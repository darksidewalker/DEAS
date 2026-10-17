//! Explicit lifecycle for the current app-owned, successfully provisioned environment.
//! Linux and Windows, matching native provisioning. No target/PID/URL IPC inputs.
use crate::install::{Backend, Plan, VENV_BIN, VENV_PYTHON};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub endpoint: Option<String>,
    pub error: Option<String>,
    pub generation_ready: bool,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            state: "stopped".into(),
            endpoint: None,
            error: None,
            generation_ready: false,
        }
    }
}

/// Captured after native provisioning or explicit validated existing-environment approval.
#[derive(Clone)]
pub(crate) struct Approved {
    plan: Plan,
    files: Vec<(PathBuf, Vec<u8>)>,
    fingerprints: Vec<(PathBuf, [u8; 32])>,
    identities: Vec<(PathBuf, (u64, u64, u32))>,
}
fn safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Owned path must be absolute".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err("Owned path contains traversal".into());
        }
        current.push(component);
        let meta =
            fs::symlink_metadata(&current).map_err(|e| format!("Owned path missing: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err("Owned paths must not contain symlinks".into());
        }
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn identity(path: &Path) -> Result<(u64, u64, u32), String> {
    use std::os::unix::fs::MetadataExt;
    safe_path(path)?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
        return Err(
            "Owned environment must be owned by this user and not group/world writable".into(),
        );
    }
    Ok((meta.dev(), meta.ino(), meta.uid()))
}
// Windows: handle identity only; ownership is ACL-based and the environment root was
// created by this app, so the uid slot is always 0.
#[cfg(windows)]
fn identity(path: &Path) -> Result<(u64, u64, u32), String> {
    safe_path(path)?;
    let (volume, index) = crate::win::identity(&crate::win::open_no_follow(path)?)?;
    Ok((volume, index, 0))
}
#[cfg(not(any(target_os = "linux", windows)))]
fn identity(_: &Path) -> Result<(u64, u64, u32), String> {
    Err("Owned lifecycle supports Linux and Windows only".into())
}
pub(crate) fn read_owned(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    safe_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("Owned file is not regular or exceeds size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Owned file exceeds size limit".into());
    }
    Ok(bytes)
}
impl Approved {
    pub(crate) fn plan(&self) -> &Plan {
        &self.plan
    }
    pub(crate) fn capture(plan: &Plan) -> Result<Self, String> {
        let root = Path::new(&plan.request.storage_path);
        let expected = serde_json::to_value(plan).map_err(|e| e.to_string())?;
        let plan_bytes = read_owned(&root.join("deas-plan.json"), 1024 * 1024)?;
        if serde_json::from_slice::<serde_json::Value>(&plan_bytes).map_err(|e| e.to_string())?
            != expected
        {
            return Err("Owned plan manifest does not match approved plan".into());
        }
        let install_bytes = read_owned(&root.join("deas-install.json"), 1024 * 1024)?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&install_bytes).map_err(|e| e.to_string())?;
        if manifest["planId"] != plan.id
            || manifest["python"]
                != root
                    .join(VENV_PYTHON)
                    .to_str()
                    .ok_or("Invalid Python path")?
            || manifest["backend"] != expected["request"]["backend"]
            || manifest["hardware"] != expected["hardware"]
            || manifest["torchProfile"] != expected["torch"]
            || manifest["generationReady"] != false
        {
            return Err("Owned install manifest does not match approved plan".into());
        }
        let mut identities = vec![];
        for name in [
            "",
            "ComfyUI",
            "ComfyUI/main.py",
            "venv",
            VENV_BIN,
            VENV_PYTHON,
            "venv/pyvenv.cfg",
            "runtime",
            "runtime/python",
            "home",
            "cache",
            "config",
            "tmp",
            "deas-plan.json",
            "deas-install.json",
        ] {
            let path = root.join(name);
            identities.push((path.clone(), identity(&path)?));
        }
        if !root.join(VENV_PYTHON).is_file() || !root.join("ComfyUI/main.py").is_file() {
            return Err("Owned executable/main.py must be regular files".into());
        }
        let mut fingerprints = vec![];
        for name in ["ComfyUI/main.py", VENV_PYTHON, "venv/pyvenv.cfg"] {
            let path = root.join(name);
            fingerprints.push((
                path.clone(),
                Sha256::digest(read_owned(&path, 128 * 1024 * 1024)?).into(),
            ));
        }
        let approved = Self {
            plan: plan.clone(),
            files: vec![
                (root.join("deas-plan.json"), plan_bytes),
                (root.join("deas-install.json"), install_bytes),
            ],
            identities,
            fingerprints,
        };
        approved.validate()?;
        Ok(approved)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !self.plan.can_execute
            || !matches!(self.plan.request.backend, Backend::Cpu | Backend::Nvidia)
        {
            return Err("Approved backend is not executable".into());
        }
        for (path, expected) in &self.identities {
            if identity(path)? != *expected {
                return Err("Owned environment identity changed; re-provision required".into());
            }
        }
        for (path, expected) in &self.files {
            let actual = read_owned(path, 1024 * 1024)?;
            if Sha256::digest(&actual) != Sha256::digest(expected) {
                return Err("Owned manifest changed; refusing launch".into());
            }
        }
        for (path, expected) in &self.fingerprints {
            let actual: [u8; 32] = Sha256::digest(read_owned(path, 128 * 1024 * 1024)?).into();
            if actual != *expected {
                return Err("Owned launch file changed; refusing launch".into());
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Inner {
    status: Status,
    child: Option<Child>,
    environment_lock: Option<fs::File>,
    #[cfg(windows)]
    job: Option<crate::win::Job>,
    serial: u64,
    port: u16,
}
#[derive(Default)]
pub struct Lifecycle {
    inner: Arc<Mutex<Inner>>,
}
fn locked(inner: &Arc<Mutex<Inner>>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|e| e.into_inner())
}
pub(crate) const MAX_LOG_LINE: u64 = 64 * 1024;
/// Child output as display text: ANSI escapes and control characters removed,
/// a carriage return overwrites the line like a terminal (progress bars).
pub(crate) fn clean_log_line(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end_matches(['\r', '\n']);
    let text = text.rsplit('\r').next().unwrap_or_default();
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                // CSI: parameters until a final byte in @..=~
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC: until BEL or ESC \\
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' || (n == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out.trim_end().to_string()
}
fn log(text: &str) {
    crate::logs::push(crate::logs::Source::Deas, text);
}
// Keep the leader unreaped until its private group is killed: no PID/group reuse window.
#[cfg(target_os = "linux")]
fn exited(child: &Child) -> Result<bool, String> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(format!(
            "Owned child wait failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { info.si_pid() } != 0)
}
#[cfg(windows)]
fn exited(child: &Child) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle;
    crate::win::exited(child.as_raw_handle())
}
#[cfg(not(any(target_os = "linux", windows)))]
fn exited(_: &Child) -> Result<bool, String> {
    Err("Unsupported platform".into())
}
fn lock_environment(root: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(0)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(root.join("deas-install.json")).map_err(|_| {
        "Environment is unavailable or already in use by another DEAS instance".to_string()
    })?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Environment is already running in another DEAS instance; no duplicate backend was started".into());
        }
    }
    Ok(file)
}
fn terminate(inner: &mut Inner) {
    if let Some(mut child) = inner.child.take() {
        #[cfg(target_os = "linux")]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        if let Some(job) = inner.job.take() {
            job.kill();
        }
        let _ = child.kill();
        match child.wait() {
            Ok(status) => log(&format!("Owned child exited: {status}")),
            Err(error) => log(&format!("Owned child reap failed: {error}")),
        }
    }
    inner.environment_lock = None;
    inner.status.endpoint = None;
}
fn fail(inner: &mut Inner, error: String) {
    terminate(inner);
    inner.status.state = "failed".into();
    log(&error);
    inner.status.error = Some(error);
}
// Require the listening socket to belong to the exact unreaped child, not just
// a successful response on a raced ephemeral port. Do not adopt any other PID.
#[cfg(target_os = "linux")]
fn owns_listener(child: &Child, port: u16) -> Result<bool, String> {
    let table = fs::read_to_string("/proc/net/tcp").map_err(|e| e.to_string())?;
    let address = format!("0100007F:{port:04X}");
    let inodes: Vec<&str> = table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() > 9 && fields[1] == address && fields[3] == "0A" {
                Some(fields[9])
            } else {
                None
            }
        })
        .collect();
    if inodes.len() != 1 {
        return Ok(false);
    }
    for entry in fs::read_dir(format!("/proc/{}/fd", child.id())).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Ok(target) = fs::read_link(entry.path()) {
            if inodes
                .iter()
                .any(|inode| target == Path::new(&format!("socket:[{inode}]")))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
#[cfg(windows)]
fn owns_listener(child: &Child, port: u16) -> Result<bool, String> {
    let loopback: Vec<u32> = crate::win::listeners(port)?
        .into_iter()
        .filter(|(addr, _)| *addr == Some(crate::win::LOOPBACK_V4))
        .map(|(_, pid)| pid)
        .collect();
    Ok(loopback == [child.id()])
}
#[cfg(not(any(target_os = "linux", windows)))]
fn owns_listener(_: &Child, _: u16) -> Result<bool, String> {
    Err("Unsupported platform".into())
}
#[cfg(windows)]
fn port_has_listener(port: u16) -> bool {
    crate::win::listeners(port).is_ok_and(|rows| !rows.is_empty())
}
#[cfg(not(windows))]
fn port_has_listener(port: u16) -> bool {
    ["/proc/net/tcp", "/proc/net/tcp6"].iter().any(|path| {
        fs::read_to_string(path).is_ok_and(|table| {
            table.lines().skip(1).any(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                fields.len() > 3
                    && fields[3] == "0A"
                    && fields[1].ends_with(&format!(":{port:04X}"))
            })
        })
    })
}
impl Lifecycle {
    pub(crate) fn active(&self) -> bool {
        locked(&self.inner).child.is_some()
    }
    pub(crate) fn start(&self, approved: Approved) -> Result<Status, String> {
        approved.validate()?;
        if let Some(expected) = &approved.plan.hardware {
            let actual = crate::install::torch_profile::probe()?;
            if actual.uuid != expected.uuid
                || actual.compute_capability != expected.compute_capability
                || actual.driver_version != expected.driver_version
            {
                return Err("NVIDIA hardware/driver changed; re-provision required".into());
            }
        }
        self.launch(approved, Duration::from_secs(120))
    }
    fn launch(&self, approved: Approved, timeout: Duration) -> Result<Status, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        self.spawn_reserved(approved, timeout, port, Some(listener))
    }
    #[cfg(all(test, target_os = "linux"))]
    fn launch_port(
        &self,
        approved: Approved,
        timeout: Duration,
        port: u16,
    ) -> Result<Status, String> {
        self.spawn_reserved(approved, timeout, port, None)
    }
    fn spawn_reserved(
        &self,
        approved: Approved,
        timeout: Duration,
        port: u16,
        listener: Option<std::net::TcpListener>,
    ) -> Result<Status, String> {
        let mut inner = locked(&self.inner);
        if inner.child.is_some() {
            return Err("An owned backend is already starting or running".into());
        }
        approved.validate()?;
        let root = Path::new(&approved.plan.request.storage_path);
        let environment_lock = lock_environment(root)?;
        let mut command = Command::new(root.join(VENV_PYTHON));
        command.args([
            "-u",
            "main.py",
            "--listen",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--disable-auto-launch",
        ]);
        match approved.plan.request.backend {
            Backend::Cpu => {
                command.arg("--cpu");
            }
            Backend::Nvidia => {
                command.args(["--cuda-device", "0"]);
            }
            _ => return Err("Unsupported backend".into()),
        }
        command.args(crate::settings::backend_args(root)?);
        command.args(crate::startup::args(root, Some(&approved.plan))?);
        command
            .env_clear()
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1");
        #[cfg(windows)]
        {
            // Python refuses to start without SYSTEMROOT; System32 supplies only OS DLLs.
            let system_root = std::env::var_os("SYSTEMROOT").unwrap_or_default();
            command.env("PATH", Path::new(&system_root).join("System32"));
            for name in ["SYSTEMROOT", "WINDIR", "COMSPEC"] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
        }
        #[cfg(not(windows))]
        command.env("PATH", "/usr/bin:/bin");
        for (name, folder) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("XDG_CACHE_HOME", "cache"),
            ("LOCALAPPDATA", "cache"),
            ("XDG_CONFIG_HOME", "config"),
            ("APPDATA", "config"),
            ("TMPDIR", "tmp"),
            ("TMP", "tmp"),
            ("TEMP", "tmp"),
        ] {
            command.env(name, root.join(folder));
        }
        if let Some(hardware) = &approved.plan.hardware {
            command.env("CUDA_VISIBLE_DEVICES", &hardware.uuid);
        }
        command
            .current_dir(root.join("ComfyUI"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(crate::win::CREATE_NO_WINDOW);
        }
        // One reservation, one spawn. A bind race fails ownership/readiness; never retry/adopt.
        drop(listener);
        let mut child = command.spawn().map_err(|e| {
            inner.status = Status {
                state: "failed".into(),
                error: Some(format!("Owned backend spawn failed: {e}")),
                ..Status::default()
            };
            inner.status.error.clone().unwrap()
        })?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let job = crate::win::Job::new()
                .and_then(|job| job.assign(child.as_raw_handle()).map(|_| job));
            match job {
                Ok(job) => inner.job = Some(job),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    inner.status = Status {
                        state: "failed".into(),
                        error: Some(error.clone()),
                        ..Status::default()
                    };
                    return Err(error);
                }
            }
        }
        inner.environment_lock = Some(environment_lock);
        inner.serial += 1;
        let serial = inner.serial;
        inner.port = port;
        inner.status = Status {
            state: "starting".into(),
            ..Status::default()
        };
        log(&format!(
            "Starting owned backend on 127.0.0.1:{port}; API readiness only"
        ));
        let stdout = child.stdout.take().ok_or("Missing owned stdout")?;
        let stderr = child.stderr.take().ok_or("Missing owned stderr")?;
        inner.child = Some(child);
        let initial = inner.status.clone();
        drop(inner);
        capture(stdout, self.inner.clone(), serial);
        capture(stderr, self.inner.clone(), serial);
        let state = self.inner.clone();
        std::thread::spawn(move || supervise(state, serial, port, timeout));
        Ok(initial)
    }
    pub fn status(&self) -> Status {
        let mut inner = locked(&self.inner);
        if let Some(child) = &inner.child {
            match exited(child) {
                Ok(true) => fail(&mut inner, "Owned backend exited".into()),
                Err(error) => fail(&mut inner, error),
                Ok(false) => {
                    if inner.status.state == "running"
                        && !owns_listener(child, inner.port).unwrap_or(false)
                    {
                        fail(
                            &mut inner,
                            "Owned backend lost its loopback listener".into(),
                        );
                    }
                }
            }
        }
        inner.status.clone()
    }
    pub fn stop(&self) -> Status {
        let mut inner = locked(&self.inner);
        inner.serial += 1;
        terminate(&mut inner);
        inner.status.state = "stopped".into();
        inner.status.error = None;
        inner.status.clone()
    }
}
impl Drop for Lifecycle {
    fn drop(&mut self) {
        self.stop();
    }
}
fn capture<R: std::io::Read + Send + 'static>(reader: R, inner: Arc<Mutex<Inner>>, serial: u64) {
    std::thread::spawn(move || {
        use std::io::{BufRead, Read};
        let mut reader = std::io::BufReader::new(reader);
        let mut line = Vec::new();
        loop {
            line.clear();
            // Whole lines keep UTF-8 sequences intact; the cap bounds output without newlines.
            match (&mut reader)
                .take(MAX_LOG_LINE)
                .read_until(b'\n', &mut line)
            {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let guard = locked(&inner);
            if guard.serial != serial {
                break;
            }
            let text = clean_log_line(&line);
            if !text.is_empty() {
                crate::logs::push(crate::logs::Source::Comfyui, &text);
            }
        }
    });
}
fn supervise(inner: Arc<Mutex<Inner>>, serial: u64, port: u16, timeout: Duration) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let mut g = locked(&inner);
            if g.serial == serial {
                fail(&mut g, error.to_string());
            }
            return;
        }
    };
    let deadline = Instant::now() + timeout;
    let base =
        reqwest::Url::parse(&format!("http://127.0.0.1:{port}/")).expect("constant loopback URL");
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let mut g = locked(&inner);
            if g.serial == serial {
                fail(&mut g, error.to_string());
            }
            return;
        }
    };
    let mut last_error = "Owned listener not ready".to_string();
    loop {
        {
            let mut guard = locked(&inner);
            if guard.serial != serial || guard.child.is_none() {
                return;
            }
            let child = guard.child.as_ref().unwrap();
            match exited(child) {
                Ok(false) => {}
                Ok(true) => {
                    fail(&mut guard, "Owned backend exited before readiness".into());
                    return;
                }
                Err(error) => {
                    fail(&mut guard, error);
                    return;
                }
            }
            if Instant::now() >= deadline {
                fail(
                    &mut guard,
                    format!("Backend readiness timed out: {last_error}"),
                );
                return;
            }
            if !owns_listener(child, port).unwrap_or(false) {
                if port_has_listener(port) && !owns_listener(child, port).unwrap_or(false) {
                    fail(
                        &mut guard,
                        "Startup collision: foreign listener owns the chosen port".into(),
                    );
                    return;
                }
                drop(guard);
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        }
        let result = runtime
            .block_on(async {
                tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), async {
                    let nodes = crate::get_json(&client, &base, "object_info", false)
                        .await?
                        .ok_or("Missing object_info")?;
                    let stats = crate::get_json(&client, &base, "system_stats", false)
                        .await?
                        .ok_or("Missing system_stats")?;
                    crate::parse_snapshot(&base, &nodes, &stats, None).map(|_| ())
                })
                .await
            })
            .unwrap_or_else(|_| Err("Overall readiness deadline reached".into()));
        let mut guard = locked(&inner);
        if guard.serial != serial || guard.child.is_none() {
            return;
        }
        let child = guard.child.as_ref().unwrap();
        if exited(child).unwrap_or(true) {
            fail(&mut guard, "Owned backend exited during API probe".into());
            return;
        }
        if result.is_ok()
            && Instant::now() < deadline
            && owns_listener(child, port).unwrap_or(false)
        {
            guard.status.state = "running".into();
            guard.status.endpoint = Some(base.to_string());
            log("Owned ComfyUI API responded; generation/model readiness remains unverified");
            // Liveness only; the UI polls once a second too, so 100 ms would be 10x wasted /proc scans.
            drop(guard);
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let mut g = locked(&inner);
                if g.serial != serial || g.child.is_none() {
                    return;
                }
                if exited(g.child.as_ref().unwrap()).unwrap_or(true) {
                    fail(&mut g, "Owned backend exited".into());
                    return;
                }
                if !owns_listener(g.child.as_ref().unwrap(), port).unwrap_or(false) {
                    fail(&mut g, "Owned backend lost its loopback listener".into());
                    return;
                }
            }
        }
        if let Err(error) = result {
            last_error = error;
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "backend_tests.rs"]
pub(crate) mod tests;

#[tauri::command]
pub fn native_backend_start(
    engine: tauri::State<'_, crate::install::Engine>,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<Status, String> {
    let _guard = operations.enter()?;
    engine.backend_start()
}
#[tauri::command]
pub fn native_backend_status(engine: tauri::State<'_, crate::install::Engine>) -> Status {
    engine.backend.status()
}
#[tauri::command]
pub fn native_backend_stop(engine: tauri::State<'_, crate::install::Engine>) -> Status {
    engine.backend.stop()
}
