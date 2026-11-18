//! Optional local CSV dictionaries for prompt completion. Import once; query cached indexes.
use crate::forge::{
    engine::data_dir,
    tags::{category_name, TagStore},
};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const PRESETS: [(&str, &str); 4] = [
    ("danbooru", "danbooru_2025-09-01.csv"),
    ("e621", "e621_2025-09-01.csv"),
    ("merged", "danbooru_e621_merged_2025-09-01.csv"),
    ("classified", "danbooru_tags_classified.csv"),
];
const MAX_BYTES: u64 = 64 * 1024 * 1024;
static ACCESS: Mutex<()> = Mutex::new(());
type Stores = HashMap<PathBuf, (Option<(u64, std::time::SystemTime)>, Arc<TagStore>)>;
static BUILTIN: OnceLock<Mutex<Stores>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub ready: bool,
    pub rows: u64,
    pub skipped: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub tag: String,
    pub category: String,
    pub count: i64,
    pub source: String,
    pub description: Option<String>,
    pub matched_alias: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub sources: Vec<String>,
    pub limit: usize,
    pub aliases: bool,
    pub contains: bool,
    pub minimum_count: i64,
}
fn id_ok(id: &str) -> bool {
    PRESETS.iter().any(|(key, _)| *key == id)
        || (id.len() == 23
            && id.starts_with("custom-")
            && id[7..].bytes().all(|b| b.is_ascii_hexdigit()))
}
fn valid_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("The DEAS environment directory must be absolute".into());
    }
    Ok(())
}
fn cache(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !id_ok(id) {
        return Err("Unknown tag source".into());
    }
    Ok(dir.join("tag-sources").join(format!("{id}.sqlite3")))
}
fn discover(root: &Path, models: Option<&str>, id: &str) -> Option<PathBuf> {
    let name = PRESETS.iter().find(|(key, _)| *key == id)?.1;
    let comfy = models
        .and_then(|s| Path::new(s).parent().map(Path::to_path_buf))
        .unwrap_or_else(|| root.join("ComfyUI"));
    Some(
        comfy
            .join("custom_nodes/comfyui-easyuse-anima/__easyuse_anima__")
            .join(name),
    )
}
fn readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Tag index is unavailable; rebuild it in autocomplete options".into())
}
fn meta(db: &Connection, key: &str) -> Result<String, String> {
    db.query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| {
        r.get(0)
    })
    .map_err(|_| "Tag index metadata is invalid".into())
}
fn source_from(dir: &Path, id: &str, path: Option<&Path>) -> Source {
    let mut s = Source {
        id: id.into(),
        label: path
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.into()),
        available: path.is_some_and(Path::is_file),
        ready: false,
        rows: 0,
        skipped: 0,
    };
    if let Ok(db) = cache(dir, id).and_then(|p| readonly(&p)) {
        if meta(&db, "version").as_deref() == Ok("1") {
            s.ready = true;
            s.rows = meta(&db, "rows")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            s.skipped = meta(&db, "skipped")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            s.label = meta(&db, "label").unwrap_or(s.label);
            if path.is_none() {
                s.available = meta(&db, "path")
                    .ok()
                    .is_some_and(|p| Path::new(&p).is_file());
            }
        }
    }
    s
}
pub fn sources(root: &Path, _models: Option<&str>) -> Result<Vec<Source>, String> {
    valid_root(root)?;
    let dir = data_dir(root);
    let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = vec![Source {
        id: "builtin".into(),
        label: "builtin".into(),
        available: true,
        ready: true,
        rows: 0,
        skipped: 0,
    }];
    // Keep an already-indexed merged source visible, without rediscovering it
    // after removal or suggesting machine-specific files to a fresh installation.
    if cache(&dir, "merged")?.is_file() {
        list.push(source_from(&dir, "merged", None));
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("tag-sources")) {
        for entry in entries.flatten() {
            if let Some(id) = entry
                .path()
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| s.starts_with("custom-") && id_ok(s))
            {
                list.push(source_from(&dir, id, None));
            }
        }
    }
    list.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(list)
}

/// RFC4180 quoting (including multiline descriptions), with bounded cells and rows.
fn records(text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut out = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut closed = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' if field.is_empty() && !closed => quoted = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                    closed = false;
                }
                '\r' | '\n' => {
                    if c == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    row.push(std::mem::take(&mut field));
                    if row.iter().any(|s| !s.is_empty()) {
                        out.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                    closed = false;
                }
                _ if closed && c.is_whitespace() => {}
                _ if closed || c == '"' => return Err("Malformed quoted CSV field".into()),
                _ => field.push(c),
            }
        }
        if field.len() > 262144 || row.len() > 16 || out.len() > 1_000_000 {
            return Err("Tag CSV exceeds row/cell limits".into());
        }
    }
    if quoted {
        return Err("Unclosed CSV quote".into());
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        out.push(row);
    }
    Ok(out)
}
fn key(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
}
fn good_tag(s: &str) -> bool {
    !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control)
}
fn category(code: i64, kind: &str) -> &'static str {
    match (kind, code) {
        ("e621", 5) => "species",
        ("e621", 7) | ("merged", 7) => "meta",
        ("e621", 8) | ("merged", 8) => "lore",
        ("merged", 5) => "other",
        (_, 0 | 1 | 3 | 4 | 5) => category_name(code),
        _ => "other",
    }
}

pub fn import_file(root: &Path, path: &Path, preset: Option<&str>) -> Result<Source, String> {
    valid_root(root)?;
    let file = crate::media::star::open_media(path)
        .map_err(|_| "Cannot open regular tag CSV without following links".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect tag CSV".to_string())?;
    if !metadata.is_file() {
        return Err("Select a regular tag CSV file".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("Tag CSV exceeds 64 MiB".into());
    }
    // Also bound the actual read if another process grows the selected file.
    let mut text = String::new();
    file.take(MAX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Tag CSV must be readable UTF-8".to_string())?;
    if text.len() as u64 > MAX_BYTES {
        return Err("Tag CSV exceeds 64 MiB".into());
    }
    let rows = records(&text)?;
    let id = match preset {
        Some(id) if PRESETS.iter().any(|(key, _)| *key == id) => id.to_string(),
        Some(_) => return Err("Unknown tag source".into()),
        None => {
            let canonical =
                std::fs::canonicalize(path).map_err(|_| "Cannot resolve tag CSV".to_string())?;
            let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
            format!(
                "custom-{}",
                digest[..8]
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            )
        }
    };
    let label = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tags.csv".into());
    let kind = if id == "e621" || label.starts_with("e621_") {
        "e621"
    } else if id == "merged" || label.contains("merged") {
        "merged"
    } else {
        "danbooru"
    };
    let header = rows.first().is_some_and(|r| {
        r.len() >= 3
            && matches!(r[0].to_lowercase().as_str(), "name" | "tag")
            && matches!(r[2].to_lowercase().as_str(), "post_count" | "count")
    });
    let descriptions = header
        && rows[0]
            .get(3)
            .is_some_and(|s| s.eq_ignore_ascii_case("description"));
    let dir = data_dir(root);
    let destination = cache(&dir, &id)?;
    std::fs::create_dir_all(destination.parent().unwrap())
        .map_err(|_| "Cannot create tag index directory".to_string())?;
    let staged = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
        .map_err(|_| "Cannot stage tag index".to_string())?;
    let mut db = Connection::open(staged.path()).map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE tags(tag TEXT PRIMARY KEY,category TEXT NOT NULL,count INTEGER NOT NULL,description TEXT);CREATE TABLE aliases(alias TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(alias,tag));CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut skipped = 0u64;
    {
        let mut tag=tx.prepare("INSERT INTO tags VALUES(?1,?2,?3,?4) ON CONFLICT(tag) DO UPDATE SET count=max(tags.count,excluded.count),description=coalesce(tags.description,excluded.description)").map_err(|e|e.to_string())?;
        let mut alias = tx
            .prepare("INSERT OR IGNORE INTO aliases VALUES(?1,?2)")
            .map_err(|e| e.to_string())?;
        for row in rows.iter().skip(usize::from(header)) {
            let name = row.first().map(|s| key(s)).unwrap_or_default();
            let count = row.get(2).and_then(|s| s.parse::<i64>().ok());
            let code = row.get(1).and_then(|s| s.parse::<i64>().ok());
            if !(3..=if descriptions { 5 } else { 4 }).contains(&row.len())
                || !good_tag(&name)
                || count.is_none_or(|n| n < 0)
                || code.is_none()
            {
                skipped += 1;
                continue;
            }
            // The classified dictionary has an optional fifth translated description.
            let details = if descriptions {
                row[3..].join("\n")
            } else {
                String::new()
            };
            let extra = if descriptions {
                details.as_str()
            } else {
                row.get(3).map(String::as_str).unwrap_or("")
            };
            tag.execute(params![
                name,
                category(code.unwrap(), kind),
                count.unwrap(),
                if descriptions && !extra.is_empty() {
                    Some(extra)
                } else {
                    None
                }
            ])
            .map_err(|e| e.to_string())?;
            if !descriptions {
                for name_alias in extra
                    .split(',')
                    .map(key)
                    .filter(|a| good_tag(a) && a != &name)
                {
                    alias
                        .execute(params![name_alias, name])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let count: i64 = tx
        .query_row("SELECT count(*) FROM tags", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Err("CSV contains no valid tags".into());
    }
    for (k, v) in [
        ("version", "1".to_string()),
        ("label", label),
        ("path", path.to_string_lossy().into_owned()),
        ("rows", count.to_string()),
        ("skipped", skipped.to_string()),
    ] {
        tx.execute("INSERT INTO metadata VALUES(?1,?2)", params![k, v])
            .map_err(|e| e.to_string())?;
    }
    tx.execute_batch("CREATE INDEX tag_prefix ON tags(tag COLLATE NOCASE);CREATE INDEX alias_prefix ON aliases(alias COLLATE NOCASE);").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    drop(db);
    let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    staged
        .persist(&destination)
        .map_err(|_| "Cannot publish tag index".to_string())?;
    let result = source_from(&dir, &id, Some(path));
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("INFO: PromptTags operation=import source={id} rows={count} skipped={skipped}"),
    );
    Ok(result)
}

/// Forget an app-owned imported index; never resolve or delete its recorded CSV path.
pub fn remove_source(root: &Path, id: &str) -> Result<(), String> {
    valid_root(root)?;
    if (id != "merged" && !id.starts_with("custom-")) || !id_ok(id) {
        return Err("Only CSV tag sources can be removed".into());
    }
    let path = cache(&data_dir(root), id)?;
    let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot remove the imported tag index".into()),
    }
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("INFO: PromptTags operation=remove source={id}; original CSV retained"),
    );
    Ok(())
}

fn builtin(dir: &Path) -> Result<Arc<TagStore>, String> {
    let path = dir.join("tags.sqlite");
    let stamp = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok().map(|t| (m.len(), t)));
    let mut stores = BUILTIN
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((held, store)) = stores.get(&path) {
        if *held == stamp {
            return Ok(store.clone());
        }
    }
    let store = Arc::new(TagStore::open(&path)?);
    if stores.len() >= 4 {
        stores.clear();
    }
    stores.insert(path, (stamp, store.clone()));
    Ok(store)
}
fn escaped(s: &str) -> String {
    s.chars().fold(String::new(), |mut out, c| {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
        out
    })
}
pub fn search(
    root: &Path,
    target: &str,
    query: &str,
    options: &Options,
) -> Result<Vec<Completion>, String> {
    valid_root(root)?;
    if !(1..=64).contains(&options.limit)
        || options.sources.len() > 8
        || options.minimum_count < 0
        || query.len() > 512
    {
        return Err("Invalid autocomplete options".into());
    }
    let needle = key(query);
    if needle.chars().count() < 2 {
        return Ok(vec![]);
    }
    let dir = data_dir(root);
    let under = crate::forge::picker::underscore(&dir, target);
    let mut found: HashMap<String, (u8, Completion)> = HashMap::new();
    let mut seen = HashSet::new();
    let mut keep = |raw: String,
                    cat: String,
                    count: i64,
                    source: String,
                    description: Option<String>,
                    alias: Option<String>| {
        if count < options.minimum_count {
            return;
        }
        let rank = if raw == needle {
            0
        } else if raw.starts_with(&needle) {
            1
        } else if raw.contains(&needle) {
            2
        } else {
            3
        };
        let hit = Completion {
            tag: if under {
                raw.clone()
            } else {
                raw.replace('_', " ")
            },
            category: cat,
            count,
            source,
            description,
            matched_alias: alias,
        };
        if let Some((old_rank, old)) = found.get_mut(&raw) {
            if rank < *old_rank {
                *old_rank = rank;
                old.source = hit.source;
                old.category = hit.category;
                old.matched_alias = hit.matched_alias;
            }
            old.count = old.count.max(count);
            if old.description.is_none() {
                old.description = hit.description;
            }
        } else {
            found.insert(raw, (rank, hit));
        }
    };
    for id in &options.sources {
        if !seen.insert(id) {
            continue;
        }
        if id == "builtin" {
            let store = builtin(&dir)?;
            for h in store.lookup(query, false, None, 256)? {
                if !h.deprecated && (options.contains || h.tag.starts_with(&needle)) {
                    keep(
                        h.tag,
                        category_name(h.category).into(),
                        h.post_count,
                        "builtin".into(),
                        None,
                        None,
                    );
                }
            }
            continue;
        }
        let path = cache(&dir, id)?;
        let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
        let db = readonly(&path)?;
        let pattern = if options.contains {
            format!("%{}%", escaped(&needle))
        } else {
            format!("{}%", escaped(&needle))
        };
        let sql="SELECT tag,category,count,description,CASE WHEN min(rank)=3 THEN min(alias) END AS alias,min(rank) AS rank FROM (SELECT tag,category,count,description,NULL AS alias,CASE WHEN tag=?4 THEN 0 WHEN tag LIKE ?5 ESCAPE '\\' THEN 1 ELSE 2 END AS rank FROM tags WHERE tag LIKE ?1 ESCAPE '\\' AND count>=?2 UNION ALL SELECT t.tag,t.category,t.count,t.description,a.alias,3 AS rank FROM aliases a JOIN tags t ON t.tag=a.tag WHERE ?3 AND a.alias LIKE ?1 ESCAPE '\\' AND t.count>=?2) GROUP BY tag ORDER BY rank,count DESC,tag LIMIT 256";
        let mut stmt = db.prepare_cached(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    pattern,
                    options.minimum_count,
                    options.aliases,
                    needle,
                    format!("{}%", escaped(&needle))
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (tag, cat, count, description, alias) = row.map_err(|e| e.to_string())?;
            keep(tag, cat, count, id.clone(), description, alias);
        }
    }
    let mut hits: Vec<_> = found.into_values().collect();
    hits.sort_by(|(a, x), (b, y)| {
        a.cmp(b)
            .then_with(|| y.count.cmp(&x.count))
            .then_with(|| x.tag.cmp(&y.tag))
    });
    Ok(hits
        .into_iter()
        .take(options.limit)
        .map(|(_, hit)| hit)
        .collect())
}

fn logged<T>(operation: &str, result: Result<T, String>) -> Result<T, String> {
    result.inspect_err(|_| {
        static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
        let mut last = LAST.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
        if last.get(operation).is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
            crate::logs::push(crate::logs::Source::Deas, &format!("ERROR: PromptTags operation={operation}: local tag dictionary operation failed (details in autocomplete options; queries and paths omitted)"));
            last.insert(operation.into(), Instant::now());
        }
    })
}
#[tauri::command]
pub async fn native_prompt_tag_sources(
    root: String,
    models_dir: Option<String>,
) -> Result<Vec<Source>, String> {
    let result =
        tokio::task::spawn_blocking(move || sources(Path::new(&root), models_dir.as_deref()))
            .await
            .map_err(|_| "Tag source lookup failed".to_string())
            .and_then(std::convert::identity);
    logged("sources", result)
}
#[tauri::command]
pub async fn native_prompt_tag_import(
    root: String,
    models_dir: Option<String>,
    source: Option<String>,
) -> Result<Option<Source>, String> {
    logged("import", valid_root(Path::new(&root)))?;
    let path = if let Some(id) = source.as_deref() {
        logged(
            "import",
            discover(Path::new(&root), models_dir.as_deref(), id)
                .ok_or_else(|| "Unknown tag source".to_string()),
        )?
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .add_filter("CSV", &["csv"])
            .pick_file()
            .await
        else {
            return Ok(None);
        };
        file.path().to_path_buf()
    };
    let result = tokio::task::spawn_blocking(move || {
        import_file(Path::new(&root), &path, source.as_deref()).map(Some)
    })
    .await
    .map_err(|_| "Tag import failed".to_string())
    .and_then(std::convert::identity);
    logged("import", result)
}
#[tauri::command]
pub async fn native_prompt_tag_search(
    root: String,
    target: String,
    query: String,
    options: Options,
) -> Result<Vec<Completion>, String> {
    let result =
        tokio::task::spawn_blocking(move || search(Path::new(&root), &target, &query, &options))
            .await
            .map_err(|_| "Autocomplete search failed".to_string())
            .and_then(std::convert::identity);
    logged("search", result)
}

#[tauri::command]
pub async fn native_prompt_tag_remove(root: String, source: String) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || remove_source(Path::new(&root), &source))
        .await
        .map_err(|_| "Tag source removal failed".to_string())
        .and_then(std::convert::identity);
    logged("remove", result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(ids: &[&str]) -> Options {
        Options {
            sources: ids.iter().map(|s| s.to_string()).collect(),
            limit: 32,
            aliases: true,
            contains: true,
            minimum_count: 0,
        }
    }
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("forge-data")).unwrap();
        std::fs::write(
            dir.path().join("forge-data/forge-pack.json"),
            r#"{"models":{"anima":{"entry":{"tag_style":"underscore"}}}}"#,
        )
        .unwrap();
        dir
    }
    #[test]
    fn shared_logs_receive_redacted_rate_limited_errors() {
        let start = crate::logs::after(0).last().map_or(0, |e| e.seq);
        for _ in 0..2 {
            let _ = logged::<()>("fixture-redaction", Err("private prompt and path".into()));
        }
        let rows = crate::logs::after(start)
            .into_iter()
            .filter(|e| e.text.contains("operation=fixture-redaction"))
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, crate::logs::Source::Deas);
        assert!(!rows[0].text.contains("private prompt"));
        assert!(sources(Path::new("relative"), None).is_err());
    }
    #[test]
    fn csv_quotes_bom_unicode_and_multiline() {
        assert_eq!(records("\u{feff}name,category,post_count,description\r\nblue,0,1,\"line one, \"\"quote\"\"\n日本語\"\r\n").unwrap()[1],vec!["blue","0","1","line one, \"quote\"\n日本語"]);
        assert!(records("a,0,1,\"unclosed").is_err());
        assert!(records("a,0,1,\"bad\"oops").is_err());
    }
    #[test]
    fn aliases_categories_dedup_spelling_and_offline_cache() {
        let root = fixture();
        let file = root.path().join("e621_fixture.csv");
        std::fs::write(
            &file,
            "blue_eyes,0,12,\"azure_eyes,blue_eyed\"\nmammal,5,30,mammalian\nblue_eyes,0,20,\n",
        )
        .unwrap();
        let source = import_file(root.path(), &file, Some("e621")).unwrap();
        assert_eq!(source.rows, 2);
        let hits = search(root.path(), "anima", "azure", &options(&["e621", "e621"])).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tag, "blue_eyes");
        assert_eq!(hits[0].count, 20);
        assert_eq!(hits[0].matched_alias.as_deref(), Some("azure_eyes"));
        assert_eq!(
            search(root.path(), "anima", "mammal", &options(&["e621"])).unwrap()[0].category,
            "species"
        );
        assert_eq!(
            search(root.path(), "unknown", "azure", &options(&["e621"])).unwrap()[0].tag,
            "blue eyes"
        );
        let mut no_alias = options(&["e621"]);
        no_alias.aliases = false;
        assert!(search(root.path(), "anima", "azure", &no_alias)
            .unwrap()
            .is_empty());
        std::fs::remove_file(file).unwrap();
        assert_eq!(
            search(root.path(), "anima", "azure", &options(&["e621"]))
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn alias_limit_counts_canonical_tags_and_keeps_best_match() {
        let root = fixture();
        let file = root.path().join("tags.csv");
        let aliases = (0..256)
            .map(|n| format!("azure_{n:03}"))
            .collect::<Vec<_>>()
            .join(",");
        std::fs::write(
            &file,
            format!("blue_eyes,0,100,\"{aliases}\"\ngreen_eyes,0,1,azure_other\n"),
        )
        .unwrap();
        import_file(root.path(), &file, Some("danbooru")).unwrap();
        let mut opts = options(&["danbooru"]);
        opts.contains = false;
        let hits = search(root.path(), "anima", "azure", &opts).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].tag, "blue_eyes");
        assert_eq!(hits[0].matched_alias.as_deref(), Some("azure_000"));
        assert_eq!(hits[1].tag, "green_eyes");
        assert_eq!(hits[1].matched_alias.as_deref(), Some("azure_other"));

        std::fs::write(&file, "azure,0,1,azure_alias\n").unwrap();
        import_file(root.path(), &file, Some("danbooru")).unwrap();
        let hits = search(root.path(), "anima", "azure", &opts).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tag, "azure");
        assert!(hits[0].matched_alias.is_none());
    }
    #[test]
    fn descriptions_are_not_aliases_and_overlapping_lists_do_not_add_counts() {
        let root = fixture();
        let file = root.path().join("classified.csv");
        std::fs::write(
            &file,
            "name,category,post_count,description\nblue_eyes,0,10,\"A blue shade, not an alias\",translation\n",
        )
        .unwrap();
        import_file(root.path(), &file, Some("classified")).unwrap();
        std::fs::write(&file, "blue_eyes,0,15,azure_eyes\n").unwrap();
        import_file(root.path(), &file, Some("danbooru")).unwrap();
        let hits = search(
            root.path(),
            "anima",
            "blue",
            &options(&["classified", "danbooru"]),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].count, 15);
        assert_eq!(
            hits[0].description.as_deref(),
            Some("A blue shade, not an alias\ntranslation")
        );
        assert!(
            search(root.path(), "anima", "shade", &options(&["classified"]))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn exact_rare_tags_beat_popular_prefixes_and_filters_are_literal() {
        let root = fixture();
        let file = root.path().join("tags.csv");
        let mut csv = "pet,0,1,\nab%tag,0,5,\nab_tag,0,4,\n".to_string();
        for n in 0..350 {
            csv += &format!("pet_{n},0,{},\n", 1000 + n);
        }
        std::fs::write(&file, csv).unwrap();
        import_file(root.path(), &file, Some("danbooru")).unwrap();
        let hits = search(root.path(), "anima", "pet", &options(&["danbooru"])).unwrap();
        assert_eq!(hits.len(), 32);
        assert_eq!(hits[0].tag, "pet");
        assert_eq!(
            search(root.path(), "anima", "ab%", &options(&["danbooru"])).unwrap()[0].tag,
            "ab%tag"
        );
        let mut filtered = options(&["danbooru"]);
        filtered.minimum_count = 100;
        assert!(search(root.path(), "anima", "ab", &filtered)
            .unwrap()
            .is_empty());
        assert!(search(root.path(), "anima", "ab", &options(&["../bad"])).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn fifo_import_returns_promptly_without_removing_original() {
        use std::os::unix::{ffi::OsStrExt, fs::FileTypeExt};
        let root = fixture();
        let fifo = root.path().join("tags.csv");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // No writer: a blocking open would wait forever.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (send, receive) = std::sync::mpsc::channel();
        let worker_root = root.path().to_path_buf();
        let worker_fifo = fifo.clone();
        let worker = std::thread::spawn(move || {
            let _ = send.send(import_file(&worker_root, &worker_fifo, None));
        });
        let result = receive
            .recv_timeout(Duration::from_secs(2))
            .expect("FIFO import must not block waiting for a writer");
        worker.join().unwrap();
        assert!(result.unwrap_err().contains("tag CSV"));
        assert!(std::fs::symlink_metadata(&fifo)
            .unwrap()
            .file_type()
            .is_fifo());
        assert!(!data_dir(root.path()).join("tag-sources").exists());
    }
    #[cfg(unix)]
    #[test]
    fn import_rejects_symlinks_and_directories_without_removing_originals() {
        let root = fixture();
        let original = root.path().join("original.csv");
        let csv = "blue_eyes,0,12,azure_eyes\n";
        std::fs::write(&original, csv).unwrap();
        let link = root.path().join("link.csv");
        std::os::unix::fs::symlink(&original, &link).unwrap();
        assert!(import_file(root.path(), &link, None)
            .unwrap_err()
            .contains("tag CSV"));
        assert_eq!(std::fs::read_link(&link).unwrap(), original);
        assert_eq!(std::fs::read_to_string(&original).unwrap(), csv);
        let directory = root.path().join("directory.csv");
        std::fs::create_dir(&directory).unwrap();
        assert!(import_file(root.path(), &directory, None)
            .unwrap_err()
            .contains("tag CSV"));
        assert!(directory.is_dir());
        assert!(!data_dir(root.path()).join("tag-sources").exists());
    }
    #[test]
    fn failed_import_retains_the_previous_index_and_reports_skips() {
        let root = fixture();
        let file = root.path().join("tags.csv");
        std::fs::write(&file, "blue,0,1,\nbad,0,not_a_number,\n").unwrap();
        assert_eq!(
            import_file(root.path(), &file, Some("danbooru"))
                .unwrap()
                .skipped,
            1
        );
        std::fs::write(&file, "bad,0,1,\"unterminated").unwrap();
        assert!(import_file(root.path(), &file, Some("danbooru")).is_err());
        assert_eq!(
            search(root.path(), "anima", "blue", &options(&["danbooru"]))
                .unwrap()
                .len(),
            1
        );
        std::fs::File::create(&file)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(import_file(root.path(), &file, Some("danbooru"))
            .unwrap_err()
            .contains("64 MiB"));
    }
    #[test]
    fn removes_only_imported_indexes_and_retains_original_csv_and_other_sources() {
        let root = fixture();
        let original = root.path().join("my tags 日本語.csv");
        std::fs::write(&original, "blue_eyes,0,12,azure_eyes\n").unwrap();
        let source = import_file(root.path(), &original, None).unwrap();
        import_file(root.path(), &original, Some("merged")).unwrap();
        let before = std::fs::read(&original).unwrap();
        let seq = crate::logs::after(0).last().map_or(0, |e| e.seq);
        remove_source(root.path(), &source.id).unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), before);
        assert!(!cache(&data_dir(root.path()), &source.id).unwrap().exists());
        assert!(cache(&data_dir(root.path()), "merged").unwrap().exists());
        assert!(!sources(root.path(), None)
            .unwrap()
            .iter()
            .any(|s| s.id == source.id));
        remove_source(root.path(), &source.id).unwrap();
        for id in ["builtin", "danbooru", "custom-../../escape"] {
            assert!(remove_source(root.path(), id).is_err());
        }
        assert!(crate::logs::after(seq)
            .iter()
            .any(|e| e.source == crate::logs::Source::Deas
                && e.text.contains("PromptTags operation=remove")
                && !e.text.contains("my tags")));
    }
    #[test]
    fn external_csvs_are_opt_in_and_removed_merged_index_stays_removed() {
        let root = fixture();
        let comfy = root.path().join("external ComfyUI");
        let csv = comfy.join("custom_nodes/comfyui-easyuse-anima/__easyuse_anima__");
        std::fs::create_dir_all(&csv).unwrap();
        std::fs::write(
            csv.join("danbooru_e621_merged_2025-09-01.csv"),
            "blue,0,1,\n",
        )
        .unwrap();
        let models = comfy.join("models").to_string_lossy().into_owned();
        let list = sources(root.path(), Some(&models)).unwrap();
        assert_eq!(list.len(), 1, "external CSVs are opt-in");
        let original = csv.join("danbooru_e621_merged_2025-09-01.csv");
        import_file(root.path(), &original, Some("merged")).unwrap();
        assert!(sources(root.path(), Some(&models))
            .unwrap()
            .iter()
            .any(|s| s.id == "merged"));
        remove_source(root.path(), "merged").unwrap();
        assert!(original.is_file());
        assert_eq!(
            sources(root.path(), Some(&models)).unwrap().len(),
            1,
            "removal must survive reopening"
        );
    }
    #[test]
    #[ignore = "explicit local CSV benchmark; set DEAS_TAG_CSV_FIXTURE_DIR"]
    fn real_csv_dictionaries() {
        let base = PathBuf::from(std::env::var("DEAS_TAG_CSV_FIXTURE_DIR").unwrap());
        let root = fixture();
        for (id, name) in PRESETS {
            let start = Instant::now();
            let source = import_file(root.path(), &base.join(name), Some(id)).unwrap();
            let imported = start.elapsed();
            let start = Instant::now();
            let hits = search(
                root.path(),
                "anima",
                if id == "e621" { "mammal" } else { "blue" },
                &options(&[id]),
            )
            .unwrap();
            assert!(!hits.is_empty());
            println!(
                "{id}: rows={} skipped={} import_ms={} query_ms={}",
                source.rows,
                source.skipped,
                imported.as_millis(),
                start.elapsed().as_millis()
            );
        }
    }
}
