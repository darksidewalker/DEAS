//! Explicit, confirmed deletion of regular media in the native-owned Input/Output roots.
use crate::downloads::fs::Anchor;
use serde::Serialize;
use std::{
    fs::File,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct DeleteReport {
    deleted: Vec<String>,
    failed: Vec<String>,
    #[serde(rename = "deletedVideoSourceIds")]
    deleted_video_source_ids: Vec<String>,
    // Returned over IPC, never logged: recovery paths can contain private filenames.
    errors: Vec<String>,
}

struct Candidate {
    path: PathBuf,
    root: PathBuf,
    root_anchor: Anchor,
    parent: Anchor,
    file: Option<File>,
    metadata: std::fs::Metadata,
}

fn prepare(roots: &[PathBuf], paths: &[String]) -> Result<Vec<Candidate>, String> {
    if paths.is_empty() || paths.len() > 500 {
        return Err("Select between 1 and 500 media files".into());
    }
    let mut seen = std::collections::HashSet::new();
    #[cfg(windows)]
    let mut identities = std::collections::HashSet::new();
    paths
        .iter()
        .map(|path| {
            let source = Path::new(path);
            if !seen.insert(source.to_path_buf()) {
                return Err("Duplicate media selection".into());
            }
            let root = roots
                .iter()
                .find(|root| source.starts_with(root))
                .ok_or("Only files in the owned Input/Output folders can be deleted")?;
            // Reuse the physical-media boundary: reject traversal, links/reparse parents,
            // directories, read-only files, project assets and ungrouped sidecars.
            let (_, file) = crate::media::star::preflight(root, source)?;
            #[cfg(windows)]
            {
                let identity = crate::win::identity(&file)?;
                // A second admitted reader of the same file would keep deletion pending.
                if !identities.insert(identity) {
                    return Err("Duplicate physical media selection".into());
                }
            }
            Ok(Candidate {
                path: source.to_path_buf(),
                root: root.clone(),
                root_anchor: Anchor::open(root)?,
                parent: Anchor::open(source.parent().ok_or("Missing media parent")?)?,
                metadata: file.metadata().map_err(|_| "Cannot inspect media")?,
                file: Some(file),
            })
        })
        .collect()
}

fn remove(candidate: &mut Candidate) -> Result<(), String> {
    remove_checked(candidate, |_| Ok(()))
}

// Checkpoints bracket capture so regressions can deterministically inject external edits.
fn remove_checked(
    candidate: &mut Candidate,
    mut checkpoint: impl FnMut(bool) -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    let _ = &mut checkpoint;
    // Revalidate after batch admission: another writer may add sidecars or keep writing.
    let (_, current) = crate::media::star::preflight(&candidate.root, &candidate.path)?;
    let metadata = current.metadata().map_err(|_| "Cannot inspect media")?;
    if metadata.len() != candidate.metadata.len()
        || metadata.modified().ok().is_none()
        || metadata.modified().ok() != candidate.metadata.modified().ok()
    {
        return Err("Media changed after selection; nothing was deleted".into());
    }
    let admitted = candidate
        .file
        .as_ref()
        .ok_or("Media inspection handle was already released")?;
    let name = candidate
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid media filename")?;
    if Anchor::open(&candidate.root)?.identity()? != candidate.root_anchor.identity()?
        || Anchor::open(candidate.path.parent().ok_or("Missing media parent")?)?.identity()?
            != candidate.parent.identity()?
        || !candidate.parent.owns_partial(name, admitted)
    {
        return Err("Media identity changed; nothing was deleted".into());
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let folder = format!(".deas-delete-{}", uuid::Uuid::new_v4());
        let quarantine = candidate.parent.create(&folder)?;
        let folder = std::ffi::CString::new(folder).unwrap();
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid media filename")?;
        let captured = c"media";
        let rename =
            |from: &Anchor, source: &std::ffi::CStr, to: &Anchor, target: &std::ffi::CStr| {
                (unsafe {
                    libc::renameat2(
                        from.0.as_raw_fd(),
                        source.as_ptr(),
                        to.0.as_raw_fd(),
                        target.as_ptr(),
                        libc::RENAME_NOREPLACE,
                    )
                }) == 0
            };
        let cleanup = || {
            // Empty directories only; never recursively clean up retained recovery data.
            unsafe {
                libc::unlinkat(
                    candidate.parent.0.as_raw_fd(),
                    folder.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            };
        };
        if let Err(error) = checkpoint(false) {
            cleanup();
            return Err(error);
        }
        // Capture the name atomically, then validate inside the private same-filesystem directory.
        if !rename(&candidate.parent, &name, &quarantine, captured) {
            cleanup();
            return Err("Cannot capture media for deletion; nothing was deleted".into());
        }
        let result = (|| {
            checkpoint(true)?;
            let metadata = admitted
                .metadata()
                .map_err(|_| "Cannot inspect captured media")?;
            if !quarantine.owns_partial("media", admitted)
                || metadata.len() != candidate.metadata.len()
                || metadata.modified().ok().is_none()
                || metadata.modified().ok() != candidate.metadata.modified().ok()
                || Anchor::open(&candidate.root)?.identity()? != candidate.root_anchor.identity()?
                || Anchor::open(candidate.path.parent().ok_or("Missing media parent")?)?
                    .identity()?
                    != candidate.parent.identity()?
            {
                return Err("Media changed during deletion; nothing was deleted".to_owned());
            }
            // shortcut: private staging does not isolate same-user attacks or held writers, require stronger isolation before supporting that threat model.
            if unsafe { libc::unlinkat(quarantine.0.as_raw_fd(), captured.as_ptr(), 0) } != 0 {
                return Err("Cannot delete captured media".into());
            }
            Ok(())
        })();
        if let Err(error) = result {
            if rename(&quarantine, captured, &candidate.parent, &name) {
                cleanup();
                let parent = std::fs::read_link(format!("/proc/self/fd/{}", candidate.parent.0.as_raw_fd()))
                    .map_err(|_| format!("{error}; restored into held parent; inspect {} and renamed parent directories", candidate.path.display()))?;
                return Err(format!(
                    "{error}; retained at {}",
                    parent.join(name.to_str().unwrap()).display()
                ));
            }
            let recovery = std::fs::read_link(format!("/proc/self/fd/{}", quarantine.0.as_raw_fd()))
                .map_err(|_| format!("{error}; recovery directory path could not be resolved; inspect {} beneath the original or renamed parent of {}", folder.to_string_lossy(), candidate.path.display()))?;
            return Err(format!(
                "{error}; restore could not complete without overwrite; recovery: {}",
                recovery.join("media").display()
            ));
        }
        cleanup();
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            FILE_FLAG_OPEN_REPARSE_POINT,
        };
        // DELETE | GENERIC_READ; delete by the verified handle rather than a second path lookup.
        let file = std::fs::OpenOptions::new()
            .access_mode(0x0001_0000 | 0x8000_0000)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&candidate.path)
            .map_err(|_| "Cannot open media for deletion; it may be in use")?;
        if crate::win::identity(&file)? != crate::win::identity(admitted)? {
            return Err("Media identity changed; nothing was deleted".into());
        }
        // Release our preflight/admission readers before marking deletion. Even
        // share-delete readers keep a Windows filename pending until they close.
        drop(current);
        drop(candidate.file.take());
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as _,
                FileDispositionInfo,
                std::ptr::addr_of!(disposition).cast(),
                std::mem::size_of_val(&disposition) as u32,
            )
        } == 0
        {
            return Err("Cannot delete media file; it may be in use".into());
        }
        // A disposed name stays PENDING (still listed, and re-creating the same path
        // fails with ACCESS_DENIED) while a live WebView2 <video> preview or backend
        // stream keeps a share-delete handle open. Drop ours, then require the name
        // to actually disappear before reporting success.
        drop(file);
        for attempt in 0..10 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            match candidate.path.try_exists() {
                Ok(false) => return Ok(()),
                Ok(true) => {}
                // Windows denies metadata queries while another handle keeps
                // the disposed name pending. This is not proof of disappearance.
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
                Err(_) => return Err("Cannot verify deletion".into()),
            }
        }
        Err("Media was marked for deletion but is still open in a preview or the backend; it clears once the player closes; do not reuse this filename".into())
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    Err("Safe media deletion requires Linux or Windows".into())
}

fn delete(roots: &[PathBuf], paths: &[String]) -> Result<DeleteReport, String> {
    // Validate the entire batch before touching any file. Report physical partial
    // failures explicitly; successfully removed files must never be retried blindly.
    let candidates = prepare(roots, paths)?;
    let mut report = DeleteReport {
        deleted: vec![],
        failed: vec![],
        deleted_video_source_ids: vec![],
        errors: vec![],
    };
    for mut candidate in candidates {
        let path = candidate.path.to_string_lossy().into_owned();
        let result = (|| {
            let file = candidate
                .file
                .as_ref()
                .ok_or("Missing media inspection handle")?
                .try_clone()
                .map_err(|_| "Cannot retain media identity for deletion")?;
            crate::video_post_source::with_deleted_source(file, || remove(&mut candidate))
        })();
        match result {
            Ok(source_id) => {
                report.deleted.push(path);
                report.deleted_video_source_ids.extend(source_id);
            }
            Err(error) => {
                report.errors.push(format!("{path}: {error}"));
                report.failed.push(path);
            }
        }
    }
    Ok(report)
}

fn diagnostic(failed: bool) {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    if failed {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    crate::logs::push(
        crate::logs::Source::Deas,
        if failed {
            "ERROR: Media operation=delete failed or partially completed; inspect the selection for retry (repeats limited to once per minute)"
        } else {
            "INFO: Media operation=delete completed"
        },
    );
}

#[tauri::command]
pub fn native_media_delete(
    paths: Vec<String>,
    engine: tauri::State<'_, crate::install::Engine>,
    jobs: tauri::State<'_, crate::jobs::Jobs>,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<DeleteReport, String> {
    let result = (|| {
        let _guard = operations.enter()?;
        let roots = [
            crate::media::star::output_root(&engine)?,
            crate::media::intake::input_root(&engine)?,
        ];
        crate::jobs::with_idle_media_edit(|| jobs.with_idle_media_edit(|| delete(&roots, &paths)))
    })();
    diagnostic(
        result
            .as_ref()
            .map_or(true, |report| !report.failed.is_empty()),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Vec<PathBuf>, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Output");
        std::fs::create_dir(&root).unwrap();
        let paths = ["one.png", "two ü.jpg"]
            .map(|name| {
                let path = root.join(name);
                std::fs::write(&path, b"fixture").unwrap();
                path.to_str().unwrap().to_owned()
            })
            .to_vec();
        (dir, vec![root], paths)
    }
    #[test]
    fn deletion_correlates_only_the_unchanged_retained_video_identity() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Output");
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let path = root.join("source.mp4");
        let same_name = other.join("source.mp4");
        for file in [&path, &same_name] {
            std::fs::write(file, b"abcdefghijklmnop").unwrap();
        }
        let metadata = crate::video_post::VideoSourceInspection {
            source_id: None,
            name: "source.mp4".into(),
            width: 512,
            height: 256,
            fps_numerator: 24,
            fps_denominator: 1,
            duration_seconds: Some(1.0),
            pixel_format: "yuv420p".into(),
            field_order: "progressive".into(),
            color_transfer: "bt709".into(),
            audio_streams: 0,
            subtitle_streams: 0,
            blockers: vec![],
            timing_verified: false,
            processing_ready: false,
        };
        let inspected = crate::video_post_source::retain_source(crate::video_post::test_retained(
            &path,
            metadata.clone(),
        ))
        .unwrap();
        let id = inspected.source_id.unwrap();
        let roots = [root];
        let report = delete(&roots, &[same_name.to_str().unwrap().into()]).unwrap();
        assert!(
            report.deleted_video_source_ids.is_empty(),
            "never correlate by basename"
        );
        assert!(crate::video_post_source::source(&id).is_ok());
        let report = delete(&roots, &[path.to_str().unwrap().into()]).unwrap();
        assert_eq!(report.deleted, [path.to_str().unwrap()], "{report:?}");
        assert_eq!(
            report.deleted_video_source_ids.as_slice(),
            std::slice::from_ref(&id)
        );
        assert_eq!(
            serde_json::to_value(report).unwrap()["deletedVideoSourceIds"],
            serde_json::json!([id])
        );
        assert!(crate::video_post_source::source(&id).is_err());

        std::fs::write(&path, b"abcdefghijklmnop").unwrap();
        crate::video_post_source::retain_source(crate::video_post::test_retained(&path, metadata))
            .unwrap();
        std::fs::write(&path, b"changed identity, same path").unwrap();
        let report = delete(&roots, &[path.to_str().unwrap().into()]).unwrap();
        assert!(
            report.deleted_video_source_ids.is_empty(),
            "changed retained identities stay guarded"
        );
        assert_eq!(report.deleted, [path.to_str().unwrap()], "{report:?}");
    }

    #[test]
    fn removes_only_confirmed_regular_files_and_keeps_unselected_files() {
        let (_dir, roots, paths) = fixture();
        let report = crate::jobs::Jobs::default()
            .with_idle_media_edit(|| delete(&roots, &paths[..1]))
            .unwrap();
        assert_eq!(report.deleted, paths[..1], "{report:?}");
        assert!(report.failed.is_empty());
        assert!(!Path::new(&paths[0]).exists());
        assert!(Path::new(&paths[1]).exists());
    }
    #[test]
    fn bulk_deletion_releases_handles_and_allows_immediate_filename_reuse() {
        let (_dir, roots, paths) = fixture();
        let report = delete(&roots, &paths).unwrap();
        assert_eq!(report.deleted, paths, "{report:?}");
        assert!(report.failed.is_empty());
        for path in &paths {
            assert!(!Path::new(path).try_exists().unwrap());
            std::fs::write(path, b"new output at the same filename").unwrap();
            assert_eq!(
                std::fs::read(path).unwrap(),
                b"new output at the same filename"
            );
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn replacement_after_validation_is_captured_but_never_deleted() {
        let (_dir, roots, paths) = fixture();
        let mut candidates = prepare(&roots, &paths[..1]).unwrap();
        let held = roots[0].join("held.png");
        let error = remove_checked(&mut candidates[0], |captured| {
            if !captured {
                std::fs::rename(&paths[0], &held).unwrap();
                std::fs::write(&paths[0], b"replacement").unwrap();
            }
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("retained at"), "{error}");
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"replacement");
        assert_eq!(std::fs::read(held).unwrap(), b"fixture");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn source_recreated_after_capture_is_not_unlinked() {
        let (_dir, roots, paths) = fixture();
        let mut candidates = prepare(&roots, &paths[..1]).unwrap();
        remove_checked(&mut candidates[0], |captured| {
            if captured {
                std::fs::write(&paths[0], b"replacement").unwrap();
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"replacement");
        assert_eq!(
            candidates[0]
                .file
                .as_ref()
                .unwrap()
                .metadata()
                .unwrap()
                .len(),
            7
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_delete_restores_or_exposes_recovery_without_clobber() {
        for occupied in [false, true] {
            let (_dir, roots, paths) = fixture();
            let mut candidates = prepare(&roots, &paths[..1]).unwrap();
            let error = remove_checked(&mut candidates[0], |captured| {
                if captured {
                    if occupied {
                        std::fs::write(&paths[0], b"replacement").unwrap();
                    }
                    return Err("injected deletion failure".into());
                }
                Ok(())
            })
            .unwrap_err();
            if occupied {
                assert_eq!(std::fs::read(&paths[0]).unwrap(), b"replacement");
                let recovery = error.split("recovery: ").nth(1).unwrap();
                assert_eq!(std::fs::read(recovery).unwrap(), b"fixture");
                assert!(error.contains("without overwrite"), "{error}");
            } else {
                assert!(error.contains("retained at"), "{error}");
                assert_eq!(std::fs::read(&paths[0]).unwrap(), b"fixture");
                assert_eq!(std::fs::read_dir(&roots[0]).unwrap().count(), 2);
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn captured_content_change_is_preserved_and_rolled_back() {
        use std::os::unix::fs::FileExt;
        let (_dir, roots, paths) = fixture();
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&paths[0])
            .unwrap();
        let mut candidates = prepare(&roots, &paths[..1]).unwrap();
        assert!(remove_checked(&mut candidates[0], |captured| {
            if captured {
                writer.write_all_at(b"unfinished writer", 0).unwrap();
            }
            Ok(())
        })
        .unwrap_err()
        .contains("retained at"));
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"unfinished writer");
    }

    #[cfg(windows)]
    #[test]
    fn pending_deletion_is_reported_while_a_share_delete_holder_is_open() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, roots, paths) = fixture();
        let mut candidates = prepare(&roots, &paths[..1]).unwrap();
        // A WebView2-style preview holder: share READ|WRITE|DELETE keeps the name
        // pending after disposition, which must surface as an actionable failure.
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2 | 0x4)
            .open(&paths[0])
            .unwrap();
        let error = remove(&mut candidates[0]).unwrap_err();
        assert!(error.contains("still open in a preview"), "{error}");
        drop(holder);
        assert!(!Path::new(&paths[0]).try_exists().unwrap());
        std::fs::write(&paths[0], b"filename can be reused").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn delayed_preview_release_completes_deletion_and_allows_filename_reuse() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, roots, paths) = fixture();
        let mut candidates = prepare(&roots, &paths[..1]).unwrap();
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2 | 0x4)
            .open(&paths[0])
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            drop(holder);
        });
        let result = remove(&mut candidates[0]);
        release.join().unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert!(!Path::new(&paths[0]).try_exists().unwrap());
        std::fs::write(&paths[0], b"new output").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_case_and_hardlink_identities_reject_the_entire_batch() {
        for hardlink in [false, true] {
            let (_dir, roots, paths) = fixture();
            let alias = roots[0].join(if hardlink { "alias.png" } else { "ONE.PNG" });
            if hardlink {
                std::fs::hard_link(&paths[0], &alias).unwrap();
            }
            let error =
                delete(&roots, &[paths[0].clone(), alias.to_str().unwrap().into()]).unwrap_err();
            assert!(
                error.contains("Duplicate physical media selection"),
                "{error}"
            );
            assert_eq!(std::fs::read(&paths[0]).unwrap(), b"fixture");
            assert_eq!(std::fs::read(alias).unwrap(), b"fixture");
            assert!(Path::new(&paths[1]).exists());
        }
    }

    #[test]
    fn validates_entire_batch_before_deletion() {
        let (_dir, roots, paths) = fixture();
        for invalid in [
            roots[0].to_string_lossy().into_owned(),
            roots[0]
                .join("../outside.png")
                .to_string_lossy()
                .into_owned(),
            "relative.png".into(),
        ] {
            assert!(delete(&roots, &[paths[0].clone(), invalid]).is_err());
            assert!(Path::new(&paths[0]).exists());
        }
        assert!(delete(&roots, &[paths[0].clone(), paths[0].clone()]).is_err());
        assert!(delete(&roots, &[]).is_err());
        assert!(delete(&roots, &vec![paths[0].clone(); 501]).is_err());
    }
    #[test]
    fn refuses_sidecars_and_project_assets_without_deleting_anything() {
        let (_dir, roots, paths) = fixture();
        let sidecar = Path::new(&paths[1]).with_extension("json");
        std::fs::write(&sidecar, b"{}").unwrap();
        assert!(delete(&roots, &paths).is_err());
        assert!(Path::new(&paths[0]).exists());
        assert!(sidecar.exists());
        std::fs::remove_file(sidecar).unwrap();
        std::fs::write(roots[0].join(crate::projects::MANIFEST), b"{}").unwrap();
        assert!(delete(&roots, &paths).is_err());
        assert!(Path::new(&paths[0]).exists());
    }
    #[test]
    fn rejects_namespace_replacement_and_reports_partial_failure() {
        let (_dir, roots, paths) = fixture();
        let mut candidates = prepare(&roots, &paths).unwrap();
        std::fs::rename(&paths[0], roots[0].join("held.png")).unwrap();
        std::fs::write(&paths[0], b"replacement").unwrap();
        assert!(remove(&mut candidates[0]).is_err());
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"replacement");
        let result = remove(&mut candidates[1]);
        assert!(result.is_ok(), "{result:?}");
        drop(candidates);
        assert!(!Path::new(&paths[1]).exists());
    }
    #[test]
    fn rechecks_content_and_sidecars_before_each_removal() {
        let (_dir, roots, paths) = fixture();
        let mut candidates = prepare(&roots, &paths).unwrap();
        std::fs::write(&paths[0], b"unfinished replacement content").unwrap();
        std::fs::write(Path::new(&paths[1]).with_extension("json"), b"{}").unwrap();
        assert!(remove(&mut candidates[0]).is_err());
        assert!(remove(&mut candidates[1]).is_err());
        assert_eq!(
            std::fs::read(&paths[0]).unwrap(),
            b"unfinished replacement content"
        );
        assert!(Path::new(&paths[1]).exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_files_parents_and_shared_writable_folders() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (_dir, roots, paths) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let foreign = outside.path().join("foreign.png");
        std::fs::write(&foreign, b"foreign").unwrap();
        let linked = roots[0].join("linked.png");
        symlink(&foreign, &linked).unwrap();
        symlink(outside.path(), roots[0].join("linked-folder")).unwrap();
        for path in [linked, roots[0].join("linked-folder/foreign.png")] {
            assert!(delete(
                &roots,
                &[paths[0].clone(), path.to_string_lossy().into_owned()]
            )
            .is_err());
        }
        std::fs::set_permissions(&roots[0], std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(delete(&roots, &paths).is_err());
        assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign");
        assert!(Path::new(&paths[0]).exists());
    }

    #[test]
    fn command_is_registered_permissioned_and_logs_no_paths() {
        assert!(include_str!("main.rs").contains("deas::native_media_delete"));
        assert!(include_str!("../permissions/media.toml").contains("\"native_media_delete\""));
        diagnostic(true);
        diagnostic(true);
        let logs = crate::logs::native_logs(0);
        let entries: Vec<_> = logs
            .iter()
            .filter(|entry| entry.text.contains("Media operation=delete failed"))
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].text.contains(".png"));
    }
}
