//! One explicit managed render, no scheduler and no frontend filesystem authority.
use crate::video_post_prepare::strict_id;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
const UNAVAILABLE: &str =
    "VIDEO_ENGINE: This build does not support managed Linux video rendering.";
const INVALID: &str =
    "VIDEO_JOB: Selection changed or request is unavailable; select and prepare again.";
const FAILED: &str =
    "VIDEO_RENDER: Rendering failed validation or execution; no output was published.";
#[derive(Serialize)]
pub struct Capabilities {
    available: bool,
}
#[tauri::command]
pub fn native_video_post_capabilities() -> Capabilities {
    Capabilities {
        available: cfg!(all(target_os = "linux", feature = "video-upscale")),
    }
}
fn available() -> Result<(), String> {
    if native_video_post_capabilities().available {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindTitles {
    runtime: String,
    model: String,
    dependency: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    id: String,
    runtime_name: String,
    model_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    dependency_name: Option<String>,
}
struct TrustedFile {
    path: PathBuf,
    file: File,
    identity: Vec<u64>,
    cap: u64,
}
impl TrustedFile {
    fn identity(file: &File, cap: u64) -> Result<Vec<u64>, String> {
        let m = file.metadata().map_err(|_| INVALID)?;
        if !m.is_file() || m.len() == 0 || m.len() > cap {
            return Err(INVALID.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(vec![
                m.dev(),
                m.ino(),
                m.len(),
                m.mtime() as u64,
                m.mtime_nsec() as u64,
                m.ctime() as u64,
                m.ctime_nsec() as u64,
            ])
        }
        #[cfg(not(unix))]
        {
            Err(UNAVAILABLE.into())
        }
    }
    fn open(path: &Path, cap: u64) -> Result<Self, String> {
        let path = fs::canonicalize(path).map_err(|_| INVALID)?;
        let mut o = fs::OpenOptions::new();
        o.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = o.open(&path).map_err(|_| INVALID)?;
        let identity = Self::identity(&file, cap)?;
        Ok(Self {
            path,
            file,
            identity,
            cap,
        })
    }
    fn library(path: &Path) -> Result<Self, String> {
        use std::io::Read;
        let selected = Self::open(path, 1024 * 1024 * 1024)?;
        let mut magic = [0; 4];
        selected
            .file
            .try_clone()
            .map_err(|_| INVALID)?
            .read_exact(&mut magic)
            .map_err(|_| INVALID)?;
        if magic != *b"\x7fELF" {
            return Err(INVALID.into());
        }
        Ok(selected)
    }
    fn preload_path(&self) -> Result<&Path, String> {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            if self
                .path
                .as_os_str()
                .as_bytes()
                .iter()
                .any(|b| *b == b':' || *b == b'$' || b.is_ascii_whitespace())
                || self
                    .path
                    .to_str()
                    .is_some_and(|p| p.chars().any(char::is_whitespace))
            {
                return Err("VIDEO_DEPENDENCY_PATH: Choose a trusted cuDNN library whose full canonical path contains no colon, whitespace or dollar sign.".into());
            }
        }
        Ok(&self.path)
    }
    fn recheck(&self) -> Result<(), String> {
        let current = Self::open(&self.path, self.cap)?;
        if current.identity != self.identity
            || Self::identity(&self.file, self.cap)? != self.identity
        {
            return Err(INVALID.into());
        }
        Ok(())
    }
    fn name(&self) -> Result<String, String> {
        self.path
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| s.len() <= 1024 && !s.chars().any(char::is_control))
            .map(str::to_owned)
            .ok_or_else(|| INVALID.into())
    }
}
struct Profile {
    snapshot: ProfileSnapshot,
    runtime: TrustedFile,
    model: TrustedFile,
    dependency: Option<TrustedFile>,
}
impl Profile {
    fn recheck(&self) -> Result<(), String> {
        self.runtime.recheck()?;
        self.model.recheck()?;
        if let Some(d) = &self.dependency {
            d.recheck()?;
        }
        Ok(())
    }
}
static PROFILE: Mutex<Option<Arc<Profile>>> = Mutex::new(None);
#[tauri::command]
pub async fn native_video_post_bind(titles: BindTitles) -> Result<Option<ProfileSnapshot>, String> {
    let operation = uuid::Uuid::new_v4();
    let result = bind_profile(titles).await;
    crate::video_post::finish_operation("bind", "bound", operation, result)
}
async fn bind_profile(titles: BindTitles) -> Result<Option<ProfileSnapshot>, String> {
    available()?;
    for title in [&titles.runtime, &titles.model, &titles.dependency] {
        crate::video_post::validate_title(title)?;
    }
    let _permit = crate::video_post::INSPECTING
        .try_acquire()
        .map_err(|_| INVALID)?;
    // Fixed native titles cannot be replaced with a misleading frontend trust description.
    let Some(runtime) = rfd::AsyncFileDialog::new()
        .set_title("Trusted ONNX Runtime native library — executes native code; trusted files only")
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let Some(model) = rfd::AsyncFileDialog::new()
        .set_title("Trusted ONNX model — only load a model you trust")
        .add_filter("ONNX", &["onnx"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let dependency = rfd::AsyncFileDialog::new()
        .set_title("OPTIONAL trusted cuDNN native library — executes native code; Cancel = skip")
        .pick_file()
        .await;
    if model.path().extension().and_then(|v| v.to_str()) != Some("onnx") {
        return Err(INVALID.into());
    }
    let runtime = TrustedFile::library(runtime.path())?;
    let model = TrustedFile::open(model.path(), 64 * 1024 * 1024)?;
    let dependency = dependency
        .map(|d| TrustedFile::library(d.path()))
        .transpose()?;
    if let Some(d) = &dependency {
        d.preload_path()?;
    }
    let snapshot = ProfileSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        runtime_name: runtime.name()?,
        model_name: model.name()?,
        dependency_name: dependency.as_ref().map(TrustedFile::name).transpose()?,
    };
    let p = Profile {
        snapshot: snapshot.clone(),
        runtime,
        model,
        dependency,
    };
    p.recheck()?;
    *PROFILE.lock().map_err(|_| INVALID)? = Some(Arc::new(p));
    Ok(Some(snapshot))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    id: String,
    state: String,
    source_name: String,
    output_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    frames: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
struct Job {
    snapshot: JobSnapshot,
    cancel: Arc<AtomicBool>,
}
impl Job {
    fn active(&self) -> bool {
        matches!(
            self.snapshot.state.as_str(),
            "starting" | "running" | "stopping"
        )
    }
}
static JOB: Mutex<Option<Job>> = Mutex::new(None);
static TVE_RESERVED: AtomicBool = AtomicBool::new(false);
fn log_state(id: &str, state: &str) {
    let severity = if state == "failed" { "ERROR" } else { "INFO" };
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("{severity}: video-post operation=render jobId={id} outcome={state}"),
    );
}
pub(crate) fn gpu_reserved() -> bool {
    TVE_RESERVED.load(Ordering::SeqCst)
}
struct RenderPermit<'a>(&'a AtomicBool);
impl<'a> RenderPermit<'a> {
    fn reserve(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "VIDEO_BUSY: A managed render is already active.")?;
        Ok(Self(flag))
    }
}
impl Drop for RenderPermit<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[tauri::command]
pub fn native_video_post_status(id: String) -> Result<JobSnapshot, String> {
    strict_id(&id)?;
    JOB.lock()
        .map_err(|_| INVALID)?
        .as_ref()
        .filter(|j| j.snapshot.id == id)
        .map(|j| j.snapshot.clone())
        .ok_or_else(|| INVALID.into())
}
#[tauri::command]
pub fn native_video_post_stop(id: String) -> Result<JobSnapshot, String> {
    strict_id(&id)?;
    let mut jobs = JOB.lock().map_err(|_| INVALID)?;
    let j = jobs
        .as_mut()
        .filter(|j| j.snapshot.id == id)
        .ok_or(INVALID)?;
    if j.active() {
        if j.snapshot.state != "stopping" {
            log_state(&id, "stopping");
        }
        j.cancel.store(true, Ordering::Relaxed);
        j.snapshot.state = "stopping".into();
    }
    Ok(j.snapshot.clone())
}
pub fn shutdown() {
    if let Ok(j) = JOB.lock() {
        if let Some(j) = j.as_ref().filter(|j| j.active()) {
            j.cancel.store(true, Ordering::Relaxed);
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if !JOB
            .lock()
            .map(|j| j.as_ref().is_some_and(Job::active))
            .unwrap_or(false)
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
#[tauri::command]
pub fn native_video_post_run(
    state: tauri::State<'_, crate::jobs::Jobs>,
    preparation_id: String,
    profile_id: String,
) -> Result<JobSnapshot, String> {
    available()?;
    let _chooser = crate::video_post::INSPECTING
        .try_acquire()
        .map_err(|_| "VIDEO_BUSY: Finish the current native chooser first.")?;
    strict_id(&preparation_id)?;
    strict_id(&profile_id)?;
    let permit = RenderPermit::reserve(&TVE_RESERVED)?;
    state.admit_video_post()?;
    let authority = crate::video_post_prepare::authorize_render(&preparation_id)?;
    let profile = PROFILE
        .lock()
        .map_err(|_| INVALID)?
        .as_ref()
        .filter(|p| p.snapshot.id == profile_id)
        .cloned()
        .ok_or(INVALID)?;
    profile.recheck()?;
    let s = authority.snapshot();
    let snapshot = JobSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        state: "starting".into(),
        source_name: s.source_name.clone(),
        output_name: s.output_name.clone(),
        frames: None,
        width: None,
        height: None,
        error: None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let mut jobs = JOB.lock().map_err(|_| INVALID)?;
    if jobs.as_ref().is_some_and(Job::active) {
        return Err("VIDEO_BUSY: A managed render is already active.".into());
    }
    *jobs = Some(Job {
        snapshot: snapshot.clone(),
        cancel: cancel.clone(),
    });
    let id = snapshot.id.clone();
    log_state(&id, "starting");
    if std::thread::Builder::new()
        .name("video-post-owner".into())
        .spawn(move || {
            let _permit = permit;
            let result = linux_render(
                authority,
                profile,
                &cancel,
                &id,
                #[cfg(test)]
                None,
            );
            let mut jobs = JOB.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(j) = jobs.as_mut().filter(|j| j.snapshot.id == id) {
                match result {
                    Ok(m) => {
                        j.snapshot.state = "succeeded".into();
                        j.snapshot.frames = Some(m.frames);
                        j.snapshot.width = Some(m.width);
                        j.snapshot.height = Some(m.height);
                    }
                    Err(_) => {
                        j.snapshot.state = if cancel.load(Ordering::Relaxed) {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        if j.snapshot.state == "failed" {
                            j.snapshot.error = Some(FAILED.into());
                        }
                    }
                }
                log_state(&id, &j.snapshot.state);
            }
        })
        .is_err()
    {
        if let Some(j) = jobs.as_mut() {
            j.snapshot.state = "failed".into();
            j.snapshot.error = Some(FAILED.into());
        }
        return Err(FAILED.into());
    }
    Ok(snapshot)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    frames: usize,
    width: u32,
    height: u32,
}
#[cfg(target_os = "linux")]
#[derive(Serialize, Deserialize)]
enum WorkerKind {
    #[serde(rename = "deas-video-post-worker")]
    Render,
}
#[cfg(target_os = "linux")]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    version: u32,
    kind: WorkerKind,
    runtime: PathBuf,
    model: PathBuf,
    source: PathBuf,
    output: PathBuf,
    width: u32,
    height: u32,
}
#[cfg(target_os = "linux")]
#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase", deny_unknown_fields)]
enum Event {
    Running { version: u32 },
    Success { version: u32, metadata: Metadata },
    Error { version: u32 },
}
#[cfg(not(target_os = "linux"))]
fn linux_render(
    _: crate::video_post_prepare::RenderAuthority,
    _: Arc<Profile>,
    _: &AtomicBool,
    _: &str,
    #[cfg(test)] _: Option<()>,
) -> Result<Metadata, String> {
    Err(UNAVAILABLE.into())
}
#[cfg(target_os = "linux")]
fn linux_render(
    authority: crate::video_post_prepare::RenderAuthority,
    profile: Arc<Profile>,
    cancel: &AtomicBool,
    id: &str,
    #[cfg(test)] fixture: Option<&mut dyn FnMut(&Descriptor) -> std::process::Command>,
) -> Result<Metadata, String> {
    authority.recheck()?;
    profile.recheck()?;
    let stage = tempfile::Builder::new()
        .prefix(".deas-video-job-")
        .tempdir_in(authority.destination().parent().ok_or(INVALID)?)
        .map_err(|_| FAILED)?;
    let output = stage.path().join("result.mp4");
    let s = authority.snapshot();
    let descriptor = Descriptor {
        version: 1,
        kind: WorkerKind::Render,
        runtime: profile.runtime.path.clone(),
        model: profile.model.path.clone(),
        source: authority.source_path().to_owned(),
        output: output.clone(),
        width: s.width,
        height: s.height,
    };
    let executable = std::env::current_exe().map_err(|_| FAILED)?;
    #[cfg(test)]
    let executable = std::env::var_os("DEAS_VIDEO_POST_WORKER_EXE")
        .map(PathBuf::from)
        .unwrap_or(executable);
    let mut command = std::process::Command::new(executable);
    command.arg("--video-post-worker").env_remove("LD_PRELOAD");
    if let Some(d) = &profile.dependency {
        command.env("LD_PRELOAD", d.preload_path()?);
    }
    #[cfg(test)]
    let command = fixture.map_or(command, |make| make(&descriptor));
    let result = monitor(
        command,
        &descriptor,
        cancel,
        || {
            if let Ok(mut jobs) = JOB.lock() {
                if let Some(j) = jobs
                    .as_mut()
                    .filter(|j| j.snapshot.id == id && j.snapshot.state == "starting")
                {
                    j.snapshot.state = "running".into();
                    log_state(id, "running");
                }
            }
        },
        std::time::Duration::from_secs(330),
        std::time::Duration::from_secs(2),
    )?;
    if result.width != s.width || result.height != s.height {
        return Err(FAILED.into());
    }
    // Serialize cancellation versus commit: Stop after this commit honestly returns success.
    let _jobs = JOB.lock().map_err(|_| FAILED)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(FAILED.into());
    }
    authority.recheck()?;
    profile.recheck()?;
    let m = fs::symlink_metadata(&output).map_err(|_| FAILED)?;
    if !m.is_file() || m.len() == 0 || m.len() > 256 * 1024 * 1024 {
        return Err(FAILED.into());
    }
    fs::hard_link(&output, authority.destination()).map_err(|_| FAILED)?;
    Ok(result)
}
#[cfg(target_os = "linux")]
fn monitor(
    mut command: std::process::Command,
    descriptor: &Descriptor,
    cancel: &AtomicBool,
    mut running: impl FnMut(),
    limit: std::time::Duration,
    grace: std::time::Duration,
) -> Result<Metadata, String> {
    use std::{
        io::{Read, Write},
        os::{fd::AsRawFd, unix::process::CommandExt},
        process::Stdio,
        time::Instant,
    };
    let bytes = serde_json::to_vec(descriptor).map_err(|_| FAILED)?;
    if bytes.len() > 16384 {
        return Err(FAILED.into());
    }
    let parent = unsafe { libc::getpid() };
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                libc::_exit(1);
            }
            Ok(())
        });
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    struct Owned(std::process::Child);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = Owned(command.spawn().map_err(|_| FAILED)?);
    for fd in [
        child.0.stdin.as_ref().unwrap().as_raw_fd(),
        child.0.stdout.as_ref().unwrap().as_raw_fd(),
        child.0.stderr.as_ref().unwrap().as_raw_fd(),
    ] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(FAILED.into());
        }
    }
    let start = Instant::now();
    let mut stopping = None;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut sent = 0;
    let mut stdout = Vec::new();
    let mut seen_running = false;
    let mut success = None;
    let mut failed = false;
    loop {
        if (cancel.load(Ordering::Relaxed) || start.elapsed() >= limit)
            && stopping.is_none()
            && exit_status.is_none()
        {
            unsafe {
                libc::kill(child.0.id() as i32, libc::SIGTERM);
            }
            stopping = Some(Instant::now());
        }
        if stopping.is_some_and(|t| t.elapsed() >= grace) {
            return Err(FAILED.into());
        }
        if let Some(stdin) = child.0.stdin.as_mut() {
            match stdin.write(&bytes[sent..]) {
                Ok(n) => sent += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(_) => return Err(FAILED.into()),
            }
            if sent == bytes.len() {
                child.0.stdin.take();
            }
        }
        for is_stdout in [true, false] {
            let mut buf = [0; 1024];
            for _ in 0..16 {
                let read = if is_stdout {
                    child.0.stdout.as_mut().unwrap().read(&mut buf)
                } else {
                    child.0.stderr.as_mut().unwrap().read(&mut buf)
                };
                match read {
                    Ok(0) => break,
                    Ok(n) => {
                        if is_stdout {
                            stdout.extend_from_slice(&buf[..n]);
                            if stdout.len() > 4096 {
                                return Err(FAILED.into());
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => return Err(FAILED.into()),
                }
            }
        }
        while let Some(end) = stdout.iter().position(|&b| b == b'\n') {
            let line: Vec<_> = stdout.drain(..=end).collect();
            let event: Event = serde_json::from_slice(&line).map_err(|_| FAILED)?;
            match event {
                Event::Running { version: 1 } if !seen_running && success.is_none() && !failed => {
                    seen_running = true;
                    running();
                }
                Event::Success {
                    version: 1,
                    metadata,
                } if seen_running && success.is_none() && !failed => {
                    if metadata.frames < 2
                        || metadata.frames > 600
                        || metadata.width != descriptor.width
                        || metadata.height != descriptor.height
                    {
                        return Err(FAILED.into());
                    }
                    success = Some(metadata);
                }
                Event::Error { version: 1 } if success.is_none() && !failed => failed = true,
                _ => return Err(FAILED.into()),
            }
        }
        if let Some(status) = exit_status {
            return if status.success() && !failed && stdout.is_empty() && stopping.is_none() {
                success.ok_or_else(|| FAILED.into())
            } else {
                Err(FAILED.into())
            };
        }
        // Drain once more after exit: the last event may race the preceding pipe read.
        exit_status = child.0.try_wait().map_err(|_| FAILED)?;
        if exit_status.is_none() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}
/// Called before Linux/GTK setup; no other command-line worker options exist.
pub fn worker_entry() -> i32 {
    #[cfg(all(target_os = "linux", feature = "video-upscale"))]
    {
        worker::entry()
    }
    #[cfg(not(all(target_os = "linux", feature = "video-upscale")))]
    {
        2
    }
}
#[cfg(all(target_os = "linux", feature = "video-upscale"))]
mod worker {
    use super::*;
    use std::io::{Read, Write};
    static CANCEL: AtomicBool = AtomicBool::new(false);
    extern "C" fn stop(_: i32) {
        CANCEL.store(true, Ordering::Relaxed);
    }
    fn emit(event: Event) -> Result<(), String> {
        let mut out = std::io::stdout().lock();
        serde_json::to_writer(&mut out, &event).map_err(|_| FAILED)?;
        out.write_all(b"\n")
            .and_then(|_| out.flush())
            .map_err(|_| FAILED.to_owned())
    }
    pub(super) fn entry() -> i32 {
        // The selected library is already loaded by the child loader; codec children need none.
        std::env::remove_var("LD_PRELOAD");
        unsafe {
            if libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t) == libc::SIG_ERR
            {
                return 1;
            }
        }
        let result = (|| {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(16385)
                .read_to_end(&mut bytes)
                .map_err(|_| FAILED)?;
            if bytes.len() > 16384 {
                return Err(FAILED.into());
            }
            let d: Descriptor = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
            if d.version != 1
                || d.width == 0
                || d.height == 0
                || d.width > 2048
                || d.height > 2048
                || [&d.runtime, &d.model, &d.source, &d.output]
                    .iter()
                    .any(|p| !p.is_absolute())
            {
                return Err(FAILED.into());
            }
            let _runtime = TrustedFile::open(&d.runtime, 1024 * 1024 * 1024)?;
            let _model = TrustedFile::open(&d.model, 64 * 1024 * 1024)?;
            let mut session = crate::video_upscale::SpatialUpscaler::open(&d.runtime, &d.model)?;
            let mut first = true;
            let r = crate::video_stream::upscale_video(&d.source, &d.output, &CANCEL, |frame| {
                let result = session.upscale(frame)?;
                if result.width != d.width || result.height != d.height {
                    return Err(FAILED.into());
                }
                if first {
                    emit(Event::Running { version: 1 })?;
                    first = false;
                }
                Ok(result)
            })?;
            emit(Event::Success {
                version: 1,
                metadata: Metadata {
                    frames: r.frames,
                    width: r.width,
                    height: r.height,
                },
            })
        })();
        if result.is_ok() {
            0
        } else {
            let _ = emit(Event::Error { version: 1 });
            1
        }
    }
}
#[cfg(all(test, target_os = "linux"))]
#[path = "video_post_job_tests.rs"]
mod tests;
