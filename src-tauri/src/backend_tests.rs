use super::*;
use crate::install::{Options, Request};
pub(crate) const SERVER: &str = r#"
import json,sys,http.server,socketserver,time,os
args=sys.argv[1:]
assert '--disable-auto-launch' in args
assert args[args.index('--listen')+1]=='127.0.0.1'
assert '--cpu' in args
assert os.environ.get('PYTHONPATH') is None
port=int(args[args.index('--port')+1])
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  with open('requests.log','a') as f: f.write(self.path+'\n')
  body=json.dumps({'FixtureNode':{}} if self.path=='/object_info' else {'devices':[{'name':'CPU fixture'}]}).encode()
  self.send_response(200); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
print('fixture starting',flush=True)
with socketserver.TCPServer(('127.0.0.1',port),Handler) as server: server.serve_forever()
"#;
pub(crate) fn fixture(script: &str) -> (tempfile::TempDir, Approved) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for name in [
        "runtime/python",
        "ComfyUI",
        "home",
        "cache",
        "config",
        "tmp",
    ] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    let result = Command::new("/usr/bin/python3")
        .args(["-m", "venv", "--without-pip", "--copies"])
        .arg(root.join("venv"))
        .status()
        .unwrap();
    assert!(result.success());
    fs::write(root.join("ComfyUI/main.py"), script).unwrap();
    let plan = Plan {
        reopen_id: None,
        id: uuid::Uuid::new_v4().to_string(),
        request: Request {
            storage_path: root.to_str().unwrap().into(),
            backend: Backend::Cpu,
            features: vec![],
            options: Options::default(),
            comfy_ref: "master".into(),
            folders: None,
        },
        steps: vec![],
        warnings: vec![],
        unsupported_options: vec![],
        can_execute: true,
        hardware: None,
        torch: Some(crate::install::torch_profile::cpu()),
    };
    fs::write(
        root.join("deas-plan.json"),
        serde_json::to_vec(&plan).unwrap(),
    )
    .unwrap();
    fs::write(root.join("deas-install.json"), serde_json::to_vec(&serde_json::json!({"planId":plan.id,"backend":"cpu","hardware":null,"torchProfile":plan.torch,"python":root.join("venv/bin/python"),"generationReady":false})).unwrap()).unwrap();
    let approved = Approved::capture(&plan).unwrap();
    (tmp, approved)
}
pub(crate) fn await_state(lifecycle: &Lifecycle, state: &str) -> Status {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let current = lifecycle.status();
        if current.state == state {
            return current;
        }
        assert!(
            Instant::now() < deadline,
            "waiting for {state}: {current:?}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
#[test]
fn a_second_lifecycle_cannot_start_the_same_environment_until_the_first_stops() {
    let (_tmp, approved) = fixture(SERVER);
    let first = Lifecycle::default();
    let second = Lifecycle::default();
    first
        .launch(approved.clone(), Duration::from_secs(5))
        .unwrap();
    await_state(&first, "running");
    let duplicate = second.launch(approved.clone(), Duration::from_secs(5));
    first.stop();
    assert!(
        duplicate.is_err(),
        "second instance must not spawn a duplicate backend"
    );
    second.launch(approved, Duration::from_secs(5)).unwrap();
    await_state(&second, "running");
    second.stop();
}
#[test]
fn real_owned_child_requires_api_before_running_and_stop_is_exact() {
    let (tmp, approved) = fixture(SERVER);
    let lifecycle = Lifecycle::default();
    let initial = lifecycle
        .launch(approved.clone(), Duration::from_secs(5))
        .unwrap();
    assert_eq!(initial.state, "starting");
    assert!(initial.endpoint.is_none());
    assert!(lifecycle.launch(approved, Duration::from_secs(5)).is_err());
    let status = await_state(&lifecycle, "running");
    assert!(!status.generation_ready);
    let endpoint = status.endpoint.unwrap();
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    assert_eq!(
        fs::read_to_string(tmp.path().join("ComfyUI/requests.log")).unwrap(),
        "/object_info\n/system_stats\n"
    );
    let pid = locked(&lifecycle.inner).child.as_ref().unwrap().id();
    assert_eq!(lifecycle.stop().state, "stopped");
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert!(lifecycle.status().endpoint.is_none());
    assert!(!lifecycle.stop().generation_ready);
}
#[test]
fn readiness_timeout_kills_only_owned_process() {
    let (_tmp, approved) = fixture("import time; print('not an API',flush=True); time.sleep(60)");
    let lifecycle = Lifecycle::default();
    lifecycle
        .launch(approved, Duration::from_millis(300))
        .unwrap();
    let pid = locked(&lifecycle.inner).child.as_ref().unwrap().id();
    let status = await_state(&lifecycle, "failed");
    assert!(status.error.unwrap().contains("timed out"));
    assert!(status.endpoint.is_none());
    assert!(!status.generation_ready);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert!(crate::logs::native_logs(0)
        .iter()
        .any(|entry| entry.text.contains("not an API")));
}
#[test]
fn startup_failure_retains_real_logs() {
    let (_tmp, approved) =
        fixture("import sys; print('fixture startup failed',flush=True); sys.exit(7)");
    let lifecycle = Lifecycle::default();
    lifecycle.launch(approved, Duration::from_secs(2)).unwrap();
    let status = await_state(&lifecycle, "failed");
    assert!(status.error.unwrap().contains("exited"));
    assert!(!status.generation_ready);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !crate::logs::native_logs(0)
        .iter()
        .any(|entry| entry.text.contains("fixture startup failed"))
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn manifest_tamper_and_symlink_replacement_never_spawn() {
    let (tmp, approved) = fixture(SERVER);
    fs::write(tmp.path().join("deas-install.json"), "{}").unwrap();
    let lifecycle = Lifecycle::default();
    assert!(lifecycle
        .launch(approved, Duration::from_secs(1))
        .unwrap_err()
        .contains("manifest"));
    assert!(locked(&lifecycle.inner).child.is_none());
    let (tmp, approved) = fixture(SERVER);
    let main = tmp.path().join("ComfyUI/main.py");
    fs::rename(&main, tmp.path().join("original.py")).unwrap();
    std::os::unix::fs::symlink(tmp.path().join("original.py"), &main).unwrap();
    assert!(lifecycle
        .launch(approved, Duration::from_secs(1))
        .unwrap_err()
        .contains("symlink"));
}
#[test]
fn drop_cleans_owned_group() {
    let (_tmp, approved) = fixture("import time; time.sleep(60)");
    let lifecycle = Lifecycle::default();
    lifecycle.launch(approved, Duration::from_secs(5)).unwrap();
    let pid = locked(&lifecycle.inner).child.as_ref().unwrap().id();
    drop(lifecycle);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
}
#[test]
fn changed_launch_file_never_spawns() {
    let (tmp, approved) = fixture(SERVER);
    fs::write(tmp.path().join("ComfyUI/main.py"), "print('replaced')").unwrap();
    let lifecycle = Lifecycle::default();
    assert!(lifecycle.launch(approved, Duration::from_secs(1)).is_err());
    assert!(locked(&lifecycle.inner).child.is_none());
}
#[test]
fn stalled_owned_http_respects_overall_readiness_deadline() {
    let (tmp, approved) = fixture(&SERVER.replace(
        "  body=json.dumps",
        "  with open('stalled-request.pid','w') as f: f.write(str(os.getpid()))\n  time.sleep(60)\n  body=json.dumps",
    ));
    let lifecycle = Lifecycle::default();
    let overall_deadline = Duration::from_millis(300);
    let total_started = Instant::now();
    let launch_started = Instant::now();
    lifecycle.launch(approved, overall_deadline).unwrap();
    let launch_duration = launch_started.elapsed();
    let terminal_started = Instant::now();
    let status = await_state(&lifecycle, "failed");
    let terminal_observation = terminal_started.elapsed();
    let total_elapsed = total_started.elapsed();
    let stalled_pid = fs::read_to_string(tmp.path().join("ComfyUI/stalled-request.pid"))
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());
    let timing = format!(
        "caller-observed durations: launch_call={launch_duration:?}, post_launch_terminal_state={terminal_observation:?}, total={total_elapsed:?}"
    );
    eprintln!(
        "stalled readiness diagnostics: {timing}; stalled_request_pid={stalled_pid:?}; terminal_status={status:?}"
    );

    assert!(
        status
            .error
            .as_deref()
            .is_some_and(|error| error.contains("Overall readiness deadline reached")),
        "{timing}; {status:?}"
    );
    assert!(!status.generation_ready, "{timing}; {status:?}");
    assert!(status.endpoint.is_none(), "{timing}; {status:?}");
    assert!(locked(&lifecycle.inner).child.is_none(), "{timing}");
    assert!(
        stalled_pid.is_some(),
        "fixture never recorded entry into the stalled HTTP request; {timing}; {status:?}"
    );
    if let Some(pid) = stalled_pid {
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "{timing}");
    }
    // Bound caller-observed post-launch liveness, excluding synchronous launch
    // validation/spawn. The supervisor's 300 ms clock starts after runtime
    // construction and may already be running when launch returns; this is not
    // a precise supervisor/cleanup measurement. Retain launch/total diagnostics.
    assert!(
        terminal_observation < Duration::from_secs(1),
        "{timing}; {status:?}"
    );
}
#[test]
fn running_child_losing_owned_listener_is_failed_not_adopted() {
    let script = SERVER.replace(
        "server.serve_forever()",
        "server.handle_request(); server.handle_request(); time.sleep(0.3)\ntime.sleep(60)",
    );
    let (_tmp, approved) = fixture(&script);
    let lifecycle = Lifecycle::default();
    lifecycle.launch(approved, Duration::from_secs(2)).unwrap();
    assert_eq!(await_state(&lifecycle, "running").state, "running");
    // The fixture closes its listener after both probes but stays alive.
    let status = await_state(&lifecycle, "failed");
    assert!(status.endpoint.is_none());
    assert!(!status.generation_ready);
}
#[test]
fn invalid_owned_api_never_marks_running() {
    let (_tmp, approved) = fixture(&SERVER.replace("{'FixtureNode':{}}", "[]"));
    let lifecycle = Lifecycle::default();
    lifecycle
        .launch(approved, Duration::from_millis(350))
        .unwrap();
    let status = await_state(&lifecycle, "failed");
    assert!(status.error.unwrap().contains("object_info"));
    assert!(status.endpoint.is_none());
    assert!(!status.generation_ready);
}
#[test]
fn stop_kills_owned_descendant_but_not_unrelated_child() {
    use std::os::unix::process::CommandExt;
    struct Foreign(Child);
    impl Drop for Foreign {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut foreign_command = Command::new("/usr/bin/sleep");
    foreign_command.arg("30").process_group(0);
    let mut foreign = Foreign(foreign_command.spawn().unwrap());
    let script = "import subprocess,time\np=subprocess.Popen(['/usr/bin/sleep','30'])\nopen('descendant.pid','w').write(str(p.pid))\ntime.sleep(30)";
    let (tmp, approved) = fixture(script);
    let lifecycle = Lifecycle::default();
    lifecycle.launch(approved, Duration::from_secs(5)).unwrap();
    let pid_file = tmp.path().join("ComfyUI/descendant.pid");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !pid_file.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid: u32 = fs::read_to_string(pid_file).unwrap().parse().unwrap();
    lifecycle.stop();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => break,
            Ok(stat) if stat.split_whitespace().nth(2) == Some("Z") => break,
            _ => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    assert!(foreign.0.try_wait().unwrap().is_none());
}
#[test]
fn stop_during_probe_does_not_allow_stale_running_status() {
    let (_tmp, approved) =
        fixture(&SERVER.replace("  body=json.dumps", "  time.sleep(60)\n  body=json.dumps"));
    let lifecycle = Lifecycle::default();
    lifecycle
        .launch(approved, Duration::from_millis(300))
        .unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(lifecycle.stop().state, "stopped");
    std::thread::sleep(Duration::from_millis(250));
    let status = lifecycle.status();
    assert_eq!(status.state, "stopped");
    assert!(status.endpoint.is_none());
}
#[test]
fn exact_ipc_status_schema_never_claims_generation() {
    assert_eq!(
        serde_json::to_value(Status::default()).unwrap(),
        serde_json::json!({"state":"stopped","endpoint":null,"error":null,"generationReady":false})
    );
}
#[test]
fn writable_or_replaced_owned_environment_is_rejected() {
    use std::os::unix::fs::PermissionsExt;
    let (tmp, approved) = fixture(SERVER);
    fs::set_permissions(
        tmp.path().join("ComfyUI"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let lifecycle = Lifecycle::default();
    assert!(lifecycle
        .launch(approved, Duration::from_secs(1))
        .unwrap_err()
        .contains("writable"));
    assert!(locked(&lifecycle.inner).child.is_none());
    let (tmp, approved) = fixture(SERVER);
    fs::rename(
        tmp.path().join("ComfyUI"),
        tmp.path().join("original-comfy"),
    )
    .unwrap();
    fs::create_dir(tmp.path().join("ComfyUI")).unwrap();
    fs::copy(
        tmp.path().join("original-comfy/main.py"),
        tmp.path().join("ComfyUI/main.py"),
    )
    .unwrap();
    assert!(lifecycle
        .launch(approved, Duration::from_secs(1))
        .unwrap_err()
        .contains("identity"));
}
#[test]
fn foreign_listener_is_never_adopted_or_stopped() {
    let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = foreign.local_addr().unwrap().port();
    let (_tmp, approved) = fixture("import time; time.sleep(60)");
    let lifecycle = Lifecycle::default();
    lifecycle
        .launch_port(approved, Duration::from_secs(2), port)
        .unwrap();
    let status = await_state(&lifecycle, "failed");
    assert!(status.error.unwrap().contains("foreign listener"));
    assert!(status.endpoint.is_none());
    foreign.set_nonblocking(true).unwrap();
    assert_eq!(
        foreign.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "The foreign listener must not even receive readiness probes"
    );
    lifecycle.stop();
    assert!(std::net::TcpStream::connect(foreign.local_addr().unwrap()).is_ok());
}
#[test]
fn clean_log_line_strips_terminal_control_sequences() {
    assert_eq!(
        clean_log_line(b"\x1b[32m[INFO]\x1b[0m Starting server\n"),
        "[INFO] Starting server"
    );
    assert_eq!(clean_log_line(b" 10%\r 55%\r100% done\r\n"), "100% done");
    assert_eq!(
        clean_log_line(b"\x1b]0;title\x07a\tb\x08c\x1b]8;;x\x1b\\d"),
        "a\tbcd"
    );
    assert_eq!(
        clean_log_line("Gr\u{fc}\u{df}e \u{2713}\n".as_bytes()),
        "Grüße ✓"
    );
    assert_eq!(clean_log_line(b"\n"), "");
}
