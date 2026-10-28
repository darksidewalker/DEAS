//! Session-only source/output authority. Metadata admission is not execution readiness.
use crate::video_post::{
    finish_operation, validate_title, RetainedSource, VideoSourceInspection, INSPECTING,
};
use crate::video_post_draft::{build_draft, DraftProfile, DraftSettings, DraftSource};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

const INVALID: &str = "VIDEO_PREPARE: Select the current unchanged source and a new MP4 destination in an existing folder.";
const STALE: &str =
    "VIDEO_PREPARED: Prepared selection is unavailable or changed; prepare it again.";
const LIMIT: &str = "VIDEO_PREPARE_LIMIT: Preparation requires an unblocked source up to 512 pixels per edge, known duration up to 10 seconds, positive rate up to 120 fps, at most one audio stream and no subtitles.";
const PLATFORM: &str = "VIDEO_PREPARE_PLATFORM: Output preparation is available on Linux only.";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareSettings {
    pub scale: u32,
    pub profile: PrepareProfile,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub enum PrepareProfile {
    #[serde(rename = "mp4-h264")]
    Mp4H264,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSnapshot {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub output_name: String,
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub settings: PrepareSettings,
    pub model_bound: bool,
    pub timing_verified: bool,
    pub encoder_verified: bool,
    pub processing_ready: bool,
}
struct Prepared {
    snapshot: PreparedSnapshot,
    destination: PathBuf,
    parent: File,
    parent_identity: (u64, u64),
}
#[derive(Default)]
struct Session {
    source: Option<Arc<RetainedSource>>,
    prepared: Option<Prepared>,
}
static SESSION: Mutex<Session> = Mutex::new(Session {
    source: None,
    prepared: None,
});

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
        self.replace_source(source);
        Ok(result)
    }
    fn replace_source(&mut self, source: RetainedSource) {
        self.source = Some(Arc::new(source));
        self.prepared = None;
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
    fn commit(
        &mut self,
        source_id: &str,
        settings: PrepareSettings,
        destination: Option<&Path>,
    ) -> Result<Option<PreparedSnapshot>, String> {
        // Cancellation leaves the last successful preparation untouched.
        let Some(destination) = destination else {
            return Ok(None);
        };
        let source = self.source(source_id)?;
        let draft = admissible(&source.metadata, &settings)?;
        let (parent, parent_identity, output_name) = destination_parent(destination)?;
        source.recheck().map_err(|_| INVALID)?;
        let snapshot = PreparedSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            source_id: source_id.into(),
            source_name: source.metadata.name.clone(),
            output_name,
            width: draft.output.width,
            height: draft.output.height,
            fps_numerator: draft.output.fps_numerator,
            fps_denominator: draft.output.fps_denominator,
            settings,
            model_bound: false,
            timing_verified: false,
            encoder_verified: false,
            processing_ready: false,
        };
        let prepared = Prepared {
            snapshot: snapshot.clone(),
            destination: destination.to_owned(),
            parent,
            parent_identity,
        };
        prepared.recheck()?;
        self.prepared = Some(prepared);
        Ok(Some(snapshot))
    }
    fn status(&mut self, id: &str) -> Result<PreparedSnapshot, String> {
        strict_id(id).map_err(|_| STALE)?;
        let prepared = self
            .prepared
            .as_ref()
            .filter(|p| p.snapshot.id == id)
            .ok_or(STALE)?;
        if self.source(&prepared.snapshot.source_id).is_err() || prepared.recheck().is_err() {
            self.prepared = None;
            return Err(STALE.into());
        }
        Ok(prepared.snapshot.clone())
    }
}
pub(crate) fn strict_id(id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| INVALID)?;
    if parsed.get_version_num() != 4 || parsed.to_string() != id {
        return Err(INVALID.into());
    }
    Ok(())
}
fn admissible(
    source: &VideoSourceInspection,
    settings: &PrepareSettings,
) -> Result<crate::video_post_draft::VideoPostDraft, String> {
    if source.width > 512
        || source.height > 512
        || !source
            .duration_seconds
            .is_some_and(|d| d.is_finite() && d > 0.0 && d <= 10.0)
        || source.fps_numerator == 0
        || source.fps_denominator == 0
        || u64::from(source.fps_numerator) > 120 * u64::from(source.fps_denominator)
        || !source.blockers.is_empty()
        || source.audio_streams > 1
        || source.subtitle_streams != 0
    {
        return Err(LIMIT.into());
    }
    let draft = build_draft(
        DraftSource {
            name: source.name.clone(),
            width: source.width,
            height: source.height,
            fps_numerator: source.fps_numerator,
            fps_denominator: source.fps_denominator,
            audio_streams: source.audio_streams as u32,
            subtitle_streams: source.subtitle_streams as u32,
            blockers: source.blockers.clone(),
        },
        DraftSettings {
            scale: settings.scale,
            profile: DraftProfile::Mp4H264,
        },
    )?;
    if !draft.blockers.is_empty() {
        return Err(LIMIT.into());
    }
    Ok(draft)
}
fn directory_identity(file: &File) -> Result<(u64, u64), String> {
    let metadata = file.metadata().map_err(|_| INVALID)?;
    if !metadata.is_dir() {
        return Err(INVALID.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        Err(PLATFORM.into())
    }
}
fn destination_parent(path: &Path) -> Result<(File, (u64, u64), String), String> {
    if !cfg!(target_os = "linux") {
        return Err(PLATFORM.into());
    }
    if !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
        || path.extension().and_then(|s| s.to_str()) != Some("mp4")
    {
        return Err(INVALID.into());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
        .ok_or(INVALID)?;
    // Any leaf entry (including dangling links, hardlinks and FIFOs) is forbidden.
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        _ => return Err(INVALID.into()),
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NONBLOCK);
    }
    let parent = options
        .open(path.parent().ok_or(INVALID)?)
        .map_err(|_| INVALID)?;
    let identity = directory_identity(&parent)?;
    Ok((parent, identity, name.into()))
}
impl Prepared {
    fn recheck(&self) -> Result<(), String> {
        let (_, current, _) = destination_parent(&self.destination)?;
        if directory_identity(&self.parent)? != self.parent_identity
            || current != self.parent_identity
        {
            return Err(INVALID.into());
        }
        Ok(())
    }
}

// Only the actual managed consumer receives this native authority; never serialize paths.
pub(crate) struct RenderAuthority {
    source: Arc<RetainedSource>,
    prepared: Prepared,
}
impl RenderAuthority {
    #[cfg(target_os = "linux")]
    pub(crate) fn source_path(&self) -> &Path {
        self.source.path()
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn destination(&self) -> &Path {
        &self.prepared.destination
    }
    pub(crate) fn snapshot(&self) -> &PreparedSnapshot {
        &self.prepared.snapshot
    }
    pub(crate) fn recheck(&self) -> Result<(), String> {
        self.source.recheck()?;
        self.prepared.recheck()
    }
}
pub(crate) fn authorize_render(id: &str) -> Result<RenderAuthority, String> {
    strict_id(id)?;
    let session = SESSION.lock().map_err(|_| STALE)?;
    let p = session
        .prepared
        .as_ref()
        .filter(|p| p.snapshot.id == id)
        .ok_or(STALE)?;
    let source = session.source(&p.snapshot.source_id)?;
    let authority = RenderAuthority {
        source,
        prepared: Prepared {
            snapshot: p.snapshot.clone(),
            destination: p.destination.clone(),
            parent: p.parent.try_clone().map_err(|_| STALE)?,
            parent_identity: p.parent_identity,
        },
    };
    authority.recheck()?;
    Ok(authority)
}

#[tauri::command]
pub async fn native_video_post_prepare(
    source_id: String,
    settings: PrepareSettings,
    title: String,
) -> Result<Option<PreparedSnapshot>, String> {
    let operation = uuid::Uuid::new_v4();
    let result = async {
        validate_title(&title)?;
        if !cfg!(target_os = "linux") {
            return Err(PLATFORM.into());
        }
        let _permit = INSPECTING.try_acquire().map_err(|_| {
            "VIDEO_BUSY: A video chooser is already open; finish it before trying again."
        })?;
        let source = SESSION.lock().map_err(|_| INVALID)?.source(&source_id)?;
        admissible(&source.metadata, &settings)?;
        let stem = Path::new(&source.metadata.name)
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or(INVALID)?;
        let selected = rfd::AsyncFileDialog::new()
            .set_title(title)
            .add_filter("MP4", &["mp4"])
            .set_file_name(format!("{stem}_processed.mp4"))
            .save_file()
            .await;
        let mut state = SESSION.lock().map_err(|_| INVALID)?;
        // Recheck after the dialog, including cancellation; never alter state on refusal.
        state.source(&source_id)?;
        state.commit(&source_id, settings, selected.as_ref().map(|f| f.path()))
    }
    .await;
    finish_operation("prepare", "prepared", operation, result)
}
#[tauri::command]
pub fn native_video_post_prepared_status(id: String) -> Result<PreparedSnapshot, String> {
    let operation = uuid::Uuid::new_v4();
    let result = SESSION
        .lock()
        .map_err(|_| STALE.to_owned())
        .and_then(|mut s| s.status(&id))
        .map(Some);
    finish_operation("prepared-status", "checked", operation, result)?.ok_or_else(|| STALE.into())
}

#[cfg(all(test, target_os = "linux", feature = "video-upscale"))]
pub(crate) fn test_real_render_authority(source: &Path, destination: &Path) -> RenderAuthority {
    let metadata = crate::video_post::inspect_source(source).unwrap();
    let mut session = Session::default();
    let selected = session
        .admit_source(crate::video_post::test_retained(source, metadata))
        .unwrap();
    let id = selected.source_id.unwrap();
    session
        .commit(
            &id,
            PrepareSettings {
                scale: 2,
                profile: PrepareProfile::Mp4H264,
            },
            Some(destination),
        )
        .unwrap();
    RenderAuthority {
        source: session.source.take().unwrap(),
        prepared: session.prepared.take().unwrap(),
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn test_render_authority(source: &Path, destination: &Path) -> RenderAuthority {
    let metadata = VideoSourceInspection {
        source_id: Some(uuid::Uuid::new_v4().to_string()),
        name: "source.mp4".into(),
        width: 16,
        height: 16,
        fps_numerator: 25,
        fps_denominator: 1,
        duration_seconds: Some(0.16),
        pixel_format: "yuv420p".into(),
        field_order: "progressive".into(),
        color_transfer: "bt709".into(),
        audio_streams: 0,
        subtitle_streams: 0,
        blockers: vec![],
        timing_verified: false,
        processing_ready: false,
    };
    let id = metadata.source_id.clone().unwrap();
    let mut session = Session::default();
    session.replace_source(crate::video_post::test_retained(source, metadata));
    session
        .commit(
            &id,
            PrepareSettings {
                scale: 2,
                profile: PrepareProfile::Mp4H264,
            },
            Some(destination),
        )
        .unwrap();
    RenderAuthority {
        source: session.source.take().unwrap(),
        prepared: session.prepared.take().unwrap(),
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "video_post_prepare_tests.rs"]
mod tests;
