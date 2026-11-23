//! The defaults sheet plane (API-DESIGN §6): `deas-agent-defaults.json` in app-data.
//!
//! The sheet is the operator-configurable generation-defaults plane that fixes the old
//! `notShipped` hole. It is keyed per `family:mode` combo over a closed vocabulary: a
//! malformed key, an unknown family id or an unknown dial key is refused with the
//! offending key named — never silently dropped, never silently repaired.
//!
//! The §6 merge ladder is a pure function over owned inputs: request > sheet combo >
//! sheet family > sheet global > stock `builtin.json` per-family defaults > hard floors.
//! The stock tier reads the same embedded `src/families/builtin.json` the stock family
//! detection reads; `builtin.json` diffed zero bytes at v0.3.14, so the seed is stable.
//!
//! Writes are atomic (staging file + rename) and serialized: one process-wide gate
//! spans each load-merge-write critical section, and the staging name is unique per
//! write (LEG AF2-M18b B2), so two writers in one process can neither lose each
//! other's merge nor share one staging path. A corrupt sheet file fails closed: readers
//! get the refusal text, and nothing rewrites the file behind the operator's back.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// File name of the defaults sheet, in app-data.
pub(crate) const FILE: &str = "deas-agent-defaults.json";

/// The only sheet schema version this build understands (API-DESIGN §6).
pub(crate) const SHEET_VERSION: u32 = 2;

/// The closed mode vocabulary (API-DESIGN §3: MODE = the job the model runs).
///
/// Combo keys and preview queries are validated against exactly this list. LEG
/// M9c grew it from nine words to twelve: the video recipes' three stock pipeline
/// forms (`t2v` / `i2v` / `v2v`, the `video-generation` arm's t2v/i2v/v2v shapes)
/// are first-class mode words beside the generic `video` word. LEG M9e grew it to
/// thirteen with `t2m`, the music recipe's own pipeline word (the stock music
/// `mode` field's word); `cover` stays out — it is that intent's second `mode`
/// word, reached by sending an audio reference, not a door word. RefMod CREATION
/// is not a mode word at all: it is its own door (`POST /v1/refmods`).
/// `fill_plane::MODE_SPECS` is the compile-side mirror — every word here has exactly
/// one row there.
pub(crate) const MODES: [&str; 13] = [
    "t2i", "i2i", "inpaint", "refine", "upscale", "refmod", "ref2va", "video", "music", "t2v",
    "i2v", "v2v", "t2m",
];

/// `src/families/builtin.json` embedded once; the stock tier, the family allowlist and
/// the `stock` view all read this single home (same pattern the stock `model_families`
/// module uses for the same data-only plugin).
const BUILTIN_JSON: &str = include_str!("../../../src/families/builtin.json");

/// One block of dial overrides: every field optional, null/absent means "fall through".
///
/// Unknown keys are refused at parse time (`deny_unknown_fields`), naming the key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(crate) struct Dials {
    /// `"random"` or `"fixed"`; opaque here, expanded by the queue-door resolver (M5+).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) seed_mode: Option<String>,
    /// `"png"` or `"webp"` (intent schema, §SR8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) image_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) steps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cfg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sampler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scheduler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) negative_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) denoise: Option<f64>,
    /// Attention/sage/cache/compile/vaeTile bag (§SR8), kept as an opaque object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) options: Option<Value>,
}

impl Dials {
    /// Collects value-domain problems into `problems`, each naming its key.
    fn validate(&self, block: &str, problems: &mut Vec<String>) {
        if self.steps == Some(0) {
            problems.push(format!("{block}.steps must be greater than 0"));
        }
        if self.width == Some(0) {
            problems.push(format!("{block}.width must be greater than 0"));
        }
        if self.height == Some(0) {
            problems.push(format!("{block}.height must be greater than 0"));
        }
        if self
            .cfg
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            problems.push(format!("{block}.cfg must be a finite non-negative number"));
        }
        if self
            .denoise
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            problems.push(format!("{block}.denoise must be between 0.0 and 1.0"));
        }
        if let Some(format) = &self.image_format {
            if !matches!(format.as_str(), "png" | "webp") {
                problems.push(format!(
                    "{block}.imageFormat '{format}' is outside the closed vocabulary png|webp"
                ));
            }
        }
        if self.seed_mode.as_deref() == Some("") {
            problems.push(format!("{block}.seedMode must not be empty when present"));
        }
        if self
            .options
            .as_ref()
            .is_some_and(|value| !value.is_object())
        {
            problems.push(format!(
                "{block}.options must be a JSON object when present"
            ));
        }
        if self.sampler.as_deref() == Some("") {
            problems.push(format!("{block}.sampler must not be empty when present"));
        }
        if self.scheduler.as_deref() == Some("") {
            problems.push(format!("{block}.scheduler must not be empty when present"));
        }
    }
}

/// The whole sheet: one global block, per-family blocks, per-family:mode combos.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(crate) struct DefaultsSheet {
    /// Schema version; only [`SHEET_VERSION`] is understood.
    pub(crate) version: u32,
    /// Lowest sheet tier: applies unless combo/family blocks supply the field.
    pub(crate) global: Dials,
    /// Mid sheet tier, keyed by family id (must be a `builtin.json` id).
    pub(crate) families: BTreeMap<String, Dials>,
    /// Highest sheet tier, keyed by `family:mode` (closed vocabulary).
    pub(crate) combos: BTreeMap<String, Dials>,
}

impl Default for DefaultsSheet {
    fn default() -> Self {
        Self {
            version: SHEET_VERSION,
            global: Dials::default(),
            families: BTreeMap::new(),
            combos: BTreeMap::new(),
        }
    }
}

/// Reads the sheet from app-data.
///
/// Returns `Ok(None)` when the file is absent (the ladder then runs on stock + floors),
/// and `Err` with the refused key or JSON problem named when the file exists but cannot
/// be trusted. A corrupt file is never repaired on read.
///
/// # Errors
///
/// Reports the parse or validation failure naming the offending block, key or path.
pub(crate) fn load(app_data: &Path) -> Result<Option<DefaultsSheet>, String> {
    let path = app_data.join(FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let sheet: DefaultsSheet = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    validate_sheet(&sheet).map_err(|problem| format!("validate {}: {problem}", path.display()))?;
    Ok(Some(sheet))
}

/// The atomic write leg: staging file in app-data, then rename over the target.
///
/// The sheet is re-validated before anything touches the filesystem, so a half-built
/// sheet can never land, and the staging name carries a per-process sequence so two
/// writers in one process can never name the same staging file (LEG AF2-M18b B2).
///
/// THE SHEET GATE IS NOT TAKEN HERE. Every mutating call site runs inside
/// [`merge_write`] / [`merge_preview`], which hold [`WRITE_GATE`] across the whole
/// load-merge-write; a caller outside a critical section must go through one of those,
/// never this leg, or the serialization this module exists to provide is gone.
///
/// # Errors
///
/// Reports serialization, staging-write or rename failure with the path involved.
pub(crate) fn write(app_data: &Path, sheet: &DefaultsSheet) -> Result<(), String> {
    validate_sheet(sheet).map_err(|problem| format!("refuse write: {problem}"))?;
    let path = app_data.join(FILE);
    let staging = staging_name(&path);
    let bytes =
        serde_json::to_vec_pretty(sheet).map_err(|error| format!("serialize {FILE}: {error}"))?;
    let result = std::fs::write(&staging, &bytes)
        .map_err(|error| format!("write {}: {error}", staging.display()))
        .and_then(|()| {
            std::fs::rename(&staging, &path)
                .map_err(|error| format!("rename onto {}: {error}", path.display()))
        });
    if result.is_err() {
        // Best-effort cleanup of the staging file; the target keeps its previous bytes.
        let _ = std::fs::remove_file(&staging);
    }
    result
}

/// The process-wide defaults-sheet write gate (LEG AF2-M18b B2).
///
/// A sheet write is a read-modify-write sequence: read the bytes, merge, validate,
/// stage, rename. Two writers racing across that sequence lose each other's merge (both
/// loaded the same sheet, the later rename wins), and the staging name is per-PROCESS
/// (`{FILE}.{pid}.tmp`), so two writers inside one process — the two Control permits, or
/// the route and the native `defaults_write` bridge — share ONE staging path and can
/// tear each other's bytes. The gate spans the whole critical section, so the plane has
/// exactly one mutating sheet path at a time.
///
/// It is a plain [`Mutex`]: the critical sections that hold it call this module's write
/// leg directly (never a second gate-taking entry point), so no reentrancy is needed and
/// a caller that tried to nest one would deadlock loudly instead of silently losing the
/// serialization. Cross-thread exclusion is the whole point.
///
/// A poisoned gate is recovered, not propagated: the write leg lands by rename, so a
/// panicking writer cannot have left half-written sheet bytes, and the gate carries no
/// state beyond ordering.
static WRITE_GATE: Mutex<()> = Mutex::new(());

/// Takes the sheet gate for the duration of one critical section.
fn lock_sheet_gate() -> MutexGuard<'static, ()> {
    WRITE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The staging name for one write: process id plus a per-process sequence number, so
/// two writers in one process can never name the same staging file even momentarily
/// (the pid alone could, which is the torn-write half of LEG AF2-M18b B2).
fn staging_name(path: &Path) -> std::path::PathBuf {
    static STAGING_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let sequence = STAGING_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.with_file_name(format!("{FILE}.{}.{sequence}.tmp", std::process::id()))
}

/// Which leg of the load-merge-write section refused. The three legs carry different
/// refusal text at every call site, so the discriminant is part of the contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SheetProblem {
    /// The existing sheet is unreadable or unparseable: fail closed, bytes untouched.
    Load(String),
    /// The caller's merge or the dial validation refused; nothing was written.
    Merge(String),
    /// The atomic write failed; the previous bytes stay authoritative.
    Write(String),
}

/// What one critical section produced: the sheet as found and as merged.
pub(crate) struct MergeOutcome {
    /// The sheet the section read (`Default` when the file is absent).
    pub(crate) before: DefaultsSheet,
    /// The merged sheet — what a write leg put on disk.
    pub(crate) after: DefaultsSheet,
}

/// One serialized load-merge-write: the gate spans the read, the merge and the atomic
/// write, so no second writer can interleave anywhere in the sequence. `merge` mutates a
/// clone of the loaded sheet and refuses by returning `Err(problem)` naming what it
/// refused; a refused merge writes nothing.
///
/// This is the ONLY mutating home for the sheet: `POST /v1/defaults` ([`super::routes`])
/// and the native `defaults_write` bridge ([`super::settings_bridge`]) both run through
/// here, and neither touches the file by hand.
///
/// # Errors
///
/// [`SheetProblem::Load`] for unreadable or unparseable existing bytes,
/// [`SheetProblem::Merge`] for the caller's own refusal, [`SheetProblem::Write`] for a
/// staging or rename failure.
pub(crate) fn merge_write<F>(app_data: &Path, merge: F) -> Result<MergeOutcome, SheetProblem>
where
    F: FnOnce(&mut DefaultsSheet) -> Result<(), String>,
{
    let _gate = lock_sheet_gate();
    let outcome = load_merge(app_data, merge)?;
    write(app_data, &outcome.after).map_err(SheetProblem::Write)?;
    Ok(outcome)
}

/// The read-only twin of [`merge_write`]: the same gate, no write leg. The native
/// bridge's preview answer (`confirm` not literally true) reads and merges under the
/// gate so its before/after snapshot can never straddle a concurrent write.
///
/// # Errors
///
/// [`SheetProblem::Load`] or [`SheetProblem::Merge`]; a preview never reaches
/// [`SheetProblem::Write`].
pub(crate) fn merge_preview<F>(app_data: &Path, merge: F) -> Result<MergeOutcome, SheetProblem>
where
    F: FnOnce(&mut DefaultsSheet) -> Result<(), String>,
{
    let _gate = lock_sheet_gate();
    load_merge(app_data, merge)
}

/// The shared half of both critical sections; the caller holds the gate.
fn load_merge<F>(app_data: &Path, merge: F) -> Result<MergeOutcome, SheetProblem>
where
    F: FnOnce(&mut DefaultsSheet) -> Result<(), String>,
{
    let before = load(app_data)
        .map_err(SheetProblem::Load)?
        .unwrap_or_default();
    let mut after = before.clone();
    merge(&mut after).map_err(SheetProblem::Merge)?;
    Ok(MergeOutcome { before, after })
}

/// Validates the whole sheet: version, every key, every dial value.
fn validate_sheet(sheet: &DefaultsSheet) -> Result<(), String> {
    let mut problems: Vec<String> = Vec::new();
    if sheet.version != SHEET_VERSION {
        problems.push(format!(
            "version {} is not supported (expected {SHEET_VERSION})",
            sheet.version
        ));
    }
    sheet.global.validate("global", &mut problems);
    for (family, dials) in &sheet.families {
        if !is_known_family(family) {
            problems.push(format!("families key '{family}' is not a known family id"));
        }
        dials.validate(&format!("families.{family}"), &mut problems);
    }
    for (key, dials) in &sheet.combos {
        match parse_combo_key(key) {
            Ok((family, mode)) => {
                if !is_known_family(family) {
                    problems.push(format!(
                        "combos key '{key}': family '{family}' is not a known family id"
                    ));
                }
                if !MODES.contains(&mode) {
                    problems.push(format!(
                        "combos key '{key}': mode '{mode}' is outside the closed vocabulary {}",
                        MODES.join("|")
                    ));
                }
            }
            Err(problem) => problems.push(problem),
        }
        dials.validate(&format!("combos.{key}"), &mut problems);
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// Splits a combo key into `(family, mode)`; anything without exactly one colon is
/// malformed and refused with the key named.
pub(crate) fn parse_combo_key(key: &str) -> Result<(&str, &str), String> {
    let mut parts = key.split(':');
    let family = parts.next().unwrap_or_default();
    let mode = parts.next().unwrap_or_default();
    if parts.next().is_some() || family.is_empty() || mode.is_empty() {
        return Err(format!(
            "combo key '{key}' is malformed: expected 'family:mode' with both parts non-empty"
        ));
    }
    Ok((family, mode))
}

/// One stock family entry as the defaults plane reads it (a data-only subset of the
/// same `builtin.json` the stock `model_families` module parses for detection).
#[derive(Deserialize)]
struct BuiltinFamily {
    id: String,
    #[serde(default)]
    defaults: BuiltinDefaults,
    /// `"checkpoint"` (self-contained loader) or `"diffusion"` (split text encoder + VAE).
    #[serde(default)]
    loader: Option<String>,
    /// The stock pipeline words this family declares (`t2i`, `i2i`, `t2v`, `ref2v`, `t2m`…).
    #[serde(default)]
    pipelines: Vec<String>,
    /// The `music` compile profile of the ACE-Step rows (LEG M14b): the latent clocks
    /// and per-family seeds the stock `jobs_music_ace` arm and the stock Workbench
    /// both read. `None` for every family that carries no such block.
    #[serde(default)]
    music: Option<MusicProfile>,
}

/// The `music` block of a `builtin.json` family row (the ACE-Step recipe profile).
/// Field names ride the sheet's camelCase verbatim.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicProfile {
    /// `"1.0"` (all-in-one checkpoint) or `"1.5"` (split UNET/DualCLIP/VAE loaders).
    pub(crate) version: String,
    pub(crate) steps: u64,
    pub(crate) cfg: f64,
    pub(crate) sampler: String,
    pub(crate) scheduler: String,
    /// The model-sampling shift; it rides the intent's `ace{}` block, not the ladder.
    pub(crate) shift: f64,
    pub(crate) sample_rate: f64,
    pub(crate) samples_per_latent: f64,
}

/// The per-family `defaults` block of `builtin.json` (§SR7): the seed of the ladder.
#[derive(Default, Deserialize)]
struct BuiltinDefaults {
    width: Option<u32>,
    height: Option<u32>,
    steps: Option<u64>,
    cfg: Option<f64>,
    sampler: Option<String>,
    scheduler: Option<String>,
    negative: Option<String>,
}

impl BuiltinDefaults {
    /// True when the row carries no `defaults` block at all — the ACE-Step shape,
    /// whose stock tier comes from its `music` profile instead (LEG M14b).
    fn is_empty(&self) -> bool {
        self.width.is_none()
            && self.height.is_none()
            && self.steps.is_none()
            && self.cfg.is_none()
            && self.sampler.is_none()
            && self.scheduler.is_none()
            && self.negative.is_none()
    }

    /// Re-keys the stock block into the sheet vocabulary (`negative` -> `negativePrompt`).
    fn to_dials(&self) -> Dials {
        Dials {
            width: self.width,
            height: self.height,
            steps: self.steps,
            cfg: self.cfg,
            sampler: self.sampler.clone(),
            scheduler: self.scheduler.clone(),
            negative_prompt: self.negative.clone(),
            ..Dials::default()
        }
    }
}

impl MusicProfile {
    /// Re-keys the profile into the sheet vocabulary: the four dials the ladder
    /// resolves. `shift` belongs to the `ace{}` block (fill_plane owns it), and the
    /// latent clocks belong to the duration law, so neither rides the ladder.
    fn to_dials(&self) -> Dials {
        Dials {
            steps: Some(self.steps),
            cfg: Some(self.cfg),
            sampler: Some(self.sampler.clone()),
            scheduler: Some(self.scheduler.clone()),
            ..Dials::default()
        }
    }
}

/// The embedded `builtin.json` parsed once for the defaults plane.
fn builtin_families() -> &'static [BuiltinFamily] {
    static FAMILIES: OnceLock<Vec<BuiltinFamily>> = OnceLock::new();
    FAMILIES
        .get_or_init(|| serde_json::from_str(BUILTIN_JSON).expect("bundled family plugin is valid"))
}

/// True when `id` is one of the 42 builtin family ids: the single family allowlist.
pub(crate) fn is_known_family(id: &str) -> bool {
    builtin_families().iter().any(|family| family.id == id)
}

/// The stock per-family defaults as a dial block (`None` for a family id outside the
/// plugin). A row that carries no `defaults` block seeds its stock tier from its
/// `music` profile instead — the ACE-Step rows (LEG M14b) declare none, and the stock
/// Workbench seeds their controls from exactly that block.
pub(crate) fn builtin_defaults(family: &str) -> Option<Dials> {
    builtin_families()
        .iter()
        .find(|entry| entry.id == family)
        .map(|entry| {
            if entry.defaults.is_empty() {
                entry
                    .music
                    .as_ref()
                    .map_or_else(Dials::default, MusicProfile::to_dials)
            } else {
                entry.defaults.to_dials()
            }
        })
}

/// The stock `music` compile profile of a family — the ACE-Step latent clocks and
/// per-family seeds — `None` for every family without one (LEG M14b: the music arm
/// reads this for the ACE-Step arm's duration grid and block seeds).
pub(crate) fn builtin_music_profile(family: &str) -> Option<&'static MusicProfile> {
    builtin_families()
        .iter()
        .find(|entry| entry.id == family)
        .and_then(|entry| entry.music.as_ref())
}

/// The stock loader law for a family: `"diffusion"` families need split text-encoder/VAE
/// components in the intent, `"checkpoint"` families carry one self-contained file.
/// `None` for a family id outside the bundled plugin.
pub(crate) fn builtin_loader(family: &str) -> Option<&'static str> {
    builtin_families()
        .iter()
        .find(|entry| entry.id == family)
        .and_then(|entry| entry.loader.as_deref())
}

/// The `pipelines` words a family declares; empty for an unknown id or a family that
/// declares none. The fill plane's mode table reads this single home.
pub(crate) fn builtin_pipelines(family: &str) -> &'static [String] {
    builtin_families()
        .iter()
        .find(|entry| entry.id == family)
        .map(|entry| entry.pipelines.as_slice())
        .unwrap_or(&[])
}

/// `builtin.json` verbatim as a parsed value: the `stock` view of `GET /v1/defaults`
/// (§6 exposure law), parsed once and cloned per response.
pub(crate) fn builtin_view() -> &'static Value {
    static VIEW: OnceLock<Value> = OnceLock::new();
    VIEW.get_or_init(|| serde_json::from_str(BUILTIN_JSON).expect("bundled family plugin is valid"))
}

/// Which ladder tier supplied a resolved field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    /// The request body (the user "specified intent").
    Request,
    /// Sheet combo block (`family:mode`).
    Combo,
    /// Sheet family block.
    Family,
    /// Sheet global block.
    Global,
    /// Stock `builtin.json` per-family defaults.
    Stock,
    /// Hard floor (seed=random, format=png, batch=1, compression=44; §6.5).
    Floor,
    /// No tier supplied a value; the queue-door resolver or compile validation owns it.
    Unsupplied,
}

impl Tier {
    /// The preview source word (camelCase, §6 per-field source tags).
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Combo => "combo",
            Self::Family => "family",
            Self::Global => "global",
            Self::Stock => "stock",
            Self::Floor => "floor",
            Self::Unsupplied => "none",
        }
    }
}

/// One resolved preview field: the dial name, the winning tier and the value.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedField {
    /// Dial name in sheet vocabulary.
    pub(crate) field: &'static str,
    /// The tier that supplied the value (`none` when no tier did).
    pub(crate) source: &'static str,
    /// The resolved value; `null` when no tier supplied one.
    pub(crate) value: Value,
}

/// Dial accessor: name-side getter into any [`Dials`] block.
type DialAccessor = fn(&Dials) -> Option<Value>;

/// Dial accessors in preview order: name plus a getter into any [`Dials`] block.
const DIAL_FIELDS: [(&str, DialAccessor); 11] = [
    ("seedMode", |d| d.seed_mode.clone().map(Value::String)),
    ("imageFormat", |d| d.image_format.clone().map(Value::String)),
    ("steps", |d| d.steps.map(|v| json!(v))),
    ("cfg", |d| d.cfg.map(|v| json!(v))),
    ("sampler", |d| d.sampler.clone().map(Value::String)),
    ("scheduler", |d| d.scheduler.clone().map(Value::String)),
    ("width", |d| d.width.map(|v| json!(v))),
    ("height", |d| d.height.map(|v| json!(v))),
    ("negativePrompt", |d| {
        d.negative_prompt.clone().map(Value::String)
    }),
    ("denoise", |d| d.denoise.map(|v| json!(v))),
    ("options", |d| d.options.clone()),
];

/// The dial names in preview order: the sheet vocabulary. A test pins it against
/// [`DIAL_FIELDS`] so the two can never drift apart.
pub(crate) const DIAL_NAMES: [&str; 11] = [
    "seedMode",
    "imageFormat",
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "width",
    "height",
    "negativePrompt",
    "denoise",
    "options",
];

/// The §6.5 hard floors for dial fields; non-dial floors are appended by [`resolve`].
fn floor_value(field: &str) -> Option<Value> {
    match field {
        "seedMode" => Some(json!("random")),
        "imageFormat" => Some(json!("png")),
        _ => None,
    }
}

/// Applies one `POST /v1/defaults` patch onto a dial block (three-state merge):
/// key present with a value sets the dial, key present with `null` clears it (back to
/// fall-through), key absent keeps the current value. Unknown keys and mistyped values
/// are refused with the key named; the target is left consistent but callers must not
/// persist a failed patch.
///
/// # Errors
///
/// Names the offending dial key with the reason an agent can act on.
pub(crate) fn apply_patch(
    patch: &serde_json::Map<String, Value>,
    target: &mut Dials,
) -> Result<(), String> {
    for (key, value) in patch {
        // `String` dials share one reader; numeric dials share the typed reader.
        match key.as_str() {
            "seedMode" => target.seed_mode = optional_string(key, value)?,
            "imageFormat" => target.image_format = optional_string(key, value)?,
            "sampler" => target.sampler = optional_string(key, value)?,
            "scheduler" => target.scheduler = optional_string(key, value)?,
            "negativePrompt" => target.negative_prompt = optional_string(key, value)?,
            "steps" => target.steps = optional_typed(key, value)?,
            "width" => target.width = optional_typed(key, value)?,
            "height" => target.height = optional_typed(key, value)?,
            "cfg" => target.cfg = optional_typed(key, value)?,
            "denoise" => target.denoise = optional_typed(key, value)?,
            "options" => {
                target.options = match value {
                    Value::Null => None,
                    Value::Object(_) => Some(value.clone()),
                    _ => return Err(format!("dials.{key} must be a JSON object or null")),
                };
            }
            other => {
                return Err(format!(
                    "dials.{other} is not a dial key; the closed set is seedMode, imageFormat, \
                     steps, cfg, sampler, scheduler, width, height, negativePrompt, denoise, options"
                ));
            }
        }
    }
    // The sheet canvas law (P8): guard the MERGED stored pair, so a patch carrying
    // one edge is measured against the other edge already on the sheet.
    check_dial_canvas(target)
}

/// The sheet's share of the canvas law (the resolution-sanity ruling): a stored
/// width/height becomes the canvas of every dial-free row of its scope, so the
/// POST door validates it with the SAME numbers the render arms enforce
/// (`crate::jobs::canvas_edge_ok` / `canvas_pixels_ok`: edge 8..=8192 aligned to
/// 8, product 16.7M). `null` (clear) and absent (keep) stay legal — this wall
/// guards stored VALUES only; the three-state merge itself is untouched. Without
/// it a live-proven `width: 30000` poisoned every dial-free row of its family:mode
/// scope until an operator cleared the sheet.
fn check_dial_canvas(target: &Dials) -> Result<(), String> {
    for key in ["width", "height"] {
        let stored = if key == "width" {
            target.width
        } else {
            target.height
        };
        let Some(value) = stored else { continue };
        if !crate::jobs::canvas_edge_ok(u64::from(value)) {
            return Err(format!(
                "dials.{key} {value} breaks the canvas law: a stored dial dimension must be an integer 8..=8192 aligned to 8 (null clears the dial, omitting it keeps the current value)"
            ));
        }
    }
    if let (Some(width), Some(height)) = (target.width, target.height) {
        if !crate::jobs::canvas_pixels_ok(u64::from(width), u64::from(height)) {
            return Err(format!(
                "dials.width x dials.height ({width} x {height}) exceeds the 16.7M pixel canvas law (the stock pixel limit the render arms enforce)"
            ));
        }
    }
    Ok(())
}

/// A patch value for a string dial: `null` clears, a string sets, anything else refuses.
fn optional_string(key: &str, value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(format!("dials.{key} must be a string or null")),
    }
}

/// A patch value for a typed dial: `null` clears, else serde's typed parse must fit.
fn optional_typed<T: serde::de::DeserializeOwned>(
    key: &str,
    value: &Value,
) -> Result<Option<T>, String> {
    match value {
        Value::Null => Ok(None),
        _ => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| format!("dials.{key} does not match the dial's type")),
    }
}

/// Validates one dial block outside the sheet context (POST merge preview).
///
/// # Errors
///
/// Joins every value problem, each naming its key.
pub(crate) fn validate_dials(block: &str, dials: &Dials) -> Result<(), String> {
    let mut problems = Vec::new();
    dials.validate(block, &mut problems);
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// The §6 merge ladder, per field, most specific tier wins.
///
/// Pure over in-memory inputs: no filesystem, no process state. `family`/`mode` select
/// the combo, family and stock tiers; both `None` means the plane-level ladder (sheet
/// global + floors only), which the preview labels honestly. `request` is the tier-1
/// block: `None` models a bare request (the resolved preview case).
pub(crate) fn resolve(
    family: Option<&str>,
    mode: Option<&str>,
    request: Option<&Dials>,
    sheet: &DefaultsSheet,
) -> Vec<ResolvedField> {
    let combo = match (family, mode) {
        (Some(family), Some(mode)) => sheet.combos.get(&format!("{family}:{mode}")),
        _ => None,
    };
    let family_block = family.and_then(|family| sheet.families.get(family));
    let stock = family.and_then(builtin_defaults);
    let tiers: [(Tier, Option<&Dials>); 5] = [
        (Tier::Request, request),
        (Tier::Combo, combo),
        (Tier::Family, family_block),
        (Tier::Global, Some(&sheet.global)),
        (Tier::Stock, stock.as_ref()),
    ];
    let mut fields = Vec::with_capacity(DIAL_FIELDS.len() + 2);
    for (name, get) in DIAL_FIELDS {
        let hit = tiers
            .iter()
            .find_map(|(tier, block)| block.and_then(get).map(|value| (*tier, value)));
        let (source, value) = match hit {
            Some((tier, value)) => (tier.word(), value),
            None => match floor_value(name) {
                Some(value) => (Tier::Floor.word(), value),
                None => (Tier::Unsupplied.word(), Value::Null),
            },
        };
        fields.push(ResolvedField {
            field: name,
            source,
            value,
        });
    }
    // Non-dial floors (§6.5): batch is fixed 1 stock-side, compression defaults 44.
    fields.push(ResolvedField {
        field: "batch",
        source: Tier::Floor.word(),
        value: json!(1),
    });
    fields.push(ResolvedField {
        field: "imageCompression",
        source: Tier::Floor.word(),
        value: json!(44),
    });
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dial_names_match_the_accessor_table() {
        let built: Vec<&str> = DIAL_FIELDS.iter().map(|(name, _)| *name).collect();
        assert_eq!(built, DIAL_NAMES.to_vec());
    }

    fn write_fixture(dir: &Path, text: &str) {
        std::fs::write(dir.join(FILE), text).expect("test fixture writes the sheet");
    }

    #[test]
    fn absent_sheet_is_none_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(load(dir.path()).expect("absent is not an error"), None);
    }

    #[test]
    fn valid_sheet_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(
            dir.path(),
            r#"{"version": 2,
                "global": { "seedMode": "random", "imageFormat": "png" },
                "families": { "anima": { "steps": 30, "cfg": 4 } },
                "combos": { "anima:t2i": { "steps": 35 }, "minimax-h3:ref2va": { "steps": 12 } }}"#,
        );
        let sheet = load(dir.path()).expect("valid").expect("present");
        assert_eq!(sheet.version, SHEET_VERSION);
        assert_eq!(sheet.combos["anima:t2i"].steps, Some(35));
        assert_eq!(sheet.families["anima"].cfg, Some(4.0));
        assert_eq!(sheet.global.seed_mode.as_deref(), Some("random"));
    }

    #[test]
    fn corrupt_sheet_fails_closed_and_names_the_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(dir.path(), "{ not json");
        let problem = load(dir.path()).expect_err("corrupt is refused");
        assert!(problem.contains(FILE), "problem names the file: {problem}");
        // Never silently repaired: the bytes are untouched.
        let on_disk = std::fs::read_to_string(dir.path().join(FILE)).expect("still there");
        assert_eq!(on_disk, "{ not json");
    }

    #[test]
    fn unknown_dial_key_is_refused_naming_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(
            dir.path(),
            r#"{"version": 2, "combos": { "anima:t2i": { "stps": 35 } }}"#,
        );
        let problem = load(dir.path()).expect_err("unknown dial refused");
        assert!(problem.contains("stps"), "problem names the key: {problem}");
    }

    #[test]
    fn unknown_top_level_block_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(dir.path(), r#"{"version": 2, "comboz": {}}"#);
        assert!(load(dir.path()).is_err());
    }

    #[test]
    fn wrong_version_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(dir.path(), r#"{"version": 1}"#);
        let problem = load(dir.path()).expect_err("version 1 refused");
        assert!(
            problem.contains("version"),
            "problem names version: {problem}"
        );
    }

    #[test]
    fn malformed_combo_key_is_refused_naming_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        for key in ["anima", "anima:t2i:extra", ":t2i", "anima:"] {
            write_fixture(
                dir.path(),
                &format!(r#"{{"version": 2, "combos": {{ "{key}": {{}} }}}}"#),
            );
            let problem = load(dir.path()).expect_err("malformed key refused: {key}");
            assert!(problem.contains(key), "problem names '{key}': {problem}");
        }
    }

    #[test]
    fn combo_key_with_unknown_mode_names_the_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(
            dir.path(),
            r#"{"version": 2, "combos": { "anima:t2o": {} }}"#,
        );
        let problem = load(dir.path()).expect_err("unknown mode refused");
        assert!(problem.contains("t2o"), "problem names the mode: {problem}");
    }

    #[test]
    fn combo_key_with_unknown_family_names_the_family() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(
            dir.path(),
            r#"{"version": 2, "combos": { "nope:t2i": {} }}"#,
        );
        let problem = load(dir.path()).expect_err("unknown family refused");
        assert!(
            problem.contains("nope"),
            "problem names the family: {problem}"
        );
    }

    #[test]
    fn family_block_with_unknown_family_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(
            dir.path(),
            r#"{"version": 2, "families": { "notafamily": { "steps": 1 } }}"#,
        );
        let problem = load(dir.path()).expect_err("unknown family refused");
        assert!(
            problem.contains("notafamily"),
            "problem names it: {problem}"
        );
    }

    #[test]
    fn impossible_dial_values_are_refused_naming_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture(dir.path(), r#"{"version": 2, "global": { "steps": 0 }}"#);
        let problem = load(dir.path()).expect_err("steps 0 refused");
        assert!(problem.contains("steps"), "problem names steps: {problem}");
        write_fixture(
            dir.path(),
            r#"{"version": 2, "global": { "denoise": 1.5 }}"#,
        );
        let problem = load(dir.path()).expect_err("denoise 1.5 refused");
        assert!(
            problem.contains("denoise"),
            "problem names denoise: {problem}"
        );
        write_fixture(
            dir.path(),
            r#"{"version": 2, "global": { "imageFormat": "gif" }}"#,
        );
        let problem = load(dir.path()).expect_err("gif refused");
        assert!(
            problem.contains("imageFormat"),
            "problem names imageFormat: {problem}"
        );
    }

    #[test]
    fn atomic_write_survives_a_second_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut sheet = DefaultsSheet::default();
        sheet.combos.insert(
            "anima:t2i".to_owned(),
            Dials {
                steps: Some(35),
                sampler: Some("er_sde".to_owned()),
                ..Dials::default()
            },
        );
        sheet.families.insert(
            "sdxl".to_owned(),
            Dials {
                steps: Some(25),
                ..Dials::default()
            },
        );
        write(dir.path(), &sheet).expect("atomic write succeeds");
        let reloaded = load(dir.path()).expect("reparse").expect("present");
        assert_eq!(reloaded, sheet, "round trip is exact");
        // No staging files linger after a successful write.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("readable")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "staging cleaned up");
    }

    #[test]
    fn write_refuses_an_invalid_sheet_without_touching_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut sheet = DefaultsSheet::default();
        sheet.combos.insert(
            "anima:t2o".to_owned(),
            Dials {
                steps: Some(35),
                ..Dials::default()
            },
        );
        let problem = write(dir.path(), &sheet).expect_err("invalid combo key refused");
        assert!(problem.contains("t2o"), "problem names the mode: {problem}");
        assert!(
            !dir.path().join(FILE).exists(),
            "nothing was written for an invalid sheet"
        );
    }

    #[test]
    fn builtin_stock_seed_surfaces_for_a_known_family() {
        // Pinned stock value: anima is 1024x1024, 30 steps, cfg 4, er_sde/simple (§SR7).
        let dials = builtin_defaults("anima").expect("anima has stock defaults");
        assert_eq!(dials.steps, Some(30));
        assert_eq!(dials.width, Some(1024));
        assert_eq!(dials.height, Some(1024));
        assert_eq!(dials.cfg, Some(4.0));
        assert_eq!(dials.sampler.as_deref(), Some("er_sde"));
        assert_eq!(dials.scheduler.as_deref(), Some("simple"));
        assert!(is_known_family("minimax-h3"));
        assert!(!is_known_family("not-a-family"));
    }

    #[test]
    fn the_ace_step_rows_seed_the_ladder_from_their_music_profile() {
        // LEG M14b: the ACE-Step sheet rows carry NO `defaults` block — their stock
        // tier is the `music` profile, the same block the stock Workbench seeds its
        // ACE controls from (musicIntent.ts `aceMusicProfile`). Pinned per row.
        let one = builtin_defaults("ace-step-1-0").expect("the stock row is a builtin family");
        assert_eq!(one.steps, Some(50));
        assert_eq!(one.cfg, Some(5.0));
        assert_eq!(one.sampler.as_deref(), Some("euler"));
        assert_eq!(one.scheduler.as_deref(), Some("simple"));
        assert!(
            one.width.is_none() && one.height.is_none(),
            "the music recipe counts no canvas dial"
        );
        let turbo =
            builtin_defaults("ace-step-1-5-turbo").expect("the turbo row is a builtin family");
        assert_eq!(
            turbo.steps,
            Some(8),
            "the turbo row's own seed, not the 1.0 row's"
        );
        assert_eq!(turbo.cfg, Some(1.0));
        // The latent clocks answer the duration grid (fill_plane's ACE arm).
        let profile =
            builtin_music_profile("ace-step-1-0").expect("the 1.0 row carries its music profile");
        assert_eq!(
            (profile.sample_rate, profile.samples_per_latent),
            (44100.0, 4096.0)
        );
        assert_eq!(profile.version, "1.0");
        let one_five = builtin_music_profile("ace-step-1-5-base")
            .expect("the 1.5 row carries its music profile");
        assert_eq!(
            (one_five.sample_rate, one_five.samples_per_latent),
            (48000.0, 1920.0)
        );
        assert_eq!(one_five.version, "1.5");
        assert!(
            builtin_music_profile("yue2").is_none(),
            "the YuE2 row keeps its `defaults` block and counts no music profile"
        );
    }

    #[test]
    fn builtin_view_is_the_verbatim_plugin_array() {
        let view = builtin_view();
        let entries = view.as_array().expect("builtin.json is an array");
        assert!(
            entries
                .iter()
                .any(|entry| entry["id"] == "anima" && entry["defaults"]["steps"] == 30),
            "stock view carries the anima seed"
        );
    }

    fn ladder_sheet() -> DefaultsSheet {
        let mut sheet = DefaultsSheet::default();
        sheet.global.steps = Some(21);
        sheet.global.negative_prompt = Some("global-negative".to_owned());
        sheet.families.insert(
            "anima".to_owned(),
            Dials {
                steps: Some(22),
                sampler: Some("family-sampler".to_owned()),
                ..Dials::default()
            },
        );
        sheet.combos.insert(
            "anima:t2i".to_owned(),
            Dials {
                steps: Some(23),
                scheduler: Some("combo-scheduler".to_owned()),
                ..Dials::default()
            },
        );
        sheet
    }

    fn source_of<'a>(fields: &'a [ResolvedField], name: &str) -> (&'a str, &'a Value) {
        let field = fields
            .iter()
            .find(|field| field.field == name)
            .unwrap_or_else(|| panic!("{name} is in the preview"));
        (field.source, &field.value)
    }

    #[test]
    fn ladder_request_beats_every_sheet_tier() {
        let sheet = ladder_sheet();
        let request = Dials {
            steps: Some(24),
            ..Dials::default()
        };
        let fields = resolve(Some("anima"), Some("t2i"), Some(&request), &sheet);
        assert_eq!(source_of(&fields, "steps"), ("request", &json!(24)));
    }

    #[test]
    fn ladder_combo_beats_family_and_both_beat_global() {
        let sheet = ladder_sheet();
        let fields = resolve(Some("anima"), Some("t2i"), None, &sheet);
        // steps exists at every sheet tier: combo wins.
        assert_eq!(source_of(&fields, "steps"), ("combo", &json!(23)));
        // sampler exists at family tier and below only: family wins.
        assert_eq!(
            source_of(&fields, "sampler"),
            ("family", &json!("family-sampler"))
        );
        // negativePrompt exists only at global: global wins over stock.
        assert_eq!(
            source_of(&fields, "negativePrompt"),
            ("global", &json!("global-negative"))
        );
        // scheduler exists at combo and stock: combo wins over stock.
        assert_eq!(
            source_of(&fields, "scheduler"),
            ("combo", &json!("combo-scheduler"))
        );
    }

    #[test]
    fn ladder_stock_tier_surfaces_when_the_sheet_is_silent() {
        let sheet = DefaultsSheet::default();
        let fields = resolve(Some("anima"), Some("t2i"), None, &sheet);
        // No sheet block names steps: the builtin.json seed answers, pinned at 30.
        assert_eq!(source_of(&fields, "steps"), ("stock", &json!(30)));
        assert_eq!(source_of(&fields, "width"), ("stock", &json!(1024)));
    }

    #[test]
    fn ladder_floors_cover_their_fields_everything_else_is_none() {
        let sheet = DefaultsSheet::default();
        let fields = resolve(None, None, None, &sheet);
        assert_eq!(source_of(&fields, "seedMode"), ("floor", &json!("random")));
        assert_eq!(source_of(&fields, "imageFormat"), ("floor", &json!("png")));
        assert_eq!(source_of(&fields, "batch"), ("floor", &json!(1)));
        assert_eq!(
            source_of(&fields, "imageCompression"),
            ("floor", &json!(44))
        );
        // No tier supplies a sampler without a family: honestly none, no fabrication.
        assert_eq!(source_of(&fields, "sampler"), ("none", &Value::Null));
    }

    #[test]
    fn ladder_nulls_fall_through_to_lower_tiers() {
        let mut sheet = ladder_sheet();
        // Explicit null at the combo tier: absent/null means fall through (§6).
        sheet.combos.insert(
            "anima:i2i".to_owned(),
            Dials {
                steps: None,
                ..Dials::default()
            },
        );
        let fields = resolve(Some("anima"), Some("i2i"), None, &sheet);
        assert_eq!(source_of(&fields, "steps"), ("family", &json!(22)));
    }

    #[test]
    fn plane_scope_skips_the_family_combo_and_stock_tiers() {
        let sheet = ladder_sheet();
        let fields = resolve(None, None, None, &sheet);
        // The global block still answers, but the family/combo blocks must not leak
        // into a plane-level preview, and stock needs a family.
        assert_eq!(source_of(&fields, "steps"), ("global", &json!(21)));
        assert_eq!(source_of(&fields, "sampler"), ("none", &Value::Null));
    }

    #[test]
    fn patch_merges_three_state_set_clear_keep() {
        let mut target = Dials {
            steps: Some(30),
            sampler: Some("er_sde".to_owned()),
            width: Some(1024),
            ..Dials::default()
        };
        let patch: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "steps": 35, "sampler": null }"#)
                .expect("patch object parses");
        apply_patch(&patch, &mut target).expect("well-formed patch applies");
        assert_eq!(target.steps, Some(35), "present value sets");
        assert_eq!(target.sampler, None, "explicit null clears to fall-through");
        assert_eq!(target.width, Some(1024), "absent key keeps");
    }

    #[test]
    fn patch_unknown_key_names_it_and_typed_mismatch_names_it() {
        let mut target = Dials::default();
        let bad_key: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "stps": 35 }"#).expect("object parses");
        let problem = apply_patch(&bad_key, &mut target).expect_err("unknown dial refused");
        assert!(problem.contains("stps"), "problem names the key: {problem}");
        let bad_type: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "steps": "many" }"#).expect("object parses");
        let problem = apply_patch(&bad_type, &mut target).expect_err("mistyped dial refused");
        assert!(
            problem.contains("steps"),
            "problem names the key: {problem}"
        );
    }

    /// The sheet canvas law (the defaults-range wall): an out-of-domain width is
    /// refused naming the key and the canvas law, `null` and the legal pair pass,
    /// and a legal pair whose PRODUCT crosses 16.7M is refused (both a patch pair
    /// and a patch merged onto an already-stored edge).
    #[test]
    fn patch_refuses_dial_dimensions_crossing_the_canvas_law() {
        let mut target = Dials::default();
        let wide: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "width": 30000 }"#).expect("object parses");
        let problem = apply_patch(&wide, &mut target)
            .expect_err("30000 poisons the sheet; refused at the door");
        assert!(problem.contains("dials.width"), "names the key: {problem}");
        assert!(problem.contains("canvas law"), "names the law: {problem}");
        // Off-grid and below the latent floor are refused; the floor itself is legal.
        // (A refused patch still lands in the target — the pre-existing three-state
        // law — so each case gets a fresh target and names the key it broke.)
        for bad in [511, 4] {
            let patch: serde_json::Map<String, Value> =
                serde_json::from_str(&format!(r#"{{ "height": {bad} }}"#)).expect("parses");
            let mut fresh = Dials::default();
            let problem = apply_patch(&patch, &mut fresh).expect_err("{bad} breaks the grid law");
            assert!(problem.contains("dials.height"), "{bad}: {problem}");
        }
        let legal: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "width": 576, "height": 1024 }"#)
                .expect("the legal pair parses");
        apply_patch(&legal, &mut target).expect("576x1024 is a shipped-shape pair");
        assert_eq!(target.width, Some(576));
        assert_eq!(target.height, Some(1024));
        // The product wall: legal edges, 25M pixels.
        let big: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "width": 8192, "height": 4096 }"#).expect("parses");
        let mut fresh = Dials::default();
        let problem = apply_patch(&big, &mut fresh).expect_err("8192x4096 is 33.5M");
        assert!(problem.contains("16.7M"), "names the ceiling: {problem}");
        // Merged onto a stored edge: the patch carries one dial, the stored other
        // completes the illegal pair — the MERGED pair is what the wall measures.
        let one: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "width": 8192 }"#).expect("parses");
        let mut tall = Dials {
            height: Some(8192),
            ..Dials::default()
        };
        let problem = apply_patch(&one, &mut tall).expect_err("the merged pair is 67M");
        assert!(problem.contains("16.7M"), "names the ceiling: {problem}");
        // null still clears, and clearing cannot be illegal.
        let clear: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{ "width": null }"#).expect("parses");
        apply_patch(&clear, &mut tall).expect("null clears the dial");
        assert_eq!(tall.width, None);
    }

    #[test]
    fn validate_dials_names_impossible_values() {
        let dials = Dials {
            steps: Some(0),
            ..Dials::default()
        };
        let problem = validate_dials("combos.anima:t2i", &dials).expect_err("steps 0 refused");
        assert!(problem.contains("steps"), "problem names steps: {problem}");
    }

    #[test]
    fn parse_combo_key_accepts_only_well_formed_pairs() {
        assert_eq!(
            parse_combo_key("anima:t2i").expect("well formed"),
            ("anima", "t2i")
        );
        assert!(parse_combo_key("anima").is_err());
        assert!(parse_combo_key("a:b:c").is_err());
        assert!(parse_combo_key(":t2i").is_err());
        assert!(parse_combo_key("anima:").is_err());
    }

    /// AF2-M18b B2: two concurrent writers of one sheet must BOTH survive. Without the
    /// gate the second writer merges into bytes it read before the first one wrote (a
    /// lost key) and both stage through one `{FILE}.{pid}.tmp` path (a torn file). The
    /// barrier puts them in the section together on every round, so a regression is
    /// caught rather than raced past.
    #[test]
    fn two_concurrent_sheet_writers_keep_both_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data = dir.path().to_path_buf();
        for round in 0..4u64 {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let mut writers = Vec::new();
            for (index, key) in ["anima:t2i", "anima:i2i"].into_iter().enumerate() {
                let barrier = std::sync::Arc::clone(&barrier);
                let app_data = app_data.clone();
                let key = key.to_owned();
                writers.push(std::thread::spawn(move || {
                    barrier.wait();
                    let steps = 11 + index as u64 + round * 100;
                    merge_write(&app_data, |sheet| {
                        sheet.combos.entry(key).or_default().steps = Some(steps);
                        Ok(())
                    })
                }));
            }
            for writer in writers {
                writer.join().expect("writer thread").expect("merge write");
            }
            let sheet = load(&app_data).expect("readable").expect("present");
            let keys: Vec<&String> = sheet.combos.keys().collect();
            assert_eq!(
                keys,
                vec![&"anima:i2i".to_owned(), &"anima:t2i".to_owned()],
                "round {round} lost a writer's key"
            );
            assert_eq!(sheet.combos["anima:t2i"].steps, Some(11 + round * 100));
            assert_eq!(sheet.combos["anima:i2i"].steps, Some(12 + round * 100));
            // No staging debris survives a clean write.
            let leftovers: Vec<String> = std::fs::read_dir(dir.path())
                .expect("readable dir")
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.ends_with(".tmp"))
                .collect();
            assert!(
                leftovers.is_empty(),
                "staging files left behind: {leftovers:?}"
            );
        }
    }
}
