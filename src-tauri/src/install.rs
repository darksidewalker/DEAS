//! Native provisioning. No sidecar, shell, system package manager, reuse or wipe.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const UV_URL: &str =
    "https://github.com/astral-sh/uv/releases/download/0.8.22/uv-x86_64-unknown-linux-gnu.tar.gz";
const UV_SHA: &str = "741ff1f5742c5a4a25d2f829e8395355e43f7a5ae2ebc6368e9ae2df0efb69cf";
const COMFY: &str = "https://github.com/comfyanonymous/ComfyUI.git";
const NODEPACK: &str = "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes.git";
#[path = "install_torch.rs"]
pub(crate) mod torch_profile;
const MAX_LOGS: usize = 300;
const FRAMEWORK_PROBE: &str = r#"import json,sys,os
p=json.loads(sys.argv[2]); h=json.loads(sys.argv[3])
if h: os.environ['CUDA_VISIBLE_DEVICES']=h['uuid']
import torch,torchvision,torchaudio
assert sys.version_info[:2]==(3,12)
assert sys.prefix!=sys.base_prefix
assert os.path.commonpath([sys.base_prefix,sys.argv[1]])==sys.argv[1]
for module,spec in zip([torch,torchvision,torchaudio],p['packages']):
    expected=spec.split('==')[1]
    expected += '+' + p['indexUrl'].rsplit('/',1)[1]
    assert module.__version__==expected, (module.__version__,expected)
assert not torch.version.hip
metadata={'python':sys.version,'basePrefix':sys.base_prefix,'torch':torch.__version__,'torchvision':torchvision.__version__,'torchaudio':torchaudio.__version__,'cuda':torch.version.cuda,'generationReady':False}
if h:
    assert torch.version.cuda==p['cuda']
    assert torch.cuda.is_available(), 'CUDA unavailable; check driver and device access'
    props=torch.cuda.get_device_properties(0)
    assert f'{props.major}.{props.minor}'==h['computeCapability'], 'GPU architecture changed; re-plan'
    if hasattr(props,'uuid'):
        assert str(props.uuid).removeprefix('GPU-').lower()==h['uuid'].removeprefix('GPU-').lower(), 'GPU identity changed; re-plan'
    x=torch.ones((2,2),device='cuda'); y=x@x
    torch.cuda.synchronize()
    assert bool(torch.isfinite(y).all().item() and (y==2).all().item())
    metadata.update(gpu=props.name,uuid=str(getattr(props,'uuid',h['uuid'])),computeCapability=f'{props.major}.{props.minor}',computed=True)
else:
    assert torch.version.cuda is None
    assert (torch.ones(2)+1).tolist()==[2,2]
print(json.dumps(metadata))
"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Cpu,
    Nvidia,
    Amd,
    Intel,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Options {
    pub sage: bool,
    pub radial: bool,
    pub flash: bool,
    pub ffmpeg: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub storage_path: String,
    pub backend: Backend,
    pub features: Vec<String>,
    pub options: Options,
    pub comfy_ref: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub label_key: String,
    pub detail: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub request: Request,
    pub steps: Vec<Step>,
    pub warnings: Vec<String>,
    pub unsupported_options: Vec<String>,
    pub can_execute: bool,
    pub hardware: Option<torch_profile::Hardware>,
    pub torch: Option<torch_profile::Torch>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub step_id: Option<String>,
    pub logs: Vec<String>,
    pub error: Option<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            step_id: None,
            logs: vec![],
            error: None,
        }
    }
}
#[derive(Default)]
pub struct Engine {
    inner: Arc<Mutex<Inner>>,
    pub(crate) backend: crate::backend::Lifecycle,
}
#[derive(Default)]
struct Inner {
    plans: HashMap<String, Plan>,
    approved: Option<crate::backend::Approved>,
    status: Status,
    cancel: Arc<AtomicBool>,
}
fn lock(engine: &Arc<Mutex<Inner>>) -> std::sync::MutexGuard<'_, Inner> {
    engine.lock().unwrap_or_else(|e| e.into_inner())
}
fn log(engine: &Arc<Mutex<Inner>>, text: String) {
    let mut g = lock(engine);
    if g.status.logs.len() >= MAX_LOGS {
        g.status.logs.remove(0);
    }
    g.status.logs.push(text.chars().take(4096).collect());
}

/// Require a new directory directly inside an existing, non-symlink parent.
/// Reject lexical traversal before any filesystem writes, even if it resolves safely.
fn validate_target(input: &str) -> Result<PathBuf, String> {
    let path = Path::new(input);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || input.split(['/', '\\']).any(|s| s == ".." || s == ".")
    {
        return Err("Choose an absolute new directory without traversal".into());
    }
    if path.file_name().is_none() {
        return Err("A filesystem root cannot be an installation target".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Installation paths must not contain symlinks".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && current == path => {}
            Err(e) => return Err(format!("Installation parent must exist: {e}")),
        }
    }
    if path.exists() {
        return Err(
            "Choose a new directory: existing environments are never modified or wiped".into(),
        );
    }
    let parent = path.parent().ok_or("Missing installation parent")?;
    if !parent.is_dir() {
        return Err("Installation parent must be a directory".into());
    }
    Ok(path.to_owned())
}
fn validate_ref(reference: &str) -> Result<(), String> {
    if reference.is_empty()
        || reference.len() > 128
        || reference.starts_with('-')
        || reference.contains("..")
        || !reference
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    {
        return Err("ComfyUI ref must be a branch, tag or commit (for example master); no command options or URLs".into());
    }
    Ok(())
}
fn git_path() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join(if cfg!(windows) { "git.exe" } else { "git" }))
                .find(|p| p.is_file())
        })
        .and_then(|p| std::fs::canonicalize(p).ok())
}
impl Engine {
    pub fn shutdown_backend(&self) {
        self.backend.stop();
    }
    pub(crate) fn backend_start(&self) -> Result<crate::backend::Status, String> {
        let g = lock(&self.inner);
        if g.status.state == "running" {
            return Err("Provisioning is still running".into());
        }
        let approved = g.approved.clone().ok_or(
            "No current successful native provision; existing environments cannot be adopted",
        )?;
        self.backend.start(approved)
    }
    fn plan(&self, mut request: Request) -> Result<Plan, String> {
        validate_target(&request.storage_path)?;
        validate_ref(&request.comfy_ref)?;
        // Director is one selected package: its companion capabilities are included,
        // not independently optional. Persist the complete request before consent.
        if request.features.iter().any(|feature| feature == "director") {
            for included in ["forge", "refmods", "continuity"] {
                if !request.features.iter().any(|feature| feature == included) {
                    request.features.push(included.into());
                }
            }
        }
        let mut unsupported = vec![];
        let mut hardware = None;
        let mut torch = None;
        match request.backend {
            Backend::Cpu => torch = Some(torch_profile::cpu()),
            Backend::Nvidia => match torch_profile::probe() {
                Ok(found) => {
                    match torch_profile::select(&found) {
                        Ok(selected) => torch = Some(selected),
                        Err(error) => unsupported.push(error),
                    }
                    hardware = Some(found);
                }
                Err(error) => unsupported.push(error),
            },
            Backend::Amd | Backend::Intel => {}
        }
        if matches!(request.backend, Backend::Amd | Backend::Intel) {
            unsupported.push(format!(
                "backend:{:?} (GPU provisioning/preflight not ported)",
                request.backend
            ));
        }
        if !(cfg!(target_os = "linux") && cfg!(target_arch = "x86_64")) {
            unsupported.push("platform: only Linux x86_64 CPU/NVIDIA baseline is supported".into());
        }
        for (name, selected) in [
            ("sage", request.options.sage),
            ("radial", request.options.radial),
            ("flash", request.options.flash),
            ("ffmpeg", request.options.ffmpeg),
        ] {
            if selected {
                unsupported.push(name.into());
            }
        }
        for feature in &request.features {
            if !["installer", "director", "forge", "refmods", "continuity"]
                .contains(&feature.as_str())
            {
                unsupported.push(format!("feature:{feature}"));
            }
        }
        let mut warnings=vec!["New environment only. Downloads Python, selected pinned Torch and selected source dependencies; may require several GB. No models, launch, API readiness or generation verification. Failed/cancelled partial directories are retained, never wiped.".into(),"ComfyUI branches/tags and selected nodepack main are fetched at execution time; final Git revisions are recorded. Dependency installation executes upstream package build code inside the managed environment.".into()];
        if git_path().is_none() {
            unsupported
                .push("git: install Git through your OS tools, then create a new plan".into());
        }
        if request
            .features
            .iter()
            .any(|f| ["director", "forge", "refmods", "continuity"].contains(&f.as_str()))
        {
            warnings.push("Selected DaSiWa features select the shared nodepack only; model recipes, weights, workflows and feature readiness are not provisioned.".into());
        }
        let mut steps = vec![];
        for (id,detail) in [("uv","Download official uv 0.8.22 archive and verify embedded SHA-256 before extracting executable"),("python","Install managed Python 3.12 under target/runtime; no system Python or PATH changes"),("comfy","Fetch requested ComfyUI ref into new target/ComfyUI"),("venv","Create isolated target/venv"),("torch","Install torch 2.8.0 / torchvision 0.23.0 / torchaudio 2.8.0 from official CPU wheel index"),("requirements","Install ComfyUI requirements with Torch constraints")] { steps.push(Step{id:id.into(),label_key:format!("installer.steps.{id}"),detail:detail.into()}); }
        if request
            .features
            .iter()
            .any(|f| ["director", "forge", "refmods", "continuity"].contains(&f.as_str()))
        {
            steps.push(Step {
                id: "nodes".into(),
                label_key: "installer.steps.nodes".into(),
                detail: "Fetch DaSiWa nodepack main; install its requirements in managed venv"
                    .into(),
            });
        }
        steps.push(Step{id:"verify".into(),label_key:"installer.steps.verify".into(),detail:"Import exact Torch trio, confirm CPU tensors and ComfyUI main --help; record manifest (not generation readiness)".into()});
        if let Some(selected) = &torch {
            if let Some(step) = steps.iter_mut().find(|s| s.id == "torch") {
                step.detail = format!(
                    "Install {} from {}",
                    selected.packages.join(" / "),
                    selected.index_url
                );
            }
        }
        if matches!(request.backend, Backend::Nvidia) {
            warnings.push("NVIDIA preflight is read-only, bounded to 5 seconds, and supports one visible GPU only. CUDA 13 requires driver >=580; Pascal uses CUDA 12.1. No CUDA toolkit or attention extensions are installed.".into());
            steps.last_mut().unwrap().detail = "Verify exact framework trio, CUDA metadata, planned GPU identity and synchronized CUDA matrix multiplication; ComfyUI main --help (not generation readiness)".into();
        }
        let plan = Plan {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            steps,
            warnings,
            can_execute: unsupported.is_empty(),
            unsupported_options: unsupported,
            hardware,
            torch,
        };
        let mut g = lock(&self.inner);
        if g.plans.len() >= 64 {
            return Err("Plan limit reached; restart app to discard old plans".into());
        }
        g.plans.insert(plan.id.clone(), plan.clone());
        Ok(plan)
    }
    fn start(&self, id: &str, confirmed: bool) -> Result<Status, String> {
        if !confirmed {
            return Err("Explicit confirmation is required".into());
        }
        let mut g = lock(&self.inner);
        if g.status.state == "running" {
            return Err("A native installation is already running".into());
        }
        if self.backend.active() {
            return Err("Stop the owned backend before starting a new provision".into());
        }
        let plan = g
            .plans
            .get(id)
            .ok_or("Unknown or already consumed plan ID")?
            .clone();
        if !plan.can_execute {
            return Err("Plan contains unsupported selections or prerequisites".into());
        }
        validate_target(&plan.request.storage_path)?;
        let git = git_path().ok_or("Git is no longer available; install Git and re-plan")?;
        g.plans.remove(id);
        g.approved = None;
        g.cancel = Arc::new(AtomicBool::new(false));
        g.status = Status {
            state: "running".into(),
            ..Status::default()
        };
        let cancel = g.cancel.clone();
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            let result = provision(&plan, &git, &inner, &cancel).await;
            let result = result.and_then(|()| crate::backend::Approved::capture(&plan));
            let mut g = lock(&inner);
            if !cancel.load(Ordering::SeqCst) {
                if let Ok(approved) = &result {
                    g.approved = Some(approved.clone());
                }
            }
            g.status.state = if cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            }
            .into();
            g.status.error = result.err();
            g.status.step_id = None;
        });
        Ok(g.status.clone())
    }
}
#[tauri::command]
pub fn native_install_plan(
    request: Request,
    engine: tauri::State<'_, Engine>,
) -> Result<Plan, String> {
    engine.plan(request)
}
#[tauri::command]
pub fn native_install_start(
    plan_id: String,
    confirmed: bool,
    engine: tauri::State<'_, Engine>,
) -> Result<Status, String> {
    engine.start(&plan_id, confirmed)
}
#[tauri::command]
pub fn native_install_status(engine: tauri::State<'_, Engine>) -> Status {
    lock(&engine.inner).status.clone()
}
#[tauri::command]
pub fn native_install_cancel(engine: tauri::State<'_, Engine>) -> Status {
    let g = lock(&engine.inner);
    if g.status.state == "running" {
        g.cancel.store(true, Ordering::SeqCst);
    }
    g.status.clone()
}

fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("Cancelled; partial installation retained".into())
    } else {
        Ok(())
    }
}
fn step(inner: &Arc<Mutex<Inner>>, id: &str) {
    lock(inner).status.step_id = Some(id.into());
    log(inner, format!("Step: {id}"));
}
fn isolated(command: &mut Command, root: &Path) {
    // Keep only OS execution essentials. Remove inherited Python/pip/uv, proxies,
    // Git overrides and credentials so user configuration cannot redirect writes.
    let path = std::env::var_os("PATH");
    command.env_clear();
    if let Some(path) = path {
        command.env("PATH", path);
    }
    for name in ["SYSTEMROOT", "WINDIR", "COMSPEC"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    for (key, folder) in [
        ("HOME", "home"),
        ("USERPROFILE", "home"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_CONFIG_HOME", "config"),
        ("UV_CACHE_DIR", "cache/uv"),
        ("UV_PYTHON_INSTALL_DIR", "runtime/python"),
        ("UV_PYTHON_BIN_DIR", "runtime/bin"),
        ("TMPDIR", "tmp"),
        ("TMP", "tmp"),
        ("TEMP", "tmp"),
    ] {
        command.env(key, root.join(folder));
    }
    let constraints = root.join("constraints.txt");
    if constraints.is_file() {
        if let Ok(uri) = reqwest::Url::from_file_path(&constraints) {
            // uv splits bare paths on spaces; an encoded URI propagates safely
            // into child package installers, with final imports still mandatory.
            command.env("UV_CONSTRAINT", uri.as_str());
        }
    }
    command
        .env("UV_NO_CONFIG", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_GLOBAL", root.join("config/empty-gitconfig"));
}
async fn capture<R: AsyncRead + Unpin>(
    mut stream: R,
    inner: Arc<Mutex<Inner>>,
) -> Result<String, String> {
    let mut collected = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        log(&inner, String::from_utf8_lossy(&chunk[..n]).into_owned());
        if collected.len() < 262144 {
            let take = n.min(262144 - collected.len());
            collected.extend_from_slice(&chunk[..take]);
        }
    }
    Ok(String::from_utf8_lossy(&collected).into_owned())
}
async fn run(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    root: &Path,
    inner: &Arc<Mutex<Inner>>,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    cancelled(cancel)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    isolated(&mut command, root);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot run {}: {e}", program.display()))?;
    let pid = child.id();
    let stdout = tokio::spawn(capture(
        child.stdout.take().ok_or("Missing stdout")?,
        inner.clone(),
    ));
    let stderr = tokio::spawn(capture(
        child.stderr.take().ok_or("Missing stderr")?,
        inner.clone(),
    ));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let status = loop {
        if cancel.load(Ordering::SeqCst) || tokio::time::Instant::now() > deadline {
            #[cfg(unix)]
            if let Some(pid) = pid {
                // Only our freshly spawned private process group.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout.abort();
            stderr.abort();
            return Err(if cancel.load(Ordering::SeqCst) {
                "Cancelled; partial installation retained"
            } else {
                "Command timed out after one hour"
            }
            .into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    // A package builder must not leave descendants holding pipes or working
    // after its parent exits. This group was created exclusively by this runner.
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let out = stdout.await.map_err(|e| e.to_string())??;
    let err = stderr.await.map_err(|e| e.to_string())??;
    if !status.success() {
        return Err(format!(
            "{} exited {status}: {}",
            program.display(),
            err.chars().take(2048).collect::<String>()
        ));
    }
    cancelled(cancel)?;
    Ok(out)
}
async fn bootstrap(
    root: &Path,
    inner: &Arc<Mutex<Inner>>,
    cancel: &Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response=tokio::select! {r=client.get(UV_URL).send()=>r.map_err(|e|e.to_string())?, _=wait_cancel(cancel)=>return Err("Cancelled".into())}.error_for_status().map_err(|e|e.to_string())?;
    let mut bytes = vec![];
    loop {
        let chunk = tokio::select! { r=response.chunk()=>r.map_err(|e|e.to_string())?, _=wait_cancel(cancel)=>return Err("Cancelled".into()) };
        let Some(chunk) = chunk else { break };
        if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
            return Err("uv archive exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let uv = extract_verified_uv(&bytes, root)?;
    log(
        inner,
        "uv archive SHA-256 verified against embedded release digest".into(),
    );
    Ok(uv)
}
async fn wait_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
fn extract_verified_uv(bytes: &[u8], root: &Path) -> Result<PathBuf, String> {
    if format!("{:x}", Sha256::digest(bytes)) != UV_SHA {
        return Err("uv archive checksum mismatch; refusing execution".into());
    }
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if entry.path().map_err(|e| e.to_string())?.as_ref()
            != Path::new("uv-x86_64-unknown-linux-gnu/uv")
        {
            continue;
        }
        if !entry.header().entry_type().is_file() || entry.size() > 128 * 1024 * 1024 {
            return Err("Invalid uv archive executable".into());
        }
        let uv = root.join("runtime/uv");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&uv)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        return Ok(uv);
    }
    Err("Official archive did not contain uv".into())
}
async fn checkout(
    git: &Path,
    url: &str,
    reference: &str,
    target: &Path,
    root: &Path,
    inner: &Arc<Mutex<Inner>>,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    std::fs::create_dir(target).map_err(|e| e.to_string())?;
    run(git, &["init", "."], target, root, inner, cancel).await?;
    run(
        git,
        &["remote", "add", "origin", url],
        target,
        root,
        inner,
        cancel,
    )
    .await?;
    run(
        git,
        &["fetch", "--depth", "1", "origin", reference],
        target,
        root,
        inner,
        cancel,
    )
    .await?;
    run(
        git,
        &[
            "-c",
            "advice.detachedHead=false",
            "checkout",
            "--detach",
            "FETCH_HEAD",
        ],
        target,
        root,
        inner,
        cancel,
    )
    .await?;
    Ok(
        run(git, &["rev-parse", "HEAD"], target, root, inner, cancel)
            .await?
            .trim()
            .into(),
    )
}
// uv normally links the venv executable to managed Python. Materialize a regular
// copy so launch never follows an interpreter symlink or escapes this runtime.
fn own_interpreter(root: &Path, python: &Path) -> Result<(), String> {
    let resolved = std::fs::canonicalize(python).map_err(|e| e.to_string())?;
    if !resolved.starts_with(root.join("runtime/python")) {
        return Err("Venv interpreter is not inside the approved managed runtime".into());
    }
    let temporary = python.with_extension("deas-copy");
    let mut source = std::fs::File::open(&resolved).map_err(|e| e.to_string())?;
    let mut destination = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    std::io::copy(&mut source, &mut destination).map_err(|e| e.to_string())?;
    std::fs::set_permissions(
        &temporary,
        std::fs::metadata(&resolved)
            .map_err(|e| e.to_string())?
            .permissions(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, python).map_err(|e| e.to_string())?;
    Ok(())
}
fn prepare_dirs(root: &Path) -> Result<(), String> {
    for folder in ["runtime", "home", "cache", "config", "tmp"] {
        std::fs::create_dir(root.join(folder)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
async fn provision(
    plan: &Plan,
    git: &Path,
    inner: &Arc<Mutex<Inner>>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if let Some(expected) = &plan.hardware {
        let actual = torch_profile::probe()?;
        if actual.uuid != expected.uuid
            || actual.compute_capability != expected.compute_capability
            || actual.driver_version != expected.driver_version
        {
            return Err("NVIDIA_GPU: hardware/driver changed since confirmation; create a new plan (target not touched)".into());
        }
    }
    let root = validate_target(&plan.request.storage_path)?;
    cancelled(cancel)?;
    // Exclusive claim; never accept a target introduced after planning.
    std::fs::create_dir(&root).map_err(|e| format!("Cannot claim new target: {e}"))?;
    prepare_dirs(&root)?;
    std::fs::write(
        root.join("deas-plan.json"),
        serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    step(inner, "uv");
    let uv = bootstrap(&root, inner, cancel).await?;
    step(inner, "python");
    run(
        &uv,
        &["python", "install", "--managed-python", "--no-bin", "3.12"],
        &root,
        &root,
        inner,
        cancel,
    )
    .await?;
    step(inner, "comfy");
    let comfy = root.join("ComfyUI");
    let revision = checkout(
        git,
        COMFY,
        &plan.request.comfy_ref,
        &comfy,
        &root,
        inner,
        cancel,
    )
    .await?;
    step(inner, "venv");
    let venv = root.join("venv");
    run(
        &uv,
        &[
            "venv",
            "--managed-python",
            "--python",
            "3.12",
            venv.to_str().ok_or("Path must be UTF-8")?,
        ],
        &root,
        &root,
        inner,
        cancel,
    )
    .await?;
    let python = venv.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    own_interpreter(&root, &python)?;
    let py = python.to_str().ok_or("Python path must be UTF-8")?;
    let constraint = root.join("constraints.txt");
    let selected = plan.torch.as_ref().ok_or("Missing planned Torch profile")?;
    let wheel_family = selected
        .index_url
        .rsplit('/')
        .next()
        .ok_or("Invalid planned index")?;
    let constraints = selected
        .packages
        .iter()
        .map(|s| format!("{s}+{wheel_family}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&constraint, constraints).map_err(|e| e.to_string())?;
    step(inner, "torch");
    run(
        &uv,
        &[
            "pip",
            "install",
            "--python",
            py,
            "--index-url",
            &selected.index_url,
            &selected.packages[0],
            &selected.packages[1],
            &selected.packages[2],
        ],
        &root,
        &root,
        inner,
        cancel,
    )
    .await?;
    step(inner, "requirements");
    run(
        &uv,
        &[
            "pip",
            "install",
            "--python",
            py,
            "--index",
            &selected.index_url,
            "--constraint",
            constraint.to_str().ok_or("Constraint path must be UTF-8")?,
            "-r",
            "requirements.txt",
        ],
        &comfy,
        &root,
        inner,
        cancel,
    )
    .await?;
    let mut node_revision = None;
    if plan
        .request
        .features
        .iter()
        .any(|f| ["director", "forge", "refmods", "continuity"].contains(&f.as_str()))
    {
        step(inner, "nodes");
        let nodes = comfy.join("custom_nodes");
        if !nodes.exists() {
            std::fs::create_dir(&nodes).map_err(|e| e.to_string())?;
        }
        let node = nodes.join("ComfyUI-DaSiWa-Nodes");
        node_revision = Some(checkout(git, NODEPACK, "main", &node, &root, inner, cancel).await?);
        if node.join("requirements.txt").is_file() {
            run(
                &uv,
                &[
                    "pip",
                    "install",
                    "--python",
                    py,
                    "--index",
                    &selected.index_url,
                    "--constraint",
                    constraint.to_str().ok_or("Invalid constraint path")?,
                    "-r",
                    "requirements.txt",
                ],
                &node,
                &root,
                inner,
                cancel,
            )
            .await?;
        }
    }
    step(inner, "verify");
    let profile_json = serde_json::to_string(selected).map_err(|e| e.to_string())?;
    let hardware_json = serde_json::to_string(&plan.hardware).map_err(|e| e.to_string())?;
    let versions = run(
        &python,
        &[
            "-I",
            "-c",
            FRAMEWORK_PROBE,
            root.join("runtime/python")
                .to_str()
                .ok_or("Managed Python path must be UTF-8")?,
            &profile_json,
            &hardware_json,
        ],
        &comfy,
        &root,
        inner,
        cancel,
    )
    .await?;
    run(
        &python,
        if selected.cuda.is_some() {
            &["main.py", "--cuda-device", "0", "--help"]
        } else {
            &["main.py", "--cpu", "--help"]
        },
        &comfy,
        &root,
        inner,
        cancel,
    )
    .await?;
    cancelled(cancel)?;
    let manifest = serde_json::json!({"planId":plan.id,"comfyRevision":revision,"nodepackRevision":node_revision,"backend":plan.request.backend,"hardware":plan.hardware,"torchProfile":selected,"python":py,"versions":versions.trim(),"generationReady":false});
    std::fs::write(
        root.join("deas-install.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    log(inner,"Provisioning checks succeeded; backend is not launched and generation readiness is not verified".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch() -> tempfile::TempDir {
        let base = std::env::var_os("TMPDIR").expect("Set TMPDIR to Hermes scratch");
        tempfile::tempdir_in(base).unwrap()
    }
    fn request(root: &Path) -> Request {
        Request {
            storage_path: root.join("new").to_str().unwrap().into(),
            backend: Backend::Cpu,
            features: vec!["installer".into()],
            options: Options::default(),
            comfy_ref: "master".into(),
        }
    }
    #[test]
    fn managed_interpreter_is_copied_not_external_or_symlinked() {
        let tmp = scratch();
        std::fs::create_dir_all(tmp.path().join("runtime/python")).unwrap();
        std::fs::create_dir_all(tmp.path().join("venv/bin")).unwrap();
        let managed = tmp.path().join("runtime/python/python");
        std::fs::write(&managed, "owned interpreter").unwrap();
        let py = tmp.path().join("venv/bin/python");
        std::os::unix::fs::symlink(&managed, &py).unwrap();
        own_interpreter(tmp.path(), &py).unwrap();
        assert!(!std::fs::symlink_metadata(&py)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&py).unwrap(), "owned interpreter");
        std::fs::remove_file(&py).unwrap();
        std::os::unix::fs::symlink("/usr/bin/python3", &py).unwrap();
        assert!(own_interpreter(tmp.path(), &py).is_err());
    }
    #[test]
    fn backend_requires_current_successful_provision() {
        let engine = Engine::default();
        assert!(engine.backend_start().unwrap_err().contains("successful"));
    }
    #[test]
    fn prepared_plan_or_success_label_does_not_authorize_backend() {
        let tmp = scratch();
        let engine = Engine::default();
        let plan = engine.plan(request(tmp.path())).unwrap();
        assert!(plan.can_execute);
        assert!(engine.backend_start().is_err());
        lock(&engine.inner).status.state = "succeeded".into();
        assert!(engine.backend_start().is_err());
        lock(&engine.inner).status.state = "failed".into();
        assert!(engine.backend_start().is_err());
        assert!(!tmp.path().join("new").exists());
    }
    #[test]
    fn safe_read_only_plans_and_confirmation() {
        let tmp = scratch();
        let engine = Engine::default();
        let r = request(tmp.path());
        let plan = engine.plan(r.clone()).unwrap();
        assert!(!Path::new(&r.storage_path).exists());
        assert!(engine.start(&plan.id, false).is_err());
        let mut changed = r;
        changed.options.sage = true;
        let blocked = engine.plan(changed).unwrap();
        assert!(!blocked.can_execute);
        assert!(engine.start(&blocked.id, true).is_err());
        assert!(
            !lock(&engine.inner)
                .plans
                .get(&plan.id)
                .unwrap()
                .request
                .options
                .sage
        );
        std::fs::create_dir(tmp.path().join("new")).unwrap();
        assert!(engine.start(&plan.id, true).is_err());
    }
    #[test]
    fn rejects_unsafe_paths_refs_and_binary() {
        let tmp = scratch();
        assert!(validate_target("/").is_err());
        assert!(validate_target(&format!("{}/../escape", tmp.path().display())).is_err());
        assert!(validate_ref("--upload-pack=evil").is_err());
        assert!(extract_verified_uv(b"unverified", tmp.path())
            .unwrap_err()
            .contains("checksum"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(tmp.path(), tmp.path().join("link")).unwrap();
            assert!(validate_target(tmp.path().join("link/new").to_str().unwrap()).is_err());
        }
    }
    #[tokio::test]
    async fn real_git_runner_and_checkout_in_scratch() {
        let tmp = scratch();
        prepare_dirs(tmp.path()).unwrap();
        let source = tmp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let git = git_path().expect("Git prerequisite");
        let inner = Arc::new(Mutex::new(Inner::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        run(&git, &["init", "."], &source, tmp.path(), &inner, &cancel)
            .await
            .unwrap();
        std::fs::write(source.join("fixture.txt"), "real fixture").unwrap();
        run(
            &git,
            &["add", "fixture.txt"],
            &source,
            tmp.path(),
            &inner,
            &cancel,
        )
        .await
        .unwrap();
        run(
            &git,
            &[
                "-c",
                "user.name=DEAS test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
            &source,
            tmp.path(),
            &inner,
            &cancel,
        )
        .await
        .unwrap();
        let rev = checkout(
            &git,
            source.to_str().unwrap(),
            "HEAD",
            &tmp.path().join("checkout"),
            tmp.path(),
            &inner,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(rev.len(), 40);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("checkout/fixture.txt")).unwrap(),
            "real fixture"
        );
        cancel.store(true, Ordering::SeqCst);
        assert!(run(&git, &["status"], &source, tmp.path(), &inner, &cancel)
            .await
            .unwrap_err()
            .contains("Cancelled"));
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn real_runner_cancels_and_reaps_owned_process() {
        let tmp = scratch();
        prepare_dirs(tmp.path()).unwrap();
        let inner = Arc::new(Mutex::new(Inner::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            signal.store(true, Ordering::SeqCst);
        });
        let start = std::time::Instant::now();
        let result = run(
            Path::new("/usr/bin/sleep"),
            &["30"],
            tmp.path(),
            tmp.path(),
            &inner,
            &cancel,
        )
        .await;
        assert!(result.unwrap_err().contains("Cancelled"));
        assert!(start.elapsed() < Duration::from_secs(3));
        for _ in 0..400 {
            log(&inner, "bounded".repeat(1000));
        }
        assert_eq!(lock(&inner).status.logs.len(), MAX_LOGS);
        assert!(lock(&inner)
            .status
            .logs
            .iter()
            .all(|line| line.len() <= 4096));
    }

    #[test]
    fn every_unsupported_selection_blocks_execution() {
        let tmp = scratch();
        for backend in [Backend::Amd, Backend::Intel] {
            let engine = Engine::default();
            let mut request = request(tmp.path());
            request.backend = backend;
            let plan = engine.plan(request).unwrap();
            assert!(!plan.can_execute);
            assert!(engine.start(&plan.id, true).is_err());
        }
        for option in ["sage", "radial", "flash", "ffmpeg", "unknown-feature"] {
            let engine = Engine::default();
            let mut request = request(tmp.path());
            match option {
                "sage" => request.options.sage = true,
                "radial" => request.options.radial = true,
                "flash" => request.options.flash = true,
                "ffmpeg" => request.options.ffmpeg = true,
                _ => request.features.push(option.into()),
            }
            assert!(!engine.plan(request).unwrap().can_execute);
        }
        assert!(!tmp.path().join("new").exists());
    }

    #[test]
    fn managed_constraints_use_encoded_uri_and_no_inherited_configuration() {
        let tmp = scratch();
        let root = tmp.path().join("path with spaces");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("constraints.txt"), "torch==2.14.1+cu130\n").unwrap();
        let mut command = Command::new("python");
        isolated(&mut command, &root);
        let env: HashMap<_, _> = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|v| {
                    (
                        key.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert!(env["UV_CONSTRAINT"].starts_with("file://"));
        assert!(env["UV_CONSTRAINT"].contains("path%20with%20spaces"));
        assert_eq!(env["HOME"], root.join("home").to_string_lossy());
        assert!(!env.contains_key("PYTHONPATH"));
        assert!(!env.contains_key("CUDA_VISIBLE_DEVICES"));
        assert!(!env.contains_key("PIP_INDEX_URL"));
    }

    #[test]
    fn director_plan_includes_companions_without_writes() {
        let tmp = scratch();
        let engine = Engine::default();
        let mut r = request(tmp.path());
        r.features = vec!["director".into()];
        let plan = engine.plan(r).unwrap();
        assert_eq!(
            plan.request.features,
            ["director", "forge", "refmods", "continuity"]
        );
        assert_eq!(plan.steps.iter().filter(|s| s.id == "nodes").count(), 1);
        assert!(!Path::new(&plan.request.storage_path).exists());
        assert_eq!(
            lock(&engine.inner).plans[&plan.id].request.features,
            plan.request.features
        );
    }

    #[test]
    fn all_selected_features_share_one_main_nodepack_and_keep_request() {
        let tmp = scratch();
        let engine = Engine::default();
        let mut r = request(tmp.path());
        r.features = vec![
            "director".into(),
            "forge".into(),
            "refmods".into(),
            "continuity".into(),
        ];
        let original = serde_json::to_value(&r).unwrap();
        let plan = engine.plan(r).unwrap();
        assert!(plan.can_execute);
        assert_eq!(serde_json::to_value(&plan.request).unwrap(), original);
        assert_eq!(plan.steps.iter().filter(|s| s.id == "nodes").count(), 1);
        assert!(plan
            .steps
            .iter()
            .find(|s| s.id == "nodes")
            .unwrap()
            .detail
            .contains("main"));
        assert!(!Path::new(&plan.request.storage_path).exists());
        assert_eq!(
            plan.torch.unwrap().index_url,
            "https://download.pytorch.org/whl/cpu"
        );
    }

    #[test]
    #[ignore = "Read-only live NVIDIA immutable plan; no installation"]
    fn live_nvidia_plan() {
        let tmp = scratch();
        let engine = Engine::default();
        let mut r = request(tmp.path());
        r.backend = Backend::Nvidia;
        r.features = vec![
            "director".into(),
            "forge".into(),
            "refmods".into(),
            "continuity".into(),
        ];
        let original = serde_json::to_value(&r).unwrap();
        let plan = engine.plan(r).unwrap();
        assert!(plan.can_execute, "{:?}", plan.unsupported_options);
        assert_eq!(serde_json::to_value(&plan.request).unwrap(), original);
        assert_eq!(plan.steps.iter().filter(|s| s.id == "nodes").count(), 1);
        assert!(plan.hardware.is_some());
        println!("{}", serde_json::to_string(&plan).unwrap());
        assert!(!Path::new(&plan.request.storage_path).exists());
        assert!(engine.start(&plan.id, false).is_err());
    }

    /// Explicit network smoke only: no Torch, models or user target touched.
    #[tokio::test]
    #[ignore = "Downloads checksum-verified uv and isolated Python; run explicitly"]
    async fn real_uv_isolated_minimal_package() {
        let tmp = scratch();
        prepare_dirs(tmp.path()).unwrap();
        let inner = Arc::new(Mutex::new(Inner::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        let uv = bootstrap(tmp.path(), &inner, &cancel).await.unwrap();
        run(
            &uv,
            &["python", "install", "--managed-python", "--no-bin", "3.12"],
            tmp.path(),
            tmp.path(),
            &inner,
            &cancel,
        )
        .await
        .unwrap();
        let venv = tmp.path().join("venv");
        run(
            &uv,
            &[
                "venv",
                "--managed-python",
                "--python",
                "3.12",
                venv.to_str().unwrap(),
            ],
            tmp.path(),
            tmp.path(),
            &inner,
            &cancel,
        )
        .await
        .unwrap();
        let python = venv.join("bin/python");
        own_interpreter(tmp.path(), &python).unwrap();
        assert!(!std::fs::symlink_metadata(&python)
            .unwrap()
            .file_type()
            .is_symlink());
        run(
            &uv,
            &[
                "pip",
                "install",
                "--python",
                python.to_str().unwrap(),
                "packaging==25.0",
            ],
            tmp.path(),
            tmp.path(),
            &inner,
            &cancel,
        )
        .await
        .unwrap();
        let output=run(&python,&["-I","-c","import packaging,sys,os;assert packaging.__version__=='25.0';assert sys.prefix!=sys.base_prefix;assert sys.version_info[:2]==(3,12);assert os.path.commonpath([sys.base_prefix,sys.argv[1]])==sys.argv[1];print(sys.prefix)",tmp.path().join("runtime/python").to_str().unwrap()],tmp.path(),tmp.path(),&inner,&cancel).await.unwrap();
        assert!(output.contains(venv.to_str().unwrap()));
        assert!(tmp.path().join("runtime/python").is_dir());
        // Real managed uv/Python + local API fixture, not a full Comfy/Torch install.
        #[cfg(target_os = "linux")]
        {
            std::fs::create_dir(tmp.path().join("ComfyUI")).unwrap();
            std::fs::write(
                tmp.path().join("ComfyUI/main.py"),
                crate::backend::tests::SERVER,
            )
            .unwrap();
            let mut r = request(tmp.path());
            r.storage_path = tmp.path().to_str().unwrap().into();
            let plan = Plan {
                id: uuid::Uuid::new_v4().to_string(),
                request: r,
                steps: vec![],
                warnings: vec![],
                unsupported_options: vec![],
                can_execute: true,
                hardware: None,
                torch: Some(torch_profile::cpu()),
            };
            std::fs::write(
                tmp.path().join("deas-plan.json"),
                serde_json::to_vec(&plan).unwrap(),
            )
            .unwrap();
            std::fs::write(tmp.path().join("deas-install.json"), serde_json::to_vec(&serde_json::json!({"planId":plan.id,"backend":"cpu","hardware":null,"torchProfile":plan.torch,"python":python,"generationReady":false})).unwrap()).unwrap();
            let engine = Engine::default();
            lock(&engine.inner).approved = Some(crate::backend::Approved::capture(&plan).unwrap());
            assert_eq!(engine.backend_start().unwrap().state, "starting");
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let status = engine.backend.status();
                if status.state == "running" {
                    assert!(!status.generation_ready);
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "{status:?}");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            engine.shutdown_backend();
            assert_eq!(engine.backend.status().state, "stopped");
        }
    }
}
