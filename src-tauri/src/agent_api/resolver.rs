//! The UNIFIED RESOLVER (API-DESIGN §3 step 1-2, §9, §9b): a request model reference
//! becomes concrete intent slots — the checkpoint name the graph loads, the family word
//! and, for split-loader families, the `diffusion` component recipe.
//!
//! Law this module keeps:
//!
//! * ONE resolver for every family and mode (§9b, ruling E10). The queue door calls it;
//!   nothing else expands a model reference.
//! * The library index is the only identity authority. It is read through the stock
//!   snapshot reader ([`crate::downloads::models::index::load`]) with `refresh: false`,
//!   so this leg NEVER runs the scan natives (M3c owns `POST /v1/scan`) and never walks
//!   a model folder. An absent or cold index answers the landed honest word
//!   `libraryScanRequired`. The ONE exception is the explicit rescan seam
//!   ([`refresh_index`], LEG AF2-M27): it is never called by a read, only by the
//!   `POST /v1/models/refresh` door, and it calls the stock refresh with `refresh: true`.
//!   Reads stay cheap; a refresh is EXPLICIT only.
//! * Family = the model's category, mode = the job (§12 resolved-5). Detection comes from
//!   the stock classifier ([`crate::model_families`]) and the index's stored words; an
//!   explicit request-side family that conflicts with the detected one is
//!   `familyAmbiguous` naming both — never a silent winner.
//! * Component recipes come from the single builtin home ([`defaults::builtin_view`]),
//!   never re-embedded. A split-loader family whose required component is not in the
//!   index refuses with `libraryScanRequired` naming the component slot and the
//!   architecture ids that would satisfy it — never a fabricated encoder.
//! * Live-backend allowlists are NOT consulted here: that proof is the M4 live window.
//!
//! Everything below is pure over index data, so the tests drive [`LibraryEntry`] values
//! directly — no backend, no scan, no GPU.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::defaults;
use super::errors::{ApiError, ErrorKind};

/// Where the library index lives for one installation: the stock index cache directory
/// plus the model roots that index was built over. The M4 boot wiring supplies both
/// (they derive from the Tauri app-cache dir and the saved folder settings); until that
/// wiring lands the plane holds `None` and every model reference answers honestly.
#[derive(Clone, Debug)]
pub(crate) struct IndexSource {
    pub(crate) index_dir: PathBuf,
    pub(crate) roots: Vec<PathBuf>,
}

/// The resolver's view of one index record — exactly the fields resolution reads, taken
/// from the stock snapshot's serialized shape ([`crate::downloads::models::index`]).
///
/// `family`/`detected_family`/`family_override` mirror the stock declaration law:
/// an explicit declaration outranks automatic detection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LibraryEntry {
    pub(crate) category: String,
    /// Path relative to the category folder — the exact value ComfyUI loads, so this is
    /// what fills the intent's `checkpoint` slot (§SR9).
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) sha256: Option<String>,
    pub(crate) family: Option<String>,
    pub(crate) detected_family: Option<String>,
    pub(crate) family_override: Option<String>,
    /// Header-verified companion architecture id (text encoder / VAE entries).
    pub(crate) component: Option<String>,
    /// The `.deas.json` sidecar trigger words the scan stored on the snapshot
    /// (`downloads_models_index.rs:22`, fed by the sidecar cache home at
    /// `downloads_models.rs:945` and written by `native_model_edit_lora` at
    /// :1610-1628). LEG M15 (design 12.1 addendum, API-DESIGN.md:444): the
    /// index already carries them, so the identity doors surface them with no
    /// extra file read — this leg still never walks a model folder or opens a
    /// sidecar; an index that stored none answers `None`, honestly.
    pub(crate) trigger_words: Option<Vec<String>>,
}

/// Categories a queue `checkpoint` may load through the image arm.
const CHECKPOINT_CATEGORIES: [&str; 3] = ["checkpoints", "diffusion_models", "unet"];
/// Categories that can satisfy a family's `textEncoders` component slot.
const TEXT_ENCODER_CATEGORIES: [&str; 2] = ["text_encoders", "clip"];
/// Categories that can satisfy a family's `vaes` component slot.
const VAE_CATEGORIES: [&str; 1] = ["vae"];

/// Reads the stock snapshot index for one source. `refresh: false` is the law of this
/// leg: the reader returns the cached index when present and never walks model folders.
///
/// # Errors
///
/// Reports the stock reader's own failure text; the caller turns it into the honest
/// `libraryScanRequired` posture, never a silent empty library.
pub(crate) fn load_index(source: &IndexSource) -> Result<Vec<LibraryEntry>, String> {
    let snapshots =
        crate::downloads::models::index::load(&source.index_dir, source.roots.clone(), false)?;
    Ok(snapshots
        .iter()
        .map(|snapshot| {
            // Snapshot fields are private; the stock Serialize impl is the stable view.
            let value = serde_json::to_value(snapshot).unwrap_or(Value::Null);
            let text = |key: &str| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|text| !text.is_empty())
            };
            LibraryEntry {
                category: text("category").unwrap_or_default(),
                name: text("name").unwrap_or_default(),
                path: text("path").unwrap_or_default(),
                sha256: value
                    .get("info")
                    .and_then(|info| info.get("sha256"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                family: text("family"),
                detected_family: text("detectedFamily"),
                family_override: text("familyOverride"),
                component: text("component"),
                // The snapshot's own list, verbatim; absent stays absent
                // (None), a cleared list stays the honest empty list (the
                // stock writer serializes `[]` after a clear, :2983-side).
                trigger_words: value
                    .get("triggerWords")
                    .and_then(Value::as_array)
                    .map(|words| {
                        words
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    }),
            }
        })
        .collect())
}

/// The rescan door's single home (LEG AF2-M27, owner law 2026-11-22: "API should allow
/// you to call for the rescan"). This is the ONLY place the plane asks the stock index
/// for a rebuild, and it calls the SAME seam the UI's "Refresh models" button calls —
/// `native_models_scan` (downloads_models.rs:1775) runs exactly
/// `index::load(&index::directory(app), roots, refresh: true)`; here the index dir comes
/// from the boot-wired [`IndexSource`] instead of a fresh `index::directory` bridge, and
/// the caller's `spawn_blocking` wrapper mirrors that command so the header walk never
/// runs on an async lane thread.
///
/// Why the door exists: the snapshot (schema `model-index-v1`) is the resolver's ground
/// truth for model and component classification, and ONLY this refresh recomputes it —
/// the walk re-reads each file's header, then `detect_component`
/// (downloads_models.rs:965) and the family detector stamp the component words a split
/// loader (an h3.video row) needs. A read through [`load_index`], however many times
/// repeated, can never produce a stamp the stored snapshot lacks.
///
/// The `refresh: false` law of [`load_index`] is untouched by this function: reads stay
/// cheap and folder-walk-free, and a walk is only ever paid when a caller asks for it by
/// name. The stock scoped refresh (`load_scoped` with a `RefreshScope`) is deliberately
/// NOT reachable from the plane — its fields are private and `Deserialize`-only, and the
/// door stays a full refresh: E26 kin, the engine's saved folders only, no parameters.
///
/// Returns the number of snapshot entries the rebuilt index carries.
///
/// # Errors
///
/// Reports the stock reader's own failure text verbatim; the door rides it as
/// `maintenanceActive`, never a swallowed partial snapshot.
pub(crate) fn refresh_index(source: &IndexSource) -> Result<usize, String> {
    crate::downloads::models::index::load(&source.index_dir, source.roots.clone(), true)
        .map(|models| models.len())
}

/// What one model reference resolved to: the slot values the fill plane leaves open,
/// plus the identity the spool row records (§5 `modelHandle`/`sha256`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Resolved {
    pub(crate) family: String,
    pub(crate) checkpoint: String,
    pub(crate) diffusion: Option<Value>,
    pub(crate) sha256: Option<String>,
}

impl Resolved {
    /// The §9 handle for this model: first 12 hex of its library sha256; `None` for an
    /// entry the scan never fingerprinted.
    pub(crate) fn model_handle(&self) -> Option<&str> {
        handle_of(self.sha256.as_deref())
    }
}

/// The §9 handle law in one home: first 12 hex of a library fingerprint, `None` for an
/// entry the scan never fingerprinted. The resolver, the identity doors and every row
/// that names a model all take the handle from here.
pub(crate) fn handle_of(sha256: Option<&str>) -> Option<&str> {
    sha256.map(|sha| &sha[..12.min(sha.len())])
}

/// True for the §9 handle grammar: exactly 12 hex digits (any case on the wire, the
/// index stores lowercase).
pub(crate) fn is_handle(reference: &str) -> bool {
    reference.len() == 12 && reference.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// The full-fingerprint grammar (LORA FAMILY ROUTING, owner ruling 2026-11-22): exactly
/// 64 hex digits, any case on the wire, the index stores lowercase. A 64-hex reference
/// matches an entry's stored sha256 EXACTLY (the 12-hex handle law keeps `starts_with`).
pub(crate) fn is_sha256(reference: &str) -> bool {
    reference.len() == 64 && reference.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Resolves one model reference against the index (API-DESIGN §3 steps 1-2).
///
/// * `reference` — a 12-hex library handle, a ComfyUI-relative model name, or an
///   absolute file path (§3 step 1's three forms).
/// * `explicit_family` — the request's own `family` word, when it carried one. A
///   conflict with the detected family is `familyAmbiguous` naming both; agreement is
///   accepted, and an explicit word alone (undetected model) is honored.
///
/// The `diffusion` slot is filled only for `loader: "diffusion"` families (the split
/// law of `builtin.json`); an explicit request-side component recipe outranks the index
/// and is supplied by the door, which keeps the request's own value verbatim.
///
/// # Errors
///
/// Closed taxonomy only: `libraryScanRequired` (no index entry, or a required component
/// missing), `familyAmbiguous` (reference matches several entries, family conflicts with
/// detection, or no family can be established), `bodyInvalid` (reference grammar or a
/// non-checkpoint category).
#[cfg(test)]
pub(crate) fn resolve(
    entries: &[LibraryEntry],
    reference: &str,
    explicit_family: Option<&str>,
) -> Result<Resolved, ApiError> {
    resolve_with(entries, reference, explicit_family, &BTreeMap::new())
}

/// The same resolve law with the operator's component overrides in the picture
/// (`deas-agent-settings.json` `componentOverrides`, owner ruling 2026-11-22): a family
/// slot pinned to an indexed file name is accepted WITHOUT the header-verified
/// architecture stamp - the operator asserts the pairing, and the stock backend stays
/// the last arbiter: a file it refuses fails its row honestly. An override naming an
/// entry absent from the index keeps the honest `libraryScanRequired` posture.
pub(crate) fn resolve_with(
    entries: &[LibraryEntry],
    reference: &str,
    explicit_family: Option<&str>,
    overrides: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<Resolved, ApiError> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
            "the model reference must be a 12-hex library handle, a model name or a path",
        ));
    }
    let matches = matching_entries(entries, reference)?;
    let entry = matches
        .into_iter()
        .next()
        // §3 step 1: a miss is the scan posture, never a guess.
        .ok_or_else(|| {
            ApiError::new(ErrorKind::LibraryScanRequired).with_hint(format!(
                "no library entry for '{reference}'; the model must appear in the DEAS library index (the scan bridge ships with POST /v1/scan)"
            ))
        })?;
    if !CHECKPOINT_CATEGORIES.contains(&entry.category.as_str()) {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "'{reference}' is a {} entry; the queue model reference must name a {} model",
            entry.category,
            CHECKPOINT_CATEGORIES.join("/")
        )));
    }
    if !crate::jobs::comfy_model_name(&entry.name) {
        return Err(ApiError::new(ErrorKind::LibraryScanRequired).with_hint(format!(
            "library entry for '{reference}' carries a name ComfyUI cannot load; re-scan the library"
        )));
    }

    let detected = family_of(&entry);
    let family = match (explicit_family, &detected) {
        (Some(explicit), Some(found)) if explicit != found => {
            return Err(ApiError::new(ErrorKind::FamilyAmbiguous).with_hint(format!(
                "the request says family '{explicit}' but the library detects '{found}' for '{}'; correct one",
                entry.name
            )));
        }
        (Some(explicit), _) => explicit.to_owned(),
        (None, Some(found)) => found.clone(),
        (None, None) => {
            return Err(ApiError::new(ErrorKind::FamilyAmbiguous).with_hint(format!(
                "the family of '{}' is unknown to the library; send the family word explicitly or re-scan",
                entry.name
            )))
        }
    };
    if !defaults::is_known_family(&family) {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "family '{family}' is not a builtin.json family id; GET /v1/families lists them"
        )));
    }

    let diffusion = if defaults::builtin_loader(&family) == Some("diffusion") {
        Some(build_diffusion(entries, &family, overrides)?)
    } else {
        None
    };
    Ok(Resolved {
        family,
        checkpoint: entry.name.clone(),
        diffusion,
        sha256: entry.sha256.clone(),
    })
}

/// The §3 step 1 lookup plus its ambiguity law, in the one home both the queue door and
/// the identity doors read: the matched entries, or the `familyAmbiguous` refusal naming
/// every candidate when one reference lands on several index entries. An empty answer is
/// NOT an error here — the identity doors surface "nothing matches" honestly, while the
/// queue door turns it into the `libraryScanRequired` posture itself.
pub(crate) fn matching_entries(
    entries: &[LibraryEntry],
    reference: &str,
) -> Result<Vec<LibraryEntry>, ApiError> {
    let matches = find_entries(entries, reference)?;
    // Several index entries under one reference: the identity is ambiguous, name them.
    if matches.len() > 1 {
        let candidates: Vec<String> = matches
            .iter()
            .map(|entry| format!("{} ({})", entry.name, entry.category))
            .collect();
        return Err(ApiError::new(ErrorKind::FamilyAmbiguous).with_hint(format!(
            "model reference '{reference}' matches several library entries: {}; disambiguate with the 12-hex handle",
            candidates.join(", ")
        )));
    }
    Ok(matches)
}

/// The reference forms of §3 step 1, matched against the index. Names and paths
/// are matched exactly (case-insensitively, the way the stock listings compare); a
/// 12-hex reference tries the handle law first, then falls back to name/path so a real
/// file literally named `deadbeefcafe.safetensors` stays reachable. A 64-hex reference
/// tries the EXACT sha256 law first — the fingerprint bypass: the file resolves by its
/// scan-recorded digest regardless of any other stored word (LORA FAMILY ROUTING).
fn find_entries(entries: &[LibraryEntry], reference: &str) -> Result<Vec<LibraryEntry>, ApiError> {
    let probe = reference.to_ascii_lowercase();
    let by_name = entries.iter().filter(|entry| {
        entry.name.to_ascii_lowercase() == probe || entry.path.to_ascii_lowercase() == probe
    });
    if is_handle(reference) {
        let by_handle: Vec<LibraryEntry> = entries
            .iter()
            .filter(|entry| {
                entry
                    .sha256
                    .as_deref()
                    .is_some_and(|sha| sha.to_ascii_lowercase().starts_with(&probe))
            })
            .cloned()
            .collect();
        if !by_handle.is_empty() {
            return Ok(dedup(by_handle));
        }
    }
    if is_sha256(reference) {
        let by_sha: Vec<LibraryEntry> = entries
            .iter()
            .filter(|entry| {
                entry
                    .sha256
                    .as_deref()
                    .is_some_and(|sha| sha.to_ascii_lowercase() == probe)
            })
            .cloned()
            .collect();
        if !by_sha.is_empty() {
            return Ok(dedup(by_sha));
        }
    }
    Ok(dedup(by_name.cloned().collect()))
}

/// Collapses duplicate index rows for the same file (the stock reader can list one path
/// under two roots only rarely, but the resolver must not turn that into ambiguity).
fn dedup(mut entries: Vec<LibraryEntry>) -> Vec<LibraryEntry> {
    entries.sort_by(|left, right| {
        left.path
            .to_ascii_lowercase()
            .cmp(&right.path.to_ascii_lowercase())
    });
    entries.dedup_by(|left, right| {
        left.path.eq_ignore_ascii_case(&right.path) && left.category == right.category
    });
    entries
}

/// The LoRA reference law (LORA FAMILY ROUTING, owner ruling 2026-11-22): a queue
/// `loras[]` reference resolves a `loras`-category index entry by name, path, 12-hex
/// handle, or the FULL 64-hex sha256 fingerprint. A fingerprint match resolves
/// REGARDLESS of the entry's family stamp — a wrongly categorized LoRA still runs
/// (the runtime half of this same law is the `loras` exemption in the stock execution
/// check, `downloads_models.rs` `field == "loras"`); the fingerprint is the identity,
/// never the family word. The entry rides on verbatim (name, path, stamp and all): it
/// is the file's real path/name the door hands to the backend.
///
/// # Errors
///
/// `libraryScanRequired` (no entry matches), `familyAmbiguous` (several entries match,
/// or an empty reference), `bodyInvalid` (the matched entry is not a `loras` row).
// The law's home; the door-side call is `routes::resolve_lora_bag` (queue door and
// story base, LORA FAMILY ROUTING leg), which rewrites a hex reference to the
// entry's real name before fill and spool. The shared lookup law (`find_entries`)
// also gives every model-reference surface the 64-hex arm.
pub(crate) fn resolve_lora(
    entries: &[LibraryEntry],
    reference: &str,
) -> Result<LibraryEntry, ApiError> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
            "the lora reference must be a model name, a path, a 12-hex handle or a full 64-hex sha256",
        ));
    }
    let matches = matching_entries(entries, reference)?;
    let entry = matches
        .into_iter()
        .next()
        .ok_or_else(|| {
            ApiError::new(ErrorKind::LibraryScanRequired).with_hint(format!(
                "no lora entry for '{reference}'; the file must appear in the DEAS library index (the scan bridge ships with POST /v1/scan)"
            ))
        })?;
    if entry.category != "loras" {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "'{reference}' is a {} entry; a lora reference must name a loras entry",
            entry.category
        )));
    }
    Ok(entry)
}

/// Stock's family precedence, the one home the resolver reads: a declaration (override
/// or CivitAI base) outranks the automatic header detection; the stock classifier is the
/// last honest word for an index that stored none (it reads the file header, so an
/// offline entry simply yields `None`). The identity doors do NOT use this — a listing
/// never probes a file header, it answers what the index stored.
fn family_of(entry: &LibraryEntry) -> Option<String> {
    entry
        .family_override
        .clone()
        .or_else(|| entry.family.clone())
        .or_else(|| entry.detected_family.clone())
        .or_else(|| {
            crate::model_families::detect(&entry.category, std::path::Path::new(&entry.path), None)
        })
}

/// Builds the split-loader `diffusion` recipe compile demands
/// (`{textEncoder, clipType, vae}`; jobs.rs validates the shape).
///
/// * `clipType` is the family's builtin word — the single home, never re-typed here.
/// * Components are index entries whose header-verified `component` architecture the
///   family accepts (`builtin.json` `components`, checked through the stock
///   [`crate::model_families::component_matches`] seam).
/// * A missing component is a named refusal, never a placeholder.
fn build_diffusion(
    entries: &[LibraryEntry],
    family: &str,
    overrides: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<Value, ApiError> {
    let clip_type = builtin_field(family, "clipType").ok_or_else(|| {
        ApiError::new(ErrorKind::MaintenanceActive).with_hint(format!(
            "builtin family '{family}' declares loader 'diffusion' but no clipType; family plugin is inconsistent"
        ))
    })?;
    let text_encoder = find_component(
        entries,
        family,
        "textEncoders",
        &TEXT_ENCODER_CATEGORIES,
        overrides,
    )
    .ok_or_else(|| component_missing(family, "textEncoders"))?;
    let vae = find_component(entries, family, "vaes", &VAE_CATEGORIES, overrides)
        .ok_or_else(|| component_missing(family, "vaes"))?;
    Ok(json!({
        "textEncoder": text_encoder,
        "clipType": clip_type,
        "vae": vae,
    }))
}

/// The honest refusal for an absent component: the word §3 reserves for "the library
/// does not know enough", the hint naming the slot and the accepted architectures.
fn component_missing(family: &str, slot: &str) -> ApiError {
    let accepted = builtin_components(family, slot).join("|");
    let accepted = if accepted.is_empty() {
        "(none declared)".to_owned()
    } else {
        accepted
    };
    ApiError::new(ErrorKind::LibraryScanRequired).with_hint(format!(
        "family '{family}' needs a {slot} component ({accepted}) present in the library index; place it and re-scan (POST /v1/scan ships with M3c)"
    ))
}

/// One component slot: an operator override pinned for this family+slot wins when it
/// names an indexed entry of a loadable category (the operator asserts the pairing; no
/// architecture stamp is demanded, the backend is the arbiter). Otherwise the first index
/// entry, in stable name order, whose category can hold the slot and whose verified
/// architecture the family accepts.
fn find_component(
    entries: &[LibraryEntry],
    family: &str,
    slot: &str,
    categories: &[&str],
    overrides: &BTreeMap<String, BTreeMap<String, String>>,
) -> Option<String> {
    if let Some(name) = overrides.get(family).and_then(|slots| slots.get(slot)) {
        let wanted = name.replace('\\', "/");
        if let Some(entry) = entries.iter().find(|entry| {
            categories.contains(&entry.category.as_str()) && entry.name.replace('\\', "/") == wanted
        }) {
            // The INDEX's exact name is what ComfyUI loads, so that is what rides on.
            return Some(entry.name.clone());
        }
    }
    let mut candidates: Vec<&LibraryEntry> = entries
        .iter()
        .filter(|entry| categories.contains(&entry.category.as_str()))
        .filter(|entry| {
            entry.component.as_deref().is_some_and(|component| {
                crate::model_families::component_matches(family, slot, component) == Some(true)
            })
        })
        .collect();
    candidates.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
    candidates.first().map(|entry| entry.name.clone())
}

/// One family's `builtin.json` entry inside the single embedded home (a 42-row ARRAY,
/// keyed by nothing, so the scan is the honest shape).
fn builtin_entry(family: &str) -> Option<&'static Value> {
    defaults::builtin_view()
        .as_array()?
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(family))
}

/// One scalar field of a family's builtin entry.
fn builtin_field(family: &str, key: &str) -> Option<String> {
    builtin_entry(family)
        .and_then(|entry| entry.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// The architecture ids a family accepts for one component slot (`components.<slot>`).
fn builtin_components(family: &str, slot: &str) -> Vec<String> {
    builtin_entry(family)
        .and_then(|entry| entry.get("components"))
        .and_then(|components| components.get(slot))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// §9 turbo shorthand: the value is `true` or the literal `"--turbo"`; anything else is
/// a malformed shorthand refused at the door (never ignored).
pub(crate) fn parse_turbo(value: &Value) -> Result<bool, ApiError> {
    match value {
        Value::Bool(true) => Ok(true),
        Value::String(word) if word == "--turbo" => Ok(true),
        Value::Bool(false) => Ok(false),
        other => Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "turbo must be true or the shorthand \"--turbo\"; got {other}"
        ))),
    }
}

/// The §9/SR7 turbo law: turbo is a family VARIANT, never a flag. Returns the variant
/// id when `builtin.json` declares `<family>-turbo`.
pub(crate) fn turbo_variant(family: &str) -> Option<String> {
    let candidate = format!("{family}-turbo");
    builtin_entry(&candidate).map(|_| candidate)
}

/// The fixed `sigmas` a turbo variant declares (the lying-sigma schedule of §SR7); the
/// door injects them as the intent's passthrough `sigmas` key.
pub(crate) fn turbo_sigmas(family: &str) -> Option<Value> {
    builtin_entry(family)
        .and_then(|entry| entry.get("sigmas"))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire reason word of a refusal — the same single home the surfaces read.
    fn reason(error: &ApiError) -> String {
        error.body_json()["reason"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    fn hint(error: &ApiError) -> String {
        error.body_json()["hint"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }
    fn entry(category: &str, name: &str, sha: Option<&str>) -> LibraryEntry {
        LibraryEntry {
            category: category.to_owned(),
            name: name.to_owned(),
            path: format!("/models/{category}/{name}"),
            sha256: sha.map(str::to_owned),
            family: None,
            detected_family: None,
            family_override: None,
            component: None,
            trigger_words: None,
        }
    }

    fn anima_library() -> Vec<LibraryEntry> {
        let mut model = entry(
            "diffusion_models",
            "anima.safetensors",
            Some("a1b2c3d4e5f60718293a4b5c6d7e8f90"),
        );
        model.detected_family = Some("anima".to_owned());
        let mut encoder = entry("text_encoders", "qwen3-0.6b.safetensors", None);
        encoder.component = Some("qwen3-0.6b".to_owned());
        let mut vae = entry("vae", "wan2.1_vae.safetensors", None);
        vae.component = Some("wan-2.1-vae".to_owned());
        vec![model, encoder, vae]
    }

    #[test]
    fn handle_resolves_family_checkpoint_and_diffusion() {
        let library = anima_library();
        let resolved = resolve(&library, "a1b2c3d4e5f6", None).expect("resolves");
        assert_eq!(resolved.family, "anima");
        assert_eq!(resolved.checkpoint, "anima.safetensors");
        assert_eq!(resolved.model_handle(), Some("a1b2c3d4e5f6"));
        let diffusion = resolved.diffusion.expect("anima is a split-loader family");
        assert_eq!(diffusion["textEncoder"], "qwen3-0.6b.safetensors");
        assert_eq!(diffusion["vae"], "wan2.1_vae.safetensors");
        assert_eq!(diffusion["clipType"], "stable_diffusion");
    }

    #[test]
    fn name_reference_hits_the_same_entry() {
        let library = anima_library();
        let resolved = resolve(&library, "anima.safetensors", None).expect("name path");
        assert_eq!(resolved.checkpoint, "anima.safetensors");
    }

    #[test]
    fn unknown_reference_is_library_scan_required() {
        let library = anima_library();
        let error = resolve(&library, "ffffffffffff", None).unwrap_err();
        assert_eq!(reason(&error), "libraryScanRequired");
    }

    #[test]
    fn explicit_family_conflict_names_both_words() {
        let library = anima_library();
        let error = resolve(&library, "a1b2c3d4e5f6", Some("flux")).unwrap_err();
        assert_eq!(reason(&error), "familyAmbiguous");
        let hint = hint(&error);
        assert!(hint.contains("flux") && hint.contains("anima"), "{hint}");
    }

    #[test]
    fn explicit_family_agreement_is_accepted() {
        let library = anima_library();
        let resolved = resolve(&library, "a1b2c3d4e5f6", Some("anima")).expect("agreement");
        assert_eq!(resolved.family, "anima");
    }

    #[test]
    fn missing_component_slot_refuses_naming_the_architectures() {
        let library = vec![anima_library().remove(0)];
        let error = resolve(&library, "a1b2c3d4e5f6", None).unwrap_err();
        assert_eq!(reason(&error), "libraryScanRequired");
        let hint = hint(&error);
        assert!(
            hint.contains("textEncoders") && hint.contains("qwen3-0.6b"),
            "{hint}"
        );
    }

    /// A qwen-image-2.1 model whose component slots hold UNSTAMPED files: refused alone,
    /// accepted when the operator pins both names in `componentOverrides` (the pairing is
    /// asserted, the backend stays the arbiter).
    fn qwen21_unstamped_library() -> Vec<LibraryEntry> {
        let mut model = entry("diffusion_models", "qwen21-base_fp16.safetensors", None);
        model.family = Some("qwen-image-2.1".to_owned());
        let encoder = entry(
            "text_encoders",
            "qwen21\\customEncoder_v10.safetensors",
            None,
        );
        let vae = entry("vae", "qwen21\\customVae_v10.safetensors", None);
        vec![model, encoder, vae]
    }

    fn qwen21_overrides() -> BTreeMap<String, BTreeMap<String, String>> {
        let mut slots = BTreeMap::new();
        slots.insert(
            "textEncoders".to_owned(),
            "qwen21/customEncoder_v10.safetensors".to_owned(),
        );
        slots.insert(
            "vaes".to_owned(),
            "qwen21/customVae_v10.safetensors".to_owned(),
        );
        let mut overrides = BTreeMap::new();
        overrides.insert("qwen-image-2.1".to_owned(), slots);
        overrides
    }

    #[test]
    fn unstamped_components_are_refused_without_an_override() {
        let error = resolve(
            &qwen21_unstamped_library(),
            "qwen21-base_fp16.safetensors",
            None,
        )
        .unwrap_err();
        assert_eq!(reason(&error), "libraryScanRequired");
    }

    #[test]
    fn operator_override_accepts_an_unstamped_component() {
        let resolved = resolve_with(
            &qwen21_unstamped_library(),
            "qwen21-base_fp16.safetensors",
            None,
            &qwen21_overrides(),
        )
        .expect("override accepted");
        let diffusion = resolved.diffusion.expect("split loader recipe");
        assert_eq!(
            diffusion["textEncoder"],
            "qwen21\\customEncoder_v10.safetensors"
        );
        assert_eq!(diffusion["vae"], "qwen21\\customVae_v10.safetensors");
    }

    #[test]
    fn an_override_naming_an_unindexed_entry_keeps_the_scan_posture() {
        let library = vec![qwen21_unstamped_library().remove(0)];
        let error = resolve_with(
            &library,
            "qwen21-base_fp16.safetensors",
            None,
            &qwen21_overrides(),
        )
        .unwrap_err();
        assert_eq!(reason(&error), "libraryScanRequired");
    }

    /// The override law is family-agnostic: it works for ANY split-loader family and its
    /// encoders/VAEs, it outranks a stamped auto-match (a user swapping in a custom
    /// component on a family that already resolves), and a pin set for one family never
    /// unlocks another.
    #[test]
    fn overrides_are_family_agnostic_and_family_scoped() {
        // krea-2 declares qwen3-vl-4b + wan-2.1-vae; the index carries BOTH encoders -
        // the stamped one auto-matches, the custom one is unstamped.
        let mut model = entry("diffusion_models", "krea2-turbo_fp16.safetensors", None);
        model.family = Some("krea-2".to_owned());
        let mut stamped = entry(
            "text_encoders",
            "clip/Krea2/qwen3vl_4b_bf16.safetensors",
            None,
        );
        stamped.component = Some("qwen3-vl-4b".to_owned());
        let custom = entry(
            "text_encoders",
            "clip/Krea2/myCustomEncoder_v2.safetensors",
            None,
        );
        let mut vae = entry("vae", "vae/Krea2/qwen_image_vae.safetensors", None);
        vae.component = Some("wan-2.1-vae".to_owned());
        let library = vec![model, stamped, custom, vae];
        // (a) no override: the stamped auto-match wins.
        let auto = resolve(
            &[library[0].clone(), library[1].clone(), library[3].clone()],
            "krea2-turbo_fp16.safetensors",
            None,
        )
        .expect("stamped match");
        assert_eq!(
            auto.diffusion.expect("recipe")["textEncoder"],
            "clip/Krea2/qwen3vl_4b_bf16.safetensors"
        );
        // (b) the family pins the custom encoder: it outranks the stamped match.
        let mut slots = BTreeMap::new();
        slots.insert(
            "textEncoders".to_owned(),
            "clip/Krea2/myCustomEncoder_v2.safetensors".to_owned(),
        );
        let mut overrides = BTreeMap::new();
        overrides.insert("krea-2".to_owned(), slots);
        let picked = resolve_with(&library, "krea2-turbo_fp16.safetensors", None, &overrides)
            .expect("custom component honored");
        assert_eq!(
            picked.diffusion.expect("recipe")["textEncoder"],
            "clip/Krea2/myCustomEncoder_v2.safetensors"
        );
        // (c) a pin under the WRONG family key never unlocks anything: qwen-image-2.1
        // stays refused when only a krea-2 block is present.
        let error = resolve_with(
            &qwen21_unstamped_library(),
            "qwen21-base_fp16.safetensors",
            None,
            &overrides,
        )
        .unwrap_err();
        assert_eq!(reason(&error), "libraryScanRequired");
    }

    #[test]
    fn undetected_family_without_a_word_is_ambiguous() {
        let mut model = entry(
            "checkpoints",
            "mystery.safetensors",
            Some("00001111222233334444555566667777"),
        );
        model.path = "/models/checkpoints/mystery.safetensors".to_owned();
        let library = vec![model];
        let error = resolve(&library, "000011112222", None).unwrap_err();
        assert_eq!(reason(&error), "familyAmbiguous");
    }

    #[test]
    fn checkpoint_family_needs_no_diffusion_slot() {
        let mut model = entry(
            "checkpoints",
            "sd15.safetensors",
            Some("9e8d7c6b5a4938271605f4e3d2c1b0ae"),
        );
        model.detected_family = Some("sd15".to_owned());
        let resolved = resolve(&[model], "9e8d7c6b5a49", None).expect("checkpoint loader");
        assert_eq!(resolved.family, "sd15");
        assert!(resolved.diffusion.is_none());
    }

    #[test]
    fn lora_reference_refuses_as_a_non_checkpoint_category() {
        let library = vec![entry(
            "loras",
            "detail-fix.safetensors",
            Some("1234567890abcdef1234567890abcdef"),
        )];
        let error = resolve(&library, "1234567890ab", None).unwrap_err();
        assert_eq!(reason(&error), "bodyInvalid");
    }

    /// LORA FAMILY ROUTING (5): the fingerprint bypass. A lora reference given as the
    /// file's FULL 64-hex sha256 resolves the scan entry by digest, REGARDLESS of the
    /// wrong family stamp on it — the owner's escape from a mis-categorized scan. The
    /// entry rides on verbatim: its real name/path is what the door hands the backend.
    #[test]
    fn sha256_reference_resolves_a_wrongly_stamped_lora() {
        let sha = "0f3e2d1c4b5a6978a7b6c5d4e3f20189abcdef00112233445566778899aabbcc";
        let mut lora = entry(
            "loras",
            "Anima/BallsDeep-Anima-V1F-Re.safetensors",
            Some(sha),
        );
        lora.family = Some("sd15".to_owned());
        lora.detected_family = Some("sd15".to_owned());
        let library = vec![lora.clone()];
        let found = resolve_lora(&library, sha).expect("the digest outranks the wrong stamp");
        assert_eq!(found.name, "Anima/BallsDeep-Anima-V1F-Re.safetensors");
        assert_eq!(found.sha256.as_deref(), Some(sha));
        assert_eq!(found.category, "loras");
        // Name references work on the same path, and a NON-loras entry is refused.
        assert_eq!(
            resolve_lora(&library, "anima/ballsdeep-anima-v1f-re.safetensors")
                .expect("name form")
                .name,
            found.name
        );
        let error = resolve_lora(&anima_library(), "a1b2c3d4e5f6").unwrap_err();
        assert_eq!(reason(&error), "bodyInvalid", "a model is not a lora");
    }

    /// The shared lookup law extends the full-sha arm to EVERY reference surface
    /// (queue model reference, identity doors): a checkpoint resolves by its exact
    /// 64-hex digest too; an unknown 64-hex stays the honest scan posture.
    #[test]
    fn full_sha256_resolves_a_checkpoint_reference_too() {
        let sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
        let mut library = anima_library();
        library[0].sha256 = Some(sha.to_owned());
        let resolved = resolve(&library, sha, None).expect("exact digest");
        assert_eq!(resolved.checkpoint, "anima.safetensors");
        let error = resolve(
            &library,
            "0f3e2d1c4b5a6978a7b6c5d4e3f20189abcdef00112233445566778899aabbcc",
            None,
        )
        .unwrap_err();
        assert_eq!(reason(&error), "libraryScanRequired");
    }

    #[test]
    fn turbo_variant_law_follows_builtin_variants() {
        assert_eq!(
            turbo_variant("qwen-image-2.1").as_deref(),
            Some("qwen-image-2.1-turbo")
        );
        assert_eq!(turbo_variant("anima"), None);
        let sigmas = turbo_sigmas("qwen-image-2.1-turbo").expect("fixed sigmas");
        assert!(sigmas.as_array().is_some_and(|list| list.len() > 4));
        assert!(turbo_sigmas("anima").is_none());
    }

    #[test]
    fn turbo_grammar_accepts_true_and_shorthand_only() {
        assert!(parse_turbo(&json!(true)).expect("true"));
        assert!(parse_turbo(&json!("--turbo")).expect("shorthand"));
        assert!(!parse_turbo(&json!(false)).expect("false"));
        assert_eq!(
            reason(&parse_turbo(&json!("turbo")).unwrap_err()),
            "bodyInvalid"
        );
    }

    /// The shared lookup law both the queue door and the identity doors read: several
    /// entries under one reference is the ONE `familyAmbiguous` word naming every
    /// candidate, and an empty answer is an honest empty — never an invented refusal.
    #[test]
    fn matching_entries_names_every_candidate_and_never_invents_a_miss() {
        let mut second = entry(
            "checkpoints",
            "anima.safetensors",
            Some("ffee00001111222233334444"),
        );
        second.detected_family = Some("flux".to_owned());
        let library = vec![
            entry(
                "diffusion_models",
                "anima.safetensors",
                Some("a1b2c3d4e5f60718"),
            ),
            second,
        ];
        let error = matching_entries(&library, "anima.safetensors").unwrap_err();
        assert_eq!(reason(&error), "familyAmbiguous");
        let hint = hint(&error);
        assert!(
            hint.contains("anima.safetensors (checkpoints)")
                && hint.contains("anima.safetensors (diffusion_models)"),
            "{hint}"
        );
        assert!(matching_entries(&library, "nothing.here")
            .expect("a miss is empty")
            .is_empty());
        assert_eq!(
            matching_entries(&library, "ffee00001111").expect("handle form")[0].category,
            "checkpoints"
        );
    }

    /// Writes one sparse SAFETENSORS file: a real header plus a payload sized by
    /// `set_len`, the exact idiom the stock component-signature tests use
    /// (`model_families.rs:1039` `write` + `:1659` `component_file`), so the stock header
    /// reader and its `valid_tensors` offset law both run without allocating weights.
    fn safetensors_file(dir: &std::path::Path, name: &str, tensors: &[(&str, &[u64])]) -> PathBuf {
        let mut head = serde_json::Map::new();
        let mut end = 0u64;
        for (key, shape) in tensors {
            let start = end;
            end += shape.iter().product::<u64>() * 2;
            head.insert(
                (*key).to_owned(),
                json!({"dtype": "BF16", "shape": shape, "data_offsets": [start, end]}),
            );
        }
        let header = serde_json::to_vec(&head).expect("header bytes");
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("safetensors file");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("reopen for the sparse payload");
        file.set_len(file.metadata().expect("metadata").len() + end)
            .expect("sparse payload");
        path
    }

    /// Publishes a STALE snapshot over `roots` in the stock serialized shape: the two files
    /// exist and are listed, but no component word is stored — the posture of an index
    /// written before the classifier knew the architecture. The file name is the stock
    /// reader's own law (`models-` plus the SHA-256 of the serialized roots array) and
    /// `detector` must equal the package version, exactly what `read_any` compares.
    fn stale_snapshot(index_dir: &std::path::Path, roots: &[PathBuf], records: &[Value]) {
        use sha2::Digest as _;
        let key = format!(
            "{:x}",
            sha2::Sha256::digest(serde_json::to_vec(roots).expect("roots"))
        );
        let index = json!({
            "schema": crate::downloads::models::index::SCHEMA,
            "detector": env!("CARGO_PKG_VERSION"),
            "roots": roots,
            "records": records,
        });
        std::fs::write(
            index_dir.join(format!("models-{key}.json")),
            serde_json::to_vec(&index).expect("index bytes"),
        )
        .expect("index file");
    }

    /// AF2-M27 — the rescan seam's own proof, and the trio-stamp proof the door exists for.
    /// Over a real (tiny) saved folder: the cheap `refresh:false` reader serves the stale
    /// snapshot it is given and NEVER repairs it; `refresh_index` runs the stock rebuild and
    /// counts the rebuilt snapshot; the `refresh:false` reader then serves the component
    /// word an h3.video split-loader row resolves against (`h3_video_vae`, stamped by
    /// `detect_component` from the file header during the walk); and a second refresh is a
    /// successful cached-stamp pass, so the door can be called again honestly.
    #[test]
    fn the_rescan_seam_recomputes_the_snapshot_and_the_component_stamp() {
        let fixture = tempfile::tempdir().expect("fixture");
        let root = fixture.path().join("models");
        let index_dir = fixture.path().join("index");
        std::fs::create_dir_all(root.join("checkpoints")).expect("checkpoints folder");
        std::fs::create_dir_all(root.join("vae")).expect("vae folder");
        std::fs::create_dir_all(&index_dir).expect("index dir");
        std::fs::write(root.join("checkpoints/one.pt"), b"fixture").expect("checkpoint file");
        // The H3 video VAE signature as measured from the MiniMax H3 package — the same
        // tensors `model_families::h3_component_signatures_match_measured_package_files`
        // pins — so the walk's detect_component stamps this file.
        let video: &[(&str, &[u64])] = &[
            ("encoder.conv_in.weight", &[128, 3, 3, 3, 3]),
            ("encoder.conv_out.weight", &[48, 1024, 3, 3, 3]),
            ("decoder.transformer_blocks.0.ff.w1.weight", &[16384, 2048]),
        ];
        safetensors_file(
            &root.join("vae"),
            "minimax_h3_video_vae_fp16.safetensors",
            video,
        );
        let roots = vec![root.clone()];
        let listed = |name: &str, category: &str| {
            json!({
                "stamp": null,
                "model": {
                    "category": category,
                    "name": name,
                    "path": root.join(category).join(name).to_string_lossy(),
                    "size": 4096,
                    "info": null,
                    "component": null,
                }
            })
        };
        stale_snapshot(
            &index_dir,
            &roots,
            &[
                listed("one.pt", "checkpoints"),
                listed("minimax_h3_video_vae_fp16.safetensors", "vae"),
            ],
        );
        let source = IndexSource {
            index_dir: index_dir.clone(),
            roots: roots.clone(),
        };
        let component_of = |name: &str| {
            load_index(&source)
                .expect("a published snapshot is readable")
                .into_iter()
                .find(|entry| entry.name == name)
                .expect("the listed entry")
                .component
        };
        // THE READ NEVER REPAIRS: the stale snapshot stays stale through any number of
        // cheap reads — the exact dead end that made the rescan door necessary.
        assert_eq!(
            component_of("minimax_h3_video_vae_fp16.safetensors"),
            None,
            "a read cannot invent a stamp"
        );
        // The door's seam: the stock rebuild over the saved folders, entry count reported.
        assert_eq!(
            refresh_index(&source).expect("refresh"),
            2,
            "both files listed"
        );
        // And the fresh snapshot now carries the stamp the resolver's component-slot proof
        // reads — served by the untouched `refresh:false` reader.
        assert_eq!(
            component_of("minimax_h3_video_vae_fp16.safetensors"),
            Some("h3_video_vae".to_owned()),
            "the header walk stamped the component"
        );
        // A second refresh is honest too: the cached-stamp fast path reuses the unchanged
        // records and still answers the same count.
        assert_eq!(refresh_index(&source).expect("second refresh"), 2);
        assert_eq!(
            component_of("minimax_h3_video_vae_fp16.safetensors"),
            Some("h3_video_vae".to_owned()),
            "the stamp survives the cached pass"
        );
    }
}
