//! The uploads plane (API-DESIGN §11 "only `/v1/uploads` writes bytes; pathwall
//! single grammar; caps 50 MiB upload / 100 MiB job", §SR14.4 placement law, ruling
//! E13): reference bytes in, a ComfyUI-relative name out.
//!
//! Placement is stock, never restated: the bridge hands the bytes to the same
//! functions the UI uses — `jobs::native_mask_upload` (masks to `deas-masks/` with a
//! fresh name, PNG-magic-checked stock-side) and `jobs::upload_input` (images/audio to
//! `deas-inputs/`, videos to the input ROOT as `deas-input-<uuid>.<ext>` because core
//! `LoadVideo` lists top-level input files only). Those seams hit the running owned
//! backend; with no backend running they refuse, and the plane surfaces that honestly.
//!
//! The plane's own law, enforced before the seam ever sees a byte:
//!
//! * the §11 NETWORK upload cap — `caps.uploadSingleMiB`, default 50 MiB, whose one home
//!   is [`super::caps`] (LEG AF2-M19a deleted the plane's duplicate 50 MiB constant when
//!   the E24 placement law removed the last code that consulted it: the cap is a network
//!   law, and an on-disk file under a served root pays no cap at all; the 100 MiB job cap
//!   belongs to the M4 drain);
//! * the closed content table — the stock sniffer's magic-bytes verdict must match
//!   the requested kind, and masks are PNG-only (the stock mask seam's own law);
//! * the pathwall — a supplied `name` must be a bare filename: no separators, no
//!   traversal, no control characters. Root placements are always minted by the stock
//!   seam (uuid, `overwrite=false`), so no client string ever reaches a root path.
//!
//! Ruling E22 (LEG M17a) grows the plane one notch: `?subfolder=<grammar>` places
//! bytes NESTED under `deas-inputs/` through the stock fence `jobs::upload_scoped`
//! (same multipart law, `overwrite=false` kept, backend collision law: identical hash
//! keeps the existing file, different bytes walk the ` (N)` rename loop). Inside a
//! subfolder the `name` param is HONORED (single final segment, scoped grammar below);
//! at the root it stays validated-then-discarded (the uuid law). Masks keep the stock
//! `mask_name` uuid law — subfolder is refused for them. The answer reports the
//! BACKEND's final placement and whether the requested name landed verbatim (`actual`).

use futures_util::future::BoxFuture;

use super::errors::{ApiError, ErrorKind};

/// The magic-bytes window the stock sniffer reads (`jobs::sniff_media`'s own 64).
pub(crate) const SNIFF_HEAD_BYTES: usize = 64;
/// Pathwall bound for a supplied bare filename.
const MAX_NAME_BYTES: usize = 255;
/// E22 subfolder grammar: total bytes and segment count ceilings.
const MAX_SUBFOLDER_BYTES: usize = 128;
const MAX_SUBFOLDER_SEGMENTS: usize = 8;

/// The closed upload-kind vocabulary (API-DESIGN §4: image/audio/video are one route
/// stock-side; the mask kind rides the stock mask seam).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UploadKind {
    Image,
    Audio,
    Video,
    Mask,
}

impl UploadKind {
    /// The kind vocabulary, surfaced verbatim in every refusal hint.
    pub(crate) const VOCABULARY: &'static str = "image|audio|video|mask";

    pub(crate) fn parse(word: &str) -> Option<Self> {
        match word {
            "image" => Some(Self::Image),
            "audio" => Some(Self::Audio),
            "video" => Some(Self::Video),
            "mask" => Some(Self::Mask),
            _ => None,
        }
    }

    pub(crate) const fn word(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Mask => "mask",
        }
    }

    /// The closed content table: the kind word and extension the stock sniffer answers
    /// for the body's magic bytes must be what the request claims. The extension set
    /// is exactly what `jobs::sniff_media` recognizes: image png/jpg/webp, audio
    /// wav/mp3/flac/ogg/m4a, video mp4/mov/webm/mkv; masks PNG only.
    pub(crate) fn matches_bytes(self, sniffed_kind: &str, extension: &str) -> bool {
        match self {
            Self::Image => sniffed_kind == "image",
            Self::Audio => sniffed_kind == "audio",
            Self::Video => sniffed_kind == "video",
            Self::Mask => sniffed_kind == "image" && extension == "png",
        }
    }
}

/// The pathwall (API-DESIGN §11): a supplied name must be one bare filename. No path
/// separators, no traversal names, no control characters, bounded length. The name
/// never composes a path anywhere in this plane — placement names are minted by the
/// stock seam — but the grammar is enforced anyway so a caller can never even present
/// a path, and the same wall stands if a later leg starts honoring names.
pub(crate) fn check_name(name: &str) -> Result<(), ApiError> {
    let refusal = |why: &str| {
        ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "the name parameter must be a bare filename ({why}); the closed grammar allows no paths"
        ))
    };
    if name.is_empty() {
        return Err(refusal("it is empty"));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(refusal("it exceeds 255 bytes"));
    }
    if name.contains(['/', '\\']) {
        return Err(refusal("it contains a path separator"));
    }
    if name.chars().any(char::is_control) {
        return Err(refusal("it contains control characters"));
    }
    if name == "." || name == ".." {
        return Err(refusal("it is a traversal name"));
    }
    Ok(())
}

/// The E22 subfolder wall (ruling E22): 1-8 path segments totalling at most 128
/// bytes, every segment passing the stock [`crate::jobs::model_name`] segment law
/// (no traversal, no backslash, no percent, no control characters, no stray edge
/// whitespace), and NO dot-leading segment — a dot name would hide the placement
/// from the inventory walk (the bench law) the moment it is minted.
pub(crate) fn check_subfolder(spec: &str) -> Result<(), ApiError> {
    let refusal = |why: &str| {
        ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "the subfolder parameter is refused ({why}); the closed grammar is 1-8 name segments (max {MAX_SUBFOLDER_BYTES} bytes) under deas-inputs/"
        ))
    };
    if spec.is_empty() {
        return Err(refusal("it is empty"));
    }
    if spec.len() > MAX_SUBFOLDER_BYTES {
        return Err(refusal("it exceeds 128 bytes"));
    }
    let segments: Vec<&str> = spec.split('/').collect();
    if segments.len() > MAX_SUBFOLDER_SEGMENTS {
        return Err(refusal("it carries more than 8 segments"));
    }
    if !crate::jobs::model_name(spec) {
        return Err(refusal(
            "a segment is empty, a traversal name, or carries a forbidden character",
        ));
    }
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(refusal(
            "a segment is dot-prefixed and would hide from the listing",
        ));
    }
    Ok(())
}

/// The E22 scoped-name wall: inside a subfolder the `name` param is HONORED, so it
/// gets its own grammar — one final segment (no separators: the stock
/// [`check_name`] bare-filename wall would forbid the very paths E22 opens, and the
/// root uuid law still owns that wall), non-empty, model_name-law clean, no
/// `[`/`]` (the stock recipe walls mark special sources `[output]`/`[temp]` with
/// brackets), no leading dot (listing law again). The ` (N)` collision-loop shape
/// stays expressible on purpose: the backend may mint it.
pub(crate) fn check_scoped_name(name: &str) -> Result<(), ApiError> {
    let refusal = |why: &str| {
        ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "the name parameter (with subfolder) is refused ({why}); the closed grammar is one final file-name segment with no path separators or brackets"
        ))
    };
    if name.is_empty() {
        return Err(refusal("it is empty"));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(refusal("it exceeds 255 bytes"));
    }
    if name.contains(['/', '\\']) {
        return Err(refusal("it carries a path separator"));
    }
    if name.contains(['[', ']']) {
        return Err(refusal(
            "it carries a bracket (reserved by the stock recipe grammar)",
        ));
    }
    if name.starts_with('.') {
        return Err(refusal(
            "it is dot-prefixed and would hide from the listing",
        ));
    }
    if !crate::jobs::model_name(name) {
        return Err(refusal(
            "it is empty, a traversal name, or carries a forbidden character",
        ));
    }
    Ok(())
}

/// The composed-placement wall: the full `deas-inputs/<subfolder>/<name>` reference
/// the answer will carry must itself pass the stock [`crate::jobs::model_name`]
/// whole-identifier law (the ≤ 255-byte ceiling the reference plane enforces).
pub(crate) fn check_placement(placement: &str) -> Result<(), ApiError> {
    if crate::jobs::model_name(placement) {
        return Ok(());
    }
    Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
        "the composed placement exceeds the 255-byte reference law; shorten the subfolder or the name",
    ))
}

/// One E22 scoped placement request: the subfolder (relative to `deas-inputs/`,
/// already grammar-checked by the door) and the requested final name (already
/// checked by the scoped-name wall). Only the door's grammar decides when a scope
/// exists; the bridge never re-litigates it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UploadScope {
    pub(crate) subfolder: String,
    pub(crate) name: String,
}

/// What a placement actually became: the full ComfyUI-relative name the seam
/// created, and `actual` — true when a requested name landed verbatim (no backend
/// collision rename). The uuid-minted root law always answers `actual: true`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Placement {
    pub(crate) name: String,
    pub(crate) actual: bool,
}

/// The upload seam: production runs the stock placement functions against the running
/// owned backend; tests fake the seam (the stock functions need a live backend, so the
/// thin wrapper is the faked seam while the production path still calls stock).
pub(crate) trait UploadBridge: Send + Sync {
    /// Place one plane-validated body. `scope: None` keeps the stock uuid-mint law
    /// (`deas-inputs/<uuid>...`, `deas-masks/<uuid>.png`, or the root-level
    /// `deas-input-<uuid>.<ext>` for video); `scope: Some` places the requested name
    /// nested under `deas-inputs/<subfolder>` and answers the BACKEND's final name
    /// (E22 collision law). `Err` text is surfaced to the caller beside the taxonomy
    /// word.
    fn place(
        &self,
        kind: UploadKind,
        bytes: axum::body::Bytes,
        scope: Option<UploadScope>,
    ) -> BoxFuture<'static, Result<Placement, String>>;
}

/// Production bridge: the running backend's endpoint comes from the stock owned
/// backend lifecycle (never a hardcoded port — the owned backend binds an ephemeral
/// loopback port), and placement is the stock upload seam verbatim.
pub(crate) struct StockUploadBridge {
    app: tauri::AppHandle,
}

impl StockUploadBridge {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl UploadBridge for StockUploadBridge {
    fn place(
        &self,
        kind: UploadKind,
        bytes: axum::body::Bytes,
        scope: Option<UploadScope>,
    ) -> BoxFuture<'static, Result<Placement, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            use std::io::Write as _;
            use tauri::Manager as _;
            let status = app.state::<crate::install::Engine>().backend.status();
            let base_url = match (status.state.as_str(), status.endpoint) {
                ("running", Some(endpoint)) => endpoint,
                _ => {
                    return Err(
                        "no owned backend is running; uploads place bytes into the running backend's input plane"
                            .to_owned(),
                    )
                }
            };
            if kind == UploadKind::Mask {
                // Masks keep the stock uuid law (ruling E22); the door's grammar
                // refuses a scope for masks, so `scope` is None on every call here.
                let placed = crate::jobs::native_mask_upload(base_url, bytes.to_vec()).await?;
                return Ok(Placement {
                    name: placed,
                    actual: true,
                });
            }
            if let Some(scope) = scope {
                // E22 nested placement: the stock fence with an explicit name.
                // The door already sniffed the body, so re-sniffing the head here
                // only recovers the extension for the fence's collision check.
                let head = &bytes[..bytes.len().min(SNIFF_HEAD_BYTES)];
                let (sniffed_kind, extension) = crate::jobs::sniff_media(head)
                    .ok_or("the bytes no longer match the closed content set")?;
                if sniffed_kind != kind.word() {
                    // The door already bound kind to magic; this only guards the
                    // fence against a body that changed between the walls.
                    return Err(format!(
                        "the body reads as {sniffed_kind}, not the requested kind {}",
                        kind.word()
                    ));
                }
                let folder = format!("deas-inputs/{}", scope.subfolder);
                let (final_name, placed_subfolder) = crate::jobs::upload_scoped(
                    &base_url,
                    bytes.to_vec(),
                    extension,
                    &folder,
                    &scope.name,
                )
                .await?;
                return Ok(Placement {
                    name: format!("{placed_subfolder}/{final_name}"),
                    actual: final_name == scope.name,
                });
            }
            // The stock input seam is path-based (it reads the file and sniffs it
            // itself); staging the body in a temp file is the reuse path, and the
            // NamedTempFile drops with this block.
            let video_only = matches!(kind, UploadKind::Video);
            let mut staged = tempfile::NamedTempFile::new()
                .map_err(|problem| format!("upload staging failed: {problem}"))?;
            staged
                .write_all(&bytes)
                .map_err(|problem| format!("upload staging failed: {problem}"))?;
            let path = match staged.path().to_str() {
                Some(path) => path,
                None => return Err("staged upload path is not UTF-8".to_owned()),
            };
            let placed = crate::jobs::upload_input(&base_url, path, video_only).await?;
            Ok(Placement {
                name: placed,
                actual: true,
            })
        })
    }
}

/// Test double: records each placement (kind, byte count, scoped subfolder when
/// present) and answers a stock-shaped placement per kind — or, when built
/// `renaming()`, a scoped placement answers the backend's ` (N)` collision variant
/// of the requested name (`actual: false`), the shape only a LIVE backend mints
/// (the real collision needs the backend; this seam pins the plane's handling of
/// its answer). Refuses like the seam does with no backend running.
#[cfg(test)]
pub(crate) struct RecordingUploadBridge {
    failure: Option<&'static str>,
    rename: bool,
    placements: std::sync::Mutex<Vec<(UploadKind, usize, Option<String>)>>,
}

#[cfg(test)]
impl RecordingUploadBridge {
    pub(crate) const fn accepting() -> Self {
        Self {
            failure: None,
            rename: false,
            placements: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Scoped placements come back collision-renamed (`{stem} (1).{ext}`), the
    /// backend's rename-loop shape (server.py, ruling E22).
    pub(crate) const fn renaming() -> Self {
        Self {
            failure: None,
            rename: true,
            placements: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub(crate) const fn refusing(problem: &'static str) -> Self {
        Self {
            failure: Some(problem),
            rename: false,
            placements: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn placements(&self) -> Vec<(UploadKind, usize, Option<String>)> {
        self.placements
            .lock()
            .expect("test lock")
            .iter()
            .cloned()
            .collect()
    }
}

/// Inserts the backend's ` (1)` collision loop before the extension of `name`.
#[cfg(test)]
fn looped(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem} (1).{ext}"),
        None => format!("{name} (1)"),
    }
}

#[cfg(test)]
impl UploadBridge for RecordingUploadBridge {
    fn place(
        &self,
        kind: UploadKind,
        bytes: axum::body::Bytes,
        scope: Option<UploadScope>,
    ) -> BoxFuture<'static, Result<Placement, String>> {
        let recorded = (
            kind,
            bytes.len(),
            scope.as_ref().map(|scope| scope.subfolder.clone()),
        );
        let failure = self.failure;
        let rename = self.rename;
        if let Some(problem) = failure {
            return Box::pin(async move { Err(problem.to_owned()) });
        }
        // Mutex guard closed before the await: no lock lives across a suspension.
        if let Ok(mut guard) = self.placements.lock() {
            guard.push(recorded);
        }
        Box::pin(async move {
            if let Some(scope) = scope {
                let final_name = if rename {
                    looped(&scope.name)
                } else {
                    scope.name.clone()
                };
                return Ok(Placement {
                    name: format!("deas-inputs/{}/{}", scope.subfolder, final_name),
                    actual: final_name == scope.name,
                });
            }
            Ok(Placement {
                name: match kind {
                    UploadKind::Image => "deas-inputs/fake-image.png".to_owned(),
                    UploadKind::Audio => "deas-inputs/fake-audio.wav".to_owned(),
                    UploadKind::Video => "deas-input-fake-video.mp4".to_owned(),
                    UploadKind::Mask => "deas-masks/fake-mask.png".to_owned(),
                },
                actual: true,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_vocabulary_parses_and_round_trips() {
        for word in ["image", "audio", "video", "mask"] {
            let kind = UploadKind::parse(word).expect("closed word parses");
            assert_eq!(kind.word(), word);
        }
        for word in ["Image", "file", "", "text", "mp4"] {
            assert_eq!(UploadKind::parse(word), None, "{word} is outside");
        }
    }

    #[test]
    fn the_content_table_binds_kind_to_the_sniffed_bytes() {
        // The stock sniffer's own (kind, extension) pairs land on their kinds.
        assert!(UploadKind::Image.matches_bytes("image", "webp"));
        assert!(UploadKind::Audio.matches_bytes("audio", "flac"));
        assert!(UploadKind::Video.matches_bytes("video", "mkv"));
        // Masks are PNG-only (the stock mask seam's magic law).
        assert!(UploadKind::Mask.matches_bytes("image", "png"));
        assert!(!UploadKind::Mask.matches_bytes("image", "jpg"));
        // A kind claiming something the bytes are not never matches.
        assert!(!UploadKind::Image.matches_bytes("video", "mp4"));
        assert!(!UploadKind::Video.matches_bytes("audio", "wav"));
    }

    #[test]
    fn the_pathwall_accepts_bare_filenames_only() {
        assert!(check_name("photo.png").is_ok());
        assert!(check_name("deas-input-7db0.mp4").is_ok());
        assert!(
            check_name("a..b.png").is_ok(),
            "dots inside a name are legal"
        );
        for bad in [
            "",
            "..",
            ".",
            "../evil.png",
            "a/b.png",
            "a\\b.png",
            "/absolute.png",
            "C:\\models\\x.png",
            "bad\u{0}name",
            "line\nbreak",
            &"w".repeat(256),
        ] {
            let error = check_name(bad).expect_err("pathwall refuses");
            assert_eq!(
                error.body_json()["reason"],
                "bodyInvalid",
                "{bad:?}: the pathwall rides the bodyInvalid word"
            );
        }
    }

    /// E22 subfolder grammar: name segments under deas-inputs/, dot-hidden and
    /// traversal forms refused, ceilings honest (128 bytes, 8 segments).
    #[test]
    fn the_subfolder_wall_admits_nested_name_segments_only() {
        for good in [
            "project1",
            "project1/shots/a",
            "project one",
            "a.b.c",
            "é project",
        ] {
            check_subfolder(good).expect("{good} is legal nested grammar");
        }
        for bad in [
            "",
            ".",
            "..",
            "../escape",
            "a/../../b",
            "a//b",
            ".bench-2026",
            "a/.hidden",
            "bad%name",
            "C:\\x",
            "a\\b",
            " lead",
            "trail ",
            "a/b/c/d/e/f/g/h/i",
            &"a".repeat(129),
        ] {
            let error = check_subfolder(bad).expect_err("{bad:?} refused");
            assert_eq!(error.body_json()["reason"], "bodyInvalid", "{bad:?}");
        }
    }

    /// E22 scoped-name wall: one final segment; brackets are the stock recipe
    /// grammar's reserved words; the ` (N)` collision-loop shape must stay
    /// expressible (the backend mints it on a content-differing collision).
    #[test]
    fn the_scoped_name_wall_honors_names_but_keeps_reserved_forms_out() {
        for good in ["pic.png", "shot 3.mp4", "a (1).wav", "x.y.png"] {
            check_scoped_name(good).expect("{good} is a legal scoped name");
        }
        for bad in [
            "",
            "a/b.png",
            "a\\b.png",
            "[output]",
            "x[y].png",
            ".hidden.png",
            "..",
            "bad%20name",
            " lead",
            &"n".repeat(256),
        ] {
            let error = check_scoped_name(bad).expect_err("{bad:?} refused");
            assert_eq!(error.body_json()["reason"], "bodyInvalid", "{bad:?}");
        }
    }

    /// The composed placement carries the stock whole-identifier law (≤ 255
    /// bytes), so a legal subfolder plus a legal name still cannot exceed it.
    #[test]
    fn the_composed_placement_respects_the_reference_length_law() {
        check_placement("deas-inputs/project1/pic.png").expect("short placement");
        let long = format!("deas-inputs/{}/{}", "s".repeat(120), "n".repeat(200));
        let error = check_placement(&long).expect_err("over 255 bytes");
        assert_eq!(error.body_json()["reason"], "bodyInvalid");
    }
}
