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
    "brief", "story", "voice", "music", "segment", "assemble", "score",
];
const MAX_REFS: usize = 16;
const MAX_MEDIA: usize = 32;
const MAX_DIALOGUE: usize = 32;
const MAX_LORAS: usize = 8;
const STATES: [&str; 4] = ["planned", "done", "stale", "failed"];

const MEDIA: [&str; 3] = ["image", "video", "audio"];
const REF_KEYS: [&str; 16] = [
    "path",
    "media",
    "mediaMode",
    "second",
    "strength",
    "trimStart",
    "trimEnd",
    "sourceDuration",
    "label",
    "instructions",
    "who",
    "whoAxis",
    "boxes",
    "keep",
    "drop",
    "description",
];
fn path_ok(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|p| (1..=1024).contains(&p.len()) && !p.contains('\0'))
}
fn media_ok(v: &Value) -> bool {
    path_ok(&v["path"]) && v["media"].as_str().is_some_and(|m| MEDIA.contains(&m))
}
fn in_range(v: &Value, lo: f64, hi: f64) -> bool {
    v.as_f64()
        .is_some_and(|x| x.is_finite() && (lo..=hi).contains(&x))
}
fn opt_text(v: Option<&Value>, max: usize) -> bool {
    v.is_none_or(|t| t.as_str().is_some_and(|t| t.chars().count() <= max))
}
/// Same rules as `movieManifest.ts::sceneInputsProblem`: typed, bounded, no unknown keys.
fn scene_inputs_problem(v: &Value) -> Option<&'static str> {
    let Some(o) = v.as_object() else {
        return Some("bad scene inputs");
    };
    if o.keys()
        .any(|k| !["first", "last", "source", "refs"].contains(&k.as_str()))
    {
        return Some("bad scene inputs");
    }
    for k in ["first", "last", "source"] {
        if let Some(m) = o.get(k) {
            if !media_ok(m) || m.as_object().is_none_or(|m| m.len() != 2) {
                return Some("bad scene inputs");
            }
        }
    }
    let refs = o.get("refs")?;
    let Some(refs) = refs.as_array() else {
        return Some("bad scene inputs");
    };
    if refs.len() > MAX_REFS {
        return Some("bad scene inputs");
    }
    for r in refs {
        let Some(ro) = r.as_object() else {
            return Some("bad scene inputs");
        };
        let ok = media_ok(r)
            && ro.keys().all(|k| REF_KEYS.contains(&k.as_str()))
            && r["mediaMode"]
                .as_str()
                .is_some_and(|m| ["video", "audio", "video_audio"].contains(&m))
            && in_range(&r["second"], 0.0, 3600.0)
            && in_range(&r["strength"], 0.0, 10.0)
            && ["trimStart", "trimEnd", "sourceDuration"]
                .iter()
                .all(|k| ro.get(*k).is_none_or(|t| in_range(t, 0.0, 36000.0)))
            && opt_text(ro.get("label"), 40)
            && ["instructions", "keep", "drop", "description"]
                .iter()
                .all(|k| opt_text(ro.get(*k), 4000))
            && ro.get("who").is_none_or(|w| {
                w.as_array().is_some_and(|a| {
                    a.len() <= 32
                        && a.iter()
                            .all(|n| n.as_u64().is_some_and(|n| (1..=32).contains(&n)))
                })
            })
            && ro
                .get("whoAxis")
                .is_none_or(|w| w.as_str().is_some_and(|w| ["y", "z", "none"].contains(&w)))
            && ro.get("boxes").is_none_or(|b| {
                b.as_array().is_some_and(|a| {
                    a.len() <= 32
                        && a.iter().all(|x| {
                            x["n"].as_u64().is_some_and(|n| (1..=32).contains(&n))
                                && x["box"].as_array().is_some_and(|c| {
                                    c.len() == 4 && c.iter().all(|c| in_range(c, 0.0, 1.0))
                                })
                        })
                })
            });
        if !ok {
            return Some("bad scene inputs");
        }
    }
    None
}

/// Same rules as `movieManifest.ts::samplingProblem`: optional whole Steps 1–150 and CFG 0–30, the given extra keys, nothing else.
fn sampling_ok(v: &Value, extra: &[&str]) -> bool {
    v.as_object().is_some_and(|o| {
        o.keys()
            .all(|k| k == "steps" || k == "cfg" || extra.contains(&k.as_str()))
            && o.get("steps")
                .is_none_or(|s| s.as_u64().is_some_and(|s| (1..=150).contains(&s)))
            && o.get("cfg").is_none_or(|c| in_range(c, 0.0, 30.0))
    })
}
/// Same rules as `movieManifest.ts::renderProblem`.
fn render_ok(v: &Value) -> bool {
    sampling_ok(v, &["source", "model", "resolution"])
        && v["source"]
            .as_str()
            .is_some_and(|s| s == "movie" || s == "generate")
        && v.get("model").is_none_or(|m| {
            m.as_str()
                .is_some_and(|m| (1..=300).contains(&m.len()) && !m.contains('\0'))
        })
        && v.get("resolution")
            .is_none_or(|r| r.as_str().is_some_and(|r| (1..=20).contains(&r.len())))
}
/// Music-only settings: lyrics, ACE-Step tempo and lyrics language, the preset id and the planner-writes-lyrics flag.
fn music_settings_ok(i: &Value) -> bool {
    let lower = |v: &Value, lo: usize, hi: usize, digits: bool| {
        v.as_str().is_some_and(|s| {
            (lo..=hi).contains(&s.len())
                && s.bytes().all(|b| {
                    b.is_ascii_lowercase() || (digits && (b.is_ascii_digit() || b == b'-'))
                })
        })
    };
    opt_text(i.get("lyrics"), 4000)
        && i.get("bpm")
            .is_none_or(|b| b.as_u64().is_some_and(|b| (10..=300).contains(&b)))
        && i.get("language").is_none_or(|l| lower(l, 2, 8, false))
        && i.get("preset").is_none_or(|p| lower(p, 1, 60, true))
        && i.get("vocals").is_none_or(Value::is_boolean)
}

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
    if let Some(pool) = o.get("media") {
        let ok = pool.as_array().is_some_and(|a| {
            let paths: HashSet<&str> = a.iter().filter_map(|x| x["path"].as_str()).collect();
            a.len() <= MAX_MEDIA
                && paths.len() == a.len()
                && a.iter().all(|x| {
                    media_ok(x)
                        && x.as_object().is_some_and(|o| {
                            o.keys().all(|k| {
                                ["path", "media", "note", "role", "label"].contains(&k.as_str())
                            })
                        })
                        && opt_text(x.get("note"), 2000)
                        && opt_text(x.get("label"), 40)
                        && x.get("role").is_none_or(|r| {
                            r.as_str().is_some_and(|r| {
                                ["reference", "first", "last", "source"].contains(&r)
                            })
                        })
                })
        });
        if !ok {
            return Some("bad media pool");
        }
    }
    if o.get("render").is_some_and(|r| !render_ok(r)) {
        return Some("bad render settings");
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
        if i.get("file").is_some_and(|f| {
            kind != "music"
                || !f
                    .as_str()
                    .is_some_and(|f| (1..=1024).contains(&f.len()) && !f.contains('\0'))
        }) {
            return Some("bad music file");
        }
        if let Some(x) = i.get("mix") {
            let num = |k: &str, lo: f64, hi: f64| {
                x.get(k)
                    .and_then(Value::as_f64)
                    .is_some_and(|n| n.is_finite() && (lo..=hi).contains(&n))
            };
            let mode = x
                .get("mode")
                .and_then(Value::as_str)
                .is_some_and(|m| m == "mix" || m == "h3-reference");
            if kind != "score"
                || !mode
                || !num("levelDb", -40.0, 6.0)
                || !num("duckDb", 0.0, 30.0)
                || !num("fadeSeconds", 0.0, 10.0)
            {
                return Some("bad mix settings");
            }
        }
        if i.get("sampling")
            .is_some_and(|s| kind != "segment" || !sampling_ok(s, &[]))
        {
            return Some("bad shot sampling");
        }
        let music_keys = ["lyrics", "bpm", "language", "preset", "vocals"]
            .iter()
            .any(|k| i.get(*k).is_some());
        if music_keys && (kind != "music" || !music_settings_ok(i)) {
            return Some("bad music settings");
        }
        if let Some(inputs) = i.get("inputs") {
            if kind != "segment" {
                return Some("bad scene inputs (scenes only)");
            }
            if let Some(problem) = scene_inputs_problem(inputs) {
                return Some(problem);
            }
        }
        let segment_only = [
            "seconds",
            "continuous",
            "blend",
            "dialogue",
            "entry",
            "exit",
            "model",
        ]
        .iter()
        .any(|k| i.get(*k).is_some());
        // LoRAs belong to a shot's model or to the generated music bed's model.
        if let Some(l) = i.get("loras") {
            let ok = (kind == "segment" || kind == "music")
                && l.as_array().is_some_and(|a| {
                    let names: HashSet<&str> = a
                        .iter()
                        .filter_map(|x| x.get("name").and_then(Value::as_str))
                        .collect();
                    a.len() <= MAX_LORAS
                        && names.len() == a.len()
                        && a.iter().all(|x| {
                            x.get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|n| (1..=300).contains(&n.len()) && !n.contains('\0'))
                                && x.get("strength")
                                    .and_then(Value::as_f64)
                                    .is_some_and(|s| s.is_finite() && (-4.0..=4.0).contains(&s))
                        })
                });
            if !ok {
                return Some("bad LoRAs (shots and the music only)");
            }
        }
        if kind == "segment" {
            if !positive(i.get("seconds")) || i.get("continuous").is_some_and(|c| !c.is_boolean()) {
                return Some("bad segment");
            }
            if i.get("blend").is_some_and(|b| {
                !in_range(b, 0.25, 3.0)
                    || i.get("continuous").and_then(Value::as_bool) == Some(true)
            }) {
                return Some("bad blend");
            }
            if ["entry", "exit"]
                .iter()
                .any(|k| i.get(*k).is_some_and(|v| !text_ok(v)))
            {
                return Some("bad scene state");
            }
            if i.get("model").is_some_and(|m| {
                !m.as_str()
                    .is_some_and(|m| (1..=300).contains(&m.len()) && !m.contains('\0'))
            }) {
                return Some("bad shot model");
            }
            if let Some(d) = i.get("dialogue") {
                let ok = d.as_array().is_some_and(|a| {
                    a.len() <= MAX_DIALOGUE
                        && a.iter().all(|x| {
                            x.get("speaker")
                                .and_then(Value::as_str)
                                .is_some_and(|c| (1..=80).contains(&c.chars().count()))
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
/// Which files a stored movie points at are gone: the current revision's result of every item and every scene input. Only paths read
/// from the stored manifest are looked at (never a path from the webview), by metadata only — nothing is opened, read, copied or changed.
pub fn check(dir: &Path, id: &str) -> Result<Value, String> {
    let m: Value =
        serde_json::from_str(&open(dir, id)?).map_err(|_| "MOVIE_MALFORMED".to_owned())?;
    let (mut missing, mut checked) = (Vec::new(), 0usize);
    let mut truncated = false;
    for path in m["media"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x["path"].as_str())
    {
        if checked >= MAX_CHECKS {
            truncated = true;
            break;
        }
        checked += 1;
        if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
            missing.push(serde_json::json!({ "id": "brief", "kind": "reference", "path": path }));
        }
    }
    'items: for item in m["items"].as_array().into_iter().flatten() {
        let current = item["revision"].as_u64();
        let results = item["revisions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["n"].as_u64() == current)
            .filter_map(|r| r["result"]["outputId"].as_str())
            .map(|p| ("result", p));
        let inputs = &item["inputs"];
        let refs = ["first", "last", "source"]
            .iter()
            .filter_map(|k| inputs[*k]["path"].as_str())
            .chain(
                inputs["refs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| r["path"].as_str()),
            )
            .map(|p| ("reference", p));
        let music = item["file"].as_str().into_iter().map(|p| ("music", p));
        for (kind, path) in results.chain(refs).chain(music) {
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
