//! Movie Maker manifest store (UX-22d1): bounded, atomic save and validated reopen of the versioned movie manifest
//! (`src/lib/movieManifest.ts`) under `<app data>/movies/<id>.movie.json`. It stores and returns the manifest text and
//! nothing else: it never submits a job, resubmits in-flight work or grants file access, so a reopened movie is inert
//! until the user resumes it. The structural rules mirror the TypeScript validator (the frontend validates again).
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const VERSION: u64 = 1;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ITEMS: usize = 400;
const MAX_DEPS: usize = 32;
const MAX_REVISIONS: usize = 20;
const MAX_TEXT: usize = 20_000;
const MAX_MOVIES: usize = 500;
const SUFFIX: &str = ".movie.json";
const KINDS: [&str; 7] = [
    "brief", "cast", "story", "voice", "music", "segment", "assemble",
];
const ROLES: [&str; 4] = ["actor", "location", "prop", "style"];
const MAX_REFS: usize = 16;
const MAX_DIALOGUE: usize = 32;
const STATES: [&str; 4] = ["planned", "done", "stale", "failed"];

fn id_ok(s: &str) -> bool {
    (1..=80).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn text_ok(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.chars().count() <= MAX_TEXT && !s.contains('\0'))
}
fn positive(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && n > 0.0)
}

/// The first structural problem of a manifest, as a fixed message that never echoes manifest text.
pub fn problem(m: &Value) -> Option<&'static str> {
    let Some(o) = m.as_object() else {
        return Some("manifest is not an object");
    };
    if o.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return Some("unsupported manifest version");
    }
    if !o.get("id").and_then(Value::as_str).is_some_and(id_ok)
        || !o.get("title").is_some_and(text_ok)
        || !o.get("aspect").is_some_and(text_ok)
    {
        return Some("bad manifest header");
    }
    if !positive(o.get("targetSeconds")) {
        return Some("bad target length");
    }
    let Some(items) = o
        .get("items")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= MAX_ITEMS)
    else {
        return Some("bad item list");
    };
    let mut deps: HashMap<&str, Vec<&str>> = HashMap::new();
    for i in items {
        let Some(id) = i.get("id").and_then(Value::as_str).filter(|s| id_ok(s)) else {
            return Some("bad item id");
        };
        if deps.insert(id, Vec::new()).is_some() {
            return Some("duplicate item id");
        }
    }
    let ids: HashSet<&str> = deps.keys().copied().collect();
    for i in items {
        let id = i["id"].as_str().unwrap_or_default();
        let kind = i.get("kind").and_then(Value::as_str).unwrap_or_default();
        if !KINDS.contains(&kind) {
            return Some("unknown item kind");
        }
        if !i.get("title").is_some_and(text_ok) || !i.get("text").is_some_and(text_ok) {
            return Some("bad item text");
        }
        if !STATES.contains(&i.get("state").and_then(Value::as_str).unwrap_or_default()) {
            return Some("unknown item state");
        }
        let Some(list) = i
            .get("deps")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= MAX_DEPS)
        else {
            return Some("bad dependency");
        };
        let mut seen = HashSet::new();
        for d in list {
            match d.as_str() {
                Some(d) if ids.contains(d) && d != id && seen.insert(d) => {
                    deps.get_mut(id).map(|v| v.push(d)).unwrap_or_default()
                }
                _ => return Some("bad dependency"),
            }
        }
        if !i
            .get("revision")
            .and_then(Value::as_u64)
            .is_some_and(|n| n >= 1)
        {
            return Some("bad revision");
        }
        let Some(revs) = i
            .get("revisions")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= MAX_REVISIONS)
        else {
            return Some("bad revisions");
        };
        let rev_ok = |r: &Value| {
            r.get("n").and_then(Value::as_u64).is_some()
                && r.get("text").is_some_and(text_ok)
                && r.get("result").is_none_or(|x| {
                    x.get("outputId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| (1..=500).contains(&s.len()))
                })
        };
        if !revs.iter().all(rev_ok) {
            return Some("bad revision entry");
        }
        if i.get("locked").is_some_and(|l| !l.is_boolean()) {
            return Some("bad lock");
        }
        if kind != "cast" && (i.get("role").is_some() || i.get("refs").is_some()) {
            return Some("role/refs are cast-only");
        }
        if i.get("role")
            .is_some_and(|r| !r.as_str().is_some_and(|r| ROLES.contains(&r)))
        {
            return Some("unknown cast role");
        }
        if let Some(refs) = i.get("refs") {
            let ok = refs.as_array().is_some_and(|a| {
                let paths: HashSet<&str> = a.iter().filter_map(Value::as_str).collect();
                a.len() <= MAX_REFS
                    && paths.len() == a.len()
                    && paths
                        .iter()
                        .all(|p| (1..=1024).contains(&p.len()) && !p.contains('\0'))
            });
            if !ok {
                return Some("bad references");
            }
        }
        let segment_only = ["seconds", "continuous", "dialogue", "entry", "exit"]
            .iter()
            .any(|k| i.get(*k).is_some());
        if kind == "segment" {
            if !positive(i.get("seconds")) || i.get("continuous").is_some_and(|c| !c.is_boolean()) {
                return Some("bad segment");
            }
            if ["entry", "exit"]
                .iter()
                .any(|k| i.get(*k).is_some_and(|v| !text_ok(v)))
            {
                return Some("bad scene state");
            }
            if let Some(d) = i.get("dialogue") {
                let ok = d.as_array().is_some_and(|a| {
                    a.len() <= MAX_DIALOGUE
                        && a.iter().all(|x| {
                            x.get("castId")
                                .and_then(Value::as_str)
                                .is_some_and(|c| ids.contains(c))
                                && x.get("line")
                                    .and_then(Value::as_str)
                                    .is_some_and(|l| (1..=1000).contains(&l.chars().count()))
                                && x.get("delivery").is_none_or(|v| {
                                    v.as_str().is_some_and(|s| s.chars().count() <= 200)
                                })
                        })
                });
                if !ok {
                    return Some("bad dialogue");
                }
            }
        } else if segment_only {
            return Some("seconds/continuity are segment-only");
        }
    }
    // Cycle check: repeatedly strip items whose dependencies are all stripped.
    let mut left: HashMap<&str, usize> = deps.iter().map(|(k, v)| (*k, v.len())).collect();
    let mut ready: Vec<&str> = left
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(k, _)| *k)
        .collect();
    let mut done = 0;
    while let Some(x) = ready.pop() {
        done += 1;
        for (k, v) in &deps {
            if v.contains(&x) {
                let n = left.get_mut(k).unwrap();
                *n -= 1;
                if *n == 0 {
                    ready.push(k);
                }
            }
        }
    }
    (done != deps.len()).then_some("dependency cycle")
}

fn parse(text: &str) -> Result<Value, String> {
    if text.len() > MAX_BYTES {
        return Err("MOVIE_TOO_LARGE".into());
    }
    let v: Value = serde_json::from_str(text).map_err(|_| "MOVIE_MALFORMED".to_owned())?;
    match problem(&v) {
        Some(_) => Err("MOVIE_INVALID".into()),
        None => Ok(v),
    }
}
fn path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !id_ok(id) {
        return Err("MOVIE_ID".into());
    }
    Ok(dir.join(format!("{id}{SUFFIX}")))
}

static WRITE: Mutex<()> = Mutex::new(());

/// Validates and writes the manifest atomically (temp file in the same folder, flushed, then renamed over the old file).
pub fn save(dir: &Path, text: &str) -> Result<String, String> {
    let v = parse(text)?;
    let id = v["id"].as_str().unwrap_or_default().to_owned();
    let target = path(dir, &id)?;
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir).map_err(|_| "MOVIE_WRITE".to_owned())?;
    if !target.exists() && count(dir) >= MAX_MOVIES {
        return Err("MOVIE_LIMIT".into());
    }
    let partial = dir.join(format!(".{id}.partial"));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&partial)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&partial, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
        return Err("MOVIE_WRITE".into());
    }
    Ok(id)
}
/// Reads and validates one movie; a damaged or newer file is refused, never repaired or overwritten.
pub fn open(dir: &Path, id: &str) -> Result<String, String> {
    let target = path(dir, id)?;
    let meta = std::fs::metadata(&target).map_err(|_| "MOVIE_NOT_FOUND".to_owned())?;
    if meta.len() > MAX_BYTES as u64 {
        return Err("MOVIE_TOO_LARGE".into());
    }
    let text = std::fs::read_to_string(&target).map_err(|_| "MOVIE_READ".to_owned())?;
    parse(&text)?;
    Ok(text)
}
fn names(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_suffix(SUFFIX)?.to_owned();
            (id_ok(&id) && e.file_type().ok()?.is_file()).then(|| (id, e.path()))
        })
        .collect();
    out.sort();
    out
}
fn count(dir: &Path) -> usize {
    names(dir).len()
}
/// One line per usable movie; damaged ones are counted, not listed, and left on disk.
pub fn list(dir: &Path) -> Value {
    let (mut movies, mut damaged) = (Vec::new(), 0u32);
    for (id, p) in names(dir).into_iter().take(MAX_MOVIES) {
        let parsed = std::fs::metadata(&p)
            .ok()
            .filter(|m| m.len() <= MAX_BYTES as u64)
            .zip(std::fs::read_to_string(&p).ok())
            .and_then(|(m, t)| parse(&t).ok().map(|v| (m, v)));
        match parsed {
            Some((meta, v)) => {
                let updated = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());
                movies.push(serde_json::json!({ "id": id, "title": v["title"], "items": v["items"].as_array().map_or(0, Vec::len), "targetSeconds": v["targetSeconds"], "updated": updated }));
            }
            None => damaged += 1,
        }
    }
    serde_json::json!({ "movies": movies, "damaged": damaged })
}

const MAX_CHECKS: usize = 2000;
/// Which files a stored movie points at are gone: the current revision's result of every item and every cast reference. Only paths read
/// from the stored manifest are looked at (never a path from the webview), by metadata only — nothing is opened, read, copied or changed.
pub fn check(dir: &Path, id: &str) -> Result<Value, String> {
    let m: Value =
        serde_json::from_str(&open(dir, id)?).map_err(|_| "MOVIE_MALFORMED".to_owned())?;
    let (mut missing, mut checked) = (Vec::new(), 0usize);
    let mut truncated = false;
    'items: for item in m["items"].as_array().into_iter().flatten() {
        let current = item["revision"].as_u64();
        let results = item["revisions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["n"].as_u64() == current)
            .filter_map(|r| r["result"]["outputId"].as_str())
            .map(|p| ("result", p));
        let refs = item["refs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|p| ("reference", p));
        for (kind, path) in results.chain(refs) {
            if checked >= MAX_CHECKS {
                truncated = true;
                break 'items;
            }
            checked += 1;
            if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
                missing.push(serde_json::json!({ "id": item["id"], "kind": kind, "path": path }));
            }
        }
    }
    Ok(serde_json::json!({ "missing": missing, "checked": checked, "truncated": truncated }))
}

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|d| d.join("movies"))
        .map_err(|_| "MOVIE_UNAVAILABLE".to_owned())
}
/// Fixed, rate-limited Central Logs line per failure code; never the manifest text or a path.
fn report(op: &str, code: &str) {
    static LAST: Mutex<Option<(std::time::Instant, String)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last
        .as_ref()
        .is_some_and(|(at, c)| c == code && at.elapsed() < std::time::Duration::from_secs(60))
    {
        return;
    }
    *last = Some((std::time::Instant::now(), code.to_owned()));
    crate::logs::push(crate::logs::Source::Deas, &format!("WARN: Movie Maker operation={op} failed code={code} (repeats limited to once per minute)"));
}
fn logged<T>(op: &str, r: Result<T, String>) -> Result<T, String> {
    r.inspect_err(|code| report(op, code))
}

#[tauri::command]
pub fn native_movie_list(app: tauri::AppHandle) -> Result<Value, String> {
    logged("list", dir(&app).map(|d| list(&d)))
}
#[tauri::command]
pub fn native_movie_open(app: tauri::AppHandle, id: String) -> Result<String, String> {
    logged("open", dir(&app).and_then(|d| open(&d, &id)))
}
#[tauri::command]
pub fn native_movie_check(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let found = logged("check", dir(&app).and_then(|d| check(&d, &id)))?;
    let n = found["missing"].as_array().map_or(0, Vec::len);
    if n > 0 {
        crate::logs::push(crate::logs::Source::Deas, &format!("WARN: Movie Maker operation=check {n} referenced file(s) of the reopened movie are missing"));
    }
    Ok(found)
}
#[tauri::command]
pub fn native_movie_save(app: tauri::AppHandle, manifest: String) -> Result<String, String> {
    logged("save", dir(&app).and_then(|d| save(&d, &manifest)))
}

#[cfg(test)]
#[path = "movie_store_tests.rs"]
mod tests;
