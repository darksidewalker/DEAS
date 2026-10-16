//! Installed-model library: scan the ComfyUI models folder and enrich files with CivitAI
//! metadata looked up by SHA-256. Metadata is cached beside the file as `<file>.deas.json`;
//! the model file itself is only ever read.
use super::*;
use serde_json::Value;
use std::path::{Path, PathBuf};

const EXTENSIONS: [&str; 7] = ["safetensors", "sft", "ckpt", "pt", "pth", "gguf", "bin"];
const MAX_MODELS: usize = 5000;
const MAX_DEPTH: usize = 8;
const SIDECAR: &str = ".deas.json";

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
}

fn is_model(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn sidecar(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(SIDECAR);
    PathBuf::from(s)
}

fn read_info(path: &Path) -> Option<ModelInfo> {
    // shortcut: an unreadable sidecar is treated as absent, a refetch overwrites it
    serde_json::from_slice(&std::fs::read(sidecar(path)).ok()?).ok()
}

fn describe(category: &str, base: &Path, path: &Path) -> Result<LocalModel, String> {
    let shown = path
        .to_str()
        .ok_or("Model path is not valid UTF-8")?
        .to_owned();
    let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
    Ok(LocalModel {
        category: category.into(),
        name: path
            .strip_prefix(base)
            .map_err(|_| "Model outside its category folder")?
            .to_string_lossy()
            .replace('\\', "/"),
        size: meta.len(),
        info: read_info(path),
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

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
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

/// Hash the file (reusing the cached hash while the size is unchanged), look it up on
/// CivitAI and persist the result beside the model. 404 is a valid "unknown" answer.
pub async fn fetch(
    p: &Provider,
    path: PathBuf,
    header: Option<HeaderValue>,
) -> Result<LocalModel, String> {
    if p.kind != "civitai" {
        return Err("Metadata lookup needs the CivitAI provider".into());
    }
    if !path.is_absolute() || !path.is_file() || !is_model(&path) {
        return Err("Not an absolute path to a model file".into());
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let sha256 = match read_info(&path).filter(|i| i.size == size) {
        Some(i) => i.sha256,
        None => {
            let p = path.clone();
            tokio::task::spawn_blocking(move || sha256_file(&p))
                .await
                .map_err(|_| "Hashing task failed")??
        }
    };
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
        size,
        fetched_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        civitai,
    };
    let target = sidecar(&path);
    let tmp = target.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&info).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    let base = path.ancestors().skip(1).find(|a| {
        a.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| crate::settings::MODEL_FOLDERS.contains(&n))
    });
    match base {
        Some(base) => describe(base.file_name().unwrap().to_str().unwrap(), base, &path),
        None => describe("", path.parent().unwrap_or(&path), &path),
    }
}

#[tauri::command]
pub fn native_models_scan(root: String) -> Result<Vec<LocalModel>, String> {
    scan(Path::new(&root))
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
    #[test]
    fn scan_lists_models_with_sidecars_and_parses_civitai_shape() {
        let root = tempfile::tempdir().unwrap();
        let loras = root.path().join("loras/Anima");
        std::fs::create_dir_all(&loras).unwrap();
        std::fs::write(loras.join("a.safetensors"), b"model").unwrap();
        std::fs::write(
            loras.join("a.safetensors.deas.json"),
            r#"{"sha256":"ab","size":5,"fetchedAt":1,"civitai":null}"#,
        )
        .unwrap();
        std::fs::write(loras.join(".hidden.safetensors"), b"x").unwrap();
        std::fs::write(loras.join("readme.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.path().join("vae")).unwrap();
        std::fs::write(root.path().join("vae/v.pt"), b"vae").unwrap();
        let models = scan(root.path()).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].category, "loras");
        assert_eq!(models[0].name, "Anima/a.safetensors");
        assert_eq!(models[0].info.as_ref().unwrap().sha256, "ab");
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
    #[cfg(target_os = "linux")]
    #[test]
    fn scan_ignores_oversize_and_linked_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("loras");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("a.pt");
        std::fs::write(&path, b"model").unwrap();
        let json = r#"{"sha256":"ab","size":5,"fetchedAt":1,"civitai":null}"#;
        std::fs::write(sidecar(&path), format!("{json}{}", " ".repeat(128 * 1024))).unwrap();
        assert!(
            scan(root.path()).unwrap()[0].info.is_none(),
            "oversize cache accepted"
        );
        std::fs::remove_file(sidecar(&path)).unwrap();
        let victim = root.path().join("victim");
        std::fs::write(&victim, json).unwrap();
        std::os::unix::fs::symlink(&victim, sidecar(&path)).unwrap();
        assert!(
            scan(root.path()).unwrap()[0].info.is_none(),
            "linked cache accepted"
        );
    }

    #[cfg(target_os = "linux")]
    async fn fetch_fixture(path: &Path, before_reply: impl FnOnce() + Send + 'static) -> Result<LocalModel, String> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut request = vec![];
            while !request.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                stream.read_exact(&mut b).unwrap();
                request.push(b[0]);
            }
            before_reply();
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            String::from_utf8(request).unwrap()
        });
        let p = Provider { id: "fixture".into(), kind: "civitai".into(), label: "Fixture".into(), origin, scopes: vec!["model".into()], anonymous_notice: "".into() };
        let result = fetch(&p, path.to_owned(), None).await;
        let request = server.join().unwrap();
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
            if hard { std::fs::hard_link(&victim, &tmp).unwrap(); }
            else { std::os::unix::fs::symlink(&victim, &tmp).unwrap(); }
            fetch_fixture(&path, || {}).await.unwrap();
            assert_eq!(std::fs::read(&victim).unwrap(), b"keep these bytes");
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
        std::fs::File::options().write(true).open(&replacement).unwrap().set_modified(modified).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(scan(root.path()).unwrap()[0].info.is_none(), "stale replacement metadata shown");
        let refreshed = fetch_fixture(&path, || {}).await.unwrap().info.unwrap();
        assert_ne!(first.sha256, refreshed.sha256);
        assert_eq!(refreshed.sha256, sha256_file(&path).unwrap());
    }

    /// Live CivitAI by-hash acceptance; run with `cargo test -- --ignored live_civitai_by_hash`.
    #[tokio::test]
    #[ignore]
    async fn live_civitai_by_hash_fetches_and_caches_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("probe.safetensors");
        // Bytes of a published public LoRA are not needed: the sidecar supplies the known hash.
        std::fs::write(&file, b"stub").unwrap();
        std::fs::write(
            sidecar(&file),
            r#"{"sha256":"PLACEHOLDER","size":4,"fetchedAt":0,"civitai":null}"#.replace(
                "PLACEHOLDER",
                std::env::var("DEAS_LIVE_SHA256")
                    .expect("DEAS_LIVE_SHA256")
                    .as_str(),
            ),
        )
        .unwrap();
        let c = Catalog::load().unwrap();
        let p = c.providers.iter().find(|p| p.kind == "civitai").unwrap();
        let model = fetch(p, file.clone(), None).await.unwrap();
        let civitai = model.info.unwrap().civitai.expect("hash known to CivitAI");
        assert!(civitai.model_id > 0 && !civitai.name.is_empty());
        assert!(read_info(&file).unwrap().civitai.is_some());
    }
}
