//! The E16 queue request surface (API-DESIGN §12.1 E16, owner ruling 2026-06-21):
//! the queue body arrives in the owner's shorthand shape and this module folds it
//! into the structured request the fill plane already consumes — before `fill`, so
//! both shapes land the same `IntentPlan`.
//!
//! Four laws, all pure and window-free except the placement door's fs reads:
//!
//! * **Canonical reference arrays** `images[]` / `videos[]` / `audio[]` of reference
//!   strings (absolute path, 12-hex library handle or library-relative name).
//! * **Numbered aliases** `picture1..picture12` / `audio1..audio12` /
//!   `video1..video12` folded into the canonical arrays in numeric order; a
//!   malformed suffix is a `bodyInvalid` naming the accepted shape.
//! * **List shorthands** `--lora "a,b,c"` (`name:0.7` strength suffix, bare = 1.0),
//!   `--refmod "a,b"` (rows with auto slots 1..8, strength 1.0), `--dials
//!   "steps=8,cfg=2"` (closed dial names, number-or-string values).
//! * **The reference caps wall**: ≤ 9 images, ≤ 3 videos, ≤ 3 audio, ≤ 12 total —
//!   the §12.1 matrix, mirroring `jobs_video::H3_LANES`; the refusal names the
//!   exceeded cap and its number.
//!
//! The caps wall is a door convenience: the stock compiler re-verifies the same
//! numbers in `validate_h3_media`, so the door can never be the only guard.
//!
//! Placement is CONTAINMENT, never fetching (ruling E24, LEG AF2-M19a; the law's one
//! home is [`place_references`] below): a local-path reference must already live under
//! the engine's INPUT root or OUTPUT root. Inside the input root it is rewritten to the
//! root-relative placement form — no copy, no size cap, no seam call. Inside the output
//! root it is server-side copied into a fresh `deas-inputs/<uuid>.<ext>` placement
//! ([`super::files::copy_into_inputs`], the promote door's mint, one home). Anywhere
//! else on the box it is a `bodyInvalid` naming the law. Relative references resolve
//! against the input root and normalize to the placement form; handles and already
//! placed names pass through untouched.

use std::path::Path;

use serde_json::{Map, Value};

use super::defaults::DIAL_NAMES;
use super::errors::{ApiError, ErrorKind};
use super::files;
use super::resolver::is_handle;
use super::uploads::{self, UploadKind};

/// The §12.1 reference matrix, mirroring `jobs_video::H3_LANES` (9 image, 3 video,
/// 3 audio slots) and its ≤ 12 total gate; a test pins the three lane numbers.
pub(crate) const MAX_IMAGES: usize = 9;
pub(crate) const MAX_VIDEOS: usize = 3;
pub(crate) const MAX_AUDIO: usize = 3;
pub(crate) const MAX_REFERENCES: usize = 12;

/// The canonical reference-array keys, in lane order, with their upload kind.
pub(crate) const REFERENCE_KEYS: [(&str, UploadKind); 3] = [
    ("images", UploadKind::Image),
    ("videos", UploadKind::Video),
    ("audio", UploadKind::Audio),
];

/// The highest accepted alias index (picture12 / audio12 / video12).
const MAX_ALIAS_INDEX: u32 = 12;

/// The shorthand keys, exactly as the owner's surface writes them.
const LORA_SHORTHAND: &str = "--lora";
const DIALS_SHORTHAND: &str = "--dials";
const REFMOD_SHORTHAND: &str = "--refmod";

/// The caps-wall refusal text; named once so the door and its tests quote one home.
fn caps_hint() -> String {
    format!(
        "the reference matrix caps at {MAX_IMAGES} images, {MAX_VIDEOS} videos, {MAX_AUDIO} audio and {MAX_REFERENCES} total (the stock Director lanes); the request exceeds one of them"
    )
}

fn invalid(hint: impl Into<String>) -> ApiError {
    ApiError::new(ErrorKind::BodyInvalid).with_hint(hint)
}

/// Folds the E16 surface into the structured body, in place, before the fill plane
/// sees it. Structured forms already present are kept and the shorthand entries are
/// appended (both shapes land the same plan).
///
/// # Errors
///
/// `bodyInvalid` for a malformed alias, a non-string reference, a malformed
/// shorthand, a structured `loras` bag the `--lora` shorthand would have folded into
/// (LEG AF2-M18c: refused, never silently replaced), an unknown dial name, a refmod bag
/// over 8, or a caps-wall breach.
pub(crate) fn fold(body: &mut Map<String, Value>) -> Result<(), ApiError> {
    fold_aliases(body)?;
    check_reference_arrays(body)?;
    check_caps(body)?;
    fold_lora(body)?;
    fold_dials(body)?;
    fold_refmods(body)?;
    Ok(())
}

/// Reads one canonical array into its string entries (empty when the key is absent).
fn reference_array(body: &Map<String, Value>, key: &str) -> Result<Vec<String>, ApiError> {
    let Some(value) = body.get(key) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| invalid(format!("'{key}' must be an array of reference strings")))?;
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    invalid(format!(
                        "every '{key}' entry must be a non-empty reference string"
                    ))
                })
        })
        .collect()
}

/// One `videos`/`audio` entry as the folded body carries it: the untouched JSON
/// value plus the placement name it carries (a plain string, or the object's
/// `file`). Images never ride this shape — they stay string-only; the trim
/// objects decorate only the video recipe's video/audio lanes.
struct RawEntry {
    value: Value,
    name: String,
}

/// The array-shape refusal for one canonical key: `images` stays string-only;
/// the trimmable lanes admit the entry object. Braces ride the wire verbatim.
fn array_shape_hint(key: &str) -> String {
    if key == "images" {
        format!("'{key}' must be an array of reference strings")
    } else {
        format!("'{key}' must be an array of reference strings or {{file, trimStart?, trimEnd?}} objects")
    }
}

/// The per-entry refusal for one canonical key, mirroring [`array_shape_hint`]'s split.
fn entry_shape_hint(key: &str) -> String {
    if key == "images" {
        format!("every '{key}' entry must be a non-empty reference string")
    } else {
        format!("every '{key}' entry must be a non-empty reference string or {{file, trimStart?, trimEnd?}} object")
    }
}

/// The trim-number wall, mirroring the `validate_h3_media` shape arm (stock
/// jobs_video.rs 1147–1153): every present trim is a finite number of seconds in
/// `0..=3600`, and `trimStart < trimEnd` when both sit. The 2–15 s clip-duration
/// wall deliberately stays stock-side at prepare, where it counts the TRIMMED
/// span — the door never duplicates it. Unknown entry keys are NOT refused here;
/// the fill plane's closed-set refusal owns that word.
fn check_trim_shape(obj: &Map<String, Value>) -> Result<(), ApiError> {
    let bounded = ["trimStart", "trimEnd"].iter().all(|key| {
        obj.get(*key).is_none_or(|value| {
            value
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=3600.0).contains(&n))
        })
    });
    let ordered = match (
        obj.get("trimStart").and_then(Value::as_f64),
        obj.get("trimEnd").and_then(Value::as_f64),
    ) {
        (Some(start), Some(end)) => start < end,
        _ => true,
    };
    if bounded && ordered {
        return Ok(());
    }
    Err(invalid(
        "trimStart/trimEnd must be finite seconds in 0..=3600 with trimStart before trimEnd (the stock h3.media trim law)"
            .to_owned(),
    ))
}

/// Reads one trimmable reference array (`videos`/`audio`) into raw entries: a
/// non-empty reference string, or a `{file, trimStart?, trimEnd?}` object with a
/// non-empty string `file`. Entry objects pass with their trim decorations
/// intact; the fill plane re-reads the same law at its own wall.
fn reference_entries(body: &Map<String, Value>, key: &str) -> Result<Vec<RawEntry>, ApiError> {
    let Some(value) = body.get(key) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| invalid(array_shape_hint(key)))?;
    items
        .iter()
        .map(|item| {
            if let Some(text) = item.as_str() {
                if text.trim().is_empty() {
                    return Err(invalid(entry_shape_hint(key)));
                }
                return Ok(RawEntry {
                    value: item.clone(),
                    name: text.to_owned(),
                });
            }
            let obj = item
                .as_object()
                .ok_or_else(|| invalid(entry_shape_hint(key)))?;
            let name = obj
                .get("file")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    invalid(format!(
                        "a '{key}' entry object needs a non-empty \"file\" placement name"
                    ))
                })?
                .to_owned();
            check_trim_shape(obj)?;
            Ok(RawEntry {
                value: item.clone(),
                name,
            })
        })
        .collect()
}

/// Validates every canonical array's entry grammar: `images` stays string-only,
/// `videos`/`audio` also admit the `{file, trimStart?, trimEnd?}` entry objects.
fn check_reference_arrays(body: &Map<String, Value>) -> Result<(), ApiError> {
    for (key, _) in REFERENCE_KEYS {
        if key == "images" {
            reference_array(body, key)?;
        } else {
            reference_entries(body, key)?;
        }
    }
    Ok(())
}

/// Raw length of one canonical array (absent = 0); a non-array value is the
/// array-shape refusal even here, so no count is ever quoted for a malformed body.
fn reference_len(body: &Map<String, Value>, key: &str) -> Result<usize, ApiError> {
    match body.get(key) {
        None => Ok(0),
        Some(Value::Array(items)) => Ok(items.len()),
        Some(_) => Err(invalid(array_shape_hint(key))),
    }
}

/// The caps wall (§12.1-1): raw entry counts per key — a string and an entry
/// object occupy one lane slot alike. The refusal names the matrix and its numbers.
fn check_caps(body: &Map<String, Value>) -> Result<(), ApiError> {
    let images = reference_len(body, "images")?;
    let videos = reference_len(body, "videos")?;
    let audio = reference_len(body, "audio")?;
    let over_cap = images > MAX_IMAGES
        || videos > MAX_VIDEOS
        || audio > MAX_AUDIO
        || images + videos + audio > MAX_REFERENCES;
    if over_cap {
        return Err(invalid(format!(
            "{}: got {images} images, {videos} videos, {audio} audio",
            caps_hint()
        )));
    }
    Ok(())
}

/// One alias hit: the canonical key it feeds and its numeric index.
struct Alias {
    key: String,
    feeds: &'static str,
    index: u32,
}

/// Classifies one body key as an alias or not. A malformed numeric-looking alias is
/// refused naming the accepted shape; foreign keys whose prefix merely collides
/// (`videoPost`, `audioVae`) are never aliases and stay for the fill plane.
fn classify_alias(key: &str) -> Result<Option<Alias>, ApiError> {
    let accepted = "picture1..picture12, audio1..audio12, video1..video12";
    for (prefix, feeds) in [
        ("picture", "images"),
        ("audio", "audio"),
        ("video", "videos"),
    ] {
        let Some(suffix) = key.strip_prefix(prefix) else {
            continue;
        };
        if suffix.is_empty() {
            // `picture` alone is never legal; bare `audio` is the canonical array
            // key and bare `video` is not a key this plane names.
            if prefix != "audio" {
                return Err(invalid(format!(
                    "'{key}' is not a reference alias; the accepted aliases are {accepted}"
                )));
            }
            return Ok(None);
        }
        let digits = suffix.bytes().all(|byte| byte.is_ascii_digit());
        if digits {
            let index: u32 = suffix.parse().unwrap_or(0);
            if !(1..=MAX_ALIAS_INDEX).contains(&index) {
                return Err(invalid(format!(
                    "reference alias '{key}' is out of range; the accepted aliases are {accepted}"
                )));
            }
            return Ok(Some(Alias {
                key: key.to_owned(),
                feeds,
                index,
            }));
        }
        // A digit-led but broken suffix (`picture1a`, `video1x`) is a malformed
        // alias; a letter-led suffix (`videoPost`, `audioVae`) is another key —
        // except `picture`, which prefixes no intent key at all.
        if suffix.as_bytes()[0].is_ascii_digit() || prefix == "picture" {
            return Err(invalid(format!(
                "'{key}' looks like a reference alias but is malformed; the accepted aliases are {accepted}"
            )));
        }
        return Ok(None);
    }
    Ok(None)
}

/// Folds every numbered alias into its canonical array in numeric order (canonical
/// entries first, then alias entries ascending).
fn fold_aliases(body: &mut Map<String, Value>) -> Result<(), ApiError> {
    let mut aliases: Vec<Alias> = Vec::new();
    for key in body.keys() {
        if let Some(alias) = classify_alias(key)? {
            aliases.push(alias);
        }
    }
    if aliases.is_empty() {
        return Ok(());
    }
    aliases.sort_by_key(|alias| (alias.feeds, alias.index));
    for alias in &aliases {
        let value = body
            .remove(&alias.key)
            .expect("the key was collected from this body");
        let text = value
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                invalid(format!(
                    "reference alias '{}' must carry a non-empty reference string",
                    alias.key
                ))
            })?;
        // APPEND to the RAW array (LEG audio-trim): rebuilding through
        // `reference_array` would destroy the `{file, trimStart?, trimEnd?}` entry
        // objects an already-valid body carries. Entry grammar is `check_reference_arrays`
        // (next in `fold`) and the fill plane's wall; only a non-array value is
        // refused here, so nothing is ever silently replaced.
        let mut items: Vec<Value> = match body.get(alias.feeds) {
            None => Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            Some(_) => return Err(invalid(array_shape_hint(alias.feeds))),
        };
        items.push(Value::String(text.to_owned()));
        body.insert(alias.feeds.to_owned(), Value::Array(items));
    }
    Ok(())
}

/// Splits one comma-separated shorthand value into trimmed, non-empty parts.
fn shorthand_list(key: &str, value: &Value) -> Result<Vec<String>, ApiError> {
    let shape = format!("'{key}' must be a comma-separated string \"a,b,c\"");
    let text = value.as_str().ok_or_else(|| invalid(shape.clone()))?;
    if text.trim().is_empty() {
        return Err(invalid(shape));
    }
    let parts: Vec<String> = text.split(',').map(str::trim).map(str::to_owned).collect();
    if parts.iter().any(String::is_empty) {
        return Err(invalid(shape));
    }
    Ok(parts)
}

/// `--lora "name,name:0.7"`: appended to the structured `loras` bag as
/// `{name, strength}`; a `name:strength` suffix is parsed, a bare name defaults to
/// strength 1.0 (the stock video lora law pins strength, it is never omitted).
///
/// LEG M15 ruling (design 12.1 addendum, API-DESIGN.md:444): the shorthand does
/// NOT fold `.deas.json` trigger words into the loras bag or name them in its
/// refusals. Triggers are prompt content the stranger composes into
/// `positivePrompt` itself; the door's job is to SURFACE them, and it does, in the
/// identity rows both library doors already serve (`library::identity_row`
/// `triggerWords` — the snapshot field the scan stores and
/// `native_model_edit_lora` :1610-1628 writes, read here from the loaded index
/// only, never a sidecar walk). Writing triggers through the door would be a
/// sidecar mutation: owner-UI class, confirm-wall territory (the M14c hint-only
/// ruling), deferred with that reasoning.
fn fold_lora(body: &mut Map<String, Value>) -> Result<(), ApiError> {
    let Some(value) = body.remove(LORA_SHORTHAND) else {
        return Ok(());
    };
    // THE STRUCTURED BAG IS READ BEFORE IT IS APPENDED TO (LEG AF2-M18c). Without
    // the shorthand this function never looks at `loras` and the fill plane's own
    // shape wall refuses a malformed bag naming the key; WITH the shorthand the
    // bag was read through `as_array()`, so a value that is not an array of
    // `{name, strength}` pairs decoded to "no bag" and the shorthand result
    // SILENTLY REPLACED it — the caller's LoRAs vanished with an `ok` answer.
    // The refusal is the fill plane's own law, called from its one home
    // (`fill_plane::check_passthrough_shape("loras", …)`), so e16 cannot drift
    // from what the door would enforce one step later anyway: `bodyInvalid`
    // naming `loras`, before any fold, before any partial write of the body.
    //
    // What stays exactly as shipped: shorthand over an ABSENT bag still mints the
    // bag, and shorthand beside a WELL-FORMED structured bag still appends (both
    // shapes land the same IntentPlan — there is no collision law for `loras`,
    // unlike `--dials` against the H3 Dial Rack array, which `fold_dials` refuses
    // by name). A malformed bag without the shorthand is still the fill plane's
    // refusal, untouched.
    if let Some(existing) = body.get("loras") {
        if let Err(refusal) = super::fill_plane::check_passthrough_shape("loras", existing) {
            // The fold's own refusal, restating the wall's reason verbatim: the
            // caller learns WHICH key the fold refused to overwrite, which the
            // stock-word refusal alone does not always say.
            let verdict = refusal.body_json();
            let reason = verdict["hint"]
                .as_str()
                .unwrap_or("the value is not an array of {name, strength} pairs");
            return Err(invalid(format!(
                "'loras' is refused before the '--lora' shorthand folds: {reason}"
            )));
        }
    }
    let mut loras = body
        .get("loras")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for part in shorthand_list(LORA_SHORTHAND, &value)? {
        let (name, strength) = match part.rsplit_once(':') {
            Some((name, raw)) if !name.is_empty() => {
                let strength: f64 = raw.parse().map_err(|_| {
                    invalid(format!(
                        "'--lora' entry '{part}' carries an unparsable strength after ':'; expected \"name\" or \"name:0.7\""
                    ))
                })?;
                (name.to_owned(), Value::from(strength))
            }
            _ => (part.clone(), Value::from(1.0)),
        };
        loras.push(serde_json::json!({"name": name, "strength": strength}));
    }
    body.insert("loras".to_owned(), Value::Array(loras));
    Ok(())
}

/// `--dials "steps=8,cfg=2"`: merged into the ladder `dials` block; names must be
/// dial names, values land as numbers when they parse, else as strings — exactly the
/// values the structured block carries today.
fn fold_dials(body: &mut Map<String, Value>) -> Result<(), ApiError> {
    let Some(value) = body.remove(DIALS_SHORTHAND) else {
        return Ok(());
    };
    // LEG M12: `dials` is an overloaded wire word — the H3 Dial Rack rides it as an
    // ARRAY (fill_plane's `VIDEO_PASSTHROUGH_KEYS`; jobs_video.rs OPTIONAL:1). The
    // shorthand writes the ladder OBJECT; folding into a rack body would silently
    // replace the rack with a dial block, so the collision is refused by the cause,
    // never resolved by a guess.
    if matches!(body.get("dials"), Some(Value::Array(_))) {
        return Err(invalid(format!(
            "'{DIALS_SHORTHAND}' writes the ladder dials object, but this body's 'dials' is an ARRAY (the H3 Dial Rack); supply the ladder through the defaults sheet, or drop the shorthand to send the rack"
        )));
    }
    let mut block = body
        .remove("dials")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for part in shorthand_list(DIALS_SHORTHAND, &value)? {
        let Some((name, raw)) = part.split_once('=') else {
            return Err(invalid(format!(
                "'--dials' entry '{part}' is not a name=value pair; the accepted shape is \"steps=8,cfg=2.0\" over the dial names {}",
                DIAL_NAMES.join(", ")
            )));
        };
        let name = name.trim();
        if !DIAL_NAMES.contains(&name) {
            return Err(invalid(format!(
                "'--dials' dial '{name}' is not a dial name; the closed set is {}",
                DIAL_NAMES.join(", ")
            )));
        }
        // An integral value lands as a JSON INTEGER, only a fractional one as a float:
        // the ladder types `steps` as u64, so a shorthand that wrote "steps=6" as 6.0
        // died at the dials wall (`invalid type: floating point 6.0, expected u64`)
        // while the structured block `{"steps":6}` sailed through — the two shapes
        // must land the SAME plan (the fold's own stated law).
        let text = raw.trim();
        let value = if let Ok(integer) = text.parse::<u64>() {
            serde_json::json!(integer)
        } else if let Ok(float) = text.parse::<f64>() {
            serde_json::json!(float)
        } else {
            serde_json::json!(text)
        };
        block.insert(name.to_owned(), value);
    }
    body.insert("dials".to_owned(), Value::Object(block));
    Ok(())
}

/// `--refmod "name,name"`: appended to a `refmods` bag with auto slots continuing
/// the existing rows (the fill plane validates the row shape and lands them in
/// `h3.refmods` for the h3 modes); the 1..8 cap refuses here by name.
fn fold_refmods(body: &mut Map<String, Value>) -> Result<(), ApiError> {
    let Some(value) = body.remove(REFMOD_SHORTHAND) else {
        return Ok(());
    };
    let mut rows = body
        .get("refmods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for part in shorthand_list(REFMOD_SHORTHAND, &value)? {
        if rows.len() >= 8 {
            return Err(invalid(
                "'--refmod' exceeds the 1-8 refmod rows (slots 1..=8 unique)".to_owned(),
            ));
        }
        let (name, strength) = match part.rsplit_once(':') {
            Some((name, raw)) if !name.is_empty() => {
                let strength: f64 = raw.parse().map_err(|_| {
                    invalid(format!(
                        "'--refmod' entry '{part}' carries an unparsable strength after ':'; expected \"name\" or \"name:0.7\""
                    ))
                })?;
                (name.to_owned(), strength)
            }
            _ => (part.clone(), 1.0),
        };
        let slot = rows.len() as u64 + 1;
        rows.push(serde_json::json!({"slot": slot, "name": name, "strength": strength}));
    }
    body.insert("refmods".to_owned(), Value::Array(rows));
    Ok(())
}

/// True when the reference is already a library-plane relative name the stock
/// compiler counts (`deas-inputs/...` or the root `deas-input-...`).
fn is_placed_name(reference: &str) -> bool {
    reference.starts_with("deas-inputs/") || reference.starts_with("deas-input-")
}

/// True when the reference is written as a filesystem path (Windows drive form, a
/// leading root on either platform, or any backslash). A POSIX leading `/` is a
/// rooted path even where the host's `Path::is_absolute` says no (Windows: root
/// without a drive prefix is drive-relative, not absolute), so the door names it
/// explicitly — the grammar is platform-independent. Library-relative names use
/// forward slashes under `deas-inputs/`, checked before this by [`is_placed_name`].
pub(crate) fn is_path_form(reference: &str) -> bool {
    let path = Path::new(reference);
    path.is_absolute() || reference.starts_with('/') || reference.contains('\\')
}

/* ---------------- THE E24 PLACEMENT CONTAINMENT LAW (LEG AF2-M19a) ----------------

OWNER RULING E24 (verbatim spirit): "when using the API, it should only let a user touch
input and output files. it should not be able to directly pass anything else... relative
path based off of the DEAS default OR the path set by user in the interface... should not
let it copy from anywhere else on the box, a local agent can manually move items to the
input/output path... don't make it a toggle, just force it. when selecting references
from local (not uploading) there should be no size limit."

WHAT THIS REPLACED: an absolute-path reference was read (capped at the §11 50 MiB upload
constant) and handed to the network upload seam, which placed a COPY of it into the input
plane — from ANYWHERE on the box. That is exactly the capability E24 removes. The door may
touch only the two folders the engine already owns (the input root and the output root,
stock default or UI-set saved path — the same homes the byte doors and the promote door
read); it may not read or copy from anywhere else; and an on-disk file under those folders
carries NO size cap (rulings E21 + E24: on-disk files cost nothing — the caps are
NETWORK caps and live at `POST /v1/uploads`, untouched by this leg).

FOUR ARMS, FORCED, NO TOGGLE:

1. OUTSIDE both roots (path-form or relative) -> `bodyInvalid` naming the law: the
   reference must live under the DEAS input or output folder — a local agent moves it
   there — or its bytes come in through `POST /v1/uploads`. The caller's own string
   rides the detail verbatim (it is already in the body); no served-root path is ever
   echoed (the inputs door's privacy law).
2. INSIDE the INPUT root -> NOTHING is copied and no cap is consulted: the reference is
   rewritten in place to the root-RELATIVE placement form, forward slashes
   (`<input_root>/deas-inputs/project1/pic.jpg` -> `deas-inputs/project1/pic.jpg`; a
   file sitting at the root becomes its bare name). ZERO seam calls — the bytes never
   move. The existence law ([`super::inputs::referenced_placement_names`] and its stat
   pass) then stats the rewritten name exactly as before.
3. INSIDE the OUTPUT root -> a server-side `std::fs::copy` (NEVER a read into memory:
   the class includes video) into a fresh `deas-inputs/<stock-minted-uuid>-name`
   placement, the promote door's mint ([`super::files::copy_into_inputs`], one home),
   and the reference is rewritten to that new placement. The original stays where it is
   — a copy, not a move. No size cap.
4. RELATIVE references with interior separators are ACCEPTED and resolved against the
   INPUT root: `project1/pic.jpg`, `./project1/pic.jpg`, `project1\pic.jpg` (the
   backslash form [`is_path_form`] already catches), `deas-inputs/x.png`. The resolved
   name is normalized to the canonical root-relative form (already-canonical names are
   identity, so library-relative names ride untouched). A `..` that escapes the root is
   refused under arm 1; a `..` that resolves back INSIDE it is decided by containment,
   the same way a path-form reference carrying one is decided.

CONTAINMENT IS ONE LAW WITH ONE HOME (coined for the scan root by LEG AF2-M18b B6,
factored into `files` by this leg so no door restates it): canonicalize both sides, then
component-wise equal-or-inside, case-folded on Windows ([`files::contained_tail`]). The walk wall is the byte doors' symlink refusal
([`files::contained`]'s per-component law, factored as [`files::symlink_free_under`]): a
reference written THROUGH a symlink under a served root is refused even when the link
resolves back inside, and a symlink that escapes is refused structurally because the
canonical resolve lands outside the root. The leaf may be absent at this door
([`files::resolve_shape`] canonicalizes as far as the line lands and appends the rest
lexically) — WHERE a reference may live is decided before WHETHER it exists, and the
existence word rides its own honest refusal.

WITH NO ROOT DERIVABLE (no owned environment readable) a path-form or relative
reference cannot be resolved at all: the door answers the same honest `maintenanceActive`
posture the queue door already carries for placement names — never a guessed folder. A
body naming only placed names, library names or handles still queues with no
environment, exactly as before.
------------------------------------------------------------------------------ */

/// Where one local-path reference sits relative to the served roots (arms 2 and 3).
enum ServedPlacement {
    /// Inside the input root: the payload is the root-relative placement name the
    /// reference is rewritten to (`/`-separated; a root-level file is its bare name).
    Input(String),
    /// Inside the output root: the payload is the resolved on-disk path to copy.
    Output(std::path::PathBuf),
}

/// The E24 refusal (arm 1, and arm 4's escape): the law rides the detail, the caller's
/// own string rides verbatim because it came from the body, and no served-root path is
/// echoed. The word is the body grammar's `bodyInvalid`; there is no cap in this law
/// and the hint says so nowhere — a stranger path is refused for WHERE it is, never for
/// how big it is.
fn outside_law(reference: &str, why: &str) -> ApiError {
    invalid(format!(
        "reference '{reference}' is refused ({why}): the API touches only the engine's own folders — a local-path reference must live under the DEAS input folder or the DEAS output folder (a local agent can move it there), or its bytes must come in through POST /v1/uploads"
    ))
}

/// The honest word when a reference needs a root and none is derivable: the same
/// `maintenanceActive` posture the queue door already carries for placement names.
fn root_undecidable(reference: &str, why: &str) -> ApiError {
    ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
        "the reference '{reference}' is written as a filesystem path but {why}: open the owned DEAS environment so the door can resolve it against the engine's folders, or send a placed reference name, a library name or a 12-hex handle"
    ))
}

/// The existing existence law, restated for the two arms that end in a filesystem
/// action: a path-form reference naming nothing on disk is refused naming the path.
/// The placement law decides containment FIRST, so a stranger path answers the E24
/// law even when it does not exist — the honest word about WHERE the caller reached.
fn missing_path(reference: &str) -> ApiError {
    invalid(format!(
        "reference path '{reference}' does not exist; send a readable file under the engine's input or output folder, a library name or a 12-hex handle"
    ))
}

/// True when a reference is written as an ABSOLUTE path: a drive form, a leading root
/// on either platform, or the host's own absolute law. A backslash RELATIVE form is
/// not absolute — arm 4 resolves it against the input root, so the law reads the same
/// on every host.
fn is_absolute_form(reference: &str) -> bool {
    Path::new(reference).is_absolute() || reference.starts_with('/')
}

/// Splits a relative reference over BOTH separators so the grammar is
/// platform-independent, exactly as [`is_path_form`] already claims it is.
fn relative_segments(reference: &str) -> Vec<&str> {
    reference.split(['/', '\\']).collect()
}

/// The E24 decision for one reference that is neither a handle nor an already-placed
/// name: which served root contains it, and what the reference becomes.
fn classify_reference(
    reference: &str,
    input_root: Option<&Path>,
    output_root: Option<&Path>,
) -> Result<ServedPlacement, ApiError> {
    if is_absolute_form(reference) {
        let spelled = files::normalize_lexical(Path::new(reference));
        // Input first: a reference inside BOTH roots (a nested install) is the file the
        // input plane already holds, and arm 2 costs nothing.
        for (root, is_input) in [(input_root, true), (output_root, false)] {
            let Some(root) = root else { continue };
            let Ok(canonical_root) = std::fs::canonicalize(root) else {
                continue;
            };
            let Some(resolved) = files::resolve_shape(&spelled) else {
                continue;
            };
            let Some(tail) = files::contained_tail(&canonical_root, &resolved) else {
                continue;
            };
            // The walk wall on the reference's OWN spelling, when that spelling lines up
            // under this root: a symlink anywhere on the line is refused (the byte doors'
            // law), even one that resolves back inside. A spelling that reaches the root
            // through links outside it is contained canonically, the shipped M18b posture.
            if let Some(spelled_tail) = files::contained_tail(root, &spelled)
                .or_else(|| files::contained_tail(&canonical_root, &spelled))
            {
                let segments: Vec<&str> = spelled_tail.iter().map(String::as_str).collect();
                if !files::symlink_free_under(root, &segments) {
                    return Err(outside_law(
                        reference,
                        "it is written through a symlink, which the placement law never follows",
                    ));
                }
            }
            if !std::fs::metadata(&resolved).is_ok_and(|metadata| metadata.is_file()) {
                return Err(missing_path(reference));
            }
            if tail.is_empty() {
                return Err(outside_law(
                    reference,
                    "it names the served folder itself, not a file",
                ));
            }
            return Ok(if is_input {
                ServedPlacement::Input(tail.join("/"))
            } else {
                ServedPlacement::Output(resolved)
            });
        }
        if input_root.is_none() && output_root.is_none() {
            return Err(root_undecidable(
                reference,
                "no input or output root is derivable",
            ));
        }
        Err(outside_law(
            reference,
            "it sits outside both the input and the output folder",
        ))
    } else {
        // ARM 4: a relative reference resolves against the INPUT root.
        let Some(input_root) = input_root else {
            return Err(root_undecidable(
                reference,
                "no input root is derivable to resolve it against",
            ));
        };
        let segments: Vec<&str> = relative_segments(reference)
            .into_iter()
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .collect();
        if !files::symlink_free_under(input_root, &segments) {
            return Err(outside_law(
                reference,
                "it is written through a symlink, which the placement law never follows",
            ));
        }
        let mut candidate = input_root.to_path_buf();
        for segment in &segments {
            if *segment == ".." {
                candidate.pop();
            } else {
                candidate.push(segment);
            }
        }
        let Ok(canonical_root) = std::fs::canonicalize(input_root) else {
            return Err(root_undecidable(
                reference,
                "the input root is not a readable folder",
            ));
        };
        let resolved = files::resolve_shape(&candidate).unwrap_or(candidate);
        let Some(tail) = files::contained_tail(&canonical_root, &resolved) else {
            return Err(outside_law(
                reference,
                "it resolves outside the engine's input folder",
            ));
        };
        if tail.is_empty() {
            return Err(outside_law(
                reference,
                "it names the served folder itself, not a file",
            ));
        }
        Ok(ServedPlacement::Input(tail.join("/")))
    }
}

/// One reference under the E24 placement law — the arm logic both entry shapes
/// ride, so the string lane and the entry objects share one placement home.
fn place_one(
    reference: String,
    input_root: Option<&Path>,
    output_root: Option<&Path>,
) -> Result<String, ApiError> {
    if is_handle(&reference) || is_placed_name(&reference) {
        return Ok(reference);
    }
    let name = match classify_reference(&reference, input_root, output_root)? {
        // ARM 2: inside the input plane already — the name is the placement, the
        // bytes never move, no seam, no cap.
        ServedPlacement::Input(name) => name,
        // ARM 3: the output plane — the promote door's server-side copy, the same
        // uuid-minted placement grammar, no cap (a local agent could have moved
        // it here; the door copies it instead, which costs the same).
        ServedPlacement::Output(source) => {
            let Some(input_root) = input_root else {
                return Err(root_undecidable(
                    &reference,
                    "no input root is derivable to copy it into",
                ));
            };
            files::copy_into_inputs(&source, input_root)?.name
        }
    };
    // The rewritten name must be a reference the stock compiler counts (the
    // 255-byte whole-identifier law): surfaced here, where the caller named the
    // path, rather than at the compiler one step later.
    uploads::check_placement(&name)?;
    Ok(name)
}

/// Places every local-path reference under the E24 containment law and rewrites the
/// array in place. Handles and already-placed names pass through untouched; a relative
/// reference is normalized to the canonical placement form. The roots are the engine's
/// own homes — stock default or UI-set saved path — read per request by the calling
/// door through [`super::PlaneState`], the same law the byte doors use. Entry objects
/// (`{file, trimStart?, trimEnd?}`) place through the same arms: only their `"file"`
/// is rewritten, the trim decorations ride through to the fill plane's wall.
///
/// # Errors
///
/// `bodyInvalid` for a reference outside both folders, one written through a symlink,
/// or a path-form reference naming nothing on disk — every refusal names the E24 law
/// and carries the caller's own string; `maintenanceActive` when the reference needs a
/// root and none is derivable. No size cap is consulted anywhere in this path: an
/// on-disk file under a served root costs nothing (rulings E21 + E24).
pub(crate) fn place_references(
    body: &mut Map<String, Value>,
    input_root: Option<&Path>,
    output_root: Option<&Path>,
) -> Result<(), ApiError> {
    for (key, _) in REFERENCE_KEYS {
        if key == "images" {
            let references = reference_array(body, key)?;
            if references.is_empty() {
                continue;
            }
            let placed = references
                .into_iter()
                .map(|reference| place_one(reference, input_root, output_root))
                .collect::<Result<Vec<_>, ApiError>>()?;
            body.insert(
                key.to_owned(),
                Value::Array(placed.into_iter().map(Value::String).collect()),
            );
            continue;
        }
        let entries = reference_entries(body, key)?;
        if entries.is_empty() {
            continue;
        }
        let mut placed = Vec::with_capacity(entries.len());
        for entry in entries {
            let name = place_one(entry.name, input_root, output_root)?;
            let value = match entry.value {
                // An entry object rewrites IN PLACE: only "file" moves; the trim
                // decorations ride through untouched to the fill plane's wall.
                // `reference_entries` validated every entry as string-or-object,
                // so the remaining arm is exactly the plain string entry.
                Value::Object(mut object) => {
                    object.insert("file".to_owned(), Value::String(name));
                    Value::Object(object)
                }
                _ => Value::String(name),
            };
            placed.push(value);
        }
        body.insert(key.to_owned(), Value::Array(placed));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body(text: &str) -> Map<String, Value> {
        serde_json::from_str(text).expect("test body parses")
    }

    fn refusal(error: ApiError) -> Value {
        error.body_json()
    }

    #[test]
    fn e16_caps_match_the_stock_director_lanes() {
        // Pinned against `jobs_video::H3_LANES` (image 9, video 3, audio 3) and the
        // `validate_h3_media` total of 12: the door wall can never drift from stock.
        assert_eq!(MAX_IMAGES, 9);
        assert_eq!(MAX_VIDEOS, 3);
        assert_eq!(MAX_AUDIO, 3);
        assert_eq!(MAX_REFERENCES, 12);
    }

    #[test]
    fn picture_audio_video_aliases_fold_into_the_canonical_arrays_in_numeric_order() {
        let mut request = body(
            r#"{"picture5":"e","picture1":"a","picture2":"b","picture3":"c","picture4":"d",
                "audio1":"g","audio2":"h","audio3":"i","video1":"j","video2":"k"}"#,
        );
        fold(&mut request).expect("aliases fold");
        assert_eq!(
            request["images"],
            json!(["a", "b", "c", "d", "e"]),
            "numeric order, not arrival order"
        );
        assert_eq!(request["audio"], json!(["g", "h", "i"]));
        assert_eq!(request["videos"], json!(["j", "k"]));
        for stray in ["picture1", "audio3", "video2"] {
            assert!(!request.contains_key(stray), "{stray} was consumed");
        }
    }

    #[test]
    fn canonical_and_alias_shapes_land_the_same_arrays_canonical_first() {
        let mut request = body(r#"{"images":["z"],"picture2":"y","picture1":"x"}"#);
        fold(&mut request).expect("both shapes fold");
        assert_eq!(request["images"], json!(["z", "x", "y"]));
    }

    #[test]
    fn malformed_picture_alias_is_refused_naming_the_accepted_shape() {
        for key in ["pictureX", "picture0", "picture13", "picture1a", "picture"] {
            let error = refusal(
                fold(&mut body(&format!(r#"{{"{key}":"a"}}"#))).expect_err("{key} is malformed"),
            );
            assert_eq!(error["reason"], "bodyInvalid");
            assert!(
                error["hint"]
                    .as_str()
                    .is_some_and(|hint| hint.contains("picture1..picture12")),
                "{key}: hint names the shape: {error}"
            );
        }
    }

    #[test]
    fn colliding_keys_are_not_aliases_and_stay_for_the_fill_plane() {
        let mut request = body(r#"{"videoPost":{},"audioVae":"x","videos":["a"]}"#);
        fold(&mut request).expect("no alias is claimed");
        assert!(request.contains_key("videoPost"));
        assert!(request.contains_key("audioVae"));
        assert_eq!(request["videos"], json!(["a"]));
    }

    #[test]
    fn lora_shorthand_parses_strength_suffix_and_bare_default() {
        let mut request = body(r#"{"--lora":"style-a,face-b:0.7"}"#);
        fold(&mut request).expect("lora folds");
        assert_eq!(
            request["loras"],
            json!([{"name":"style-a","strength":1.0},{"name":"face-b","strength":0.7}])
        );
        assert!(!request.contains_key("--lora"));
    }

    #[test]
    fn lora_shorthand_appends_to_the_structured_bag() {
        // The merge law (unchanged since M15): both shapes land one bag. The
        // structured element carries a legal LoRA name because the fold now reads
        // the bag through the fill plane's own shape wall before appending to it
        // (LEG AF2-M18c) — a bag that wall refuses would have been replaced.
        let mut request =
            body(r#"{"loras":[{"name":"one.safetensors","strength":0.5}],"--lora":"two"}"#);
        fold(&mut request).expect("both shapes merge");
        assert_eq!(request["loras"].as_array().expect("array").len(), 2);
        assert_eq!(
            request["loras"][0]["name"], "one.safetensors",
            "the bag survives"
        );
        assert_eq!(request["loras"][1]["name"], "two", "the shorthand appended");
    }

    /// THE SILENT-OVERWRITE FIX (LEG AF2-M18c): a structured `loras` value the fold
    /// cannot read used to decode to "no bag", so the shorthand result REPLACED it
    /// and the caller's LoRAs vanished under an `ok` answer. Now the fold refuses
    /// `bodyInvalid` naming `loras` before it folds, and nothing is written.
    #[test]
    fn a_malformed_structured_loras_bag_refuses_the_shorthand_fold_naming_the_key() {
        for malformed in [
            r#"{"loras":"not-an-array","--lora":"x.safetensors"}"#,
            r#"{"loras":{},"--lora":"x.safetensors"}"#,
            r#"{"loras":["one.safetensors"],"--lora":"x.safetensors"}"#,
            r#"{"loras":[{"name":"one.safetensors"}],"--lora":"x.safetensors"}"#,
            r#"{"loras":[{"name":1,"strength":0.5}],"--lora":"x.safetensors"}"#,
            r#"{"loras":[{"name":"one.gguf","strength":0.5}],"--lora":"x.safetensors"}"#,
        ] {
            let error = refusal(fold(&mut body(malformed)).expect_err("the bag is read first"));
            assert_eq!(error["reason"], "bodyInvalid", "{malformed}");
            let hint = error["hint"].as_str().expect("hint");
            assert!(hint.contains("loras"), "the refusal names the key: {hint}");
        }
    }

    /// A malformed bag WITHOUT the shorthand keeps the law it shipped with: the
    /// fold is not the wall for it (the fill plane refuses it naming the key), so
    /// `fold` still succeeds and nothing about the absent-shorthand path moved.
    #[test]
    fn a_malformed_loras_bag_without_the_shorthand_still_reaches_the_fill_wall() {
        let mut request = body(r#"{"loras":"not-an-array"}"#);
        fold(&mut request).expect("the fold leaves it for the fill plane");
        assert_eq!(request["loras"], "not-an-array", "the fold wrote nothing");
        let error = refusal(
            super::super::fill_plane::check_passthrough_shape("loras", &request["loras"].clone())
                .expect_err("the wall still refuses it"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(error["hint"].as_str().expect("hint").contains("loras"));
    }

    #[test]
    fn unparsable_lora_strength_refuses() {
        let error =
            refusal(fold(&mut body(r#"{"--lora":"a:heavy"}"#)).expect_err("strength parses"));
        assert_eq!(error["reason"], "bodyInvalid");
    }

    #[test]
    fn dials_shorthand_refuses_a_body_whose_dials_is_the_h3_rack_array() {
        // LEG M12: a rack array under `dials` beside the shorthand would be
        // silently destroyed by the fold; the fold names the collision instead.
        let mut request = body(
            r#"{"--dials":"steps=8","dials":[{"dial":"dials/h3_motion.safetensors","strength":1.5}]}"#,
        );
        let error = refusal(fold(&mut request).expect_err("the collision is refused"));
        let text = error["hint"].as_str().expect("hint");
        assert!(text.contains("dials"), "{text} names the colliding key");
        assert!(text.contains("Dial Rack"), "{text} names the rack");
    }

    #[test]
    fn dials_shorthand_lands_dial_values_numbers_stay_numbers() {
        // M11b: the old pin here read `steps: 8.0` — it pinned the fold's float defect,
        // which the u64-typed `steps` dial then refused at the door. Integral values
        // land integral; fractional values land as floats.
        let mut request = body(r#"{"--dials":"steps=8,cfg=2.5,sampler=euler"}"#);
        fold(&mut request).expect("dials fold");
        assert_eq!(
            request["dials"],
            json!({"steps": 8, "cfg": 2.5, "sampler": "euler"})
        );
    }

    #[test]
    fn unknown_dial_name_refuses_naming_the_closed_set() {
        let error = refusal(fold(&mut body(r#"{"--dials":"grain=3"}"#)).expect_err("closed set"));
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(error["hint"]
            .as_str()
            .is_some_and(|hint| hint.contains("steps")));
    }

    #[test]
    fn refmod_shorthand_mints_unique_slots_and_defaults_strength() {
        let mut request = body(r#"{"--refmod":"character-a,object-b:0.4"}"#);
        fold(&mut request).expect("refmods fold");
        assert_eq!(
            request["refmods"],
            json!([
                {"slot": 1, "name": "character-a", "strength": 1.0},
                {"slot": 2, "name": "object-b", "strength": 0.4}
            ])
        );
    }

    #[test]
    fn refmod_bag_over_eight_rows_refuses_naming_the_cap() {
        let mut request = body(r#"{"--refmod":"a,b,c,d,e,f,g,h,i"}"#);
        let error = refusal(fold(&mut request).expect_err("8-row cap"));
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(error["hint"]
            .as_str()
            .is_some_and(|hint| hint.contains("1-8")));
    }

    #[test]
    fn the_caps_wall_names_the_matrix_numbers() {
        let ten: Vec<String> = (0..10).map(|n| format!("deas-inputs/p{n}.png")).collect();
        let error = refusal(
            fold(&mut body(&json!({"images": ten}).to_string()))
                .expect_err("ten images breach the 9-lane"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        let hint = error["hint"].as_str().expect("hint");
        for word in ["9 images", "3 videos", "3 audio", "12 total"] {
            assert!(hint.contains(word), "hint names {word}: {hint}");
        }
    }

    #[test]
    fn the_total_cap_breaches_below_the_lane_caps() {
        let images: Vec<String> = (0..9).map(|n| format!("deas-inputs/p{n}.png")).collect();
        let videos: Vec<String> = (0..3).map(|n| format!("deas-input-v{n}.mp4")).collect();
        let audio: Vec<String> = (0..1).map(|n| format!("deas-inputs/a{n}.wav")).collect();
        let error = refusal(
            fold(&mut body(
                &json!({"images": images, "videos": videos, "audio": audio}).to_string(),
            ))
            .expect_err("13 references breach the 12 total"),
        );
        assert!(error["hint"].as_str().expect("hint").contains("12 total"));
    }

    #[test]
    fn a_non_string_reference_refuses_naming_its_array() {
        let error = refusal(fold(&mut body(r#"{"images":[{"a":1}]}"#)).expect_err("strings only"));
        assert!(error["hint"].as_str().expect("hint").contains("images"));
    }

    /* ---- THE AUDIO-TRIM ENTRY-OBJECT law (LEG: trim for agent-plane video refs) ---- */

    #[test]
    fn trim_entry_objects_pass_the_door_and_land_untouched() {
        // The fold seam must not eat trim objects: entry grammar passes
        // `check_reference_arrays` and the raw array lands byte-equal — the fill
        // plane re-reads the same law at its own wall.
        let mut request = body(
            r#"{"videos":[{"file":"deas-input-v1.mp4","trimStart":1.0,"trimEnd":9.0}],
                "audio":[{"file":"deas-inputs/a.mp3"}]}"#,
        );
        fold(&mut request).expect("entry objects pass the arrays and the caps wall");
        assert_eq!(
            request["videos"],
            json!([{"file": "deas-input-v1.mp4", "trimStart": 1.0, "trimEnd": 9.0}]),
            "the fold wrote nothing to a valid entry object"
        );
        assert_eq!(request["audio"], json!([{"file": "deas-inputs/a.mp3"}]));
    }

    #[test]
    fn the_caps_wall_counts_entry_objects_as_lane_entries() {
        let four: Vec<Value> = (0..4)
            .map(|n| json!({"file": format!("deas-input-v{n}.mp4")}))
            .collect();
        let error = refusal(
            fold(&mut body(&json!({"videos": four}).to_string()))
                .expect_err("four entry objects breach the 3-lane"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        let hint = error["hint"].as_str().expect("hint");
        assert!(
            hint.contains("got 0 images, 4 videos, 0 audio"),
            "the raw counts ride, objects counted as lane entries: {hint}"
        );
    }

    #[test]
    fn an_alias_appends_to_the_raw_array_and_keeps_the_entry_objects() {
        // Rebuilding the array through the string reader would destroy the entry
        // object; the fold appends the alias as a raw string instead.
        let mut request = body(
            r#"{"videos":[{"file":"deas-input-v1.mp4","trimStart":1.0,"trimEnd":9.0}],"video2":"deas-input-v2.mp4"}"#,
        );
        fold(&mut request).expect("the alias folds onto the raw array");
        assert_eq!(
            request["videos"][0],
            json!({"file": "deas-input-v1.mp4", "trimStart": 1.0, "trimEnd": 9.0}),
            "the entry object survived the fold"
        );
        assert_eq!(
            request["videos"][1], "deas-input-v2.mp4",
            "the alias appended"
        );
    }

    #[test]
    fn a_trim_entry_object_places_its_file_and_keeps_the_trims() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let nested = write_under(input.path(), "deas-inputs/clip.mp4", b"video bytes");
        let mut request = body(
            &json!({
                "videos": [{
                    "file": nested.to_str().expect("utf-8"),
                    "trimStart": 2.5,
                    "trimEnd": 12.5
                }]
            })
            .to_string(),
        );
        place_references(&mut request, Some(input.path()), Some(output.path()))
            .expect("the entry object places like a string");
        assert_eq!(
            request["videos"],
            json!([{"file": "deas-inputs/clip.mp4", "trimStart": 2.5, "trimEnd": 12.5}]),
            "only \"file\" moved; the trims ride through to the fill plane"
        );
    }

    #[test]
    fn path_form_and_placed_name_detection() {
        assert!(is_path_form("C:\\inputs\\pic.png"));
        assert!(is_path_form("/home/owner/pic.png"));
        assert!(!is_path_form("deas-inputs/pic.png"));
        assert!(!is_path_form("pic.png"));
        assert!(is_placed_name("deas-inputs/pic.png"));
        assert!(is_placed_name("deas-inputs/project1/picture1.jpg"));
        assert!(is_placed_name("deas-input-7db0.mp4"));
        assert!(!is_placed_name("models/pic.png"));
    }

    /* ---- THE E24 PLACEMENT CONTAINMENT LAW tests (LEG AF2-M19a, ruling E24) ----

    Every fixture builds the two served roots as tempdirs and writes files INSIDE them,
    because the law is about which folder a reference sits in. Tests that used to place a
    stranger path (the pre-E24 posture) are re-pinned to inside-root paths or to the
    refusal the new law owes them.
    -------------------------------------------------------------------------- */

    /// Writes one file under `root` at a `/`-separated relative name; answers its
    /// absolute path, the shape a stranger sends.
    fn write_under(root: &Path, rel: &str, bytes: &[u8]) -> std::path::PathBuf {
        let target = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("folder");
        }
        std::fs::write(&target, bytes).expect("file");
        target
    }

    /// Every entry under `root`, recursively: the proof a refused arm wrote nothing and
    /// an accepted arm wrote exactly what the law says it wrote.
    fn every_path(root: &Path) -> Vec<std::path::PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    stack.push(entry.path());
                } else {
                    found.push(entry.path());
                }
            }
        }
        found
    }

    /// One reference through the placement law, over the two temp roots.
    fn placed(reference: &str, input_root: &Path, output_root: &Path) -> Result<String, ApiError> {
        let mut request = body(&json!({ "images": [reference] }).to_string());
        match place_references(&mut request, Some(input_root), Some(output_root)) {
            Ok(()) => Ok(request["images"][0]
                .as_str()
                .expect("the array rides a string")
                .to_owned()),
            Err(error) => Err(error),
        }
    }

    /// ARM 1, the headline of ruling E24: a stranger absolute path — anywhere else on
    /// the box — is REFUSED naming the two-folder law, and NOTHING is placed: the input
    /// plane is byte-for-byte what the fixture left it. The caller's own string rides the
    /// detail verbatim (it is already in the body); no served-root path is echoed. The
    /// law has no cap, so no cap word may reach the detail either.
    #[test]
    fn a_stranger_absolute_path_refuses_naming_the_two_folder_law_and_places_nothing() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let stranger = tempfile::tempdir().expect("stranger root");
        write_under(
            input.path(),
            "deas-inputs/keep.png",
            b"the plane's own file",
        );
        let outside = write_under(stranger.path(), "notepad.png", b"png bytes");
        let error = refusal(
            placed(
                outside.to_str().expect("utf-8"),
                input.path(),
                output.path(),
            )
            .expect_err("the box outside the two folders is refused"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        let hint = error["hint"].as_str().expect("hint");
        for word in [
            "input folder",
            "output folder",
            "POST /v1/uploads",
            "local agent",
        ] {
            assert!(hint.contains(word), "the hint names {word}: {hint}");
        }
        assert!(
            hint.contains(&outside.to_string_lossy().into_owned()),
            "the caller's own string rides verbatim: {hint}"
        );
        assert!(
            !hint.contains(&input.path().to_string_lossy().into_owned())
                && !hint.contains(&output.path().to_string_lossy().into_owned()),
            "no served root reaches the wire (the inputs door's privacy law): {hint}"
        );
        assert!(!hint.contains("cap"), "this law has no cap: {hint}");
        assert_eq!(
            every_path(input.path()).len(),
            1,
            "ZERO placements: the seam never ran and no copy landed"
        );
        assert!(every_path(output.path()).is_empty());
    }

    /// ARM 2: inside the input root the reference is REWRITTEN to the root-relative
    /// placement form and nothing moves — no copy (the plane still holds exactly the two
    /// files the fixture wrote), no read, no seam, no cap. A file sitting AT the root
    /// becomes its bare name (the root-level video grammar).
    #[test]
    fn a_reference_inside_the_input_root_rewrites_root_relative_without_copying() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let nested = write_under(
            input.path(),
            "deas-inputs/project1/pic.jpg",
            b"\xff\xd8\xff jpeg",
        );
        let at_root = write_under(input.path(), "deas-input-video.mp4", b"video bytes");
        let mut request = body(
            &json!({
                "images": [nested.to_str().expect("utf-8")],
                "videos": [at_root.to_str().expect("utf-8")],
            })
            .to_string(),
        );
        place_references(&mut request, Some(input.path()), Some(output.path()))
            .expect("contained in the input root");
        assert_eq!(request["images"], json!(["deas-inputs/project1/pic.jpg"]));
        assert_eq!(request["videos"], json!(["deas-input-video.mp4"]));
        assert_eq!(
            every_path(input.path()).len(),
            2,
            "no copy landed: the plane holds the two files the fixture wrote"
        );
        assert!(
            every_path(output.path()).is_empty(),
            "the output plane is untouched"
        );
        assert!(nested.exists() && at_root.exists(), "the bytes never moved");
    }

    /// NO SIZE CAP ON AN ON-DISK REFERENCE (E21 + E24): a 51 MiB file — over the §11
    /// upload constant that used to bite this path — sits in the input root and passes.
    /// The length is `set_len` metadata, never 51 MiB of written bytes, and this arm
    /// copies nothing, so no byte of it is ever read.
    #[test]
    fn an_input_root_reference_over_the_upload_cap_costs_nothing() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let folder = input.path().join("deas-inputs");
        std::fs::create_dir_all(&folder).expect("folder");
        let big = folder.join("clip.mp4");
        let handle = std::fs::File::create(&big).expect("file");
        handle
            .set_len(
                super::super::caps::Caps::bytes(super::super::caps::DEFAULT_UPLOAD_SINGLE_MIB) + 1,
            )
            .expect("a sparse length over the §11 network upload cap (50 MiB)");
        drop(handle);
        let mut request = body(&json!({ "videos": [big.to_str().expect("utf-8")] }).to_string());
        place_references(&mut request, Some(input.path()), Some(output.path()))
            .expect("on-disk files cost nothing");
        assert_eq!(request["videos"], json!(["deas-inputs/clip.mp4"]));
        assert!(big.exists(), "the file was never read, moved or re-written");
    }

    /// ARM 3: inside the OUTPUT root the door runs the promote door's server-side copy
    /// into a fresh uuid placement under the input root, rewrites the reference to it, and
    /// leaves the original exactly where it was — a COPY, never a move. No cap.
    #[test]
    fn a_reference_inside_the_output_root_copies_into_a_fresh_placement() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let source = write_under(output.path(), "starred/hero.png", b"png hero bytes");
        let name = placed(source.to_str().expect("utf-8"), input.path(), output.path())
            .expect("the output root is a served folder");
        assert!(
            name.starts_with("deas-inputs/") && name.ends_with(".png"),
            "the stock placement idiom: {name}"
        );
        assert!(
            crate::jobs::model_name(&name),
            "the rewritten reference is one the stock compiler counts: {name}"
        );
        assert!(
            super::super::inputs::input_present(input.path(), &name),
            "the copy landed where the placement name says"
        );
        assert_eq!(
            std::fs::read(
                input
                    .path()
                    .join(name.replace('/', std::path::MAIN_SEPARATOR_STR))
            )
            .expect("copy readable"),
            b"png hero bytes",
            "verbatim bytes"
        );
        assert!(
            source.exists(),
            "a COPY, not a move: the output plane keeps its file"
        );
        assert_eq!(
            std::fs::read(&source).expect("source intact"),
            b"png hero bytes",
            "the original is untouched"
        );
    }

    /// ARM 4: a RELATIVE reference resolves against the INPUT root and normalizes to the
    /// canonical root-relative placement form. The `./` prefix, the interior separator,
    /// the backslash spelling and a `..` that resolves back inside all ride the same law.
    #[test]
    fn a_relative_reference_resolves_against_the_input_root_and_normalizes() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        write_under(input.path(), "project1/pic.jpg", b"jpeg");
        write_under(input.path(), "loose.png", b"png");
        for spelling in [
            "project1/pic.jpg",
            "./project1/pic.jpg",
            "project1\\pic.jpg",
            "project1/../project1/pic.jpg",
            "./loose.png",
            "loose.png",
        ] {
            let name = placed(spelling, input.path(), output.path())
                .expect("{spelling} resolves inside the input root");
            assert!(
                !name.contains("..") && !name.contains('\\') && !name.starts_with("./"),
                "{spelling} landed normalized: {name}"
            );
            assert!(
                super::super::inputs::input_present(input.path(), &name),
                "{spelling} -> {name} is where the file actually sits"
            );
        }
        assert_eq!(
            placed("project1/../loose.png", input.path(), output.path()).expect("inside"),
            "loose.png",
            "the canonical name, never the traversal spelling"
        );
    }

    /// A `deas-inputs/…` reference is a PLACED name and rides the placement door
    /// untouched (the pass-through is prefix-only, the M17a law), traversal spelling and
    /// all: it cannot escape, because the existence law's stock `model_name` wall refuses
    /// the traversal form before any stat join (`inputs::a_traversal_shaped_name_is_never_stat_walked`
    /// pins that wall), so the door answers `inputMissing` naming the name.
    #[test]
    fn a_traversal_spelled_placed_name_rides_and_the_existence_law_refuses_it() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        for spelling in ["deas-inputs/../../outside.png", "deas-inputs/../x.png"] {
            assert_eq!(
                placed(spelling, input.path(), output.path()).expect("the placed prefix rides"),
                spelling,
                "a placed-form name is never rewritten: it is already the grammar"
            );
            assert!(
                !crate::jobs::model_name(spelling),
                "{spelling} is not a stock identifier, so the existence law refuses it"
            );
        }
    }

    /// ARM 4, the identity case: a library-relative name (not placement grammar, not on
    /// disk) normalizes to ITSELF and rides untouched — the placement door never requires
    /// a relative reference to exist, the existence law is what stats placement names.
    #[test]
    fn a_library_relative_name_normalizes_to_identity_and_rides_untouched() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        for spelling in [
            "some/library-name.png",
            "pic.png",
            "anima/something.safetensors",
        ] {
            assert_eq!(
                placed(spelling, input.path(), output.path()).expect("{spelling} is a name"),
                spelling,
                "identity: the name was already the root-relative form"
            );
        }
        assert!(
            every_path(input.path()).is_empty(),
            "a name that is not on disk is not a placement and copies nothing"
        );
    }

    /// ARM 4 + ARM 1: a relative `..` that escapes the root is refused under the SAME
    /// two-folder law a stranger absolute path gets — the two spellings are one reach.
    #[test]
    fn a_relative_escape_refuses_under_the_same_two_folder_law() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        for spelling in [
            "..\\secrets",
            "../secrets",
            "..",
            "../deas-inputs/x.png",
            "project1/../../outside.png",
            "loose.png/../../outside.png",
        ] {
            let error = refusal(
                placed(spelling, input.path(), output.path())
                    .expect_err("{spelling} escapes and is refused"),
            );
            assert_eq!(error["reason"], "bodyInvalid", "{spelling}");
            let hint = error["hint"].as_str().expect("hint");
            assert!(hint.contains("input folder"), "{spelling}: {hint}");
            assert!(hint.contains("POST /v1/uploads"), "{spelling}: {hint}");
            assert!(
                hint.contains(spelling),
                "the caller's string rides verbatim: {hint}"
            );
        }
        assert!(
            every_path(input.path()).is_empty(),
            "ZERO placements behind the refusals"
        );
    }

    /// Containment, not spelling: a path-form reference that carries an interior `..` is
    /// decided by where it LANDS. Inside the root it is accepted and rewritten to the
    /// canonical placement name (the traversal spelling never reaches the intent); the
    /// same shape landing outside is refused.
    #[test]
    fn a_traversal_inside_a_path_form_reference_is_decided_by_where_it_lands() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        write_under(input.path(), "deas-inputs/pic.jpg", b"jpeg");
        let inside = input
            .path()
            .join("deas-inputs")
            .join("project1")
            .join("..")
            .join("pic.jpg");
        assert_eq!(
            placed(inside.to_str().expect("utf-8"), input.path(), output.path())
                .expect("the final path sits inside the root"),
            "deas-inputs/pic.jpg",
            "the canonical name, not the traversal spelling"
        );
        let outside = input
            .path()
            .join("deas-inputs")
            .join("..")
            .join("..")
            .join("outside.png");
        let error = refusal(
            placed(
                outside.to_str().expect("utf-8"),
                input.path(),
                output.path(),
            )
            .expect_err("the same shape lands outside"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(
            error["hint"]
                .as_str()
                .expect("hint")
                .contains("outside both the input and the output folder"),
            "{}",
            error["hint"]
        );
    }

    /// The walk wall (the byte doors' law, `files::symlink_free_under` — factored out of
    /// `files::contained` by this leg and reused here, not restated): a symlink component
    /// anywhere on the walked line is refused EVEN WHEN it resolves back inside the served
    /// root, which is the case the canonical containment compare alone would admit. The
    /// escaping shape (a link out of the root) is refused structurally by the canonical
    /// containment law as well — the two walls together are what the byte doors already
    /// run and what this door now runs too.
    #[cfg(unix)]
    #[test]
    fn a_symlink_component_in_the_reference_walk_is_refused() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let real = write_under(input.path(), "deas-inputs/real.png", b"png inside");
        std::os::unix::fs::symlink(&real, input.path().join("deas-inputs").join("link.png"))
            .expect("an inside-to-inside symlink");
        let error = refusal(
            placed(
                input
                    .path()
                    .join("deas-inputs")
                    .join("link.png")
                    .to_str()
                    .expect("utf-8"),
                input.path(),
                output.path(),
            )
            .expect_err("the walk never reads through a link"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(
            error["hint"].as_str().expect("hint").contains("symlink"),
            "the refusal names the wall: {}",
            error["hint"]
        );
        // And the escape shape, for completeness: the canonical resolve lands outside the
        // root, so containment refuses it even before the walk sees the leaf.
        let stranger = tempfile::tempdir().expect("stranger root");
        let away = write_under(stranger.path(), "away.png", b"outside bytes");
        std::os::unix::fs::symlink(&away, input.path().join("escape.png"))
            .expect("an escaping link");
        let escaped = refusal(
            placed(
                input.path().join("escape.png").to_str().expect("utf-8"),
                input.path(),
                output.path(),
            )
            .expect_err("a link out of the root is never followed"),
        );
        assert_eq!(escaped["reason"], "bodyInvalid");
    }

    /// Item 6: with no root derivable a path-form or relative reference cannot be
    /// resolved at all — the door answers the honest `maintenanceActive` posture the queue
    /// door already carries for placement names, never a guessed folder.
    #[test]
    fn a_local_path_reference_with_no_derivable_root_refuses_maintenance() {
        for spelling in ["C:\\inputs\\pic.png", "project1/pic.jpg", "../outside.png"] {
            let mut request = body(&json!({ "images": [spelling] }).to_string());
            let error = refusal(
                place_references(&mut request, None, None)
                    .expect_err("{spelling} cannot be resolved without a root"),
            );
            assert_eq!(error["reason"], "maintenanceActive", "{spelling}");
            assert!(
                error["hint"]
                    .as_str()
                    .expect("hint")
                    .contains("open the owned DEAS environment"),
                "{spelling}: {}",
                error["hint"]
            );
        }
    }

    /// The existing existence law survives, re-pinned to the one class it now owns: a
    /// path-form reference INSIDE a served root that names nothing on disk. (Before E24
    /// this test used a stranger temp path; under E24 a stranger path is refused by the
    /// containment law first, which is what the ARM 1 test above pins.)
    #[test]
    fn a_missing_path_inside_a_served_root_refuses_naming_the_path() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let ghost = input.path().join("deas-inputs").join("does-not-exist.png");
        let error = refusal(
            placed(ghost.to_str().expect("utf-8"), input.path(), output.path())
                .expect_err("a contained path naming nothing is still refused"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(
            error["hint"]
                .as_str()
                .expect("hint")
                .contains("does not exist"),
            "{}",
            error["hint"]
        );
        assert!(every_path(input.path()).is_empty(), "nothing was placed");
    }

    /// Handles and already-placed names pass through untouched — re-pinned with the roots
    /// the law now consults (a relative name is resolved against the input root, so the
    /// plane must have one; identity normalization keeps the strings byte-identical).
    #[test]
    fn handles_placed_names_and_library_names_pass_through_untouched() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let mut request = body(
            r#"{"images":["a1b2c3d4e5f6","deas-inputs/x.png","deas-inputs/project1/picture1.jpg","some/library-name.png"],"audio":["deas-inputs/s.wav"]}"#,
        );
        place_references(&mut request, Some(input.path()), Some(output.path()))
            .expect("nothing places");
        assert_eq!(
            request["images"],
            json!([
                "a1b2c3d4e5f6",
                "deas-inputs/x.png",
                "deas-inputs/project1/picture1.jpg",
                "some/library-name.png"
            ])
        );
        assert_eq!(request["audio"], json!(["deas-inputs/s.wav"]));
        assert!(
            every_path(input.path()).is_empty() && every_path(output.path()).is_empty(),
            "no copy, no write: only the strings rode through"
        );
    }

    /// LEG M17a measurement (ruling E22), re-pinned to the E24 signature: a NESTED
    /// placement reference rides the canonical arrays un-folded — `is_placed_name` is
    /// prefix-only, the placement law never touches it, and it needs NO derivable root
    /// (a body of placed names still queues with no environment, the posture the queue
    /// door's own no-root law depends on).
    #[test]
    fn a_nested_placement_name_rides_the_surface_unfolded() {
        let mut request = body(
            r#"{"images":["deas-inputs/project1/pic.jpg"],"videos":["deas-inputs/project1/clip.mp4"],"audio":["deas-inputs/project1/song.wav"]}"#,
        );
        fold(&mut request).expect("nested placements fold clean");
        place_references(&mut request, None, None).expect("nothing places");
        assert_eq!(request["images"], json!(["deas-inputs/project1/pic.jpg"]));
        assert_eq!(request["videos"], json!(["deas-inputs/project1/clip.mp4"]));
        assert_eq!(request["audio"], json!(["deas-inputs/project1/song.wav"]));
    }

    /// A reference rewritten by the law must still be a reference the stock compiler
    /// counts: the 255-byte whole-identifier wall is surfaced at the door, naming the
    /// law, rather than one step later at the compiler. The fixture rides the RELATIVE
    /// arm (which imposes no existence requirement) so the long name never has to be
    /// created on disk — a 300-character path is not creatable on a Windows temp path —
    /// and it carries no `deas-inputs/` prefix, which the door would pass through
    /// untouched as an already-placed name.
    #[test]
    fn a_placement_beyond_the_reference_length_law_refuses_at_the_door() {
        let input = tempfile::tempdir().expect("input root");
        let output = tempfile::tempdir().expect("output root");
        let deep = format!("{}/{}", "s".repeat(120), "n".repeat(200));
        let error = refusal(
            placed(&deep, input.path(), output.path())
                .expect_err("the rewritten name is beyond the reference law"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(
            error["hint"].as_str().expect("hint").contains("255-byte"),
            "{}",
            error["hint"]
        );
    }
}
