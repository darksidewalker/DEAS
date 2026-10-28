use super::*;
use serde_json::json;

fn settings() -> PrepareSettings {
    PrepareSettings {
        scale: 4,
        profile: PrepareProfile::Mp4H264,
    }
}
fn fixture() -> (tempfile::TempDir, Session, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private source.mp4");
    fs::write(&path, b"abcdefghijklmnop").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let source = VideoSourceInspection {
        source_id: Some(id.clone()),
        name: "private source.mp4".into(),
        width: 512,
        height: 256,
        fps_numerator: 30000,
        fps_denominator: 1001,
        duration_seconds: Some(10.0),
        pixel_format: "yuv420p".into(),
        field_order: "progressive".into(),
        color_transfer: "bt709".into(),
        audio_streams: 1,
        subtitle_streams: 0,
        blockers: vec![],
        timing_verified: false,
        processing_ready: false,
    };
    let mut state = Session::default();
    state.replace_source(crate::video_post::test_retained(&path, source));
    (dir, state, id)
}
#[test]
fn exact_snapshot_cancel_failure_and_replacement() {
    let (dir, mut state, id) = fixture();
    let output = dir.path().join("new.mp4");
    let result = state
        .commit(&id, settings(), Some(&output))
        .unwrap()
        .unwrap();
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(
        value,
        json!({"id":result.id,"sourceId":id,"sourceName":"private source.mp4","outputName":"new.mp4",
        "width":2048,"height":1024,"fpsNumerator":30000,"fpsDenominator":1001,
        "settings":{"scale":4,"profile":"mp4-h264"},"modelBound":false,"timingVerified":false,"encoderVerified":false,"processingReady":false})
    );
    assert!(!output.exists());
    assert!(state.commit(&id, settings(), None).unwrap().is_none());
    assert_eq!(state.status(&result.id).unwrap().id, result.id);
    assert!(state
        .commit(&id, settings(), Some(&dir.path().join("bad.mkv")))
        .is_err());
    assert_eq!(state.status(&result.id).unwrap().id, result.id);
    assert!(state.status(&uuid::Uuid::new_v4().to_string()).is_err());
    assert!(state.status("/private/source.mp4").is_err());
    assert_eq!(state.status(&result.id).unwrap().id, result.id);
    let next = state
        .commit(&id, settings(), Some(&output))
        .unwrap()
        .unwrap();
    assert_ne!(result.id, next.id);
    assert!(state.status(&result.id).is_err());
    let mut replacement = state.source(&id).unwrap().metadata.clone();
    replacement.source_id = Some(uuid::Uuid::new_v4().to_string());
    state.replace_source(crate::video_post::test_retained(
        &dir.path().join("private source.mp4"),
        replacement,
    ));
    assert!(state.status(&next.id).is_err());
    assert!(state.source(&id).is_err());
}
#[test]
fn source_changed_and_parent_replaced_invalidate_permanently() {
    for change_source in [false, true] {
        let (dir, mut state, id) = fixture();
        let parent = dir.path().join("output");
        fs::create_dir(&parent).unwrap();
        let output = parent.join("new.mp4");
        let prepared = state
            .commit(&id, settings(), Some(&output))
            .unwrap()
            .unwrap();
        if change_source {
            let source = dir.path().join("private source.mp4");
            fs::rename(&source, dir.path().join("old.mp4")).unwrap();
            fs::write(&source, b"abcdefghijklmnop").unwrap();
            assert!(state.commit(&id, settings(), Some(&output)).is_err());
        } else {
            fs::rename(&parent, dir.path().join("old-output")).unwrap();
            fs::create_dir(&parent).unwrap();
        }
        assert_eq!(state.status(&prepared.id).unwrap_err(), STALE);
        assert!(state.prepared.is_none());
    }
}
#[cfg(target_os = "linux")]
#[test]
fn destination_traps_and_symlink_parent_navigation() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let (dir, mut state, id) = fixture();
    for path in [
        PathBuf::from("relative.mp4"),
        dir.path().join("new.MP4"),
        dir.path().join("new.mkv"),
        dir.path().join("private source.mp4"),
        dir.path().join("missing/new.mp4"),
    ] {
        assert!(state.commit(&id, settings(), Some(&path)).is_err());
    }
    let original = dir.path().join("private source.mp4");
    let metadata = state.source(&id).unwrap().metadata.clone();
    let hardlink = dir.path().join("hard.mp4");
    fs::hard_link(&original, &hardlink).unwrap();
    // Adding a hardlink changes source ctime; admit that identity before testing targets.
    state.replace_source(crate::video_post::test_retained(&original, metadata));
    let link = dir.path().join("link.mp4");
    symlink(dir.path().join("absent"), &link).unwrap();
    let fifo = dir.path().join("fifo.mp4");
    let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    for path in [&hardlink, &link, &fifo, &fifo.join("new.mp4")] {
        assert!(state.commit(&id, settings(), Some(path)).is_err());
    }
    let linked_parent = dir.path().join("bookmark");
    symlink(dir.path(), &linked_parent).unwrap();
    let output = linked_parent.join("new.mp4");
    let prepared = state
        .commit(&id, settings(), Some(&output))
        .unwrap()
        .unwrap();
    assert!(state.status(&prepared.id).is_ok());
    fs::write(&output, b"external target").unwrap();
    assert_eq!(state.status(&prepared.id).unwrap_err(), STALE);
    fs::remove_file(output).unwrap();
    assert!(state.status(&prepared.id).is_err());
}
#[test]
fn strict_settings_and_metadata_limits() {
    for bad in [
        json!({"scale":1,"profile":"mkv-h264"}),
        json!({"scale":1,"profile":"webm-vp9"}),
        json!({"scale":1,"profile":"mp4-h264","path":"/secret"}),
        json!({"scale":1.5,"profile":"mp4-h264"}),
        json!({"scale":-1,"profile":"mp4-h264"}),
    ] {
        assert!(serde_json::from_value::<PrepareSettings>(bad).is_err());
    }
    let (_dir, state, id) = fixture();
    let base = state.source(&id).unwrap().metadata.clone();
    for scale in [0, 3, 5, u32::MAX] {
        assert!(admissible(
            &base,
            &PrepareSettings {
                scale,
                profile: PrepareProfile::Mp4H264
            }
        )
        .is_err());
    }
    for case in 0..9 {
        let mut source = base.clone();
        match case {
            0 => source.width = 514,
            1 => source.height = 514,
            2 => source.duration_seconds = None,
            3 => source.duration_seconds = Some(10.001),
            4 => source.fps_numerator = 120121,
            5 => source.fps_denominator = 0,
            6 => source.audio_streams = 2,
            7 => source.subtitle_streams = 1,
            _ => source.blockers.push("rotation".into()),
        }
        assert!(admissible(&source, &settings()).is_err(), "case {case}");
    }
    for scale in [1, 2, 4] {
        assert!(admissible(
            &base,
            &PrepareSettings {
                scale,
                profile: PrepareProfile::Mp4H264
            }
        )
        .is_ok());
    }
}
#[tokio::test]
async fn commands_log_sanitized_errors_and_share_admission() {
    let error =
        native_video_post_prepare("private/path".into(), settings(), "private\ntitle".into())
            .await
            .unwrap_err();
    assert!(error.starts_with("VIDEO_TITLE:"));
    let permit = INSPECTING.try_acquire().unwrap();
    assert!(native_video_post_prepare(
        uuid::Uuid::new_v4().to_string(),
        settings(),
        "Prepare".into()
    )
    .await
    .unwrap_err()
    .starts_with("VIDEO_BUSY:"));
    drop(permit);
    assert_eq!(
        native_video_post_prepared_status("private/path".into()).unwrap_err(),
        STALE
    );
    for operation in ["prepare", "prepared-status"] {
        let prefix = format!("ERROR: video-post operation={operation} operationId=");
        let entries = crate::logs::native_logs(0);
        let entry = entries
            .iter()
            .rev()
            .find(|e| e.text.starts_with(&prefix))
            .unwrap();
        let (id, suffix) = entry
            .text
            .strip_prefix(&prefix)
            .unwrap()
            .split_once(' ')
            .unwrap();
        assert_eq!(uuid::Uuid::parse_str(id).unwrap().get_version_num(), 4);
        assert_eq!(suffix, "outcome=failed");
        assert!(!entry.text.contains("private"));
    }
}
#[test]
fn source_admission_id_failure_and_same_basename_replacement() {
    let (dir, mut state, id) = fixture();
    let path = dir.path().join("private source.mp4");
    let metadata = state.source(&id).unwrap().metadata.clone();
    let initial = state
        .admit_source(crate::video_post::test_retained(&path, metadata.clone()))
        .unwrap();
    let current = initial.source_id.unwrap();
    assert_ne!(current, id);
    assert_eq!(
        uuid::Uuid::parse_str(&current).unwrap().get_version_num(),
        4
    );
    let prepared = state
        .commit(&current, settings(), Some(&dir.path().join("new.mp4")))
        .unwrap()
        .unwrap();
    let bad_path = dir.path().join("bad.mp4");
    fs::write(&bad_path, b"abcdefghijklmnop").unwrap();
    let bad = crate::video_post::test_retained(&bad_path, metadata.clone());
    fs::remove_file(&bad_path).unwrap();
    assert!(state.admit_source(bad).is_err());
    assert_eq!(state.status(&prepared.id).unwrap().id, prepared.id);
    let replaced = state
        .admit_source(crate::video_post::test_retained(&path, metadata))
        .unwrap();
    assert_ne!(replaced.source_id.as_deref(), Some(current.as_str()));
    assert!(state.prepared.is_none());
    assert!(state.status(&prepared.id).is_err());
}
#[test]
fn operation_logs_success_cancel_and_failure_without_payloads() {
    for operation in ["prepare", "prepared-status"] {
        for (result, severity, outcome) in [
            (Ok(Some(())), "INFO", "checked"),
            (Ok(None), "INFO", "cancelled"),
            (
                Err("private /path name.mp4 OS error".into()),
                "ERROR",
                "failed",
            ),
        ] {
            let id = uuid::Uuid::new_v4();
            let _ = finish_operation(operation, "checked", id, result);
            let entries = crate::logs::native_logs(0);
            let matches: Vec<_> = entries
                .iter()
                .filter(|e| e.text.contains(&id.to_string()))
                .collect();
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0].text, format!("{severity}: video-post operation={operation} operationId={id} outcome={outcome}"));
            assert_eq!(matches[0].source, crate::logs::Source::Deas);
        }
    }
}
#[test]
fn permission_and_registration() {
    for name in [
        "native_video_post_prepare",
        "native_video_post_prepared_status",
    ] {
        assert!(include_str!("main.rs").contains(&format!("deas::{name},")));
        assert!(include_str!("lib.rs").contains(name));
        assert!(include_str!("../permissions/video_post.toml").contains(&format!("\"{name}\"")));
    }
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(capability["windows"], json!(["main"]));
    assert!(capability.get("remote").is_none());
    assert!(capability["permissions"]
        .as_array()
        .unwrap()
        .contains(&json!("allow-native-video-post-inspect")));
}
