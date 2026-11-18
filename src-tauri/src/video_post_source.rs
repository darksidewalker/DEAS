//! Session-only retention of the inspected TVE source: an opaque UUID stands for the native path,
//! so the webview can hand the source to the backend enhance recipe without ever seeing the path.
use crate::video_post::{RetainedSource, VideoSourceInspection};
use std::sync::{Arc, Mutex};

const INVALID: &str = "VIDEO_SOURCE_ID: Select the current unchanged source again.";

#[derive(Default)]
struct Session {
    source: Option<Arc<RetainedSource>>,
}
static SESSION: Mutex<Session> = Mutex::new(Session { source: None });

pub(crate) fn retain_source(source: RetainedSource) -> Result<VideoSourceInspection, String> {
    SESSION.lock().map_err(|_| INVALID)?.admit_source(source)
}
impl Session {
    fn admit_source(
        &mut self,
        mut source: RetainedSource,
    ) -> Result<VideoSourceInspection, String> {
        source.recheck()?;
        source.metadata.source_id = Some(uuid::Uuid::new_v4().to_string());
        let result = source.metadata.clone();
        self.source = Some(Arc::new(source));
        Ok(result)
    }
    fn source(&self, id: &str) -> Result<Arc<RetainedSource>, String> {
        strict_id(id)?;
        let source = self
            .source
            .as_ref()
            .filter(|s| s.metadata.source_id.as_deref() == Some(id))
            .ok_or(INVALID)?;
        source.recheck().map_err(|_| INVALID)?;
        Ok(Arc::clone(source))
    }
}
pub(crate) fn source(id: &str) -> Result<Arc<RetainedSource>, String> {
    SESSION.lock().map_err(|_| INVALID)?.source(id)
}

/// Hold admission across removal so a concurrent inspection cannot retain the deleted file.
pub(crate) fn with_deleted_source(
    file: std::fs::File,
    remove: impl FnOnce() -> Result<(), String>,
) -> Result<Option<String>, String> {
    let mut session = SESSION.lock().map_err(|_| INVALID)?;
    let source_id = session
        .source
        .as_ref()
        .filter(|source| source.recheck().is_ok() && source.matches_file(&file))
        .and_then(|source| source.metadata.source_id.clone());
    // Identity has been correlated under admission. The temporary clone must
    // not keep the filename pending while the remover verifies disappearance.
    #[cfg(windows)]
    let held_by_source = session
        .source
        .as_ref()
        .is_some_and(|source| source.holds_file(&file));
    drop(file);
    #[cfg(windows)]
    let restore = if held_by_source {
        let held = session.source.take().ok_or(INVALID)?;
        match Arc::try_unwrap(held) {
            Ok(source) => Some(source.release_deletion_handle()),
            Err(held) => {
                session.source = Some(held);
                return Err(
                    "Video source is still in use; finish the active operation before deleting it"
                        .into(),
                );
            }
        }
    } else {
        None
    };
    let result = remove();
    #[cfg(windows)]
    if result.is_err() {
        if let Some(source) = restore {
            session.source = source.restore_deletion_handle().ok().map(Arc::new);
        }
    }
    if result.is_ok() && source_id.is_some() {
        session.source = None;
    }
    result.map(|()| source_id)
}

pub(crate) fn strict_id(id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| INVALID)?;
    if parsed.get_version_num() != 4 || parsed.to_string() != id {
        return Err(INVALID.into());
    }
    Ok(())
}

/// Copies the retained TVE source into the backend input folder for the `video-enhance` recipe;
/// the retained path never leaves the native side.
#[tauri::command]
pub async fn native_video_post_upload(
    base_url: String,
    source_id: String,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    crate::logs::push(
        crate::logs::Source::Deas,
        "INFO: origin=video-post stage=upload outcome=start elapsed_ms=0",
    );
    let result = async {
        crate::validate_base_url(&base_url)?;
        let source = SESSION.lock().map_err(|_| INVALID)?.source(&source_id)?;
        let path = source
            .path()
            .to_str()
            .ok_or("Video path must be UTF-8")?
            .to_owned();
        crate::jobs::upload_input(&base_url, &path, true).await
    }
    .await;
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!(
            "INFO: origin=video-post stage=upload outcome={} elapsed_ms={}",
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
            started.elapsed().as_millis()
        ),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn native_processing_logs_upload_validation_without_private_values() {
        assert!(
            native_video_post_upload("private-endpoint".into(), "private-source".into())
                .await
                .is_err()
        );
        let lines: Vec<_> = crate::logs::after(0)
            .into_iter()
            .filter(|e| e.text.contains("origin=video-post stage=upload "))
            .collect();
        assert!(lines.iter().any(|e| e.text.contains("outcome=start")));
        assert!(lines
            .iter()
            .any(|e| e.text.contains("outcome=failed elapsed_ms=")));
        assert!(lines.iter().all(|e| !e.text.contains("private-")));
    }

    fn metadata(name: &str) -> VideoSourceInspection {
        VideoSourceInspection {
            source_id: None,
            name: name.into(),
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
        }
    }

    #[test]
    fn admission_issues_fresh_v4_ids_rejects_missing_files_and_replaces_the_previous_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private source.mp4");
        fs::write(&path, b"abcdefghijklmnop").unwrap();
        let mut state = Session::default();
        let first = state
            .admit_source(crate::video_post::test_retained(
                &path,
                metadata("private source.mp4"),
            ))
            .unwrap();
        let id = first.source_id.unwrap();
        assert!(strict_id(&id).is_ok());
        assert_eq!(state.source(&id).unwrap().path(), path);
        for bad in [
            "",
            "not-a-uuid",
            &id.to_uppercase(),
            &uuid::Uuid::new_v4().to_string(),
        ] {
            assert!(state.source(bad).is_err(), "{bad}");
        }
        let missing = dir.path().join("gone.mp4");
        fs::write(&missing, b"abcdefghijklmnop").unwrap();
        let retained = crate::video_post::test_retained(&missing, metadata("gone.mp4"));
        fs::remove_file(&missing).unwrap();
        assert!(state.admit_source(retained).is_err());
        assert!(
            state.source(&id).is_ok(),
            "a failed admission keeps the previous source"
        );
        let second = state
            .admit_source(crate::video_post::test_retained(
                &path,
                metadata("private source.mp4"),
            ))
            .unwrap();
        assert_ne!(second.source_id.as_deref(), Some(id.as_str()));
        assert!(state.source(&id).is_err());
        fs::remove_file(&path).unwrap();
        assert!(
            state.source(second.source_id.as_deref().unwrap()).is_err(),
            "a changed source fails the recheck"
        );
    }

    #[test]
    fn deletion_holds_admission_and_failed_removal_keeps_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.mp4");
        fs::write(&path, b"abcdefghijklmnop").unwrap();
        let inspected = retain_source(crate::video_post::test_retained(
            &path,
            metadata("source.mp4"),
        ))
        .unwrap();
        let result = with_deleted_source(fs::File::open(&path).unwrap(), || {
            assert!(
                SESSION.try_lock().is_err(),
                "inspection admission must wait for removal"
            );
            Err("removal failed".into())
        });
        assert_eq!(result, Err("removal failed".into()));
        assert!(source(inspected.source_id.as_deref().unwrap()).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn active_source_borrow_blocks_deletion_without_losing_inspection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("borrowed source.mp4");
        fs::write(&path, b"abcdefghijklmnop").unwrap();
        let inspected = retain_source(crate::video_post::test_retained(
            &path,
            metadata("source.mp4"),
        ))
        .unwrap();
        let id = inspected.source_id.unwrap();
        let held = source(&id).unwrap();
        let result = with_deleted_source(fs::File::open(&path).unwrap(), || {
            panic!("an active source must not be deleted")
        });
        assert!(result.unwrap_err().contains("still in use"));
        drop(held);
        assert!(source(&id).is_ok());
        assert_eq!(fs::read(&path).unwrap(), b"abcdefghijklmnop");
    }
    #[cfg(windows)]
    #[test]
    fn failed_deletion_never_restores_a_different_file_under_the_old_source_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.mp4");
        let saved = dir.path().join("original.mp4");
        fs::write(&path, b"abcdefghijklmnop").unwrap();
        let inspected = retain_source(crate::video_post::test_retained(
            &path,
            metadata("source.mp4"),
        ))
        .unwrap();
        let id = inspected.source_id.unwrap();
        let result = with_deleted_source(fs::File::open(&path).unwrap(), || {
            fs::rename(&path, &saved).unwrap();
            fs::write(&path, b"a different replacement source").unwrap();
            Err("injected failure".into())
        });
        assert!(result.is_err());
        assert!(source(&id).is_err());
        assert_eq!(fs::read(&saved).unwrap(), b"abcdefghijklmnop");
        assert_eq!(fs::read(&path).unwrap(), b"a different replacement source");
    }
    #[test]
    fn permission_and_registration() {
        for name in ["native_video_post_upload", "native_video_post_inspect_path"] {
            assert!(include_str!("main.rs").contains(&format!("deas::{name},")));
            assert!(include_str!("lib.rs").contains(name));
            assert!(include_str!("../permissions/video_post.toml").contains(&format!("\"{name}\"")));
        }
    }
}
