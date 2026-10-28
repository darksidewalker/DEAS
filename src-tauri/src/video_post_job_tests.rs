use super::*;

#[cfg(feature = "video-upscale")]
#[test]
#[ignore = "requires explicit native worker executable, trusted local SDK/model paths, four-frame 16x16 source and free CUDA device"]
fn real_managed_ai_parent_worker_publication() {
    let path = |key: &str| PathBuf::from(std::env::var_os(key).expect(key));
    assert!(path("DEAS_VIDEO_POST_WORKER_EXE").is_absolute());
    let source = path("VIDEO_JOB_SOURCE");
    let output = path("VIDEO_JOB_OUTPUT");
    let original = fs::read(&source).unwrap();
    let authority = crate::video_post_prepare::test_real_render_authority(&source, &output);
    assert_eq!(
        (authority.snapshot().width, authority.snapshot().height),
        (32, 32)
    );
    let runtime = TrustedFile::library(&path("ORT_LIBRARY")).unwrap();
    let model = TrustedFile::open(&path("UPSCALE_MODEL"), 64 * 1024 * 1024).unwrap();
    let dependency =
        std::env::var_os("CUDNN_LIBRARY").map(|p| TrustedFile::library(Path::new(&p)).unwrap());
    let profile = Arc::new(Profile {
        snapshot: ProfileSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            runtime_name: runtime.name().unwrap(),
            model_name: model.name().unwrap(),
            dependency_name: dependency.as_ref().map(|d| d.name().unwrap()),
        },
        runtime,
        model,
        dependency,
    });
    let result = linux_render(
        authority,
        profile,
        &AtomicBool::new(false),
        &uuid::Uuid::new_v4().to_string(),
        None,
    )
    .unwrap();
    assert_eq!((result.frames, result.width, result.height), (4, 32, 32));
    assert_eq!(fs::read(&source).unwrap(), original);
    assert!(output.is_file());
    assert!(!fs::read_dir(output.parent().unwrap()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".deas-video-job-")));
    println!("Real managed parent + native CUDA worker published 4 frames at 32x32; source unchanged, owned staging removed");
}

#[test]
fn render_permissions_are_explicit_and_local_main_only() {
    let permissions: toml::Value =
        toml::from_str(include_str!("../permissions/video_post.toml")).unwrap();
    let allow = |name: &str| {
        permissions["permission"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["identifier"].as_str() == Some(name))
            .unwrap()["commands"]["allow"]
            .as_array()
            .unwrap()
    };
    let inspect = allow("allow-native-video-post-inspect");
    let render = allow("allow-native-video-post-render");
    for name in [
        "native_video_post_bind",
        "native_video_post_run",
        "native_video_post_status",
        "native_video_post_stop",
    ] {
        let name = toml::Value::String(name.into());
        assert!(!inspect.contains(&name));
        assert!(render.contains(&name));
    }
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(capability.get("remote").is_none());
    assert!(capability["permissions"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("allow-native-video-post-render")));
}

#[test]
fn optional_preload_rejects_loader_lists_and_expansion_without_repair() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "a:b.so",
        "a b.so",
        "a\u{00a0}b.so",
        "a\u{2003}b.so",
        "a\tb.so",
        "a$ORIGIN.so",
        "a$LIB.so",
        "a$PLATFORM.so",
    ] {
        let path = dir.path().join(name);
        fs::write(&path, b"library").unwrap();
        let selected = TrustedFile::open(&path, 64).unwrap();
        assert!(selected
            .preload_path()
            .unwrap_err()
            .starts_with("VIDEO_DEPENDENCY_PATH:"));
        assert_eq!(selected.path, path);
    }
    let path = dir.path().join("libcudnn.so.9");
    fs::write(&path, b"library").unwrap();
    assert_eq!(
        TrustedFile::open(&path, 64)
            .unwrap()
            .preload_path()
            .unwrap(),
        path
    );
}

#[test]
fn stalled_private_descriptor_pipe_cannot_block_stop_or_deadline() {
    use std::os::unix::process::CommandExt;
    let mut c = fixture("stallstdin");
    unsafe {
        c.pre_exec(|| {
            if libc::fcntl(0, libc::F_SETPIPE_SZ, 4096) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut d = descriptor();
    d.source = PathBuf::from(format!("/{}", "x".repeat(12000)));
    let start = Instant::now();
    assert!(monitor(
        c,
        &d,
        &AtomicBool::new(false),
        || {},
        Duration::from_millis(100),
        Duration::from_millis(60)
    )
    .is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
    d.source = PathBuf::from(format!("/{}", "x".repeat(17000)));
    assert!(monitor(
        fixture("success"),
        &d,
        &AtomicBool::new(false),
        || {},
        Duration::from_secs(1),
        Duration::from_millis(60)
    )
    .is_err());
}

#[test]
fn reservation_rejects_overlap_and_releases_on_every_return() {
    let busy = AtomicBool::new(false);
    let first = RenderPermit::reserve(&busy).unwrap();
    assert!(RenderPermit::reserve(&busy).is_err());
    drop(first);
    assert!(!busy.load(Ordering::SeqCst));
    let rejection = (|| -> Result<(), String> {
        let _permit = RenderPermit::reserve(&busy)?;
        Err(INVALID.into())
    })();
    assert!(rejection.is_err());
    assert!(!busy.load(Ordering::SeqCst));
    assert!(RenderPermit::reserve(&busy).is_ok());
}

#[test]
fn forced_worker_death_still_cleans_parent_owned_stage() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("out.mp4");
    let ready = dir.path().join("ready");
    fs::write(&source, b"abcdefghijklmnop").unwrap();
    let authority = crate::video_post_prepare::test_render_authority(&source, &output);
    let p = profile(dir.path());
    let cancel = AtomicBool::new(false);
    let mut make = |d: &Descriptor| {
        fs::write(&d.output, b"private partial").unwrap();
        let mut c = fixture("hang");
        c.env("DEAS_FIXTURE_READY", &ready);
        c
    };
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !ready.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            cancel.store(true, Ordering::Relaxed);
        });
        assert!(linux_render(
            authority,
            p,
            &cancel,
            &uuid::Uuid::new_v4().to_string(),
            Some(&mut make)
        )
        .is_err());
    });
    assert!(!output.exists());
    assert!(!fs::read_dir(dir.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".deas-video-job-")));
}

fn profile(dir: &Path) -> Arc<Profile> {
    let runtime = dir.join("runtime.so");
    let model = dir.join("model.onnx");
    fs::write(&runtime, b"runtime").unwrap();
    fs::write(&model, b"model").unwrap();
    Arc::new(Profile {
        snapshot: ProfileSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            runtime_name: "runtime.so".into(),
            model_name: "model.onnx".into(),
            dependency_name: None,
        },
        runtime: TrustedFile::open(&runtime, 1024).unwrap(),
        model: TrustedFile::open(&model, 1024).unwrap(),
        dependency: None,
    })
}
#[test]
fn actual_parent_staging_cleans_up_and_rechecks_noclobber_source_profile() {
    for mode in [
        "success",
        "fail",
        "wrong",
        "clobber",
        "source-change",
        "profile-change",
        "cancel",
        "oversize",
        "empty",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.mp4");
        let output = dir.path().join("out.mp4");
        fs::write(&source, b"abcdefghijklmnop").unwrap();
        let authority = crate::video_post_prepare::test_render_authority(&source, &output);
        let p = profile(dir.path());
        let model = p.model.path.clone();
        let cancel = AtomicBool::new(false);
        let mut make = |d: &Descriptor| {
            let mut c = fixture(if mode == "fail" || mode == "oversize" || mode == "empty" {
                mode
            } else if mode == "wrong" {
                "wrong"
            } else {
                "success"
            });
            c.env("DEAS_FIXTURE_OUTPUT", &d.output);
            match mode {
                "clobber" => {
                    c.env("DEAS_FIXTURE_TOUCH", &output);
                }
                "source-change" => {
                    c.env("DEAS_FIXTURE_TOUCH", &source);
                }
                "profile-change" => {
                    c.env("DEAS_FIXTURE_TOUCH", &model);
                }
                "cancel" => {
                    cancel.store(true, Ordering::Relaxed);
                }
                _ => (),
            };
            c
        };
        let result = linux_render(
            authority,
            p,
            &cancel,
            &uuid::Uuid::new_v4().to_string(),
            Some(&mut make),
        );
        assert_eq!(result.is_ok(), mode == "success", "{mode}");
        if mode == "success" {
            assert_eq!(fs::read(&output).unwrap(), b"NON-AI fixture output");
        } else if mode == "clobber" {
            assert_eq!(fs::read(&output).unwrap(), b"changed");
        } else {
            assert!(!output.exists(), "{mode}");
        }
        assert!(
            !fs::read_dir(dir.path()).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".deas-video-job-")),
            "{mode}"
        );
    }
}
use std::{
    process::Command,
    sync::OnceLock,
    time::{Duration, Instant},
};
fn fixture(mode: &str) -> Command {
    static BIN: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    let (_, binary) = BIN.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("non-ai-worker");
        let status = Command::new("rustc")
            .args([
                "--edition=2021",
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/src/video_post_worker_fixture.rs"
                ),
                "-o",
            ])
            .arg(&binary)
            .status()
            .unwrap();
        assert!(status.success());
        (dir, binary)
    });
    let mut c = Command::new(binary);
    c.env("DEAS_FIXTURE_MODE", mode);
    c
}
fn descriptor() -> Descriptor {
    Descriptor {
        version: 1,
        kind: WorkerKind::Render,
        runtime: "/unused.so".into(),
        model: "/unused.onnx".into(),
        source: "/unused.mp4".into(),
        output: "/unused-output.mp4".into(),
        width: 32,
        height: 32,
    }
}
#[test]
fn real_rust_child_protocol_is_strict_and_failure_is_not_success() {
    let mut called = 0;
    let m = monitor(
        fixture("success"),
        &descriptor(),
        &AtomicBool::new(false),
        || called += 1,
        Duration::from_secs(5),
        Duration::from_millis(50),
    )
    .unwrap();
    assert_eq!((m.frames, m.width, m.height, called), (4, 32, 32, 1));
    for mode in ["fail", "error", "noise", "wrong", "badversion", "double"] {
        assert!(
            monitor(
                fixture(mode),
                &descriptor(),
                &AtomicBool::new(false),
                || {},
                Duration::from_secs(5),
                Duration::from_millis(50)
            )
            .is_err(),
            "{mode}"
        );
    }
    assert!(
        serde_json::from_str::<Event>(r#"{"version":1,"event":"running","path":"private"}"#)
            .is_err()
    );
    for value in [
        r#"{"version":"1","event":"running"}"#,
        r#"{"version":1,"event":"success","metadata":{"frames":4,"width":"32","height":32}}"#,
    ] {
        assert!(serde_json::from_str::<Event>(value).is_err());
    }
    let mut value = serde_json::to_value(descriptor()).unwrap();
    value["kind"] = serde_json::json!("shell");
    assert!(serde_json::from_value::<Descriptor>(value).is_err());
}
#[test]
fn real_rust_child_stop_timeout_forcekill_and_reap() {
    for mode in ["wait", "hang"] {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let mut c = fixture(mode);
        c.env("DEAS_FIXTURE_READY", &ready);
        let start = Instant::now();
        assert!(monitor(
            c,
            &descriptor(),
            &AtomicBool::new(false),
            || {},
            Duration::from_millis(250),
            Duration::from_millis(60)
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(3));
        let pid: i32 = fs::read_to_string(ready).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    assert!(monitor(
        fixture("hang"),
        &descriptor(),
        &AtomicBool::new(true),
        || {},
        Duration::from_secs(5),
        Duration::from_millis(60)
    )
    .is_err());
}
#[test]
fn trusted_profile_handles_detect_mutation_replacement_and_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("private model.onnx");
    fs::write(&p, b"model").unwrap();
    assert!(TrustedFile::open(&p, 4).is_err());
    let f = TrustedFile::open(&p, 64).unwrap();
    f.recheck().unwrap();
    fs::write(&p, b"other").unwrap();
    assert!(f.recheck().is_err());
    let f = TrustedFile::open(&p, 64).unwrap();
    fs::rename(&p, dir.path().join("old")).unwrap();
    fs::write(&p, b"other").unwrap();
    assert!(f.recheck().is_err());
    assert!(TrustedFile::open(dir.path(), 64).is_err());
}
#[test]
fn capability_has_no_runtime_dependency_and_inactive_fields_are_omitted() {
    if !cfg!(feature = "video-upscale") {
        assert_eq!(worker_entry(), 2);
    }
    assert_eq!(
        native_video_post_capabilities().available,
        cfg!(feature = "video-upscale")
    );
    let s = JobSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        state: "starting".into(),
        source_name: "source.mp4".into(),
        output_name: "output.mp4".into(),
        frames: None,
        width: None,
        height: None,
        error: None,
    };
    let v = serde_json::to_value(s).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 4);
    assert!(strict_id("00000000-0000-0000-0000-000000000000").is_err());
}
#[test]
fn wrong_status_stop_ids_preserve_the_active_job() {
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    *JOB.lock().unwrap() = Some(Job {
        snapshot: JobSnapshot {
            id: id.clone(),
            state: "running".into(),
            source_name: "a.mp4".into(),
            output_name: "b.mp4".into(),
            frames: None,
            width: None,
            height: None,
            error: None,
        },
        cancel: cancel.clone(),
    });
    assert!(native_video_post_stop(uuid::Uuid::new_v4().to_string()).is_err());
    assert!(native_video_post_status("bad".into()).is_err());
    assert!(!cancel.load(Ordering::Relaxed));
    assert_eq!(
        native_video_post_status(id.clone()).unwrap().state,
        "running"
    );
    assert_eq!(
        native_video_post_stop(id.clone()).unwrap().state,
        "stopping"
    );
    assert!(cancel.load(Ordering::Relaxed));
    JOB.lock().unwrap().as_mut().unwrap().snapshot.state = "succeeded".into();
    assert_eq!(native_video_post_stop(id).unwrap().state, "succeeded");
    *JOB.lock().unwrap() = None;
}
