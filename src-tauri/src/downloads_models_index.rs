//! Persistent browsing snapshots only. Execution continues to inspect live models.
use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

// AF2-M28 invalidation law: bump SCHEMA whenever detection logic changes.
// Visibility: pub(crate) — agent_api fixture sites interpolate this constant so a
// future bump cannot fork the value silently in hand-written snapshot JSON.
// v2: the AF2-M26 component signatures (minimax_h3 / h3_video_vae / h3_audio_vae)
// made the v1 detector vocabulary stale, but refresh reuses saved records while a
// file's stamp (mtime+size) is unchanged and honors a saved snapshot while
// schema==SCHEMA && detector==CARGO_PKG_VERSION. A schema bump is therefore the
// ONLY lever that forces one full re-describe (stamp-reuse cache miss) on
// already-stamped files. Live proof 2026-11-22: refreshed:144 yet the trio kept
// component:null in unchanged-stamp records until this bump.
pub(crate) const SCHEMA: u32 = 2;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
static REFRESH: Mutex<()> = Mutex::new(());

// Owned strings avoid deserializing the native classifier's &'static str fields.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotModel {
    category: String,
    name: String,
    path: String,
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_preview: Option<String>,
    info: Option<ModelInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trigger_words: Option<Vec<String>>,
    #[serde(flatten)]
    details: SnapshotDetails,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotDetails {
    #[serde(default)]
    added_at: Option<u64>,
    check: Option<SnapshotCheck>,
    family: Option<String>,
    detected_family: Option<String>,
    family_evidence: Option<String>,
    family_override: Option<String>,
    metadata_error: Option<String>,
    component: Option<String>,
    integrity: Option<String>,
    #[serde(default)]
    misplaced_all_in_one: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct SnapshotCheck {
    identity: String,
    integrity: Option<String>,
    compatibility: String,
    availability: String,
    evidence: Vec<String>,
    reasons: Vec<SnapshotReason>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SnapshotReason {
    code: String,
    detail: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Stamp {
    model: SourceFingerprint,
    sidecar: Option<SourceFingerprint>,
    resolved: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    stamp: Option<Stamp>,
    model: SnapshotModel,
}

#[derive(Serialize, Deserialize)]
struct Index {
    schema: u32,
    detector: String,
    roots: Vec<PathBuf>,
    records: Vec<Record>,
}

pub(super) const PREVIEW_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "mp4"];

const MAX_DISPLAY_PREVIEW: u64 = 32 * 1024 * 1024;

fn absolute_path_valid(path: &Path) -> bool {
    path.is_absolute()
        && path.to_string_lossy().len() <= 32768
        && !path.to_string_lossy().chars().any(char::is_control)
        && path.components().all(|part| {
            matches!(
                part,
                std::path::Component::Prefix(_)
                    | std::path::Component::RootDir
                    | std::path::Component::Normal(_)
            )
        })
}

fn preview_path_valid(model: &str, preview: &str) -> bool {
    let preview = Path::new(preview);
    absolute_path_valid(preview)
        && preview.parent() == Path::new(model).parent()
        && preview.extension().is_some_and(|ext| {
            PREVIEW_EXTENSIONS
                .iter()
                .any(|known| ext.to_string_lossy().eq_ignore_ascii_case(known))
        })
        && preview
            .file_name()
            .is_some_and(|name| !name.to_string_lossy().chars().any(char::is_control))
}

pub(super) type PreviewFolders = HashMap<PathBuf, HashMap<String, String>>;

fn preview_bases(path: &Path) -> Option<[String; 3]> {
    let stem = path.file_stem()?.to_str()?;
    let full = path.file_name()?.to_str()?;
    Some([
        format!("{stem}.preview"),
        stem.into(),
        format!("{full}.preview"),
    ])
}

pub(super) fn find_local_preview(path: &Path) -> Option<String> {
    selected_preview(path, MAX_DISPLAY_PREVIEW)
}

pub(super) fn has_local_preview(path: &Path) -> bool {
    selected_preview(path, u64::MAX).is_some()
}

pub(super) fn has_indexed_local_preview(path: &Path, folders: &mut PreviewFolders) -> bool {
    local_preview(path, folders, u64::MAX).is_some()
}

fn custom_preview(path: &Path, max_bytes: u64) -> Option<String> {
    let source = Source::open(path).ok()?;
    let name = format!("{}{}", source.name, preview::CUSTOM_COVER_SUFFIX);
    let size = source.dir.regular(&name).ok()?.metadata().ok()?.len();
    if !(1..=max_bytes).contains(&size) {
        return None;
    }
    source.verify().ok()?;
    path.with_file_name(name).to_str().map(str::to_owned)
}

#[cfg(windows)]
fn selected_preview(path: &Path, max_bytes: u64) -> Option<String> {
    if let Some(preview) = custom_preview(path, max_bytes) {
        return Some(preview);
    }
    let source = Source::open(path).ok()?;
    for base in preview_bases(path)? {
        for ext in PREVIEW_EXTENSIONS {
            let name = format!("{base}.{ext}");
            if source
                .dir
                .regular(&name)
                .ok()
                .and_then(|file| file.metadata().ok())
                .is_some_and(|meta| (1..=max_bytes).contains(&meta.len()))
            {
                source.verify().ok()?;
                return path.with_file_name(name).to_str().map(str::to_owned);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn selected_preview(path: &Path, max_bytes: u64) -> Option<String> {
    local_preview(path, &mut PreviewFolders::new(), max_bytes)
}
// Directory names are read once per worker/folder during explicit refresh only.
fn local_preview(path: &Path, folders: &mut PreviewFolders, max_bytes: u64) -> Option<String> {
    let parent = path.parent()?;
    let names = folders.entry(parent.into()).or_insert_with(|| {
        let mut names = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.take(MAX_WALK).flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().is_ok_and(|kind| kind.is_file())
                    && Path::new(&name).extension().is_some_and(|ext| {
                        PREVIEW_EXTENSIONS
                            .iter()
                            .any(|known| ext.to_string_lossy().eq_ignore_ascii_case(known))
                    })
                {
                    names.insert(name.to_lowercase(), name);
                }
            }
        }
        names
    });
    let custom_name = format!(
        "{}{}",
        path.file_name()?.to_str()?,
        preview::CUSTOM_COVER_SUFFIX
    );
    if names.contains_key(&custom_name.to_lowercase()) {
        if let Some(preview) = custom_preview(path, max_bytes) {
            return Some(preview);
        }
    }
    for base in preview_bases(path)? {
        for ext in PREVIEW_EXTENSIONS {
            if let Some(name) = names.get(&format!("{base}.{ext}").to_lowercase()) {
                let source = Source::open(path).ok()?;
                if let Ok(file) = source.dir.regular(name) {
                    let size = file.metadata().ok()?.len();
                    if size > 0 && size <= max_bytes && source.verify().is_ok() {
                        return Some(path.with_file_name(name).to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    None
}

fn stamp(path: &Path) -> Result<Stamp, String> {
    let source = Source::open(path)?;
    let name = format!("{}{SIDECAR}", source.name);
    let sidecar = match std::fs::symlink_metadata(source.dir.path.join(&name)) {
        Ok(_) => Some(fingerprint(&source.dir.regular(&name)?)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    source.verify()?;
    Ok(Stamp {
        model: source.stamp,
        sidecar,
        resolved: source.dir.path.join(&source.name),
    })
}

fn read_any(path: &Path) -> Option<Index> {
    // A corrupt/obsolete snapshot is a cache miss, never model authority.
    #[cfg(windows)]
    let file = crate::win::open_no_follow(path).ok()?;
    #[cfg(not(windows))]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        File::options()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .ok()?
    };
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let index: Index = serde_json::from_reader(file.take(MAX_BYTES + 1)).ok()?;
    let roots = &index.roots;
    (index.schema == SCHEMA
        && index.detector == env!("CARGO_PKG_VERSION")
        && !roots.is_empty()
        && roots.len() <= 32
        && roots.iter().all(|root| absolute_path_valid(root))
        && index.records.len() <= MAX_WALK * roots.len()
        && index.records.iter().all(|record| {
            let m = &record.model;
            absolute_path_valid(Path::new(&m.path))
                && roots
                    .iter()
                    .any(|root| Path::new(&m.path).starts_with(root))
                && m.local_preview.as_ref().is_none_or(|preview| {
                    preview.len() <= 32768 && preview_path_valid(&m.path, preview)
                })
                && m.trigger_words
                    .as_ref()
                    .is_none_or(|words| validate_trigger_words(words).is_ok())
                && !m.name.is_empty()
                && !m.name.chars().any(char::is_control)
                && m.name.len() <= 32768
                && m.path.len() <= 32768
                && Path::new(&m.path).ends_with(&m.name)
                && Path::new(&m.name)
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)))
                && crate::settings::model_folder_category(&m.category).is_some()
        }))
    .then_some(index)
}

fn read(path: &Path, roots: &[PathBuf]) -> Option<Index> {
    read_any(path).filter(|index| index.roots == roots)
}

pub fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_cache_dir()
        .map(|path| path.join("model-index-v1"))
        .map_err(|e| e.to_string())
}

pub(super) fn file_members(
    directory: &Path,
    root: &Path,
) -> Result<HashMap<PathBuf, (String, SourceFingerprint)>, String> {
    let roots = [root.to_path_buf()];
    let index = read(&index_path(directory, &roots)?, &roots)
        .ok_or("Refresh models before editing library files")?;
    Ok(index
        .records
        .into_iter()
        .filter_map(|record| {
            Some((
                PathBuf::from(record.model.path),
                (record.model.category, record.stamp?.model),
            ))
        })
        .collect())
}

pub(super) fn apply_file_changes(
    directory: &Path,
    changes: &[super::files::FileChange],
) -> Result<(), String> {
    if changes.is_empty() {
        return Ok(());
    }
    let _guard = REFRESH
        .lock()
        .map_err(|_| "Model index update lock failed")?;
    let changes: HashMap<_, _> = changes
        .iter()
        .map(|change| (Path::new(&change.old), change))
        .collect();
    for entry in std::fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .take(128)
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let index_path = entry.path();
        if !entry.file_name().to_string_lossy().starts_with("models-")
            || index_path.extension().is_none_or(|ext| ext != "json")
        {
            continue;
        }
        let Some(mut index) = read_any(&index_path) else {
            continue;
        };
        let mut changed = false;
        index.records.retain_mut(|record| {
            let Some(change) = changes.get(Path::new(&record.model.path)) else {
                return true;
            };
            changed = true;
            let (Some(path), Some(name)) = (&change.path, &change.name) else {
                return false;
            };
            record.model.path = path.clone();
            record.model.name = name.clone();
            record.model.local_preview = change.local_preview.clone();
            record.stamp = stamp(Path::new(path)).ok();
            true
        });
        if changed {
            publish(&index_path, &index)?;
        }
    }
    Ok(())
}

fn index_path(directory: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(roots).map_err(|e| e.to_string())?)
    );
    Ok(directory.join(format!("models-{key}.json")))
}

/// Patch one explicitly edited file into existing indexes; never walk model folders.
pub fn update(directory: &Path, path: &Path) -> Result<(), String> {
    update_many(directory, &[path.to_path_buf()])
}

/// Publish a completed metadata batch once per index, without a model-folder walk.
pub fn update_many(directory: &Path, paths: &[PathBuf]) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    let _guard = REFRESH
        .lock()
        .map_err(|_| "Model index update lock failed")?;
    let mut snapshots = HashMap::new();
    let mut folders = PreviewFolders::new();
    for path in paths {
        let (category, base) = model_category(path)?;
        let model = describe(category, base, path)?;
        let mut snapshot: SnapshotModel =
            serde_json::from_value(serde_json::to_value(model).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        snapshot.local_preview = local_preview(path, &mut folders, MAX_DISPLAY_PREVIEW);
        snapshots.insert(path.clone(), (snapshot, stamp(path).ok()));
    }
    for entry in std::fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .take(128)
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with("models-")
            || entry.path().extension().is_none_or(|ext| ext != "json")
        {
            continue;
        }
        let Some(mut index) = read_any(&entry.path()) else {
            continue;
        };
        let mut changed = false;
        for record in &mut index.records {
            if let Some((snapshot, stamp)) = snapshots.get(Path::new(&record.model.path)) {
                let added = record.model.details.added_at;
                record.model = snapshot.clone();
                record.model.details.added_at = added;
                record.stamp = stamp.clone();
                changed = true;
            }
        }
        if changed {
            publish(&entry.path(), &index)?;
        }
    }
    Ok(())
}

fn publish(path: &Path, index: &Index) -> Result<(), String> {
    let bytes = serde_json::to_vec(index).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Model browsing index exceeds its size limit".into());
    }
    let parent = path.parent().ok_or("Missing index directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

fn payload(index: Index) -> Vec<SnapshotModel> {
    let mut models: Vec<_> = index.records.into_iter().map(|r| r.model).collect();
    if models.len() > MAX_LISTING {
        crate::logs::push(
            crate::logs::Source::Deas,
            "WARN: Library index operation=list webview model limit reached",
        );
        models.truncate(MAX_LISTING);
    }
    models
}

pub fn load(
    directory: &Path,
    roots: Vec<PathBuf>,
    refresh: bool,
) -> Result<Vec<SnapshotModel>, String> {
    load_scoped(directory, roots, refresh, None)
}

#[derive(Deserialize)]
pub struct RefreshScope {
    category: String,
    folder: Option<String>,
}

impl RefreshScope {
    fn includes(&self, category: &str) -> bool {
        if self.category == "models" {
            matches!(category, "checkpoints" | "diffusion_models")
        } else {
            category == self.category
        }
    }

    fn folder(&self) -> Result<PathBuf, String> {
        if self.category != "models"
            && !crate::settings::MODEL_FOLDERS.contains(&self.category.as_str())
        {
            return Err("Invalid Library refresh category".into());
        }
        let Some(folder) = &self.folder else {
            return Ok(PathBuf::new());
        };
        let mut relative = PathBuf::new();
        if folder.is_empty() || folder.len() > 32768 || folder.chars().any(char::is_control) {
            return Err("Invalid Library refresh folder".into());
        }
        for part in folder.split('/') {
            let mut components = Path::new(part).components();
            if part.starts_with('.')
                || part.contains('\\')
                || !matches!(components.next(), Some(std::path::Component::Normal(_)))
                || components.next().is_some()
            {
                return Err("Invalid Library refresh folder".into());
            }
            relative.push(part);
        }
        if relative.components().count() > MAX_DEPTH {
            return Err("Library refresh folder is too deep".into());
        }
        Ok(relative)
    }
}

pub fn load_scoped(
    directory: &Path,
    roots: Vec<PathBuf>,
    refresh: bool,
    scope: Option<RefreshScope>,
) -> Result<Vec<SnapshotModel>, String> {
    let refresh = refresh || scope.is_some();
    let relative = scope.as_ref().map(RefreshScope::folder).transpose()?;
    if roots.is_empty() || roots.len() > 32 || roots.iter().any(|p| !absolute_path_valid(p)) {
        return Err("Invalid model index roots".into());
    }
    let path = index_path(directory, &roots)?;
    if !refresh {
        if let Some(index) = read(&path, &roots) {
            return Ok(payload(index));
        }
    }
    let _guard = REFRESH
        .lock()
        .map_err(|_| "Model index refresh lock failed")?;
    let mut previous = read(&path, &roots);
    // Coalesce simultaneous cold starts from Library and Studio.
    if !refresh {
        if let Some(index) = previous.take() {
            return Ok(payload(index));
        }
    }
    if scope.is_some() && previous.is_none() {
        return Err("Refresh all models once before refreshing one folder".into());
    }
    let old_records = previous.map(|index| index.records).unwrap_or_default();
    let old: HashMap<_, _> = old_records
        .iter()
        .map(|r| ((r.model.category.clone(), r.model.path.clone()), r))
        .collect();
    let mut jobs = vec![];
    let mut remaining = MAX_WALK;
    for root in &roots {
        if resolve_directory(root).is_err() {
            return Err("Models folder could not be read; saved index retained".into());
        }
        for (category, base) in crate::settings::model_locations(root) {
            if scope
                .as_ref()
                .is_some_and(|scope| !scope.includes(category))
            {
                continue;
            }
            let target = relative
                .as_ref()
                .map_or_else(|| base.clone(), |folder| base.join(folder));
            if scope.is_some() {
                match std::fs::metadata(&target) {
                    Ok(meta) if meta.is_dir() && resolve_directory(&target).is_ok() => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    _ => {
                        return Err(
                            "Could not read the selected Library folder; saved index retained"
                                .into(),
                        )
                    }
                }
            }
            let depth = relative
                .as_ref()
                .map_or(0, |folder| folder.components().count());
            walk(category, &base, &target, depth, &mut jobs, &mut remaining);
        }
    }
    if scope.is_some() && remaining == 0 {
        return Err("Invalid or oversized Library refresh scope; saved index retained".into());
    }
    if remaining == 0 {
        crate::logs::push(crate::logs::Source::Deas,
            "WARN: Library index operation=scan entry limit reached; narrow the configured model roots");
    }
    let chunk = jobs.len().div_ceil(4).max(1);
    let mut records = std::thread::scope(|scope| {
        let handles: Vec<_> = jobs
            .chunks(chunk)
            .map(|part| {
                let old = &old;
                scope.spawn(move || {
                    let mut preview_folders = PreviewFolders::new();
                    part.iter()
                        .filter_map(|(category, base, path)| {
                            let stamp = stamp(path).ok();
                            if let Some(saved) = old
                                .get(&(category.to_string(), path.to_string_lossy().into_owned()))
                            {
                                if stamp.is_some() && stamp == saved.stamp {
                                    let mut saved = (*saved).clone();
                                    saved.model.local_preview = local_preview(
                                        path,
                                        &mut preview_folders,
                                        MAX_DISPLAY_PREVIEW,
                                    );
                                    return Some(saved);
                                }
                            }
                            let model = describe(category, base, path).ok()?;
                            let mut model: SnapshotModel =
                                serde_json::from_value(serde_json::to_value(model).ok()?).ok()?;
                            model.local_preview =
                                local_preview(path, &mut preview_folders, MAX_DISPLAY_PREVIEW);
                            model.details.added_at = old
                                .get(&(category.to_string(), path.to_string_lossy().into_owned()))
                                .and_then(|saved| saved.model.details.added_at)
                                .or_else(|| {
                                    std::fs::metadata(path)
                                        .ok()?
                                        .created()
                                        .ok()?
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .ok()
                                        .map(|d| d.as_secs())
                                })
                                .or_else(|| {
                                    std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .ok()
                                        .map(|d| d.as_secs())
                                });
                            Some(Record { stamp, model })
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut records = vec![];
        for handle in handles {
            records.extend(
                handle
                    .join()
                    .map_err(|_| "Model index worker failed".to_owned())?,
            );
        }
        Ok::<_, String>(records)
    })?;
    if records.len() < jobs.len() {
        crate::logs::push(crate::logs::Source::Deas, &format!("WARN: Library index operation=inspect skipped={} model files; check file access and metadata", jobs.len()-records.len()));
    }
    if let Some(scope) = &scope {
        let relative = relative.as_deref().unwrap_or(Path::new(""));
        records.extend(
            old_records
                .iter()
                .filter(|record| {
                    !scope.includes(&record.model.category)
                        || !Path::new(&record.model.name).starts_with(relative)
                })
                .cloned(),
        );
    }
    let mut seen = std::collections::HashSet::new();
    let records = records
        .into_iter()
        .filter(|r| {
            seen.insert((
                r.model.category.clone(),
                r.model.name.clone(),
                r.stamp
                    .as_ref()
                    .map(|s| s.resolved.clone())
                    .unwrap_or_else(|| PathBuf::from(&r.model.path)),
            ))
        })
        .collect();
    let index = Index {
        schema: SCHEMA,
        detector: env!("CARGO_PKG_VERSION").into(),
        roots,
        records,
    };
    if publish(&path, &index).is_err() {
        crate::logs::push(crate::logs::Source::Deas, "WARN: Library index operation=save snapshot could not be persisted; current listing remains available");
    }
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!(
            "INFO: Library index operation=refresh listed={} reused={} (browsing snapshot only)",
            index.records.len(),
            index
                .records
                .iter()
                .filter(|r| old
                    .get(&(r.model.category.clone(), r.model.path.clone()))
                    .is_some_and(|old| old.stamp.is_some() && old.stamp == r.stamp))
                .count()
        ),
    );
    Ok(payload(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_refresh_reconciles_only_the_selected_folder() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("models");
        let cache = fixture.path().join("index");
        let selected = root.join("loras/style");
        let adjacent = root.join("loras/style-extra");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(&adjacent).unwrap();
        std::fs::create_dir_all(root.join("checkpoints")).unwrap();
        let removed = selected.join("old.pt");
        let added = selected.join("new.pt");
        let untouched = adjacent.join("cached.pt");
        let checkpoint = root.join("checkpoints/cached.pt");
        for file in [&removed, &untouched, &checkpoint] {
            std::fs::write(file, b"old").unwrap();
        }
        assert_eq!(load(&cache, vec![root.clone()], false).unwrap().len(), 3);
        std::fs::remove_file(&removed).unwrap();
        std::fs::write(&added, b"new").unwrap();
        std::fs::write(&untouched, b"changed on disk").unwrap();
        std::fs::remove_file(&checkpoint).unwrap();
        let scope = RefreshScope {
            category: "loras".into(),
            folder: Some("style".into()),
        };
        let models = load_scoped(&cache, vec![root.clone()], true, Some(scope)).unwrap();
        assert_eq!(models.len(), 3);
        assert!(models.iter().any(|model| Path::new(&model.path) == added));
        assert!(models
            .iter()
            .any(|model| Path::new(&model.path) == untouched && model.size == 3));
        assert!(models
            .iter()
            .any(|model| Path::new(&model.path) == checkpoint));
        assert!(models.iter().all(|model| Path::new(&model.path) != removed));
        assert!(load_scoped(
            &cache,
            vec![root.clone()],
            true,
            Some(RefreshScope {
                category: "loras".into(),
                folder: Some("../checkpoints".into()),
            })
        )
        .is_err());
        let models = load(&cache, vec![root], true).unwrap();
        assert!(models
            .iter()
            .any(|model| Path::new(&model.path) == untouched && model.size > 3));
        assert!(models
            .iter()
            .all(|model| Path::new(&model.path) != checkpoint));
    }

    #[test]
    fn cache_rejects_traversal_in_roots_models_and_previews() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::write(root.join("loras/a.pt"), b"fixture").unwrap();
        let cache = dir.path().join("index");
        load(&cache, vec![root.clone()], false).unwrap();
        let file = std::fs::read_dir(&cache)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        for field in ["root", "model", "preview"] {
            let mut index = read(&file, std::slice::from_ref(&root)).unwrap();
            match field {
                "root" => index.roots = vec![root.join("../models")],
                "model" => {
                    index.records[0].model.path =
                        root.join("../outside/a.pt").to_string_lossy().into_owned()
                }
                _ => {
                    index.records[0].model.local_preview = Some(
                        root.join("loras/../outside/a.png")
                            .to_string_lossy()
                            .into_owned(),
                    )
                }
            }
            let invalid = cache.join(format!("invalid-{field}.json"));
            publish(&invalid, &index).unwrap();
            assert!(read_any(&invalid).is_none(), "{field}");
        }
        assert!(load(&cache, vec![root.join("../models")], false).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cache_fifo_is_a_nonblocking_miss() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models-fifo.json");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_any(&path).is_none());
    }

    #[test]
    fn sibling_previews_support_raster_formats_and_refresh_without_model_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        let folder = root.join("loras");
        std::fs::create_dir_all(&folder).unwrap();
        let model = folder.join("a.pt");
        std::fs::write(&model, b"fixture").unwrap();
        let cache = dir.path().join("index");
        assert!(load(&cache, vec![root.clone()], false).unwrap()[0]
            .local_preview
            .is_none());
        for ext in ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "JpG"] {
            let image = folder.join(format!("a.preview.{ext}"));
            std::fs::write(&image, b"synthetic image fixture").unwrap();
            assert!(load(&cache, vec![root.clone()], false).unwrap()[0]
                .local_preview
                .is_none());
            let refreshed = load(&cache, vec![root.clone()], true).unwrap();
            assert_eq!(refreshed[0].local_preview.as_deref(), image.to_str());
            assert_eq!(
                load(&cache, vec![root.clone()], false).unwrap()[0]
                    .local_preview
                    .as_deref(),
                image.to_str()
            );
            std::fs::remove_file(image).unwrap();
            assert!(load(&cache, vec![root.clone()], true).unwrap()[0]
                .local_preview
                .is_none());
        }
        assert!(!preview_path_valid(
            model.to_str().unwrap(),
            folder.join("x.svg").to_str().unwrap()
        ));
        assert!(!preview_path_valid(
            model.to_str().unwrap(),
            dir.path().join("x.jpg").to_str().unwrap()
        ));
    }

    #[test]
    fn refresh_reuses_unchanged_records_but_not_changed_sidecars_and_recovers_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::write(root.join("loras/a.pt"), b"fixture").unwrap();
        let cache = dir.path().join("cache");
        load(&cache, vec![root.clone()], false).unwrap();
        let file = std::fs::read_dir(&cache)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut index = read(&file, std::slice::from_ref(&root)).unwrap();
        index.records[0].model.details.family = Some("fixture-reused".into());
        publish(&file, &index).unwrap();
        let reused = load(&cache, vec![root.clone()], true).unwrap();
        assert_eq!(reused[0].details.family.as_deref(), Some("fixture-reused"));
        std::fs::write(root.join("loras/a.pt.deas.json"), b"invalid cache").unwrap();
        let changed = load(&cache, vec![root.clone()], true).unwrap();
        assert!(changed[0].details.metadata_error.is_some());
        assert_ne!(changed[0].details.family.as_deref(), Some("fixture-reused"));
        std::fs::write(&file, b"corrupt index").unwrap();
        assert_eq!(load(&cache, vec![root.clone()], false).unwrap().len(), 1);
        let missing = dir.path().join("offline");
        std::fs::rename(&root, &missing).unwrap();
        assert_eq!(load(&cache, vec![root.clone()], false).unwrap().len(), 1);
        assert!(load(&cache, vec![root.clone()], true).is_err());
        assert!(read(&file, &[root]).is_some());
        assert!(load(&cache, vec![missing.join("missing")], false).is_err());
    }

    #[test]
    fn persisted_index_survives_restart_and_refresh_tracks_changes_without_rewriting_models() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        let folder = root.join("loras/group/nested");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.pt");
        std::fs::write(&file, b"original").unwrap();
        let cache = dir.path().join("index");
        let first = load(&cache, vec![root.clone()], false).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].name.replace('\\', "/"), "group/nested/a.pt");
        std::fs::write(&file, b"changed-size").unwrap();
        std::fs::write(folder.join("b.pt"), b"new").unwrap();
        let saved = load(&cache, vec![root.clone()], false).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].size, 8); // A warm load does not walk or inspect changed files.
        let updated = load(&cache, vec![root.clone()], true).unwrap();
        assert_eq!(updated.len(), 2);
        assert_eq!(
            updated
                .iter()
                .find(|m| m.name.ends_with("a.pt"))
                .unwrap()
                .size,
            12
        );
        let again = load(&cache, vec![root.clone()], true).unwrap();
        assert_eq!(again.len(), 2);
        write_family(&file, Some("sdxl")).unwrap();
        update(&cache, &file).unwrap();
        let edited = load(&cache, vec![root.clone()], false).unwrap();
        assert_eq!(
            edited
                .iter()
                .find(|m| m.name.ends_with("a.pt"))
                .unwrap()
                .details
                .family_override
                .as_deref(),
            Some("sdxl")
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(load(&cache, vec![root.clone()], false).unwrap().len(), 2);
        assert_eq!(load(&cache, vec![root], true).unwrap().len(), 1);
        assert_eq!(std::fs::read(folder.join("b.pt")).unwrap(), b"new");
    }

    #[test]
    fn schema_pin_guarding_the_detection_bump_law() {
        // AF2-M28: bump this constant whenever detect_component / family detection
        // logic changes, so stale already-stamped records are forced through one
        // full re-describe. Raised 1 -> 2 for the AF2-M26 component signatures;
        // live proof 2026-11-22 (refreshed:144 with component:null persisting).
        assert_eq!(SCHEMA, 2);
    }

    #[test]
    fn obsolete_schema_snapshot_is_a_cache_miss_and_forces_redescribe() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::write(root.join("loras/a.pt"), b"fixture").unwrap();
        let cache = dir.path().join("index");
        load(&cache, vec![root.clone()], false).unwrap();
        let file = std::fs::read_dir(&cache)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut stale = read(&file, std::slice::from_ref(&root)).unwrap();
        assert_eq!(stale.schema, SCHEMA);
        stale.schema = 1;
        stale.records[0].model.details.family = Some("stale-v1-sentinel".into());
        publish(&file, &stale).unwrap();
        assert!(read_any(&file).is_none());
        assert!(read(&file, std::slice::from_ref(&root)).is_none());
        let warmed = load(&cache, vec![root.clone()], false).unwrap();
        assert_eq!(warmed.len(), 1);
        assert_ne!(
            warmed[0].details.family.as_deref(),
            Some("stale-v1-sentinel")
        );
        let republished = read(&file, std::slice::from_ref(&root)).unwrap();
        assert_eq!(republished.schema, SCHEMA);
        assert_ne!(
            republished.records[0].model.details.family.as_deref(),
            Some("stale-v1-sentinel")
        );
    }
}
