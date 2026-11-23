//! The MEDIA-1 byte doors (LEG MEDIA-1, owner ruling E21 + E21-AMENDMENT): the
//! output enumeration, the raw byte reads with Range slicing, and the promote
//! door (generated output → placed input, server-side copy). LEG AF2-M29 made
//! the OUTPUT read door video-ready: an output-root-relative path spans up to
//! [`MAX_OUTPUT_PATH_SEGMENTS`] segments, and its content type rides the closed
//! [`OUTPUT_MEDIA_TYPES`] table pinned equal to the listing's kinds.
//!
//! The ruling that shapes this whole module: ON-DISK files cost NOTHING. The
//! caps are NETWORK caps — the byte doors therefore carry only the READ cap
//! (`caps.downloadSingleMiB`), and the promote door carries NO cap at all (the
//! copy never crosses the network). A cap that bites an on-disk file answers
//! 409 `capExceeded` (the payload is already here; the remedy is the guard-file
//! cap, not a smaller request) — the upload walls keep the word's canonical 413.
//!
//! Roots are the stock in-process homes, never a guessed folder and never an
//! HTTP probe: [`crate::media::intake::input_root`] and
//! [`crate::media::star::output_root`], read per request through
//! [`super::PlaneState`]. The containment law on every path that leaves the
//! wire: percent-decode, then reject the e16 path FORM (absolute, backslash,
//! leading root) plus NUL and traversal segments, then walk the components
//! under the root refusing every symlink — the resolved-parent law that makes a
//! symlink escape structurally impossible. This module is also the ONE home of
//! that law for the whole plane (LEG AF2-M19a): [`contained_tail`] (the canonical
//! equal-or-inside compare LEG AF2-M18b B6 coined for the scan root; its thin
//! `path_inside` wrapper went with the parameter under ruling E26, LEG AF2-M19b —
//! the compare itself stays, alive for the placement and byte doors),
//! [`symlink_free_under`] (the walk wall),
//! [`resolve_shape`] / [`normalize_lexical`] (canonicalize-as-far-as-it-lands and
//! the lexical pass) and [`copy_into_inputs`] (the server-side copy the promote
//! door and the E24 reference door share). Doors elsewhere call these; they never
//! restate them.
//!
//! PRIVACY LAW (M9g/W7, inherited from the inputs/models doors): rows carry the
//! stock descriptor words — `subfolder`, `filename`, `type`, `sizeBytes`,
//! `mtimeMs` — never an absolute path.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::caps::Caps;
use super::e16;
use super::errors::{ApiError, ErrorKind};
use super::uploads;

/// Honest ceiling on one output listing, the [`super::inputs::MAX_INPUT_ROWS`]
/// law restated for the output plane: the cap is the plane's, not a client
/// parameter, and the answer says when it cut.
pub(crate) const MAX_OUTPUT_ROWS: usize = 500;

/// Grammar ceiling of the output byte door (LEG AF2-M29): an output-root-relative
/// path spans at most this many forward-slash-separated segments under the root
/// (the live H3 shape `raw/video/DEAS-00001-audio.mp4` is three). The ceiling is
/// the OUTPUT door's own grammar law — the inputs door and the promote door keep
/// their placement grammars untouched.
pub(crate) const MAX_OUTPUT_PATH_SEGMENTS: usize = 8;

/// One generated media file under the output root, in the stock descriptor
/// shape: the relative `subfolder` (`""` at the root), the bare `filename`,
/// the stock media kind, and the file's own size/mtime facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutputRow {
    pub(crate) subfolder: String,
    pub(crate) filename: String,
    pub(crate) kind: &'static str,
    pub(crate) size_bytes: u64,
    pub(crate) modified_ms: Option<u64>,
}

impl OutputRow {
    /// The wire shape: descriptor words only — the privacy law pins that no
    /// absolute path ever joins these fields.
    #[must_use]
    pub(crate) fn row_json(&self) -> Value {
        json!({
            "subfolder": self.subfolder,
            "filename": self.filename,
            "type": self.kind,
            "sizeBytes": self.size_bytes,
            "mtimeMs": self.modified_ms,
        })
    }
}

/// The output listing plus its honesty counters (same posture as the input
/// inventory: rows, a reported cut, and a count of what the walk skipped).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OutputListing {
    pub(crate) rows: Vec<OutputRow>,
    pub(crate) truncated: bool,
    /// Entries the walk passed without labeling: non-media kinds, hidden files,
    /// symlinks, and the folders themselves.
    pub(crate) unlisted: usize,
}

/// Walks the output root recursively (stack, no recursion, no symlink
/// following), labeling only what the stock media table kinds
/// ([`crate::media::media_kind`]). Refusal text is path-free.
///
/// # Errors
///
/// "the output root is unreadable" when the root itself cannot be opened.
pub(crate) fn list_outputs(root: &Path) -> Result<OutputListing, String> {
    let root_entry =
        std::fs::metadata(root).map_err(|_| "the output root is unreadable".to_owned())?;
    if !root_entry.is_dir() {
        return Err("the output root is unreadable".to_owned());
    }
    let mut listing = OutputListing::default();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, subfolder)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            // A subfolder that cannot be read is counted, never invented; the
            // root itself already failed closed above.
            listing.unlisted += 1;
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                listing.unlisted += 1;
                continue;
            };
            if file_type.is_symlink() || name.starts_with('.') {
                listing.unlisted += 1;
                continue;
            }
            if file_type.is_dir() {
                let child = if subfolder.is_empty() {
                    name.clone()
                } else {
                    format!("{subfolder}/{name}")
                };
                stack.push((entry.path(), child));
                continue;
            }
            if !file_type.is_file() {
                listing.unlisted += 1;
                continue;
            }
            let Some(kind) = crate::media::media_kind(&name) else {
                listing.unlisted += 1;
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                listing.unlisted += 1;
                continue;
            };
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64);
            listing.rows.push(OutputRow {
                subfolder: subfolder.clone(),
                filename: name,
                kind,
                size_bytes: metadata.len(),
                modified_ms,
            });
        }
    }
    // E22 recency law (restated from the inputs door): newest first, None mtimes
    // last; subfolder then filename is the deterministic tiebreak under a tie.
    listing.rows.sort_by(|left, right| {
        right.modified_ms.cmp(&left.modified_ms).then_with(|| {
            (
                &left.subfolder,
                left.filename.to_ascii_lowercase(),
                &left.filename,
            )
                .cmp(&(
                    &right.subfolder,
                    right.filename.to_ascii_lowercase(),
                    &right.filename,
                ))
        })
    });
    listing.truncated = listing.rows.len() > MAX_OUTPUT_ROWS;
    listing.rows.truncate(MAX_OUTPUT_ROWS);
    Ok(listing)
}

/// The containment law for every wire-supplied relative path (both byte doors
/// and the promote source). Order of walls:
///
/// 1. grammar: non-empty, no NUL, not the e16 path FORM (absolute form, a
///    leading root, any backslash — [`e16::is_path_form`]), and every `/`
///    segment non-empty, not `.` or `..`, free of control characters;
/// 2. the walk: every intermediate component must be a real directory under
///    the root — a symlink at ANY level is refused (the escape wall), a missing
///    component answers `routeNotFound`;
/// 3. the leaf: an existing regular file (symlink refused, directory and
///    anything else answer `routeNotFound`).
///
/// # Errors
///
/// `bodyInvalid` for a grammar or symlink violation, `routeNotFound` for a
/// component that is not on disk.
pub(crate) fn contained(root: &Path, rel: &str) -> Result<PathBuf, ApiError> {
    let violation = |why: &str| {
        ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "the named path is refused ({why}); the closed grammar allows one relative file path under the served root"
        ))
    };
    if rel.is_empty() || rel.contains('\0') {
        return Err(violation(if rel.is_empty() {
            "it is empty"
        } else {
            "it contains NUL"
        }));
    }
    if e16::is_path_form(rel) {
        return Err(violation("it is written as a filesystem path"));
    }
    let segments: Vec<&str> = rel.split('/').collect();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.chars().any(char::is_control)
    }) {
        return Err(violation("it contains an empty or traversal segment"));
    }
    let mut current = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        current.push(*segment);
        let last = index + 1 == segments.len();
        match walk_step(&current) {
            Step::Link => {
                return Err(violation(
                    "symlinks are never followed under the served root",
                ))
            }
            Step::Missing => {
                // AF2-M18b WORD-RULE-2: `routeNotFound` is the shipped word for "nothing at
                // this address" and stays (shipped words win per the ledger) — the ROUTE is
                // registered, the file behind it is not. The honesty the word lacks lives in
                // the detail, which now names the missing name.
                return Err(ApiError::new(ErrorKind::RouteNotFound).with_hint(format!(
                    "no such file at '{rel}' on the served root; GET /v1/inputs and GET /v1/outputs list what is"
                )));
            }
            Step::Leaf => {
                if !last {
                    return Err(violation("a path component is not a directory"));
                }
            }
            Step::Dir => {
                if last {
                    return Err(ApiError::new(ErrorKind::RouteNotFound)
                        .with_hint("the named path is not a regular file on the served root"));
                }
            }
            Step::Other => {
                if last {
                    return Err(ApiError::new(ErrorKind::RouteNotFound)
                        .with_hint("the named path is not a regular file on the served root"));
                }
                return Err(violation("a path component is not a directory"));
            }
        }
    }
    Ok(current)
}

/* --------- THE SHARED CONTAINMENT LAW (coined LEG AF2-M18b B6, one home AF2-M19a) ---------

Two doors must keep a wire-named path inside an engine folder, and they must not own
two copies of the law: the byte-serving doors (`serve_input_file`/`serve_output_file`
in `routes`, via [`contained`]'s per-component walk) and the reference-placement door
(`e16::place_references` under owner ruling E24, which additionally resolves relative
references against the input root and copies from the output root). The compare, the
per-component walk verdict and the canonical-resolve-with-lexical-tail all live HERE;
both doors call them. Restating the law in either door is the drift this factoring
exists to prevent. (`path_inside`'s third former caller — the scan door's `root`
containment wall — was deleted with the parameter itself under ruling E26, LEG
AF2-M19b: the scan now walks the engine's saved folders only, so there is nothing
left to contain. The wrapper itself went with its caller — measurement named it the
only one — while the compare it delegated to, [`contained_tail`], stays the live
law home the placement and byte doors call.)
------------------------------------------------------------------------------- */

/// One component of the shared walk law ([`contained`]'s per-step verdict, factored
/// into one home by LEG AF2-M19a so the placement door reuses the same wall instead
/// of restating it): a real directory, a real regular file, a symlink (the escape
/// form), something else that exists (socket, device, FIFO), or nothing on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Dir,
    Leaf,
    Link,
    Other,
    Missing,
}

/// The walk's per-component read: `symlink_metadata`, so a link is seen AS a link and
/// never resolved into the walk (the byte doors' escape wall verbatim).
fn walk_step(path: &Path) -> Step {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Step::Missing;
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        Step::Link
    } else if file_type.is_dir() {
        Step::Dir
    } else if file_type.is_file() {
        Step::Leaf
    } else {
        Step::Other
    }
}

/// The walk wall, reusable (LEG AF2-M19a): true when no component of `segments` under
/// `root` is a symlink. A component that is not on disk STOPS the walk — nothing there
/// is followable — which is what lets the placement door apply the same wall to a
/// reference whose leaf has not landed yet (its existence is a separate law).
#[must_use]
pub(crate) fn symlink_free_under(root: &Path, segments: &[&str]) -> bool {
    let mut current = root.to_path_buf();
    for segment in segments {
        current.push(*segment);
        match walk_step(&current) {
            Step::Link => return false,
            Step::Missing | Step::Leaf => return true,
            Step::Dir | Step::Other => {}
        }
    }
    true
}

/// The containment compare WITH its tail: `Some(segments)` when `candidate` sits at or
/// inside `root` — the segments are `candidate`'s components PAST the root, which the
/// placement door turns into the root-relative reference form — and `None` when it
/// does not. Canonical form on both sides is the shipped law (LEG AF2-M18b B6: a
/// symlink that resolves outside the root is refused rather than followed); the
/// placement door also calls this spelling-vs-spelling to locate a reference's own
/// spelling under a root it already contained canonically.
#[must_use]
pub(crate) fn contained_tail(root: &Path, candidate: &Path) -> Option<Vec<String>> {
    let components = |path: &Path| {
        path.components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<String>>()
    };
    let (root, candidate) = (components(root), components(candidate));
    if candidate.len() < root.len() {
        return None;
    }
    let matched = root.iter().zip(candidate.iter()).all(|(root, probe)| {
        if cfg!(windows) {
            root.eq_ignore_ascii_case(probe)
        } else {
            root == probe
        }
    });
    matched.then(|| candidate[root.len()..].to_vec())
}

/// Canonicalizes the deepest part of `path` the filesystem can resolve and appends the
/// remainder verbatim, so containment answers for a path whose LEAF has not landed yet
/// (E24 decides WHERE a reference may live before anything asks whether it exists). The
/// parts that ARE on disk still resolve through the filesystem, so a symlink in the
/// resolvable prefix moves the candidate to its real home — where containment then
/// decides, exactly as the scan-root law already does. `None` only when nothing on the
/// line resolves at all (an unreadable drive): the door then refuses.
#[must_use]
pub(crate) fn resolve_shape(path: &Path) -> Option<PathBuf> {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = path;
    loop {
        if let Ok(found) = std::fs::canonicalize(probe) {
            let mut out = found;
            for segment in missing.iter().rev() {
                out.push(segment);
            }
            return Some(out);
        }
        let name = probe.file_name()?;
        missing.push(name.to_os_string());
        probe = probe.parent()?;
    }
}

/// Lexical normalization, filesystem untouched: `.` segments drop, `..` segments pop
/// the previous component, separators collapse. Containment then decides by where the
/// path LANDS, never by how it was spelled (ruling E24 arm 4 and the traversal test
/// that rides it).
#[must_use]
pub(crate) fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// One server-side copy into the input plane: the minted placement name and the byte
/// count the answer reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlacedCopy {
    pub(crate) name: String,
    pub(crate) bytes: u64,
}

/// The mint-and-copy half of the promote door (factored into one home by LEG
/// AF2-M19a; behavior unchanged): a fresh `deas-inputs/<uuid>.<sanitized-ext>` under
/// the input root, landed with `std::fs::copy` — never a read into memory, because the
/// class includes video — and with NO size cap (rulings E21 + E24: an on-disk copy
/// costs nothing; the caps are network caps). The stock uuid placement idiom is minted
/// here because the ComfyUI upload seam is a network call and these doors deliberately
/// cross none.
///
/// # Errors
///
/// `routeNotFound` when the source vanished between the wall and the copy,
/// `maintenanceActive` when the placement folder or the copy itself cannot be written.
pub(crate) fn copy_into_inputs(source: &Path, input_root: &Path) -> Result<PlacedCopy, ApiError> {
    let bytes = std::fs::metadata(source)
        .map_err(|_| {
            ApiError::new(ErrorKind::RouteNotFound)
                .with_hint("the named source vanished between the wall and the copy")
        })?
        .len();
    let extension = source
        .extension()
        .map(|raw| {
            raw.to_string_lossy()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase()
                .chars()
                .take(8)
                .collect::<String>()
        })
        .unwrap_or_default();
    let placed_name = if extension.is_empty() {
        format!("deas-inputs/{}", uuid::Uuid::new_v4())
    } else {
        format!("deas-inputs/{}.{}", uuid::Uuid::new_v4(), extension)
    };
    let folder = input_root.join("deas-inputs");
    std::fs::create_dir_all(&folder).map_err(|problem| {
        ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
            "the input placement folder cannot be prepared for the copy: {problem}"
        ))
    })?;
    let target = folder.join(
        placed_name
            .split('/')
            .next_back()
            .expect("the placement name has a final segment"),
    );
    std::fs::copy(source, &target).map_err(|problem| {
        ApiError::new(ErrorKind::MaintenanceActive)
            .with_hint(format!("the placement copy failed: {problem}"))
    })?;
    Ok(PlacedCopy {
        name: placed_name,
        bytes,
    })
}

/// One Range outcome for a file of `len` bytes. A missing, malformed, or
/// multi-range header serves the whole file (the HTTP law for a Range the
/// server does not negotiate); a start past the end answers 416.
#[derive(Debug, PartialEq, Eq)]
enum Slice {
    Whole,
    Part { start: u64, end: u64 },
    Unsatisfiable,
}

/// The single-range subset: `bytes=a-b`, `bytes=a-`, `bytes=-n`. Everything
/// else (syntax noise, comma lists, unknown units) is a non-negotiated Range —
/// the whole file answers instead.
fn parse_range(headers: &HeaderMap, len: u64) -> Slice {
    let Some(raw) = headers.get("range").and_then(|value| value.to_str().ok()) else {
        return Slice::Whole;
    };
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return Slice::Whole;
    };
    if len == 0 || spec.contains(',') {
        return Slice::Whole;
    }
    let (first, second) = match spec.split_once('-') {
        Some(pair) => pair,
        None => return Slice::Whole,
    };
    let parse = |text: &str| text.trim().parse::<u64>().ok();
    match (first.is_empty(), second.is_empty()) {
        (false, false) => match (parse(first), parse(second)) {
            (Some(start), Some(end)) if start <= end && end > 0 => {
                if start >= len {
                    Slice::Unsatisfiable
                } else {
                    Slice::Part {
                        start,
                        end: end.min(len - 1),
                    }
                }
            }
            _ => Slice::Whole,
        },
        (false, true) => match parse(first) {
            Some(start) if start < len => Slice::Part {
                start,
                end: len - 1,
            },
            Some(_) => Slice::Unsatisfiable,
            None => Slice::Whole,
        },
        (true, false) => match parse(second) {
            Some(suffix) if suffix > 0 => Slice::Part {
                start: len.saturating_sub(suffix),
                end: len - 1,
            },
            _ => Slice::Whole,
        },
        (true, true) => Slice::Whole,
    }
}

/// The closed extension → media-type table for the byte doors (the stock media
/// kinds served by the two roots); anything else serves as octet-stream, which
/// keeps the doors total and the table honest.
fn media_type(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

/// The closed output-door media table (LEG AF2-M29): every extension the stock
/// listing labels ([`crate::media::media_kind`]) maps to its honest IANA type;
/// an extension outside the table is refused BY NAME OF THE TABLE, never
/// octet-streamed. The table and the listing are pinned equal test-for-test
/// ([`the_closed_output_media_map_equals_the_listing_table`]), so a listed row
/// is always serveable (the M16 no-orphan law) and no unlisted kind ever
/// serves. This narrows only the OUTPUT door; the inputs door keeps the total
/// octet-stream table above — placement names are the plane's own grammar.
const OUTPUT_MEDIA_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("mp4", "video/mp4"),
    ("mkv", "video/x-matroska"),
    ("webm", "video/webm"),
    ("mov", "video/quicktime"),
    ("avi", "video/x-msvideo"),
    ("m4v", "video/mp4"),
    ("mpg", "video/mpeg"),
    ("mpeg", "video/mpeg"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("flac", "audio/flac"),
    ("ogg", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("opus", "audio/opus"),
];

/// The output door's content-type read: `Some(honest type)` for an extension
/// inside [`OUTPUT_MEDIA_TYPES`], `None` for anything else (the refusal then
/// names the table — the hint is built from the same home).
fn output_media_type(name: &str) -> Option<&'static str> {
    let extension = Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    OUTPUT_MEDIA_TYPES
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

/// The table spelled for a refusal hint: `png|jpg|jpeg|...`.
fn output_media_map_words() -> String {
    OUTPUT_MEDIA_TYPES
        .iter()
        .map(|(ext, _)| *ext)
        .collect::<Vec<&str>>()
        .join("|")
}

/// Serves one contained file (the inputs door, behavior unchanged): the READ
/// cap first (409 `capExceeded` naming the size and the cap — the file is
/// already on disk, so the guard-file cap is the remedy), then the bytes under
/// the Range subset with `Accept-Ranges` always stated. The whole file is read
/// under the cap before slicing — the 1..=8192 MiB config bound is the
/// ceiling, and a loopback agent plane pays it honestly rather than streaming
/// a second code path. The type comes from the total [`media_type`] table.
pub(crate) fn serve_bytes(
    root: &Path,
    caps: Caps,
    rel: &str,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let path = contained(root, rel)?;
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    serve_under_cap(&path, media_type(&filename), caps, headers)
}

/// Serves one contained OUTPUT file (LEG AF2-M29, video-ready): the same
/// containment wall and the same cap restate as [`serve_bytes`], but the leaf
/// extension must sit inside the closed [`OUTPUT_MEDIA_TYPES`] table — an
/// extension outside it answers `bodyInvalid` naming the table (never
/// octet-stream), and an inside extension answers its honest content type.
pub(crate) fn serve_output_bytes(
    root: &Path,
    caps: Caps,
    rel: &str,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let path = contained(root, rel)?;
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(content_type) = output_media_type(&filename) else {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "the named file is refused (its extension is outside the closed output media map {}); the door serves exactly the kinds GET /v1/outputs labels",
            output_media_map_words(),
        )));
    };
    serve_under_cap(&path, content_type, caps, headers)
}

/// The shared serving tail of both byte doors: size, cap restate, read, Range
/// subset — one home so the two doors cannot drift apart.
fn serve_under_cap(
    path: &Path,
    content_type: &'static str,
    caps: Caps,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let size = std::fs::metadata(path)
        .map_err(|_| {
            ApiError::new(ErrorKind::RouteNotFound)
                .with_hint("the named file vanished between the wall and the read")
        })?
        .len();
    let cap_bytes = Caps::bytes(caps.download_single_mib);
    if size > cap_bytes {
        return Err(ApiError::new(ErrorKind::CapExceeded)
            .with_hint(format!(
                "the named file is {size} bytes at the {} MiB single-file download cap; the payload is already on disk, so the remedy is caps.downloadSingleMiB in the guard file ({}..={}), not a smaller request",
                caps.download_single_mib,
                super::caps::CAP_MIN_MIB,
                super::caps::CAP_MAX_MIB,
            ))
            .with_status(StatusCode::CONFLICT));
    }
    let bytes = std::fs::read(path).map_err(|_| {
        ApiError::new(ErrorKind::RouteNotFound)
            .with_hint("the named file is unreadable; the listing stays honest, the read refuses")
    })?;
    match parse_range(headers, size) {
        Slice::Unsatisfiable => {
            let mut out = HeaderMap::new();
            out.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{size}")).expect("valid header"),
            );
            Ok((StatusCode::RANGE_NOT_SATISFIABLE, out).into_response())
        }
        Slice::Whole => {
            let mut out = base_headers(content_type);
            out.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&size.to_string()).expect("valid header"),
            );
            Ok((StatusCode::OK, out, Body::from(bytes)).into_response())
        }
        Slice::Part { start, end } => {
            let window = &bytes[start as usize..=end as usize];
            let mut out = base_headers(content_type);
            out.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
                    .expect("valid header"),
            );
            out.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&window.len().to_string()).expect("valid header"),
            );
            Ok((
                StatusCode::PARTIAL_CONTENT,
                out,
                Body::from(window.to_vec()),
            )
                .into_response())
        }
    }
}

/// The headers every served answer carries: the Range law stated (`bytes`,
/// never `none`) and the media type of the leaf name.
fn base_headers(content_type: &str) -> HeaderMap {
    let mut out = HeaderMap::new();
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).expect("valid header"),
    );
    out
}

/// The promote door's copy (ruling E21 GENERATED reuse): containment under the
/// output root (same wall as the byte doors), then a server-side COPY into
/// `deas-inputs/<uuid>.<sanitized-ext>` under the input root — the mint-and-copy half
/// is [`copy_into_inputs`], one home it shares with the E24 reference-placement door
/// (LEG AF2-M19a). NO size cap: an on-disk copy costs nothing (doc ruling).
///
/// # Errors
///
/// The containment wall's words; `maintenanceActive` when the copy itself
/// cannot be written.
pub(crate) fn promote_copy(
    output_root: &Path,
    input_root: &Path,
    subfolder: &str,
    name: &str,
) -> Result<Value, ApiError> {
    // The bare-name wall first (the uploads pathwall is its single home), then
    // one composed relative path through the shared containment law.
    uploads::check_name(name)?;
    let rel = if subfolder.is_empty() {
        name.to_owned()
    } else {
        format!("{subfolder}/{name}")
    };
    let source = contained(output_root, &rel)?;
    let placed = copy_into_inputs(&source, input_root)?;
    Ok(json!({
        "ok": true,
        "name": placed.name,
        "bytes": placed.bytes,
        "from": { "subfolder": subfolder, "filename": name },
        "note": "server-side copy; no bytes crossed the network, so no upload cap applies (ruling E21: on-disk files cost nothing)",
    }))
}

/* ---------------- BENCH DOORS (LEG M17b, ruling E22 BENCH; WHOLE-ROOT SWEEP
restate — owner ruling 2026-11-22, supersedes the pick-list body grammar) ----

BENCH IS A NON-DESTRUCTIVE WHOLE-ROOT SWEEP: one call moves EVERY file under
the served root — the whole tree, placement names, operator drops, UI-placed
files and the continuity-state clutter class alike — into ONE date-time-stamped
folder inside the `.bench` parent under the SAME root:
`<root>/.bench/<YYYYMMDDTHHMMSSZ>/<original relative path>`. There is NO body
list (the 1..=100 pick-list grammar and its entry cap are dead); one call
sweeps the whole root. The stamp folder groups everything benched by one call
(and by every call landing in the same wall-clock second), so the group a bench
command moved is one dated folder to find later. Nothing is deleted (deletion
stays unruled). THE FOLDER IS LAZY (bench-behaviour leg): it is minted only at
the first real move — an all-refused call leaves NOTHING on disk — and an
existing folder under the same stamp name is REUSED, never an error, never a
minted suffix. Both walks and [`sweep_names`] skip dot-prefixed entries at
every level, so the `.bench` parent (and the legacy `.bench-<stamp>` folders
from the pre-sweep grammar) is NEVER re-swept; a benched item leaves the
inventories the moment it lands,
while the byte doors still reach it by its explicit new name — the containment
grammar refuses only empty/`.`/`..` segments, a leading dot is a legal segment.
Every moved item keeps its FULL source-relative name under the stamp folder
(`deas-inputs/project1/pic.jpg` → `.bench/<stamp>/deas-inputs/project1/pic.jpg`),
so each row is a round-trip: `old` is gone (a queue naming it answers
`inputMissing`, and the new name is not placement-form, so it is never a new
reference), `new` is exactly what the byte door serves. Files a LIVE queue row
(queued/draining/wedged) still references are refused per-row as
`claimedByQueue` and stay exactly where the drain will look for them; TERMINAL
rows never claim anything — the sweep is not required to track items that were
already generated. Moves WITHIN the served root are sanctioned by E20-AMENDED
(UI-placed and operator-dropped files included — which is why the source wall
is the containment law, not the placement grammar). Un-benching has no door in
this leg: it is an owner-UI / future-leg move.
--------------------------------------------------------------------------- */

/// The bench parent folder: the dot that hides it (and everything under it) from
/// both walks and from every sweep — the law M17a pre-positioned in
/// `inputs::labelable` and the `list_outputs` skip. Each bench call stamps ONE
/// folder INSIDE this parent ([`bench_folder_name`]).
pub(crate) const BENCH_PARENT: &str = ".bench";

/// The one-call bench folder name: `.bench/YYYYMMDDTHHMMSSZ` (UTC) — the parent
/// plus this call's stamp segment, one date-time folder per bench command
/// (owner ruling 2026-11-22: the group benched together is one stamped folder
/// inside `.bench`). The stamp rides the plane's clock law
/// ([`super::spool::now_ms`]: 0 for a clock set before the POSIX epoch — the
/// hostile-clock honesty marker the spool already carries, and
/// `bench_folder_name(0)` answers 1970, never a panic). Two calls landing in
/// the same second SHARE one folder, and the law is REUSE, not collision
/// (bench-behaviour leg P1): an existing folder under this name — same-second
/// sibling or older disk state — is entered as-is, no error, no minted suffix.
/// Every row keeps its full source-relative name under the folder, so
/// different names never collide there and the same name answers `targetExists`.
#[must_use]
pub(crate) fn bench_folder_name(now_ms: u64) -> String {
    let seconds = i64::try_from(now_ms / 1_000).unwrap_or(i64::MAX);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{BENCH_PARENT}/{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        second_of_day / 3_600,
        (second_of_day % 3_600) / 60,
        second_of_day % 60,
    )
}

/// The sweep's name list: EVERY regular file under `root`, recursively,
/// root-relative and '/'-joined — the whole-root law of the bench sweep doors
/// (owner ruling 2026-11-22: bench moves all existing files, the doors take no
/// body list). Iterative walk (a stack, `std::fs::read_dir`), no new deps.
///
/// DOT LAW: any entry whose file name starts with `.` is skipped, FILES AND
/// DIRECTORIES alike (never descended into) — the `.bench` parent is never
/// re-swept, the legacy `.bench-<stamp>` folders from the pre-sweep grammar
/// stay exactly where they are, and any dot state stays invisible. SYMLINKS are
/// skipped as sweep sources (they are never collected; the per-row symlink wall
/// inside [`bench_move`] keeps refusing them if any other caller names one).
/// Only REGULAR FILES are collected: directories are descended into and are
/// never rows themselves. The result is sorted for a deterministic row order.
///
/// `bench_move` claims law protects the files a live queue row references; the
/// sweep itself never deletes and never removes a directory — a claimed file
/// simply stays at its original path.
///
/// # Errors
///
/// Names the unreadable directory: a root (or subtree) the walk cannot read
/// refuses the WHOLE call — a sweep that cannot see the plane will not half
/// sweep it (the door hoists `maintenanceActive`).
pub(crate) fn sweep_names(root: &Path) -> Result<Vec<String>, String> {
    let mut stack = vec![root.to_path_buf()];
    let mut names: Vec<String> = Vec::new();
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|problem| format!("cannot read the directory {}: {problem}", dir.display()))?;
        // read_dir order is filesystem-dependent; sort each level so the walk
        // (and therefore the answer's row order) is deterministic.
        let mut level: Vec<_> = entries.flatten().collect();
        level.sort_by_key(|entry| entry.file_name());
        for entry in level {
            let file_name = entry.file_name();
            let text = file_name.to_string_lossy();
            if text.starts_with('.') {
                continue; // the dot law: .bench, legacy .bench-* folders, dot state
            }
            // file_type() here is the entry's OWN type (an lstat, never a
            // followed link), so a symlink reads as Symlink and is skipped.
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(entry.path()),
                Ok(kind) if kind.is_file() => {
                    let relative = contained_tail(root, &entry.path());
                    if let Some(segments) = relative {
                        names.push(segments.join("/"));
                    }
                }
                // Symlinks, fifos, sockets: never swept (bench_move's per-row
                // symlink wall stays the second line of defense). Ok(Err) is a
                // fs surprise on this entry: skip it honestly rather than guess.
                Ok(_) | Err(_) => {}
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Days since the Unix epoch → proleptic Gregorian (year, month, day): the
/// `civil_from_days` algorithm (Howard Hinnant), integer-exact, no date crate,
/// no clock panic in any direction (a pre-epoch clock yields pre-1970 years
/// honestly). All intermediates after the era step are non-negative by
/// construction.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = (if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    }) / 146_097;
    let day_of_era = shifted - era * 146_097; // [0, 146_096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365; // [0, 399]
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_probe = (5 * day_of_year + 2) / 153; // [0, 11]
    let day = (day_of_year - (153 * month_probe + 2) / 5 + 1) as u32; // [1, 31]
    let month = u32::try_from(if month_probe < 10 {
        month_probe + 3
    } else {
        month_probe - 9
    })
    .expect("the month probe is bounded");
    let year = if month <= 2 {
        year_of_era + era * 400 + 1
    } else {
        year_of_era + era * 400
    };
    (year, month, day)
}

/// One bench row: the source name exactly as asked, plus the honest outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BenchRow {
    pub(crate) old: String,
    pub(crate) outcome: BenchOutcome,
}

/// The closed per-row outcome words inside a 200 bench answer. Row words are
/// NOT taxonomy words (the top-level body keeps the closed taxonomy): a bench
/// call answers 200 with per-row partials because a refused row changes
/// nothing and the other rows genuinely moved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BenchOutcome {
    /// Moved: the new bench-relative name (`<folder>/<old>`) — the byte door
    /// serves this exact name; a retry of the same source answers `notFound`.
    Moved { new: String },
    /// The source is not a regular file the containment walk reaches (missing,
    /// a folder, a dead leaf): honest per-row, the rest of the call proceeds.
    NotFound,
    /// The target already exists on disk: refused, never moved onto (both
    /// POSIX and Windows rename would silently replace — a delete, and
    /// deletion is unruled). A retry under a fresh stamp lands.
    TargetExists,
    /// The filesystem refused the rename itself; `problem` carries the OS word
    /// verbatim (a running stock job holds its open output file — Windows
    /// answers the sharing violation; and a bench move never crosses volumes:
    /// the target is under the same root, so `EXDEV` cannot honestly arise —
    /// if some reparse trick produces one, it surfaces here too).
    MoveFailed { problem: String },
    /// A live spool row still references this input, so the drain will read it
    /// later: refused, nothing moved (LEG AF2-M18c, the bench-vs-spool TOCTOU).
    /// `claimed_by` names the row so the caller can wait for it or delete it.
    ///
    /// WORD-RULE: `claimedByQueue` is a PER-ROW bench word, coined here and nowhere
    /// else. Per-row bench words are answer-internal state inside a 200 body, NOT
    /// §11 taxonomy (the closed taxonomy set is untouched — the same ruling that
    /// admitted `notFound`/`targetExists`/`moveFailed` in M17b), so no taxonomy
    /// ledger entry and no `ErrorKind` arm rides this word.
    ClaimedByQueue { claimed_by: String },
}

impl BenchRow {
    /// The wire shape: `{old,new}` on a move, `{old,error,problem?}` on a
    /// refusal. Rows stay in request order (the old→new map is readable).
    #[must_use]
    pub(crate) fn row_json(&self) -> Value {
        match &self.outcome {
            BenchOutcome::Moved { new } => json!({ "old": self.old, "new": new }),
            BenchOutcome::NotFound => json!({ "old": self.old, "error": "notFound" }),
            BenchOutcome::TargetExists => json!({ "old": self.old, "error": "targetExists" }),
            BenchOutcome::MoveFailed { problem } => json!({
                "old": self.old,
                "error": "moveFailed",
                "problem": problem,
            }),
            BenchOutcome::ClaimedByQueue { claimed_by } => json!({
                "old": self.old,
                "error": "claimedByQueue",
                "claimedBy": claimed_by,
            }),
        }
    }
}

/// Moves every named file under `root` into one bench folder, keeping each
/// full source-relative name. Wall order per call: the WHOLE source list
/// faces the containment law first (a grammar or symlink violation hoists to
/// the call as `bodyInvalid` BEFORE a single rename happens — walls are body
/// law, never row state; a missing source is a per-row `notFound`), then rows
/// move in request order. Every per-file fs condition after that lands in its
/// row: the call answers partials.
///
/// THE FOLDER IS LAZY (bench-behaviour leg P1, the owner stamp law): no folder
/// is prepared up front — the first row that reaches its rename creates it (the
/// per-row parent mkdir covers the folder itself). A call whose every row is
/// refused therefore leaves NOTHING on disk, and an existing folder under the
/// same stamp name is REUSED — never an error, never a minted suffix; the only
/// collision word stays the per-row `targetExists`. A folder-creation failure
/// is that row's `moveFailed` with the OS word verbatim, not a call-level
/// refusal: the wall order hoists GRAMMAR, never fs state.
///
/// `claims` is the live-row claim set — [`super::inputs::queued_input_claims`]
/// at the input door, [`super::inputs::queued_output_claims`] at the output
/// mirror (LEG AF2-M18c + bench-behaviour leg P2): a name a live spool row
/// still references is refused per-row as `claimedByQueue` naming that row, and
/// the claim check rides the SAME validate-all-then-move-all pass, so a refused
/// claim never half-moves a call — the other rows move exactly as they did
/// before the guard.
///
/// # Errors
///
/// `bodyInvalid` hoisted from the containment wall (grammar or symlink).
/// Everything after that wall is a row (`notFound`, `targetExists`,
/// `moveFailed`, `claimedByQueue`) — the call never refuses on fs state.
pub(crate) fn bench_move(
    root: &Path,
    names: &[String],
    folder: &str,
    claims: &[super::inputs::InputClaim],
) -> Result<Vec<BenchRow>, ApiError> {
    // NAME-SHAPE LAW (bench-behaviour leg P3, asserted in code): the bench
    // folder is ONE dot-prefixed segment directly under the served root, never
    // a path of its own. The doors always pass [`bench_folder_name`]; this
    // wall is against a future caller inventing a folder word, checked before
    // anything touches the disk.
    debug_assert!(
        folder.starts_with(BENCH_PARENT)
            && folder.as_bytes().get(BENCH_PARENT.len()) == Some(&b'/')
            && folder.len() > BENCH_PARENT.len() + 1
            && folder.matches('/').count() == 1
            && !folder.contains('\\')
            && !folder[BENCH_PARENT.len() + 1..].contains('.'),
        "the bench folder is .bench/<stamp>: the dot-prefixed parent plus exactly one non-empty dot-free stamp segment, got {folder:?}"
    );
    // Pass 1: every source faces the shared wall before any rename touches
    // the disk, so a hoisted refusal leaves the plane exactly as it was.
    let mut sources: Vec<Option<PathBuf>> = Vec::with_capacity(names.len());
    for old in names {
        match contained(root, old) {
            Ok(path) => sources.push(Some(path)),
            Err(error) if error.kind() == ErrorKind::RouteNotFound => sources.push(None),
            Err(error) => return Err(error),
        }
    }
    // LAZY FOLDER (leg P1): nothing is minted here. The first rename-bound row
    // creates the folder through its own parent mkdir below; an all-refused
    // call leaves no trace, and an existing same-name folder is simply entered.
    let bench_dir = root.join(folder);
    let mut rows = Vec::with_capacity(names.len());
    for (old, source) in names.iter().zip(sources) {
        let Some(source) = source else {
            rows.push(BenchRow {
                old: old.clone(),
                outcome: BenchOutcome::NotFound,
            });
            continue;
        };
        let new = format!("{folder}/{old}");
        let target = bench_dir.join(old.replace('/', std::path::MAIN_SEPARATOR_STR));
        // The claim wall rides this same pass (LEG AF2-M18c): a name a live row
        // still references never moves, whatever else this call does. It sits
        // under the `notFound` arm because a name that is not on disk has nothing
        // for the drain to lose, and `notFound` is the truth about the name.
        if let Some(claim) = super::inputs::claim_for_name(claims, old) {
            rows.push(BenchRow {
                old: old.clone(),
                outcome: BenchOutcome::ClaimedByQueue {
                    claimed_by: claim.row.clone(),
                },
            });
            continue;
        }
        // Refuse-first: ANY existing target — file, folder, symlink — stops
        // this row; the door never renames onto what is already there.
        if std::fs::symlink_metadata(&target).is_ok() {
            rows.push(BenchRow {
                old: old.clone(),
                outcome: BenchOutcome::TargetExists,
            });
            continue;
        }
        if let Some(parent) = target.parent() {
            if let Err(problem) = std::fs::create_dir_all(parent) {
                rows.push(BenchRow {
                    old: old.clone(),
                    outcome: BenchOutcome::MoveFailed {
                        problem: problem.to_string(),
                    },
                });
                continue;
            }
        }
        // SAME-ROOT LAW (bench-behaviour leg P3, asserted before the rename):
        // the operation is a move WITHIN the served root — the source came from
        // `contained` (root-joined segments only, traversal and absolute forms
        // already refused), the target is root + one folder segment + the same
        // segments. The canary turns a future wiring slip into a loud failure.
        debug_assert!(
            source.starts_with(root) && target.starts_with(root),
            "a bench rename never leaves the served root: {source:?} -> {target:?}"
        );
        let outcome = match std::fs::rename(&source, &target) {
            // MOVE, never copy-and-delete (leg P3): rename semantics — after
            // `Ok` the source address is gone and the target holds the same
            // bytes. The canary turns a filesystem surprise into a loud
            // failure instead of a silent `{old,new}` lie.
            Ok(()) => {
                debug_assert!(
                    source.symlink_metadata().is_err() && target.symlink_metadata().is_ok(),
                    "the rename answered Ok but the move shape is broken: {source:?} -> {target:?}"
                );
                BenchOutcome::Moved { new }
            }
            Err(problem) => BenchOutcome::MoveFailed {
                problem: problem.to_string(),
            },
        };
        rows.push(BenchRow {
            old: old.clone(),
            outcome,
        });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn place(root: &Path, rel: &str, bytes: &[u8]) {
        let target = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("folder");
        }
        fs::write(&target, bytes).expect("placed file");
    }

    #[test]
    fn the_listing_walks_recursively_and_labels_the_stock_media_kinds() {
        let root = tempfile::tempdir().expect("output root");
        let place_recent = |root: &Path, rel: &str, bytes: &[u8]| {
            place(root, rel, bytes);
            // E22 sorts by mtime; separate the writes so the fixture order is real.
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        place_recent(root.path(), "hero.png", b"png bytes");
        place_recent(root.path(), "starred/raw/keep.mp4", b"video bytes");
        place_recent(root.path(), "raw/deep/nested.wav", b"audio bytes");
        place_recent(root.path(), "notes.txt", b"not media");
        let listing = list_outputs(root.path()).expect("listing");
        let rows: Vec<(&str, &str, &str)> = listing
            .rows
            .iter()
            .map(|row| (row.subfolder.as_str(), row.filename.as_str(), row.kind))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("raw/deep", "nested.wav", "audio"),
                ("starred/raw", "keep.mp4", "video"),
                ("", "hero.png", "image"),
            ],
            "most recent first (E22 recency law, same as the inputs door); the recursion never follows a symlink"
        );
        assert_eq!(listing.unlisted, 1, "the txt counts, unlabeled");
        assert!(!listing.truncated);
        let text = serde_json::to_string(
            &listing
                .rows
                .iter()
                .map(OutputRow::row_json)
                .collect::<Vec<_>>(),
        )
        .expect("rows serialize");
        assert!(
            !text.contains(&root.path().to_string_lossy().into_owned()),
            "the privacy law holds: no absolute root reaches the wire: {text}"
        );
    }

    #[test]
    fn the_listing_cap_is_reported_not_silently_applied() {
        let root = tempfile::tempdir().expect("output root");
        for index in 0..MAX_OUTPUT_ROWS + 5 {
            place(root.path(), &format!("out-{index:04}.png"), b"png");
        }
        let listing = list_outputs(root.path()).expect("listing");
        assert_eq!(listing.rows.len(), MAX_OUTPUT_ROWS);
        assert!(listing.truncated);
    }

    #[test]
    fn the_containment_wall_refuses_forms_and_walks_but_never_escapes() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/hero.png", b"0123456789");
        let outside = root.path().join("..").join("outside-secret.png");
        fs::write(&outside, b"never served").expect("outside file");
        for bad in [
            "",
            "..",
            "../outside-secret.png",
            "deas-inputs/../../outside-secret.png",
            "/absolute.png",
            "C:\\x.png",
            "a\\b.png",
            "deas-inputs//hero.png",
            "./deas-inputs/hero.png",
            "deas-inputs/hero.png\0",
        ] {
            let error = contained(root.path(), bad).expect_err("{bad:?} refused");
            assert_eq!(
                error.body_json()["reason"],
                "bodyInvalid",
                "{bad:?}: the grammar wall answers bodyInvalid"
            );
        }
        // A missing file is honest: routeNotFound, naming the listing remedy.
        let missing = contained(root.path(), "deas-inputs/gone.png").expect_err("missing");
        assert_eq!(missing.body_json()["reason"], "routeNotFound");
        assert!(contained(root.path(), "deas-inputs/hero.png").is_ok());
        let _ = fs::remove_file(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_at_any_level_is_refused_before_the_read() {
        let root = tempfile::tempdir().expect("served root");
        let outside =
            std::env::temp_dir().join(format!("deas-symlink-outside-{}", std::process::id()));
        fs::write(&outside, b"escape payload").expect("outside file");
        let link_dir = root.path().join("links");
        fs::create_dir_all(&link_dir).expect("dir");
        std::os::unix::fs::symlink(&outside, link_dir.join("esc.png")).expect("symlink");
        let error = contained(root.path(), "links/esc.png").expect_err("the walk refuses");
        assert_eq!(error.body_json()["reason"], "bodyInvalid");
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn the_range_subset_slices_exactly_and_nothing_else_negotiates() {
        assert_eq!(parse_range(&HeaderMap::new(), 10), Slice::Whole);
        let mut headers = HeaderMap::new();
        headers.insert("range", "bytes=2-5".parse().expect("header"));
        assert!(matches!(
            parse_range(&headers, 10),
            Slice::Part { start: 2, end: 5 }
        ));
        headers.clear();
        headers.insert("range", "bytes=8-".parse().expect("header"));
        assert!(matches!(
            parse_range(&headers, 10),
            Slice::Part { start: 8, end: 9 }
        ));
        headers.clear();
        headers.insert("range", "bytes=-3".parse().expect("header"));
        assert!(matches!(
            parse_range(&headers, 10),
            Slice::Part { start: 7, end: 9 }
        ));
        headers.clear();
        headers.insert("range", "bytes=12-20".parse().expect("header"));
        assert!(matches!(parse_range(&headers, 10), Slice::Unsatisfiable));
        // End past the file clamps; comma lists and noise serve the whole file.
        headers.clear();
        headers.insert("range", "bytes=0-99".parse().expect("header"));
        assert!(matches!(
            parse_range(&headers, 10),
            Slice::Part { start: 0, end: 9 }
        ));
        for noise in ["bytes=0-1,4-5", "items=1", "bytes=abc"] {
            headers.clear();
            headers.insert("range", noise.parse().expect("header"));
            assert!(matches!(parse_range(&headers, 10), Slice::Whole), "{noise}");
        }
    }

    #[test]
    fn a_served_file_answers_with_ranges_and_the_exact_window() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/hero.png", b"0123456789");
        let caps = Caps {
            download_single_mib: 1,
            ..Caps::default()
        };
        let response = serve_bytes(root.path(), caps, "deas-inputs/hero.png", &HeaderMap::new())
            .expect("served");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.headers()["content-length"], "10");

        let mut headers = HeaderMap::new();
        headers.insert("range", "bytes=2-5".parse().expect("header"));
        let response =
            serve_bytes(root.path(), caps, "deas-inputs/hero.png", &headers).expect("sliced");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
    }

    #[test]
    fn the_read_cap_bites_first_with_the_409_restate_naming_size_and_cap() {
        let root = tempfile::tempdir().expect("served root");
        let file = root.path().join("big.png");
        let handle = fs::File::create(&file).expect("file");
        handle.set_len(2 * 1024 * 1024).expect("2 MiB");
        let caps = Caps {
            download_single_mib: 1,
            ..Caps::default()
        };
        let error = serve_bytes(root.path(), caps, "big.png", &HeaderMap::new())
            .expect_err("over the read cap");
        let response = error.clone().into_response();
        assert_eq!(
            response.status(),
            StatusCode::CONFLICT,
            "the on-disk door answers the 409 restate, not the canonical 413"
        );
        let body = error.body_json();
        assert_eq!(body["reason"], "capExceeded");
        let hint = body["hint"].as_str().expect("hint");
        assert!(hint.contains("2097152"), "{hint} names the size");
        assert!(hint.contains("1 MiB"), "{hint} names the cap");
    }

    #[test]
    fn the_closed_output_media_map_equals_the_listing_table() {
        // The M16 no-orphan law as a table pin: every extension the enumeration
        // labels must sit in the serving map, and every mapped extension must be
        // a kind the enumeration labels. The extension list mirrors
        // `media.rs::media_kind` verbatim — when either table moves, this pin
        // fails ON PURPOSE so the two doors and the listing move together.
        const LISTED_EXTENSIONS: [&str; 25] = [
            "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "tif", "tiff", "mp4", "mkv",
            "webm", "mov", "avi", "m4v", "mpg", "mpeg", "mp3", "wav", "flac", "ogg", "m4a", "aac",
            "opus",
        ];
        for extension in LISTED_EXTENSIONS {
            assert!(
                crate::media::media_kind(&format!("x.{extension}")).is_some(),
                "{extension} is listed by media_kind: keep the mirror current"
            );
            assert!(
                output_media_type(&format!("x.{extension}")).is_some(),
                "{extension} is listed but the closed output map would refuse it"
            );
        }
        for (extension, mime) in OUTPUT_MEDIA_TYPES {
            assert!(
                crate::media::media_kind(&format!("x.{extension}")).is_some(),
                "{extension} is in the map but not listed: the map would serve an invisible kind"
            );
            assert!(!mime.is_empty(), "{extension} names no type");
        }
        assert_eq!(LISTED_EXTENSIONS.len(), OUTPUT_MEDIA_TYPES.len());
        assert_eq!(output_media_type("notes.txt"), None);
        assert_eq!(output_media_type("noextension"), None);
    }

    #[test]
    fn the_output_door_serves_a_subfolder_video_with_an_honest_content_type() {
        let root = tempfile::tempdir().expect("served root");
        place(
            root.path(),
            "raw/video/DEAS-00001-audio.mp4",
            b"agent video bytes",
        );
        let caps = Caps {
            download_single_mib: 1,
            ..Caps::default()
        };
        let response = serve_output_bytes(
            root.path(),
            caps,
            "raw/video/DEAS-00001-audio.mp4",
            &HeaderMap::new(),
        )
        .expect("served");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "video/mp4");
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["content-length"], "17");
    }

    #[test]
    fn the_output_door_refuses_an_extension_outside_the_closed_map_naming_it() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "raw/notes.txt", b"not media");
        let caps = Caps {
            download_single_mib: 1,
            ..Caps::default()
        };
        let error = serve_output_bytes(root.path(), caps, "raw/notes.txt", &HeaderMap::new())
            .expect_err("outside the closed map");
        let body = error.body_json();
        assert_eq!(body["reason"], "bodyInvalid");
        let hint = body["hint"].as_str().expect("hint");
        assert!(
            hint.contains("closed output media map"),
            "{hint} names the map"
        );
        assert!(hint.contains("mp4"), "{hint} spells the map: {hint}");
    }

    #[test]
    fn the_promote_copy_lands_as_a_legal_placement_name_no_cap_and_no_network() {
        let outputs = tempfile::tempdir().expect("output root");
        let inputs = tempfile::tempdir().expect("input root");
        place(outputs.path(), "starred/hero.png", b"png hero bytes");
        let answer =
            promote_copy(outputs.path(), inputs.path(), "starred", "hero.png").expect("promoted");
        let name = answer["name"].as_str().expect("name");
        assert!(
            name.starts_with("deas-inputs/") && name.ends_with(".png"),
            "the placement idiom: {name}"
        );
        // The answer is a legal upload-grammar reference end to end.
        uploads::check_name(name.split('/').next_back().expect("final segment"))
            .expect("the minted file name passes the bare-name wall");
        assert!(
            crate::jobs::model_name(name),
            "the stock compiler counts it"
        );
        assert!(
            super::super::inputs::input_present(inputs.path(), name),
            "the copy is on disk where the name says"
        );
        let copied = fs::read(
            inputs
                .path()
                .join("deas-inputs")
                .join(name.split('/').next_back().unwrap()),
        )
        .expect("copy");
        assert_eq!(
            copied, b"png hero bytes",
            "server-side copy, verbatim bytes"
        );
        assert_eq!(answer["bytes"], 14);
    }

    #[test]
    fn the_promote_source_passes_the_same_containment_wall_as_the_reads() {
        let outputs = tempfile::tempdir().expect("output root");
        let inputs = tempfile::tempdir().expect("input root");
        for (subfolder, name) in [
            ("../secrets", "x.png"),
            ("starred/../../", "x.png"),
            ("", "../escape.png"),
        ] {
            let error = promote_copy(outputs.path(), inputs.path(), subfolder, name)
                .expect_err("the wall refuses before any copy");
            assert_eq!(error.body_json()["reason"], "bodyInvalid");
        }
        let missing = promote_copy(outputs.path(), inputs.path(), "starred", "gone.png")
            .expect_err("a missing source is honest");
        assert_eq!(missing.body_json()["reason"], "routeNotFound");
    }

    /* ---- BENCH DOOR tests (LEG M17b, ruling E22 BENCH) ---- */

    /// The stamp grammar is closed and UTC: `.bench/YYYYMMDDTHHMMSSZ` (the
    /// dot-prefixed parent plus one stamp segment — the owner sweep ruling
    /// 2026-11-22), the ruling's own timestamp included. A pre-epoch clock
    /// answers 1970 (the spool's hostile-clock honesty marker, never a panic);
    /// milliseconds truncate; the leap day lands where the calendar says.
    #[test]
    fn the_bench_stamp_is_the_closed_utc_grammar() {
        assert_eq!(bench_folder_name(0), ".bench/19700101T000000Z");
        assert_eq!(
            bench_folder_name(951_827_696_000),
            ".bench/20000229T123456Z"
        );
        assert_eq!(
            bench_folder_name(1_709_251_199_999),
            ".bench/20240229T235959Z",
            "milliseconds truncate; the leap day rides"
        );
        assert_eq!(
            bench_folder_name(1_795_277_498_000),
            ".bench/20261121T161138Z",
            "the E22 ruling's own timestamp, verbatim"
        );
        assert_eq!(
            bench_folder_name(1_798_761_599_000),
            ".bench/20261231T235959Z"
        );
        assert_eq!(
            bench_folder_name(0).chars().count(),
            23,
            "the closed shape: the 7-char `.bench/` parent plus the 16-char stamp (the design note's 24 miscounts the stamp grammar it names)"
        );
        assert_eq!(
            &bench_folder_name(0)[..BENCH_PARENT.len()],
            BENCH_PARENT,
            "the parent rides the front of the folder name"
        );
        assert_eq!(
            bench_folder_name(0).split('/').count(),
            2,
            "parent plus exactly one stamp segment"
        );
    }

    /// The headline law: one call, one stamp, every moved item keeps its FULL
    /// source-relative name under the dot folder — the answer is a round-trip
    /// (the byte door serves `new`; the old path is gone), and BOTH walks skip
    /// the folder (the M17a pre-positioned dot law, pinned end to end here).
    /// E20-AMENDED: an operator drop (not placement grammar) moves too — the
    /// source wall is the containment law, not the placement grammar.
    #[test]
    fn the_bench_move_keeps_the_full_source_name_under_the_folder() {
        let root = tempfile::tempdir().expect("input root");
        place(root.path(), "deas-inputs/project1/pic.jpg", b"nested jpeg");
        place(root.path(), "deas-masks/m.png", b"mask");
        place(root.path(), "deas-input-clip.mp4", b"video bytes");
        place(root.path(), "operator-drop.png", b"no prefix at the root");
        let names = [
            "deas-inputs/project1/pic.jpg".to_owned(),
            "deas-masks/m.png".to_owned(),
            "deas-input-clip.mp4".to_owned(),
            "operator-drop.png".to_owned(),
        ];
        let folder = bench_folder_name(1_795_277_498_000);
        let rows = bench_move(root.path(), &names, &folder, &[]).expect("bench");
        let news: Vec<&str> = rows
            .iter()
            .map(|row| match &row.outcome {
                BenchOutcome::Moved { new } => new.as_str(),
                other => panic!("every source was staged: {other:?}"),
            })
            .collect();
        assert_eq!(
            news,
            vec![
                ".bench/20261121T161138Z/deas-inputs/project1/pic.jpg",
                ".bench/20261121T161138Z/deas-masks/m.png",
                ".bench/20261121T161138Z/deas-input-clip.mp4",
                ".bench/20261121T161138Z/operator-drop.png",
            ],
            "one stamp per call; the full source-relative name rides under the folder"
        );
        for old in &names {
            assert!(
                !root
                    .path()
                    .join(old.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .exists(),
                "{old} moved: a MOVE, not a copy"
            );
        }
        assert_eq!(
            fs::read(
                root.path()
                    .join(&folder)
                    .join("deas-inputs")
                    .join("project1")
                    .join("pic.jpg")
            )
            .expect("benched bytes"),
            b"nested jpeg",
            "create_dir_all prepared the placement tail"
        );
        // Both walks skip the dot folder at every level (M17a pre-positioned;
        // pinned here as the bench law): the benched rows are absent AND the
        // folder itself is never a row.
        let listing = list_outputs(root.path()).expect("listing");
        assert!(
            listing.rows.is_empty(),
            "the output walk skips the dot folder"
        );
        let inventory = super::super::inputs::inventory(root.path()).expect("input inventory");
        assert!(
            inventory.rows.is_empty(),
            "the input walk skips the dot folder: {:?}",
            inventory.rows
        );
        // The byte door reaches the benched path by explicit name: a leading-
        // dot segment is a legal containment segment (only empty/`.`/`..` refuse).
        let served = serve_bytes(
            root.path(),
            Caps::default(),
            ".bench/20261121T161138Z/deas-inputs/project1/pic.jpg",
            &HeaderMap::new(),
        )
        .expect("benched bytes are served");
        assert_eq!(served.status(), StatusCode::OK);
    }

    /// A refusal is a ROW, not the call: missing sources answer `notFound`, a
    /// target already on disk answers `targetExists` (never moved onto —
    /// rename-replace would be an unruled delete), and the neighbors still
    /// move. Rows stay in request order, so the answer reads as an old→new map.
    #[test]
    fn a_bench_refusal_is_a_row_not_the_call() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/here.png", b"here");
        place(root.path(), "deas-inputs/other.png", b"other");
        let folder = bench_folder_name(1_795_277_498_000);
        // Pre-collide the first row's target on disk (an older bench of the
        // same name under the same stamp-second folder).
        fs::create_dir_all(root.path().join(&folder).join("deas-inputs")).expect("folder");
        fs::write(
            root.path()
                .join(&folder)
                .join("deas-inputs")
                .join("here.png"),
            b"elder",
        )
        .expect("elder file");
        let names = [
            "deas-inputs/here.png".to_owned(),
            "deas-inputs/gone.png".to_owned(),
            "deas-inputs/other.png".to_owned(),
            "deas-inputs/folder-itself".to_owned(),
        ];
        fs::create_dir_all(root.path().join("deas-inputs").join("folder-itself")).expect("dir");
        let rows = bench_move(root.path(), &names, &folder, &[]).expect("partials answer 200");
        let words: Vec<(&str, String)> = rows
            .iter()
            .map(|row| {
                (
                    row.old.as_str(),
                    match &row.outcome {
                        BenchOutcome::Moved { new } => format!("moved:{new}"),
                        BenchOutcome::NotFound => "notFound".to_owned(),
                        BenchOutcome::TargetExists => "targetExists".to_owned(),
                        BenchOutcome::MoveFailed { problem } => {
                            format!("moveFailed:{problem}")
                        }
                        BenchOutcome::ClaimedByQueue { claimed_by } => {
                            format!("claimedByQueue:{claimed_by}")
                        }
                    },
                )
            })
            .collect();
        assert_eq!(
            words,
            vec![
                ("deas-inputs/here.png", "targetExists".to_owned()),
                ("deas-inputs/gone.png", "notFound".to_owned()),
                (
                    "deas-inputs/other.png",
                    format!("moved:{folder}/deas-inputs/other.png")
                ),
                ("deas-inputs/folder-itself", "notFound".to_owned()),
            ],
            "request order; the survivor moved despite failing neighbors; a folder is not a placement"
        );
        assert_eq!(
            fs::read(
                root.path()
                    .join(&folder)
                    .join("deas-inputs")
                    .join("here.png")
            )
            .expect("elder"),
            b"elder",
            "the refused target kept its bytes: never moved onto"
        );
    }

    /// The wall/row boundary: a grammar violation (traversal) hoists to the
    /// CALL as `bodyInvalid` — and it hoists BEFORE any rename, so a valid
    /// name earlier in the list stays exactly where it was. Passes are
    /// validate-all-then-move-all, never half-moved.
    #[test]
    fn the_bench_source_wall_hoists_before_any_rename() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/valid.png", b"valid");
        let folder = bench_folder_name(1_795_277_498_000);
        for bad in [
            "../escape.png",
            "deas-inputs//double.png",
            "deas-inputs/./self.png",
            "C:\\windows.png",
            "deas-inputs/hero.png\0",
        ] {
            let names = [
                "deas-inputs/valid.png".to_owned(),
                "deas-inputs/gone.png".to_owned(),
                bad.to_owned(),
            ];
            let error = bench_move(root.path(), &names, &folder, &[]).expect_err("{bad} hoists");
            assert_eq!(
                error.body_json()["reason"],
                "bodyInvalid",
                "the shared containment wall keeps its word: {bad:?}"
            );
        }
        assert!(
            root.path().join("deas-inputs").join("valid.png").exists(),
            "nothing moved: a hoisted refusal means the call never touched the disk"
        );
        assert!(
            !root.path().join(&folder).exists(),
            "the folder itself was never even prepared"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_bench_source_symlink_hoists_the_same_body_invalid() {
        let root = tempfile::tempdir().expect("served root");
        let outside =
            std::env::temp_dir().join(format!("deas-bench-outside-{}", std::process::id()));
        fs::write(&outside, b"escape payload").expect("outside file");
        fs::create_dir_all(root.path().join("links")).expect("dir");
        std::os::unix::fs::symlink(&outside, root.path().join("links").join("esc.png"))
            .expect("symlink");
        let folder = bench_folder_name(1_795_277_498_000);
        let error = bench_move(root.path(), &["links/esc.png".to_owned()], &folder, &[])
            .expect_err("the walk refuses the symlink");
        assert_eq!(error.body_json()["reason"], "bodyInvalid");
        assert!(outside.exists(), "the escape payload was never touched");
        let _ = fs::remove_file(&outside);
    }

    /* ---- BENCH BEHAVIOUR LEG tests (owner ruling 2026-11-22: P1 lazy folder +
    same-second reuse, P3 move-not-delete + name-shape law) ---- */

    /// P1 (the live-observed flaw): a call whose every row is refused must
    /// leave NOTHING on disk — no `.bench` parent, no stamp folder inside it.
    /// The folder is minted lazily at the first rename-bound row; refused rows
    /// never reach it.
    #[test]
    fn a_fully_refused_bench_call_leaves_no_folder_on_disk() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/claimed.png", b"claimed");
        let folder = bench_folder_name(1_795_277_498_000);
        let claims = [super::super::inputs::InputClaim {
            name: "deas-inputs/claimed.png".to_owned(),
            row: "row-a".to_owned(),
        }];
        let names = [
            "deas-inputs/gone.png".to_owned(),
            "deas-inputs/claimed.png".to_owned(),
        ];
        let rows = bench_move(root.path(), &names, &folder, &claims).expect("partials answer 200");
        assert_eq!(
            rows.iter()
                .filter(|row| matches!(row.outcome, BenchOutcome::Moved { .. }))
                .count(),
            0,
            "every row refused: {rows:?}"
        );
        let entries: Vec<String> = fs::read_dir(root.path())
            .expect("root readable")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !entries.iter().any(|name| name == BENCH_PARENT),
            "an all-refused call minted the .bench parent: {entries:?}"
        );
        assert!(
            root.path().join("deas-inputs").join("claimed.png").exists(),
            "the claimed source stayed exactly where the drain will look for it"
        );
    }

    /// P1 (same-second reuse law): the stamped folder already exists — a
    /// same-second sibling call, or older disk state the clock landed on — the
    /// call REUSES it: no error, no minted suffix. A same-name retry inside
    /// that shared folder answers the honest per-row `targetExists`.
    #[test]
    fn two_calls_under_one_stamp_second_share_the_same_folder() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/a.png", b"a");
        place(root.path(), "deas-inputs/b.png", b"b");
        let folder = bench_folder_name(1_795_277_498_000);
        // Pre-mint the folder: the same-second elder call benched something else
        // (or nothing at all — the folder existing is the whole condition).
        fs::create_dir_all(root.path().join(&folder)).expect("elder folder");
        let rows_1 = bench_move(root.path(), &["deas-inputs/a.png".to_owned()], &folder, &[])
            .expect("first call");
        let rows_2 = bench_move(root.path(), &["deas-inputs/b.png".to_owned()], &folder, &[])
            .expect("second call");
        assert!(
            matches!(rows_1[0].outcome, BenchOutcome::Moved { .. })
                && matches!(rows_2[0].outcome, BenchOutcome::Moved { .. }),
            "an existing folder never blocks: {rows_1:?} / {rows_2:?}"
        );
        assert_eq!(
            fs::read(root.path().join(&folder).join("deas-inputs").join("a.png")).expect("a"),
            b"a"
        );
        assert_eq!(
            fs::read(root.path().join(&folder).join("deas-inputs").join("b.png")).expect("b"),
            b"b",
            "one folder, both calls, no suffix minted"
        );
        let benched: Vec<String> = fs::read_dir(root.path().join(BENCH_PARENT))
            .expect("the .bench parent readable")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            benched,
            vec![folder.split('/').nth(1).expect("the stamp segment")],
            "exactly ONE stamp folder inside the .bench parent"
        );
        // Same name, same shared folder: the collision word is the per-row
        // targetExists — never an error, never a second folder.
        place(root.path(), "deas-inputs/a.png", b"a again");
        let rows_3 = bench_move(root.path(), &["deas-inputs/a.png".to_owned()], &folder, &[])
            .expect("retry");
        assert_eq!(rows_3[0].outcome, BenchOutcome::TargetExists);
    }

    /// P3 (move-not-delete shape law, documented as a test over the code
    /// canary): a successful `{old,new}` row means the SOURCE path is gone and
    /// the NEW path exists with the same bytes — rename, never copy, never
    /// delete. The never-moved-onto twin (`targetExists` refusal) is pinned by
    /// `a_bench_refusal_is_a_row_not_the_call`; the escape law (dot-dot and
    /// absolute sources hoist `bodyInvalid` before any rename) is pinned by
    /// `the_bench_source_wall_hoists_before_any_rename`.
    #[test]
    fn the_bench_move_shape_source_gone_target_present_same_bytes() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/deep/x.png", b"payload");
        let folder = bench_folder_name(1_795_277_498_000);
        let rows = bench_move(
            root.path(),
            &["deas-inputs/deep/x.png".to_owned()],
            &folder,
            &[],
        )
        .expect("move");
        assert_eq!(
            rows[0].outcome,
            BenchOutcome::Moved {
                new: format!("{folder}/deas-inputs/deep/x.png"),
            }
        );
        assert!(
            !root
                .path()
                .join("deas-inputs")
                .join("deep")
                .join("x.png")
                .exists(),
            "after {{old,new}} the source address is GONE"
        );
        assert_eq!(
            fs::read(
                root.path()
                    .join(&folder)
                    .join("deas-inputs")
                    .join("deep")
                    .join("x.png")
            )
            .expect("after {old,new} the new address EXISTS"),
            b"payload",
            "and carries the same bytes — a move, not a copy"
        );
    }

    /// P3 (name-shape law, asserted in code): the bench folder is the `.bench`
    /// parent plus exactly ONE stamp segment — a deeper path (three segments)
    /// is a programmer-side violation and the `debug_assert` fires before any
    /// rename is issued (release builds keep the containment law; the assert
    /// is the debug-profile canary the suite pins). A normal `.bench/<stamp>`
    /// folder is legal — every other bench test here rides one.
    #[test]
    #[should_panic(expected = "the bench folder is .bench/<stamp>")]
    fn a_multi_segment_bench_folder_panics_the_shape_assert() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "x.png", b"x");
        let _ = bench_move(root.path(), &["x.png".to_owned()], ".bench/2026/a", &[]);
    }

    /* ---- BENCH CLAIM GUARD tests (LEG AF2-M18c: the bench-vs-spool TOCTOU) ---- */

    /// The claim matcher: equality in the placement form the collector produces,
    /// containment at whole segment boundaries, and never a false hit on a
    /// sibling name. The row→claim half (the collector over live rows) is proven
    /// end to end at the door in `transport.rs`.
    #[test]
    fn the_claim_matcher_spans_the_placement_form_and_never_a_sibling_name() {
        use crate::agent_api::inputs::{claim_for_name, queued_input_claims, InputClaim};
        let claim = |name: &str, row: &str| InputClaim {
            name: name.to_owned(),
            row: row.to_owned(),
        };
        let claims = [
            claim("deas-inputs/proj/a.png", "row-a"),
            claim("deas-input-clip.mp4", "row-b"),
            claim("deas-masks/m.png", "row-c"),
        ];
        // Equality in the placement form, and the nested placement form.
        for (name, row) in [
            ("deas-inputs/proj/a.png", "row-a"),
            ("deas-input-clip.mp4", "row-b"),
            ("deas-masks/m.png", "row-c"),
        ] {
            let hit = claim_for_name(&claims, name).expect("the placement name is claimed");
            assert_eq!(hit.row, row, "the claiming row is the one named: {name}");
        }
        // Containment at whole segment boundaries (the deeper path that still
        // ends at the claimed placement), and the byte door's escaped form.
        for name in [
            "archive/deas-inputs/proj/a.png",
            "deas-inputs%2Fproj%2Fa.png",
            "x/deas-masks/m.png/y",
        ] {
            assert!(
                claim_for_name(&claims, name).is_some(),
                "a name that contains a claimed placement as a segment run is refused: {name}"
            );
        }
        // Neighbours are never caught by a claim: segment boundaries only, never
        // a substring of a longer segment or of a sibling name.
        for name in [
            "deas-inputs/a.png",
            "deas-inputs/proj/ab.png",
            "archive/deas-inputs/proj/a.png.bak",
            "deas-input-clip.mp4.bak",
            "deas-inputs/proj/a.png.evil",
        ] {
            assert!(
                claim_for_name(&claims, name).is_none(),
                "a name that is not the claimed placement still moves: {name}"
            );
        }
        assert!(
            queued_input_claims(&[]).is_empty(),
            "an empty spool claims nothing"
        );
    }

    /* ---- BENCH SWEEP LEG tests (owner ruling 2026-11-22: whole-root sweeps,
    no body list, one dated folder inside the .bench parent) ---- */

    /// The sweep's dot law: the `.bench` parent is NEVER re-swept (neither
    /// after a fresh sweep minted it nor as pre-existing disk state), the
    /// legacy `.bench-<stamp>` folders from the pre-sweep grammar are skipped
    /// with their contents, and any dot state stays invisible.
    #[test]
    fn sweep_names_skips_the_bench_parent_and_every_dot_folder() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/hero.png", b"hero");
        place(root.path(), ".state/config.json", b"dot state file");
        place(
            root.path(),
            ".bench-20260101T000000Z/old.png",
            b"legacy benched file",
        );
        place(root.path(), ".hidden.png", b"dot file");
        let names = sweep_names(root.path()).expect("walk");
        assert_eq!(
            names,
            vec!["deas-inputs/hero.png"],
            "dot entries never sweep"
        );
        // A fresh sweep's own .bench parent is invisible to the next sweep:
        // sweeping once, then sweeping again, collects nothing new.
        let folder = bench_folder_name(1_795_277_498_000);
        bench_move(root.path(), &names, &folder, &[]).expect("first sweep");
        assert_eq!(
            sweep_names(root.path()).expect("second walk"),
            Vec::<String>::new(),
            "the .bench parent (and everything benched inside it) is never re-swept"
        );
        assert!(
            root.path()
                .join(".bench-20260101T000000Z")
                .join("old.png")
                .exists(),
            "the legacy dot folder stayed exactly where it was"
        );
    }

    /// Regular files only: directories are descended into, never collected as
    /// rows, and empty leftover directories are not names (the sweep never
    /// deletes a directory, so leftovers simply produce no rows).
    #[test]
    fn sweep_names_collects_regular_files_never_directories() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-inputs/project1/deep/pic.jpg", b"deep");
        place(root.path(), "loose.wav", b"loose");
        fs::create_dir_all(root.path().join("empty-dir")).expect("empty dir");
        fs::create_dir_all(root.path().join("nested").join("emptier")).expect("nested dirs");
        let mut names = sweep_names(root.path()).expect("walk");
        names.sort();
        assert_eq!(
            names,
            vec!["deas-inputs/project1/deep/pic.jpg", "loose.wav"],
            "directories are walked through, never named"
        );
    }

    /// Root-relative names join with '/' on every platform (the walk's own
    /// separators never leak onto the wire), and the list is deterministic
    /// (sorted) regardless of the filesystem's read_dir order.
    #[test]
    fn sweep_names_are_root_relative_and_slash_joined() {
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "deas-masks/a.png", b"a");
        place(root.path(), "deas-inputs/b/c.mp4", b"c");
        place(root.path(), "top.txt", b"top");
        let names = sweep_names(root.path()).expect("walk");
        assert_eq!(
            names,
            vec!["deas-inputs/b/c.mp4", "deas-masks/a.png", "top.txt"],
            "/-joined, root-relative, sorted"
        );
        assert!(
            names.iter().all(|name| !name.contains('\\')),
            "no platform separator ever rides a sweep name: {names:?}"
        );
    }

    /// The portable arm of the walk-failure law: a root the walk cannot open at
    /// all (a regular file where a directory must be) refuses the WHOLE sweep,
    /// naming what it could not read — a sweep that cannot see the plane will
    /// not half-sweep it (the door hoists the Err as `maintenanceActive`).
    #[test]
    fn sweep_names_refuses_an_unopenable_root_by_name() {
        let root = tempfile::tempdir().expect("served root");
        place(
            root.path(),
            "not-a-directory",
            b"a file where the walk expects a root",
        );
        let problem = sweep_names(&root.path().join("not-a-directory"))
            .expect_err("an unopenable root refuses");
        assert!(
            problem.contains("not-a-directory"),
            "the refusal names the directory it could not read: {problem}"
        );
    }

    /// The POSIX arm of the same law: an unreadable (mode-000) directory refuses
    /// by name — the same unix-only idiom the symlink-source test uses.
    #[cfg(unix)]
    #[test]
    fn sweep_names_refuses_an_unreadable_directory_by_name() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("served root");
        place(root.path(), "blocked/inside.png", b"inside");
        fs::set_permissions(
            root.path().join("blocked"),
            fs::Permissions::from_mode(0o000),
        )
        .expect("permissions");
        let problem = sweep_names(root.path()).expect_err("the unreadable dir refuses");
        assert!(
            problem.contains("blocked"),
            "the refusal names the unreadable directory: {problem}"
        );
        fs::set_permissions(
            root.path().join("blocked"),
            fs::Permissions::from_mode(0o755),
        )
        .expect("restore");
    }
}
