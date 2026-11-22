//! Installed-model library: scan the ComfyUI models folder and enrich files with CivitAI
//! metadata looked up by SHA-256. Metadata is cached beside the file as `<file>.deas.json`;
//! the model file itself is only ever read.
use super::*;
#[path = "downloads_models_scan.rs"]
pub mod background;
#[path = "downloads_model_files.rs"]
pub mod files;
#[path = "downloads_models_identify.rs"]
mod identify;
#[path = "downloads_models_index.rs"]
pub mod index;
pub use identify::CivitaiMatch;
#[path = "downloads_models_preview.rs"]
mod preview;
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const EXTENSIONS: [&str; 7] = ["safetensors", "sft", "ckpt", "pt", "pth", "gguf", "bin"];
// Bound visited entries as well as models: empty directories and sidecars must not bypass the walk guard.
// The separate UI payload cap remains below the runaway guard.
const MAX_WALK: usize = 100_000;
const MAX_LISTING: usize = 25_000;
const MAX_DEPTH: usize = 8;
const SIDECAR: &str = ".deas.json";
// Small advisory JSON only; read at most this bound plus one detection byte.
const MAX_CACHE_BYTES: u64 = 128 * 1024;
// SHA-256 of an installed model reads in 8 MiB slices rather than through `std::io::copy`, whose 8 KiB
// buffer measured ~106 MiB/s here: a pass over a 664 GiB library costs ~1 h 47 m at that rate and only
// ~3 m 09 s at the 2,293 MiB/s single-stream rate 8 MiB reads reach (3,599 MiB/s across two readers).
// The digest is identical either way — `model_hash_matches_sha256_across_the_chunk_boundary` pins that,
// and the ignored `hash_throughput_reference` re-measures the rate on a real model.
const MODEL_HASH_CHUNK: usize = 8 * 1024 * 1024;
// Only the short filesystem commit is serialized, on a blocking worker. Network
// requests/hash work remain concurrent. An optimistic snapshot rejects late replies.
static CACHE_PUBLICATION: Mutex<()> = Mutex::new(());
#[cfg(test)]
thread_local! { static HASH_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

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
type DirectoryLinks = Vec<(PathBuf, (u64, [u8; 16]))>;

struct CacheDir {
    anchor: fs::Anchor,
    path: PathBuf,
    alias: PathBuf,
    links: DirectoryLinks,
}

fn resolve_directory(path: &Path) -> Result<(PathBuf, DirectoryLinks), String> {
    let mut links = vec![];
    #[cfg(not(windows))]
    {
        for part in path.ancestors() {
            let meta = std::fs::symlink_metadata(part).map_err(|e| e.to_string())?;
            #[cfg(target_os = "linux")]
            if meta.file_type().is_symlink() {
                use std::os::unix::fs::MetadataExt;
                let mut id = [0; 16];
                id[..8].copy_from_slice(&meta.ino().to_le_bytes());
                links.push((part.into(), (meta.dev(), id)));
            }
        }
        let resolved = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !resolved.is_dir() {
            return Err("Model path is not a directory".into());
        }
        Ok((resolved, links))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        let mut pending = path.to_owned();
        // Windows can refuse traversal of user junctions (OS448), even for canonicalize.
        for _ in 0..40 {
            let mut current = PathBuf::new();
            let mut parts = pending.components();
            let mut redirected = false;
            while let Some(part) = parts.next() {
                current.push(part);
                if !matches!(part, std::path::Component::Normal(_)) {
                    continue;
                }
                let meta = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    let file = File::options()
                        .read(true)
                        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                        .open(&current)
                        .map_err(|e| e.to_string())?;
                    let (device, id, _) = file_identity(&file)?;
                    let target = std::fs::read_link(&current).map_err(|e| e.to_string())?;
                    links.push((current.clone(), (device, id)));
                    pending = if target.is_absolute() {
                        target
                    } else {
                        current.parent().ok_or("Missing link parent")?.join(target)
                    }
                    .join(parts.as_path());
                    redirected = true;
                    break;
                }
                if !meta.is_dir() {
                    return Err("Model directory component is not a directory".into());
                }
            }
            if !redirected {
                return Ok((
                    std::fs::canonicalize(current).map_err(|e| e.to_string())?,
                    links,
                ));
            }
        }
        Err("Too many model directory links".into())
    }
}

/// Backend configuration needs the same checked directory target, not a second resolver.
pub(crate) fn backend_directory_target(path: &Path) -> Result<Option<PathBuf>, String> {
    let dir = CacheDir::open(path)?;
    if dir.links.is_empty() {
        return Ok(None);
    }
    let target = dunce::canonicalize(&dir.path).map_err(|e| e.to_string())?;
    dir.verify()?;
    Ok(Some(target))
}

impl CacheDir {
    fn open(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("Model directory must be absolute".into());
        }
        // Resolve directory aliases here only; final model/cache entries remain no-follow.
        let (resolved, links) = resolve_directory(path)?;
        let dir = Self {
            anchor: fs::Anchor::open(&resolved)?,
            path: resolved,
            alias: path.into(),
            links,
        };
        dir.verify()?;
        Ok(dir)
    }

    fn verify(&self) -> Result<(), String> {
        self.verify_target()?;
        let (resolved, links) = resolve_directory(&self.alias)?;
        if links != self.links || resolved != self.path {
            return Err("Model directory alias changed during metadata lookup".into());
        }
        Ok(())
    }

    fn verify_target(&self) -> Result<(), String> {
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
        self.regular_target(name)
    }

    fn regular_target(&self, name: &str) -> Result<File, String> {
        self.verify_target()?;
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

    fn cache(&self, name: &str) -> Result<Option<(SourceFingerprint, CachedMetadata)>, String> {
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
        let info: CachedMetadata = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        info.validate()?;
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
            || fingerprint(&self.dir.regular_target(&self.name)?)? != fingerprint(&self.file)?
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
        #[cfg(test)]
        HASH_READS.with(|n| n.set(n.get() + 1));
        let mut hasher = Sha256::new();
        // Feed the hasher MODEL_HASH_CHUNK at a time, but never past `size + 1` bytes: that extra byte is
        // still how a file that grew mid-hash is caught, and a file that stopped short still fails the
        // size check below exactly as `io::copy` did.
        let limit = self.stamp.size.saturating_add(1);
        let mut buffer: Vec<u8> = Vec::new();
        let mut copied: u64 = 0;
        while copied < limit {
            let want = MODEL_HASH_CHUNK.min(usize::try_from(limit - copied).unwrap_or(usize::MAX));
            buffer.resize(want, 0);
            let mut read = 0usize;
            while read < want {
                let n = self
                    .file
                    .read(&mut buffer[read..want])
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                read += n;
            }
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            copied += read as u64;
        }
        after_read();
        self.verify()?;
        if copied != self.stamp.size {
            return Err("Model size changed while hashing".into());
        }
        Ok(format!("{:x}", hasher.finalize()))
    }
}

/// Header parsers share the model-cache boundary, including no-follow final-file opening.
pub(crate) fn open_model_file(path: &Path) -> Result<File, String> {
    let source = Source::open(path)?;
    source.verify()?;
    Ok(source.file)
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

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CivitaiPreviewKind {
    Image,
    Video,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CivitaiInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub model_id: u64,
    pub version_id: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
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
    pub preview_kind: Option<CivitaiPreviewKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<ModelExample>,
    /// How the file was tied to this version; absent = full-file SHA-256 (also legacy sidecars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_by: Option<CivitaiMatch>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelExample {
    pub image: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
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

// Declaration-only sidecars carry no hash/provider result. Public ModelInfo stays fetched-only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fetched_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    civitai: Option<CivitaiInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<SourceFingerprint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    family_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trigger_words: Option<Vec<String>>,
    /// CivitAI AutoV3 tensor hash, kept so retried misses do not reread the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    autov3: Option<String>,
}

impl CachedMetadata {
    fn from_info(info: &ModelInfo) -> Self {
        Self {
            sha256: Some(info.sha256.clone()),
            size: info.size,
            fetched_at: Some(info.fetched_at),
            civitai: info.civitai.clone(),
            source: info.source.clone(),
            family_override: None,
            trigger_words: None,
            autov3: None,
        }
    }

    fn declaration(stamp: &SourceFingerprint) -> Self {
        Self {
            sha256: None,
            size: stamp.size,
            fetched_at: None,
            civitai: None,
            source: Some(stamp.clone()),
            family_override: None,
            trigger_words: None,
            autov3: None,
        }
    }

    fn model_info(&self) -> Option<ModelInfo> {
        Some(ModelInfo {
            sha256: self.sha256.clone()?,
            size: self.size,
            fetched_at: self.fetched_at?,
            civitai: self.civitai.clone(),
            source: self.source.clone(),
        })
    }

    fn validate(&self) -> Result<(), String> {
        if let Some(info) = self.model_info() {
            validate_info(&info)?;
        } else if self.sha256.is_some()
            || self.fetched_at.is_some()
            || self.civitai.is_some()
            || self.source.is_none()
        {
            return Err("Invalid incomplete model metadata".into());
        }
        if self.source.as_ref().is_some_and(|s| {
            s.size != self.size
                || s.modified_nanos >= 1_000_000_000
                || !matches!(s.platform.as_str(), "linux" | "windows")
        }) || self.family_override.as_ref().is_some_and(|f| {
            f.is_empty()
                || f.len() > 64
                || !f.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.')
                })
        }) {
            return Err("Invalid model declaration/fingerprint".into());
        }
        if let Some(words) = &self.trigger_words {
            validate_trigger_words(words)?;
        }
        if self
            .autov3
            .as_deref()
            .is_some_and(|hash| self.sha256.is_none() || !identify::valid_autov3(hash))
        {
            return Err("Invalid cached AutoV3 hash".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<crate::model_check::ModelCheck>,
    pub category: String,
    /// Path relative to the category folder, the way ComfyUI names models.
    pub name: String,
    pub path: String,
    pub size: u64,
    pub info: Option<ModelInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_words: Option<Vec<String>>,
    /// Architecture family from `crate::model_families` (header or CivitAI base); absent = unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_family: Option<String>,
    /// Automatic ACE identity evidence; declarations do not upgrade it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_evidence: Option<crate::model_families::FamilyEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_error: Option<String>,
    /// Header-verified companion architecture ID; omitted for unknown/unsupported formats.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    /// `truncated` when a safetensors header covers payload bytes the file does not hold.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    /// ACE-Step all-in-one (embedded text encoders + VAE) found outside `checkpoints/`: ComfyUI only loads it there.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub misplaced_all_in_one: bool,
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

#[cfg(test)]
fn read_info(path: &Path) -> Option<ModelInfo> {
    let source = Source::open(path).ok()?;
    read_info_from_source(&source)
}

fn read_info_from_source(source: &Source) -> Option<ModelInfo> {
    let (_, info) = source
        .dir
        .cache(&format!("{}{SIDECAR}", source.name))
        .ok()??;
    source.verify().ok()?;
    (info.source.as_ref() == Some(&source.stamp))
        .then(|| info.model_info())
        .flatten()
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
        if c.description.as_ref().is_some_and(|text| {
            text.chars().count() > 8000
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
        }) {
            return Err("Invalid cached model description".into());
        }
        bounded_text(&c.name, 240)?;
        bounded_text(&c.version, 240)?;
        if c.creator
            .as_deref()
            .is_some_and(|name| !crate::token_page::valid_civitai_creator(name))
        {
            return Err("Invalid cached CivitAI creator".into());
        }
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
        if c.examples.len() > 6
            || c.examples.iter().any(|example| {
                example.image.len() > 1024
                    || preview::cdn_url(&example.image).is_err()
                    || !valid_example_text(&example.prompt, 3200)
                    || example
                        .negative_prompt
                        .as_ref()
                        .is_some_and(|text| !valid_example_text(text, 1600))
            })
        {
            return Err("Invalid cached CivitAI examples".into());
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

fn checked_metadata(category: &str, path: &Path) -> Result<Option<CachedMetadata>, String> {
    let source = Source::open(path)?;
    let cache = source.dir.cache(&format!("{}{SIDECAR}", source.name))?;
    source.verify()?;
    if let Some((_, cache)) = &cache {
        if let Some(family) = &cache.family_override {
            crate::model_families::validate_override(category, family)?;
            if cache.source.as_ref() != Some(&source.stamp) {
                return Err("Family declaration belongs to a replaced or modified model".into());
            }
        }
    }
    Ok(cache
        .filter(|(_, c)| c.source.as_ref() == Some(&source.stamp))
        .map(|(_, c)| c))
}

/// Resolve only the owned backend's registered namespace, in backend search order.
/// Reinspect cheap headers and source-bound metadata; never hash or contact providers.
#[cfg(test)]
pub(crate) fn validate_selected(roots: &[PathBuf], field: &str, name: &str) -> Result<(), String> {
    validate_selected_family(roots, field, name, None)
}

#[cfg(test)]
pub(crate) fn validate_selected_family(
    roots: &[PathBuf],
    field: &str,
    name: &str,
    family: Option<&str>,
) -> Result<(), String> {
    let slot = match field {
        "vaes" => Some("vaes"),
        "audioVaes" => Some("audioVaes"),
        "textProjections" => Some("textProjections"),
        "textEncoders" | "dualTextEncoders" | "ggufTextEncoders" | "ggufDualTextEncoders" => {
            Some("textEncoders")
        }
        _ => None,
    };
    validate_selected_context(roots, field, name, family, slot, false)
}

pub(crate) fn validate_selected_context(
    roots: &[PathBuf],
    field: &str,
    name: &str,
    family: Option<&str>,
    slot: Option<&str>,
    component_override: bool,
) -> Result<(), String> {
    let categories = crate::model_check::categories(field);
    if categories.is_empty() {
        return Ok(());
    }
    // Backend names can contain either separator, never absolute paths/traversal/ADS.
    let parts: Vec<_> = name.split(['/', '\\']).collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains(':'))
    {
        return Err("Invalid backend model name".into());
    }
    for root in roots {
        for (category, base) in crate::settings::model_locations(root) {
            if !categories.contains(&category) {
                continue;
            }
            let path = parts.iter().fold(base, |p, part| p.join(part));
            let parent = path.parent().ok_or("Missing model parent")?;
            if std::fs::symlink_metadata(parent)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            let (resolved, _) =
                resolve_directory(parent).map_err(|e| format!("MODEL_METADATA_INVALID: {e}"))?;
            match std::fs::symlink_metadata(resolved.join(path.file_name().unwrap())) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("MODEL_METADATA_INVALID: {e}")),
                Ok(_) => {}
            }
            let selected_source = Source::open(&path)?;
            let model = describe(category, path.parent().unwrap(), &path)
                .map_err(|e| format!("MODEL_METADATA_INVALID: {name}: {e}"))?;
            selected_source.verify()?;
            if model.metadata_error.is_some() {
                return Err(format!("MODEL_METADATA_INVALID: {name}"));
            }
            if model.integrity.is_some() {
                return Err(format!("MODEL_INTEGRITY_INVALID: {name}"));
            }
            if model
                .check
                .as_ref()
                .is_some_and(|c| c.blocks_execution(field))
            {
                return Err(format!("MODEL_EVIDENCE_CONFLICT: {name}"));
            }
            // Explicitly selected LoRAs may have incorrect provider, header-label or
            // declaration families. Keep source/integrity/sidecar checks above and
            // let the backend loader apply the exact selected file and strength.
            if field == "loras" {
                selected_source.verify()?;
                return Ok(());
            }
            if let Some(expected) = family {
                if let Some(slot) = slot {
                    if !component_override
                        && model.component.as_deref().is_some_and(|id| {
                            crate::model_families::component_matches(expected, slot, id)
                                == Some(false)
                        })
                    {
                        return Err(format!("MODEL_COMPONENT_MISMATCH: {name}"));
                    }
                    selected_source.verify()?;
                    return Ok(());
                }
                if !["checkpoints", "diffusionModels", "ggufDiffusionModels"].contains(&field) {
                    selected_source.verify()?;
                    return Ok(());
                }
                let source = &selected_source;
                let detected = model.family_override.clone().or_else(|| {
                    crate::model_families::detect_with_evidence(
                        category,
                        &source.dir.path.join(&source.name),
                        None,
                    )
                    .0
                });
                let checkpoint_parts = !expected.starts_with("ace-step")
                    || field != "checkpoints"
                    || crate::model_families::ace_checkpoint_has_companions(
                        &source.dir.path.join(&source.name),
                    );
                source.verify()?;
                if detected.as_deref().is_some_and(|id| id != expected)
                    || (expected.starts_with("ace-step") && detected.is_none())
                {
                    return Err(
                        "MODEL_FAMILY_MISMATCH: intent does not match source-bound model identity"
                            .into(),
                    );
                }
                if !checkpoint_parts {
                    return Err("MODEL_COMPONENTS_MISSING: ACE checkpoint needs embedded text encoders and VAE; put split weights in diffusion_models and select their components".into());
                }
            }
            selected_source.verify()?;
            return Ok(());
        }
    }
    // A backend may register other paths; absence is not local declaration authority.
    Ok(())
}

fn describe(category: &str, base: &Path, path: &Path) -> Result<LocalModel, String> {
    let shown = path
        .to_str()
        .ok_or("Model path is not valid UTF-8")?
        .to_owned();
    let source = Source::open(path)?;
    let header_path = source.dir.path.join(&source.name);
    let meta = source
        .file
        .metadata()
        .map_err(|e| format!("{shown}: {e}"))?;
    let metadata = checked_metadata(category, path);
    let metadata_error = metadata
        .as_ref()
        .err()
        .map(|_| "Invalid or stale model metadata; repair the sidecar before execution".to_owned());
    let cache = metadata.ok().flatten();
    let info = cache.as_ref().and_then(CachedMetadata::model_info);
    let trigger_words = cache.as_ref().and_then(|c| c.trigger_words.clone());
    let family_override = cache.as_ref().and_then(|c| c.family_override.clone());
    let (detected_family, family_evidence) = crate::model_families::detect_with_evidence(
        category,
        &header_path,
        info.as_ref()
            .and_then(|i| i.civitai.as_ref()?.base.as_deref()),
    );
    let family = if metadata_error.is_some() {
        None
    } else {
        family_override.clone().or_else(|| detected_family.clone())
    };
    let family_evidence = family_evidence.or_else(|| {
        family
            .as_deref()
            .filter(|id| id.starts_with("ace-step"))
            .map(|_| crate::model_families::FamilyEvidence::Unresolved)
    });
    let component =
        crate::model_families::detect_component(category, &header_path).map(str::to_owned);
    let structural_integrity = crate::model_families::intact(&header_path);
    let integrity = structural_integrity.and_then(|ok| (!ok).then(|| "truncated".to_owned()));
    let misplaced_all_in_one = category != "checkpoints"
        && family.as_deref().is_some_and(|f| f.starts_with("ace-step"))
        && crate::model_families::ace_checkpoint_has_companions(&header_path);
    source.verify()?;
    if let Some(cache) = &cache {
        let current = Source::open(path)?;
        current.verify()?;
        if cache.source.as_ref() != Some(&current.stamp) || cache.size != meta.len() {
            return Err("Model changed during scan".into());
        }
    }
    let (header_family, header_evidence) =
        crate::model_families::detect_with_evidence(category, &header_path, None);
    let header_family = header_family
        .filter(|_| header_evidence != Some(crate::model_families::FamilyEvidence::Unresolved));
    // Reuse the base classifier without reinterpreting a provider label as a header.
    let provider_family = info
        .as_ref()
        .and_then(|i| i.civitai.as_ref()?.base.as_deref())
        .and_then(|base| crate::model_families::from_base(category, base));
    source.verify()?;
    let mut model = LocalModel {
        local_preview: None,
        check: None,
        category: category.into(),
        name: path
            .strip_prefix(base)
            .map_err(|_| "Model outside its category folder")?
            .to_string_lossy()
            .into_owned(),
        size: meta.len(),
        info,
        trigger_words,
        component,
        family,
        detected_family,
        family_evidence,
        family_override,
        metadata_error,
        integrity,
        misplaced_all_in_one,
        path: shown,
    };
    model.check = Some(crate::model_check::describe(
        &model,
        header_family.as_deref(),
        provider_family.as_deref(),
        structural_integrity,
    ));
    Ok(model)
}

fn walk(
    category: &'static str,
    base: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<(&'static str, PathBuf, PathBuf)>,
    remaining: &mut usize,
) {
    if *remaining == 0 || out.len() >= MAX_WALK {
        return;
    }
    let Ok((resolved, _)) = resolve_directory(dir) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&resolved) else {
        return;
    };
    let mut entries: Vec<_> = entries
        .take(*remaining)
        .flatten()
        .filter_map(|e| Some((dir.join(e.file_name()), e.file_type().ok()?)))
        .collect();
    *remaining -= entries.len();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (path, kind) in entries {
        if out.len() >= MAX_WALK {
            return;
        }
        let hidden = path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with('.'));
        if hidden {
            continue;
        }
        if (kind.is_dir() || kind.is_symlink()) && resolve_directory(&path).is_ok() {
            if depth < MAX_DEPTH {
                walk(category, base, &path, depth + 1, out, remaining);
            }
        } else if is_model(&path) {
            out.push((category, base.to_path_buf(), path));
        }
    }
}

/// All model files under the standard ComfyUI category folders of `root`, sorted per folder.
pub fn scan(root: &Path) -> Result<Vec<LocalModel>, String> {
    if !root.is_absolute() {
        return Err("Models folder must be absolute".into());
    }
    if resolve_directory(root).is_err() {
        return Err(format!("{}: not an existing directory", root.display()));
    }
    let mut jobs = vec![];
    let mut remaining = MAX_WALK;
    for (category, base) in crate::settings::model_locations(root) {
        walk(category, &base, &base, 0, &mut jobs, &mut remaining);
    }
    if remaining == 0 || jobs.len() >= MAX_WALK {
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!(
                "WARN: model walk reached its {MAX_WALK} entry/file boundary under {}",
                root.display()
            ),
        );
    }
    // describe() is syscall/header-bound; 4 threads, more would thrash spinning disks.
    // shortcut: fixed 4, raise only with a measured reason (NVMe-only fleets).
    let threads = jobs.len().div_ceil(4).clamp(1, 4);
    let chunk = jobs.len().div_ceil(threads).max(1);
    let mut out = vec![];
    std::thread::scope(|s| {
        let handles: Vec<_> = jobs
            .chunks(chunk)
            .map(|part| {
                s.spawn(move || {
                    part.iter()
                        .filter_map(|(c, b, p)| describe(c, b, p).ok())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            out.extend(h.join().unwrap());
        }
    });
    deduplicate(&mut out);
    Ok(out)
}

/// All model files under the standard ComfyUI category folders of each root, sorted per folder.
/// Extra roots (additional drives) are scanned with the same rules and appended.
pub fn scan_roots(roots: &[PathBuf]) -> Result<Vec<LocalModel>, String> {
    let mut models = vec![];
    for root in roots {
        models.extend(scan(root)?);
    }
    deduplicate(&mut models);
    Ok(models)
}

fn deduplicate(models: &mut Vec<LocalModel>) {
    let mut seen = std::collections::HashSet::new();
    models.retain(|model| match Source::open(Path::new(&model.path)) {
        Ok(source) => seen.insert((
            model.category.clone(),
            model.name.clone(),
            source.dir.path.join(&source.name),
        )),
        Err(_) => true,
    });
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
fn civitai_creator(value: &Value) -> Option<String> {
    let name = value.get("creator")?.get("username")?.as_str()?;
    crate::token_page::valid_civitai_creator(name).then(|| name.to_owned())
}

fn example_text(value: Option<&Value>, limit: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    let mut clean = String::new();
    for c in text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
    {
        if clean.len() + c.len_utf8() > limit {
            break;
        }
        clean.push(c);
    }
    let clean = clean.trim();
    (!clean.is_empty()).then(|| clean.to_owned())
}

fn valid_example_text(text: &str, limit: usize) -> bool {
    !text.is_empty()
        && text.len() <= limit
        && text.trim() == text
        && !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
}

fn model_examples(version: &Value) -> Vec<ModelExample> {
    version["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|image| {
            let url = providers::civitai_still_preview(image)?;
            if url.len() > 1024 || preview::cdn_url(&url).is_err() {
                return None;
            }
            let meta = &image["meta"];
            Some(ModelExample {
                image: url,
                prompt: example_text(meta.get("prompt"), 3200)?,
                negative_prompt: example_text(meta.get("negativePrompt"), 1600),
            })
        })
        .take(6)
        .collect()
}

fn civitai_cover(version: &Value) -> Option<(String, CivitaiPreviewKind)> {
    version.get("images")?.as_array()?.iter().find_map(|media| {
        let raw = media.get("url")?.as_str()?;
        if raw.len() > 2048 || raw.chars().any(char::is_control) {
            return None;
        }
        let url = preview::cdn_url(raw).ok()?;
        let path = url.path().to_ascii_lowercase();
        let kind = media.get("type").and_then(Value::as_str);
        if kind == Some("audio") || path.ends_with(".webm") {
            return None;
        }
        if kind == Some("video") || path.ends_with(".mp4") {
            // Use CivitAI's video URL without applying the still-thumbnail resize.
            return Some((raw.into(), CivitaiPreviewKind::Video));
        }
        providers::civitai_still_preview(media).map(|url| (url, CivitaiPreviewKind::Image))
    })
}

pub(super) fn civitai_info(v: &Value) -> Result<CivitaiInfo, String> {
    let model = v.get("model").ok_or("Missing CivitAI model")?;
    let name = providers::text(model, "name")?;
    let version = providers::text(v, "name")?;
    bounded_text(name, 240)?;
    bounded_text(version, 240)?;
    let model_type = model.get("type").and_then(Value::as_str).unwrap_or("");
    let (preview, preview_kind) = match civitai_cover(v) {
        Some((url, kind)) => (Some(url), kind),
        None => (None, CivitaiPreviewKind::Unavailable),
    };
    Ok(CivitaiInfo {
        description: v.get("description").and_then(Value::as_str).map(|text| {
            text.chars()
                .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                .take(8000)
                .collect()
        }),
        model_id: v
            .get("modelId")
            .and_then(Value::as_u64)
            .ok_or("Missing CivitAI model ID")?,
        version_id: v
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("Missing CivitAI version ID")?,
        name: name.into(),
        creator: civitai_creator(v).or_else(|| civitai_creator(model)),
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
        preview,
        preview_kind: Some(preview_kind),
        settings: v
            .get("images")
            .and_then(Value::as_array)
            .and_then(|images| images.iter().find_map(|i| settings(i.get("meta")?))),
        examples: model_examples(v),
        matched_by: None,
    })
}

#[cfg(test)]
fn publish_info(
    source: &Source,
    expected: &Option<SourceFingerprint>,
    info: &ModelInfo,
    before_publish: impl FnOnce(),
) -> Result<(), String> {
    publish_cache(
        source,
        expected,
        &CachedMetadata::from_info(info),
        before_publish,
    )
}

fn publish_cache(
    source: &Source,
    expected: &Option<SourceFingerprint>,
    info: &CachedMetadata,
    before_publish: impl FnOnce(),
) -> Result<(), String> {
    info.validate()?;
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

/// Source-bound state taken on a blocking worker before any provider request.
struct Prepared {
    source: Source,
    expected: Option<SourceFingerprint>,
    sha256: String,
    family_override: Option<String>,
    /// The current cache for this exact source fingerprint, if any.
    current: Option<CachedMetadata>,
    foreign: identify::ForeignSidecars,
}

fn prepare(model_path: &Path) -> Result<Prepared, String> {
    let mut source = Source::open(model_path)?;
    let cache = source.dir.cache(&format!("{}{SIDECAR}", source.name))?;
    let family_override = cache.as_ref().and_then(|(_, c)| c.family_override.clone());
    if let Some(family) = &family_override {
        crate::model_families::validate_override(model_category(model_path)?.0, family)?;
        if cache.as_ref().and_then(|(_, c)| c.source.as_ref()) != Some(&source.stamp) {
            return Err("Stale family declaration; sidecar repair required".into());
        }
    }
    let expected = cache.as_ref().map(|(stamp, _)| stamp.clone());
    let current = cache
        .map(|(_, c)| c)
        .filter(|c| c.source.as_ref() == Some(&source.stamp));
    let sha256 = match current.as_ref().and_then(|c| c.sha256.clone()) {
        Some(sha256) => sha256,
        None => source.hash()?,
    };
    source.verify()?;
    let foreign = identify::foreign_sidecars(&source, &sha256);
    Ok(Prepared {
        source,
        expected,
        sha256,
        family_override,
        current,
        foreign,
    })
}

async fn provider_json(
    client: &reqwest::Client,
    p: &Provider,
    header: &Option<HeaderValue>,
    parts: &[&str],
) -> Result<Option<Value>, String> {
    let u = providers::endpoint(p, parts)?;
    tokio::time::timeout(
        Duration::from_secs(30),
        providers::json_optional(client, p, u, header),
    )
    .await
    .map_err(|_| "CivitAI lookup exceeded 30 seconds")?
}

async fn provider_version(
    client: &reqwest::Client,
    p: &Provider,
    header: &Option<HeaderValue>,
    version: u64,
) -> Result<Option<Value>, String> {
    let id = version.to_string();
    Ok(
        provider_json(client, p, header, &["api", "v1", "model-versions", &id])
            .await?
            .filter(|v| v.get("id").and_then(Value::as_u64) == Some(version))
            .filter(|v| !identify::candidates(v).is_empty()),
    )
}

async fn provider_model_versions(
    client: &reqwest::Client,
    p: &Provider,
    header: &Option<HeaderValue>,
    model: u64,
) -> Result<Vec<Value>, String> {
    let id = model.to_string();
    Ok(
        provider_json(client, p, header, &["api", "v1", "models", &id])
            .await?
            .map(|m| identify::candidates(&m))
            .unwrap_or_default(),
    )
}

/// Computes (once, then cached) the AutoV3 tensor hash on a blocking worker.
async fn ensure_autov3(
    prepared: Prepared,
    autov3: Option<String>,
) -> Result<(Prepared, Option<String>), String> {
    if autov3.is_some() {
        return Ok((prepared, autov3));
    }
    tokio::task::spawn_blocking(move || {
        let mut prepared = prepared;
        let hash = identify::autov3(&mut prepared.source)?;
        Ok::<_, String>((prepared, hash))
    })
    .await
    .map_err(|_| "Hashing task failed")?
}

/// Full-file SHA-256 first; on a miss the hash-bound fallbacks in order: local CivitAI
/// sidecars, AutoV3, then a Forge `.json` model ID resolved against the file's hashes.
async fn identify_version(
    client: &reqwest::Client,
    p: &Provider,
    header: &Option<HeaderValue>,
    prepared: Prepared,
) -> Result<(Prepared, Option<String>, Option<(Value, CivitaiMatch)>), String> {
    let sha256 = prepared.sha256.clone();
    let autov3 = prepared.current.as_ref().and_then(|c| c.autov3.clone());
    if let Some(found) = provider_json(
        client,
        p,
        header,
        &["api", "v1", "model-versions", "by-hash", &sha256],
    )
    .await?
    {
        return Ok((prepared, autov3, Some((found, CivitaiMatch::Sha256))));
    }
    // A local sidecar bound by the full hash; refresh its version when CivitAI still has it.
    let local = |prepared: &Prepared, autov3: Option<&str>| {
        identify::first_match(&prepared.foreign.versions, &sha256, autov3)
    };
    let refresh = |found: Value| async move {
        let fresh = match found.get("id").and_then(Value::as_u64) {
            Some(id) => provider_version(client, p, header, id).await.ok().flatten(),
            None => None,
        };
        fresh.unwrap_or(found)
    };
    if let Some(found) = local(&prepared, None) {
        let found = refresh(found).await;
        return Ok((prepared, autov3, Some((found, CivitaiMatch::Sidecar))));
    }
    let (prepared, autov3) = ensure_autov3(prepared, autov3).await?;
    if let Some(hash) = autov3.as_deref() {
        if let Some(found) = provider_json(
            client,
            p,
            header,
            &["api", "v1", "model-versions", "by-hash", hash],
        )
        .await?
        .filter(|v| identify::version_matches(v, &sha256, Some(hash)))
        {
            return Ok((prepared, autov3, Some((found, CivitaiMatch::Autov3))));
        }
        if let Some(found) = local(&prepared, Some(hash)) {
            let found = refresh(found).await;
            return Ok((prepared, autov3, Some((found, CivitaiMatch::Sidecar))));
        }
    }
    let ids = prepared.foreign.forge.as_ref().map(identify::forge_ids);
    let versions = match ids {
        Some((Some(model), _)) => provider_model_versions(client, p, header, model).await?,
        Some((None, Some(version))) => provider_version(client, p, header, version)
            .await?
            .into_iter()
            .collect(),
        _ => vec![],
    };
    let found = identify::first_match(&versions, &sha256, autov3.as_deref())
        .map(|found| (found, CivitaiMatch::Sidecar));
    Ok((prepared, autov3, found))
}

/// Hash an owned verified handle off the executor, look up CivitAI, then revalidate
/// the source and optimistic cache snapshot before publication. 404 means unknown; a
/// miss keeps an explicit user link.
pub async fn fetch(
    p: &Provider,
    path: PathBuf,
    header: Option<HeaderValue>,
    save_preview: bool,
) -> Result<LocalModel, String> {
    let prepared = prepare_checked(p, &path).await?;
    let client = client_for(false, None)?;
    let (prepared, autov3, found) = identify_version(&client, p, &header, prepared).await?;
    let civitai = match found {
        Some((version, matched)) => {
            let mut info = civitai_info(&version)?;
            info.matched_by = (matched != CivitaiMatch::Sha256).then_some(matched);
            Some(info)
        }
        None => prepared
            .current
            .as_ref()
            .and_then(|c| c.civitai.clone())
            .filter(|c| c.matched_by == Some(CivitaiMatch::Manual)),
    };
    complete(
        &client,
        p,
        &header,
        path,
        prepared,
        autov3,
        civitai,
        save_preview,
    )
    .await
}

/// Ties the file to a pasted CivitAI model/version link. Only IDs are taken from the link;
/// a model link picks the version listing this file's hash, else the newest version.
pub async fn link(
    p: &Provider,
    path: PathBuf,
    header: Option<HeaderValue>,
    link: &str,
    save_preview: bool,
) -> Result<LocalModel, String> {
    let (model, version) = identify::parse_link(link)?;
    let prepared = prepare_checked(p, &path).await?;
    let client = client_for(false, None)?;
    let autov3 = prepared.current.as_ref().and_then(|c| c.autov3.clone());
    let found = match version {
        Some(version) => provider_version(&client, p, &header, version)
            .await?
            .filter(|v| model.is_none() || v.get("modelId").and_then(Value::as_u64) == model)
            .ok_or("CivitAI has no such version for this link")?,
        None => {
            let versions =
                provider_model_versions(&client, p, &header, model.unwrap_or_default()).await?;
            identify::first_match(&versions, &prepared.sha256, autov3.as_deref())
                .or_else(|| versions.first().cloned())
                .ok_or("CivitAI has no such model for this link")?
        }
    };
    let mut info = civitai_info(&found)?;
    info.matched_by = Some(CivitaiMatch::Manual);
    complete(
        &client,
        p,
        &header,
        path,
        prepared,
        autov3,
        Some(info),
        save_preview,
    )
    .await
}

async fn prepare_checked(p: &Provider, path: &Path) -> Result<Prepared, String> {
    if p.kind != "civitai" {
        return Err("Metadata lookup needs the CivitAI provider".into());
    }
    if !path.is_absolute() || !is_model(path) {
        return Err("Not an absolute path to a model file".into());
    }
    let model_path = path.to_owned();
    tokio::task::spawn_blocking(move || prepare(&model_path))
        .await
        .map_err(|_| "Hashing task failed")?
}

#[allow(clippy::too_many_arguments)] // One publication path for lookups and links.
async fn complete(
    client: &reqwest::Client,
    p: &Provider,
    header: &Option<HeaderValue>,
    path: PathBuf,
    prepared: Prepared,
    autov3: Option<String>,
    mut civitai: Option<CivitaiInfo>,
    save_preview: bool,
) -> Result<LocalModel, String> {
    let cached_creator = prepared.current.as_ref().and_then(|cache| {
        let info = cache.civitai.as_ref()?;
        Some((info.model_id, info.creator.clone()?))
    });
    if let Some(info) = civitai.as_mut().filter(|info| info.creator.is_none()) {
        let id = info.model_id.to_string();
        let url = providers::endpoint(p, &["api", "v1", "models", &id])?;
        if let Ok(Ok(Some(model))) = tokio::time::timeout(
            Duration::from_secs(10),
            providers::json_optional(client, p, url, header),
        )
        .await
        {
            info.creator = civitai_creator(&model);
        }
        if info.creator.is_none() {
            info.creator = cached_creator
                .filter(|(model_id, _)| *model_id == info.model_id)
                .map(|(_, username)| username);
        }
    }
    let cover = if let Some(url) = civitai
        .as_ref()
        .and_then(|info| info.preview.as_deref())
        .filter(|_| save_preview)
    {
        let check_path = path.clone();
        let has_cover = tokio::task::spawn_blocking(move || index::has_local_preview(&check_path))
            .await
            .map_err(|_| "Preview lookup task failed")?;
        if has_cover {
            None
        } else {
            match preview::download(url).await {
                Ok(cover) => Some(cover),
                Err(_) => {
                    crate::logs::native_logs_library_error("preview-fetch".into());
                    None
                }
            }
        }
    } else {
        None
    };
    let Prepared {
        source,
        expected,
        sha256,
        family_override,
        current,
        foreign,
    } = prepared;
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
    // Forge activation text fills trigger words only when the user has none in DEAS yet.
    let trigger_words = current
        .as_ref()
        .and_then(|c| c.trigger_words.clone())
        .or_else(|| {
            foreign
                .forge
                .as_ref()
                .and_then(identify::forge_trigger_words)
        });
    tokio::task::spawn_blocking(move || {
        // Includes the first check after the network await, before any cache write.
        source.verify()?;
        let mut cache = CachedMetadata::from_info(&info);
        cache.family_override = family_override;
        cache.trigger_words = trigger_words;
        cache.autov3 = autov3;
        publish_cache(&source, &expected, &cache, || {})?;
        if let Some(cover) = cover {
            if !index::has_local_preview(&path) && preview::publish(&source, cover).is_err() {
                crate::logs::native_logs_library_error("preview-fetch".into());
            }
        }
        let (category, base) =
            model_category(&path).unwrap_or(("", path.parent().unwrap_or(&path)));
        let mut model = describe(category, base, &path)?;
        if save_preview {
            model.local_preview = index::find_local_preview(&path);
        }
        source.verify()?;
        if model.info.as_ref() != Some(&info) {
            return Err("Metadata cache changed before returning".into());
        }
        Ok(model)
    })
    .await
    .map_err(|_| "Cache publication task failed")?
}

fn model_category(path: &Path) -> Result<(&str, &Path), String> {
    let base = path
        .ancestors()
        .skip(1)
        .find(|a| {
            a.file_name()
                .and_then(|n| n.to_str())
                .and_then(crate::settings::model_folder_category)
                .is_some()
        })
        .ok_or("Model is not under a supported category folder")?;
    Ok((
        crate::settings::model_folder_category(base.file_name().and_then(|n| n.to_str()).unwrap())
            .unwrap(),
        base,
    ))
}

fn write_family(path: &Path, family: Option<&str>) -> Result<LocalModel, String> {
    if !path.is_absolute() || !is_model(path) {
        return Err("Not an absolute path to a model file".into());
    }
    let (category, base) = model_category(path)?;
    if !["checkpoints", "diffusion_models", "unet", "loras"].contains(&category) {
        return Err("Family declarations require a model or LoRA".into());
    }
    if let Some(family) = family {
        crate::model_families::validate_override(category, family)?;
    }
    let source = Source::open(path)?;
    let old = source.dir.cache(&format!("{}{SIDECAR}", source.name))?;
    if family.is_some() {
        if let Some((_, cache)) = &old {
            if let Some(id) = &cache.family_override {
                crate::model_families::validate_override(category, id)?;
            }
        }
    }
    let mut cache = old
        .as_ref()
        .filter(|(_, c)| c.source.as_ref() == Some(&source.stamp))
        .map(|(_, c)| c.clone())
        .unwrap_or_else(|| CachedMetadata::declaration(&source.stamp));
    cache.family_override = family.map(str::to_owned);
    publish_cache(&source, &old.map(|(stamp, _)| stamp), &cache, || {})?;
    let model = describe(category, base, path)?;
    source.verify()?;
    if model.family_override.as_deref() != family || model.metadata_error.is_some() {
        return Err("Metadata changed before returning".into());
    }
    Ok(model)
}

pub(crate) async fn family_operation(
    path: String,
    family: Option<String>,
) -> Result<LocalModel, String> {
    let operation = if family.is_some() { "write" } else { "reset" };
    let result =
        tokio::task::spawn_blocking(move || write_family(Path::new(&path), family.as_deref()))
            .await
            .map_err(|_| "Model family task failed".to_owned())
            .and_then(|r| r);
    if result.is_err() {
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!("ERROR: models operation=family-{operation} outcome=failed"),
        );
    }
    result
}

async fn update_index(app: &tauri::AppHandle, model: &LocalModel) {
    let Ok(directory) = index::directory(app) else {
        return;
    };
    let path = PathBuf::from(&model.path);
    let result = tokio::task::spawn_blocking(move || index::update(&directory, &path)).await;
    if !matches!(result, Ok(Ok(()))) {
        crate::logs::push(crate::logs::Source::Deas, "WARN: Library index operation=metadata-update saved metadata is available; browsing cache update failed");
    }
}

fn validate_trigger_words(words: &[String]) -> Result<(), String> {
    if words.len() > 50 {
        return Err("Use at most 50 trigger words".into());
    }
    for word in words {
        bounded_text(word, 200)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoraEdit {
    TriggerWords { words: Vec<String> },
    Preview { png: Vec<u8> },
}

fn edit_lora(
    directory: &Path,
    root: &Path,
    path: &Path,
    edit: LoraEdit,
) -> Result<LocalModel, String> {
    let (category, base) = model_category(path)?;
    if category != "loras" || !path.starts_with(root) || !is_model(path) {
        return Err("Select a LoRA in the Library".into());
    }
    let members = index::file_members(directory, root)?;
    let (indexed_category, stamp) = members
        .get(path)
        .ok_or("LoRA is not in the Library index")?;
    let source = Source::open(path)?;
    if indexed_category != category || &source.stamp != stamp {
        return Err("LoRA moved or changed. Refresh models before trying again".into());
    }
    match edit {
        LoraEdit::TriggerWords { words } => {
            validate_trigger_words(&words)?;
            let old = source.dir.cache(&format!("{}{SIDECAR}", source.name))?;
            let expected = old.as_ref().map(|(stamp, _)| stamp.clone());
            let mut cache = match old {
                Some((_, cache)) if cache.source.as_ref() == Some(&source.stamp) => cache,
                Some(_) => return Err("Model metadata changed. Refresh it before editing".into()),
                None => CachedMetadata::declaration(&source.stamp),
            };
            cache.trigger_words = Some(words);
            publish_cache(&source, &expected, &cache, || {})?;
        }
        LoraEdit::Preview { png } => preview::replace_custom(&source, &png)?,
    }
    source.verify()?;
    let mut model = describe(category, base, path)?;
    model.local_preview = index::find_local_preview(path);
    Ok(model)
}

#[tauri::command]
pub async fn native_model_edit_lora(
    app: tauri::AppHandle,
    root: String,
    path: String,
    edit: LoraEdit,
) -> Result<LocalModel, String> {
    let directory = index::directory(&app)?;
    let result = tokio::task::spawn_blocking(move || {
        edit_lora(&directory, Path::new(&root), Path::new(&path), edit)
    })
    .await;
    let model = match result {
        Ok(Ok(model)) => model,
        failure => {
            crate::logs::native_logs_library_error("lora-edit".into());
            return failure.map_err(|_| "LoRA edit task failed")?;
        }
    };
    update_index(&app, &model).await;
    Ok(model)
}

#[tauri::command]
pub async fn native_model_family_write(
    app: tauri::AppHandle,
    path: String,
    family: Option<String>,
) -> Result<LocalModel, String> {
    let model = family_operation(path, family).await?;
    update_index(&app, &model).await;
    Ok(model)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyBatchReport {
    updated: Vec<LocalModel>,
    failed: Vec<String>,
}

fn write_family_batch(paths: &[String], family: Option<&str>) -> Result<FamilyBatchReport, String> {
    if paths.is_empty()
        || paths.len() > 500
        || paths.iter().collect::<std::collections::HashSet<_>>().len() != paths.len()
    {
        return Err("Select between 1 and 500 unique model files".into());
    }
    // Validate the complete request before writes; per-file publication retains source checks.
    for path in paths {
        let path = Path::new(path);
        if !path.is_absolute()
            || !is_model(path)
            || path.to_string_lossy().chars().any(char::is_control)
            || path.components().any(|p| {
                matches!(
                    p,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err("Invalid model path".into());
        }
        let (category, _) = model_category(path)?;
        if !["checkpoints", "diffusion_models", "unet", "loras"].contains(&category) {
            return Err("Family declarations require models or LoRAs".into());
        }
        if let Some(family) = family {
            crate::model_families::validate_override(category, family)?;
        }
    }
    let mut report = FamilyBatchReport {
        updated: vec![],
        failed: vec![],
    };
    for path in paths {
        match write_family(Path::new(path), family) {
            Ok(model) => report.updated.push(model),
            Err(_) => report.failed.push(path.clone()),
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn native_model_family_write_many(
    app: tauri::AppHandle,
    paths: Vec<String>,
    family: Option<String>,
) -> Result<FamilyBatchReport, String> {
    let directory = index::directory(&app)?;
    let result = tokio::task::spawn_blocking(move || {
        let report = write_family_batch(&paths, family.as_deref())?;
        if !report.updated.is_empty() {
            let paths: Vec<_> = report.updated.iter().map(|m| PathBuf::from(&m.path)).collect();
            if index::update_many(&directory, &paths).is_err() {
                crate::logs::push(crate::logs::Source::Deas, "WARN: Library index operation=family-batch metadata saved; browsing cache update failed");
            }
        }
        Ok::<_, String>(report)
    }).await.map_err(|_| "Model family batch task failed".to_string()).and_then(|r| r);
    match &result {
        Ok(report) => {
            crate::logs::push(
                crate::logs::Source::Deas,
                &format!(
                    "INFO: models operation=family-bulk updated={} failed={}",
                    report.updated.len(),
                    report.failed.len()
                ),
            );
            if !report.failed.is_empty() {
                crate::logs::native_logs_library_error("family".into());
            }
        }
        Err(_) => crate::logs::native_logs_library_error("family".into()),
    }
    result
}

/// The webview payload carries its own cap; a listing that big already signals a misconfigured
/// root, and silence about dropped files is worse than the cap.
#[cfg(test)]
fn cap_for_ui(models: Vec<LocalModel>) -> Vec<LocalModel> {
    let total = models.len();
    if total > MAX_LISTING {
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!("WARN: model listing truncated to {MAX_LISTING} of {total} files"),
        );
        return models.into_iter().take(MAX_LISTING).collect();
    }
    models
}

// async + blocking pool: a sync command runs on the main thread and would freeze the UI during the header reads.
#[tauri::command]
pub async fn native_models_scan(
    app: tauri::AppHandle,
    root: String,
    extra_roots: Option<Vec<String>>,
    refresh: Option<bool>,
    scope: Option<index::RefreshScope>,
) -> Result<Vec<index::SnapshotModel>, String> {
    let directory = index::directory(&app)?;
    let mut roots = vec![PathBuf::from(&root)];
    if let Some(extra) = extra_roots {
        roots.extend(extra.iter().map(PathBuf::from));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(scope) = scope {
            index::load_scoped(&directory, roots, true, Some(scope))
        } else {
            index::load(&directory, roots, refresh.unwrap_or(false))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_err() {
        crate::logs::push(
            crate::logs::Source::Deas,
            "ERROR: Library index operation=load failed; check configured folders and cache access",
        );
    }
    result
}
#[tauri::command]
pub async fn native_model_info(
    app: tauri::AppHandle,
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    path: String,
    authenticated: bool,
    save_preview: Option<bool>,
) -> Result<LocalModel, String> {
    let c = engine.catalog()?;
    let p = c
        .providers
        .iter()
        .find(|p| p.kind == "civitai")
        .ok_or("No CivitAI provider in catalog")?;
    let h = credential(&auth, p, authenticated)?;
    let model = fetch(p, PathBuf::from(path), h, save_preview.unwrap_or(false)).await?;
    update_index(&app, &model).await;
    Ok(model)
}

/// Explicit user link to a CivitAI model/version page; recorded as `matchedBy: manual`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields; AppHandle and states are injected by Tauri.
pub async fn native_model_link(
    app: tauri::AppHandle,
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    path: String,
    link: String,
    authenticated: bool,
    save_preview: Option<bool>,
) -> Result<LocalModel, String> {
    let c = engine.catalog()?;
    let p = c
        .providers
        .iter()
        .find(|p| p.kind == "civitai")
        .ok_or("No CivitAI provider in catalog")?;
    let h = credential(&auth, p, authenticated)?;
    let result = self::link(
        p,
        PathBuf::from(path),
        h,
        &link,
        save_preview.unwrap_or(false),
    )
    .await;
    let model = match result {
        Ok(model) => model,
        Err(error) => {
            crate::logs::native_logs_library_error("civitai-link".into());
            return Err(error);
        }
    };
    crate::logs::push(
        crate::logs::Source::Deas,
        "INFO: Library operation=civitai-link outcome=linked",
    );
    update_index(&app, &model).await;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_budget_counts_nonmodels_and_empty_directories_across_roots() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("loras");
        std::fs::create_dir(&base).unwrap();
        for name in ["empty-one", "empty-two", "empty-three"] {
            std::fs::create_dir(base.join(name)).unwrap();
        }
        std::fs::write(base.join("notes.txt"), b"not a model").unwrap();
        let mut jobs = vec![];
        let mut remaining = 2;
        walk("loras", &base, &base, 0, &mut jobs, &mut remaining);
        assert_eq!(remaining, 0);
        assert!(jobs.is_empty());
        let other = dir.path().join("other");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("a.pt"), b"fixture").unwrap();
        walk("loras", &other, &other, 0, &mut jobs, &mut remaining);
        assert!(jobs.is_empty());
        remaining = 1;
        walk("loras", &other, &other, 0, &mut jobs, &mut remaining);
        assert_eq!(jobs.len(), 1);
    }

    fn directory_alias(target: &Path, alias: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .output()
                .unwrap();
            assert!(output.status.success(), "mklink /J: {:?}", output);
        }
    }

    fn remove_alias(alias: &Path) {
        #[cfg(unix)]
        std::fs::remove_file(alias).unwrap();
        #[cfg(windows)]
        std::fs::remove_dir(alias).unwrap();
    }

    #[test]
    fn swarm_roots_contain_categories_and_arbitrary_subfolders_remain_unsupported() {
        for category in crate::settings::MODEL_FOLDERS {
            let (root, path) = family_fixture(category);
            let contained = scan(root.path()).unwrap();
            assert_eq!(contained.len(), 1);
            assert_eq!(contained[0].category, category);
            assert!(scan(path.parent().unwrap()).unwrap().is_empty());
        }
        let (_root, path) = family_fixture("Krea2");
        assert!(scan(path.parent().unwrap()).unwrap().is_empty());
        assert!(model_category(&path).is_err());
    }

    #[test]
    fn swarm_aliases_share_namespace_inside_configured_roots() {
        for (folder, category, field) in [
            ("Stable-Diffusion", "checkpoints", "checkpoints"),
            ("Lora", "loras", "loras"),
            ("loras", "loras", "loras"),
        ] {
            let (root, path) = family_fixture(folder);
            let models = scan(root.path()).unwrap();
            assert_eq!(models.len(), 1, "missing {folder}");
            assert_eq!(models[0].category, category);
            assert_eq!(models[0].detected_family.as_deref(), Some("sdxl"));
            let declared = write_family(&path, Some("sdxl")).unwrap();
            assert_eq!(declared.category, category);
            assert_eq!(scan(root.path()).unwrap(), vec![declared]);
            write_cache_bytes(&sidecar(&path), b"{broken");
            assert!(
                validate_selected(&[root.path().into()], field, "unknown.safetensors").is_err()
            );
        }
    }

    #[tokio::test]
    async fn swarm_junction_family_fetch_reset_and_category_deduplication() {
        let (target, path) = family_fixture("checkpoints");
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("Stable-Diffusion");
        directory_alias(path.parent().unwrap(), &alias);
        directory_alias(path.parent().unwrap(), &root.path().join("checkpoints"));
        let linked = alias.join(path.file_name().unwrap());
        let source = Source::open(&linked).expect("model directory aliases must be supported");
        assert_eq!(source.stamp, Source::open(&path).unwrap().stamp);
        let declared = write_family(&linked, Some("anima")).unwrap();
        assert_eq!(declared.detected_family.as_deref(), Some("sdxl"));
        assert_eq!(declared.family_override.as_deref(), Some("anima"));
        let reopened = scan(root.path()).unwrap();
        assert_eq!(reopened.len(), 1);
        let mut expected = declared.clone();
        expected.path = reopened[0].path.clone();
        assert_eq!(reopened, vec![expected]);
        assert_eq!(
            Source::open(Path::new(&reopened[0].path)).unwrap().stamp,
            source.stamp
        );
        let fetched = fetch_fixture_reply(&linked, || {}, Some(r#"{"id":1,"modelId":2,"name":"v1","model":{"name":"Fixture","type":"Checkpoint"},"baseModel":"SDXL 1.0"}"#)).await.unwrap();
        assert_eq!(fetched.category, "checkpoints");
        assert_eq!(fetched.family_override.as_deref(), Some("anima"));
        let reset = write_family(&linked, None).unwrap();
        assert_eq!(reset.info, fetched.info);
        assert_eq!(reset.family.as_deref(), Some("sdxl"));
        assert_eq!(
            scan_roots(&[root.path().into(), target.path().into()])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(Source::open(&path).unwrap().stamp, source.stamp);
        assert_no_owned_temps(path.parent().unwrap());
        println!(
            "{}",
            serde_json::json!({
                "acceptance": "swarm-model-junction", "os": std::env::consts::OS,
                "category": reset.category, "detectedFamily": reset.detected_family,
                "savedFamily": reopened[0].family_override, "resetFamily": reset.family_override,
                "freshScanReadback": true, "providerMetadataPreserved": reset.info == fetched.info,
                "sourceFingerprintUnchanged": true, "deduplicatedRows": 1
            })
        );
    }

    #[tokio::test]
    async fn swarm_lora_nested_junction_readback_and_selected_validation() {
        let (_target, path) = family_fixture("loras");
        let root = tempfile::tempdir().unwrap();
        let loras = root.path().join("Lora");
        std::fs::create_dir(&loras).unwrap();
        let alias = loras.join("nested models");
        directory_alias(path.parent().unwrap(), &alias);
        let linked = alias.join(path.file_name().unwrap());
        let declared = write_family(&linked, Some("sdxl")).unwrap();
        assert_eq!(declared.category, "loras");
        assert_eq!(declared.detected_family.as_deref(), Some("sdxl"));
        let reopened = scan(root.path()).unwrap();
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0].family_override.as_deref(), Some("sdxl"));
        assert_eq!(
            reopened[0].name,
            Path::new("nested models")
                .join("unknown.safetensors")
                .to_str()
                .unwrap()
        );
        let fetched = fetch_fixture_reply(&linked, || {}, Some(r#"{"id":1,"modelId":2,"name":"v1","model":{"name":"Fixture","type":"LORA"},"baseModel":"SDXL 1.0"}"#)).await.unwrap();
        assert_eq!(fetched.category, "loras");
        assert_eq!(fetched.family_override.as_deref(), Some("sdxl"));
        let reset = write_family(&linked, None).unwrap();
        assert_eq!(reset.info, fetched.info);
        assert!(scan(root.path()).unwrap()[0].family_override.is_none());
        write_cache_bytes(&sidecar(&path), b"{broken");
        assert!(validate_selected(&[root.path().into()], "loras", &reopened[0].name).is_err());
    }

    #[test]
    fn swarm_distinct_nested_alias_names_keep_both_backend_ids() {
        let (_target, path) = family_fixture("loras");
        let root = tempfile::tempdir().unwrap();
        let loras = root.path().join("loras");
        std::fs::create_dir(&loras).unwrap();
        for name in ["a", "b"] {
            directory_alias(path.parent().unwrap(), &loras.join(name));
        }
        let models = scan(root.path()).unwrap();
        assert_eq!(models.len(), 2);
        for (model, alias) in models.iter().zip(["a", "b"]) {
            assert_eq!(
                model.name,
                Path::new(alias)
                    .join("unknown.safetensors")
                    .to_string_lossy()
            );
            assert_eq!(model.category, "loras");
        }
    }

    #[test]
    fn swarm_chained_junctions_track_every_alias_and_reject_loops() {
        let (_target, path) = family_fixture("loras");
        let root = tempfile::tempdir().unwrap();
        let intermediate = root.path().join("intermediate");
        std::fs::create_dir(&intermediate).unwrap();
        let inner = intermediate.join("nested");
        directory_alias(path.parent().unwrap(), &inner);
        let outer = root.path().join("loras");
        directory_alias(&intermediate, &outer);
        let linked = outer.join("nested").join(path.file_name().unwrap());
        let source = Source::open(&linked).unwrap();
        assert_eq!(source.stamp, Source::open(&path).unwrap().stamp);
        assert_eq!(scan(root.path()).unwrap().len(), 1);
        std::fs::rename(&inner, intermediate.join("old")).unwrap();
        directory_alias(path.parent().unwrap(), &inner);
        assert!(source.verify().unwrap_err().contains("alias changed"));
        let cycle = root.path().join("cycle");
        directory_alias(root.path(), &cycle);
        let loop_path = (0..41).fold(root.path().to_owned(), |path, _| path.join("cycle"));
        assert!(CacheDir::open(&loop_path).is_err());
    }

    #[test]
    fn swarm_junction_replacement_same_target_is_rejected() {
        let (_target, path) = family_fixture("checkpoints");
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("checkpoints");
        directory_alias(path.parent().unwrap(), &alias);
        let linked = alias.join(path.file_name().unwrap());
        let source = Source::open(&linked).unwrap();
        std::fs::rename(&alias, root.path().join("previous-link")).unwrap();
        directory_alias(path.parent().unwrap(), &alias);
        assert!(source.verify().unwrap_err().contains("alias changed"));
        assert!(!sidecar(&path).exists());
    }

    #[tokio::test]
    async fn swarm_junction_retarget_during_fetch_does_not_publish() {
        let (_first, path) = family_fixture("checkpoints");
        let (_second, other) = family_fixture("checkpoints");
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("Stable-Diffusion");
        directory_alias(path.parent().unwrap(), &alias);
        let linked = alias.join(path.file_name().unwrap());
        write_family(&linked, Some("anima")).unwrap();
        let before = std::fs::read(sidecar(&path)).unwrap();
        let other_dir = other.parent().unwrap().to_owned();
        let result = fetch_fixture(&linked, move || {
            remove_alias(&alias);
            directory_alias(&other_dir, &alias);
        })
        .await;
        assert!(result.unwrap_err().contains("alias changed"));
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), before);
        assert!(!sidecar(&other).exists());
        assert_no_owned_temps(path.parent().unwrap());
    }

    #[test]
    fn swarm_directory_resolution_never_follows_final_model_or_cache_links() {
        let (_target, path) = family_fixture("checkpoints");
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("checkpoints");
        directory_alias(path.parent().unwrap(), &alias);
        let linked = alias.join(path.file_name().unwrap());
        let before = std::fs::read(&path).unwrap();
        let victim = root.path().join("victim");
        std::fs::create_dir(&victim).unwrap();
        std::fs::write(victim.join("keep"), b"unchanged").unwrap();
        directory_alias(&victim, &path.parent().unwrap().join("linked.safetensors"));
        assert!(Source::open(&alias.join("linked.safetensors")).is_err());
        directory_alias(&victim, &sidecar(&path));
        assert!(write_family(&linked, Some("anima")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read(victim.join("keep")).unwrap(), b"unchanged");
        assert_eq!(std::fs::read_dir(&victim).unwrap().count(), 1);
        assert_no_owned_temps(path.parent().unwrap());
    }

    #[test]
    fn swarm_junction_final_hard_linked_cache_remains_rejected() {
        let (_target, path) = family_fixture("checkpoints");
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("checkpoints");
        directory_alias(path.parent().unwrap(), &alias);
        let linked = alias.join(path.file_name().unwrap());
        write_family(&linked, Some("anima")).unwrap();
        let before = std::fs::read(sidecar(&path)).unwrap();
        let victim = root.path().join("foreign-cache");
        std::fs::hard_link(sidecar(&path), &victim).unwrap();
        assert!(write_family(&linked, None).is_err());
        assert_eq!(std::fs::read(victim).unwrap(), before);
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), before);
        assert!(scan(root.path()).unwrap()[0].metadata_error.is_some());
    }

    #[test]
    fn swarm_junction_retarget_during_publication_preserves_both_targets() {
        let (first, path) = family_fixture("checkpoints");
        let (_second, other) = family_fixture("checkpoints");
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("checkpoints");
        directory_alias(path.parent().unwrap(), &alias);
        let linked = alias.join(path.file_name().unwrap());
        let source = Source::open(&linked).expect("open directory alias");
        let info = fixture_info(&linked);
        let result = publish_info(&source, &None, &info, || {
            remove_alias(&alias);
            directory_alias(other.parent().unwrap(), &alias);
        });
        assert!(result.is_err());
        assert!(!sidecar(&path).exists());
        assert!(!sidecar(&other).exists());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            std::fs::read(&other).unwrap()
        );
        drop(source);
        // Cleanup is allowed only through the still-verified target, not the retargeted alias.
        assert_no_owned_temps(&first.path().join("checkpoints"));
    }

    #[test]
    fn selected_lora_labels_are_advisory_but_integrity_and_source_checks_remain() {
        let (root, path) = family_fixture("loras");
        let header = br#"{"__metadata__":{"modelspec.architecture":"stable-diffusion-xl"},"fixture.weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend(0f32.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        let mut info = fixture_info(&path);
        info.civitai = Some(civitai_info(&serde_json::json!({"id":1,"modelId":2,"name":"v1","model":{"name":"fixture","type":"LORA"},"baseModel":"Flux.1 D"})).unwrap());
        write_info(&path, &info);
        let declared = write_family(&path, Some("anima")).unwrap();
        assert_eq!(declared.check.as_ref().unwrap().compatibility, "blocked");
        let roots = [root.path().into()];
        let reads = HASH_READS.with(|n| n.get());
        for family in ["sdxl", "anima", "minimax-h3"] {
            validate_selected_family(&roots, "loras", "unknown.safetensors", Some(family)).unwrap();
        }
        assert_eq!(HASH_READS.with(|n| n.get()), reads);
        assert!(
            validate_selected_family(&roots, "loras", "../unknown.safetensors", Some("anima"))
                .is_err()
        );
        write_cache_bytes(&sidecar(&path), b"{broken");
        assert!(
            validate_selected_family(&roots, "loras", "unknown.safetensors", Some("anima"))
                .unwrap_err()
                .contains("MODEL_METADATA_INVALID")
        );
        std::fs::remove_file(sidecar(&path)).unwrap();
        std::fs::write(&path, b"partial").unwrap();
        assert!(
            validate_selected_family(&roots, "loras", "unknown.safetensors", Some("anima"))
                .unwrap_err()
                .contains("MODEL_INTEGRITY_INVALID")
        );
    }
    #[test]
    fn model_check_compatible_variant_provider_and_lora_declaration() {
        let (root, path) = family_fixture("diffusion_models");
        let variant = path.with_file_name("qwen_image_2.1_turbo.safetensors");
        let header = br#"{"__metadata__":{"modelspec.architecture":"qwen-image-2.1"},"fixture.weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend(0f32.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        std::fs::rename(&path, &variant).unwrap();
        let mut info = fixture_info(&variant);
        info.civitai = Some(civitai_info(&serde_json::json!({"id":1,"modelId":2,"name":"v1","model":{"name":"fixture","type":"Checkpoint"},"baseModel":"Qwen Image 2.1"})).unwrap());
        write_info(&variant, &info);
        let model = scan(root.path()).unwrap().remove(0);
        assert_eq!(model.family.as_deref(), Some("qwen-image-2.1-turbo"));
        assert_eq!(model.info.as_ref().unwrap().sha256, info.sha256);
        let check = model.check.unwrap();
        assert_eq!(check.integrity, "headerChecked");
        assert_eq!(check.identity, "sha256");
        assert!(check.evidence.iter().any(|e| e == "header"));
        assert!(check.evidence.iter().any(|e| e == "provider"));
        assert_ne!(check.compatibility, "blocked");
        assert!(validate_selected_family(
            &[root.path().into()],
            "diffusionModels",
            "qwen_image_2.1_turbo.safetensors",
            Some("qwen-image-2.1-turbo")
        )
        .is_ok());

        let (root, path) = family_fixture("loras");
        std::fs::write(
            &path,
            2u64.to_le_bytes()
                .into_iter()
                .chain(*b"{}")
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(write_family(&path, Some("qwen-image-2.1-turbo")).is_err());
        write_family(&path, Some("qwen-image-2.1")).unwrap();
        assert!(validate_selected_family(
            &[root.path().into()],
            "loras",
            "unknown.safetensors",
            Some("qwen-image-2.1-turbo")
        )
        .is_ok());
    }

    #[test]
    fn model_check_declaration_cannot_hide_incompatible_header() {
        let (root, path) = family_fixture("diffusion_models");
        write_family(&path, Some("anima")).unwrap();
        assert!(validate_selected_family(
            &[root.path().into()],
            "diffusionModels",
            "unknown.safetensors",
            Some("anima")
        )
        .unwrap_err()
        .contains("MODEL_EVIDENCE_CONFLICT"));
    }

    #[test]
    fn model_check_reports_integrity_and_metadata_without_hashing_or_claiming_gguf_payload() {
        let (root, path) = family_fixture("vae");
        let reads = HASH_READS.with(|n| n.get());
        std::fs::write(&path, b"partial").unwrap();
        write_cache_bytes(&sidecar(&path), b"{broken");
        let model = scan(root.path()).unwrap().remove(0);
        let check = model.check.unwrap();
        assert_eq!(check.compatibility, "blocked");
        assert_eq!(serde_json::to_value(&check).unwrap()["integrity"], "broken");
        assert!(check.reasons.iter().any(|r| r.code == "metadata"));
        assert!(check.reasons.iter().any(|r| r.code == "integrity"));
        let gguf = path.with_extension("gguf");
        std::fs::rename(&path, &gguf).unwrap();
        let model = describe("vae", gguf.parent().unwrap(), &gguf).unwrap();
        assert!(model.integrity.is_none());
        let check = model.check.unwrap();
        assert_eq!(check.compatibility, "unknown");
        assert_eq!(
            serde_json::to_value(&check).unwrap()["integrity"],
            "unchecked"
        );
        assert_eq!(HASH_READS.with(|n| n.get()), reads);
    }

    #[test]
    fn model_check_selected_structural_family_integrity_and_unknown_gates() {
        let (root, path) = family_fixture("diffusion_models");
        assert!(validate_selected_family(
            &[root.path().into()],
            "diffusionModels",
            "unknown.safetensors",
            Some("anima")
        )
        .is_err());
        std::fs::write(&path, b"partial").unwrap();
        assert!(validate_selected(
            &[root.path().into()],
            "diffusionModels",
            "unknown.safetensors"
        )
        .unwrap_err()
        .contains("MODEL_INTEGRITY_INVALID"));
        let (_root, checkpoint) = family_fixture("checkpoints");
        std::fs::write(&checkpoint, b"legacy checkpoint").unwrap();
        let unknown = checkpoint.with_extension("ckpt");
        std::fs::rename(checkpoint, &unknown).unwrap();
        assert!(validate_selected(&[_root.path().into()], "checkpoints", "unknown.ckpt").is_ok());
    }

    #[test]
    fn model_check_selected_companion_integrity_and_metadata_gates() {
        for (category, field) in [
            ("vae", "vaes"),
            ("text_encoders", "textEncoders"),
            ("clip", "ggufDualTextEncoders"),
            ("clip_vision", "visionModels"),
            ("upscale_models", "upscaleModels"),
            ("audio_encoders", "audioEncoders"),
        ] {
            let (root, path) = family_fixture(category);
            let roots = [root.path().into()];
            write_cache_bytes(&sidecar(&path), b"{broken");
            assert!(
                validate_selected(&roots, field, "unknown.safetensors").is_err(),
                "{field} metadata"
            );
            std::fs::remove_file(sidecar(&path)).unwrap();
            std::fs::write(&path, b"partial safetensors").unwrap();
            assert!(
                validate_selected(&roots, field, "unknown.safetensors")
                    .unwrap_err()
                    .contains("MODEL_INTEGRITY_INVALID"),
                "{field} integrity"
            );
            assert!(validate_selected(&roots, field, "backend-only.safetensors").is_ok());
        }
    }

    #[test]
    fn model_check_unknown_and_manual_family_are_not_header_proof() {
        let (root, path) = family_fixture("checkpoints");
        let header = br#"{"fixture.weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend(0f32.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        for declared in [false, true] {
            if declared {
                write_family(&path, Some("sdxl")).unwrap();
            }
            let model = scan(root.path()).unwrap().remove(0);
            let check = model.check.unwrap();
            assert_eq!(check.identity, "unverified");
            assert_eq!(check.compatibility, "unknown");
            assert!(!check.evidence.iter().any(|e| e == "header"));
            assert_eq!(check.evidence.iter().any(|e| e == "declaration"), declared);
            assert!(validate_selected_family(
                &[root.path().into()],
                "checkpoints",
                "unknown.safetensors",
                Some("sdxl")
            )
            .is_ok());
        }
    }

    #[test]
    fn model_check_scan_separates_identity_structure_and_stale_cache() {
        let (root, path) = family_fixture("checkpoints");
        let header = br#"{"__metadata__":{"modelspec.architecture":"stable-diffusion-xl"},"fixture.weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend(0f32.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        let mut info = fixture_info(&path);
        info.civitai = Some(civitai_info(&serde_json::json!({"id":1,"modelId":2,"name":"v1","model":{"name":"fixture","type":"Checkpoint"},"baseModel":"SD1.5"})).unwrap());
        write_info(&path, &info);
        let row = serde_json::to_value(scan(root.path()).unwrap().remove(0)).unwrap();
        assert_eq!(row["check"]["identity"], "sha256");
        assert_eq!(row["check"]["compatibility"], "blocked");
        assert!(
            validate_selected(&[root.path().into()], "checkpoints", "unknown.safetensors")
                .unwrap_err()
                .contains("MODEL_EVIDENCE_CONFLICT")
        );
        assert!(row["check"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["code"] == "conflict"));
        let replacement = path.with_extension("new");
        std::fs::copy(&path, &replacement).unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let row = serde_json::to_value(scan(root.path()).unwrap().remove(0)).unwrap();
        assert_eq!(row["check"]["identity"], "unverified");
        assert_eq!(row["check"]["availability"], "available");
        assert!(row["info"].is_null());
    }

    fn family_fixture(category: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(category);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("unknown.safetensors");
        let header = br#"{"__metadata__":{"modelspec.architecture":"stable-diffusion-xl"}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        std::fs::write(&path, bytes).unwrap();
        (root, path)
    }

    #[test]
    fn family_write_reset_rescan_never_hashes_and_keeps_detection() {
        let (root, path) = family_fixture("checkpoints");
        // Sparse weights prove declaration-only publication never traverses the payload.
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(8 << 30)
            .unwrap();
        let hashes = HASH_READS.with(|n| n.get());
        let before = Source::open(&path).unwrap().stamp;
        let model = write_family(&path, Some("anima")).unwrap();
        assert_eq!(model.family.as_deref(), Some("anima"));
        assert_eq!(model.detected_family.as_deref(), Some("sdxl"));
        assert_eq!(model.family_override.as_deref(), Some("anima"));
        assert!(model.info.is_none());
        assert_eq!(scan(root.path()).unwrap()[0], model);
        let json: Value = serde_json::from_slice(&std::fs::read(sidecar(&path)).unwrap()).unwrap();
        assert!(json.get("sha256").is_none());
        assert!(json.get("fetchedAt").is_none());
        assert!(json.get("civitai").is_none());
        let reset = write_family(&path, None).unwrap();
        assert_eq!(reset.family.as_deref(), Some("sdxl"));
        assert!(reset.family_override.is_none());
        assert!(reset.info.is_none());
        assert_eq!(scan(root.path()).unwrap()[0], reset);
        assert_eq!(HASH_READS.with(|n| n.get()), hashes);
        assert_eq!(Source::open(&path).unwrap().stamp, before);
    }

    #[test]
    fn ace_selected_family_matches_effective_source_metadata() {
        let (root, path) = family_fixture("diffusion_models");
        let roots = [root.path().to_owned()];
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(validate_selected_family(
            &roots,
            "diffusionModels",
            name,
            Some("ace-step-1-5-turbo")
        )
        .unwrap_err()
        .contains("MODEL_FAMILY_MISMATCH"));
        // A declaration may resolve unknown evidence, not replace a known SDXL architecture.
        std::fs::write(&path, [2u64.to_le_bytes().as_slice(), b"{}"].concat()).unwrap();
        write_family(&path, Some("ace-step-1-5-turbo")).unwrap();
        assert!(validate_selected_family(
            &roots,
            "diffusionModels",
            name,
            Some("ace-step-1-5-turbo")
        )
        .is_ok());
        assert!(validate_selected_family(
            &roots,
            "diffusionModels",
            name,
            Some("ace-step-1-5-base")
        )
        .is_err());
        write_family(&path, None).unwrap();
        assert!(validate_selected_family(
            &roots,
            "diffusionModels",
            name,
            Some("ace-step-1-5-turbo")
        )
        .is_err());
    }

    #[test]
    fn model_check_unresolved_generic_ace_preserves_manual_resolution_without_header_proof() {
        use crate::model_families::FamilyEvidence;
        for architecture in [None, Some("ace-step")] {
            let (root, path) = family_fixture("diffusion_models");
            let mut head = serde_json::json!({
                "encoder.lyric_encoder.layers.0.input_layernorm.weight": {
                    "dtype": "F32", "shape": [2048], "data_offsets": [0, 8192]
                }
            });
            if let Some(architecture) = architecture {
                head["__metadata__"] = serde_json::json!({"modelspec.architecture": architecture});
            }
            let header = head.to_string();
            let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
            bytes.extend(header.as_bytes());
            bytes.resize(bytes.len() + 8192, 0);
            std::fs::write(&path, bytes).unwrap();
            let automatic = scan(root.path()).unwrap().remove(0);
            assert_eq!(automatic.detected_family.as_deref(), Some("ace-step"));
            assert_eq!(automatic.family_evidence, Some(FamilyEvidence::Unresolved));
            let check = automatic.check.as_ref().unwrap();
            assert_eq!(check.integrity, "headerChecked");
            assert!(!check.evidence.iter().any(|e| e == "header"));
            let declared = write_family(&path, Some("ace-step-1-5-turbo")).unwrap();
            assert_eq!(declared.family.as_deref(), Some("ace-step-1-5-turbo"));
            assert_eq!(
                declared.family_override.as_deref(),
                Some("ace-step-1-5-turbo")
            );
            assert_eq!(declared.detected_family, automatic.detected_family);
            assert_eq!(declared.family_evidence, automatic.family_evidence);
            let check = declared.check.as_ref().unwrap();
            assert_eq!(check.compatibility, "unknown");
            assert!(check.evidence.iter().any(|e| e == "declaration"));
            assert!(!check.evidence.iter().any(|e| e == "header"));
            assert!(!check.reasons.iter().any(|r| r.code == "conflict"));
            assert_eq!(scan(root.path()).unwrap()[0], declared);
            assert!(validate_selected_family(
                &[root.path().into()],
                "diffusionModels",
                "unknown.safetensors",
                Some("ace-step-1-5-turbo")
            )
            .is_ok());
            assert_eq!(write_family(&path, None).unwrap(), automatic);
        }
    }

    #[test]
    fn model_check_ace_structural_conflicts_still_block_manual_resolution() {
        use crate::model_families::FamilyEvidence;
        for (architecture, evidence) in [
            ("ace-step-1-0", FamilyEvidence::Header),
            ("ace-step-1-5-turbo", FamilyEvidence::Conflict),
        ] {
            let (root, path) = family_fixture("diffusion_models");
            let head = serde_json::json!({
                "__metadata__": {"modelspec.architecture": architecture},
                "genre_embedder.weight": {
                    "dtype": "F32", "shape": [2560, 768],
                    "data_offsets": [0, 2560 * 768 * 4]
                }
            });
            let header = head.to_string();
            let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
            bytes.extend(header.as_bytes());
            bytes.resize(bytes.len() + 2560 * 768 * 4, 0);
            std::fs::write(&path, bytes).unwrap();
            let declared = write_family(&path, Some("ace-step-1-5-turbo")).unwrap();
            assert_eq!(declared.family_evidence, Some(evidence));
            let check = declared.check.as_ref().unwrap();
            assert_eq!(check.integrity, "headerChecked");
            assert_eq!(check.compatibility, "blocked");
            assert!(check.reasons.iter().any(|r| r.code == "conflict"));
            assert_eq!(scan(root.path()).unwrap()[0], declared);
            assert!(validate_selected_family(
                &[root.path().into()],
                "diffusionModels",
                "unknown.safetensors",
                Some("ace-step-1-5-turbo")
            )
            .unwrap_err()
            .contains("MODEL_EVIDENCE_CONFLICT"));
        }
    }

    #[test]
    fn ace_all_in_one_outside_checkpoints_is_flagged_misplaced() {
        for (category, vae, text, misplaced) in [
            ("unet", true, true, true),
            ("diffusion_models", true, true, true),
            ("checkpoints", true, true, false),
            ("unet", false, true, false),
            ("unet", true, false, false),
        ] {
            let (_root, path) = family_fixture(category);
            let mut head =
                serde_json::json!({"__metadata__":{"modelspec.architecture":"ace-step-1-5-turbo"}});
            let tensor = serde_json::json!({"dtype":"F32","shape":[0],"data_offsets":[0,0]});
            if vae {
                head["vae.decoder.layers.0.bias"] = tensor.clone();
            }
            if text {
                head["text_encoders.qwen3_06b.logit_scale"] = tensor;
            }
            let header = head.to_string();
            let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
            bytes.extend(header.as_bytes());
            std::fs::write(&path, bytes).unwrap();
            let model = describe(category, path.parent().unwrap(), &path).unwrap();
            assert_eq!(
                model.misplaced_all_in_one, misplaced,
                "{category} {vae} {text}"
            );
            assert_eq!(
                serde_json::to_value(&model)
                    .unwrap()
                    .get("misplacedAllInOne")
                    .is_some(),
                misplaced
            );
        }
    }

    #[test]
    fn ace_aio_checkpoint_requires_embedded_vae_and_text_encoders() {
        for (vae, text) in [(false, false), (false, true), (true, false), (true, true)] {
            let (root, path) = family_fixture("checkpoints");
            // Synthetic explicit architecture; real official AIO exports use both namespaces.
            let mut head =
                serde_json::json!({"__metadata__":{"modelspec.architecture":"ace-step-1-5-turbo"}});
            let tensor = serde_json::json!({"dtype":"F32","shape":[0],"data_offsets":[0,0]});
            if vae {
                head["vae.decoder.layers.0.bias"] = tensor.clone();
            }
            if text {
                head["text_encoders.qwen3_06b.logit_scale"] = tensor;
            }
            let header = head.to_string();
            let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
            bytes.extend(header.as_bytes());
            std::fs::write(&path, bytes).unwrap();
            let result = validate_selected_family(
                &[root.path().to_owned()],
                "checkpoints",
                "unknown.safetensors",
                Some("ace-step-1-5-turbo"),
            );
            if vae && text {
                assert!(result.is_ok());
            } else {
                assert!(result.unwrap_err().contains("MODEL_COMPONENTS_MISSING"));
            }
        }
    }

    #[test]
    fn ace_family_scan_declare_reset_evidence_never_hashes() {
        use crate::model_families::FamilyEvidence;
        let (root, path) = family_fixture("checkpoints");
        // Synthetic explicit architecture, not a claimed producer metadata convention.
        let text = serde_json::json!({"__metadata__": {"modelspec.architecture": "ace-step-1-5"}})
            .to_string();
        let mut bytes = (text.len() as u64).to_le_bytes().to_vec();
        bytes.extend(text.as_bytes());
        std::fs::write(&path, bytes).unwrap();
        let hashes = HASH_READS.with(|n| n.get());
        let before = Source::open(&path).unwrap().stamp;
        let automatic = scan(root.path()).unwrap().remove(0);
        assert_eq!(automatic.detected_family.as_deref(), Some("ace-step-1-5"));
        assert_eq!(automatic.family_evidence, Some(FamilyEvidence::Unresolved));
        assert_eq!(
            serde_json::to_value(&automatic).unwrap()["familyEvidence"],
            "unresolved"
        );
        let families: Value =
            serde_json::from_str(include_str!("../../src/families/builtin.json")).unwrap();
        for id in families
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f["id"].as_str())
            .filter(|id| id.starts_with("ace-step"))
        {
            let declared = write_family(&path, Some(id)).unwrap();
            assert_eq!(declared.family.as_deref(), Some(id));
            assert_eq!(declared.family_override.as_deref(), Some(id));
            assert_eq!(declared.detected_family, automatic.detected_family);
            assert_eq!(declared.family_evidence, automatic.family_evidence);
            assert!(declared.info.is_none());
            assert_eq!(scan(root.path()).unwrap()[0], declared);
            let reset = write_family(&path, None).unwrap();
            assert_eq!(reset, automatic);
            assert_eq!(scan(root.path()).unwrap()[0], reset);
        }
        write_family(&path, Some("ace-step-1-5-turbo")).unwrap();
        let replacement = path.with_extension("new");
        std::fs::copy(&path, &replacement).unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let stale = scan(root.path()).unwrap().remove(0);
        assert!(stale.metadata_error.is_some());
        assert!(stale.family.is_none());
        assert_eq!(stale.detected_family, automatic.detected_family);
        assert_eq!(write_family(&path, None).unwrap(), automatic);
        assert_eq!(HASH_READS.with(|n| n.get()), hashes);
        assert_ne!(Source::open(&path).unwrap().stamp, before);
        let (_root, other) = family_fixture("checkpoints");
        let non_ace = describe("checkpoints", other.parent().unwrap(), &other).unwrap();
        assert!(serde_json::to_value(non_ace)
            .unwrap()
            .get("familyEvidence")
            .is_none());
    }

    #[test]
    fn family_validation_rejects_ids_categories_and_unsupported_loras_without_writes() {
        for category in ["checkpoints", "loras", "vae", "text_encoders"] {
            let (_root, path) = family_fixture(category);
            for id in ["unknown", "SDXL", "../sdxl", "", "sdxl\n"] {
                assert!(write_family(&path, Some(id)).is_err());
            }
            if category == "loras" {
                assert!(write_family(&path, Some("moss-image")).is_err());
                assert!(write_family(&path, Some("qwen-image-2.1-turbo")).is_err());
            }
            if ["vae", "text_encoders"].contains(&category) {
                assert!(write_family(&path, Some("sdxl")).is_err());
                assert!(write_family(&path, None).is_err());
            }
            assert!(!sidecar(&path).exists());
        }
    }

    #[test]
    fn stale_or_invalid_family_sidecar_blocks_even_detected_models() {
        let (root, path) = family_fixture("checkpoints");
        write_family(&path, Some("anima")).unwrap();
        let old = std::fs::read(sidecar(&path)).unwrap();
        let replacement = path.with_extension("new");
        std::fs::copy(&path, &replacement).unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let model = scan(root.path()).unwrap().remove(0);
        assert!(model.metadata_error.is_some());
        assert!(model.family.is_none());
        assert!(model.family_override.is_none());
        assert_eq!(model.detected_family.as_deref(), Some("sdxl"));
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), old);
        // Explicit reset can remove a structurally valid stale declaration, without reusing its hash.
        assert!(write_family(&path, None).unwrap().metadata_error.is_none());
        let mut json: Value = serde_json::from_slice(&old).unwrap();
        for value in [
            serde_json::json!("not-a-family"),
            serde_json::json!(7),
            serde_json::json!("x".repeat(1000)),
        ] {
            json["familyOverride"] = value.clone();
            let bytes = serde_json::to_vec(&json).unwrap();
            write_cache_bytes(&sidecar(&path), &bytes);
            let model = scan(root.path()).unwrap().remove(0);
            assert!(model.metadata_error.is_some());
            assert!(model.family.is_none());
            assert!(write_family(&path, Some("sdxl")).is_err());
            if value == serde_json::json!("not-a-family") {
                assert!(write_family(&path, None).unwrap().metadata_error.is_none());
            } else {
                assert!(write_family(&path, None).is_err());
                assert_eq!(std::fs::read(sidecar(&path)).unwrap(), bytes);
            }
        }
    }

    #[test]
    fn bulk_families_validate_first_and_report_missing_files_without_hashing() {
        let (_root, path) = family_fixture("loras");
        let missing = path.with_file_name("missing.safetensors");
        let paths = vec![
            path.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ];
        assert!(write_family_batch(&paths, Some("not-a-family")).is_err());
        assert!(!sidecar(&path).exists());
        let hashes = HASH_READS.with(|n| n.get());
        let report = write_family_batch(&paths, Some("anima")).unwrap();
        assert_eq!(report.updated.len(), 1);
        assert_eq!(report.failed, [missing.to_string_lossy()]);
        assert_eq!(report.updated[0].family_override.as_deref(), Some("anima"));
        assert_eq!(HASH_READS.with(|n| n.get()), hashes);
        assert!(write_family_batch(&[paths[0].clone(), paths[0].clone()], Some("anima")).is_err());
        assert!(write_family_batch(&[], Some("anima")).is_err());
        assert!(write_family_batch(&vec![paths[0].clone(); 501], Some("anima")).is_err());
        assert!(write_family_batch(&paths[..1], None).unwrap().updated[0]
            .family_override
            .is_none());
        assert!(include_str!("main.rs").contains("deas::native_model_family_write_many"));
        assert!(include_str!("../permissions/downloads.toml")
            .contains("native_model_family_write_many"));
    }

    #[test]
    fn selected_declarations_use_exact_namespace_root_order_and_no_hashes() {
        let (primary, path) = family_fixture("diffusion_models");
        let (extra, extra_path) = family_fixture("unet");
        write_family(&path, Some("sdxl")).unwrap();
        write_family(&extra_path, Some("sdxl")).unwrap();
        let roots = vec![primary.path().into(), extra.path().into()];
        let hashes = HASH_READS.with(|n| n.get());
        // A corrupt same-name extra does not shadow the first backend match.
        write_cache_bytes(&sidecar(&extra_path), b"{broken");
        assert!(validate_selected(&roots, "diffusionModels", "unknown.safetensors").is_ok());
        // Nor can a different category's broken sidecar invalidate a checkpoint.
        assert!(validate_selected(&roots, "checkpoints", "unknown.safetensors").is_ok());
        std::fs::remove_file(&path).unwrap();
        assert!(validate_selected(&roots, "diffusionModels", "unknown.safetensors").is_err());
        assert!(validate_selected(&roots, "diffusionModels", "../unknown.safetensors").is_err());
        assert_eq!(HASH_READS.with(|n| n.get()), hashes);
    }

    #[tokio::test]
    async fn reset_unknown_family_retains_current_provider_metadata_without_hashing() {
        let (root, path) = family_fixture("checkpoints");
        let fetched = fetch_fixture_reply(&path, || {}, Some(r#"{"id":1,"modelId":2,"name":"v1","model":{"name":"Fixture","type":"Checkpoint"},"baseModel":"SDXL 1.0"}"#)).await.unwrap();
        assert!(fetched.info.as_ref().unwrap().civitai.is_some());
        let mut json: Value =
            serde_json::from_slice(&std::fs::read(sidecar(&path)).unwrap()).unwrap();
        let original = json.clone();
        json["familyOverride"] = serde_json::json!("retired-family");
        write_cache_bytes(&sidecar(&path), &serde_json::to_vec(&json).unwrap());
        let hashes = HASH_READS.with(|n| n.get());
        let reset = write_family(&path, None).unwrap();
        assert_eq!(reset.info, fetched.info);
        let persisted: Value =
            serde_json::from_slice(&std::fs::read(sidecar(&path)).unwrap()).unwrap();
        assert_eq!(persisted, original);
        assert_eq!(scan_roots(&[root.path().into()]).unwrap()[0], reset);
        assert!(reset.family_override.is_none());
        assert!(reset.metadata_error.is_none());
        assert_eq!(HASH_READS.with(|n| n.get()), hashes);
    }

    #[tokio::test]
    async fn family_refresh_retains_provider_hash_and_override() {
        let (_root, path) = family_fixture("checkpoints");
        let fetched = fetch_fixture_reply(&path, || {}, Some(r#"{"id":1,"modelId":2,"name":"v1","model":{"name":"Fixture","type":"Checkpoint"},"baseModel":"SDXL 1.0"}"#)).await.unwrap();
        let declared = write_family(&path, Some("anima")).unwrap();
        assert_eq!(declared.info, fetched.info);
        assert_eq!(write_family(&path, None).unwrap().info, fetched.info);
        write_family(&path, Some("anima")).unwrap();
        let refreshed = fetch_fixture(&path, || {}).await.unwrap();
        assert_eq!(refreshed.family_override.as_deref(), Some("anima"));
        assert_eq!(refreshed.family.as_deref(), Some("anima"));
        assert_eq!(refreshed.info.unwrap().sha256, fetched.info.unwrap().sha256);
    }

    #[tokio::test]
    async fn family_declaration_only_cache_can_be_enriched_and_concurrent_write_wins() {
        let (_root, path) = family_fixture("checkpoints");
        write_family(&path, Some("anima")).unwrap();
        let enriched = fetch_fixture(&path, || {}).await.unwrap();
        assert!(enriched.info.is_some());
        assert_eq!(enriched.family_override.as_deref(), Some("anima"));
        let changed = path.clone();
        let error = fetch_fixture(&path, move || {
            write_family(&changed, Some("sdxl")).unwrap();
        })
        .await
        .unwrap_err();
        assert!(error.contains("cache changed"));
        let (category, base) = model_category(&path).unwrap();
        let current = describe(category, base, &path).unwrap();
        assert_eq!(current.family_override.as_deref(), Some("sdxl"));
        assert!(current.info.is_some());
    }

    #[test]
    fn family_write_preserves_invalid_sidecar_and_optimistic_snapshot() {
        let (_root, path) = family_fixture("checkpoints");
        write_cache_bytes(&sidecar(&path), b"{broken");
        assert!(write_family(&path, Some("sdxl")).is_err());
        assert_eq!(std::fs::read(sidecar(&path)).unwrap(), b"{broken");
        std::fs::remove_file(sidecar(&path)).unwrap();
        let source = Source::open(&path).unwrap();
        write_family(&path, Some("sdxl")).unwrap();
        let cache = source
            .dir
            .cache(&format!("{}{SIDECAR}", source.name))
            .unwrap()
            .unwrap()
            .1;
        assert!(publish_cache(&source, &None, &cache, || {}).is_err());
        assert_eq!(
            describe("checkpoints", path.parent().unwrap(), &path)
                .unwrap()
                .family_override
                .as_deref(),
            Some("sdxl")
        );
    }

    #[tokio::test]
    async fn family_errors_are_redacted_in_shared_logs_and_command_is_registered() {
        let secret = "hf_do_not_log_this_path";
        assert!(
            family_operation(secret.into(), Some("secret-family".into()))
                .await
                .is_err()
        );
        assert!(family_operation(secret.into(), None).await.is_err());
        let logs = crate::logs::native_logs(0);
        for operation in ["write", "reset"] {
            let expected = format!("models operation=family-{operation} outcome=failed");
            let entry = logs.iter().find(|e| e.text.contains(&expected)).unwrap();
            assert_eq!(entry.source, crate::logs::Source::Deas);
            assert!(!entry.text.contains(secret));
        }
        for source in [
            include_str!("lib.rs"),
            include_str!("main.rs"),
            include_str!("../permissions/downloads.toml"),
        ] {
            assert!(source.contains("native_model_family_write"));
        }
    }

    fn fixture_info(path: &Path) -> ModelInfo {
        ModelInfo {
            sha256: sha256_file(path).unwrap(),
            size: Source::open(path).unwrap().stamp.size,
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
    fn lora_edits_persist_and_the_custom_cover_takes_precedence() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("models");
        let folder = root.join("loras");
        let directory = fixture.path().join("index");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("fixture.pt");
        let legacy_cover = folder.join("fixture.preview.jpg");
        std::fs::write(&path, b"fixture weights").unwrap();
        std::fs::write(&legacy_cover, b"fixture cover").unwrap();
        index::load(&directory, vec![root.clone()], false).unwrap();

        let model = edit_lora(
            &directory,
            &root,
            &path,
            LoraEdit::TriggerWords {
                words: vec!["two words".into()],
            },
        )
        .unwrap();
        assert_eq!(model.trigger_words, Some(vec!["two words".into()]));
        assert!(model.info.is_none());
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 1, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[9, 8, 7])
                .unwrap();
        }
        let cover = edit_lora(
            &directory,
            &root,
            &path,
            LoraEdit::Preview { png: png.clone() },
        )
        .unwrap();
        let replacement = folder.join("fixture.pt.deas-preview.png");
        assert_eq!(
            Path::new(cover.local_preview.as_deref().unwrap()),
            replacement
        );
        assert_eq!(std::fs::read(&legacy_cover).unwrap(), b"fixture cover");
        assert_eq!(std::fs::read(&replacement).unwrap(), png);
        assert!(edit_lora(
            &directory,
            &root,
            &path,
            LoraEdit::Preview {
                png: b"invalid".to_vec()
            }
        )
        .is_err());
        assert_eq!(std::fs::read(&replacement).unwrap(), png);

        let cleared = edit_lora(
            &directory,
            &root,
            &path,
            LoraEdit::TriggerWords { words: vec![] },
        )
        .unwrap();
        assert_eq!(cleared.trigger_words, Some(vec![]));
        index::update(&directory, &path).unwrap();
        let saved =
            serde_json::to_value(index::load(&directory, vec![root], false).unwrap()).unwrap();
        assert_eq!(saved[0]["triggerWords"], serde_json::json!([]));
        assert_eq!(saved[0]["localPreview"], replacement.to_str().unwrap());
    }

    #[test]
    fn civitai_prompt_examples_keep_only_usable_stills_and_plain_prompt_metadata() {
        let images = serde_json::json!({
            "images": [
                {"url":"https://image.civitai.com/original=true/sample.png","type":"image",
                 "meta":{"prompt":"  portrait <lora:test:1>\n second line  ","negativePrompt":" blur "}},
                {"url":"https://image.civitai.com/sample.mp4","type":"video","meta":{"prompt":"moving"}},
                {"url":"https://image.civitai.com/unknown.png"},
                {"url":"https://example.invalid/remote.jpg","meta":{"prompt":"external"}}
            ]
        });
        let examples = model_examples(&images);
        assert_eq!(examples.len(), 1);
        assert_eq!(
            examples[0].image,
            "https://image.civitai.com/width=450/sample.png"
        );
        assert_eq!(examples[0].prompt, "portrait <lora:test:1>\n second line");
        assert_eq!(examples[0].negative_prompt.as_deref(), Some("blur"));
    }

    #[test]
    fn civitai_model_cover_keeps_the_first_mp4_and_its_original_url() {
        let video = "https://image.civitai.com/fixture/original=true/video.MP4?size=small";
        let original = serde_json::json!({
            "images": [
                {"type":"video","url":video,"meta":{"prompt":"video"}},
                {"type":"image","url":"https://image.civitai.com/original=true/frame.jpg","meta":{"prompt":"still"}}
            ]
        });
        assert_eq!(
            civitai_cover(&original),
            Some((video.into(), CivitaiPreviewKind::Video))
        );
        assert_eq!(model_examples(&original).len(), 1);
        let provider_video = serde_json::json!({
            "images":[{"type":"video","url":"https://images.civitai.com/fixture/clip"}]
        });
        assert_eq!(
            civitai_cover(&provider_video).unwrap().1,
            CivitaiPreviewKind::Video
        );
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
        assert_eq!(
            models[0].name,
            Path::new("Anima").join("a.safetensors").to_str().unwrap()
        );
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
        let roots = [root.path().into()];
        assert!(
            validate_selected_family(&roots, "vaes", "renamed.safetensors", Some("anima")).is_ok()
        );
        assert!(validate_selected_family(
            &roots,
            "vaes",
            "renamed.safetensors",
            Some("moss-image")
        )
        .unwrap_err()
        .contains("MODEL_COMPONENT_MISMATCH"));
        assert!(validate_selected_context(
            &roots,
            "vaes",
            "renamed.safetensors",
            Some("moss-image"),
            Some("vaes"),
            true
        )
        .is_ok());
        write_cache_bytes(&sidecar(&path), b"{broken");
        assert!(validate_selected_context(
            &roots,
            "vaes",
            "renamed.safetensors",
            Some("moss-image"),
            Some("vaes"),
            true
        )
        .is_err());
        assert!(validate_selected_family(
            &roots,
            "vaes",
            "renamed.safetensors",
            Some("moss-image")
        )
        .unwrap_err()
        .contains("MODEL_METADATA_INVALID"));
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
        let (requests, result) = fetch_fixture_routes(path, before_reply, move |n, _| {
            if n == 0 {
                reply.map(str::to_owned)
            } else {
                None
            }
        })
        .await;
        if let Ok(model) = &result {
            assert!(requests[0].contains(&model.info.as_ref().unwrap().sha256));
        }
        result
    }

    /// Serves every request of one fetch: `route(index, request line)` answers 200 + JSON or 404.
    async fn fetch_fixture_routes(
        path: &Path,
        before_reply: impl FnOnce() + Send + 'static,
        route: impl Fn(usize, &str) -> Option<String> + Send + 'static,
    ) -> (Vec<String>, Result<LocalModel, String>) {
        let p = fixture_server(before_reply, route);
        let result = fetch(&p.0, path.to_owned(), None, false).await;
        (p.1.finish().await, result)
    }

    struct FixtureServer {
        done: Arc<std::sync::atomic::AtomicBool>,
        thread: std::thread::JoinHandle<Vec<String>>,
    }

    impl FixtureServer {
        async fn finish(self) -> Vec<String> {
            self.done.store(true, std::sync::atomic::Ordering::SeqCst);
            let thread = self.thread;
            tokio::task::spawn_blocking(move || thread.join().unwrap())
                .await
                .unwrap()
        }
    }

    fn fixture_server(
        before_reply: impl FnOnce() + Send + 'static,
        route: impl Fn(usize, &str) -> Option<String> + Send + 'static,
    ) -> (Provider, FixtureServer) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop = done.clone();
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut before_reply = Some(before_reply);
            let mut requests = vec![];
            loop {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop.load(std::sync::atomic::Ordering::SeqCst) {
                            break;
                        }
                        assert!(Instant::now() < deadline, "Fixture fetch did not finish");
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("Fixture accept: {e}"),
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
                if let Some(hook) = before_reply.take() {
                    hook();
                }
                let request = String::from_utf8(request).unwrap();
                let line = request.lines().next().unwrap_or("").to_owned();
                match route(requests.len(), &line) {
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
                requests.push(request);
            }
            assert!(!requests.is_empty(), "No fixture request");
            requests
        });
        let p = Provider {
            id: "fixture".into(),
            kind: "civitai".into(),
            label: "Fixture".into(),
            origin,
            scopes: vec!["model".into()],
            anonymous_notice: "".into(),
        };
        (p, FixtureServer { done, thread })
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

    /// Chunking is a throughput change, never a digest change: one file crosses the 8 MiB boundary, the
    /// other stops one byte short of it.
    #[test]
    fn model_hash_matches_sha256_across_the_chunk_boundary() {
        for len in [MODEL_HASH_CHUNK + 12345usize, MODEL_HASH_CHUNK - 1] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("a.safetensors");
            let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                Source::open(&path).unwrap().hash().unwrap(),
                format!("{:x}", sha2::Sha256::digest(&bytes)),
                "{len} bytes"
            );
        }
    }

    /// Re-measures the chunking on a real model: `cargo test --lib -- --ignored --test-threads=1
    /// --nocapture hash_throughput_reference`. Prints MiB/s; skips itself when the model library is not
    /// mounted, so it costs nothing in a normal run or in CI.
    #[test]
    #[ignore = "reads a multi-gigabyte model from the shared library"]
    fn hash_throughput_reference() {
        let root = Path::new(r"F:\models");
        let entries = std::fs::read_dir(root)
            .ok()
            .into_iter()
            .flat_map(|read| read.flat_map(|entry| entry.ok().map(|entry| entry.path())))
            .flat_map(|path| match std::fs::metadata(&path) {
                Ok(meta) if meta.is_dir() => std::fs::read_dir(&path)
                    .ok()
                    .into_iter()
                    .flat_map(|read| read.flat_map(|entry| entry.ok().map(|entry| entry.path())))
                    .collect(),
                _ => vec![path],
            });
        let mut largest: Option<(u64, PathBuf)> = None;
        for path in entries {
            if path.extension().and_then(|ext| ext.to_str()) != Some("safetensors") {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file()
                || largest
                    .as_ref()
                    .is_some_and(|(size, _)| meta.len() <= *size)
            {
                continue;
            }
            largest = Some((meta.len(), path));
        }
        let Some((size, path)) = largest else {
            eprintln!("skipped: no model under {}", root.display());
            return;
        };
        let started = std::time::Instant::now();
        let digest = Source::open(&path).unwrap().hash().unwrap();
        let seconds = started.elapsed().as_secs_f64().max(0.001);
        println!(
            "hashed {} bytes of {} in {seconds:.2} s = {:.0} MiB/s ({digest})",
            size,
            path.display(),
            size as f64 / 1_048_576.0 / seconds
        );
    }

    #[test]
    fn an_oversized_ui_listing_is_cut_honestly() {
        let seed = LocalModel {
            trigger_words: None,
            local_preview: None,
            check: None,
            category: "loras".into(),
            name: "m.safetensors".into(),
            path: "/models/loras/m.safetensors".into(),
            size: 1,
            info: None,
            family: None,
            detected_family: None,
            family_evidence: None,
            family_override: None,
            metadata_error: None,
            component: None,
            integrity: None,
            misplaced_all_in_one: false,
        };
        assert_eq!(
            cap_for_ui(vec![seed.clone(); MAX_LISTING + 5]).len(),
            MAX_LISTING
        );
        assert_eq!(cap_for_ui(vec![seed; 7]).len(), 7);
    }

    /// Measures the whole-listing wall time over a real library: `DEAS_SCAN_LIBRARY=/path cargo
    /// test --lib -- --ignored --test-threads=1 --nocapture scan_listing_throughput_reference`.
    /// Prints per-round and best/avg seconds; skips itself when the folder is not mounted.
    #[test]
    #[ignore = "walks the whole model library"]
    fn scan_listing_throughput_reference() {
        let root = PathBuf::from(std::env::var("DEAS_SCAN_LIBRARY").unwrap_or_default());
        if !root.is_dir() {
            eprintln!("scan: skipped, {} is not mounted", root.display());
            return;
        }
        let mut best = f64::MAX;
        let mut total = 0.0;
        let mut count = 0;
        for round in 0..5 {
            let started = std::time::Instant::now();
            count = super::scan(&root).expect("scan").len();
            let secs = started.elapsed().as_secs_f64();
            best = best.min(secs);
            total += secs;
            eprintln!("scan round {round}: {count} models in {secs:.3}s");
        }
        eprintln!(
            "scan: {count} models, best {best:.3}s, avg {:.3}s",
            total / 5.0
        );
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
                eprintln!(
                    "Windows symlink subcase unavailable: privilege not held (1314); portable regular/hard-link fixtures remain enabled"
                );
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

    fn tensor_fixture(dir: &Path, name: &str) -> (PathBuf, String, String) {
        let header = br#"{"w":{"dtype":"F32","shape":[2],"data_offsets":[0,8]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend([9u8, 8, 7, 6, 5, 4, 3, 2]);
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        let autov3 = format!("{:X}", Sha256::digest([9u8, 8, 7, 6, 5, 4, 3, 2]))[..12].to_owned();
        let sha256 = sha256_file(&path).unwrap();
        (path, sha256, autov3)
    }

    fn version_json(id: u64, model: u64, sha256: &str, autov3: &str) -> String {
        serde_json::json!({
            "id": id, "modelId": model, "name": format!("v{id}"), "baseModel": "MiniMax H3",
            "model": {"name": format!("Model {model}"), "type": "LORA"},
            "creator": {"username": "maker"},
            "files": [{"hashes": {"SHA256": sha256.to_uppercase(), "AutoV3": autov3}}]
        })
        .to_string()
    }

    #[tokio::test]
    async fn sha256_miss_falls_back_to_bound_autov3_and_caches_the_tensor_hash() {
        let root = tempfile::tempdir().unwrap();
        let (path, sha256, autov3) = tensor_fixture(root.path(), "lora.safetensors");
        let body = version_json(11, 22, "0".repeat(64).as_str(), &autov3);
        let wanted = autov3.clone();
        let (requests, result) = fetch_fixture_routes(
            &path,
            || {},
            move |_, line| {
                line.contains(&format!("by-hash/{wanted} "))
                    .then(|| body.clone())
            },
        )
        .await;
        let info = result.unwrap().info.unwrap();
        assert!(requests[0].contains(&sha256));
        let civitai = info.civitai.unwrap();
        assert_eq!(civitai.version_id, 11);
        assert_eq!(civitai.matched_by, Some(CivitaiMatch::Autov3));
        let cached: Value =
            serde_json::from_slice(&std::fs::read(sidecar(&path)).unwrap()).unwrap();
        assert_eq!(cached["autov3"], autov3);
        assert_eq!(cached["civitai"]["matchedBy"], "autov3");
        // The cached tensor hash is reused: a retried lookup does not reread the file.
        let hashes = HASH_READS.with(|n| n.get());
        let (_, again) = fetch_fixture_routes(&path, || {}, |_, _| None).await;
        assert!(again.unwrap().info.unwrap().civitai.is_none());
        assert_eq!(HASH_READS.with(|n| n.get()), hashes);
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(sidecar(&path)).unwrap()).unwrap()
                ["autov3"],
            autov3
        );
    }

    #[tokio::test]
    async fn autov3_reply_that_does_not_list_the_hash_is_not_a_match() {
        let root = tempfile::tempdir().unwrap();
        let (path, _, autov3) = tensor_fixture(root.path(), "lora.safetensors");
        let body = version_json(11, 22, &"0".repeat(64), "FFFFFFFFFFFF");
        let wanted = autov3.clone();
        let (_, result) = fetch_fixture_routes(
            &path,
            || {},
            move |_, line| {
                line.contains(&format!("by-hash/{wanted} "))
                    .then(|| body.clone())
            },
        )
        .await;
        assert!(result.unwrap().info.unwrap().civitai.is_none());
    }

    #[tokio::test]
    async fn forge_sidecars_bind_by_hash_and_import_activation_text() {
        let root = tempfile::tempdir().unwrap();
        let (path, sha256, _) = tensor_fixture(root.path(), "lora.safetensors");
        // Civitai Helper record bound by the full hash; CivitAI no longer serves it.
        std::fs::write(
            root.path().join("lora.civitai.info"),
            version_json(31, 41, &sha256, "000000000000"),
        )
        .unwrap();
        std::fs::write(
            root.path().join("lora.json"),
            format!(
                r#"{{"activation text":"h3style, anime","sha256":"{}"}}"#,
                sha256.to_uppercase()
            ),
        )
        .unwrap();
        let (_, result) = fetch_fixture_routes(&path, || {}, |_, _| None).await;
        let model = result.unwrap();
        let civitai = model.info.as_ref().unwrap().civitai.clone().unwrap();
        assert_eq!((civitai.model_id, civitai.version_id), (41, 31));
        assert_eq!(civitai.matched_by, Some(CivitaiMatch::Sidecar));
        assert_eq!(
            model.trigger_words,
            Some(vec!["h3style".to_owned(), "anime".to_owned()])
        );
        // A sidecar for another file's hash is never adopted.
        let (other, _, _) = tensor_fixture(root.path(), "other.safetensors");
        std::fs::write(
            root.path().join("other.civitai.info"),
            version_json(31, 41, &"1".repeat(64), "000000000000"),
        )
        .unwrap();
        let (_, result) = fetch_fixture_routes(&other, || {}, |_, _| None).await;
        assert!(result.unwrap().info.unwrap().civitai.is_none());
    }

    #[tokio::test]
    async fn forge_model_id_resolves_the_version_listing_this_file() {
        let root = tempfile::tempdir().unwrap();
        let (path, sha256, autov3) = tensor_fixture(root.path(), "lora.safetensors");
        std::fs::write(root.path().join("lora.json"), r#"{"modelId":77}"#).unwrap();
        let record = serde_json::json!({
            "id": 77, "name": "Forge Model", "type": "LORA", "nsfw": true,
            "modelVersions": [
                {"id": 1, "name": "other", "files": [{"hashes": {"SHA256": "AB"}}]},
                {"id": 2, "name": "this", "files": [{"hashes": {"SHA256": sha256, "AutoV3": autov3}}]}
            ]
        })
        .to_string();
        let (_, result) = fetch_fixture_routes(
            &path,
            || {},
            move |_, line| line.contains("/api/v1/models/77 ").then(|| record.clone()),
        )
        .await;
        let civitai = result.unwrap().info.unwrap().civitai.unwrap();
        assert_eq!((civitai.model_id, civitai.version_id), (77, 2));
        assert_eq!(civitai.name, "Forge Model");
        assert!(civitai.nsfw);
        assert_eq!(civitai.matched_by, Some(CivitaiMatch::Sidecar));
    }

    #[tokio::test]
    async fn pasted_link_is_recorded_as_manual_and_survives_later_misses() {
        let root = tempfile::tempdir().unwrap();
        let (path, sha256, autov3) = tensor_fixture(root.path(), "lora.safetensors");
        let record = serde_json::json!({
            "id": 5, "name": "Linked", "type": "LORA",
            "modelVersions": [
                {"id": 50, "name": "newest", "files": []},
                {"id": 49, "name": "mine", "files": [{"hashes": {"SHA256": sha256, "AutoV3": autov3}}]}
            ]
        })
        .to_string();
        let (p, server) = fixture_server(
            || {},
            move |_, line| line.contains("/api/v1/models/5 ").then(|| record.clone()),
        );
        let linked = link(
            &p,
            path.clone(),
            None,
            "https://civitai.red/models/5/linked",
            false,
        )
        .await
        .unwrap();
        server.finish().await;
        let civitai = linked.info.unwrap().civitai.unwrap();
        assert_eq!(civitai.version_id, 49, "the version listing this file wins");
        assert_eq!(civitai.matched_by, Some(CivitaiMatch::Manual));
        let (_, refreshed) = fetch_fixture_routes(&path, || {}, |_, _| None).await;
        assert_eq!(
            refreshed.unwrap().info.unwrap().civitai.unwrap().version_id,
            49,
            "a miss keeps the user's link"
        );
        let version = version_json(60, 6, &"0".repeat(64), "000000000000");
        let (p, server) = fixture_server(
            || {},
            move |_, line| {
                line.contains("/model-versions/60 ")
                    .then(|| version.clone())
            },
        );
        let mismatch = link(
            &p,
            path.clone(),
            None,
            "https://civitai.com/models/7?modelVersionId=60",
            false,
        )
        .await;
        server.finish().await;
        assert!(mismatch.is_err(), "version of another model");
        assert!(link(
            &p,
            path.clone(),
            None,
            "https://example.com/models/5",
            false
        )
        .await
        .is_err());
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
        let model = fetch(p, file.clone(), None, false).await.unwrap();
        let civitai = model.info.unwrap().civitai.expect("hash known to CivitAI");
        assert!(civitai.model_id > 0 && !civitai.name.is_empty());
        assert!(read_info(&file).unwrap().civitai.is_some());
    }

    /// Live AutoV3 acceptance: `DEAS_LIVE_SAFETENSORS` names a published LoRA; a scratch copy
    /// with a rewritten metadata header must still match. Run with `--ignored live_civitai_autov3`.
    #[tokio::test]
    #[ignore]
    async fn live_civitai_autov3_matches_a_header_rewritten_copy() {
        let original =
            PathBuf::from(std::env::var("DEAS_LIVE_SAFETENSORS").expect("DEAS_LIVE_SAFETENSORS"));
        let bytes = std::fs::read(&original).unwrap();
        let length = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
        let mut header: Value = serde_json::from_slice(&bytes[8..8 + length]).unwrap();
        header["__metadata__"] = serde_json::json!({"deas_probe": "rewritten header"});
        let header = serde_json::to_vec(&header).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("probe.safetensors");
        let mut copy = (header.len() as u64).to_le_bytes().to_vec();
        copy.extend(header);
        copy.extend(&bytes[8 + length..]);
        std::fs::write(&file, copy).unwrap();
        assert_ne!(sha256_file(&file).unwrap(), sha256_file(&original).unwrap());
        let c = Catalog::load().unwrap();
        let p = c.providers.iter().find(|p| p.kind == "civitai").unwrap();
        let model = fetch(p, file.clone(), None, false).await.unwrap();
        let civitai = model
            .info
            .unwrap()
            .civitai
            .expect("AutoV3 known to CivitAI");
        assert_eq!(civitai.matched_by, Some(CivitaiMatch::Autov3));
        eprintln!(
            "live AutoV3 match: {} · {} · {:?} (version {})",
            civitai.name, civitai.version, civitai.base, civitai.version_id
        );
    }
}
