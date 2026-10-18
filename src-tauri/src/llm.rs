//! Shared text-only LLM transport. No API keys or secrets are accepted or persisted.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const FILE: &str = "deas-llm.json";
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_INPUT: usize = 128 * 1024;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(120);
const LOCAL_TIMEOUT: Duration = Duration::from_secs(180);
static RUNS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Local,
    Ollama,
    Openai,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmConfig {
    pub provider: Provider,
    pub base_url: String,
}
impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Local,
            base_url: "http://127.0.0.1:11434".into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmRequest {
    pub model: ModelRef,
    pub system: String,
    pub prompt: String,
    pub max_tokens: u32,
    pub temperature: f64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmResult {
    pub text: String,
    pub backend: Provider,
}

fn endpoint(config: &LlmConfig, route: &str) -> Result<reqwest::Url, String> {
    let raw = &config.base_url;
    if raw.len() > 2048
        || raw.trim() != raw
        || raw.chars().any(char::is_control)
        || raw.contains(['?', '#'])
    {
        return Err("LLM base URL must be an HTTP(S) URL without query or fragment".into());
    }
    let mut url = reqwest::Url::parse(raw).map_err(|_| "Invalid LLM base URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("LLM URL must use HTTP(S), without credentials".into());
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url.join(route).map_err(|_| "Invalid LLM endpoint".into())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRef {
    pub id: String,
    pub provider: Provider,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub provider: Provider,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ModelList {
    pub models: Vec<Model>,
    pub warnings: Vec<String>,
}
fn model_id(id: &str, provider: Provider) -> Result<(), String> {
    if id.is_empty() || id.len() > 512 || id.trim() != id || id.chars().any(char::is_control) {
        return Err("Invalid LLM model identifier".into());
    }
    if provider == Provider::Local
        && (id.contains(['\\', ':', '%'])
            || id.split('/').any(|s| {
                s.is_empty() || s == "." || s == ".." || s.trim() != s || s.starts_with('.')
            })
            || !id.to_ascii_lowercase().ends_with(".gguf"))
    {
        return Err("Local LLM identifier must be a relative GGUF name without traversal".into());
    }
    Ok(())
}
fn llm_root(root: &Path) -> Result<std::path::PathBuf, String> {
    let folders = crate::settings::read(root).map_err(|_| "Cannot read model folder settings")?;
    let base = folders
        .models
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("ComfyUI/models"));
    if !base.is_absolute() {
        return Err("Models folder must be absolute".into());
    }
    // The configured root may be an ordinary symlink alias to an external model collection.
    let base = base
        .canonicalize()
        .map_err(|_| "Local models folder is unavailable")?;
    let llm = base.join("llm");
    match std::fs::symlink_metadata(&llm) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => Ok(llm),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(llm),
        _ => Err("Local llm folder must be a non-symlink directory".into()),
    }
}

// Read bounded metadata, never tensors. Unknown/new architectures need a text-family entry here.
fn language_gguf(path: &Path) -> bool {
    use std::io::{BufReader, Read};
    fn number<const N: usize>(r: &mut impl Read) -> std::io::Result<[u8; N]> {
        let mut b = [0; N];
        r.read_exact(&mut b)?;
        Ok(b)
    }
    fn string(r: &mut impl Read) -> std::io::Result<String> {
        let n = u64::from_le_bytes(number(r)?);
        if n > 1024 * 1024 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let mut bytes = vec![0; n as usize];
        r.read_exact(&mut bytes)?;
        String::from_utf8(bytes).map_err(|_| std::io::ErrorKind::InvalidData.into())
    }
    fn skip(r: &mut impl Read, kind: u32, depth: u8) -> std::io::Result<()> {
        let n = match kind {
            0 | 1 | 7 => 1,
            2 | 3 => 2,
            4..=6 => 4,
            10..=12 => 8,
            8 => {
                string(r)?;
                return Ok(());
            }
            9 if depth == 0 => {
                let element = u32::from_le_bytes(number(r)?);
                let count = u64::from_le_bytes(number(r)?);
                if count > 1_000_000 {
                    return Err(std::io::ErrorKind::InvalidData.into());
                }
                for _ in 0..count {
                    skip(r, element, depth + 1)?;
                }
                return Ok(());
            }
            _ => return Err(std::io::ErrorKind::InvalidData.into()),
        };
        let mut bytes = [0; 8];
        r.read_exact(&mut bytes[..n])
    }
    let inspect = || -> std::io::Result<bool> {
        let file = std::fs::File::open(path)?;
        let mut r = BufReader::new(file).take(16 * 1024 * 1024);
        if number::<4>(&mut r)? != *b"GGUF" || !matches!(u32::from_le_bytes(number(&mut r)?), 2 | 3)
        {
            return Ok(false);
        }
        let tensors = u64::from_le_bytes(number(&mut r)?);
        let count = u64::from_le_bytes(number(&mut r)?);
        if tensors == 0 || count > 100_000 {
            return Ok(false);
        }
        let mut arch = String::new();
        let mut kind = String::new();
        for _ in 0..count {
            let key = string(&mut r)?;
            let ty = u32::from_le_bytes(number(&mut r)?);
            if matches!(key.as_str(), "general.architecture" | "general.type") {
                if ty != 8 {
                    return Ok(false);
                }
                let value = string(&mut r)?;
                if key == "general.architecture" {
                    arch = value;
                } else {
                    kind = value;
                }
            } else {
                skip(&mut r, ty, 0)?;
            }
        }
        Ok((kind.is_empty() || kind == "model")
            && matches!(
                arch.as_str(),
                "llama"
                    | "deci"
                    | "falcon"
                    | "baichuan"
                    | "grok"
                    | "gpt2"
                    | "gptj"
                    | "gptneox"
                    | "mpt"
                    | "starcoder"
                    | "starcoder2"
                    | "bloom"
                    | "stablelm"
                    | "qwen"
                    | "qwen2"
                    | "qwen2moe"
                    | "qwen2vl"
                    | "qwen3"
                    | "qwen3vl"
                    | "qwen3vlmoe"
                    | "qwen3moe"
                    | "qwen3next"
                    | "qwen35"
                    | "qwen35moe"
                    | "phi2"
                    | "phi3"
                    | "phimoe"
                    | "gemma"
                    | "gemma2"
                    | "gemma3"
                    | "gemma3n"
                    | "gemma4"
                    | "command-r"
                    | "cohere2"
                    | "dbrx"
                    | "olmo"
                    | "olmo2"
                    | "olmoe"
                    | "openelm"
                    | "deepseek"
                    | "deepseek2"
                    | "deepseek32"
                    | "chatglm"
                    | "glm4"
                    | "glm4moe"
                    | "glm4moelite"
                    | "bitnet"
                    | "t5"
                    | "t5encoder"
                    | "jais"
                    | "nemotron"
                    | "nemotron_h"
                    | "exaone"
                    | "exaone4"
                    | "granite"
                    | "granitemoe"
                    | "granitehybrid"
                    | "internlm2"
                    | "minicpm"
                    | "minicpm3"
                    | "mamba"
                    | "mamba2"
                    | "rwkv6"
                    | "rwkv6qwen2"
                    | "rwkv7"
                    | "arctic"
                    | "gpt-oss"
                    | "hunyuan-moe"
                    | "hunyuan-dense"
                    | "smollm3"
                    | "lfm2"
                    | "lfm2moe"
                    | "minimax-m2"
            ))
    };
    !path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().contains("mmproj"))
        && inspect().unwrap_or(false)
}
fn local_models(root: &Path) -> Result<Vec<Model>, String> {
    let base = llm_root(root)?;
    if !base.exists() {
        return Ok(vec![]);
    }
    fn walk(
        base: &Path,
        dir: &Path,
        depth: usize,
        seen: &mut usize,
        models: &mut Vec<Model>,
    ) -> Result<(), String> {
        if depth > 32 || *seen >= 5000 {
            return Ok(());
        }
        let entries = std::fs::read_dir(dir).map_err(|_| "Cannot scan local llm folder")?;
        for entry in entries {
            if *seen >= 5000 {
                break;
            }
            let entry = entry.map_err(|_| "Cannot scan local llm entry")?;
            *seen += 1;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let ty = entry
                .file_type()
                .map_err(|_| "Cannot inspect local llm entry")?;
            let path = entry.path();
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                walk(base, &path, depth + 1, seen, models)?;
            } else if ty.is_file()
                && path
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("gguf"))
            {
                let Some(relative) = path.strip_prefix(base).ok().and_then(Path::to_str) else {
                    continue;
                };
                let id = relative.replace('\\', "/");
                if model_id(&id, Provider::Local).is_ok() && language_gguf(&path) {
                    models.push(Model {
                        name: id.clone(),
                        id,
                        provider: Provider::Local,
                    });
                }
            }
        }
        Ok(())
    }
    let mut models = vec![];
    walk(&base, &base, 0, &mut 0, &mut models)?;
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}
fn resolve_local(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    model_id(id, Provider::Local)?;
    if !local_models(root)?.iter().any(|m| m.id == id) {
        return Err("Selected local LLM model is no longer available".into());
    }
    let base = llm_root(root)?;
    let path = base.join(id);
    // Recheck every component: a previously scanned directory/file may have changed.
    let mut current = base.clone();
    for segment in id.split('/') {
        current.push(segment);
        if std::fs::symlink_metadata(&current)
            .map_err(|_| "Local model changed")?
            .file_type()
            .is_symlink()
        {
            return Err("Local model symlinks are not allowed".into());
        }
    }
    let actual = path
        .canonicalize()
        .map_err(|_| "Local model is unavailable")?;
    if !actual.starts_with(&base) || !actual.is_file() || !language_gguf(&actual) {
        return Err("Invalid local GGUF model".into());
    }
    Ok(actual)
}
async fn remote_models(config: &LlmConfig) -> Result<Vec<Model>, String> {
    if config.provider == Provider::Local {
        return Ok(vec![]);
    }
    let ollama = config.provider == Provider::Ollama;
    let value = http_json(
        config,
        if ollama { "api/tags" } else { "models" },
        None,
        Duration::from_secs(10),
    )
    .await?;
    let entries = value[if ollama { "models" } else { "data" }]
        .as_array()
        .filter(|v| v.len() <= 5000)
        .ok_or("Invalid LLM model listing")?;
    let mut models = Vec::new();
    for entry in entries {
        let id = entry[if ollama { "name" } else { "id" }]
            .as_str()
            .ok_or("Invalid LLM model identifier")?;
        model_id(id, config.provider)?;
        models.push(Model {
            id: id.into(),
            name: id.into(),
            provider: config.provider,
        });
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}
pub async fn models(root: &Path, config: &LlmConfig) -> Result<ModelList, String> {
    root_guard(root)?;
    validate(config)?;
    let mut result = ModelList {
        models: vec![],
        warnings: vec![],
    };
    match local_models(root) {
        Ok(models) => result.models = models,
        Err(e) => result.warnings.push(e),
    }
    match remote_models(config).await {
        Ok(models) => result.models.extend(models),
        Err(e) => result.warnings.push(e),
    }
    Ok(result)
}
fn validate(config: &LlmConfig) -> Result<(), String> {
    if config.provider != Provider::Local || !config.base_url.is_empty() {
        endpoint(config, "")?;
    }
    Ok(())
}
fn validate_request(request: &LlmRequest) -> Result<(), String> {
    if request.prompt.trim().is_empty()
        || request.prompt.len() + request.system.len() > MAX_INPUT
        || request.prompt.contains('\0')
        || request.system.contains('\0')
    {
        return Err("LLM prompt must be nonempty; system and prompt together must be at most 128 KiB without NUL".into());
    }
    if !(1..=4095).contains(&request.max_tokens)
        || !request.temperature.is_finite()
        || !(0.0..=2.0).contains(&request.temperature)
    {
        return Err("LLM maxTokens must be 1–4095; temperature must be finite in [0, 2]".into());
    }
    model_id(&request.model.id, request.model.provider)?;
    Ok(())
}
fn root_guard(root: &Path) -> Result<crate::downloads::fs::Anchor, String> {
    let anchor = crate::downloads::fs::Anchor::open(root)?;
    anchor.writable()?;
    Ok(anchor)
}
fn target_guard(root: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(root.join(FILE)) {
        Ok(m) => {
            if !m.is_file() || m.file_type().is_symlink() {
                return Err("LLM settings must be a regular non-symlink file".into());
            }
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::fs::MetadataExt;
                if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
                    return Err("LLM settings must be owned and not group/world writable".into());
                }
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot inspect LLM settings".into()),
    }
}
pub fn read(root: &Path) -> Result<LlmConfig, String> {
    let _anchor = root_guard(root)?;
    target_guard(root)?;
    if !root.join(FILE).exists() {
        return Ok(LlmConfig::default());
    }
    let bytes = crate::backend::read_owned(&root.join(FILE), 16 * 1024)?;
    // Only disk reads accept removed fields; the IPC write contract remains strict.
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid LLM settings JSON")?;
    if let Some(object) = value.as_object_mut() {
        for key in ["model", "localModel", "fallback", "nCtx", "nGpuLayers"] {
            object.remove(key);
        }
    }
    let config = serde_json::from_value(value).map_err(|_| "Invalid LLM settings JSON")?;
    validate(&config)?;
    Ok(config)
}
pub fn write(root: &Path, config: LlmConfig) -> Result<LlmConfig, String> {
    let anchor = root_guard(root)?;
    validate(&config)?;
    target_guard(root)?;
    let tmp = format!(".{FILE}.{}", uuid::Uuid::new_v4());
    let mut file = anchor.partial(&tmp)?;
    let result = (|| {
        file.write_all(
            &serde_json::to_vec_pretty(&config).map_err(|_| "Cannot serialize LLM settings")?,
        )
        .map_err(|_| "Cannot write LLM settings")?;
        file.sync_all().map_err(|_| "Cannot sync LLM settings")?;
        target_guard(root)?;
        if crate::downloads::fs::Anchor::open(root)?.identity()? != anchor.identity()? {
            return Err("Environment root changed".into());
        }
        std::fs::rename(root.join(&tmp), root.join(FILE))
            .map_err(|_| "Cannot publish LLM settings")?;
        // shortcut: post-rename directory sync is best effort, not power-loss transactional.
        if let Ok(dir) = std::fs::File::open(root) {
            let _ = dir.sync_all();
        }
        Ok(config)
    })();
    if result.is_err() {
        anchor.remove_partial(&tmp);
    }
    result
}

fn response_text(value: &Value, provider: Provider) -> Result<String, String> {
    if value.get("error").is_some() {
        return Err("LLM server returned a model error".into());
    }
    if provider == Provider::Ollama
        && (value["done"] != true || value["message"]["role"] != "assistant")
    {
        return Err("Invalid Ollama chat response".into());
    }
    if provider == Provider::Openai && value["choices"][0]["message"]["role"] != "assistant" {
        return Err("Invalid OpenAI chat response".into());
    }
    let text = if provider == Provider::Ollama {
        value["message"]["content"].as_str()
    } else {
        value["choices"][0]["message"]["content"].as_str()
    };
    let text = text
        .filter(|t| !t.trim().is_empty() && t.len() <= MAX_RESPONSE && !t.contains('\0'))
        .ok_or("LLM response has no valid text")?;
    Ok(text.to_owned())
}
fn http_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "LLM request timed out"
    } else {
        "LLM server unavailable or transport failed"
    }
    .into()
}
async fn http_json(
    config: &LlmConfig,
    route: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let work = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout)
            .build()
            .map_err(|_| "Cannot create LLM HTTP client")?;
        let url = endpoint(config, route)?;
        let builder = if let Some(body) = body {
            client.post(url).json(&body)
        } else {
            client.get(url)
        };
        let mut response = builder.send().await.map_err(http_error)?;
        if !response.status().is_success() {
            return Err(format!(
                "LLM server returned HTTP {}",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err("LLM response exceeds byte limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("LLM response exceeds byte limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "LLM server returned invalid JSON".into())
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| "LLM request timed out")?
}
async fn remote(
    config: &LlmConfig,
    request: &LlmRequest,
    timeout: Duration,
) -> Result<String, String> {
    let messages = json!([{"role":"system","content":request.system},{"role":"user","content":request.prompt}]);
    let (route, body) = if config.provider == Provider::Ollama {
        (
            "api/chat",
            json!({"model":request.model.id,"messages":messages,"stream":false,"options":{"num_ctx":4096,"num_predict":request.max_tokens,"temperature":request.temperature}}),
        )
    } else {
        (
            "chat/completions",
            json!({"model":request.model.id,"messages":messages,"stream":false,"max_tokens":request.max_tokens,"temperature":request.temperature}),
        )
    };
    response_text(
        &http_json(config, route, Some(body), timeout).await?,
        config.provider,
    )
}
async fn bounded_read(reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "Cannot read local LLM output")?;
    if bytes.len() > limit {
        return Err("Local LLM output exceeds byte limit".into());
    }
    Ok(bytes)
}
fn owned_environment(root: &Path) -> Result<(), String> {
    root_guard(root)?;
    let bytes = crate::backend::read_owned(&root.join("deas-plan.json"), 1024 * 1024)?;
    let plan: crate::install::Plan =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid owned environment plan")?;
    if Path::new(&plan.request.storage_path) != root {
        return Err("Owned environment root does not match plan".into());
    }
    crate::backend::Approved::capture(&plan)?.validate()
}
async fn run_worker(root: &Path, input: Vec<u8>, timeout: Duration) -> Result<String, String> {
    let mut command = tokio::process::Command::new(root.join(crate::install::VENV_PYTHON));
    command
        .args(["-I", "-c", include_str!("llm_worker.py")])
        .current_dir(root)
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start managed local LLM worker")?;
    let mut stdin = child.stdin.take().ok_or("Local LLM stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Local LLM stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Local LLM stderr unavailable")?;
    let work = async {
        let send = async {
            stdin
                .write_all(&input)
                .await
                .map_err(|_| "Cannot send local LLM request".to_string())?;
            drop(stdin);
            Ok::<(), String>(())
        };
        let wait = async {
            child
                .wait()
                .await
                .map_err(|_| "Cannot wait for local LLM worker".to_string())
        };
        let (_, stdout, _, status) = tokio::try_join!(
            send,
            bounded_read(stdout, MAX_RESPONSE),
            bounded_read(stderr, 256 * 1024),
            wait
        )?;
        if !status.success() {
            return Err("Local LLM failed; verify llama-cpp-python, GGUF compatibility and available memory/context".into());
        }
        let value: Value =
            serde_json::from_slice(&stdout).map_err(|_| "Invalid local LLM response")?;
        response_text(
            &json!({"choices":[{"message":{"content":value["text"]}}]}),
            Provider::Local,
        )
    };
    let result = tokio::time::timeout(timeout, work)
        .await
        .unwrap_or_else(|_| Err("Local LLM timed out".into()));
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}
async fn local(root: &Path, request: &LlmRequest) -> Result<String, String> {
    let path = resolve_local(root, &request.model.id)?;
    // Use backend startup's manifest, ownership, interpreter and launch fingerprint guards.
    owned_environment(root)?;
    let input = serde_json::to_vec(&json!({"modelPath":path,"request":request}))
        .map_err(|_| "Cannot encode local LLM request")?;
    run_worker(root, input, LOCAL_TIMEOUT).await
}
pub async fn generate(
    root: &Path,
    config: &LlmConfig,
    request: &LlmRequest,
) -> Result<LlmResult, String> {
    validate(config)?;
    validate_request(request)?;
    root_guard(root)?;
    let _permit = RUNS
        .try_acquire()
        .map_err(|_| "An LLM generation is already running")?;
    let text = if request.model.provider == Provider::Local {
        local(root, request).await?
    } else {
        if request.model.provider != config.provider {
            return Err("Requested LLM provider is not configured".into());
        }
        let models = remote_models(config).await?;
        if !models.iter().any(|m| m.id == request.model.id) {
            return Err("Selected remote LLM model is no longer available".into());
        }
        remote(config, request, REMOTE_TIMEOUT).await?
    };
    Ok(LlmResult {
        text,
        backend: request.model.provider,
    })
}
#[tauri::command]
pub async fn native_llm_models(root: String) -> Result<ModelList, String> {
    let root = std::path::PathBuf::from(root);
    let config = read(&root)?;
    models(&root, &config).await
}
#[tauri::command]
pub fn native_llm_read(root: String) -> Result<LlmConfig, String> {
    read(Path::new(&root))
}
#[tauri::command]
pub fn native_llm_write(
    root: String,
    config: LlmConfig,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<LlmConfig, String> {
    let _guard = operations.enter()?;
    write(Path::new(&root), config)
}
#[tauri::command]
pub async fn native_llm_generate(root: String, request: LlmRequest) -> Result<LlmResult, String> {
    let root = std::path::PathBuf::from(root);
    let config = read(&root)?;
    generate(&root, &config, &request).await
}
/// The node pack's own LLM settings shape, filled from DEAS's saved endpoint; the webview never names a server.
fn forge_settings(config: &LlmConfig) -> Value {
    match config.provider {
        Provider::Local => json!({}),
        Provider::Ollama => json!({ "ollama_url": config.base_url }),
        Provider::Openai => json!({ "openai_url": config.base_url }),
    }
}
fn forge_route(route: &str) -> Result<&'static str, String> {
    Ok(match route {
        "models" => "dasiwa/h3/forge/models",
        "h3" => "dasiwa/h3/forge",
        "write" => "dasiwa/llm/write",
        _ => return Err("Unknown Prompt Forge route".into()),
    })
}
/// Prompt Forge runs in the DaSiWa node pack on the backend (Director Forge and Prompt Writer); this forwards one JSON call.
#[tauri::command]
pub async fn native_forge(
    base_url: String,
    root: String,
    route: String,
    mut body: Value,
) -> Result<Value, String> {
    let path = forge_route(&route)?;
    if !body.is_object() {
        return Err("Invalid Prompt Forge request".into());
    }
    body["settings"] = forge_settings(&read(Path::new(&root))?);
    let url = crate::validate_base_url(&base_url)?
        .join(path)
        .map_err(|_| "Invalid backend URL")?;
    // A local 27B can take minutes to load and write; the node pack's own limit is 600 s.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|_| "Cannot create Prompt Forge HTTP client")?;
    let mut response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Prompt Forge request failed")?;
    let status = response.status();
    let limit = 4 * MAX_RESPONSE;
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Prompt Forge response too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Prompt Forge response failed")?
    {
        if chunk.len() > limit - bytes.len() {
            return Err("Prompt Forge response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    if status.is_success() {
        Ok(value)
    } else {
        Err(format!(
            "{} {}",
            status.as_u16(),
            value["message"].as_str().unwrap_or("")
        )
        .trim()
        .into())
    }
}
#[cfg(test)]
#[path = "llm_tests.rs"]
mod tests;
