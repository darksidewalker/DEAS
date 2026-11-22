//! The input-plane inventory (M9d, `GET /v1/inputs`): what the upload grammar placed,
//! read by GRAMMAR and nothing else.
//!
//! The honest finding this door keeps: NO provenance record exists stock-side. Nothing on
//! disk says who placed an input, when the plane placed it, or which request did. What
//! DOES exist is a closed placement grammar, minted by the stock seams this plane already
//! calls:
//!
//! * `deas-inputs/<uuid>.<ext>` — images/audio (`jobs::upload_input`, and the plane's own
//!   `POST /v1/uploads` through it);
//! * `deas-masks/<uuid>.png` — masks (`jobs::native_mask_upload`, PNG-only stock law);
//! * `deas-input-<uuid>.<ext>` at the input ROOT — videos, because core `LoadVideo` lists
//!   top-level input files only.
//!
//! So every row here carries `placedByGrammar: true` and the answer carries
//! [`ORIGIN_NOTE`]: the origin tag is grammatical, never provenanced, and a file the
//! grammar never mints (a media-intake copy-in under a bare stem, a file the operator
//! dropped by hand) is NOT listed as plane-placed — it is counted in `unlisted` instead.
//!
//! Reading law: the SAME anchored reader the other fs readers use
//! ([`crate::downloads::fs::Anchor`] open, identity captured, identity re-checked after
//! the walk) over the stock input root from [`crate::media::intake::input_root`] — never a
//! guessed folder. Ruling E22 (LEG M17a): `deas-inputs/` is walked RECURSIVELY (stack
//! walk like the output listing; dot-prefixed entries skipped at every level — the
//! bench law — and symlinks never followed or labeled), while `deas-masks/` and the
//! input root stay top-level (uuid law). Rows sort most-recent-first (mtimeMs
//! descending, placement name as tiebreak — the E22 recency law), the row cap is
//! honest ([`MAX_INPUT_ROWS`], stated in the answer and named in the note when
//! it truncates), and refusal text never carries a local path.

use std::fs::DirEntry;
use std::path::Path;

use serde_json::{json, Map, Value};

use super::spool::{QueueRow, RowStatus};

/// Honest ceiling on one listing: 500 rows, kept most-recent-first (mtimeMs
/// descending, E22 recency law — working files stay reachable under the cap), and
/// the answer says when it cut. Raising it is a plane decision, not a client
/// parameter.
pub(crate) const MAX_INPUT_ROWS: usize = 500;
/// The origin truth, served verbatim in every answer: the tag comes from the placement
/// grammar, and no stock record backs it with provenance.
pub(crate) const ORIGIN_NOTE: &str = "origin is grammatical, not provenanced";

/// Stock placement folders (`jobs::INPUT_FOLDER`, `jobs::MASK_FOLDER`): the grammar words,
/// restated here only because the stock constants are private to `jobs`.
const INPUTS_FOLDER: &str = "deas-inputs";
const MASKS_FOLDER: &str = "deas-masks";
/// The root-level video prefix the stock seam mints (`jobs::upload` with an empty folder).
const ROOT_PREFIX: &str = "deas-input-";

/// The extension sets the stock sniffer (`jobs::sniff_media`) recognizes; a placement
/// outside this table is not grammar-placed media, so it is counted, never labeled.
const IMAGE_EXTENSIONS: [&str; 3] = ["png", "jpg", "webp"];
const AUDIO_EXTENSIONS: [&str; 5] = ["wav", "mp3", "flac", "ogg", "m4a"];
const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "webm", "mkv"];

/// One grammar-matched input: the ComfyUI-relative placement name the stock seam answers
/// (`deas-inputs/…`, `deas-masks/…`, or the root-level `deas-input-…`), never a local
/// path, plus the cheap facts the file itself reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InputRow {
    pub(crate) name: String,
    pub(crate) kind: &'static str,
    pub(crate) size_bytes: u64,
    pub(crate) modified_ms: Option<u64>,
}

/// The whole inventory plus its honesty counters.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Inventory {
    pub(crate) rows: Vec<InputRow>,
    /// True when the walk found more grammar-matched entries than [`MAX_INPUT_ROWS`].
    pub(crate) truncated: bool,
    /// Entries in the walked folders that the placement grammar does not label (a foreign
    /// extension, a mask that is not PNG, a symlink, a hidden file or folder).
    pub(crate) unlisted: usize,
}

impl Inventory {
    /// The note law: the origin truth always, plus the cap sentence when the listing cut.
    pub(crate) fn note(&self) -> String {
        if self.truncated {
            return format!(
                "{ORIGIN_NOTE}; the listing is capped at {MAX_INPUT_ROWS} rows (most recent first) and was truncated — narrow it by folder grammar, the cap is the plane's law"
            );
        }
        ORIGIN_NOTE.to_owned()
    }

    /// One row in the wire shape: the relative placement name, the grammatical kind, the
    /// stock `placedByGrammar` tag, and the file's own size/mtime facts.
    pub(crate) fn row_json(row: &InputRow) -> Value {
        json!({
            "name": row.name,
            "kind": row.kind,
            "placedByGrammar": true,
            "sizeBytes": row.size_bytes,
            "mtimeMs": row.modified_ms,
        })
    }

    /// The rows as served, in the order the cap was applied in.
    pub(crate) fn rows_json(&self) -> Vec<Value> {
        self.rows.iter().map(Self::row_json).collect()
    }
}

/// The grammatical kind of a placement name by its extension, inside the closed content
/// table the stock sniffer defines. `None` means "this name is not grammar-labeled".
fn kind_of(name: &str) -> Option<&'static str> {
    let extension = name
        .rsplit('.')
        .next()
        .filter(|ext| ext.len() < name.len())?;
    let extension = extension.to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Some("image");
    }
    if AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        return Some("audio");
    }
    if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Some("video");
    }
    None
}

/// One walked folder, honestly: a folder that was never used (`NotFound`) is an empty
/// answer, not a failure; every other read error fails closed. Entry-order is filesystem
/// order, so the caller sorts.
fn read_folder(dir: &Path) -> Result<Vec<DirEntry>, String> {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "the input listing is unreadable".to_owned()),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("the input root is unreadable".to_owned()),
    }
}

/// True for a name this walk may label at all: not hidden, not a traversal form.
fn labelable(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && name != ".."
}

/// Walks the input root's three placement sites and labels what the grammar mints.
///
/// `deas-inputs/` descends recursively (ruling E22: subfolders are first-class
/// placement; the stack walk mirrors the output listing, dot-prefixed entries are
/// skipped at every level so the bench folder hides itself, and symlinks are never
/// followed). `deas-masks/` and the input root stay top-level (uuid law).
///
/// The anchor identity is captured before the walk and re-checked after it: a root
/// that was swapped mid-listing (a reparse-point substitution, a moved folder)
/// answers an error rather than a listing that mixes two trees. Refusal text is
/// fixed-worded — no local path is ever returned.
///
/// # Errors
///
/// Names the anchored reader's own honest failure ("the input root is unreadable", "the
/// input root changed during the listing"); the door surfaces that as a refusal instead
/// of an empty inventory.
pub(crate) fn inventory(root: &Path) -> Result<Inventory, String> {
    let anchor = crate::downloads::fs::Anchor::open(root)
        .map_err(|_| "the input root is unreadable".to_owned())?;
    let identity = anchor
        .identity()
        .map_err(|_| "the input root is unreadable".to_owned())?;
    let mut found: Vec<InputRow> = Vec::new();
    let mut unlisted = 0_usize;

    // 1. `deas-inputs/` walked RECURSIVELY (E22): nested names are rows; the
    //    extension decides the kind at every depth. Dot-prefixed entries (files
    //    AND folders) count as unlisted and stop the descent — hidden from the
    //    listing by law, never silently invisible.
    let mut stack: Vec<(std::path::PathBuf, String)> =
        vec![(root.join(INPUTS_FOLDER), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for entry in read_folder(&dir)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !labelable(&name) {
                unlisted += 1;
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                unlisted += 1;
                continue;
            };
            if file_type.is_symlink() {
                unlisted += 1;
                continue;
            }
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if file_type.is_dir() {
                stack.push((entry.path(), path));
                continue;
            }
            if !file_type.is_file() {
                unlisted += 1;
                continue;
            }
            match kind_of(&name) {
                Some(kind) => match describe(&entry) {
                    Some((size, modified)) => found.push(InputRow {
                        name: format!("{INPUTS_FOLDER}/{path}"),
                        kind,
                        size_bytes: size,
                        modified_ms: modified,
                    }),
                    None => unlisted += 1,
                },
                None => unlisted += 1,
            }
        }
    }

    // 2. The mask folder stays top-level: a mask's kind is the folder's law (PNG
    //    only, the stock mask seam's own magic rule; the uuid law is untouched).
    for entry in read_folder(&root.join(MASKS_FOLDER))? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !labelable(&name) {
            unlisted += 1;
            continue;
        }
        let kind = (name.to_ascii_lowercase().ends_with(".png")).then_some("mask");
        match kind {
            Some(kind) => match describe(&entry) {
                Some((size, modified)) => found.push(InputRow {
                    name: format!("{MASKS_FOLDER}/{name}"),
                    kind,
                    size_bytes: size,
                    modified_ms: modified,
                }),
                None => unlisted += 1,
            },
            None => unlisted += 1,
        }
    }

    // 3. The input root's own top level: only the `deas-input-` prefix the stock video
    //    seam mints. Everything else at the root (media-intake copy-ins under bare stems,
    //    operator drops, the folders themselves) is counted, not labeled.
    for entry in read_folder(root)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(ROOT_PREFIX) {
            continue;
        }
        match kind_of(&name) {
            Some(kind) => match describe(&entry) {
                Some((size, modified)) => found.push(InputRow {
                    name,
                    kind,
                    size_bytes: size,
                    modified_ms: modified,
                }),
                None => unlisted += 1,
            },
            None => unlisted += 1,
        }
    }

    if crate::downloads::fs::Anchor::open(root)
        .map_err(|_| "the input root is unreadable".to_owned())?
        .identity()
        .map_err(|_| "the input root is unreadable".to_owned())?
        != identity
    {
        return Err("the input root changed during the listing".to_owned());
    }

    // E22 recency law: newest first (None mtimes sort last), placement name as a
    // deterministic tiebreak so the cap keeps a stable set.
    found.sort_by(|left, right| {
        right.modified_ms.cmp(&left.modified_ms).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
    let truncated = found.len() > MAX_INPUT_ROWS;
    found.truncate(MAX_INPUT_ROWS);
    Ok(Inventory {
        rows: found,
        truncated,
        unlisted,
    })
}

/// The file's own size and modification time; `None` for anything that is not a plain
/// file (a directory, a symlink, an entry whose metadata vanished). Symlinks are never
/// followed or labeled: the grammar mints real files.
fn describe(entry: &DirEntry) -> Option<(u64, Option<u64>)> {
    let file_type = entry.file_type().ok()?;
    if !file_type.is_file() {
        return None;
    }
    let metadata = entry.metadata().ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64);
    Some((metadata.len(), modified_ms))
}

/* ---------------- EXISTENCE LAW (LEG MEDIA-1, owner ruling E21) ----------------

No job enters the spool while any input reference it NAMES is absent from the
input plane on disk. The check is in-process (the stock input-root seam, never an
HTTP `/view` probe): the owned backend may be legitimately DOWN at queue time —
the idle-proof law — and the stat answer stands either way. ON-DISK files cost
nothing: a placed reference of any size satisfies the law; the network caps live
at the upload door, not here.
--------------------------------------------------------------------------- */

/* THE W3-1 FOLDED-NAMESPACE AUDIT (LEG AF2-M21b, adjudicated WALK 3 D-1). -----------

Every key the FOLDED intent can carry that `jobs::compile` consumes as an input FILE
NAME in ANY mode, and the collector arm that walks it. A queued row's claim at the
bench doors is computed from the drain's own reconstruction (`spool::flat_intent`),
which merges the fill plane's validated extras — so a key the fill plane MINTS is
invisible to the collector unless it appears in one of the arms below. The audit
against the three compile arms (`jobs.rs`, `jobs_video.rs`, `jobs_music.rs` + the
`fill_plane` passthrough tables) lands on exactly ten carriers:

| key                    | arm                      | compile consumer                                   |
|------------------------|--------------------------|----------------------------------------------------|
| images[]/videos[]/audio[] | canonical arrays      | Director media slots (ref2va lanes ride the names) |
| inputImage             | named key                | image i2i leg (jobs.rs:488, graph :1945)           |
| inputMask              | named key                | image inpaint leg (jobs.rs:494)                    |
| sourceVideo            | named key                | LTX v2v leg (jobs_video.rs:1410, graph :1983)      |
| firstFrame / lastFrame | named key                | video frame legs (jobs_video.rs:1418, graph :1996) |
| sourceAudio            | named key — **minted**   | YuE2 cover row (jobs_music.rs:135); minted by      |
|                        |                          | `fill_music_yue2` (fill_plane.rs:2270) from the    |
|                        |                          | one `audio[]` reference — the W3-1 hole this audit |
|                        |                          | closed: the cover row claimed NOTHING to the bench |
| inputLayers[].image    | layered-object arm       | image layers (jobs.rs:540, graph :1949)            |
| imageReference.images[].image | reference-object arm | IP-Adapter leg (jobs.rs:642, graph :1956)        |
| nativeImageReference.images[] | reference-object arm | native reference leg (jobs.rs:643, graph :1963) |
| h3 / ltx / wan blocks  | recipe-block walk        | REF2VA media bags (`h3.media[].file`, minted),     |
|                        |                          | H3 still refs (`h3.references[].image`, minted),   |
|                        |                          | LTX keyframes — placement strings ride the block   |

Nothing else in the folded namespace names an input file: model slots (`checkpoint`,
`diffusion{}`, `upscaleModel`, `audioEncoder`, `visionModel`) resolve against the
library, `outputPrefix`/`output` are output-side, and the e16 seam already rewrote
path-form references into placement names inside the arrays the walk covers. The pin
test `the_collector_walks_every_audited_input_file_carrier` re-runs this table as
data, so a future minted key that skips an arm fails the audit, not the queue.
------------------------------------------------------------------------------- */

/// The queue-body keys that ride input placement names outside the canonical
/// arrays: the i2i/inpaint input legs, the video first/last frames, and the music
/// cover's `sourceAudio` (W3-1: the fill plane mints it from the one `audio[]`
/// reference, so the drain-side intent carries the file name under THIS key). Names
/// outside the placement grammar (library names, handles, absolute paths — the
/// latter were already rewritten by the e16 placement seam) are never input
/// files, so they are never stat-checked.
const NAMED_INPUT_KEYS: [&str; 6] = [
    "inputImage",
    "inputMask",
    "sourceVideo",
    "firstFrame",
    "lastFrame",
    "sourceAudio",
];

/// The recipe-block keys walked generically (the door merges request blocks into
/// the intent; media legs that ride names inside a block are input references).
const RECIPE_BLOCK_KEYS: [&str; 3] = ["h3", "ltx", "wan"];

/// True when a string is written in the input placement grammar: `deas-inputs/…`,
/// `deas-masks/…`, or the root-level `deas-input-…` form.
fn is_placement_form(reference: &str) -> bool {
    reference.starts_with(&format!("{INPUTS_FOLDER}/"))
        || reference.starts_with(&format!("{MASKS_FOLDER}/"))
        || reference.starts_with(ROOT_PREFIX)
}

/// Collects every input placement name the FOLDED queue body references: the
/// canonical `images`/`videos`/`audio` arrays (the same strings the Director
/// media slots are built from, so ref2va media slots ride the same names), the
/// named input legs, the layered/reference object shapes, and any placement
/// string inside a recipe block. Deduped and sorted for a stable refusal.
#[must_use]
pub(crate) fn referenced_placement_names(body: &Map<String, Value>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut push = |candidate: &str| {
        if is_placement_form(candidate) && !found.iter().any(|held| held == candidate) {
            found.push(candidate.to_owned());
        }
    };
    for key in ["images", "videos", "audio"] {
        if let Some(items) = body.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(text) = item.as_str() {
                    push(text);
                }
            }
        }
    }
    for key in NAMED_INPUT_KEYS {
        if let Some(text) = body.get(key).and_then(Value::as_str) {
            push(text);
        }
    }
    if let Some(layers) = body.get("inputLayers").and_then(Value::as_array) {
        for layer in layers {
            if let Some(text) = layer.get("image").and_then(Value::as_str) {
                push(text);
            }
        }
    }
    if let Some(items) = body
        .get("imageReference")
        .and_then(|reference| reference.get("images"))
        .and_then(Value::as_array)
    {
        for item in items {
            if let Some(text) = item.get("image").and_then(Value::as_str) {
                push(text);
            }
        }
    }
    if let Some(items) = body
        .get("nativeImageReference")
        .and_then(|reference| reference.get("images"))
        .and_then(Value::as_array)
    {
        for item in items {
            if let Some(text) = item.as_str() {
                push(text);
            }
        }
    }
    for key in RECIPE_BLOCK_KEYS {
        if let Some(block) = body.get(key) {
            collect_block_names(block, &mut push);
        }
    }
    found.sort();
    found
}

/// Walks one recipe block for placement strings (objects and arrays only; a
/// block is structured payload, never prompt prose).
fn collect_block_names(value: &Value, push: &mut impl FnMut(&str)) {
    match value {
        Value::String(text) => push(text),
        Value::Array(items) => {
            for item in items {
                collect_block_names(item, push);
            }
        }
        Value::Object(fields) => {
            for item in fields.values() {
                collect_block_names(item, push);
            }
        }
        _ => {}
    }
}

/// True when one placement name resolves to an existing regular file under the
/// input root. Grammar is re-checked with the stock [`crate::jobs::model_name`]
/// law before any join, and every stat failure counts as absent: the law fails
/// closed.
#[must_use]
pub(crate) fn input_present(root: &Path, name: &str) -> bool {
    crate::jobs::model_name(name)
        && std::fs::metadata(root.join(name.replace('/', std::path::MAIN_SEPARATOR_STR)))
            .is_ok_and(|metadata| metadata.is_file())
}

/// The EXISTENCE LAW's refusal list: the names the body references that are NOT
/// on disk under the input root, in the collection's stable order.
#[must_use]
pub(crate) fn missing_inputs(root: &Path, names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| !input_present(root, name))
        .cloned()
        .collect()
}

/* --------------- BENCH CLAIM GUARD (LEG AF2-M18c: the bench-vs-spool TOCTOU) ---------------

The existence law stats every named input at QUEUE time; the drain reads it at DRAIN
time. A row can therefore sit in the spool with a reference that was on disk when it
queued, and `POST /v1/inputs/bench` can move that file away before the drain ever reads
it — the row then dies on an input the door already promised. The guard closes the
window at the bench INPUT door ONLY (an output-plane file is never an input reference,
so the outputs bench carries no guard), and it reuses the EXISTENCE-LAW collector
([`referenced_placement_names`]) rather than a second grammar that could drift.
------------------------------------------------------------------------------- */

/// One live row's claim on one input placement name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InputClaim {
    /// The placement name exactly as the existence-law collector names it
    /// (`deas-inputs/…`, `deas-masks/…`, or the root-level `deas-input-…` form).
    pub(crate) name: String,
    /// The row that references it — the detail the per-row refusal carries.
    pub(crate) row: String,
}

/// True when a row may still read its inputs: every status except the three terminal
/// ones. `queued` is the window this guard exists for; `draining` claims because the
/// batch reads each row at its own turn; `wedged` claims because the stock job is
/// still in flight on the card. A terminal row (done/failed/cancelled) read its inputs
/// or died trying, and a declutter door must still be able to tidy after a batch.
#[must_use]
fn row_is_live(status: RowStatus) -> bool {
    !matches!(
        status,
        RowStatus::Done | RowStatus::Failed | RowStatus::Cancelled
    )
}

/// The claim set for one bench call: the existence-law collector run over every LIVE
/// spool row. Each row is read through the drain's own reconstruction
/// ([`super::spool::flat_intent`]) — the exact body the drain will hand to the compiler,
/// so the claim set is what the drain will actually need. A hand-edited row that will
/// not rebuild keeps its raw passthrough `extras` (a subset of the same reconstruction):
/// an un-drainable row still holds its claims, and a silent gap in the claim set is the
/// failure mode this door exists to prevent.
#[must_use]
pub(crate) fn queued_input_claims(rows: &[QueueRow]) -> Vec<InputClaim> {
    let mut claims: Vec<InputClaim> = Vec::new();
    for row in rows {
        if !row_is_live(row.status) {
            continue;
        }
        let body = match super::spool::flat_intent(row) {
            Ok(Value::Object(fields)) => fields,
            _ => row.extras.clone(),
        };
        for name in referenced_placement_names(&body) {
            claims.push(InputClaim {
                name,
                row: row.id.clone(),
            });
        }
    }
    claims
}

/// The claim that covers one bench-source name, if any (request order decides when two
/// rows claim the same name: the first row in spool order is the one named).
#[must_use]
pub(crate) fn claim_for_name<'a>(
    claims: &'a [InputClaim],
    bench_name: &str,
) -> Option<&'a InputClaim> {
    claims
        .iter()
        .find(|claim| name_addresses_placement(bench_name, &claim.name))
}

/// Does the bench-source name address the same placement as a claimed reference?
///
/// Two forms match. EQUAL placement forms always match. CONTAINMENT matches at whole
/// segment boundaries: a bench name whose segments contain the claimed placement as a
/// run (`archive/deas-inputs/hero.png` for a claimed `deas-inputs/hero.png`) is refused
/// too. That direction over-refuses in principle and is the deliberate choice: refusing
/// a name the drain never needed costs one honest row, moving a name the drain does need
/// is the race this leg kills.
///
/// The bench body grammar is LITERAL (no percent-decoding at this door — the same law as
/// [`super::routes::parse_query`]), so the byte door's escaped form
/// (`deas-inputs%2Fhero.png`) addresses no file here and would answer `notFound`. The
/// guard still compares a decoded copy, so a percent-form name can never be the one that
/// slips a claimed file past the wall on some future door that decodes earlier.
#[must_use]
fn name_addresses_placement(bench_name: &str, claimed: &str) -> bool {
    bench_name == claimed
        || contains_placement(bench_name, claimed)
        || contains_placement(&decode_escapes_literal(bench_name), claimed)
}

/// Whole-segment-run containment over the slash-separated placement form.
#[must_use]
fn contains_placement(haystack: &str, needle: &str) -> bool {
    let hay: Vec<&str> = haystack.split('/').collect();
    let need: Vec<&str> = needle.split('/').collect();
    !need.is_empty()
        && need.len() <= hay.len()
        && (0..=hay.len() - need.len()).any(|start| hay[start..start + need.len()] == need[..])
}

/// A tolerant mirror of [`super::routes::decode_reference`]: a valid `%XX` pair decodes,
/// anything else stays literal bytes. The claim test needs no refusal — it only adds a
/// second form to compare, and the door's own wall still refuses what it refuses.
#[must_use]
fn decode_escapes_literal(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let pair = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|text| u8::from_str_radix(text, 16).ok());
        match pair {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tempdir-tree idiom the uploads tests use: build the placement grammar on disk,
    /// then read it back through the inventory law.
    fn place(root: &Path, name: &str, bytes: &[u8]) {
        let target = root.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("placement folder");
        }
        std::fs::write(&target, bytes).expect("placed file");
    }

    /// The full grammar sweep: everything the stock seams mint is labeled by kind
    /// (nested `deas-inputs/` names included, ruling E22), and everything they never
    /// mint (foreign extension, wrong mask magic, hidden file, hidden/bench folder, an
    /// operator drop with no prefix) is counted instead of invented.
    #[test]
    fn the_grammar_labels_only_what_the_placement_law_mints() {
        let root = tempfile::tempdir().expect("input root");
        let base = root.path();
        let place_recent = |root: &Path, name: &str, bytes: &[u8]| {
            place(root, name, bytes);
            // E22 sorts by mtime; separate the writes so the fixture order is real.
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        place_recent(base, "deas-inputs/deas-input-1.png", b"\x89PNG fake image");
        place_recent(base, "deas-inputs/deas-input-2.wav", b"RIFF fake audio");
        place_recent(base, "deas-masks/deas-mask-1.png", b"\x89PNG fake mask");
        place_recent(base, "deas-input-3.mp4", b"fake video bytes");
        // Not grammar-placed media: a foreign extension in a placement folder, a mask that
        // is not PNG, a root drop with no prefix, a hidden file, and a bench folder
        // (dot-prefixed: skipped at every level, its contents never walked, E22 law).
        place_recent(base, "deas-inputs/notes.txt", b"not media");
        place_recent(base, "deas-masks/wrong.jpg", b"not png");
        place_recent(base, "operator-drop.png", b"no prefix at the root");
        place_recent(base, "deas-inputs/.hidden.png", b"hidden");
        place_recent(base, "deas-inputs/.bench-20261121/kept.png", b"benched");
        // And the E22 headline: a hand-created nested placement IS listed.
        place_recent(
            base,
            "deas-inputs/project1/picture1.jpg",
            b"\xff\xd8\xff nested",
        );

        let inventory = inventory(base).expect("inventory");
        let pairs: Vec<(&str, &str)> = inventory
            .rows
            .iter()
            .map(|row| (row.name.as_str(), row.kind))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("deas-inputs/project1/picture1.jpg", "image"),
                ("deas-input-3.mp4", "video"),
                ("deas-masks/deas-mask-1.png", "mask"),
                ("deas-inputs/deas-input-2.wav", "audio"),
                ("deas-inputs/deas-input-1.png", "image"),
            ],
            "most recent first (E22 recency law); nested names are rows"
        );
        assert_eq!(
            inventory.unlisted, 4,
            "the txt, the non-PNG mask, the hidden file and the bench folder count: {pairs:?}"
        );
        assert!(!inventory.truncated);
        assert_eq!(inventory.note(), ORIGIN_NOTE);

        let rows = inventory.rows_json();
        assert_eq!(rows[0]["placedByGrammar"], true);
        assert_eq!(rows[3]["sizeBytes"], 15, "the file's own byte count");
        assert!(
            rows[4]["mtimeMs"].is_number(),
            "the file's own mtime rides when the filesystem reports it"
        );
        assert_eq!(
            inventory
                .rows
                .iter()
                .filter(|row| row.name == "operator-drop.png")
                .count(),
            0,
            "a root drop the grammar never mints is never labeled plane-placed"
        );
        assert_eq!(
            inventory
                .rows
                .iter()
                .filter(|row| row.name.contains(".bench-"))
                .count(),
            0,
            "the bench folder hides itself from both walks (E22)"
        );
    }

    /// PRIVACY LAW (law-named, the same law the models and resolve pins hold): input rows
    /// carry the relative placement name, never the absolute input root.
    #[test]
    fn input_rows_never_leak_the_input_root_path() {
        let root = tempfile::tempdir().expect("input root");
        place(root.path(), "deas-inputs/deep.png", b"png bytes");
        let inventory = inventory(root.path()).expect("inventory");
        let text =
            serde_json::to_string(&inventory.rows_json()).expect("rows serialize for the wire");
        let absolute = root.path().to_string_lossy().into_owned();
        assert!(
            !text.contains(&absolute),
            "the input root reached the wire: {text}"
        );
        assert!(!text.contains(":\\\\") && !text.contains(":/"), "{text}");
        assert_eq!(inventory.rows_json()[0]["name"], "deas-inputs/deep.png");
    }

    /// The cap is honest: the cut is reported, the note names the number and the
    /// recency law, and the kept window is the most recent rows (E22) — never a
    /// random subset (mtimes run non-increasing through the answer).
    #[test]
    fn the_row_cap_is_reported_not_silently_applied() {
        let root = tempfile::tempdir().expect("input root");
        for index in 0..MAX_INPUT_ROWS + 7 {
            place(
                root.path(),
                &format!("deas-inputs/deas-input-{index:04}.png"),
                b"png",
            );
        }
        let inventory = inventory(root.path()).expect("inventory");
        assert_eq!(inventory.rows.len(), MAX_INPUT_ROWS);
        assert!(inventory.truncated, "the cut is visible to the caller");
        assert!(inventory.note().contains(&MAX_INPUT_ROWS.to_string()));
        assert!(inventory.note().contains("most recent first"));
        let stamps: Vec<u64> = inventory
            .rows
            .iter()
            .map(|row| row.modified_ms.expect("the placed files carry mtimes"))
            .collect();
        assert!(
            stamps.windows(2).all(|pair| pair[0] >= pair[1]),
            "the kept window runs newest-first"
        );
        let note = inventory.note();
        assert!(note.starts_with(ORIGIN_NOTE), "{note}");
    }

    /// E22 recency law: the freshest placement is rows[0] even when an older name
    /// sorts first alphabetically — working files stay reachable under the cap.
    #[test]
    fn the_listing_sorts_most_recent_first() {
        let root = tempfile::tempdir().expect("input root");
        let place_recent = |root: &Path, name: &str| {
            place(root, name, b"png");
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        place_recent(root.path(), "deas-inputs/a-old.png");
        place_recent(root.path(), "deas-inputs/b-mid.png");
        place_recent(root.path(), "deas-inputs/project1/z-new.png");
        let inventory = inventory(root.path()).expect("inventory");
        let names: Vec<&str> = inventory.rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "deas-inputs/project1/z-new.png",
                "deas-inputs/b-mid.png",
                "deas-inputs/a-old.png",
            ],
            "newest first, nested included"
        );
    }

    /// A fresh install never used the input plane: both placement folders are absent and
    /// the honest answer is an empty inventory, not a failure.
    #[test]
    fn an_unused_input_plane_answers_empty_not_failed() {
        let root = tempfile::tempdir().expect("input root");
        let inventory = inventory(root.path()).expect("empty inventory is an answer");
        assert!(inventory.rows.is_empty());
        assert_eq!(inventory.unlisted, 0);
        assert!(!inventory.truncated);
    }

    /// A root that is not a directory at all fails closed with the fixed word — and that
    /// word carries no path.
    #[test]
    fn an_unreadable_root_refuses_with_a_path_free_word() {
        let root = tempfile::tempdir().expect("input root");
        let missing = root.path().join("never-created");
        let problem = inventory(&missing).expect_err("a missing root is not an inventory");
        assert_eq!(problem, "the input root is unreadable");
        assert!(
            !problem.contains(&root.path().to_string_lossy().to_string()),
            "refusal text never carries a local path"
        );
    }

    #[test]
    fn the_extension_table_is_the_stock_sniffer_set() {
        assert_eq!(kind_of("a.png"), Some("image"));
        assert_eq!(
            kind_of("a.JPG"),
            Some("image"),
            "the wire is case-insensitive"
        );
        assert_eq!(kind_of("a.m4a"), Some("audio"));
        assert_eq!(kind_of("deas-input-9.mkv"), Some("video"));
        assert_eq!(kind_of("no-extension"), None);
        assert_eq!(
            kind_of("archive."),
            None,
            "an empty extension is not a type"
        );
        assert_eq!(kind_of("a.zip"), None, "outside the closed content table");
    }

    /* ---- EXISTENCE LAW tests (LEG MEDIA-1, ruling E21) ---- */

    /// The collector names placement strings across every key family that rides
    /// them, and NEVER names library words, handles, or prompt prose.
    #[test]
    fn the_collector_names_placement_forms_and_nothing_else() {
        let body: Map<String, Value> = serde_json::from_str(
            r#"{"images":["deas-inputs/a.png","some/library.png","a1b2c3d4e5f6","deas-inputs/project1/picture1.jpg"],
                "videos":["deas-input-clip.mp4"],
                "audio":["deas-inputs/song.wav","deas-inputs/a.png"],
                "inputImage":"deas-inputs/in.png",
                "inputMask":"deas-masks/m.png",
                "positivePrompt":"a lighthouse beside deas-inputs/ghost.png",
                "checkpoint":"anima/something.safetensors",
                "inputLayers":[{"image":"deas-inputs/layer.png","x":0}],
                "imageReference":{"visionModel":"clip","images":[{"image":"deas-inputs/ref.png","strength":1.0}]},
                "nativeImageReference":{"method":"krea-2","images":["deas-inputs/nat.png"]},
                "h3":{"media":[{"type":"image","file":"deas-inputs/block.png","slot":0}]}}"#,
        )
        .expect("body parses");
        let names = referenced_placement_names(&body);
        assert_eq!(
            names,
            vec![
                "deas-input-clip.mp4",
                "deas-inputs/a.png",
                "deas-inputs/block.png",
                "deas-inputs/in.png",
                "deas-inputs/layer.png",
                "deas-inputs/nat.png",
                "deas-inputs/project1/picture1.jpg",
                "deas-inputs/ref.png",
                "deas-inputs/song.wav",
                "deas-masks/m.png",
            ],
            "deduped and sorted; nested placement forms ride the prefix law; the prompt mention is prose, not a reference"
        );
    }

    /// THE W3-1 AUDIT RUN AS DATA (LEG AF2-M21b): one body carrying every documented
    /// input-file carrier — the three canonical arrays, every named key INCLUDING the
    /// fill plane's minted `sourceAudio`, both object arms, and placement strings
    /// nested in the recipe blocks — and the collector must name every one. Add a
    /// minted key without an arm and this test, not a live queue, says so.
    #[test]
    fn the_collector_walks_every_audited_input_file_carrier() {
        let body: Map<String, Value> = serde_json::from_str(
            r#"{"images":["deas-inputs/img.png"],
                "videos":["deas-inputs/vid.mp4"],
                "audio":["deas-inputs/song.flac"],
                "inputImage":"deas-inputs/leg.png",
                "inputMask":"deas-masks/leg.png",
                "sourceVideo":"deas-input-src.mp4",
                "firstFrame":"deas-inputs/f1.png",
                "lastFrame":"deas-inputs/f2.png",
                "sourceAudio":"deas-inputs/cover-source.flac",
                "inputLayers":[{"image":"deas-inputs/layer.png","x":0,"y":0}],
                "imageReference":{"visionModel":"clip","images":[{"image":"deas-inputs/ip.png","strength":1.0}]},
                "nativeImageReference":{"method":"krea-2","images":["deas-inputs/native.png"]},
                "h3":{"mode":"REF2VA","media":[{"type":"image","file":"deas-inputs/bag.png","slot":0},
                          {"type":"audio","file":"deas-inputs/bag.wav","slot":0}],
                        "references":[{"slot":0,"image":"deas-inputs/stillref.png"}]},
                "ltx":{"keyframes":[{"image":"deas-inputs/key.png","frame":48,"strength":0.6}]},
                "wan":{"lowModel":"WAN22/low.safetensors"}}"#,
        )
        .expect("audit body parses");
        let names = referenced_placement_names(&body);
        for expected in [
            "deas-inputs/img.png",
            "deas-inputs/vid.mp4",
            "deas-inputs/song.flac",
            "deas-inputs/leg.png",
            "deas-masks/leg.png",
            "deas-input-src.mp4",
            "deas-inputs/f1.png",
            "deas-inputs/f2.png",
            "deas-inputs/cover-source.flac",
            "deas-inputs/layer.png",
            "deas-inputs/ip.png",
            "deas-inputs/native.png",
            "deas-inputs/bag.png",
            "deas-inputs/bag.wav",
            "deas-inputs/stillref.png",
            "deas-inputs/key.png",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "the collector lost the audited carrier {expected}: {names:?}"
            );
        }
        assert_eq!(
            names.len(),
            16,
            "the audit table is exactly this set: {names:?}"
        );
    }

    /// The named-arm half of the audit pinned as a const: `sourceAudio` — the key the
    /// fill plane mints for the YuE2 cover row — sits in `NAMED_INPUT_KEYS` beside the
    /// other named legs, so a cover drain row claims its file to the bench guard.
    #[test]
    fn the_named_key_table_holds_the_minted_cover_source_audio() {
        assert!(
            NAMED_INPUT_KEYS.contains(&"sourceAudio"),
            "W3-1: the minted cover key must ride the named arm (fill_plane.rs mints \
             sourceAudio; MUSIC_PASSTHROUGH_KEYS is the minting home)"
        );
        assert_eq!(
            NAMED_INPUT_KEYS.len(),
            6,
            "the named arm is exactly six keys"
        );
    }

    #[test]
    fn the_stat_law_reports_absent_names_naming_them_and_accepts_placed() {
        let root = tempfile::tempdir().expect("input root");
        place(root.path(), "deas-inputs/here.png", b"png");
        place(root.path(), "deas-input-vid.mp4", b"video");
        let names = vec![
            "deas-inputs/here.png".to_owned(),
            "deas-inputs/gone.png".to_owned(),
            "deas-masks/none.png".to_owned(),
            "deas-input-vid.mp4".to_owned(),
        ];
        assert_eq!(
            missing_inputs(root.path(), &names),
            vec!["deas-inputs/gone.png", "deas-masks/none.png"],
            "the absent are named in stable order; a directory never satisfies the law"
        );
    }

    /// ON-DISK REUSE COSTS NOTHING: a placed file of ANY size satisfies the law —
    /// the network caps never reach a reference that is already on disk. A
    /// sparse-ish 2 MiB fixture stands in for the "over the upload cap" class
    /// without a heavy write (the cap-lowering trick lives in the door tests).
    #[test]
    fn a_large_placed_file_satisfies_the_law() {
        let root = tempfile::tempdir().expect("input root");
        let target = root.path().join("deas-inputs");
        std::fs::create_dir_all(&target).expect("folder");
        let file = target.join("big.png");
        let file = std::fs::File::create(&file).expect("file");
        file.set_len(2 * 1024 * 1024).expect("2 MiB");
        assert!(input_present(root.path(), "deas-inputs/big.png"));
        assert!(missing_inputs(root.path(), &["deas-inputs/big.png".to_owned()]).is_empty());
    }

    /// The grammar gate stands before the join: a traversal-shaped "name" is
    /// reported missing, never stat-resolved outside the root.
    #[test]
    fn a_traversal_shaped_name_is_never_stat_walked() {
        let root = tempfile::tempdir().expect("input root");
        let outside = root.path().join("outside.png");
        std::fs::write(&outside, b"real file outside the placement grammar").expect("write");
        assert!(
            !input_present(root.path(), "deas-inputs/../outside.png"),
            "model_name rejects the traversal form before any join"
        );
    }

    /// E22: a NESTED placement satisfies the existence law — the stat join walks
    /// the subfolder like any other path under the root, and the nested folder
    /// itself (not a regular file) still never satisfies it.
    #[test]
    fn a_nested_placement_satisfies_the_existence_law() {
        let root = tempfile::tempdir().expect("input root");
        place(
            root.path(),
            "deas-inputs/project1/picture1.jpg",
            b"\xff\xd8\xff jpeg",
        );
        assert!(input_present(
            root.path(),
            "deas-inputs/project1/picture1.jpg"
        ));
        assert!(missing_inputs(
            root.path(),
            &["deas-inputs/project1/picture1.jpg".to_owned()]
        )
        .is_empty());
        assert!(
            !input_present(root.path(), "deas-inputs/project1"),
            "the folder itself is not a placement"
        );
        assert_eq!(
            missing_inputs(root.path(), &["deas-inputs/project1/gone.jpg".to_owned()]),
            vec!["deas-inputs/project1/gone.jpg"],
            "a nested miss is honest, naming the nested name"
        );
    }

    /// LEG M17b (ruling E22 BENCH): a benched name starts with the dot folder,
    /// so it is NOT placement-form — the collector never names it (even inside
    /// the canonical arrays) and the existence law therefore never reaches it.
    /// Benched means hidden from NEW references; the old placement name is the
    /// one the law still tracks, and once the file moved it answers missing
    /// (the door answers 422 `inputMissing`). Un-benching is an owner-UI /
    /// future leg — no door this leg (doc ruling).
    #[test]
    fn a_benched_name_is_never_a_placement_reference() {
        assert!(
            !is_placement_form(".bench-20261121T161138Z/deas-inputs/x.png"),
            "the leading dot breaks every placement prefix"
        );
        assert!(!is_placement_form(
            ".bench-20261121T161138Z/deas-input-clip.mp4"
        ));
        let body: Map<String, Value> = serde_json::from_str(
            r#"{"images":[".bench-20261121T161138Z/deas-inputs/x.png"],"videos":[".bench-20261121T161138Z/deas-input-clip.mp4"]}"#,
        )
        .expect("body parses");
        assert!(
            referenced_placement_names(&body).is_empty(),
            "the collector ignores the dot form: it is not a placement reference"
        );
        let root = tempfile::tempdir().expect("input root");
        place(
            root.path(),
            ".bench-20261121T161138Z/deas-inputs/x.png",
            b"benched png",
        );
        assert_eq!(
            missing_inputs(root.path(), &["deas-inputs/x.png".to_owned()]),
            vec!["deas-inputs/x.png"],
            "the OLD placement name is what the law tracks — and the bench moved it away"
        );
    }
}
