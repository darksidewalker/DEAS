//! Installed-model library: scan the ComfyUI models folder and enrich files with CivitAI
//! metadata looked up by SHA-256. Metadata is cached beside the file as `<file>.deas.json`;
//! the model file itself is only ever read.
use super::*;
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const EXTENSIONS: [&str; 7] = ["safetensors", "sft", "ckpt", "pt", "pth", "gguf", "bin"];
const MAX_MODELS: usize = 5000;
const MAX_DEPTH: usize = 8;
const SIDECAR: &str = ".deas.json";
// Small advisory JSON only; read at most this bound plus one detection byte.
const MAX_CACHE_BYTES: u64 = 128 * 1024;
// Only the short filesystem commit is serialized, on a blocking worker. Network
// requests/hash work remain concurrent. An optimistic snapshot rejects late replies.
static CACHE_PUBLICATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceFingerprint {
    platform: String,
    device: u64,
    file_id: [u8; 16],
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

fn file_identity(file: &File) -> Result<(u64, [u8; 16], u64), String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata().map_err(|e| e.to_string())?;
        let mut id = [0; 16];
        id[..8].copy_from_slice(&m.ino().to_le_bytes());
        Ok((m.dev(), id, m.nlink()))
    }
    #[cfg(windows)]
    {
        crate::win::cache_file_identity(file)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = file;
        Err("Safe model metadata requires Linux or Windows".into())
    }
}

fn fingerprint(file: &File) -> Result<SourceFingerprint, String> {
    let m = file.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() {
        return Err("Model/cache must be a regular file".into());
    }
    let (device, file_id, _) = file_identity(file)?;
    let modified = m
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(SourceFingerprint {
        platform: std::env::consts::OS.into(),
        device,
        file_id,
        size: m.len(),
        modified_secs: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
    })
}

fn checked_cache_file(file: &File) -> Result<(), String> {
    if file_identity(file)?.2 != 1 {
        return Err("Hard-linked model cache".into());
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata().map_err(|e| e.to_string())?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
            return Err("Model cache must be owned with trusted permissions".into());
        }
    }
    Ok(())
}

// Reuse the existing checked-directory policy. Linux child I/O is descriptor
// relative. Windows rechecks the path's directory identity before path-based I/O;
// its ACL/same-user substitution limits are the same as downloads/fs.rs.
struct CacheDir {
    anchor: fs::Anchor,
    path: PathBuf,
}

impl CacheDir {
    fn open(path: &Path) -> Result<Self, String> {
        Ok(Self {
            anchor: fs::Anchor::open(path)?,
            path: path.into(),
        })
    }

    fn verify(&self) -> Result<(), String> {
        let again = fs::Anchor::open(&self.path)?;
        if again.identity()? != self.anchor.identity()? {
            return Err("Model directory changed during metadata lookup".into());
        }
        #[cfg(windows)]
        if file_identity(&again.0)? != file_identity(&self.anchor.0)? {
            return Err("Model directory identity changed".into());
        }
        Ok(())
    }

    fn regular(&self, name: &str) -> Result<File, String> {
        self.verify()?;
        #[cfg(windows)]
        if name.contains(':') {
            return Err("Model cache filenames cannot address alternate data streams".into());
        }
        #[cfg(target_os = "linux")]
        let file: File = {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(name).map_err(|_| "Invalid cache filename")?;
            let fd = unsafe {
                libc::openat(
                    self.anchor.0.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            unsafe { File::from_raw_fd(fd) }
        };
        #[cfg(windows)]
        let file = crate::win::open_no_follow(&self.path.join(name))?;
        #[cfg(not(any(target_os = "linux", windows)))]
        let file = {
            let _ = name;
            return Err("Unsupported model cache platform".into());
        };
        fingerprint(&file)?;
        Ok(file)
    }

    fn cache(&self, name: &str) -> Result<Option<(SourceFingerprint, ModelInfo)>, String> {
        self.verify()?;
        if self.anchor.absent(name).is_ok() {
            return Ok(None);
        }
        let mut file = self.regular(name)?;
        let before = fingerprint(&file)?;
        checked_cache_file(&file)?;
        if before.size > MAX_CACHE_BYTES {
            return Err("Oversize model cache".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_CACHE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_CACHE_BYTES
            || bytes.len() as u64 != before.size
            || fingerprint(&file)? != before
            || fingerprint(&self.regular(name)?)? != before
        {
            return Err("Model cache changed while reading".into());
        }
        checked_cache_file(&file)?;
        let info: ModelInfo = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate_info(&info)?;
        Ok(Some((before, info)))
    }

    fn replace(&self, temp: &str, target: &str, existing: bool) -> Result<(), String> {
        self.verify()?;
        self.anchor.writable()?;
        if !existing {
            return self.anchor.publish(temp, target);
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let from = std::ffi::CString::new(temp).map_err(|_| "Invalid cache filename")?;
            let to = std::ffi::CString::new(target).map_err(|_| "Invalid cache filename")?;
            if unsafe {
                libc::renameat(
                    self.anchor.0.as_raw_fd(),
                    from.as_ptr(),
                    self.anchor.0.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            self.anchor.0.sync_all().map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            // Rename the entry, never open/truncate the destination. The checked
            // regular single-link cache was revalidated under CACHE_PUBLICATION.
            std::fs::rename(self.path.join(temp), self.path.join(target)).map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = (temp, target);
            Err("Unsupported model cache platform".into())
        }
    }
}

struct OwnedTemp<'a> {
    dir: &'a CacheDir,
    name: String,
    file: File,
}

impl<'a> OwnedTemp<'a> {
    fn create(dir: &'a CacheDir) -> Result<Self, String> {
        dir.verify()?;
        dir.anchor.writable()?;
        let name = format!(".deas-model-cache-{}.tmp", uuid::Uuid::new_v4());
        let file = dir.anchor.partial(&name)?;
        Ok(Self { dir, name, file })
    }

    fn verify(&self) -> Result<(), String> {
        if !self.dir.anchor.owns_partial(&self.name, &self.file)
            || file_identity(&self.file)?.2 != 1
            || fingerprint(&self.dir.regular(&self.name)?)? != fingerprint(&self.file)?
        {
            return Err("Metadata temporary file was replaced or linked".into());
        }
        Ok(())
    }
}

impl Drop for OwnedTemp<'_> {
    fn drop(&mut self) {
        if self.verify().is_ok() {
            self.dir.anchor.remove_partial(&self.name);
        }
    }
}

struct Source {
    dir: CacheDir,
    name: String,
    file: File,
    stamp: SourceFingerprint,
}

impl Source {
    fn open(path: &Path) -> Result<Self, String> {
        let dir = CacheDir::open(path.parent().ok_or("Model has no parent")?)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Model filename is not UTF-8")?
            .to_owned();
        let file = dir.regular(&name)?;
        let stamp = fingerprint(&file)?;
        Ok(Self {
            dir,
            name,
            file,
            stamp,
        })
    }

    fn verify(&self) -> Result<(), String> {
        if fingerprint(&self.file)? != self.stamp
            || fingerprint(&self.dir.regular(&self.name)?)? != self.stamp
        {
            return Err("Model changed during metadata lookup".into());
        }
        Ok(())
    }

    fn hash(&mut self) -> Result<String, String> {
        self.hash_checked(|| {})
    }

    fn hash_checked(&mut self, after_read: impl FnOnce()) -> Result<String, String> {
        self.verify()?;
        let mut hasher = Sha256::new();
        let copied = std::io::copy(
            &mut Read::by_ref(&mut self.file).take(self.stamp.size.saturating_add(1)),
            &mut hasher,
        )
        .map_err(|e| e.to_string())?;
        after_read();
        self.verify()?;
        if copied != self.stamp.size {
            return Err("Model size changed while hashing".into());
        }
        Ok(format!("{:x}", hasher.finalize()))
    }
}

/// Generation settings taken from the first CivitAI showcase image that carries any.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampler: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduler: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cfg_scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_skip: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CivitaiInfo {
    pub model_id: u64,
    pub version_id: u64,
    pub name: String,
    pub version: String,
    pub model_type: String,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub nsfw: bool,
    pub trained_words: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
}

/// Sidecar content. `civitai: None` after a fetch means the hash is unknown to CivitAI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub sha256: String,
    pub size: u64,
    pub fetched_at: u64,
    pub civitai: Option<CivitaiInfo>,
    // Additive cache schema; absent in legacy sidecars, which are never reused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<SourceFingerprint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub category: String,
    /// Path relative to the category folder, the way ComfyUI names models.
    pub name: String,
    pub path: String,
    pub size: u64,
    pub info: Option<ModelInfo>,
    /// Architecture family from `crate::model_families` (header or CivitAI base); absent = unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Header-verified companion architecture ID; omitted for unknown/unsupported formats.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
}

fn is_model(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
fn sidecar(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(SIDECAR);
    PathBuf::from(s)
}

fn read_info(path: &Path) -> Option<ModelInfo> {
    let source = Source::open(path).ok()?;
    let (_, info) = source
        .dir
        .cache(&format!("{}{SIDECAR}", source.name))
        .ok()??;
    source.verify().ok()?;
    (info.source.as_ref() == Some(&source.stamp)).then_some(info)
}

fn validate_info(info: &ModelInfo) -> Result<(), String> {
    if info.sha256.len() != 64 || !info.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid cached SHA-256".into());
    }
    if info.fetched_at > 253_402_300_799
        || info.source.as_ref().is_some_and(|s| {
            s.size != info.size
                || s.modified_nanos >= 1_000_000_000
                || !matches!(s.platform.as_str(), "linux" | "windows")
        })
    {
        return Err("Invalid cache fingerprint/timestamp".into());
    }
    if let Some(c) = &info.civitai {
        bounded_text(&c.name, 240)?;
        bounded_text(&c.version, 240)?;
        if c.model_id == 0
            || c.version_id == 0
            || c.model_type.chars().count() > 40
            || c.model_type.chars().any(char::is_control)
            || c.category != providers::civitai_category(Some(&c.model_type))
            || c.trained_words.len() > 50
        {
            return Err("Invalid cached CivitAI fields".into());
        }
        if let Some(base) = &c.base {
            // The provider permits an empty base/type for unknown families.
            if base.len() > 64 || base.chars().any(char::is_control) {
                return Err("Invalid cached base model".into());
            }
        }
        for word in &c.trained_words {
            bounded_text(word, 200)?;
        }
        if let Some(preview) = &c.preview {
            bounded_text(preview, 2048)?;
            let u = Url::parse(preview).map_err(|_| "Invalid cached preview")?;
            if u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err("Invalid cached preview".into());
            }
        }
        if let Some(s) = &c.settings {
            for (text, max) in [(&s.sampler, 64), (&s.scheduler, 64), (&s.size, 32)] {
                if let Some(text) = text {
                    bounded_text(text, max)?;
                }
            }
            if s.cfg_scale
                .is_some_and(|n| !n.is_finite() || !(0.0..=1000.0).contains(&n))
                || s.steps.is_some_and(|n| !(1..=10_000).contains(&n))
                || s.clip_skip.is_some_and(|n| n > 64)
            {
                return Err("Invalid cached numeric settings".into());
            }
        }
    }
    Ok(())
}

fn describe(category: &str, base: &Path, path: &Path) -> Result<LocalModel, String> {
    let shown = path
        .to_str()
        .ok_or("Model path is not valid UTF-8")?
        .to_owned();
    let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
    let info = read_info(path);
    let family = crate::model_families::detect(
        category,
        path,
        info.as_ref()
            .and_then(|i| i.civitai.as_ref()?.base.as_deref()),
    );
    let component = crate::model_families::detect_component(category, path).map(str::to_owned);
    if let Some(info) = &info {
        let current = Source::open(path)?;
        current.verify()?;
        if info.source.as_ref() != Some(&current.stamp) || info.size != meta.len() {
            return Err("Model changed during scan".into());
        }
    }
    Ok(LocalModel {
        category: category.into(),
        name: path
            .strip_prefix(base)
            .map_err(|_| "Model outside its category folder")?
            .to_string_lossy()
            .replace('\\', "/"),
        size: meta.len(),
        info,
        component,
        family,
        path: shown,
    })
}

fn walk(category: &str, base: &Path, dir: &Path, depth: usize, out: &mut Vec<LocalModel>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        if out.len() >= MAX_MODELS {
            return;
        }
        let hidden = path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with('.'));
        if hidden {
            continue;
        }
        if path.is_dir() {
            if depth < MAX_DEPTH {
                walk(category, base, &path, depth + 1, out);
            }
        } else if is_model(&path) {
            if let Ok(model) = describe(category, base, &path) {
                out.push(model);
            }
        }
    }
}

/// All model files under the standard ComfyUI category folders of each root, sorted per folder.
/// Extra roots (additional drives) are scanned with the same rules and appended.
pub fn scan_roots(roots: &[PathBuf]) -> Result<Vec<LocalModel>, String> {
    let mut models = vec![];
    for root in roots {
        models.extend(scan(root)?);
    }
    Ok(models)
}

/// All model files under the standard ComfyUI category folders of `root`, sorted per folder.
pub fn scan(root: &Path) -> Result<Vec<LocalModel>, String> {
    if !root.is_absolute() {
        return Err("Models folder must be absolute".into());
    }
    if !root.is_dir() {
        return Err(format!("{}: not an existing directory", root.display()));
    }
    let mut out = vec![];
    for category in crate::settings::MODEL_FOLDERS {
        let base = root.join(category);
        walk(category, &base, &base, 0, &mut out);
    }
    Ok(out)
}

#[cfg(test)]
fn sha256_file(path: &Path) -> Result<String, String> {
    Source::open(path)?.hash()
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}
fn short_text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)).then(|| s.to_owned())
}

fn settings(meta: &Value) -> Option<Settings> {
    let s = Settings {
        sampler: short_text(meta.get("sampler"), 64),
        scheduler: short_text(meta.get("scheduler"), 64),
        steps: meta.get("steps").and_then(number).map(|n| n as u64),
        cfg_scale: meta.get("cfgScale").and_then(number),
        size: short_text(meta.get("Size"), 32),
        clip_skip: meta.get("clipSkip").and_then(number).map(|n| n as u64),
    };
    (s != Settings::default()).then_some(s)
}

/// Shape of `GET api/v1/model-versions/by-hash/<sha256>`.
pub(super) fn civitai_info(v: &Value) -> Result<CivitaiInfo, String> {
    let model = v.get("model").ok_or("Missing CivitAI model")?;
    let name = providers::text(model, "name")?;
    let version = providers::text(v, "name")?;
    bounded_text(name, 240)?;
    bounded_text(version, 240)?;
    let model_type = model.get("type").and_then(Value::as_str).unwrap_or("");
    Ok(CivitaiInfo {
        model_id: v
            .get("modelId")
            .and_then(Value::as_u64)
            .ok_or("Missing CivitAI model ID")?,
        version_id: v
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("Missing CivitAI version ID")?,
        name: name.into(),
        version: version.into(),
        model_type: model_type.chars().take(40).collect(),
        category: providers::civitai_category(Some(model_type)).into(),
        base: providers::civitai_base(v),
        nsfw: model.get("nsfw").and_then(Value::as_bool).unwrap_or(false)
            || v.get("nsfwLevel").and_then(Value::as_u64).unwrap_or(0) >= 4,
        trained_words: v
            .get("trainedWords")
            .and_then(Value::as_array)
            .map(|words| {
                words
                    .iter()
                    .filter_map(|w| short_text(Some(w), 200))
                    .take(50)
                    .collect()
            })
            .unwrap_or_default(),
        preview: providers::civitai_preview(v),
        settings: v
            .get("images")
            .and_then(Value::as_array)
            .and_then(|images| images.iter().find_map(|i| settings(i.get("meta")?))),
    })
}

fn publish_info(
    source: &Source,
    expected: &Option<SourceFingerprint>,
    info: &ModelInfo,
    before_publish: impl FnOnce(),
) -> Result<(), String> {
    validate_info(info)?;
    let bytes = serde_json::to_vec_pretty(info).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_CACHE_BYTES || info.source.as_ref() != Some(&source.stamp) {
        return Err("Invalid metadata publication".into());
    }
    let _commit = CACHE_PUBLICATION
        .lock()
        .map_err(|_| "Cache lock poisoned")?;
    let target = format!("{}{SIDECAR}", source.name);
    let check_target = || -> Result<(), String> {
        if source.dir.cache(&target)?.map(|(stamp, _)| stamp) != *expected {
            return Err("Metadata cache changed during refresh; retry explicitly".into());
        }
        Ok(())
    };
    source.verify()?;
    check_target()?;
    let mut temp = OwnedTemp::create(&source.dir)?;
    temp.verify()?;
    temp.file.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.file.sync_all().map_err(|e| e.to_string())?;
    before_publish();
    source.verify()?;
    check_target()?;
    temp.verify()?;
    source
        .dir
        .replace(&temp.name, &target, expected.is_some())?;
    source.verify()
}

/// Hash an owned verified handle off the executor, look up CivitAI, then revalidate
/// the source and optimistic cache snapshot before publication. 404 means unknown.
pub async fn fetch(
    p: &Provider,
    path: PathBuf,
    header: Option<HeaderValue>,
) -> Result<LocalModel, String> {
    if p.kind != "civitai" {
        return Err("Metadata lookup needs the CivitAI provider".into());
    }
    if !path.is_absolute() || !is_model(&path) {
        return Err("Not an absolute path to a model file".into());
    }
    let model_path = path.clone();
    let (source, expected, sha256) = tokio::task::spawn_blocking(move || {
        let mut source = Source::open(&model_path)?;
        let cache = source.dir.cache(&format!("{}{SIDECAR}", source.name))?;
        let sha256 = match cache.as_ref() {
            Some((_, info)) if info.source.as_ref() == Some(&source.stamp) => info.sha256.clone(),
            _ => source.hash()?,
        };
        source.verify()?;
        Ok::<_, String>((source, cache.map(|(stamp, _)| stamp), sha256))
    })
    .await
    .map_err(|_| "Hashing task failed")??;
    let u = providers::endpoint(p, &["api", "v1", "model-versions", "by-hash", &sha256])?;
    let client = client_for(false)?;
    let found = tokio::time::timeout(
        Duration::from_secs(30),
        providers::json_optional(&client, p, u, &header),
    )
    .await
    .map_err(|_| "CivitAI lookup exceeded 30 seconds")??;
    let civitai = found.as_ref().map(civitai_info).transpose()?;
    let info = ModelInfo {
        sha256,
        size: source.stamp.size,
        fetched_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        civitai,
        source: Some(source.stamp.clone()),
    };
    tokio::task::spawn_blocking(move || {
        // Includes the first check after the network await, before any cache write.
        source.verify()?;
        publish_info(&source, &expected, &info, || {})?;
        let base = path.ancestors().skip(1).find(|a| {
            a.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| crate::settings::MODEL_FOLDERS.contains(&n))
        });
        let model = match base {
            Some(base) => describe(base.file_name().unwrap().to_str().unwrap(), base, &path),
            None => describe("", path.parent().unwrap_or(&path), &path),
        }?;
        source.verify()?;
        if model.info.as_ref() != Some(&info) {
            return Err("Metadata cache changed before returning".into());
        }
        Ok(model)
    })
    .await
    .map_err(|_| "Cache publication task failed")?
}

#[tauri::command]
pub fn native_models_scan(
    root: String,
    extra_roots: Option<Vec<String>>,
) -> Result<Vec<LocalModel>, String> {
    let mut roots = vec![PathBuf::from(&root)];
    if let Some(extra) = extra_roots {
        roots.extend(extra.iter().map(PathBuf::from));
    }
    scan_roots(&roots)
}
#[tauri::command]
pub async fn native_model_info(
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    path: String,
    authenticated: bool,
) -> Result<LocalModel, String> {
    let c = engine.catalog()?;
    let p = c
        .providers
        .iter()
        .find(|p| p.kind == "civitai")
        .ok_or("No CivitAI provider in catalog")?;
    let h = credential(&auth, p, authenticated)?;
    fetch(p, PathBuf::from(path), h).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_info(path: &Path) -> ModelInfo {
        ModelInfo {
            sha256: sha256_file(path).unwrap(),
            size: std::fs::metadata(path).unwrap().len(),
            fetched_at: 1,
            civitai: None,
            source: Some(Source::open(path).unwrap().stamp),
        }
    }

    fn write_info(path: &Path, info: &ModelInfo) {
        validate_info(info).unwrap();
        write_cache_bytes(&sidecar(path), &serde_json::to_vec(info).unwrap());
    }

    fn write_cache_bytes(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    fn assert_no_owned_temps(dir: &Path) {
        assert!(!std::fs::read_dir(dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".deas-model-cache-")
        }));
    }

    #[test]
    fn scan_lists_models_with_sidecars_and_parses_civitai_shape() {
        let root = tempfile::tempdir().unwrap();
        let loras = root.path().join("loras/Anima");
        std::fs::create_dir_all(&loras).unwrap();
        std::fs::write(loras.join("a.safetensors"), b"model").unwrap();
        let cached = fixture_info(&loras.join("a.safetensors"));
        write_info(&loras.join("a.safetensors"), &cached);
        std::fs::write(loras.join(".hidden.safetensors"), b"x").unwrap();
        std::fs::write(loras.join("readme.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.path().join("vae")).unwrap();
        std::fs::write(root.path().join("vae/v.pt"), b"vae").unwrap();
        let models = scan(root.path()).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].category, "loras");
        assert_eq!(models[0].name, "Anima/a.safetensors");
        assert_eq!(models[0].info.as_ref().unwrap(), &cached);
        assert_eq!(models[1].category, "vae");
        assert!(models[1].info.is_none());
        assert!(scan(Path::new("relative")).is_err());
        assert_eq!(
            sha256_file(&loras.join("a.safetensors")).unwrap(),
            "9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4"
        );
        let v: Value = serde_json::json!({"id":3160190,"modelId":2727972,"name":"Krea2 v1.0","nsfwLevel":60,
            "trainedWords":["D4S1W4_SL1ME"],"baseModel":"Krea 2","model":{"name":"True Slime Girls","type":"LORA","nsfw":true},
            "images":[{"url":"https://image.civitai.com/x/original=true/1.jpeg","type":"image","meta":{"prompt":"p"}},
                      {"url":"https://image.civitai.com/x/original=true/2.jpeg","type":"image","meta":{"steps":"30","sampler":"Euler a","cfgScale":4.5,"Size":"896x1152"}}]});
        let info = civitai_info(&v).unwrap();
        assert_eq!(info.category, "loras");
        assert_eq!(info.base.as_deref(), Some("Krea 2"));
        assert_eq!(info.trained_words, vec!["D4S1W4_SL1ME"]);
        assert_eq!(
            info.preview.as_deref(),
            Some("https://image.civitai.com/x/width=450/1.jpeg")
        );
        let s = info.settings.unwrap();
        assert_eq!(
            (
                s.steps,
                s.cfg_scale,
                s.sampler.as_deref(),
                s.size.as_deref()
            ),
            (Some(30), Some(4.5), Some("Euler a"), Some("896x1152"))
        );
        assert!(civitai_info(&serde_json::json!({"id":1})).is_err());
    }
    #[test]
    fn scan_serializes_optional_companion_identity_without_a_family() {
        let root = tempfile::tempdir().unwrap();
        let vae = root.path().join("vae");
        std::fs::create_dir(&vae).unwrap();
        let path = vae.join("renamed.safetensors");
        let mut head = serde_json::Map::new();
        let mut end = 0;
        for (key, shape) in [
            ("conv2.weight", vec![16, 16, 1, 1, 1]),
            ("encoder.conv1.weight", vec![96, 3, 3, 3, 3]),
            ("decoder.conv1.weight", vec![384, 16, 3, 3, 3]),
            ("decoder.middle.0.residual.0.gamma", vec![384, 1, 1, 1]),
            ("decoder.head.2.weight", vec![3, 96, 3, 3, 3]),
        ] {
            let start = end;
            end += shape.iter().product::<u64>() * 2;
            head.insert(
                key.into(),
                serde_json::json!({"dtype":"BF16", "shape":shape, "data_offsets":[start,end]}),
            );
        }
        let text = serde_json::to_vec(&head).unwrap();
        let mut file = File::create(&path).unwrap();
        file.write_all(&(text.len() as u64).to_le_bytes()).unwrap();
        file.write_all(&text).unwrap();
        file.set_len(8 + text.len() as u64 + end).unwrap();
        drop(file);
        std::fs::write(vae.join("unknown.pt"), b"unknown").unwrap();
        let models = scan(root.path()).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].component.as_deref(), Some("wan-2.1-vae"));
        assert!(models[0].family.is_none());
        let json = serde_json::to_value(&models).unwrap();
        assert_eq!(json[0]["component"], "wan-2.1-vae");
        assert!(json[0].get("family").is_none());
        assert!(json[1].get("component").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn scan_ignores_oversize_and_linked_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("loras");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("a.pt");
        std::fs::write(&path, b"model").unwrap();
        let info = fixture_info(&path);
        write_info(&path, &info);
        assert_eq!(scan(root.path()).unwrap()[0].info.as_ref(), Some(&info));
        let json = serde_json::to_string(&info).unwrap();
        std::fs::write(sidecar(&path), format!("{json}{}", " ".repeat(128 * 1024))).unwrap();
        assert!(
            scan(root.path()).unwrap()[0].info.is_none(),
            "oversize cache accepted"
        );
        std::fs::remove_file(sidecar(&path)).unwrap();
        let victim = root.path().join("victim");
        write_cache_bytes(&victim, json.as_bytes());
        std::os::unix::fs::symlink(&victim, sidecar(&path)).unwrap();
        assert!(
            scan(root.path()).unwrap()[0].info.is_none(),
            "linked cache accepted"
        );
        assert_eq!(std::fs::read(&victim).unwrap(), json.as_bytes());
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
    }

    async fn fetch_fixture(
        path: &Path,
        before_reply: impl FnOnce() + Send + 'static,
    ) -> Result<LocalModel, String> {
        fetch_fixture_reply(path, before_reply, None).await
    }

    async fn fetch_fixture_reply(
        path: &Path,
        before_reply: impl FnOnce() + Send + 'static,
        reply: Option<&'static str>,
    ) -> Result<LocalModel, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "No fixture request within 5 seconds"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("Fixture accept: {e}"),
                }
            };
            // Windows accepted sockets inherit the listener's non-blocking mode.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = vec![];
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 8192, "Oversize fixture request");
                let mut b = [0];
                stream.read_exact(&mut b).unwrap();
                request.push(b[0]);
            }
            before_reply();
            match reply {
                Some(json) => write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                )
                .unwrap(),
                None => stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .unwrap(),
            }
            String::from_utf8(request).unwrap()
        });
        let p = Provider {
            id: "fixture".into(),
            kind: "civitai".into(),
            label: "Fixture".into(),
            origin,
            scopes: vec!["model".into()],
            anonymous_notice: "".into(),
        };
        let result = fetch(&p, path.to_owned(), None).await;
        let request = tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap();
        if let Ok(model) = &result {
            assert!(request.contains(&model.info.as_ref().unwrap().sha256));
        }
        result
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cache_publication_does_not_truncate_linked_victims() {
        for hard in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("a.pt");
            let victim = root.path().join("victim");
            std::fs::write(&path, b"model").unwrap();
            std::fs::write(&victim, b"keep these bytes").unwrap();
            let tmp = sidecar(&path).with_extension("json.tmp");
            if hard {
                std::fs::hard_link(&victim, &tmp).unwrap();
            } else {
                std::os::unix::fs::symlink(&victim, &tmp).unwrap();
            }
            fetch_fixture(&path, || {}).await.unwrap();
            assert_eq!(std::fs::read(&victim).unwrap(), b"keep these bytes");
            assert_eq!(std::fs::read(&path).unwrap(), b"model");
            assert_eq!(std::fs::read(&tmp).unwrap(), b"keep these bytes");
            assert_no_owned_temps(root.path());
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn same_size_replacement_invalidates_scan_and_refresh() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("loras");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("a.pt");
        std::fs::write(&path, b"first").unwrap();
        let first = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
        let replacement = dir.join("replacement");
        std::fs::write(&replacement, b"other").unwrap();
        // Match mtime too: file identity must independently invalidate a replacement.
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(
            scan(root.path()).unwrap()[0].info.is_none(),
            "stale replacement metadata shown"
        );
        let refreshed = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
        assert_ne!(first.sha256, refreshed.sha256);
        assert_eq!(refreshed.sha256, sha256_file(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"other");
        assert_no_owned_temps(&dir);
    }

    #[tokio::test]
    async fn portable_valid_repeated_refresh_preserves_model_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Mödel with spaces.pt");
        std::fs::write(&path, b"model").unwrap();
        let expected = fixture_info(&path);
        for _ in 0..3 {
            let refreshed = fetch_fixture_reply(
                &path,
                || {},
                Some(r#"{"id":1,"modelId":2,"name":"v1","model":{"name":"Fixture model","type":"LORA"},"baseModel":"SDXL 1.0"}"#),
            )
            .await
            .unwrap()
            .info
            .unwrap();
            assert_eq!(refreshed.sha256, expected.sha256);
            assert_eq!(refreshed.source, expected.source);
            assert_eq!(refreshed.civitai.as_ref().unwrap().name, "Fixture model");
            assert_eq!(read_info(&path).as_ref(), Some(&refreshed));
            assert_eq!(std::fs::read(&path).unwrap(), b"model");
            assert_no_owned_temps(root.path());
        }
    }

    #[tokio::test]
    async fn portable_legacy_cache_is_an_untrusted_miss_and_refreshes() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("loras");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("a.pt");
        std::fs::write(&path, b"model").unwrap();
        let actual = fixture_info(&path);
        let mut legacy = actual.clone();
        legacy.sha256 = "0".repeat(64);
        legacy.source = None;
        write_info(&path, &legacy);
        let before = std::fs::read(sidecar(&path)).unwrap();
        assert!(scan(root.path()).unwrap()[0].info.is_none());
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), before);
        let refreshed = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
        assert_eq!(refreshed.sha256, actual.sha256);
        assert_eq!(refreshed.source, actual.source);
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
        assert_no_owned_temps(&dir);
    }

    #[test]
    fn portable_bounded_cache_reads_validate_fields_without_writing() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        std::fs::write(&path, b"model").unwrap();
        let mut info = fixture_info(&path);
        info.civitai = Some(
            civitai_info(&serde_json::json!({
                "id": 1, "modelId": 2, "name": "version", "baseModel": "SDXL 1.0",
                "model": {"name": "name", "type": "LORA"},
                "images": [{"url": "https://image.civitai.com/1.jpeg",
                    "meta": {"steps": 30, "cfgScale": 4.5, "clipSkip": 1}}]
            }))
            .unwrap(),
        );
        write_info(&path, &info);
        assert_eq!(read_info(&path).as_ref(), Some(&info));
        let valid = serde_json::to_value(&info).unwrap();
        for (pointer, value) in [
            ("/sha256", serde_json::json!("ab")),
            ("/size", serde_json::json!(99)),
            ("/source/modifiedNanos", serde_json::json!(1_000_000_000)),
            ("/civitai/name", serde_json::json!("bad\nname")),
            ("/civitai/preview", serde_json::json!("file:///victim")),
            (
                "/civitai/trainedWords",
                serde_json::json!(["x".repeat(201)]),
            ),
            ("/civitai/settings/steps", serde_json::json!(10_001)),
            ("/civitai/settings/cfgScale", serde_json::json!(-1)),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            let bytes = serde_json::to_vec(&invalid).unwrap();
            std::fs::write(sidecar(&path), &bytes).unwrap();
            assert!(read_info(&path).is_none(), "Accepted {pointer}");
            assert_eq!(std::fs::read(sidecar(&path)).unwrap(), bytes);
        }
        // Valid JSON plus whitespace: malformed JSON must not mask the size guard.
        let mut oversize = serde_json::to_vec(&info).unwrap();
        oversize.resize((MAX_CACHE_BYTES + 1) as usize, b' ');
        std::fs::write(sidecar(&path), &oversize).unwrap();
        assert!(read_info(&path).is_none());
        assert_eq!(
            std::fs::metadata(sidecar(&path)).unwrap().len(),
            MAX_CACHE_BYTES + 1
        );
        std::fs::write(sidecar(&path), b"{").unwrap();
        assert!(read_info(&path).is_none());
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), b"{");
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
    }

    #[test]
    fn portable_publication_preserves_hard_linked_and_foreign_final_objects() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        let victim = root.path().join("victim");
        std::fs::write(&path, b"model").unwrap();
        let info = fixture_info(&path);
        let bytes = serde_json::to_vec(&info).unwrap();
        write_cache_bytes(&victim, &bytes);
        // Otherwise-valid cache: rejection must be due to its hard link.
        std::fs::hard_link(&victim, sidecar(&path)).unwrap();
        let source = Source::open(&path).unwrap();
        assert!(read_info(&path).is_none());
        assert!(publish_info(&source, &None, &info, || {}).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), bytes);
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), bytes);
        std::fs::remove_file(sidecar(&path)).unwrap();
        std::fs::write(sidecar(&path), b"foreign file").unwrap();
        assert!(publish_info(&source, &None, &info, || {}).is_err());
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), b"foreign file");
        std::fs::remove_file(sidecar(&path)).unwrap();
        std::fs::create_dir(sidecar(&path)).unwrap();
        assert!(publish_info(&source, &None, &info, || {}).is_err());
        assert!(sidecar(&path).is_dir());
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
        assert_no_owned_temps(root.path());
    }

    #[tokio::test]
    async fn portable_same_size_replacement_with_same_mtime_invalidates_cache() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        std::fs::write(&path, b"first").unwrap();
        let first = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
        let replacement = root.path().join("replacement");
        std::fs::write(&replacement, b"other").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(read_info(&path).is_none());
        let next = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
        assert_ne!(first.sha256, next.sha256);
        assert_eq!(next.sha256, sha256_file(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"other");
    }

    #[test]
    fn portable_hash_rejects_replacement_after_read() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        std::fs::write(&path, b"first").unwrap();
        let mut source = Source::open(&path).unwrap();
        let result = source.hash_checked(|| {
            let replacement = root.path().join("replacement");
            std::fs::write(&replacement, b"other").unwrap();
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            File::options()
                .write(true)
                .open(&replacement)
                .unwrap()
                .set_modified(modified)
                .unwrap();
            std::fs::rename(&path, root.path().join("previous.pt")).unwrap();
            std::fs::rename(replacement, &path).unwrap();
        });
        assert!(result.unwrap_err().contains("Model changed"));
        assert_eq!(std::fs::read(&path).unwrap(), b"other");
        assert_eq!(
            std::fs::read(root.path().join("previous.pt")).unwrap(),
            b"first"
        );
        assert!(!sidecar(&path).exists());
    }

    #[tokio::test]
    async fn portable_changed_during_lookup_preserves_previous_cache() {
        for replace in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("a.pt");
            std::fs::write(&path, b"first").unwrap();
            fetch_fixture(&path, || {}).await.unwrap();
            let previous = std::fs::read(sidecar(&path)).unwrap();
            let changed = path.clone();
            let result = fetch_fixture(&path, move || {
                if replace {
                    let replacement = changed.with_extension("replacement");
                    std::fs::write(&replacement, b"other").unwrap();
                    let modified = std::fs::metadata(&changed).unwrap().modified().unwrap();
                    File::options()
                        .write(true)
                        .open(&replacement)
                        .unwrap()
                        .set_modified(modified)
                        .unwrap();
                    std::fs::rename(replacement, &changed).unwrap();
                } else {
                    let modified = std::fs::metadata(&changed).unwrap().modified().unwrap();
                    std::fs::write(&changed, b"other").unwrap();
                    File::options()
                        .write(true)
                        .open(&changed)
                        .unwrap()
                        .set_modified(modified + Duration::from_secs(1))
                        .unwrap();
                }
            })
            .await;
            assert!(result.unwrap_err().contains("Model changed"));
            assert_eq!(std::fs::read(sidecar(&path)).unwrap(), previous);
            assert!(read_info(&path).is_none());
            assert_eq!(std::fs::read(&path).unwrap(), b"other");
            assert_no_owned_temps(root.path());
        }
    }

    #[tokio::test]
    async fn portable_concurrent_refresh_rejects_late_publication() {
        for replace in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("a.pt");
            std::fs::write(&path, b"first").unwrap();
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let slow_path = path.clone();
            let slow = tokio::spawn(async move {
                fetch_fixture(&slow_path, move || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                })
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap();
            if replace {
                let replacement = root.path().join("replacement");
                std::fs::write(&replacement, b"other").unwrap();
                let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
                File::options()
                    .write(true)
                    .open(&replacement)
                    .unwrap()
                    .set_modified(modified)
                    .unwrap();
                std::fs::rename(&path, root.path().join("previous.pt")).unwrap();
                std::fs::rename(replacement, &path).unwrap();
            }
            let fresh = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
            let published = std::fs::read(sidecar(&path)).unwrap();
            release_tx.send(()).unwrap();
            let error = slow.await.unwrap().unwrap_err();
            assert!(error.contains(if replace {
                "Model changed"
            } else {
                "cache changed"
            }));
            assert_eq!(std::fs::read(sidecar(&path)).unwrap(), published);
            assert_eq!(read_info(&path).as_ref(), Some(&fresh));
            assert_eq!(fresh.sha256, sha256_file(&path).unwrap());
            assert_eq!(
                std::fs::read(&path).unwrap(),
                if replace { b"other" } else { b"first" }
            );
            if replace {
                assert_eq!(
                    std::fs::read(root.path().join("previous.pt")).unwrap(),
                    b"first"
                );
            }
            assert_no_owned_temps(root.path());
        }
    }

    #[test]
    fn portable_changed_before_publication_cleans_only_its_owned_temp() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        std::fs::write(&path, b"first").unwrap();
        let info = fixture_info(&path);
        write_info(&path, &info);
        let source = Source::open(&path).unwrap();
        let expected = source.dir.cache("a.pt.deas.json").unwrap().map(|(s, _)| s);
        let previous = std::fs::read(sidecar(&path)).unwrap();
        let unrelated = root.path().join(".deas-model-cache-foreign.tmp");
        std::fs::write(&unrelated, b"keep").unwrap();
        let result = publish_info(&source, &expected, &info, || {
            let replacement = root.path().join("replacement");
            std::fs::write(&replacement, b"other").unwrap();
            std::fs::rename(replacement, &path).unwrap();
        });
        assert!(result.unwrap_err().contains("Model changed"));
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), previous);
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"keep");
        assert_eq!(std::fs::read(&path).unwrap(), b"other");
        let temps: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".deas-model-cache-")
            })
            .collect();
        assert_eq!(temps, vec![unrelated]);
    }

    #[test]
    fn portable_temp_names_are_exclusive_and_cleanup_preserves_substitutions() {
        let root = tempfile::tempdir().unwrap();
        let dir = CacheDir::open(root.path()).unwrap();
        let first = OwnedTemp::create(&dir).unwrap();
        let second = OwnedTemp::create(&dir).unwrap();
        assert_ne!(first.name, second.name);
        assert!(dir.anchor.partial(&first.name).is_err());
        let first_path = root.path().join(&first.name);
        let owned_backup = root.path().join("owned-backup");
        std::fs::rename(&first_path, &owned_backup).unwrap();
        std::fs::write(&first_path, b"foreign replacement").unwrap();
        drop(first);
        drop(second);
        assert_eq!(std::fs::read(first_path).unwrap(), b"foreign replacement");
        assert_eq!(std::fs::read(owned_backup).unwrap(), b"");
    }

    #[test]
    fn portable_old_fixed_temp_hard_link_is_untouched() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        let victim = root.path().join("victim");
        std::fs::write(&path, b"model").unwrap();
        std::fs::write(&victim, b"keep these bytes").unwrap();
        let fixed = sidecar(&path).with_extension("json.tmp");
        std::fs::hard_link(&victim, &fixed).unwrap();
        let source = Source::open(&path).unwrap();
        publish_info(&source, &None, &fixture_info(&path), || {}).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep these bytes");
        assert_eq!(std::fs::read(fixed).unwrap(), b"keep these bytes");
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
        assert_no_owned_temps(root.path());
    }

    #[cfg(windows)]
    #[test]
    fn windows_alternate_stream_names_cannot_address_model_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        std::fs::write(&path, b"model").unwrap();
        let stream = root.path().join("a.pt:metadata.pt");
        assert!(Source::open(&stream).is_err());
        assert!(read_info(&stream).is_none());
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
        assert_no_owned_temps(root.path());
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn linked_final_cache_is_not_read_or_replaced() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.pt");
        let victim = root.path().join("victim");
        std::fs::write(&path, b"model").unwrap();
        let info = fixture_info(&path);
        let json = serde_json::to_vec(&info).unwrap();
        write_cache_bytes(&victim, &json);
        #[cfg(target_os = "linux")]
        std::os::unix::fs::symlink(&victim, sidecar(&path)).unwrap();
        #[cfg(windows)]
        if let Err(e) = std::os::windows::fs::symlink_file(&victim, sidecar(&path)) {
            if e.raw_os_error() == Some(1314) {
                eprintln!("Windows symlink subcase unavailable: privilege not held (1314); portable regular/hard-link fixtures remain enabled");
                return;
            }
            panic!("Cannot create scratch symlink: {e}");
        }
        assert!(read_info(&path).is_none());
        let source = Source::open(&path).unwrap();
        assert!(publish_info(&source, &None, &info, || {}).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), json);
        assert!(std::fs::symlink_metadata(sidecar(&path))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&path).unwrap(), b"model");
        assert_no_owned_temps(root.path());
    }

    /// Live CivitAI by-hash acceptance; run with `cargo test -- --ignored live_civitai_by_hash`.
    #[tokio::test]
    #[ignore]
    async fn live_civitai_by_hash_fetches_and_caches_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("probe.safetensors");
        // Bytes of a published public LoRA are not needed: the sidecar supplies the known hash.
        std::fs::write(&file, b"stub").unwrap();
        let mut known = fixture_info(&file);
        known.sha256 = std::env::var("DEAS_LIVE_SHA256").expect("DEAS_LIVE_SHA256");
        write_info(&file, &known);
        let c = Catalog::load().unwrap();
        let p = c.providers.iter().find(|p| p.kind == "civitai").unwrap();
        let model = fetch(p, file.clone(), None).await.unwrap();
        let civitai = model.info.unwrap().civitai.expect("hash known to CivitAI");
        assert!(civitai.model_id > 0 && !civitai.name.is_empty());
        assert!(read_info(&file).unwrap().civitai.is_some());
    }
}
