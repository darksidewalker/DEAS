//! The FILL PLANE (API-DESIGN §9b, §SR14.1, ruling E12): a bare request becomes the
//! complete versioned intent that `jobs::compile` demands.
//!
//! Stock already owns the compiler: [`crate::jobs::compile`] is a pure
//! `intent JSON -> graph JSON` function in this crate, and M4 wires it. What the agent
//! plane must add is the plane in front of it — the §6 defaults ladder plus the mode and
//! pairing laws that expand `{family, mode, prompt, model}` into ONE FLAT intent object
//! obeying compile's exact key law: 13 required fields, plus at most one of each optional
//! key it counts; any other key is "Missing or unknown diagnostic intent fields".
//!
//! One plan, two outputs:
//!
//! * [`IntentPlan::envelope`] — the OURS-side versioned record: every resolved field with
//!   its winning ladder tier, the values the mode laws dropped, and the slots still open.
//! * [`IntentPlan::complete_or_refuse`] — the compile-ready flat intent, produced only
//!   when every resolver-owned slot landed; otherwise it names every open slot.
//!
//! Honest gaps: `checkpoint`, `positivePrompt`, `outputPrefix`, and `diffusion` for
//! `loader: "diffusion"` families, are model-resolution territory (M3b). This plane never
//! invents a checkpoint, a prompt or an output prefix.
//!
//! Scope of this leg: no route, no `ROUTE_INDEX` row, no `jobs::compile` call (M3b/M4).
//! Validation here covers compile's *shape and pairing* laws only — value ranges and the
//! live backend model allowlists stay with `compile` and `runnable::check`, so there is
//! never a second authority to disagree with. Where a stock validator is already
//! `pub(crate)` (`comfy_model_name`, `model_name`, `mask_name`, `safe_choice`,
//! `safe_output_prefix`, `valid_options`, `is_gguf`, `validate_lora_format`) this plane
//! calls that function instead of restating its rules.

// The plane is consumed by the queue door (M3b enqueue, M4 generate). Until that leg
// lands, only this module's own tests call it, so the lint is silenced deliberately and
// documented rather than accidentally: nothing below is unreachable by design.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

use super::defaults::{self, DefaultsSheet, Dials, ResolvedField, Tier, DIAL_NAMES, MODES};
use super::errors::{ApiError, ErrorKind};

/// The OURS-side envelope schema version — distinct from the intent's own recipe
/// `version`, which is the stock compiler's and stays `1`.
pub(crate) const ENVELOPE_VERSION: u32 = 1;

/// Recipe identity of `jobs::compile`'s image arm; the compiler is stock (§SR14.1).
const IMAGE_RECIPE_ID: &str = "checkpoint-text-to-image-diagnostic";
/// The only recipe version that arm accepts (`i["version"].as_f64() == Some(1.0)`).
const IMAGE_RECIPE_VERSION: u8 = 1;

/// Recipe identity of `jobs_video::compile`'s video arm (LEG M9c; the compiler is
/// stock). `pub(crate)` so the spool's row reconstruction reads the same home.
pub(crate) const VIDEO_RECIPE_ID: &str = "video-generation";
/// The video arm's recipe version law (`i["version"].as_f64() == Some(1.0)`).
const VIDEO_RECIPE_VERSION: u8 = 1;

/// `jobs_video::validate`'s 17 required flat-intent fields, verbatim. A law-named
/// test pins this list against the mirror in the module's tests.
pub(crate) const VIDEO_REQUIRED_FIELDS: [&str; 17] = [
    "recipeId",
    "version",
    "family",
    "positivePrompt",
    "negativePrompt",
    "model",
    "textEncoder",
    "vae",
    "seed",
    "width",
    "height",
    "frames",
    "frameRate",
    "steps",
    "cfg",
    "sampler",
    "scheduler",
];

/// The video arm's optional keys this plane passes through. The stock `dials`
/// optional — the H3 Dial Rack — rides here since LEG M12: the stock UI attaches
/// the rack to the video intent as top-level `dials` (`Workbench.tsx:1226`
/// `withDials`; `jobs_video.rs` OPTIONAL:1), and the queue door tells the two uses
/// of the wire word apart by JSON shape — the ladder block is an OBJECT of dial
/// names, the rack an ARRAY of rows. The rows are gated by
/// `check_video_passthrough_shape`, which calls the stock `validate_dial_row`.
/// The H3 audio wrapper `audioEnhance` rides here since LEG M15: 13 grew to 14.
/// It is NOT one of `jobs_video::OPTIONAL` — it is the wrapper `jobs::compile`
/// validates through `audio_post::settings` (jobs.rs:448-451) and then STRIPS
/// before dispatch, while the enhancement itself is a native post-render stage
/// off the job machinery (jobs_audio_post.rs; jobs.rs:2387): the compiled graph
/// never carries it. The door arm calls the stock `settings` validator itself.
static VIDEO_PASSTHROUGH_KEYS: [&str; 14] = [
    "dials",
    "streamDecode",
    "faceRefine",
    "enhancedPreview",
    "latentUpscale",
    "videoPost",
    "sourceVideo",
    "output",
    "loras",
    "options",
    "firstFrame",
    "lastFrame",
    "chunks",
    "audioEnhance",
];

/// The pinned H3 mode vocabulary for the `video` mode arm (REF2VA belongs to the
/// `ref2va` mode). Mirrors `jobs_video::H3_MODES` minus REF2VA; a law-named test
/// pins both halves.
static VIDEO_H3_MODES: [&str; 4] = ["T2VA", "I2VA", "L2VA", "FL2VA"];

/// Recipe identity of `jobs_music::compile`'s music arm (LEG M9e; the compiler is
/// stock). `pub(crate)` so the spool's row reconstruction reads the same home.
pub(crate) const MUSIC_RECIPE_ID: &str = "music-generation";
/// The music arm's recipe version law (`i["version"].as_f64() == Some(1.0)`).
const MUSIC_RECIPE_VERSION: u8 = 1;

/// Recipe identity of a DRAINABLE RefMod export row (LEG AF2-M24b, owner law
/// E28: "REFMOD = DRAINABLE ROW for consistency"). A PLANE-side routing word
/// only: the stock export compiler (`jobs_refmod::compile`) takes NO `recipeId`
/// at all, so this word selects the spool/cycle arm and never reaches the
/// request. LEG AF2-M24c landed the queue-door grammar: `MODE_SPECS` carries
/// `refmod` as `ModeTarget::RefmodExport`, the fill dispatcher arms it to
/// `fill_refmod` (the closed request grammar), and the queue door mints the row
/// through `spool::Spool::append_refmod_row` — never the render plan path.
pub(crate) const REFMOD_RECIPE_ID: &str = "refmod-export";

/// The one family the mode-`refmod` row runs (LEG AF2-M24c, manager ruling 5):
/// the RefMod export verbs are the stock MiniMax H3 natives
/// (`jobs_refmod`/`native_h3_*`), so any other family word is an honest
/// `modeUnsupported` until data proves otherwise — `minimax-h3-hyperflow`
/// included (no stock export arm is proven for the HyperFlow GGUF row).
/// An OMITTED family means this family (the creation door requires none).
pub(crate) const REFMOD_FAMILY: &str = "minimax-h3";

/// The closed request map `jobs_refmod::compile` accepts — its `known` array,
/// verbatim (a law-named test pins the two homes; the same seven the creation
/// door validates via `results::REFMOD_FIELDS`). The ONLY keys a refmod row's
/// flat intent may carry: stock compile refuses any unknown request key, so
/// every plane-only envelope word (recipeId, family, seed, version) is stripped
/// at reconstruction.
pub(crate) const REFMOD_EXPORT_KEYS: [&str; 7] = [
    "name",
    "description",
    "conceptType",
    "media",
    "refmods",
    "vae",
    "audioVae",
];

/// `jobs_music::validate`'s 16 required flat-intent fields — every non-`Option` field
/// of the stock YuE2 `Intent` struct (jobs_music.rs :47-69). A law-named test pins the
/// list against the stock field names.
pub(crate) const MUSIC_REQUIRED_FIELDS: [&str; 16] = [
    "recipeId",
    "version",
    "family",
    "mode",
    "planning",
    "checkpoint",
    "style",
    "lyrics",
    "seed",
    "maxDuration",
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "generation",
    "outputPrefix",
];

/// The music arm's optional intent keys: the whole `Option` half of the stock struct
/// (`abc`, `sourceAudio`, `audioEncoder`). The arm's deny law is absolute — the stock
/// derive is `deny_unknown_fields` — so the emitted key set is exactly
/// `MUSIC_REQUIRED_FIELDS` plus the members of this list the request carried. No LoRA
/// bag, no `options` bag, no image key can ride a music intent, and the whitelist
/// test says so.
static MUSIC_PASSTHROUGH_KEYS: [&str; 3] = ["abc", "sourceAudio", "audioEncoder"];

/// The music arm's YuE2 family. Stock dispatch is one test
/// (`jobs_music::compile`: `if i["family"] != "yue2" { return ace::compile(i) }`);
/// the door mirrors that split exactly (LEG M14b): this family runs the YuE2 key
/// law, every music family with a `builtin.json` `music` profile runs the ACE-Step
/// arm ([`is_ace_music_family`]), and the two arms share only the recipe identity.
const MUSIC_YUE2_FAMILY: &str = "yue2";

/// True for the ACE-Step music families: the rows whose stock compile arm is
/// `jobs_music_ace::compile` — read as data, a `builtin.json` `music` profile. The
/// family words are the sheet ids verbatim (`ace-step-1-0`, the six
/// `ace-step-1-5-*` rows); stock knows no shorter alias and the door invents none.
pub(crate) fn is_ace_music_family(family: &str) -> bool {
    defaults::builtin_music_profile(family).is_some()
}

/// `jobs_music_ace::validate`'s 16 required flat-intent fields — every non-`Option`
/// field of the stock ACE-Step `Intent` struct (jobs_music_ace.rs :38-57): the YuE2
/// list with the required `ace{}` settings block in place of `generation`, and the
/// struct's one `Option` field (`diffusion`, the 1.5 split triple) owned by the
/// resolver-slot law instead of a passthrough. A law-named test pins the list
/// against the stock field names.
pub(crate) const MUSIC_ACE_REQUIRED_FIELDS: [&str; 16] = [
    "recipeId",
    "version",
    "family",
    "mode",
    "planning",
    "checkpoint",
    "style",
    "lyrics",
    "seed",
    "maxDuration",
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "outputPrefix",
    "ace",
];

/// `src/lib/aceStepData.json` embedded once — the same data-only plugin the stock
/// `jobs_music_ace::settings` gate reads for its bounds and vocabularies. One home:
/// the door's `ace{}` gate can never drift from the compiler's.
static ACE_STEP_DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/lib/aceStepData.json"))
        .expect("the bundled aceStepData plugin is valid")
});

/// The four free-vocabulary members the stock `ace` block counts beside its bounded
/// keys (`jobs_music_ace::settings` :60-66): `timeSignature`/`language`/`keyScale`
/// ride closed vocabularies in the same plugin, `generateAudioCodes` is a boolean.
static ACE_VOCAB_KEYS: [&str; 4] = [
    "timeSignature",
    "language",
    "keyScale",
    "generateAudioCodes",
];

/// The stock Workbench's seed for the whole `ace{}` block
/// (`src/lib/musicIntent.ts:7 defaultAceSettings`), with the family `music` profile's
/// `shift` overriding it — the pairing the stock `Workbench.part5.test.tsx:1444`
/// pins (`ace:{...defaultAceSettings,shift}`). A mirror of stock homes, exactly like
/// [`MUSIC_GENERATION_DEFAULTS`] is, not a value this plane invented.
fn ace_floor_block(shift: f64) -> Value {
    let mut block = json!({
        "shift": shift,
        "lyricsStrength": 1,
        "bpm": 120,
        "timeSignature": "4",
        "language": "en",
        "keyScale": "C major",
        "generateAudioCodes": true,
        "lmCfg": 2,
        "temperature": 0.85,
        "topP": 0.9,
        "topK": 0,
        "minP": 0
    });
    integralize_ace_block(&mut block);
    block
}

/// The duration the stock Workbench seeds t2m with (`musicIntent.ts:52
/// musicMaxDuration.t2m` = 120 s), SNAPPED to the family's latent grid exactly as the
/// stock UI snaps before submitting (`musicIntent.ts:27 normalizeAceDuration`, the
/// clamp + epsilon branch mirrored verbatim): the 1.0 grid (4096 samples per
/// 44100 Hz frame) cannot answer 120.0 s, and the stock compiler refuses an off-grid
/// duration rather than truncating a frame — the door answers the UI's own value.
fn ace_duration_seed(profile: &defaults::MusicProfile) -> f64 {
    let seconds = 120.0;
    let frames = (seconds * profile.sample_rate / profile.samples_per_latent)
        .round()
        .max((profile.sample_rate / profile.samples_per_latent).ceil())
        .min((1000.0 * profile.sample_rate / profile.samples_per_latent).floor());
    let mut duration = frames * profile.samples_per_latent / profile.sample_rate;
    // The original core truncates, so the seed sits one epsilon above a
    // roundoff-short boundary (the stock UI's own fix, mirrored verbatim).
    if profile.version == "1.0" && (duration * profile.sample_rate / 512.0 / 8.0).floor() != frames
    {
        duration += f64::EPSILON * duration;
    }
    duration
}

/// The music arm's closed `planning` vocabulary (the words stock `validate`'s
/// combination match accepts).
static MUSIC_PLANNING: [&str; 3] = ["off", "full", "melody"];

/// The stock `generation{}` bounds, mirrored from `jobs_music::validate` :156-171.
/// The compiler demands the block unconditionally, so the arm completes it from
/// [`MUSIC_GENERATION_DEFAULTS`] and refuses a request block outside these ranges.
static MUSIC_GENERATION_BOUNDS: [(&str, f64, f64); 5] = [
    ("temperature", 0.0, 5.0),
    ("topP", 0.01, 1.0),
    ("topK", 1.0, 32768.0),
    ("repetitionPenalty", 0.01, 10.0),
    ("cfgScale", 0.0, 100.0),
];

/// The `generation{}` seed values the stock Workbench writes for the same block
/// (`src/lib/musicIntent.ts` `defaultMusicGeneration`): the same defaults the operator
/// sees in the Generate tab, so a queued row matches an interactive run of the same
/// model. This is a mirror of a stock home, not a value this plane invented; a
/// law-named test pins the five numbers against the stock bounds they must sit in.
static MUSIC_GENERATION_DEFAULTS: [(&str, f64); 5] = [
    ("temperature", 1.0),
    ("topP", 0.95),
    ("topK", 100.0),
    ("repetitionPenalty", 1.2),
    ("cfgScale", 1.0),
];

/// The stock `abc{}` bounds, mirrored from `jobs_music::abc_settings` :90-98. The arm
/// never seeds this block — ABC planning is a request decision — so a `full`/`melody`
/// plan without it is a refusal naming the key.
static MUSIC_ABC_BOUNDS: [(&str, f64, f64); 6] = [
    ("maxTokens", 1.0, 20000.0),
    ("temperature", 0.0, 5.0),
    ("topP", 0.01, 1.0),
    ("topK", 1.0, 32768.0),
    ("repetitionPenalty", 0.01, 10.0),
    ("penaltyWindow", 1.0, 20000.0),
];

/// The members of the two sub-blocks whose stock field is a `u64`: serde refuses a
/// fraction with a parse sentence, so the door refuses it by the cause instead.
static MUSIC_INTEGRAL_KEYS: [&str; 3] = ["topK", "maxTokens", "penaltyWindow"];

/// Emits one music sub-block with every [`MUSIC_INTEGRAL_KEYS`] member as a JSON
/// INTEGER. The stock `generation`/`abc` structs are `deny_unknown_fields` `u64`
/// fields, and serde refuses a float even when the value is integral
/// (`invalid type: floating point 100.0, expected u64`) — so any value entering an
/// integral key (the floor's stock-tier defaults AND a request block that
/// [`check_music_block`], proven integral) must be emitted integral. One home;
/// callers run `check_music_block` first, which bounds the value and proves the
/// fraction is zero.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn integralize_music_block(value: &Value) -> Value {
    let mut block = value.clone();
    if let Some(object) = block.as_object_mut() {
        for key in MUSIC_INTEGRAL_KEYS {
            if let Some(number) = object.get(key).and_then(Value::as_f64) {
                object.insert(key.to_owned(), json!(number.round() as u64));
            }
        }
    }
    block
}

/// The YuE2 latent clock (the node's 0.04 s step — stock `validate` refuses anything
/// off the grid) and the duration the stock Workbench seeds text-to-music with
/// (`src/lib/musicIntent.ts` `musicMaxDuration.t2m`, carried by `Workbench.tsx`'s
/// `usePref` seed), inside the stock `0.04..=900` range.
const MUSIC_DURATION_STEP: f64 = 0.04;
const MUSIC_DURATION_FLOOR: f64 = 120.0;
const MUSIC_DURATION_LIMIT: f64 = 900.0;

/// The stock `text()` cap on `style` and `lyrics` (jobs_music.rs :80-86): at most
/// 16384 characters, 65536 bytes, no NUL.
const MUSIC_TEXT_CHARS: usize = 16_384;
const MUSIC_TEXT_BYTES: usize = 65_536;

/// One music cover takes exactly one audio reference: the stock `sourceAudio` field is
/// a single `Option<String>`, so a second audio is refused naming the cap.
const MUSIC_MAX_AUDIO: usize = 1;

/// compile's 13 required flat-intent fields, verbatim from its image arm.
///
/// `pub(crate)` so the spool's row reconstruction ([`super::spool::flat_intent`])
/// iterates the same single home instead of restating the key law.
pub(crate) const REQUIRED_FIELDS: [&str; 13] = [
    "recipeId",
    "version",
    "positivePrompt",
    "negativePrompt",
    "checkpoint",
    "seed",
    "width",
    "height",
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "outputPrefix",
];

/// compile's optional intent keys that this plane passes through for compile to validate.
static PASSTHROUGH_KEYS: [&str; 19] = [
    "inputImage",
    "inputMask",
    "maskBlur",
    "inpaintCrop",
    "inputLayers",
    "inputResize",
    "upscaleModel",
    "refine",
    "faceRefine",
    "imageReference",
    "nativeImageReference",
    "loras",
    "h3Edit",
    "lyingSigma",
    "sigmas",
    "skipLayers",
    "latentUpscale",
    "wildcard",
    "componentOverrides",
];

/// Resolver-owned slots: left open here, named by [`IntentPlan::missing_slots`].
static SLOT_KEYS: [&str; 4] = ["checkpoint", "positivePrompt", "outputPrefix", "diffusion"];

/// Non-dial request keys this plane interprets itself.
static CONTROL_KEYS: [&str; 2] = ["seed", "imageCompression"];

/// Which stock key law the flat intent obeys: one value per recipe, so the required
/// list and the emission law can never disagree the way a stale boolean would.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyLaw {
    /// The image arm: 13 required fields plus the image-only optional keys.
    Image,
    /// The video arm (LEG M9c): 17 required fields, the family block, no image keys.
    Video,
    /// The YuE2 half of the music recipe (LEG M9e): 16 required fields,
    /// `deny_unknown_fields` strict — nothing outside the stock `Intent` struct's own
    /// field list may ride.
    Music,
    /// The ACE-Step half of the music recipe (LEG M14b): 16 required fields with the
    /// required `ace{}` block in place of `generation`, and the 1.5 split triple as
    /// the struct's one optional field — a resolver slot, not a passthrough.
    MusicAce,
}

/// Where a mode's job runs in the stock compiler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModeTarget {
    /// The image arm of `jobs::compile` (checkpoint and split-loader image recipes).
    Image,
    /// `jobs_video::compile` (recipeId `video-generation`): `ref2va` is the
    /// reference-matrix form (`h3.media` built from the E16 arrays), `video` is the
    /// t2v/i2v/v2v form on ltx-2/wan/minimax-h3/hyperflow (LEG M9c).
    Video,
    /// `jobs_music::compile` (recipeId `music-generation`): text-to-music on the
    /// YuE2 arm (the E16 `audio[]` reference becoming the stock cover row, LEG M9e)
    /// and on the ACE-Step arm (mode t2m only, the required `ace{}` block, LEG M14b).
    Music,
    /// The RefMod export row (E28, queue grammar LEG AF2-M24c): NOT a stock compile
    /// arm — the row's submission is the stock RefMod export (`jobs_refmod::compile`
    /// over the backend's native verbs), reached through the drain's refmod arm.
    /// The fill plane validates the closed request grammar and returns the export
    /// map; no render ladder, no slots, no dials, no recipe key law.
    RefmodExport,
    /// In the closed mode vocabulary, no leg built yet: the plane refuses with
    /// `modeUnsupported` and names the leg that will build it.
    Deferred { leg: &'static str },
}

/// One row of the mode table: what the mode demands of the family, of the request and of
/// the ladder. Data, not control flow — the closed mode vocabulary stays in
/// [`defaults::MODES`]; this table gives every one of those words a compile-side meaning.
struct ModeSpec {
    mode: &'static str,
    target: ModeTarget,
    /// `builtin.json` `pipelines` words a family must declare for this mode (any-of);
    /// empty means the mode is not pipeline-gated yet.
    pipelines: &'static [&'static str],
    /// Intent keys the mode cannot run without (beyond the 13 required fields).
    requires: &'static [&'static str],
    /// Intent keys the mode refuses: the pairing laws that would otherwise trip compile.
    forbids: &'static [&'static str],
    /// Dials the mode floors when no ladder tier supplied them. `upscale` runs the stock
    /// upscale-only leg — resize plus model upscale, no diffusion pass — so denoise 0 is
    /// the mode's own law, not a fabricated value.
    floors: &'static [(&'static str, f64)],
}

/// Image modes run through the image arm; the rest are honest refusals for now (§SR14.5).
/// One row per [`defaults::MODES`] word — the arrays must stay the same length and
/// carry the same words (a law test pins it).
///
/// Design ruling (LEG M12, manager-ruled; owner confirmation pending): `sam3` and
/// `sam3_video` are DESIGN-EXCLUDED from v1, not merely unbuilt. The stock compile
/// arms for them EXIST and run ahead of the video and music arms (`jobs.rs:453-457`:
/// `jobs_sam3_video::is_video_mask` then `jobs_sam3::is_sam3`), but the closed
/// 13-word mode vocabulary [`defaults::MODES`] excludes them BY RULING. The door
/// therefore refuses a `sam3` mode word one wall earlier than the `Deferred` row
/// class: `bodyInvalid` naming the closed vocabulary (pinned by
/// `the_sam3_mode_words_are_design_excluded_and_name_the_closed_13`), a different
/// class from the `modeUnsupported` refusals below — those words are IN the
/// vocabulary and await a leg; these words are not in the vocabulary at all.
static MODE_SPECS: [ModeSpec; 13] = [
    ModeSpec {
        mode: "t2i",
        target: ModeTarget::Image,
        pipelines: &["t2i"],
        requires: &[],
        // An `inputImage` without its paired `denoise`, or a mask/refine leg, is a
        // different job: refusing here keeps the emitted intent shape-valid for compile.
        forbids: &[
            "inputImage",
            "inputMask",
            "maskBlur",
            "inpaintCrop",
            "inputLayers",
            "inputResize",
            "upscaleModel",
            "refine",
            "latentUpscale",
            "h3Edit",
            "faceRefine",
        ],
        floors: &[],
    },
    ModeSpec {
        mode: "i2i",
        target: ModeTarget::Image,
        pipelines: &["i2i"],
        // `denoise` is a ladder dial; the mode requires it because compile demands it
        // exactly when `inputImage` is present.
        requires: &["inputImage", "denoise"],
        forbids: &[
            "inputMask",
            "maskBlur",
            "inpaintCrop",
            "upscaleModel",
            "refine",
            // LEG M14a: `latentUpscale` is NOT a mode-level forbid. Stock accepts it on
            // an i2i job — `jobs.rs:687` demands exactly "an unmasked MiniMax H3 edit",
            // i.e. the `h3Edit` pairing plus the `minimax-h3` family with no mask, which
            // the pairing law at `check_image_pairing` (below) already enforces on both
            // walls. Leaving it mode-forbidden refused a shape the stock compiler builds
            // (`jobs_tests.rs:3045 h3_still_intent()` + the block at :3071): a capability
            // hole, pinned closed by
            // `intent_truth::h3_still_latent_upscale_lands_the_latent_pass_not_the_model_upscale_shape`.
        ],
        floors: &[],
    },
    ModeSpec {
        mode: "inpaint",
        target: ModeTarget::Image,
        // No family declares an `inpaint` pipeline at v0.3.14: inpaint is an i2i leg with
        // a mask, so the i2i pipeline is the honest gate (§SR14.5 gap note).
        pipelines: &["i2i"],
        requires: &["inputImage", "denoise", "inputMask"],
        // compile: an `inputMask` is "an uploaded mask for an UNRESIZED inputImage".
        forbids: &["inputResize", "upscaleModel", "refine", "latentUpscale"],
        floors: &[],
    },
    ModeSpec {
        mode: "refine",
        target: ModeTarget::Image,
        // The refine pass rides a t2i or an i2i first pass, exactly as stock's `post` leg.
        pipelines: &["t2i", "i2i"],
        requires: &["refine"],
        forbids: &[
            "inputMask",
            "maskBlur",
            "inpaintCrop",
            "upscaleModel",
            "latentUpscale",
        ],
        floors: &[],
    },
    ModeSpec {
        mode: "upscale",
        target: ModeTarget::Image,
        // Stock's upscale-only leg is an i2i job: `inputImage`, `inputResize` and the
        // top-level `upscaleModel` (compile demands `inputResize` beside it).
        pipelines: &["i2i"],
        requires: &["inputImage", "denoise", "inputResize", "upscaleModel"],
        forbids: &[
            "refine",
            "inputMask",
            "maskBlur",
            "inpaintCrop",
            "latentUpscale",
        ],
        floors: &[("denoise", 0.0)],
    },
    ModeSpec {
        mode: "refmod",
        // E28 (queue grammar landed, LEG AF2-M24c): a drainable RefMod export
        // ROW, not a render mode. No pipeline gate (the export is not a
        // Workbench recipe), no ladder requires/forbids/floors — the grammar
        // walls are `fill_refmod`'s closed request set and the family law is
        // the H3-only ruling (`REFMOD_FAMILY`), both one-home.
        target: ModeTarget::RefmodExport,
        pipelines: &[],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    ModeSpec {
        mode: "ref2va",
        target: ModeTarget::Video,
        pipelines: &["ref2v"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    ModeSpec {
        mode: "video",
        target: ModeTarget::Video,
        pipelines: &["t2v", "i2v", "v2v"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    ModeSpec {
        mode: "music",
        target: ModeTarget::Music,
        pipelines: &["t2m"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    // The three video-recipe words (LEG M9c vocab growth, manager-approved): each
    // gates exactly one stock pipeline word; the generic `video` word above gates
    // any of the three. The arm is `fill_video`'s non-ref2va shape either way —
    // the concrete words let the surface and the queue name the job the family
    // actually declares (wan answers `i2v`, never `t2v`).
    ModeSpec {
        mode: "t2v",
        target: ModeTarget::Video,
        pipelines: &["t2v"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    ModeSpec {
        mode: "i2v",
        target: ModeTarget::Video,
        pipelines: &["i2v"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    ModeSpec {
        mode: "v2v",
        target: ModeTarget::Video,
        pipelines: &["v2v"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
    // The music-recipe word (LEG M9e vocab growth, manager-approved): the generic
    // `music` word above and this concrete one both gate the single stock pipeline
    // word `t2m`, and `t2m` is the word the music intent itself carries in its `mode`
    // field. `cover` stays out of the closed vocabulary — it is the stock intent's
    // second `mode` word, reached by sending an audio reference, not a door word.
    ModeSpec {
        mode: "t2m",
        target: ModeTarget::Music,
        pipelines: &["t2m"],
        requires: &[],
        forbids: &[],
        floors: &[],
    },
];

/// The mode table's pipeline gate as data (LEG M13): the `pipelines` words one
/// [`MODE_SPECS`] row demands, for surfaces that must enumerate which families a mode
/// can run (the settings-truth harness builds its combo matrix from this single home,
/// so the matrix can never drift from the mode table). `None` for a mode word outside
/// the closed vocabulary; an empty slice means the mode is not pipeline-gated.
pub(crate) fn mode_pipeline_gate(mode: &str) -> Option<&'static [&'static str]> {
    MODE_SPECS
        .iter()
        .find(|spec| spec.mode == mode)
        .map(|spec| spec.pipelines)
}

/// Intent keys a family's stock image path refuses; the plane refuses them at the door
/// instead of letting compile discover them (P7: verify at the door, never surprise at
/// runtime). Extras refuse; ladder-supplied dials are dropped and recorded.
static FAMILY_KEY_REFUSALS: [(&str, &[&str], &str); 1] = [(
    "moss-image",
    &[
        "refine",
        "upscaleModel",
        "sigmas",
        "inputLayers",
        "loras",
        "options",
    ],
    "unverified on MOSS-Image stock-side (plain t2i, VAE i2i and masked inpaint only)",
)];

/// A filled intent plan: the ladder output, the validated request-side keys and the
/// resolver-owned slots. Cheap to keep in memory; the flat intent is derived on demand.
#[derive(Clone, Debug)]
pub(crate) struct IntentPlan {
    family: String,
    mode: &'static str,
    /// The §6 ladder output (dial fields + floors) in preview order, adjusted only by
    /// mode floors (added) and mode laws (cleared to `none`, recorded in `dropped`).
    fields: Vec<ResolvedField>,
    seed: Value,
    seed_mode: String,
    seed_mode_source: &'static str,
    seed_value_source: &'static str,
    /// Validated request-side keys, passed through to the flat intent verbatim.
    extras: Map<String, Value>,
    slots: Slots,
    dropped: Vec<DroppedField>,
    /// The recipe identity the flat intent carries (`compile`'s arm selected by the mode).
    recipe_id: &'static str,
    recipe_version: u8,
    /// Which stock key law the flat intent obeys (image / video / music). One value
    /// per recipe, so the required list and the emission law cannot disagree.
    key_law: KeyLaw,
}

/// The slots the queue door (M3b) resolves: model identity, prompt text, output naming and
/// the split-loader component recipe. `Option`, never a placeholder value.
///
/// `Serialize`/`Deserialize` so the durable spool can store and reload the four slot
/// values verbatim (API-DESIGN §5: the row must make the flat intent reconstructable).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(crate) struct Slots {
    pub(crate) checkpoint: Option<String>,
    pub(crate) positive_prompt: Option<String>,
    pub(crate) output_prefix: Option<String>,
    pub(crate) diffusion: Option<Value>,
}

/// One ladder value the mode or family law removed from the emitted intent.
#[derive(Clone, Debug, Serialize)]
struct DroppedField {
    field: &'static str,
    reason: &'static str,
}

/// (a) The versioned OURS-side record of one fill. Serializes in declaration order, so
/// the same fill always produces the same bytes.
#[derive(Serialize)]
pub(crate) struct Envelope<'a> {
    #[serde(rename = "apiVersion")]
    api_version: u32,
    family: &'a str,
    mode: &'a str,
    recipe: RecipeRef,
    fields: &'a [ResolvedField],
    seed: SeedRecord<'a>,
    /// Intent keys taken verbatim from the request side.
    extras: Vec<&'a str>,
    dropped: &'a [DroppedField],
    #[serde(rename = "missingSlots")]
    missing_slots: Vec<&'static str>,
}

/// The stock compiler identity the flat intent carries.
#[derive(Serialize)]
struct RecipeRef {
    #[serde(rename = "recipeId")]
    recipe_id: &'static str,
    version: u8,
}

/// The seed as this plane resolved it: the `seedMode` tier, the value, and which tier the
/// value itself came from. Reproducibility (§6) needs the drawn value, not just the mode.
#[derive(Serialize)]
struct SeedRecord<'a> {
    mode: &'a str,
    #[serde(rename = "modeSource")]
    mode_source: &'static str,
    value: &'a Value,
    #[serde(rename = "valueSource")]
    value_source: &'static str,
}

impl IntentPlan {
    /// The versioned envelope for this fill (output (a)).
    pub(crate) fn envelope(&self) -> Envelope<'_> {
        Envelope {
            api_version: ENVELOPE_VERSION,
            family: &self.family,
            mode: self.mode,
            recipe: RecipeRef {
                recipe_id: self.recipe_id,
                version: self.recipe_version,
            },
            fields: &self.fields,
            seed: SeedRecord {
                mode: &self.seed_mode,
                mode_source: self.seed_mode_source,
                value: &self.seed,
                value_source: self.seed_value_source,
            },
            extras: self.extras.keys().map(String::as_str).collect(),
            dropped: &self.dropped,
            missing_slots: self.missing_slots(),
        }
    }

    /// The family word this plan filled.
    pub(crate) fn family(&self) -> &str {
        &self.family
    }

    /// The resolver slot values the request carried. The spool stores them so a row
    /// reconstructs its flat intent without the live plan (API-DESIGN §5).
    pub(crate) fn slots(&self) -> &Slots {
        &self.slots
    }

    /// The validated request-side passthrough keys and their values. The envelope
    /// records only the key names, so the spool stores this map to keep the row
    /// reconstruction complete.
    pub(crate) fn extras(&self) -> &Map<String, Value> {
        &self.extras
    }

    /// Every field the flat intent still lacks, named as the intent spells it (sorted).
    /// Includes the gated `diffusion` slot for `loader: "diffusion"` families.
    pub(crate) fn missing_slots(&self) -> Vec<&'static str> {
        let mut missing = self.intent_values().1;
        missing.sort_unstable();
        missing.dedup();
        missing
    }

    /// (b) The compile-ready flat intent, or every still-open field named (sorted).
    ///
    /// The emitted key set is exactly compile's law: the 13 required fields plus the
    /// optional keys present, and nothing the mode table forbids.
    pub(crate) fn complete_or_refuse(&self) -> Result<Value, Vec<&'static str>> {
        let (mut values, mut missing) = self.intent_values();
        if !missing.is_empty() {
            missing.sort_unstable();
            missing.dedup();
            return Err(missing);
        }
        for (key, value) in &self.extras {
            values.insert(key.clone(), value.clone());
        }
        // The family word selects compile's internal image-recipe patch; the fill plane
        // owns it, so the request never carries a `family` key of its own.
        values.insert("family".to_string(), json!(self.family));
        Ok(Value::Object(values))
    }

    /// Resolves the 13 required fields, returning the values found and the names missing.
    fn intent_values(&self) -> (Map<String, Value>, Vec<&'static str>) {
        let mut values = Map::new();
        let mut missing = Vec::new();
        let required: &[&'static str] = match self.key_law {
            KeyLaw::Image => &REQUIRED_FIELDS,
            KeyLaw::Video => &VIDEO_REQUIRED_FIELDS,
            KeyLaw::Music => &MUSIC_REQUIRED_FIELDS,
            KeyLaw::MusicAce => &MUSIC_ACE_REQUIRED_FIELDS,
        };
        for &field in required {
            let value = match field {
                "recipeId" => Some(json!(self.recipe_id)),
                "version" => Some(json!(self.recipe_version)),
                "seed" => Some(self.seed.clone()),
                // The video arm counts `family` in its required fields; the image
                // arm writes the same key through `complete_or_refuse`.
                "family" => Some(json!(self.family)),
                // The video model identity rides the resolver slots: the checkpoint
                // slot names the model file, the split-loader component recipe
                // carries the text encoder and the VAE the recipe demands.
                "model" => self.slots.checkpoint.clone().map(Value::String),
                "textEncoder" => self
                    .slots
                    .diffusion
                    .as_ref()
                    .and_then(|diffusion| diffusion.get("textEncoder"))
                    .cloned(),
                "vae" => self
                    .slots
                    .diffusion
                    .as_ref()
                    .and_then(|diffusion| diffusion.get("vae"))
                    .cloned(),
                "positivePrompt" => self.slots.positive_prompt.clone().map(Value::String),
                "checkpoint" => self.slots.checkpoint.clone().map(Value::String),
                "outputPrefix" => self.slots.output_prefix.clone().map(Value::String),
                // §6.5: no tier and no floor supplies a negative prompt. compile accepts
                // an empty one, and an unconditional empty is the honest floor for a mode
                // that names no negative conditioning (a family with a stock negative gets
                // that value from the ladder instead).
                "negativePrompt" => Some(self.dial("negativePrompt").unwrap_or_else(|| json!(""))),
                _ => self.dial(field),
            };
            match value {
                Some(value) => {
                    values.insert(field.to_string(), value);
                }
                None => missing.push(field),
            }
        }
        // Split-loader families (`loader: "diffusion"`) cannot load through
        // CheckpointLoaderSimple: the component recipe is a slot M3b resolves.
        if self.needs_diffusion() && self.slots.diffusion.is_none() {
            missing.push("diffusion");
        }
        // The split-loader component recipe is a resolver-owned compile key — for
        // the image arm only: the video recipe counts no `diffusion` key, its
        // components land as the required `textEncoder`/`vae` fields above, and the
        // YuE2 music struct has no such field at all (`deny_unknown_fields` refuses
        // it). The ACE struct DOES count one: the 1.5 split triple (M14b).
        match self.key_law {
            KeyLaw::Image => {
                if let Some(diffusion) = &self.slots.diffusion {
                    values.insert("diffusion".to_string(), diffusion.clone());
                }
            }
            KeyLaw::Video => {
                // `outputPrefix` is optional in the video key law but a resolver slot:
                // a supplied one must land in the flat intent.
                if let Some(prefix) = &self.slots.output_prefix {
                    values.insert("outputPrefix".to_string(), json!(prefix));
                }
            }
            // The YuE2 arm's `outputPrefix` is a required field, already resolved
            // above; the struct counts no other optional key of its own. A stray
            // `diffusion` slot stays unemitted — the stock struct would refuse it.
            KeyLaw::Music => {}
            KeyLaw::MusicAce => {
                // The stock ACE struct's one optional field: the 1.5 split triple,
                // a required slot by the loader law (the fill arm refused the 1.0
                // pairing by the stock cause, so a present slot here is always legal).
                if let Some(diffusion) = &self.slots.diffusion {
                    values.insert("diffusion".to_string(), diffusion.clone());
                }
            }
        }
        // Ladder-supplied optional keys that compile counts in its key law. The
        // video whitelist carries none of the image-only trio; the music struct
        // counts no ladder-supplied optional key whatsoever.
        let ladder_optionals: &[&str] = match self.key_law {
            KeyLaw::Image => &["denoise", "imageFormat", "imageCompression", "options"],
            KeyLaw::Video => &["options"],
            KeyLaw::Music | KeyLaw::MusicAce => &[],
        };
        for name in ladder_optionals {
            if let Some(value) = self.dial(name) {
                values.insert(name.to_string(), value);
            }
        }
        (values, missing)
    }

    /// True when the family's stock loader is the split one, so `diffusion` is required.
    fn needs_diffusion(&self) -> bool {
        defaults::builtin_loader(&self.family) == Some("diffusion")
    }

    /// The effective emitted value of one ladder field (`None` when cleared or unsupplied).
    fn dial(&self, name: &str) -> Option<Value> {
        self.fields
            .iter()
            .find(|field| field.field == name && !field.value.is_null())
            .map(|field| field.value.clone())
    }
}

/// The fill dispatcher's verdict (LEG AF2-M24c, manager ruling 2): a mode word with
/// a render arm fills an [`IntentPlan`]; the mode-`refmod` word fills a RefMod
/// EXPORT MAP instead — the closed `jobs_refmod::compile`-shaped request the queue
/// door mints through `spool::Spool::append_refmod_row`, never through
/// [`QueueRow::from_plan`]. Keeping the two outcomes one enum return (not a stringly
/// probe at the door) means the mode table's `target` — not the caller's memory —
/// decides which arm ran, so the queue door can never route a render body into the
/// export helper or vice versa.
#[derive(Debug)]
// Size-difference lint declined on purpose (manager ruling, LEG AF2-M24c): boxing
// the plan variant would chase a ~300-byte stack margin across every render caller
// while this enum is a one-hop routing seam, never a hot collection. The arm is
// chosen by the mode table, not by size pressure.
#[allow(clippy::large_enum_variant)]
pub(crate) enum FillOutcome {
    /// A render-recipe plan (image / video / music arms).
    Plan(IntentPlan),
    /// The validated RefMod export request (the closed seven keys, `media` and
    /// `refmods` built door-side).
    Export(Value),
}

impl FillOutcome {
    /// The render plan, asserting the mode table's arm was a render arm (test and
    /// door plumbing; the queue branch matches the enum instead).
    pub(crate) fn plan(self) -> IntentPlan {
        match self {
            FillOutcome::Plan(plan) => plan,
            FillOutcome::Export(export) => {
                panic!("a render arm never returns an export map: {export}")
            }
        }
    }

    /// The export map, asserting the arm was `RefmodExport`.
    pub(crate) fn expect_export(self) -> Value {
        match self {
            FillOutcome::Export(export) => export,
            FillOutcome::Plan(_) => panic!("the export arm never fills a render plan"),
        }
    }
}

/// Expands one request into a [`FillOutcome`]: a render arm fills an [`IntentPlan`].
///
/// * `family` / `mode` are validated against the closed vocabularies (`builtin.json` ids,
///   [`defaults::MODES`]) — an unknown word is `bodyInvalid` naming it.
/// * `request_dials` is the ladder's tier-1 block (the request's dial overrides).
/// * `sheet` is the operator defaults sheet; the §6 ladder runs inside this plane, so a
///   caller cannot skip it and hand compile a half-filled intent.
/// * `request_extras` carries the non-dial request keys: the resolver slots
///   (`checkpoint`, `positivePrompt`, `outputPrefix`, `diffusion`), `seed`,
///   `imageCompression` and compile's optional keys.
///
/// The mode table's `target` decides the outcome ([`FillOutcome`], LEG AF2-M24c):
/// a render arm fills a plan; the `refmod` word fills the closed RefMod export
/// map ([`fill_refmod`]) without ever touching the ladder.
///
/// # Errors
///
/// [`ApiError`] using only the closed §11 taxonomy: `bodyInvalid` for vocabulary and
/// shape problems (the offending key named), `modeUnsupported` for a mode with no leg, a
/// family that cannot run the mode, or a key the mode or family refuses.
pub(crate) fn fill(
    family: &str,
    mode: &str,
    request_dials: Option<&Dials>,
    sheet: &DefaultsSheet,
    request_extras: Option<&Map<String, Value>>,
) -> Result<FillOutcome, ApiError> {
    fill_at(family, mode, request_dials, sheet, request_extras, None)
}

/// [`fill`] with the engine's INPUT root threaded in: the i2i canvas law (the P3
/// door wall) reads the PLACED `inputImage` file's header dims, and only the queue
/// door (which owns the plane state) can name that root. `None` keeps every other
/// law identical and leaves only the input-header read inert — the compile-side
/// mirror (`jobs::check_input_canvas`, fed by the backend's snapshotted input
/// folder) still refuses an oversized placed input before `VAEEncode`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fill_at(
    family: &str,
    mode: &str,
    request_dials: Option<&Dials>,
    sheet: &DefaultsSheet,
    request_extras: Option<&Map<String, Value>>,
    input_root: Option<&std::path::Path>,
) -> Result<FillOutcome, ApiError> {
    let spec = MODE_SPECS
        .iter()
        .find(|spec| spec.mode == mode)
        .ok_or_else(|| {
            ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                "mode '{mode}' is outside the closed vocabulary {}",
                MODES.join("|")
            ))
        })?;
    // E28 (LEG AF2-M24c, manager ruling 5): the RefMod export row has no render
    // family — an OMITTED family is legal (the creation door requires none) and
    // `fill_refmod` owns the H3-only wall, so the generic family-vocabulary check
    // is skipped for this arm (an unknown non-empty family word still meets a
    // `modeUnsupported` naming the export's one family; the queue door's
    // family-required wall is render-only by the same ruling).
    if matches!(spec.target, ModeTarget::RefmodExport) {
        return fill_refmod(family, request_extras).map(FillOutcome::Export);
    }
    if !defaults::is_known_family(family) {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "family '{family}' is not a builtin.json family id; GET /v1/families lists them"
        )));
    }
    match spec.target {
        ModeTarget::Image => check_family_supports(family, spec)?,
        ModeTarget::Video => {
            check_video_family(family, spec)?;
            return fill_video(spec, family, request_dials, sheet, request_extras)
                .map(FillOutcome::Plan);
        }
        ModeTarget::Music => {
            check_music_family(family, spec)?;
            return fill_music(spec, family, request_dials, sheet, request_extras)
                .map(FillOutcome::Plan);
        }
        ModeTarget::RefmodExport => {
            // Unreachable: the arm returned above, before the family-vocabulary
            // check it must skip (an omitted family is legal there).
            unreachable!("the RefmodExport target arms before the render ladder")
        }
        ModeTarget::Deferred { leg } => {
            let mut hint = format!("mode '{mode}' has no leg in this build; planned: {leg}");
            if !spec.pipelines.is_empty() {
                hint.push_str(&format!(
                    " (stock pipeline words: {})",
                    spec.pipelines.join("|")
                ));
            }
            return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(hint));
        }
    }

    let mut fields = defaults::resolve(Some(family), Some(mode), request_dials, sheet);
    let mut dropped: Vec<DroppedField> = Vec::new();

    // Mode floors first: they sit under the request tier but over the compile law, which
    // needs a `denoise` value whenever an `inputImage` is present.
    for (field, value) in spec.floors {
        if dial_value(&fields, field).is_none() {
            set_dial(&mut fields, field, json!(value), Tier::Floor.word());
        }
    }

    let mut extras = Map::new();
    let mut slots = Slots::default();
    let mut seed_request: Option<&Value> = None;
    let refusals = family_key_refusals(family);

    for (key, value) in request_extras.into_iter().flatten() {
        if DIAL_NAMES.contains(&key.as_str()) {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                "'{key}' is a dial; send it in the dials block, not beside it"
            )));
        }
        if key == "family" {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
                "the family is the request's family field; the fill plane writes the intent's family key",
            ));
        }
        if let Some(reason) = refusals
            .iter()
            .find(|refusal| refusal.0 == key.as_str())
            .map(|refusal| refusal.1)
        {
            return Err(ApiError::new(ErrorKind::ModeUnsupported)
                .with_hint(format!("family '{family}' key '{key}': {reason}")));
        }
        if spec.forbids.contains(&key.as_str()) {
            return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
                "mode '{mode}' does not run key '{key}'; it would trip the stock compiler's pairing laws"
            )));
        }
        if SLOT_KEYS.contains(&key.as_str()) {
            read_slot(key, value, &mut slots)?;
            continue;
        }
        if CONTROL_KEYS.contains(&key.as_str()) {
            match key.as_str() {
                "seed" => seed_request = Some(value),
                "imageCompression" => {
                    let compression = value.as_u64().ok_or_else(|| {
                        ApiError::new(ErrorKind::BodyInvalid)
                            .with_hint("imageCompression must be an integer 0..=100")
                    })?;
                    if compression > 100 {
                        return Err(ApiError::new(ErrorKind::BodyInvalid)
                            .with_hint("imageCompression must be an integer 0..=100"));
                    }
                    set_dial(
                        &mut fields,
                        "imageCompression",
                        json!(compression),
                        Tier::Request.word(),
                    );
                }
                other => unreachable!("CONTROL_KEYS holds only seed and imageCompression: {other}"),
            }
            continue;
        }
        if !PASSTHROUGH_KEYS.contains(&key.as_str()) {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                "'{key}' is not an intent key this plane accepts; the closed set is the stock compiler's optional keys, the slots {SLOT_KEYS:?} and the control keys {CONTROL_KEYS:?}"
            )));
        }
        check_passthrough_shape(key, value)?;
        extras.insert(key.clone(), value.clone());
    }

    // Dials the mode or family law cannot emit: cleared to `none` and recorded, never
    // silently carried into an intent compile would refuse.
    for (field, reason) in mode_dial_drops(spec, &refusals) {
        if dial_value(&fields, field).is_some() {
            set_dial(&mut fields, field, Value::Null, Tier::Unsupplied.word());
            dropped.push(DroppedField { field, reason });
        }
    }

    // Mode requirements: a mode cannot run without these keys, so the door refuses and
    // names the one missing (P7: verify at the door, never surprise compile later).
    for key in spec.requires {
        let present = if *key == "denoise" {
            dial_value(&fields, "denoise").is_some()
        } else {
            extras.contains_key(*key)
        };
        if !present {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                "mode '{}' cannot run without '{key}'; supply it in the request (denoise may come from the defaults sheet)",
                spec.mode
            )));
        }
    }

    // §12.1 dials/prereqs, BOTH generation arms: a torch.compile path is Triton-gated
    // stock-side (`recipe_prerequisites:518` builds `allowlist.compile` from the graph's
    // `TorchCompileModel` nodes; the prepare stage refuses a backend the owned
    // environment does not admit, jobs.rs:1820), and this staged door cannot read the
    // owned environment's Triton fact — so it answers by the cause, never later on the
    // card. LEG M14a: the gate used to exist in `fill_video` only.
    check_triton_gated_compile(spec, &fields)?;

    let (seed, seed_mode, seed_mode_source, seed_value_source) =
        resolve_seed(&fields, seed_request)?;

    let plan = IntentPlan {
        family: family.to_owned(),
        mode: spec.mode,
        fields,
        seed,
        seed_mode,
        seed_mode_source,
        seed_value_source,
        extras,
        slots,
        dropped,
        recipe_id: IMAGE_RECIPE_ID,
        recipe_version: IMAGE_RECIPE_VERSION,
        key_law: KeyLaw::Image,
    };
    check_image_canvas(&plan)?;
    check_pairing_laws(&plan, input_root)?;
    Ok(FillOutcome::Plan(plan))
}

/// The seed law shared by both recipe arms: the `seedMode` tier word must be in the
/// closed vocabulary, a `fixed` mode demands a request-side seed, and `random`
/// draws one in the stock domain. Answers the seed value, the mode word, and the
/// tier words that supplied the mode and the value.
fn resolve_seed(
    fields: &[ResolvedField],
    seed_request: Option<&Value>,
) -> Result<(Value, String, &'static str, &'static str), ApiError> {
    let seed_mode = dial_value(fields, "seedMode")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| Tier::Floor.word().to_owned());
    if !matches!(seed_mode.as_str(), "random" | "fixed") {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "seedMode '{seed_mode}' is outside the closed vocabulary random|fixed"
        )));
    }
    let seed_mode_source = dial_source(fields, "seedMode");
    let (seed, seed_value_source) = match seed_request {
        Some(value) => {
            let seed = value
                .as_u64()
                .filter(|seed| *seed <= MAX_SEED)
                .ok_or_else(|| {
                    ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                        "seed must be an integer 0..={MAX_SEED} (the stock compiler's JSON-safe range)"
                    ))
                })?;
            (json!(seed), Tier::Request.word())
        }
        None if seed_mode == "fixed" => {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
                "seedMode is fixed but no seed was supplied; send \"seed\" in the request or set seedMode random",
            ));
        }
        None => (json!(draw_seed()), Tier::Floor.word()),
    };
    Ok((seed, seed_mode, seed_mode_source, seed_value_source))
}

/// A family-key refusal: the key and the stock-side reason carried in the hint.
struct FamilyRefusal(&'static str, &'static str);

/// The keys this family refuses, as (key, reason) pairs.
fn family_key_refusals(family: &str) -> Vec<FamilyRefusal> {
    FAMILY_KEY_REFUSALS
        .iter()
        .filter(|(declared, _, _)| *declared == family)
        .flat_map(|(_, keys, reason)| keys.iter().map(move |key| FamilyRefusal(key, reason)))
        .collect()
}

/// Ladder dials a mode or family law removes from the emitted intent, as (field, reason).
fn mode_dial_drops(
    spec: &ModeSpec,
    refusals: &[FamilyRefusal],
) -> Vec<(&'static str, &'static str)> {
    let mut drops: Vec<(&'static str, &'static str)> = Vec::new();
    // compile demands `inputImage` and `denoise` together: a mode that forbids the input
    // image can never carry the dial, whatever tier supplied it.
    if spec.forbids.contains(&"inputImage") {
        drops.push((
            "denoise",
            "the mode has no inputImage, and the stock compiler pairs denoise with inputImage",
        ));
    }
    drops.extend(
        refusals
            .iter()
            .filter(|refusal| DIAL_NAMES.contains(&refusal.0))
            .map(|refusal| (refusal.0, refusal.1)),
    );
    drops
}

/// The modes this build can actually run for `family` — the same law the door enforces in
/// [`check_family_supports`], read as data for `GET /v1/families` (API-DESIGN §12 resolved-5:
/// the closed mode vocabulary is served per family, no alias layer). Deferred modes
/// (no leg built) are excluded: a family's list answers what `POST /v1/queue` accepts now.
pub(crate) fn runnable_modes(family: &str) -> Vec<&'static str> {
    if !defaults::is_known_family(family) {
        return Vec::new();
    }
    let declared = defaults::builtin_pipelines(family);
    let video_family = crate::jobs_video::FAMILIES.contains(&family);
    MODE_SPECS
        .iter()
        .filter(|spec| match spec.target {
            ModeTarget::Image => {
                !crate::model_families::video_only(family) && pipeline_gate(spec, declared)
            }
            ModeTarget::Video => video_family && pipeline_gate(spec, declared),
            // LEG M14b opened the ACE-Step half of the music arm: a family is
            // served when it passes the t2m gate AND has a compile arm — the YuE2
            // row or a `music`-profile row. The surface still cannot promise a mode
            // the queue door would refuse.
            ModeTarget::Music => {
                pipeline_gate(spec, declared)
                    && (family == MUSIC_YUE2_FAMILY || is_ace_music_family(family))
            }
            // E28 (LEG AF2-M24c): the RefMod export row is runnable exactly for
            // its one family — the same H3-only law `fill_refmod` enforces, read
            // as data here so `GET /v1/families` never promises a mode the queue
            // door would refuse (and never omits one it accepts).
            ModeTarget::RefmodExport => family == REFMOD_FAMILY,
            ModeTarget::Deferred { .. } => false,
        })
        .map(|spec| spec.mode)
        .collect()
}

/// The mode's pipeline-word gate over the family's declared pipelines.
fn pipeline_gate(spec: &ModeSpec, declared: &[String]) -> bool {
    spec.pipelines.is_empty()
        || spec
            .pipelines
            .iter()
            .any(|word| declared.iter().any(|have| have == word))
}

/// The family-side gates for an image mode: video-only families fail closed, families that
/// declare none of the mode's pipeline words cannot run it.
fn check_family_supports(family: &str, spec: &ModeSpec) -> Result<(), ApiError> {
    if crate::model_families::video_only(family) {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "family '{family}' declares no image pipeline ({}); it exists only as a video recipe",
            defaults::builtin_pipelines(family).join("|")
        )));
    }
    if spec.pipelines.is_empty() {
        return Ok(());
    }
    let declared = defaults::builtin_pipelines(family);
    if !spec
        .pipelines
        .iter()
        .any(|word| declared.iter().any(|have| have == word))
    {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "family '{family}' declares pipelines [{}]; mode '{}' needs one of {}",
            declared.join(","),
            spec.mode,
            spec.pipelines.join("|")
        )));
    }
    Ok(())
}

/// The family-side gates for a video-mode arm (`ref2va` / `video`, LEG M9c): the
/// family must be one of the four video-recipe families and must declare one of the
/// mode's pipeline words. Families outside the video plugin answer `modeUnsupported`
/// naming the closed four.
fn check_video_family(family: &str, spec: &ModeSpec) -> Result<(), ApiError> {
    if !crate::jobs_video::FAMILIES.contains(&family) {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "mode '{}' compiles through the video recipe (recipeId '{VIDEO_RECIPE_ID}'); its families are {}, '{family}' is not one",
            spec.mode,
            crate::jobs_video::FAMILIES.join("|")
        )));
    }
    let declared = defaults::builtin_pipelines(family);
    if !pipeline_gate(spec, declared) {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "family '{family}' declares pipelines [{}]; mode '{}' needs one of {}",
            declared.join(","),
            spec.mode,
            spec.pipelines.join("|")
        )));
    }
    Ok(())
}

/// The E16 reference arrays a video-mode request carries (folded canonical arrays,
/// already path-placed by the door's uploads seam).
#[derive(Default)]
struct ReferenceArrays {
    images: Vec<String>,
    videos: Vec<RefEntry>,
    audio: Vec<RefEntry>,
}

/// One reference-lane entry as the video door reads it: a placement name, optionally
/// decorated with the stock `h3.media` trim pair (`trimStart`/`trimEnd`, seconds,
/// finite `0..=3600`, `trimStart < trimEnd` — the `validate_h3_media` law mirrored at
/// the door; the 2–15 s clip-duration wall deliberately stays stock-side at prepare,
/// where it counts the TRIMMED span). Plain reference strings ride the same lane
/// undecorated; the music and refmod arms keep `read_reference_array` (string-only).
#[derive(Clone)]
pub(crate) struct RefEntry {
    file: String,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
}

/// A plain (undecorated) reference entry — the shape the string-only lanes and
/// the refmod door hand to [`lane_media_items`].
pub(crate) fn plain_entry(file: String) -> RefEntry {
    RefEntry {
        file,
        trim_start: None,
        trim_end: None,
    }
}

/// The stock compiler's private `grid(family)` law mirrored as data: canvas
/// multiple, frame step, frame offset — EmptyLTXVLatentVideo /32 and 8k+1, Wan /16
/// and 4k+1, H3 /32 and 17k+5. The door mirrors the table rather than widening the
/// stock fn (no stock edits); a law-named test pins the three rows.
static VIDEO_GRIDS: [(&str, u64, u64, u64); 3] =
    [("ltx-2", 32, 8, 1), ("wan", 16, 4, 1), ("h3", 32, 17, 5)];

fn video_grid(family: &str) -> (u64, u64, u64) {
    let word = if crate::jobs_video::is_h3(family) {
        "h3"
    } else {
        family
    };
    VIDEO_GRIDS
        .iter()
        .find(|(name, ..)| *name == word)
        .map_or((32, 8, 1), |(_, multiple, step, offset)| {
            (*multiple, *step, *offset)
        })
}

/// One `video` block number from the bundled family plugin (`fps`, `seconds`): the
/// honest completion floor for `frameRate` and `frames`, same plugin the ladder's
/// stock tier reads.
fn builtin_video_number(family: &str, key: &str) -> Option<f64> {
    defaults::builtin_view()
        .as_array()?
        .iter()
        .find(|entry| entry["id"] == family)?
        .get("video")?
        .get(key)?
        .as_f64()
}

/// Expands a `ref2va` or `video` request into a video-recipe plan: the §6 ladder
/// over the family, the E16 reference arrays built into the stock media/reference
/// shapes, the family block, and the door-side gates the stock compiler would
/// otherwise discover later (canvas grid, steps and step choices, sampler identity,
/// file grammars, the Triton prereq).
/// §12.1 dials/prereqs for every arm. A `torch.compile` path is Triton-gated stock-side:
/// `recipe_prerequisites:518` builds `allowlist.compile` from the compiled graph's
/// `TorchCompileModel` nodes, and the prepare stage refuses a backend the owned
/// environment does not admit (`jobs.rs:1820` reads that allowlist). This staged door
/// cannot read the owned environment's Triton fact, so it answers honestly by the cause
/// BEFORE the intent reaches the card. `options` is a ladder dial, so the gate reads the
/// RESOLVED field: whichever tier supplied `compile` — request dials, sheet combo,
/// family or global — the answer is the same.
///
/// LEG M14a hoisted this out of `fill_video`, which was the only arm enforcing it: an
/// image intent carrying `options.compile` passed the door and met the allowlist wall at
/// prepare — the invisible-refusal class LEG M11 exists to close. Pinned by
/// `intent_truth::the_options_bag_rides_its_tier_to_the_stock_option_nodes_with_stock_value_classes`
/// and `fill_plane::tests::triton_gated_compile_option_answers_the_prereq_cause`.
fn check_triton_gated_compile(spec: &ModeSpec, fields: &[ResolvedField]) -> Result<(), ApiError> {
    if dial_value(fields, "options").is_some_and(|options| options.get("compile").is_some()) {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "mode '{}': options.compile is a torch.compile path gated by the owned environment's Triton prerequisite (stock recipe_prerequisites / allowlist.triton); this door cannot prove Triton, so it refuses by the cause; drop options.compile to queue the recipe",
            spec.mode
        )));
    }
    Ok(())
}

fn fill_video(
    spec: &ModeSpec,
    family: &str,
    request_dials: Option<&Dials>,
    sheet: &DefaultsSheet,
    request_extras: Option<&Map<String, Value>>,
) -> Result<IntentPlan, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let ref2va = spec.mode == "ref2va";
    let mut fields = defaults::resolve(Some(family), Some(spec.mode), request_dials, sheet);
    let mut extras = Map::new();
    let mut slots = Slots::default();
    let mut seed_request: Option<&Value> = None;
    let mut references = ReferenceArrays::default();
    let mut request_block: Option<Map<String, Value>> = None;
    let mut request_refmods: Option<Value> = None;
    let block_key = crate::jobs_video::block(family);

    for (key, value) in request_extras.into_iter().flatten() {
        if DIAL_NAMES.contains(&key.as_str()) {
            return Err(invalid(format!(
                "'{key}' is a dial; send it in the dials block, not beside it"
            )));
        }
        if key == "family" {
            return Err(invalid(
                "the family is the request's family field; the fill plane writes the intent's family key"
                    .to_owned(),
            ));
        }
        match key.as_str() {
            "checkpoint" | "positivePrompt" | "outputPrefix" | "diffusion" => {
                read_slot(key, value, &mut slots)?;
            }
            "seed" => seed_request = Some(value),
            "images" => references.images = read_reference_array(key, value)?,
            "videos" => references.videos = read_reference_entries(key, value)?,
            "audio" => references.audio = read_reference_entries(key, value)?,
            "refmods" => request_refmods = Some(value.clone()),
            "frames" => push_integer_field(&mut fields, "frames", value, Tier::Request.word())?,
            "frameRate" => {
                push_number_field(&mut fields, "frameRate", value, Tier::Request.word())?;
            }
            other if other == block_key => {
                request_block = Some(value.as_object().cloned().ok_or_else(|| {
                    invalid(format!(
                        "'{block_key}' must be an object: the {family} recipe block"
                    ))
                })?);
            }
            other if ["ltx", "wan", "h3"].contains(&other) => {
                return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
                    "'{other}' is another family's recipe block; family '{family}' carries '{block_key}'"
                )));
            }
            other if VIDEO_PASSTHROUGH_KEYS.contains(&other) => {
                check_video_passthrough_shape(other, family, value)?;
                extras.insert(key.clone(), value.clone());
            }
            other => {
                return Err(invalid(format!(
                    "'{other}' is not an intent key the '{}' door accepts; the closed set is the video recipe's optional keys {}, the slots {SLOT_KEYS:?}, the control keys seed/frames/frameRate, the reference arrays images/videos/audio, the 'refmods' bag and the '{block_key}' block",
                    spec.mode,
                    VIDEO_PASSTHROUGH_KEYS.join(", ")
                )));
            }
        }
    }

    // §12.1 dials/prereqs: one home for every arm (LEG M14a hoisted the gate out of
    // this arm, where it was the only copy).
    check_triton_gated_compile(spec, &fields)?;

    // Required-field completion the ladder cannot supply: `frameRate` and `frames`
    // floor from the bundled plugin's `video` block (fps, seconds), rounded up to
    // the family's latent grid — the plugin is the same stock tier the ladder reads.
    if dial_value(&fields, "frameRate").is_none() {
        if let Some(fps) = builtin_video_number(family, "fps") {
            fields.push(ResolvedField {
                field: "frameRate",
                source: Tier::Stock.word(),
                value: json!(fps),
            });
        }
    }
    if dial_value(&fields, "frames").is_none() {
        if let (Some(fps), Some(seconds)) = (
            builtin_video_number(family, "fps"),
            builtin_video_number(family, "seconds"),
        ) {
            let (_, step, offset) = video_grid(family);
            let target = (fps * seconds) as u64;
            let frames = target.saturating_sub(offset).div_ceil(step) * step + offset;
            fields.push(ResolvedField {
                field: "frames",
                source: Tier::Stock.word(),
                value: json!(frames),
            });
        }
    }
    check_video_ranges(family, &fields)?;
    check_latent_upscale_canvas(family, &fields, &extras)?;

    // The family block: ltx/wan ride the request verbatim (their value laws are the
    // stock compiler's); h3 gets the door-built mode, media and reference legs.
    let block = if crate::jobs_video::is_h3(family) {
        build_h3_block(
            family,
            ref2va,
            request_block,
            &references,
            request_refmods.as_ref(),
        )?
    } else {
        let Some(block) = request_block else {
            return Err(invalid(format!(
                "'{block_key}' is required: {}",
                block_shape_hint(family)
            )));
        };
        Value::Object(block)
    };
    extras.insert(block_key.to_owned(), block);

    let (seed, seed_mode, seed_mode_source, seed_value_source) =
        resolve_seed(&fields, seed_request)?;
    let plan = IntentPlan {
        family: family.to_owned(),
        mode: spec.mode,
        fields,
        seed,
        seed_mode,
        seed_mode_source,
        seed_value_source,
        extras,
        slots,
        dropped: Vec::new(),
        recipe_id: VIDEO_RECIPE_ID,
        recipe_version: VIDEO_RECIPE_VERSION,
        key_law: KeyLaw::Video,
    };
    Ok(plan)
}

/// The block shape the stock compiler's own refusal text names, quoted in the door
/// hint so the request can fix it without a compile round-trip.
fn block_shape_hint(family: &str) -> &'static str {
    match family {
        "ltx-2" => "ltx: {textProjection, audioVae, passes 1-3, spatialUpscaler exactly when passes > 1, keyframes?, sourceStrength?}",
        "wan" => "wan: {lowModel, shiftHigh, shiftLow, refinerStep below steps}",
        _ => "h3: {mode, audioVae, shiftVideo, shiftAudio, inputScaling?, continuity?, transition?}",
    }
}

fn read_reference_array(key: &str, value: &Value) -> Result<Vec<String>, ApiError> {
    // String-only lanes (images everywhere, all three arrays on the music
    // recipes): an entry OBJECT is refused here, whatever it carries — the
    // object shape decorates only the video recipe's videos/audio lanes.
    if let Some(items) = value.as_array() {
        if let Some(obj) = items.iter().find(|item| !item.is_string()) {
            let decorated = obj.get("trimStart").is_some() || obj.get("trimEnd").is_some();
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(if decorated {
                format!(
                    "'{key}' references are plain placement names; trimStart/trimEnd decorate only the video recipe's videos/audio lanes"
                )
            } else {
                format!(
                    "'{key}' references are plain placement names; {{file, trimStart?, trimEnd?}} entry objects decorate only the video recipe's videos/audio lanes"
                )
            }));
        }
    }
    read_reference_entries(key, value)?
        .into_iter()
        .map(|entry| Ok(entry.file))
        .collect()
}

/// The video-lane reader: entries are a placement name OR the decorated object
/// `{file, trimStart?, trimEnd?}`; every file passes the same placement grammar as a
/// plain string. Trim numbers mirror the stock `validate_h3_media` wall verbatim
/// (finite, `0..=3600`, `trimStart < trimEnd`); the mediaMode word stays UI-only.
fn read_reference_entries(key: &str, value: &Value) -> Result<Vec<RefEntry>, ApiError> {
    let items = value.as_array().ok_or_else(|| {
        ApiError::new(ErrorKind::BodyInvalid)
            .with_hint(format!("'{key}' must be an array of reference strings or {{file, trimStart?, trimEnd?}} objects"))
    })?;
    items
        .iter()
        .map(|item| {
            if let Some(text) = item.as_str() {
                if text.trim().is_empty() {
                    return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                        "every '{key}' entry must be a non-empty reference string or {{file, trimStart?, trimEnd?}} object"
                    )));
                }
                return Ok(RefEntry {
                    file: text.to_owned(),
                    trim_start: None,
                    trim_end: None,
                });
            }
            let obj = item.as_object().ok_or_else(|| {
                ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                    "every '{key}' entry must be a non-empty reference string or {{file, trimStart?, trimEnd?}} object"
                ))
            })?;
            let unknown = obj
                .keys()
                .find(|k| !["file", "trimStart", "trimEnd"].contains(&k.as_str()))
                .cloned();
            if let Some(k) = unknown {
                return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                    "'{k}' is not a reference-entry key; the closed set is file, trimStart?, trimEnd? (seconds, 0..=3600, trimStart < trimEnd - the stock trim law)"
                )));
            }
            let file = obj
                .get("file")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                        "a '{key}' entry object needs a non-empty \"file\" placement name"
                    ))
                })?;
            let trim = |name: &str| -> Result<Option<f64>, ApiError> {
                match obj.get(name) {
                    None | Some(Value::Null) => Ok(None),
                    Some(v) => v
                        .as_f64()
                        .filter(|n| n.is_finite() && (0.0..=3600.0).contains(n))
                        .map(Some)
                        .ok_or_else(|| {
                            ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                                "'{name}' must be a finite number of seconds in 0..=3600 (the stock trim law)"
                            ))
                        }),
                }
            };
            let trim_start = trim("trimStart")?;
            let trim_end = trim("trimEnd")?;
            if let (Some(a), Some(b)) = (trim_start, trim_end) {
                if a >= b {
                    return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
                        "trimStart must come before trimEnd (the stock trim law)".to_owned(),
                    ));
                }
            }
            Ok(RefEntry {
                file: file.to_owned(),
                trim_start,
                trim_end,
            })
        })
        .collect()
}

fn push_number_field(
    fields: &mut Vec<ResolvedField>,
    name: &'static str,
    value: &Value,
    source: &'static str,
) -> Result<(), ApiError> {
    let number = value
        .as_f64()
        .filter(|value| finite(*value))
        .ok_or_else(|| {
            ApiError::new(ErrorKind::BodyInvalid)
                .with_hint(format!("{name} must be a finite number"))
        })?;
    fields.push(ResolvedField {
        field: name,
        source,
        value: json!(number),
    });
    Ok(())
}

/// Like [`push_number_field`] for keys the video recipe types `u64`: stock reads them
/// through `as_u64()` (`int` closure, jobs_video.rs:1430), which answers `None` for a
/// float even when the value is integral — so an integral value must EMIT as a JSON
/// integer (M11b: a request `frames:124` landed `124.0` through the f64 path and the
/// stock compiler refused its own accepted number). A fractional value is refused
/// here by the cause; the frame-grid gate refuses it too.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn push_integer_field(
    fields: &mut Vec<ResolvedField>,
    name: &'static str,
    value: &Value,
    source: &'static str,
) -> Result<(), ApiError> {
    let number = value
        .as_f64()
        .filter(|value| finite(*value) && value.fract() == 0.0 && *value >= 0.0)
        .ok_or_else(|| {
            ApiError::new(ErrorKind::BodyInvalid)
                .with_hint(format!("{name} must be a non-negative integer"))
        })?;
    fields.push(ResolvedField {
        field: name,
        source,
        value: json!(number as u64),
    });
    Ok(())
}

/// The door's video pixel-frame budget: `width * height * frames` in
/// pixels-frames, 4,294,967,296 (4.3e9 — a 1024x1024 x 4096-frame film, or a
/// 4096x4096 x 256-frame film). Chosen CONSERVATIVE, and deliberately below what
/// the per-frame laws already admit: edges 8..=8192, product 16.7M and frames
/// 1..=3600 together allow e.g. 4096x4096 x 3600 frames, whose decoded float32
/// RGB batches (`host_memory::pixel_batches`, 12 bytes per pixel-frame plus the
/// post-upscale decode) would ask for ~800 GiB of host RAM — a full-frame decode
/// of that size is the host-OOM class the drain estimator already refuses, so the
/// door refuses the request up front instead of queueing a doomed row.
pub(crate) const MAX_VIDEO_PIXEL_FRAMES: u64 = 4_294_967_296;

/// The door-side value gates the stock video validator runs before its family
/// block: canvas grid, frame grid, frameRate/cfg ranges, the 1..=150 steps gate,
/// the per-family step choices and pinned sampler (`model_families::video_recipe`,
/// read-only), and the sampler/scheduler grammar (free strings, empty refused).
fn check_video_ranges(family: &str, fields: &[ResolvedField]) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let (multiple, step, offset) = video_grid(family);
    let number = |field: &str| dial_value(fields, field).and_then(|value| value.as_f64());
    let integer = |field: &str| {
        number(field)
            .filter(|value| value.fract() == 0.0)
            .map(|value| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let as_int = value as u64;
                as_int
            })
    };
    for field in ["width", "height"] {
        let Some(edge) = integer(field).filter(|edge| (8..=8192).contains(edge)) else {
            return Err(invalid(format!(
                "{field} must be an integer 8..=8192 for the video recipe; supply it in the dials block or the sheet"
            )));
        };
        if edge % multiple != 0 {
            return Err(invalid(format!(
                "{field} {edge} must be a multiple of {multiple} for family '{family}'"
            )));
        }
    }
    let width = integer("width").expect("gated above");
    let height = integer("height").expect("gated above");
    if width * height > 16_777_216 {
        return Err(invalid(
            "the video canvas exceeds the 16.7M pixel ceiling".to_owned(),
        ));
    }
    let Some(frames) = integer("frames").filter(|frames| (offset.max(1)..=3600).contains(frames))
    else {
        return Err(invalid(format!(
            "frames must be an integer {}..=3600; supply it in the request",
            offset.max(1)
        )));
    };
    if (frames - offset) % step != 0 {
        return Err(invalid(format!(
            "frames {frames} must be {step}k+{offset} for family '{family}' (the latent grid law)"
        )));
    }
    // The frames-x-pixels budget (the per-frame laws bound each factor; only their
    // product bounds the decode): see [`MAX_VIDEO_PIXEL_FRAMES`] for the choice.
    let pixel_frames = width.saturating_mul(height).saturating_mul(frames);
    if pixel_frames > MAX_VIDEO_PIXEL_FRAMES {
        return Err(invalid(format!(
            "the film exceeds the {} pixels-frames budget ({width}x{height} x {frames} frames = {pixel_frames}); lower frames or the canvas (the decode would cross host memory — see the host-memory budget law)",
            MAX_VIDEO_PIXEL_FRAMES
        )));
    }
    if !number("frameRate").is_some_and(|value| (1.0..=120.0).contains(&value)) {
        return Err(invalid("frameRate must be a number 1..=120".to_owned()));
    }
    if !number("cfg").is_some_and(|value| (0.0..=30.0).contains(&value)) {
        return Err(invalid("cfg must be a number 0..=30".to_owned()));
    }
    let Some(steps) = integer("steps").filter(|steps| (1..=150).contains(steps)) else {
        return Err(invalid("steps must be an integer 1..=150".to_owned()));
    };
    let recipe = crate::model_families::video_recipe(family);
    if !recipe.step_choices.is_empty() && !recipe.step_choices.contains(&steps) {
        let allowed = recipe
            .step_choices
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join("/");
        return Err(invalid(format!(
            "Invalid steps: {family} only samples {allowed}"
        )));
    }
    if let Some(fixed) = recipe.fixed_sampler {
        if dial_value(fields, "sampler")
            .and_then(|value| value.as_str().map(str::to_owned))
            .as_deref()
            != Some(fixed)
        {
            return Err(invalid(format!(
                "Invalid sampler: {family} runs {fixed} only"
            )));
        }
    }
    for field in ["sampler", "scheduler"] {
        if !dial_value(fields, field)
            .is_some_and(|value| value.as_str().is_some_and(crate::jobs::safe_choice))
        {
            return Err(invalid(format!(
                "{field} must be a non-empty safe choice word (alphanumerics and _. -)"
            )));
        }
    }
    Ok(())
}

/// The per-key grammars for the video passthrough bag: cheap identifier and shape
/// checks whose refusals read better than the compiler's, plus the family gates the
/// stock validator pins (sourceVideo is LTX; latentUpscale runs ltx-2 and
/// minimax-h3; faceRefine runs on H3). The value vocabularies stay the compiler's.
fn check_video_passthrough_shape(key: &str, family: &str, value: &Value) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let mode_unsupported = |hint: String| ApiError::new(ErrorKind::ModeUnsupported).with_hint(hint);
    match key {
        "dials" => {
            // The H3 Dial Rack (LEG M12). Stock-side, `validate_dials` gates the
            // family and the row count, and `validate_dial_row` each row; the
            // family/count walls are private to jobs_video, so this arm mirrors
            // them from the same constant homes and calls the stock row validator
            // directly — no restated row rules.
            if !crate::jobs_video::is_h3(family) {
                return Err(mode_unsupported(format!(
                    "'dials' is the experimental Dial Rack; stock runs it on MiniMax H3 video only (family '{family}' has no rack)"
                )));
            }
            let rows = value.as_array().ok_or_else(|| {
                invalid("dials must be a list of rack rows {dial, strength, on?, time?}".to_owned())
            })?;
            if rows.len() > crate::jobs_video::DIAL_ROWS {
                return Err(invalid(format!(
                    "dials: a list of at most {} rows",
                    crate::jobs_video::DIAL_ROWS
                )));
            }
            for row in rows {
                crate::jobs_video::validate_dial_row(row).map_err(invalid)?;
            }
        }
        "sourceVideo" => {
            if family != "ltx-2" {
                return Err(mode_unsupported(format!(
                    "'sourceVideo' is a top-level LTX input; family '{family}' has no source-video leg"
                )));
            }
            if !value
                .as_str()
                .is_some_and(|name| crate::jobs::model_name(name) && !name.contains('/'))
            {
                return Err(invalid(
                    "sourceVideo must name a top-level input video (no directory)".to_owned(),
                ));
            }
        }
        "firstFrame" | "lastFrame" => {
            if !value.as_str().is_some_and(crate::jobs::model_name) {
                return Err(invalid(format!("{key} must name an uploaded input image")));
            }
        }
        "streamDecode" => {
            if value != &json!(true) {
                return Err(invalid("streamDecode must be true or omitted".to_owned()));
            }
            if !crate::jobs_video::is_h3(family) {
                return Err(mode_unsupported(format!(
                    "'streamDecode' requires MiniMax H3 latent upscale; family '{family}' has no stream leg"
                )));
            }
        }
        "latentUpscale" => {
            if !matches!(family, "ltx-2" | "minimax-h3") {
                return Err(mode_unsupported(format!(
                    "'latentUpscale' runs on ltx-2 and minimax-h3; the stock compiler refuses it for '{family}'"
                )));
            }
            if !value.is_object() {
                return Err(invalid("latentUpscale must be an object".to_owned()));
            }
            // The scale range law mirrored from `jobs_video::validate_latent_upscale`
            // (ltx-2 pins scale exactly 2; minimax-h3 admits a finite 1..=8 unless
            // Hi-Res Regenerate replaces the settings). The RESULT-canvas law rides
            // `check_latent_upscale_canvas` after the ladder, where the merged dials
            // are known.
            let upscale = value.as_object().expect("gated above");
            if upscale.get("regenerate").is_some() {
                return Ok(());
            }
            let scale = upscale["scale"].as_f64();
            if family == "ltx-2" {
                if scale != Some(2.0) {
                    return Err(invalid(
                        "latentUpscale.scale: ltx-2 upscales by exactly 2 (the stock law)"
                            .to_owned(),
                    ));
                }
            } else if !scale.is_some_and(|scale| scale.is_finite() && (1.0..=8.0).contains(&scale))
            {
                return Err(invalid(
                    "latentUpscale.scale must be a finite number 1..=8 (the stock minimax-h3 law)"
                        .to_owned(),
                ));
            }
        }
        "faceRefine" => {
            if !crate::jobs_video::is_h3(family) {
                return Err(mode_unsupported(format!(
                    "'faceRefine' runs on MiniMax H3; family '{family}' has no face pass"
                )));
            }
            if !value.is_object() {
                return Err(invalid("faceRefine must be an object".to_owned()));
            }
        }
        "videoPost" => {
            if !value.is_object() {
                return Err(invalid("videoPost must be an object".to_owned()));
            }
            // The TVE stage law is stock's own (`jobs_video_post::validate`, called by
            // the video arm's `validate`), so the door CALLS the stock predicate rather
            // than mirroring its tables — the direct-law pattern the `output` block and
            // the dial rack use. Without it a malformed stage (an empty block, a
            // misspelled one) passes the door and lands as a prepare-time stock refusal
            // on the owned card: the M11 invisible-refusal class.
            if let Err(problem) = crate::jobs_video_post::validate(value) {
                return Err(invalid(problem));
            }
        }
        "enhancedPreview" => {
            if !value.is_object() {
                return Err(invalid("enhancedPreview must be an object".to_owned()));
            }
        }
        "output" => {
            // The combine block (LEG M13): stock validates it through `valid_output`
            // (jobs_video.rs:209) inside `validate`, which `compile` calls (jobs_video
            // .rs:1477) — so the law is compile-side, and the door now mirrors it by
            // CALLING THE STOCK PREDICATE, the same direct-law pattern the dial rack
            // uses with `validate_dial_row`. The block is all-keys or absent: a partial
            // `output` fails stock too, and the absent case rides the `effective_
            // output` defaults (codec/container/bitDepth/audioCodec Auto, quality 20,
            // audioBitrate 192k, both frame saves false) into node 7.
            if !value.is_object() {
                return Err(invalid("output must be an object".to_owned()));
            }
            if !crate::jobs_video::valid_output(value) {
                return Err(invalid(format!(
                    "output follows the stock combine law verbatim: codec {} container {} bitDepth {} quality 0..=51 audioCodec {} audioBitrate {} saveFirstFrame/saveLastFrame booleans; imageFormat png|webp and imageCompression 0..=100 optional — every required key present",
                    crate::jobs_video::CODECS.join("|"),
                    crate::jobs_video::CONTAINERS.join("|"),
                    crate::jobs_video::BIT_DEPTHS.join("|"),
                    crate::jobs_video::AUDIO_CODECS.join("|"),
                    crate::jobs_video::AUDIO_BITRATES.join("|"),
                )));
            }
        }
        "chunks" => {
            if !value.as_u64().is_some_and(|n| (2..=16).contains(&n)) {
                return Err(invalid("chunks must be an integer 2..=16".to_owned()));
            }
        }
        "audioEnhance" => {
            // The stock audio wrapper (LEG M15): the door calls the stock shape
            // law itself — `audio_post::settings` (jobs_audio_post.rs:13-32,
            // widened pub(crate) visibility-only, the M11 refmod-mod precedent)
            // is the single home for {mode: clean|deep|stems, profile: mix|
            // speech} plus the deep-is-speech-only law, and its strings ride
            // the refusal verbatim. The recipeId gate ("AUDIO_INTENT" — video
            // or music only) can never fire on this arm: the video recipe is
            // inside the stock allowed set. The stage itself is NOT graph
            // side: compile strips the key (jobs.rs:448-451), the native
            // post-render chain consumes it off the plan intent
            // (jobs.rs:2131/2218/2387) and labels its product `processed`
            // (jobs_outputs.rs:431) — a word the M9g output descriptors
            // already surface, so the enhanced artifact stays discoverable
            // through /v1/outputs. The music recipe is stock-legal for the
            // wrapper but stays closed door-side: the music arms run their
            // own strict extras law (the ACE pin refuses this key), opening
            // it would re-forge that extras set — a music-leg ruling, not
            // this arm's.
            let probe = json!({"recipeId": VIDEO_RECIPE_ID, "audioEnhance": value});
            crate::jobs::audio_post::settings(&probe).map_err(invalid)?;
        }
        "loras" => check_passthrough_shape("loras", value)?,
        "options" => {
            if !crate::jobs::valid_options(value) {
                return Err(invalid(
                    "options: attention|sage|cache|compile|vaeTile, one attention patch only"
                        .to_owned(),
                ));
            }
        }
        other => unreachable!("VIDEO_PASSTHROUGH_KEYS holds only gated keys: {other}"),
    }
    Ok(())
}

/// Builds the `h3` block: the door writes `mode`, `media` (ref2va) or
/// `references` (video modes), and `refmods`; the request carries the rest
/// (`audioVae`, `shiftVideo`, `shiftAudio`, `inputScaling?`, `continuity?`,
/// `transition?`). The stock `validate_h3` law is the model, mirrored exactly for
/// the parts the door builds.
fn build_h3_block(
    family: &str,
    ref2va: bool,
    request_block: Option<Map<String, Value>>,
    references: &ReferenceArrays,
    request_refmods: Option<&Value>,
) -> Result<Value, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let mut h3 = request_block.unwrap_or_default();
    // AF2-M30: the stock closed h3 key set at the door — the M25a/M15 single-home
    // pattern, not a restatement. The law has ONE home,
    // `crate::jobs_video::H3_KEYS` (the ten words `validate_h3`'s `keys_in` arm
    // gates on); this wall only widens stock visibility. The live gap: row
    // `cb46b38f-cf7e-471d-ad05-2f90e3646706` carried `durationSeconds` at h3 top
    // level (it belongs inside `h3.continuity`, and only when continuity is
    // present); the door queued it, stock prepare refused it as prepareRefused and
    // burned the poison-row guard (three submit-side failures abort the whole
    // drain). Offenders are collected deterministically (sorted by name) and the
    // whole block is refused in one answer naming every offender and the closed
    // set verbatim. This wall runs FIRST, before the media/references built-by-
    // door refusals below: `media` and `references` are members of the closed set,
    // so they can never trip it and their shipped strings stay untouched.
    let mut unknown: Vec<&str> = h3
        .keys()
        .filter(|key| !crate::jobs_video::H3_KEYS.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        let mut hint = format!(
            "h3 top-level keys {} are outside the closed set {}",
            unknown
                .iter()
                .map(|key| format!("'h3.{key}'"))
                .collect::<Vec<_>>()
                .join(", "),
            crate::jobs_video::H3_KEYS.join("|")
        );
        if unknown.contains(&"durationSeconds") {
            hint +=
                "; durationSeconds belongs inside h3.continuity (only when continuity is present)";
        }
        return Err(invalid(hint));
    }
    for owned in ["media", "references"] {
        if h3.contains_key(owned) {
            return Err(invalid(format!(
                "'h3.{owned}' is built by the door from the reference arrays (images/videos/audio, pictureN/videoN/audioN); do not send it"
            )));
        }
    }
    let mode = if ref2va {
        if h3.contains_key("mode") {
            return Err(invalid(
                "'h3.mode': mode ref2va always runs REF2VA; the door writes it".to_owned(),
            ));
        }
        "REF2VA".to_owned()
    } else {
        let mode = h3
            .remove("mode")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| {
                invalid(
                    "'h3.mode' is required for this family: T2VA|I2VA|L2VA|FL2VA (REF2VA runs under mode ref2va)"
                        .to_owned(),
                )
            })?;
        if mode == "REF2VA" {
            return Err(invalid(
                "'h3.mode' REF2VA belongs to mode ref2va; send mode ref2va".to_owned(),
            ));
        }
        if !VIDEO_H3_MODES.contains(&mode.as_str()) {
            return Err(invalid(format!(
                "'h3.mode' '{mode}' is outside the pinned vocabulary {}",
                VIDEO_H3_MODES.join("|")
            )));
        }
        mode
    };
    h3.insert("mode".to_owned(), json!(mode));
    // The stock h3 fields the door cannot fabricate: model identity and the shift
    // pair, exact ranges mirrored from `validate_h3`.
    if !h3
        .get("audioVae")
        .is_some_and(|value| value.as_str().is_some_and(crate::jobs::comfy_model_name))
    {
        return Err(invalid(
            "'h3.audioVae' is required: a listed ComfyUI model name".to_owned(),
        ));
    }
    for key in ["shiftVideo", "shiftAudio"] {
        if !h3
            .get(key)
            .is_some_and(|value| value.as_f64().is_some_and(|n| (0.01..=100.0).contains(&n)))
        {
            return Err(invalid(format!(
                "'h3.{key}' is required: a number 0.01..=100"
            )));
        }
    }
    // AF2-M25a: the stock continuity law at the door - the M15 `validate_refmods`
    // pattern below, not a restatement. The row law has ONE home,
    // `crate::jobs_video::validate_continuity` (extracted verbatim from
    // `validate_h3`'s `cont_ok` arm); this wall only widens stock visibility. A
    // grammar-bad `h3.continuity` that rides through the door dies at stock
    // prepare as prepareRefused and burns the poison-row guard (three
    // submit-side failures abort the whole drain): the door refuses it here as
    // bodyInvalid, the single home's answer strings riding the hint verbatim.
    // The mirror covers the per-object facts; the durationSeconds mode/c_source
    // interlock stays stock-side authority - the door may not know the whole
    // intent, only this request block - and `mode` is already resolved into
    // `h3` at this point, so the door's verdict is exactly what stock prepare
    // would reach for the same row. Stock's own answer words never change.
    if h3.contains_key("continuity") {
        crate::jobs_video::validate_continuity(&Value::Object(h3.clone())).map_err(invalid)?;
    }
    if ref2va {
        let media = build_media(family, references, request_refmods.is_some())?;
        h3.insert("media".to_owned(), media);
    } else {
        if let Some(built) = build_h3_references(&mode, &references.images)? {
            h3.insert("references".to_owned(), built);
        }
    }
    if let Some(rows) = request_refmods {
        if !ref2va {
            return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(
                "'refmods' belongs to mode ref2va on the MiniMax H3 families (stock: h3.refmods belong to REF2VA)",
            ));
        }
        // LEG M15: stock law at the door, the M13 `valid_output` pattern. The row
        // law lives in ONE home — `validate_refmods` (jobs_video.rs:1035, called
        // by `validate_h3` at :926-927): 1-8 rows, unique slots 1-8, a library
        // name that is not None/(none), strength (0, 1], description <= 2000
        // chars, closed row keys. The fn was private like its parent; widened
        // pub(crate) visibility-only (the M11 refmod-mod precedent). The door's
        // own mirror is retired: it added no wall stock lacks (the caps are
        // identical, read stock-side), and a drifted second copy is exactly the
        // class the intent-truth harness was built to catch. Stock refusal
        // strings ride the hint verbatim.
        crate::jobs_video::validate_refmods(rows).map_err(invalid)?;
        h3.insert("refmods".to_owned(), rows.clone());
    }
    Ok(Value::Object(h3))
}

/// REF2VA media items from the reference arrays: lane order images, then videos,
/// then audio; slot is the item's position in its own lane (0-based, exactly the
/// stock `slot < lane max` law). File names must already be placed inputs — the
/// door's uploads seam turns absolute paths into those names; anything else is
/// refused naming the reference.
fn build_media(
    family: &str,
    references: &ReferenceArrays,
    has_refmods: bool,
) -> Result<Value, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    if family == "minimax-h3-hyperflow"
        && (!references.videos.is_empty() || !references.audio.is_empty())
    {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(
            "family 'minimax-h3-hyperflow': HyperFlow Flash GGUF accepts image references only (the stock compiler's law); the request carries video or audio references"
                .to_owned(),
        ));
    }
    if references.images.is_empty()
        && references.videos.is_empty()
        && references.audio.is_empty()
        && !has_refmods
    {
        return Err(invalid(
            "mode ref2va needs at least one reference (images/videos/audio, or pictureN/videoN/audioN aliases) or a refmods bag".to_owned(),
        ));
    }
    lane_media_items(&references.images, &references.videos, &references.audio)
}

/// The Director media rows the E16 reference arrays become — one home for both the
/// REF2VA arm and the `POST /v1/refmods` creation door (LEG M9e): lane order images,
/// then videos, then audio, and `slot` is the item's position in its own lane — the
/// stock `validate_h3_media` law. Every file must already be a placed input name.
pub(crate) fn lane_media_items(
    images: &[String],
    videos: &[RefEntry],
    audio: &[RefEntry],
) -> Result<Value, ApiError> {
    let mut items = Vec::new();
    for (slot, file) in images.iter().enumerate() {
        reference_file_grammar("image", file)?;
        #[allow(clippy::cast_possible_truncation)]
        items.push(json!({"type": "image", "file": file, "slot": slot as u64}));
    }
    for (lane, entries) in [("video", videos), ("audio", audio)] {
        for (slot, entry) in entries.iter().enumerate() {
            reference_file_grammar(lane, &entry.file)?;
            #[allow(clippy::cast_possible_truncation)]
            let mut item = json!({"type": lane, "file": entry.file, "slot": slot as u64});
            if let (Some(a), Some(b)) = (entry.trim_start, entry.trim_end) {
                item["trimStart"] = json!(a);
                item["trimEnd"] = json!(b);
            } else if let Some(a) = entry.trim_start {
                item["trimStart"] = json!(a);
            } else if let Some(b) = entry.trim_end {
                item["trimEnd"] = json!(b);
            }
            items.push(item);
        }
    }
    Ok(Value::Array(items))
}

/// The stock `h3.references` grammar: `{slot, image}` with the image under
/// `deas-inputs/`, and the Director slot law pinned by `validate_h3`: I2VA =
/// slot 0, L2VA = slot 1, FL2VA = {0,1} ascending, T2VA = none.
fn build_h3_references(mode: &str, images: &[String]) -> Result<Option<Value>, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let slots: &[u64] = match mode {
        "T2VA" => &[],
        "I2VA" => &[0],
        "L2VA" => &[1],
        _ => &[0, 1],
    };
    if images.is_empty() && slots.is_empty() {
        return Ok(None);
    }
    if slots.is_empty() {
        return Err(invalid(
            "T2VA carries no image references; drop images/pictureN or run I2VA/L2VA/FL2VA"
                .to_owned(),
        ));
    }
    if images.len() > slots.len() {
        return Err(invalid(format!(
            "mode {mode} carries at most {} image reference(s) (the Director slot law)",
            slots.len()
        )));
    }
    let items: Vec<Value> = images
        .iter()
        .zip(slots)
        .map(|(file, slot)| {
            if !(file.starts_with("deas-inputs/") && crate::jobs::model_name(file)) {
                return Err(invalid(format!(
                    "image reference '{file}' must be a placed input under deas-inputs/ (absolute paths are placed by the uploads seam at the door)"
                )));
            }
            Ok(json!({"slot": slot, "image": file}))
        })
        .collect::<Result<_, _>>()?;
    Ok(Some(Value::Array(items)))
}

/// Placed-input grammar for a media file (mirrors `validate_h3_media`'s file arm:
/// `deas-inputs/` or the root `deas-input-` form, passing `model_name`).
fn reference_file_grammar(lane: &str, file: &str) -> Result<(), ApiError> {
    if (file.starts_with("deas-inputs/") || file.starts_with("deas-input-"))
        && crate::jobs::model_name(file)
    {
        Ok(())
    } else {
        Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "{lane} reference '{file}' is not a placed input name; the stock compiler counts names under deas-inputs/ or the root deas-input-<uuid> form (absolute paths are placed by the uploads seam at the door)"
        )))
    }
}

/// THE QUEUE-DOOR REFMOD ROW ARM (E28, owner law "REFMOD = DRAINABLE ROW for
/// consistency"; grammar LEG AF2-M24c, manager rulings 2-5). Validates the closed
/// mode-`refmod` REQUEST grammar and returns the export map — the exact
/// `jobs_refmod::compile`-shaped map [`super::spool::Spool::append_refmod_row`]
/// mints and [`super::spool::flat_intent`] rebuilds byte-equal (pinned door-to-wire
/// by the spool's chain test). This arm deliberately does NOT touch the render
/// ladder: no required-field list, no slots, no dials, no seed, no family block —
/// the same "different shape" posture [`fill_music`]'s arm documented when it
/// landed, taken further: an export is not a render at all.
///
/// The closed request set (ruling 3): the five optional scalars
/// (`name`/`description`/`conceptType`/`vae`/`audioVae` — members of
/// [`REFMOD_EXPORT_KEYS`] a client may send), the E16 reference arrays
/// `images`/`videos`/`audio` (aliases already folded by the door's `e16::fold`),
/// and the `refmods` bag. `media` is REFUSED as a request key: it is door-built
/// from the reference arrays by [`lane_media_items`] (the one media-row home),
/// never client-supplied. Everything else — `model`, the slots, `seed`, `frames`,
/// `dials`, the recipe blocks, any stray key — is refused `bodyInvalid` NAMING the
/// closed set (`fill_video`'s refusal style). The ladder-block word `dials` is
/// also refused here so the grammar has one home even when a caller skips the
/// queue door's parse stage.
///
/// The family law (ruling 5): H3-only. An OMITTED family (`family == ""` at the
/// door — the creation door requires none) means [`REFMOD_FAMILY`]; any other
/// family word, `minimax-h3-hyperflow` included, is `modeUnsupported` naming the
/// reason honestly.
///
/// The value walls are the creation door's, shared not restated (SINGLE-HOME LAW):
/// [`super::results::check_refmod_word_walls`] (conceptType vocabulary,
/// description cap), the saved-bag fold and caps
/// ([`super::results::fold_saved_refmods`]), and the whole map build incl. the
/// at-least-one wall ([`super::results::build_refmod_export`]) over
/// [`lane_media_items`]. The mid-cycle wall deliberately does NOT sit here: an
/// export ROW queues beside a live cycle (that is E28's whole point — the row
/// waits in the spool and drains inside a cycle through `run_refmod_row`'s
/// gate), unlike the one-shot `POST /v1/refmods` door, which keeps its
/// `cycleInFlight` wall untouched.
///
/// # Errors
///
/// `bodyInvalid` for grammar/shape refusals (the offending key named); a
/// `modeUnsupported` refusal naming the H3-only family law. Never a plan.
fn fill_refmod(
    family: &str,
    request_extras: Option<&Map<String, Value>>,
) -> Result<Value, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    // The family law (ruling 5) writes nothing into the export map — the closed
    // compile request carries no family word — so this is a wall, not a rebind.
    if !family.is_empty() && family != REFMOD_FAMILY {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "mode 'refmod' is the MiniMax H3 RefMod export row: family '{family}' cannot run it (the stock export verbs are the minimax-h3 natives; no export arm is proven for any other family — hyperflow included)",
        )));
    }
    let empty = Map::new();
    let extras = request_extras.unwrap_or(&empty);
    // Ruling 3's closed set, named in full by every refusal. `mode`/`family` are
    // the door's envelope words (removed before the fill) — a caller that left
    // them in meets this wall too, which is the honest answer either way.
    for (key, _) in request_extras.into_iter().flatten() {
        match key.as_str() {
            "name" | "description" | "conceptType" | "vae" | "audioVae" | "images" | "videos"
            | "audio" | "refmods" => {}
            "media" => {
                return Err(invalid(
                    "'media' is not a request key the mode 'refmod' door takes: the Director rows are built door-side from the reference arrays images/videos/audio (pictureN/videoN/audioN aliases ride those arrays)".to_owned(),
                ));
            }
            other => {
                return Err(invalid(format!(
                    "'{other}' is not an intent key the 'refmod' door accepts; the closed set is the export scalars name/description/conceptType/vae/audioVae, the reference arrays images/videos/audio and the 'refmods' bag — this mode runs no render ladder, so model, the slots {SLOT_KEYS:?}, seed, frames, dials and the family blocks are all refused",
                )));
            }
        }
    }
    super::results::check_refmod_word_walls(extras)?;
    super::results::build_refmod_export(extras)
}

/// The family-side gates for the music arm (`music` / `t2m`): the family must
/// declare the stock `t2m` pipeline word, and it must have a music compile arm —
/// the YuE2 row or an ACE-Step row (LEG M14b: the door now mirrors stock
/// `jobs_music::compile`'s dispatch completely, so the M9e-era honest refusal of the
/// ACE arm is retired; its pin is replaced by the opened-leg tests).
fn check_music_family(family: &str, spec: &ModeSpec) -> Result<(), ApiError> {
    let declared = defaults::builtin_pipelines(family);
    if !pipeline_gate(spec, declared) {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "family '{family}' declares pipelines [{}]; mode '{}' needs one of {}",
            declared.join(","),
            spec.mode,
            spec.pipelines.join("|")
        )));
    }
    if family != MUSIC_YUE2_FAMILY && !is_ace_music_family(family) {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
            "family '{family}' declares the stock t2m pipeline but carries no music compile arm: the door runs the {MUSIC_YUE2_FAMILY} arm and the ACE-Step arm (a builtin.json 'music' profile — the seven ace-step rows); this family has neither"
        )));
    }
    Ok(())
}

/// Dispatches a `music` or `t2m` request into the stock music-recipe intent,
/// mirroring stock `jobs_music::compile`'s one-test split (LEG M14b): the YuE2
/// family runs the YuE2 key law ([`fill_music_yue2`], byte-stable from M9e/M11b/
/// M13), and an ACE-Step family runs the ACE-Step key law ([`fill_music_ace`]).
/// The two arms share only the recipe identity; the choice is the family word and
/// nothing else, exactly as the stock compiler dispatches.
fn fill_music(
    spec: &ModeSpec,
    family: &str,
    request_dials: Option<&Dials>,
    sheet: &DefaultsSheet,
    request_extras: Option<&Map<String, Value>>,
) -> Result<IntentPlan, ApiError> {
    if family == MUSIC_YUE2_FAMILY {
        return fill_music_yue2(spec, family, request_dials, sheet, request_extras);
    }
    fill_music_ace(spec, family, request_dials, sheet, request_extras)
}

/// Expands a YuE2 `music` or `t2m` request into the stock music-recipe intent
/// (LEG M9e): the §6 ladder over the family (YuE2's `defaults` block is the stock
/// tier for steps/cfg/sampler/scheduler), the required keys the ladder cannot name
/// (`style`, `lyrics`, `maxDuration`, `planning`, `mode`, the `generation{}`
/// sub-dials), and the stock combination law read at the door.
///
/// The three combinations `jobs_music::validate` accepts (:105-115) are the whole
/// design surface this arm emits:
///
/// 1. `(t2m, off)` — no `abc`, no `sourceAudio`, no `audioEncoder`;
/// 2. `(t2m, full|melody)` — with an `abc` block, never seeded here (ABC planning is a
///    request decision, so a plan without it is a refusal naming it);
/// 3. `(cover, melody)` — one E16 `audio[]`/`audioN` reference placed by the uploads
///    seam becomes `sourceAudio`, beside an `audioEncoder` model name.
///
/// Anything outside those rows is refused naming the row. The emitted key set is
/// `MUSIC_REQUIRED_FIELDS` plus the [`MUSIC_PASSTHROUGH_KEYS`] the request carried:
/// the stock derive is `deny_unknown_fields`, so `--lora` on a music mode has nothing
/// to fold into and is refused by the cause.
fn fill_music_yue2(
    spec: &ModeSpec,
    family: &str,
    request_dials: Option<&Dials>,
    sheet: &DefaultsSheet,
    request_extras: Option<&Map<String, Value>>,
) -> Result<IntentPlan, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let mut fields = defaults::resolve(Some(family), Some(spec.mode), request_dials, sheet);
    let mut extras = Map::new();
    let mut slots = Slots::default();
    let mut seed_request: Option<&Value> = None;
    // The music arms keep STRING-only references (`read_reference_array` refuses
    // trim-decorated entries with its own hint): the trim objects ride only the
    // video recipe's lanes, so these ride locals, never `ReferenceArrays`.
    let mut music_images: Vec<String> = Vec::new();
    let mut music_videos: Vec<String> = Vec::new();
    let mut music_audio: Vec<String> = Vec::new();
    let mut request_planning: Option<String> = None;

    for (key, value) in request_extras.into_iter().flatten() {
        if DIAL_NAMES.contains(&key.as_str()) {
            return Err(invalid(format!(
                "'{key}' is a dial; send it in the dials block, not beside it"
            )));
        }
        if key == "family" {
            return Err(invalid(
                "the family is the request's family field; the fill plane writes the intent's family key"
                    .to_owned(),
            ));
        }
        match key.as_str() {
            "checkpoint" | "positivePrompt" | "outputPrefix" | "diffusion" => {
                read_slot(key, value, &mut slots)?;
            }
            "seed" => seed_request = Some(value),
            "images" => music_images = read_reference_array(key, value)?,
            "videos" => music_videos = read_reference_array(key, value)?,
            "audio" => music_audio = read_reference_array(key, value)?,
            "style" => push_text_field(&mut fields, "style", value, Tier::Request.word())?,
            "lyrics" => push_text_field(&mut fields, "lyrics", value, Tier::Request.word())?,
            "planning" => {
                let word = value
                    .as_str()
                    .filter(|word| MUSIC_PLANNING.contains(word))
                    .ok_or_else(|| {
                        invalid(format!(
                            "'planning' must be one of {}",
                            MUSIC_PLANNING.join("|")
                        ))
                    })?;
                request_planning = Some(word.to_owned());
            }
            "maxDuration" => {
                push_number_field(&mut fields, "maxDuration", value, Tier::Request.word())?;
            }
            "generation" => {
                check_music_block("generation", value, &MUSIC_GENERATION_BOUNDS)?;
                fields.push(ResolvedField {
                    field: "generation",
                    source: Tier::Request.word(),
                    value: integralize_music_block(value),
                });
            }
            "loras" => {
                return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
                    "family '{family}' carries no LoRAs on a music recipe: the stock music Intent is deny_unknown_fields with no loras field, so --lora has nothing to fold into"
                )));
            }
            other if MUSIC_PASSTHROUGH_KEYS.contains(&other) => {
                check_music_passthrough_shape(other, value)?;
                // `abc` carries integral-key members the stock arm serde-types as u64;
                // the same one-home integralization the `generation` push obeys.
                let emitted = if other == "abc" {
                    integralize_music_block(value)
                } else {
                    value.clone()
                };
                extras.insert(key.clone(), emitted);
            }
            other => {
                return Err(invalid(format!(
                    "'{other}' is not an intent key the '{}' door accepts; the closed set is the music recipe's optional keys {}, the slots {SLOT_KEYS:?}, the control keys seed/style/lyrics/planning/maxDuration/generation and the reference arrays images/videos/audio",
                    spec.mode,
                    MUSIC_PASSTHROUGH_KEYS.join(", ")
                )));
            }
        }
    }

    // The music recipe has no image or video lane; only sound becomes an intent field
    // (the cover row's `sourceAudio`), so a stray reference is refused by the cause.
    if !music_images.is_empty() || !music_videos.is_empty() {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(
            "the music recipe has no image or video lane: only an audio reference (audio[]/audioN) reaches an intent field, as the cover row's sourceAudio".to_owned(),
        ));
    }
    if music_audio.len() > MUSIC_MAX_AUDIO {
        return Err(invalid(format!(
            "a music cover carries at most {MUSIC_MAX_AUDIO} audio reference (the stock sourceAudio field is one file); the request carries {}",
            music_audio.len()
        )));
    }

    // The combination law, read the way stock `validate` reads it: one of three rows,
    // each named in its own refusal.
    let cover = !music_audio.is_empty();
    let planning = match request_planning.as_deref() {
        Some(word) if cover && word != "melody" => {
            return Err(invalid(format!(
                "an audio reference runs the stock cover row: mode cover with planning melody; the request says planning '{word}'"
            )))
        }
        Some(word) => word.to_owned(),
        // The cover row's own law: a transcribed cover plans by melody. Absent the
        // request's word, the row supplies it — not a value this plane invented.
        None if cover => "melody".to_owned(),
        None => "off".to_owned(),
    };
    if cover {
        if !extras.contains_key("audioEncoder") {
            return Err(invalid(
                "a cover needs 'audioEncoder': the stock AudioEncoderLoader name that transcribes sourceAudio into a melody".to_owned(),
            ));
        }
        if extras.contains_key("abc") {
            return Err(invalid(
                "the stock cover row carries no 'abc' block: its melody comes from the transcribed source".to_owned(),
            ));
        }
    } else {
        if extras.contains_key("sourceAudio") {
            return Err(invalid(
                "'sourceAudio' is the cover row's key: send the file as an audio[]/audioN reference so the uploads seam places it".to_owned(),
            ));
        }
        if extras.contains_key("audioEncoder") {
            return Err(invalid(
                "'audioEncoder' belongs to the cover row: without an audio reference there is nothing to encode".to_owned(),
            ));
        }
        if planning == "off" && extras.contains_key("abc") {
            return Err(invalid(
                "planning off runs no ABC pass: the stock combination law refuses an 'abc' block beside planning off".to_owned(),
            ));
        }
        if planning != "off" && !extras.contains_key("abc") {
            return Err(invalid(format!(
                "planning '{planning}' demands an 'abc' block (the stock combination law); this door never seeds it"
            )));
        }
    }
    fields.push(ResolvedField {
        field: "mode",
        source: Tier::Floor.word(),
        value: json!(if cover { "cover" } else { "t2m" }),
    });
    fields.push(ResolvedField {
        field: "planning",
        source: if request_planning.is_some() {
            Tier::Request.word()
        } else {
            Tier::Floor.word()
        },
        value: json!(&planning),
    });

    // The cover row's source: the placed input name, never the request's raw path (the
    // door's placement law already ran). Stock refuses an output-side name outright.
    if let Some(source) = music_audio.first() {
        reference_file_grammar("audio", source)?;
        if source.ends_with(" [output]") {
            return Err(invalid(format!(
                "sourceAudio '{source}' is an output-side file; the cover row reads an uploaded input"
            )));
        }
        extras.insert("sourceAudio".to_owned(), json!(source));
    }

    // Required keys no tier can supply, completed from stock homes only: the prompt
    // slot is the conditioning text (`style`), an absent lyrics block is the
    // instrumental posture the stock compiler itself accepts, and the duration and the
    // `generation{}` block take the values the stock Workbench seeds.
    if dial_value(&fields, "style").is_none() {
        if let Some(prompt) = &slots.positive_prompt {
            fields.push(ResolvedField {
                field: "style",
                source: Tier::Request.word(),
                value: json!(prompt),
            });
        }
    }
    if dial_value(&fields, "lyrics").is_none() {
        fields.push(ResolvedField {
            field: "lyrics",
            source: Tier::Floor.word(),
            value: json!(""),
        });
    }
    if dial_value(&fields, "maxDuration").is_none() {
        fields.push(ResolvedField {
            field: "maxDuration",
            source: Tier::Stock.word(),
            value: json!(MUSIC_DURATION_FLOOR),
        });
    }
    if dial_value(&fields, "generation").is_none() {
        let block: Map<String, Value> = MUSIC_GENERATION_DEFAULTS
            .iter()
            .map(|(key, value)| ((*key).to_owned(), json!(*value)))
            .collect();
        fields.push(ResolvedField {
            field: "generation",
            source: Tier::Stock.word(),
            // The stock-tier seed carries `topK: 100` as an f64 (the table is one
            // float row per key); the stock `generation` struct types it u64, so the
            // emission home integralizes the integral keys (M11b: the raw f64 landed
            // 100.0 and `jobs_music::compile` refused our own floor).
            value: integralize_music_block(&Value::Object(block)),
        });
    }
    check_music_values(&fields, &extras)?;

    let (seed, seed_mode, seed_mode_source, seed_value_source) =
        resolve_seed(&fields, seed_request)?;
    let plan = IntentPlan {
        family: family.to_owned(),
        mode: spec.mode,
        fields,
        seed,
        seed_mode,
        seed_mode_source,
        seed_value_source,
        extras,
        slots,
        dropped: Vec::new(),
        recipe_id: MUSIC_RECIPE_ID,
        recipe_version: MUSIC_RECIPE_VERSION,
        key_law: KeyLaw::Music,
    };
    Ok(plan)
}

/// Expands an ACE-Step family's `music`/`t2m` request into the stock ACE-Step music
/// intent (LEG M14b). The arm mirrors `jobs_music_ace::validate` wall-for-wall:
///
/// * mode `t2m` and planning `off` ONLY — the stock gate is one equality chain, so a
///   `cover` posture or a `full`/`melody` plan is a refusal naming that law;
/// * the required `ace{}` settings block: bounded keys and closed vocabularies read
///   from the same `aceStepData.json` plugin the stock gate uses, integers where the
///   plugin marks them. A request that sends no block gets the stock Workbench's own
///   seeds — [`ace_floor_block`] (defaultAceSettings + the profile shift) and
///   [`ace_duration_seed`] (the 120 s seed snapped to the family latent grid), the
///   values the Workbench itself submits (`Workbench.part5.test.tsx:1444`);
/// * the loader law of the sheet row: an all-in-one checkpoint for `ace-step-1-0`,
///   the exact 3-key `{textEncoder,textEncoder2,vae}` split triple for the 1.5 rows
///   — NO `clipType`, because the compiler hard-wires the DualCLIPLoader `"ace"`
///   type; a `diffusion` beside a 1.0 row is refused by the stock cause;
/// * `generation`/`abc`/`sourceAudio`/`audioEncoder` (the YuE2 arm's keys) and
///   `loras`/`options` are refusals naming the key: the stock derive is
///   `deny_unknown_fields` and those keys are not in the ACE struct. Nothing else in
///   this door emits them, so the YuE2 path stays byte-stable beside this arm.
fn fill_music_ace(
    spec: &ModeSpec,
    family: &str,
    request_dials: Option<&Dials>,
    sheet: &DefaultsSheet,
    request_extras: Option<&Map<String, Value>>,
) -> Result<IntentPlan, ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let profile = defaults::builtin_music_profile(family).expect(
        "check_music_family admits the ACE arm only for a family with a builtin.json music profile",
    );
    // The ladder's stock tier is the profile row itself: the ACE sheet rows carry no
    // `defaults` block, and `defaults::builtin_defaults` falls back to the `music`
    // profile — the same block the stock Workbench seeds its controls from.
    let mut fields = defaults::resolve(Some(family), Some(spec.mode), request_dials, sheet);
    let mut slots = Slots::default();
    let mut seed_request: Option<&Value> = None;
    // The music arms keep STRING-only references (`read_reference_array` refuses
    // trim-decorated entries with its own hint): the trim objects ride only the
    // video recipe's lanes, so these ride locals, never `ReferenceArrays`.
    let mut music_images: Vec<String> = Vec::new();
    let mut music_videos: Vec<String> = Vec::new();
    let mut music_audio: Vec<String> = Vec::new();
    let mut request_planning = false;

    for (key, value) in request_extras.into_iter().flatten() {
        if DIAL_NAMES.contains(&key.as_str()) {
            return Err(invalid(format!(
                "'{key}' is a dial; send it in the dials block, not beside it"
            )));
        }
        if key == "family" {
            return Err(invalid(
                "the family is the request's family field; the fill plane writes the intent's family key"
                    .to_owned(),
            ));
        }
        match key.as_str() {
            "checkpoint" | "positivePrompt" | "outputPrefix" => {
                read_slot(key, value, &mut slots)?;
            }
            "diffusion" => {
                check_ace_diffusion_shape(value)?;
                slots.diffusion = Some(value.clone());
            }
            "seed" => seed_request = Some(value),
            "images" => music_images = read_reference_array(key, value)?,
            "videos" => music_videos = read_reference_array(key, value)?,
            "audio" => music_audio = read_reference_array(key, value)?,
            "style" => push_text_field(&mut fields, "style", value, Tier::Request.word())?,
            "lyrics" => push_text_field(&mut fields, "lyrics", value, Tier::Request.word())?,
            "planning" => {
                let word = value.as_str().unwrap_or_default();
                if word != "off" {
                    return Err(invalid(format!(
                        "planning '{word}': the stock ACE-Step gate is mode t2m with planning off only (jobs_music_ace::validate)"
                    )));
                }
                request_planning = true;
            }
            "maxDuration" => {
                push_number_field(&mut fields, "maxDuration", value, Tier::Request.word())?;
            }
            "ace" => {
                check_ace_block(value)?;
                let mut block = value.clone();
                // The plugin's integer members (`bpm`, `topK`) leave the door as JSON
                // integers: the stock gate admits integral floats, the graph feeds INT
                // node inputs (M11 emission law, one home).
                integralize_ace_block(&mut block);
                fields.push(ResolvedField {
                    field: "ace",
                    source: Tier::Request.word(),
                    value: block,
                });
            }
            "loras" => {
                return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!(
                    "family '{family}' carries no LoRAs on a music recipe: the stock ACE-Step music Intent is deny_unknown_fields with no loras field, so --lora has nothing to fold into"
                )));
            }
            "generation" | "abc" | "sourceAudio" | "audioEncoder" => {
                return Err(invalid(format!(
                    "'{key}' is a YuE2 music key: the stock ACE-Step struct is deny_unknown_fields and counts no '{key}' (jobs_music_ace::Intent) — the ACE arm carries its settings in the required 'ace' block and runs mode t2m with no cover row"
                )));
            }
            other => {
                return Err(invalid(format!(
                    "'{other}' is not an intent key the '{}' door accepts on an ACE-Step family; the closed set is the slots {SLOT_KEYS:?}, the control keys seed/style/lyrics/planning/maxDuration/ace, and the reference arrays images/videos/audio (all three have no ACE intent key and are refused)",
                    spec.mode
                )));
            }
        }
    }

    if !music_images.is_empty() || !music_videos.is_empty() {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(
            "the ACE-Step music recipe counts no image or video reference key at all (deny_unknown_fields): there is no lane to fold into".to_owned(),
        ));
    }
    if !music_audio.is_empty() {
        return Err(ApiError::new(ErrorKind::ModeUnsupported).with_hint(
            "the ACE-Step arm runs no cover row: its stock gate is mode t2m only (jobs_music_ace::validate), so an audio reference has nothing to fold into — the cover row belongs to the YuE2 arm".to_owned(),
        ));
    }
    // The loader law read from the sheet row: `loader: "diffusion"` is the 1.5 split
    // triple (a required slot by `needs_diffusion`), and the 1.0 pairing is refused
    // by the stock cause rather than reaching compile.
    if profile.version == "1.0" && slots.diffusion.is_some() {
        return Err(invalid(
            "ACE-Step 1.0 requires an all-in-one checkpoint: the split {textEncoder,textEncoder2,vae} recipe rides only the 1.5 rows (jobs_music_ace::validate)".to_owned(),
        ));
    }
    if slots
        .checkpoint
        .as_deref()
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".gguf"))
    {
        return Err(invalid(
            "Unsafe or unsupported ACE model: the stock ACE arm refuses GGUF checkpoints (jobs_music_ace::validate)".to_owned(),
        ));
    }

    // The stock gate's words ride as door-resolved fields: mode t2m, planning off
    // (any other request word was refused above, so only the tier varies).
    fields.push(ResolvedField {
        field: "mode",
        source: Tier::Floor.word(),
        value: json!("t2m"),
    });
    fields.push(ResolvedField {
        field: "planning",
        source: if request_planning {
            Tier::Request.word()
        } else {
            Tier::Floor.word()
        },
        value: json!("off"),
    });

    // Required keys no tier can supply, completed from stock homes only: the prompt
    // slot is the conditioning text (`style`), an absent lyrics block is the
    // instrumental posture the stock compiler itself accepts, the duration is the
    // Workbench seed snapped to the family grid, and the `ace` block lands
    // defaultAceSettings with the profile shift — exactly what the Workbench sends
    // for a bare ACE run.
    if dial_value(&fields, "style").is_none() {
        if let Some(prompt) = &slots.positive_prompt {
            fields.push(ResolvedField {
                field: "style",
                source: Tier::Request.word(),
                value: json!(prompt),
            });
        }
    }
    if dial_value(&fields, "lyrics").is_none() {
        fields.push(ResolvedField {
            field: "lyrics",
            source: Tier::Floor.word(),
            value: json!(""),
        });
    }
    if dial_value(&fields, "maxDuration").is_none() {
        fields.push(ResolvedField {
            field: "maxDuration",
            source: Tier::Stock.word(),
            value: json!(ace_duration_seed(profile)),
        });
    }
    if dial_value(&fields, "ace").is_none() {
        fields.push(ResolvedField {
            field: "ace",
            source: Tier::Stock.word(),
            value: ace_floor_block(profile.shift),
        });
    }
    check_ace_values(&fields, profile)?;

    let (seed, seed_mode, seed_mode_source, seed_value_source) =
        resolve_seed(&fields, seed_request)?;
    Ok(IntentPlan {
        family: family.to_owned(),
        mode: spec.mode,
        fields,
        seed,
        seed_mode,
        seed_mode_source,
        seed_value_source,
        extras: Map::new(),
        slots,
        dropped: Vec::new(),
        recipe_id: MUSIC_RECIPE_ID,
        recipe_version: MUSIC_RECIPE_VERSION,
        key_law: KeyLaw::MusicAce,
    })
}

/// Reads one music text field: a string inside the stock `text()` cap (16384 chars,
/// 65536 bytes, no NUL — mirrored, so a long prompt is refused at the door and not
/// inside the compiler's parse sentence).
fn push_text_field(
    fields: &mut Vec<ResolvedField>,
    name: &'static str,
    value: &Value,
    source: &'static str,
) -> Result<(), ApiError> {
    let text = value.as_str().ok_or_else(|| {
        ApiError::new(ErrorKind::BodyInvalid).with_hint(format!("{name} must be a string"))
    })?;
    if text.contains('\0')
        || text.chars().count() > MUSIC_TEXT_CHARS
        || text.len() > MUSIC_TEXT_BYTES
    {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "{name}: at most {} characters, no NUL",
            MUSIC_TEXT_CHARS
        )));
    }
    fields.push(ResolvedField {
        field: name,
        source,
        value: json!(text),
    });
    Ok(())
}

/// Validates one music sub-block against its stock bounds: the closed key set, every
/// bound key present, a finite number inside the stock range, and an integer where the
/// stock field is a `u64` ([`MUSIC_INTEGRAL_KEYS`]).
fn check_music_block(
    label: &str,
    value: &Value,
    bounds: &[(&str, f64, f64)],
) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let Some(object) = value.as_object() else {
        return Err(invalid(format!(
            "'{label}' must be an object carrying {}",
            bounds
                .iter()
                .map(|(key, ..)| *key)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    };
    let known: Vec<&str> = bounds.iter().map(|(key, ..)| *key).collect();
    if object.keys().any(|key| !known.contains(&key.as_str())) {
        return Err(invalid(format!(
            "'{label}' carries an unknown key; the stock {label} block is {{{}}}",
            known.join(", ")
        )));
    }
    for &(key, min, max) in bounds {
        let number = object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| finite(*value))
            .ok_or_else(|| {
                invalid(format!(
                    "{label}.{key} must be a finite number ({min}..{max})"
                ))
            })?;
        if !(min..=max).contains(&number) {
            return Err(invalid(format!("Invalid {label}.{key}: {min}..{max}")));
        }
        if MUSIC_INTEGRAL_KEYS.contains(&key) && number.fract() != 0.0 {
            return Err(invalid(format!(
                "Invalid {label}.{key}: an integer is required"
            )));
        }
    }
    Ok(())
}

/// Shape and grammar checks for the music arm's optional keys, mirroring the stock
/// validator's arms: `abc` against its bounds, `audioEncoder` against the ComfyUI model
/// grammar, and `sourceAudio` (a direct send is refused above, so this covers the
/// structured shape a hand-built body may still carry) against the input-file grammar.
fn check_music_passthrough_shape(key: &str, value: &Value) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    match key {
        "abc" => check_music_block("abc", value, &MUSIC_ABC_BOUNDS),
        "audioEncoder" => {
            if !value.as_str().is_some_and(crate::jobs::comfy_model_name) {
                return Err(invalid(
                    "audioEncoder must be a safe ComfyUI model identifier".to_owned(),
                ));
            }
            Ok(())
        }
        "sourceAudio" => {
            let file = value.as_str().unwrap_or_default();
            if !crate::jobs::model_name(file) || file.ends_with(" [output]") {
                return Err(invalid(
                    "sourceAudio must be a placed input file name, never an output-side entry"
                        .to_owned(),
                ));
            }
            Ok(())
        }
        other => {
            unreachable!("MUSIC_PASSTHROUGH_KEYS holds only abc/sourceAudio/audioEncoder: {other}")
        }
    }
}

/// The door-side value gates stock `jobs_music::validate` runs over the scalar fields,
/// so a queued row never meets the compiler's single flat sentence: the text caps and
/// the blank-`style` law, the 0.04 s duration grid inside 0.04..=900, the 1..=10000
/// steps gate, the 0..=100 cfg gate, and the sampler/scheduler choice grammar (the
/// stock `safe_choice` fn, called rather than restated). A field no tier supplied is
/// skipped here — `complete_or_refuse` names it as an open slot, which is the honest
/// answer for a model the queue door has not resolved yet.
fn check_music_values(
    fields: &[ResolvedField],
    extras: &Map<String, Value>,
) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let number = |field: &str| dial_value(fields, field).and_then(|value| value.as_f64());
    if let Some(style) = dial_value(fields, "style") {
        let style = style.as_str().unwrap_or_default();
        if style.trim().is_empty() {
            return Err(invalid("style must not be blank: it is the music recipe's conditioning text (positivePrompt is its slot)".to_owned()));
        }
    }
    if let Some(duration) = number("maxDuration") {
        if !(MUSIC_DURATION_STEP..=MUSIC_DURATION_LIMIT).contains(&duration) {
            return Err(invalid(format!(
                "Invalid maxDuration: {}..{MUSIC_DURATION_LIMIT}",
                MUSIC_DURATION_STEP
            )));
        }
        // The node's 0.04 s step: ComfyUI rounds silently, the stock compiler does not.
        let scaled = duration / MUSIC_DURATION_STEP;
        if (scaled - scaled.round()).abs() > 1e-7 {
            return Err(invalid(
                "Invalid maxDuration: a multiple of 0.04 seconds".to_owned(),
            ));
        }
    }
    if number("steps").is_some_and(|steps| !(1.0..=10000.0).contains(&steps)) {
        return Err(invalid("Invalid steps: 1..10000".to_owned()));
    }
    if number("cfg").is_some_and(|cfg| !(0.0..=100.0).contains(&cfg)) {
        return Err(invalid("Invalid cfg: 0..100".to_owned()));
    }
    for key in ["sampler", "scheduler"] {
        if let Some(value) = dial_value(fields, key) {
            if !value.as_str().is_some_and(crate::jobs::safe_choice) {
                return Err(invalid(format!(
                    "Unsafe {key}: a short alphanumeric choice word"
                )));
            }
        }
    }
    if let Some(generation) = dial_value(fields, "generation") {
        check_music_block("generation", &generation, &MUSIC_GENERATION_BOUNDS)?;
    }
    if let Some(abc) = extras.get("abc") {
        check_music_block("abc", abc, &MUSIC_ABC_BOUNDS)?;
    }
    Ok(())
}

/// The door's gate for the stock `ace{}` settings block, mirrored wall-for-wall from
/// `jobs_music_ace::settings` and read from the same `aceStepData.json` plugin: the
/// eight bounded keys plus the four vocabulary keys EXACTLY (stock counts
/// `bounds + 4` and refuses any other shape), every bounded key a finite number
/// inside its stock range, an integer where the plugin marks one (`bpm`, `topK`),
/// the three closed vocabularies, and a real boolean `generateAudioCodes`.
fn check_ace_block(value: &Value) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let bounds = ACE_STEP_DATA["bounds"]
        .as_object()
        .expect("the aceStepData plugin carries a bounds object");
    let exact = bounds.len() + ACE_VOCAB_KEYS.len();
    let Some(object) = value.as_object() else {
        return Err(invalid(format!(
            "'ace' must be an object carrying exactly the bounded keys {} and {}",
            bounds.keys().cloned().collect::<Vec<_>>().join(", "),
            ACE_VOCAB_KEYS.join(", ")
        )));
    };
    let unknown: Vec<&str> = object
        .keys()
        .filter(|key| !bounds.contains_key(*key) && !ACE_VOCAB_KEYS.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(invalid(format!(
            "'ace' carries an unknown key '{}'; the stock block is exactly {exact} keys (jobs_music_ace::settings counts no other)",
            unknown.join("', '")
        )));
    }
    if object.len() != exact {
        return Err(invalid(format!(
            "the stock 'ace' block is exactly {exact} keys (the YuE2-free ACE law); the request carries {} — send every key",
            object.len()
        )));
    }
    for (key, bound) in bounds {
        let min = bound[0].as_f64().expect("a numeric bound minimum");
        let max = bound[1].as_f64().expect("a numeric bound maximum");
        let number = object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| finite(*value))
            .ok_or_else(|| invalid(format!("Invalid ace.{key}: a finite number ({min}..{max})")))?;
        if !(min..=max).contains(&number) {
            return Err(invalid(format!("Invalid ace.{key}: {min}..{max}")));
        }
        if bound[2] == json!(true) && number.fract() != 0.0 {
            return Err(invalid(format!(
                "Invalid ace.{key}: an integer is required"
            )));
        }
    }
    for (key, list) in [
        ("language", "languages"),
        ("keyScale", "keyScales"),
        ("timeSignature", "timeSignatures"),
    ] {
        if !ACE_STEP_DATA[list]
            .as_array()
            .expect("the aceStepData plugin carries a vocabulary array")
            .contains(&object[key])
        {
            return Err(invalid(format!(
                "Invalid ace.{key}: outside the closed vocabulary of aceStepData.json"
            )));
        }
    }
    if !object["generateAudioCodes"].is_boolean() {
        return Err(invalid(
            "Invalid ace.generateAudioCodes: a boolean".to_owned(),
        ));
    }
    Ok(())
}

/// Emits the plugin's integer-marked members (`bpm`, `topK`) as JSON INTEGERS. The
/// stock `settings` gate admits an integral float (`as_f64` plus a zero-fraction
/// test), but the compiled graph carries the block's values verbatim into INT node
/// inputs — so every value entering an integer key (a request block AND the
/// stock-mirror floor) leaves this one home integral, the M11 emission law that
/// [`integralize_music_block`] applies to the YuE2 sub-blocks.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn integralize_ace_block(block: &mut Value) {
    let Some(object) = block.as_object_mut() else {
        return;
    };
    let bounds = ACE_STEP_DATA["bounds"]
        .as_object()
        .expect("the aceStepData plugin carries a bounds object");
    for (key, bound) in bounds {
        if bound[2] != json!(true) {
            continue;
        }
        if let Some(number) = object.get(key).and_then(Value::as_f64) {
            object.insert(key.clone(), json!(number.round() as u64));
        }
    }
}

/// The ACE-Step split-loader recipe law (LEG M14b): the stock `Diffusion` struct is
/// `deny_unknown_fields` with exactly {textEncoder, textEncoder2, vae} — NO
/// `clipType` (the DualCLIPLoader's `"ace"` type is hard-wired at
/// jobs_music_ace.rs:190, never an intent key, unlike the image arm's recipe),
/// every component a safe non-GGUF model identifier, and the two encoders distinct
/// (`jobs_music_ace::validate`'s split-component law).
fn check_ace_diffusion_shape(value: &Value) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let known = ["textEncoder", "textEncoder2", "vae"];
    let Some(object) = value.as_object() else {
        return Err(invalid(
            "ACE diffusion must be exactly {textEncoder, textEncoder2, vae} — no clipType, no family (the DualCLIPLoader's \"ace\" type is compiler-side)".to_owned(),
        ));
    };
    let unknown: Vec<&str> = object
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(invalid(format!(
            "diffusion.{} is not an ACE-Step split component: the stock struct counts exactly textEncoder, textEncoder2 and vae — no clipType",
            unknown.join(", ")
        )));
    }
    if object.len() != known.len() {
        return Err(invalid(
            "the ACE-Step split recipe is exactly {textEncoder, textEncoder2, vae}".to_owned(),
        ));
    }
    for key in known {
        let name = object[key].as_str().unwrap_or_default();
        if !crate::jobs::comfy_model_name(name) || name.to_ascii_lowercase().ends_with(".gguf") {
            return Err(invalid(format!(
                "diffusion.{key} must be a safe non-GGUF ComfyUI model identifier (the stock ACE split law)"
            )));
        }
    }
    if object["textEncoder"] == object["textEncoder2"] {
        return Err(invalid(
            "diffusion.textEncoder2 must name a second, distinct encoder (jobs_music_ace refuses identical split encoders)".to_owned(),
        ));
    }
    Ok(())
}

/// The ACE arm's scalar gates, mirrored from `jobs_music_ace::validate`: the
/// blank-`style` law, the 1.0..=1000 duration range with the FAMILY latent grid
/// (whole frames of `samplesPerLatent/sampleRate` from the sheet profile — 4096 of
/// 44100 for 1.0, 1920 of 48000 for 1.5 — plus the 1.0 truncation law the stock
/// test `ace_original_duration_never_silently_loses_a_frame` walks frame by frame),
/// the 1..=10000 steps gate, the 0..=100 cfg gate, the sampler/scheduler choice
/// grammar, and the `ace{}` block re-checked over whatever tier supplied it. A
/// field no tier supplied is skipped — `complete_or_refuse` names it as open.
fn check_ace_values(
    fields: &[ResolvedField],
    profile: &defaults::MusicProfile,
) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let number = |field: &str| dial_value(fields, field).and_then(|value| value.as_f64());
    if let Some(style) = dial_value(fields, "style") {
        if style.as_str().unwrap_or_default().trim().is_empty() {
            return Err(invalid("style must not be blank: it is the music recipe's conditioning text (positivePrompt is its slot)".to_owned()));
        }
    }
    if let Some(duration) = number("maxDuration") {
        if !(1.0..=1000.0).contains(&duration) {
            return Err(invalid("Invalid maxDuration: 1.0..1000.0".to_owned()));
        }
        let frames = duration * profile.sample_rate / profile.samples_per_latent;
        if (frames - frames.round()).abs() > 1e-7 {
            return Err(invalid(format!(
                "Invalid maxDuration: use the model's native latent grid ({:.6} s frames for this row)",
                profile.samples_per_latent / profile.sample_rate
            )));
        }
        if profile.version == "1.0"
            && (duration * profile.sample_rate / 512.0 / 8.0).floor() != frames.round()
        {
            return Err(invalid(
                "Invalid maxDuration: a floating-point value truncates a latent frame".to_owned(),
            ));
        }
    }
    if number("steps").is_some_and(|steps| !(1.0..=10000.0).contains(&steps)) {
        return Err(invalid("Invalid steps: 1..10000".to_owned()));
    }
    if number("cfg").is_some_and(|cfg| !(0.0..=100.0).contains(&cfg)) {
        return Err(invalid("Invalid cfg: 0..100".to_owned()));
    }
    for key in ["sampler", "scheduler"] {
        if let Some(value) = dial_value(fields, key) {
            if !value.as_str().is_some_and(crate::jobs::safe_choice) {
                return Err(invalid(format!(
                    "Unsafe {key}: a short alphanumeric choice word"
                )));
            }
        }
    }
    if let Some(block) = dial_value(fields, "ace") {
        check_ace_block(&block)?;
    }
    Ok(())
}

/// Reads one resolver-owned slot: typed, validated, never defaulted.
fn read_slot(key: &str, value: &Value, slots: &mut Slots) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    match key {
        "checkpoint" => {
            let name = value
                .as_str()
                .ok_or_else(|| invalid("checkpoint must be a model name string".to_owned()))?;
            if !crate::jobs::comfy_model_name(name) {
                return Err(invalid(format!(
                    "checkpoint '{name}' is not a safe ComfyUI model identifier; a 12-hex library handle resolves in the queue door"
                )));
            }
            slots.checkpoint = Some(name.to_owned());
        }
        "positivePrompt" => {
            let prompt = value
                .as_str()
                .ok_or_else(|| invalid("positivePrompt must be a string".to_owned()))?;
            if prompt.encode_utf16().count() > 16_384 || prompt.contains('\0') {
                return Err(invalid(
                    "positivePrompt: maximum 16384 UTF-16 units, no NUL".to_owned(),
                ));
            }
            slots.positive_prompt = Some(prompt.to_owned());
        }
        "outputPrefix" => {
            let prefix = value
                .as_str()
                .ok_or_else(|| invalid("outputPrefix must be a string".to_owned()))?;
            if !crate::jobs::safe_output_prefix(prefix) {
                return Err(invalid(
                    "outputPrefix must be bounded ASCII path segments, no traversal".to_owned(),
                ));
            }
            slots.output_prefix = Some(prefix.to_owned());
        }
        "diffusion" => {
            check_diffusion_shape(value)?;
            slots.diffusion = Some(value.clone());
        }
        other => unreachable!("SLOT_KEYS holds only the four resolver slots: {other}"),
    }
    Ok(())
}

/// compile's structural law for the split-loader recipe (3..=5 known keys, named
/// components, a safe clip type).
fn check_diffusion_shape(value: &Value) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let Some(object) = value.as_object() else {
        return Err(invalid(
            "diffusion must be {textEncoder, clipType, vae} plus optional textEncoder2/family"
                .to_owned(),
        ));
    };
    let known = ["textEncoder", "textEncoder2", "clipType", "vae", "family"];
    if !(3..=5).contains(&object.len()) || object.keys().any(|key| !known.contains(&key.as_str())) {
        return Err(invalid(
            "diffusion must be {textEncoder, clipType, vae} plus optional textEncoder2/family"
                .to_owned(),
        ));
    }
    for key in ["textEncoder", "vae"] {
        if !object[key]
            .as_str()
            .is_some_and(crate::jobs::comfy_model_name)
        {
            return Err(invalid(format!(
                "diffusion.{key} must be a safe ComfyUI model identifier"
            )));
        }
    }
    if !object["clipType"]
        .as_str()
        .is_some_and(crate::jobs::safe_choice)
    {
        return Err(invalid(
            "diffusion.clipType must be a safe choice word".to_owned(),
        ));
    }
    if let Some(second) = object.get("textEncoder2") {
        if !second.as_str().is_some_and(crate::jobs::comfy_model_name)
            || second == &object["textEncoder"]
        {
            return Err(invalid(
                "diffusion.textEncoder2 must be a distinct safe model identifier".to_owned(),
            ));
        }
    }
    if let Some(family) = object.get("family") {
        if !family.as_str().is_some_and(crate::jobs::safe_choice) {
            return Err(invalid(
                "diffusion.family must be a safe choice word".to_owned(),
            ));
        }
    }
    Ok(())
}

/// Shape checks for the pass-through keys this plane does not interpret. Value ranges and
/// the backend model allowlists stay with `compile`/`runnable::check`; only the pairing
/// laws and the identifier grammars that would otherwise produce a confusing compile
/// refusal are checked here. `pub(crate)` because the E16 fold runs the `loras` arm of
/// this same wall before it appends the `--lora` shorthand to a structured bag
/// (LEG AF2-M18c): one law, one home, no drift between the fold and the fill.
pub(crate) fn check_passthrough_shape(key: &str, value: &Value) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    match key {
        "inputImage" | "inputLayers" => {
            if key == "inputImage" {
                if !value.as_str().is_some_and(crate::jobs::model_name) {
                    return Err(invalid(
                        "inputImage must name an uploaded input image (this app's upload plane)"
                            .to_owned(),
                    ));
                }
                return Ok(());
            }
            let layers = value.as_array().ok_or_else(|| {
                invalid("inputLayers must be an array of 1..4 {image,x,y,width,height}".to_owned())
            })?;
            if layers.is_empty()
                || layers.len() > 4
                || layers.iter().any(|layer| {
                    layer.as_object().is_none_or(|object| object.len() != 5)
                        || !layer["image"].as_str().is_some_and(crate::jobs::model_name)
                        // The numeric mirror of compile's layer law (jobs.rs:549):
                        // x/y bounded by 8192, width/height 1..=8192.
                        || ["x", "y", "width", "height"].iter().any(|key| {
                            !layer[*key].as_u64().is_some_and(|n| {
                                n <= crate::jobs::MAX_CANVAS_EDGE
                                    && (n > 0 || *key == "x" || *key == "y")
                            })
                        })
                })
            {
                return Err(invalid(
                    "inputLayers must be 1..4 objects of {image,x,y,width,height} with x/y bounded by 8192 and width/height in 1..=8192"
                        .to_owned(),
                ));
            }
        }
        "inpaintCrop" => {
            // The numeric mirror of compile's crop law (jobs.rs:520-536): exactly
            // six keys, the source rectangle bounded by 8192, and the model-aligned
            // target edges on the 8..=8192 canvas grid under the 16.7M product.
            // The mask pairing and the rectangle's containment in the merged source
            // edges stay `check_pairing_laws`' (they need the ladder), not restated.
            let Some(object) = value.as_object() else {
                return Err(invalid(
                    "inpaintCrop needs {x,y,width,height,targetWidth,targetHeight}".to_owned(),
                ));
            };
            let keys = ["x", "y", "width", "height", "targetWidth", "targetHeight"];
            let number = |key: &str| object.get(key).and_then(Value::as_u64);
            let inside = object.len() == keys.len()
                && !object.keys().any(|key| !keys.contains(&key.as_str()))
                && keys.iter().all(|key| {
                    let positive = *key != "x" && *key != "y";
                    number(key)
                        .is_some_and(|n| n <= crate::jobs::MAX_CANVAS_EDGE && (!positive || n > 0))
                })
                && ["targetWidth", "targetHeight"]
                    .iter()
                    .all(|key| number(key).is_some_and(crate::jobs::canvas_edge_ok))
                && number("targetWidth")
                    .zip(number("targetHeight"))
                    .is_some_and(|(w, h)| crate::jobs::canvas_pixels_ok(w, h));
            if !inside {
                return Err(invalid(
                    "inpaintCrop: a bounded source rectangle and a model-aligned 8..=8192 target under the 16.7M pixel ceiling, with inputMask"
                        .to_owned(),
                ));
            }
        }
        "inputMask" => {
            if !value.as_str().is_some_and(crate::jobs::mask_name) {
                return Err(invalid(
                    "inputMask must name a mask uploaded into deas-masks/".to_owned(),
                ));
            }
        }
        "upscaleModel" => {
            if !value.as_str().is_some_and(crate::jobs::comfy_model_name) {
                return Err(invalid(
                    "upscaleModel must be a listed upscale model name".to_owned(),
                ));
            }
        }
        "loras" => {
            let loras = value
                .as_array()
                .ok_or_else(|| invalid("loras must be an array of {name, strength}".to_owned()))?;
            if loras.len() > 8
                || loras.iter().any(|lora| {
                    lora.as_object().is_none_or(|object| object.len() != 2)
                        || !lora["name"]
                            .as_str()
                            .is_some_and(crate::jobs::comfy_model_name)
                        || !lora["strength"].as_f64().is_some_and(finite)
                })
            {
                return Err(invalid(
                    "loras must be at most 8 {name, strength} pairs".to_owned(),
                ));
            }
            for lora in loras {
                if let Some(name) = lora["name"].as_str() {
                    // LORA FAMILY ROUTING (owner ruling 2026-11-22): a LoRA may ride as a
                    // reference instead of a file name - the 12-hex library handle or the
                    // full 64-hex fingerprint. Both are sha256-based identity words that
                    // resolve against the scan index (resolver::find_entries), so the
                    // safetensors-extension law cannot see them; the index itself only
                    // ever records safetensors LoRAs under those digests. A dotted name
                    // still rides the format wall unchanged.
                    if crate::agent_api::resolver::is_handle(name)
                        || crate::agent_api::resolver::is_sha256(name)
                    {
                        continue;
                    }
                    crate::jobs::validate_lora_format(name).map_err(invalid)?;
                }
            }
        }
        "sigmas" | "lyingSigma" => {
            if key == "sigmas" && !value.is_array() {
                return Err(invalid(
                    "sigmas must be a steps+1 descending schedule ending at 0".to_owned(),
                ));
            }
        }
        "refine" => {
            let Some(object) = value.as_object() else {
                return Err(invalid(
                    "refine must be {width, height, denoise} plus optional upscaleModel/sigmas/tiled"
                        .to_owned(),
                ));
            };
            let known = [
                "width",
                "height",
                "denoise",
                "upscaleModel",
                "sigmas",
                "tiled",
            ];
            if object.keys().any(|key| !known.contains(&key.as_str())) {
                return Err(invalid(
                    "refine keys are width, height, denoise, upscaleModel, sigmas, tiled"
                        .to_owned(),
                ));
            }
            if !object["width"].is_number() || !object["height"].is_number() {
                return Err(invalid("refine needs aligned width and height".to_owned()));
            }
            // The refine pass renders its own canvas: the stock edges and the pixel
            // product (`jobs::valid_refine`, jobs.rs:1457) are mirrored HERE, so an
            // oversized refine block never reaches the spool (the door's rule: what
            // compile will refuse, the door refuses first).
            for field in ["width", "height"] {
                let edge = object[field]
                    .as_f64()
                    .filter(|edge| edge.fract() == 0.0)
                    .map(|edge| {
                        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                        {
                            edge as u64
                        }
                    });
                if !edge.is_some_and(crate::jobs::canvas_edge_ok) {
                    return Err(invalid(format!(
                        "refine.{field} must be an integer 8..=8192 aligned to 8 (the stock canvas law)"
                    )));
                }
            }
            let (rw, rh) = (
                object["width"].as_f64().unwrap_or(0.0) as u64,
                object["height"].as_f64().unwrap_or(0.0) as u64,
            );
            if !crate::jobs::canvas_pixels_ok(rw, rh) {
                return Err(invalid(
                    "the refine canvas exceeds the 16.7M pixel ceiling (the stock canvas law)"
                        .to_owned(),
                ));
            }
            if !object["denoise"]
                .as_f64()
                .is_some_and(|value| finite(value) && value > 0.0 && value <= 1.0)
            {
                return Err(invalid("refine.denoise must be in (0, 1]".to_owned()));
            }
            if let Some(model) = object.get("upscaleModel") {
                if !model.as_str().is_some_and(crate::jobs::comfy_model_name) {
                    return Err(invalid(
                        "refine.upscaleModel must be a listed upscale model name".to_owned(),
                    ));
                }
            }
        }
        "componentOverrides" => {
            let slots = ["textEncoders", "vaes", "audioVaes", "textProjections"];
            let object = value.as_object().ok_or_else(|| {
                invalid("componentOverrides needs four explicit slot booleans".to_owned())
            })?;
            if object.len() != slots.len() || slots.iter().any(|slot| !value[*slot].is_boolean()) {
                return Err(invalid(
                    "componentOverrides needs exactly four slot booleans".to_owned(),
                ));
            }
        }
        "imageReference" => {
            let Some(object) = value.as_object() else {
                return Err(invalid(
                    "imageReference needs {visionModel, images: [{image, strength}] x 1..4}"
                        .to_owned(),
                ));
            };
            if object.len() != 2
                || !object["visionModel"]
                    .as_str()
                    .is_some_and(crate::jobs::comfy_model_name)
                || !object["images"]
                    .as_array()
                    .is_some_and(|images| !images.is_empty() && images.len() <= 4)
            {
                return Err(invalid(
                    "imageReference needs {visionModel, images: [{image, strength}] x 1..4}"
                        .to_owned(),
                ));
            }
        }
        "nativeImageReference" => {
            let Some(object) = value.as_object() else {
                return Err(invalid(
                    "nativeImageReference needs {method, images}".to_owned(),
                ));
            };
            if object.len() != 2 || !object["method"].is_string() {
                return Err(invalid(
                    "nativeImageReference needs {method, images}".to_owned(),
                ));
            }
        }
        // maskBlur, inpaintCrop, inputResize, h3Edit, faceRefine, skipLayers,
        // latentUpscale and wildcard carry value laws the stock compiler owns; the
        // numeric canvas mirrors for refine, inputResize, inpaintCrop and
        // inputLayers live beside the grammars below, and the pairing laws are
        // enforced in `check_pairing_laws`.
        _ => {}
    }
    Ok(())
}

/// compile's seed ceiling: JSON-safe integers (`2^53 - 1`).
const MAX_SEED: u64 = 9_007_199_254_740_991;

/// Draws a fresh seed in the stock domain (`0..2^32`, the Workbench's `randomSeed()`).
///
/// The randomness comes from a dependency this crate already ships — `uuid` v4 is a v4
/// (random) UUID, and its first four bytes carry no version or variant bits. No new crate.
fn draw_seed() -> u64 {
    let raw = uuid::Uuid::new_v4();
    let bytes = raw.as_bytes();
    u64::from(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// A number that survives compile's `as_f64()` range checks.
fn finite(value: f64) -> bool {
    value.is_finite()
}

/// The door-side half of the stock image arm's canvas law (LEG M13). The law home is
/// `jobs::compile`'s numeric table (jobs.rs:857-868): `width` and `height` are integers
/// in 8..=8192 aligned to 8, and the pixel product stays at or under 16,777,216 (the
/// floor was raised from the historical 64 to the true latent-grid floor, 8: one latent
/// cell; 1x1 cannot exist on the grid, so 8 is as low as the arms can render). The
/// video arm has mirrored its own grid law since M9c (`check_video_ranges`); the image
/// arm left this to compile alone, so a partial body carrying an off-grid width queued
/// green at the door and died only at the drain. Half-override stays legal — the flat
/// intent is per-field, exactly like stock: a width-only body merges with the ladder's
/// height, and the MERGED pair is what both walls measure.
fn check_image_canvas(plan: &IntentPlan) -> Result<(), ApiError> {
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let edges = ["width", "height"].map(|field| {
        plan.dial(field)
            .and_then(|value| value.as_f64())
            .filter(|value| value.fract() == 0.0)
            .map(|value| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                {
                    value as u64
                }
            })
    });
    for (index, field) in ["width", "height"].into_iter().enumerate() {
        let Some(edge) = edges[index] else {
            return Err(invalid(format!(
                "{field} must be an integer 8..=8192 aligned to 8; supply it in the dials block or the sheet"
            )));
        };
        if !(8..=8192).contains(&edge) || edge % 8 != 0 {
            return Err(invalid(format!(
                "{field} {edge} must be an integer 8..=8192 aligned to 8 (the stock canvas law)"
            )));
        }
    }
    let (width, height) = (
        edges[0].expect("gated above"),
        edges[1].expect("gated above"),
    );
    if width * height > 16_777_216 {
        return Err(invalid(
            "the image canvas exceeds the 16.7M pixel ceiling (the stock canvas law)".to_owned(),
        ));
    }
    Ok(())
}

/// Read only the head window of a file (the header-dimension laws never decode a
/// body); `None` when the file is absent or unreadable.
fn read_head_bytes(path: &std::path::Path, limit: usize) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; limit];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(buffer)
}

/// The intent's merged edge (the source extent compile measures `inpaintCrop`
/// against); 8193 when the dial is absent, mirroring compile's `unwrap_or(8193)`.
fn plan_source_edge(plan: &IntentPlan, field: &str) -> u64 {
    plan.dial(field)
        .and_then(|edge| edge.as_u64())
        .unwrap_or(8193)
}

/// The latent-upscale RESULT-canvas law at the door: the stock compiler sizes the
/// post-upscale canvas from the merged dials (`jobs_video::latent_upscale_size`:
/// ltx-2 doubles, minimax-h3 scales on its 32-px grid, Hi-Res Regenerate picks a
/// pinned target grid) and refuses an over-canvas result only at compile
/// (`jobs_video::validate_latent_upscale`, jobs_video.rs:515). The door calls the
/// SAME stock size function over the merged dial pair, so the effective canvas is
/// computed identically on both walls and an over-canvas row never queues.
fn check_latent_upscale_canvas(
    family: &str,
    fields: &[ResolvedField],
    extras: &Map<String, Value>,
) -> Result<(), ApiError> {
    let Some(upscale) = extras.get("latentUpscale") else {
        return Ok(());
    };
    let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
    let probe = json!({
        "family": family,
        "width": dial_value(fields, "width").unwrap_or(Value::Null),
        "height": dial_value(fields, "height").unwrap_or(Value::Null),
        "latentUpscale": upscale,
    });
    let (width, height) = crate::jobs_video::latent_upscale_size(&probe);
    if width > crate::jobs::MAX_CANVAS_EDGE
        || height > crate::jobs::MAX_CANVAS_EDGE
        || !crate::jobs::canvas_pixels_ok(width, height)
    {
        return Err(invalid(format!(
            "latentUpscale produces an {width}x{height} effective canvas; edges must stay 8..=8192 and the product at or under 16.7M pixels (the stock latentUpscale canvas law)"
        )));
    }
    Ok(())
}

/// The mode and family pairing laws, evaluated over exactly the keys the flat intent will
/// carry, so a plan this plane calls complete cannot trip compile's shape refusals.
fn check_pairing_laws(
    plan: &IntentPlan,
    input_root: Option<&std::path::Path>,
) -> Result<(), ApiError> {
    let extras = &plan.extras;
    let has = |key: &str| extras.contains_key(key);
    let clip_type = plan
        .slots
        .diffusion
        .as_ref()
        .and_then(|diffusion| diffusion.get("clipType"))
        .and_then(Value::as_str);
    let refusal = |key: &str, law: &str| {
        ApiError::new(ErrorKind::ModeUnsupported).with_hint(format!("'{key}': {law}"))
    };

    // `inputImage` and `denoise` are a pair, present together or absent together.
    let denoise = plan.dial("denoise");
    if has("inputImage") != denoise.is_some() {
        return Err(refusal(
            "inputImage",
            "the stock compiler requires inputImage and denoise together; the ladder supplied one without the other",
        ));
    }

    // The i2i canvas law (P3): an unresized, uncropped `inputImage` encodes at the
    // SOURCE's own dims (`LoadImage` -> `VAEEncode`, jobs.rs:1111-1127), so legal
    // dials do not bound the canvas. The door reads the placed file's header dims
    // (the same parse the uploads pixel law uses) and applies the canvas law; the
    // compile mirror is `jobs::check_input_canvas`. Inert when the root is unknown,
    // the source is a bracketed stock one, `inputResize`/`inpaintCrop` govern the
    // canvas, or the file/header cannot be read — the existing grammar laws keep
    // refusing a non-image or absent placement there.
    if let (Some(root), Some(name)) = (input_root, extras.get("inputImage").and_then(Value::as_str))
    {
        let governs_encode = !name.contains('[')
            && !has("inputResize")
            && !has("inpaintCrop")
            && crate::jobs::model_name(name);
        if governs_encode {
            let head = read_head_bytes(&root.join(name), 64);
            if let Some((width, height)) = head.as_deref().and_then(crate::jobs::image_header_dims)
            {
                let invalid = |hint: String| ApiError::new(ErrorKind::BodyInvalid).with_hint(hint);
                for (field, edge) in [("width", width), ("height", height)] {
                    if !crate::jobs::canvas_edge_ok(edge) {
                        return Err(invalid(format!(
                            "inputImage reads {width}x{height}: i2i renders at the INPUT's own dims, and the canvas law is 8..=8192 aligned to 8 on {field} (the stock canvas law)",
                        )));
                    }
                }
                if !crate::jobs::canvas_pixels_ok(width, height) {
                    return Err(invalid(format!(
                        "inputImage reads {width}x{height}: i2i renders at the INPUT's own dims, and the 16.7M pixel product is the canvas law (the stock pixel limit)",
                    )));
                }
            }
        }
    }

    // `inputMask` is a mask for an UNRESIZED inputImage; mask legs hang off it.
    for key in ["inputMask", "maskBlur", "inpaintCrop"] {
        if has(key) && (!has("inputImage") || has("inputResize")) {
            return Err(refusal(
                key,
                "needs an inputImage with no inputResize (a mask paints at the source's own size)",
            ));
        }
    }
    // `inpaintCrop`'s source rectangle stays inside the merged source edges — the
    // half of compile's crop law (jobs.rs:526-527) that needs the ladder; the key
    // and canvas numerics ride `check_passthrough_shape`.
    if let Some(crop) = extras.get("inpaintCrop") {
        let extent = |offset: &str, size: &str, edge: &str| {
            crop[offset]
                .as_u64()
                .zip(crop[size].as_u64())
                .is_some_and(|(start, span)| start + span <= plan_source_edge(plan, edge))
        };
        if !extent("x", "width", "width") || !extent("y", "height", "height") {
            return Err(refusal(
                "inpaintCrop",
                "its source rectangle (x+width, y+height) must stay inside the intent's width and height",
            ));
        }
    }
    if has("maskBlur") {
        let edges =
            ["width", "height"].map(|field| plan.dial(field).and_then(|value| value.as_u64()));
        let inside = match (edges[0], edges[1]) {
            (Some(width), Some(height)) => extras["maskBlur"]
                .as_u64()
                .is_some_and(|blur| blur <= 31 && blur < width.min(height)),
            _ => false,
        };
        if !inside {
            return Err(refusal(
                "maskBlur",
                "integer 0..31 smaller than the source edges, with inputMask",
            ));
        }
    }
    // `upscaleModel` is a resize-and-upscale leg (the `upscale` mode's own shape).
    if has("upscaleModel") && !has("inputResize") {
        return Err(refusal("upscaleModel", "needs inputResize beside it"));
    }
    // `inputResize` plus its padding equals the output dimensions, exactly as compile demands.
    if let Some(resize) = extras.get("inputResize") {
        let padding = |keys: [&str; 2]| {
            keys.map(|key| {
                resize
                    .get("pad")
                    .and_then(|pad| pad[key].as_u64())
                    .unwrap_or(0)
            })
            .iter()
            .sum::<u64>()
        };
        let matches = |field: &str, resize_key: &str, pad_keys: [&str; 2]| {
            resize[resize_key]
                .as_u64()
                .zip(plan.dial(field).and_then(|value| value.as_u64()))
                .is_some_and(|(resized, edge)| resized + padding(pad_keys) == edge)
        };
        if !matches("width", "width", ["left", "right"])
            || !matches("height", "height", ["top", "bottom"])
        {
            return Err(refusal(
                "inputResize",
                "its width/height plus padding must equal the intent's width and height",
            ));
        }
        // The resize TARGET obeys the canvas law too (compile admits an aligned
        // 8..=8192 target, jobs.rs:882; the merged output pair already rides the
        // door's canvas gate, so what this wall adds is the target's own bounds).
        for field in ["width", "height"] {
            if !resize[field]
                .as_u64()
                .is_some_and(crate::jobs::canvas_edge_ok)
            {
                return Err(refusal(
                    "inputResize",
                    "its width/height must be integers 8..=8192 aligned to 8 (the stock canvas law)",
                ));
            }
        }
        if !crate::jobs::canvas_pixels_ok(
            resize["width"].as_u64().unwrap_or(0),
            resize["height"].as_u64().unwrap_or(0),
        ) {
            return Err(refusal(
                "inputResize",
                "its width x height must stay at or under 16.7M pixels (the stock canvas law)",
            ));
        }
    }
    // The refine pass and a custom sigma schedule agree or compile refuses.
    if has("refine") && extras["refine"].get("sigmas").is_some() != has("sigmas") {
        return Err(refusal(
            "refine.sigmas",
            "present exactly when the first pass carries sigmas",
        ));
    }
    // MiniMax H3 edits: the MiniMax encoder, an input image, no custom sigmas, no refine.
    if has("h3Edit")
        && (clip_type != Some("minimax") || !has("inputImage") || has("sigmas") || has("refine"))
    {
        return Err(refusal(
            "h3Edit",
            "belongs to a diffusion recipe with clipType minimax on an inputImage, without sigmas or refine",
        ));
    }
    for key in ["faceRefine", "latentUpscale"] {
        if has(key)
            && (!has("h3Edit")
                || plan.family != "minimax-h3"
                || (key == "latentUpscale" && has("inputMask")))
        {
            return Err(refusal(
                key,
                "needs an unmasked MiniMax H3 edit on the minimax-h3 family",
            ));
        }
    }
    // Skip Layer Guidance is MOSS-Image only; SDXL ReVision needs the plain checkpoint.
    if has("skipLayers") && clip_type != Some("moss_image") {
        return Err(refusal("skipLayers", "is only supported on MOSS-Image"));
    }
    if has("imageReference") && plan.slots.diffusion.is_some() {
        return Err(refusal(
            "imageReference",
            "is a checkpoint-family (SDXL) path; split-loader families use their native reference keys",
        ));
    }
    if has("nativeImageReference") {
        let method = extras["nativeImageReference"]["method"].as_str();
        let paired = matches!(
            (method, clip_type),
            (Some("qwen-image-2.1"), Some("qwen_image"))
                | (Some("krea-2"), Some("krea2"))
                | (Some("moss-image"), Some("moss_image"))
                | (Some("minimax-h3"), Some("minimax"))
        );
        if !paired {
            return Err(refusal(
                "nativeImageReference.method",
                "must pair with diffusion.clipType: qwen-image-2.1/qwen_image, krea-2/krea2, moss-image/moss_image or minimax-h3/minimax",
            ));
        }
    }
    // A GGUF base cannot load as a self-contained checkpoint.
    if let Some(checkpoint) = &plan.slots.checkpoint {
        if crate::jobs::is_gguf(checkpoint) && plan.slots.diffusion.is_none() {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                "checkpoint '{checkpoint}' is a GGUF: it needs a diffusion recipe with a separate text encoder and VAE"
            )));
        }
    }
    // Ladder-supplied identifiers must survive compile's grammar checks.
    for field in ["sampler", "scheduler"] {
        if plan
            .dial(field)
            .is_some_and(|value| !value.as_str().is_some_and(crate::jobs::safe_choice))
        {
            return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
                "{field} must be a safe choice word (alphanumerics and _. -)"
            )));
        }
    }
    if plan
        .dial("imageFormat")
        .is_some_and(|value| !matches!(value.as_str(), Some("png") | Some("webp")))
    {
        return Err(ApiError::new(ErrorKind::BodyInvalid)
            .with_hint("imageFormat is png or webp".to_owned()));
    }
    if plan
        .dial("options")
        .is_some_and(|value| !crate::jobs::valid_options(&value))
    {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(
            "options: attention|sage|cache|compile|vaeTile, one attention patch only".to_owned(),
        ));
    }
    // The family word this plane writes must itself be compile-safe.
    if !crate::jobs::safe_choice(&plan.family) {
        return Err(ApiError::new(ErrorKind::BodyInvalid).with_hint(format!(
            "family '{}' is not a safe choice word",
            plan.family
        )));
    }
    Ok(())
}

/// The effective value of one ladder field, `None` when unsupplied or cleared.
fn dial_value(fields: &[ResolvedField], name: &str) -> Option<Value> {
    fields
        .iter()
        .find(|field| field.field == name && !field.value.is_null())
        .map(|field| field.value.clone())
}

/// The tier word that supplied one ladder field.
fn dial_source(fields: &[ResolvedField], name: &str) -> &'static str {
    fields
        .iter()
        .find(|field| field.field == name)
        .map(|field| field.source)
        .unwrap_or(Tier::Unsupplied.word())
}

/// Overwrites one ladder field's value and tier word (mode floors, request overrides and
/// law-clearing all land here, so `fields` stays the single record of what was emitted).
fn set_dial(fields: &mut [ResolvedField], name: &str, value: Value, source: &'static str) {
    if let Some(field) = fields.iter_mut().find(|field| field.field == name) {
        field.value = value;
        field.source = source;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(text: &str) -> DefaultsSheet {
        serde_json::from_str(text).expect("test sheet parses")
    }

    fn extras(text: &str) -> Map<String, Value> {
        serde_json::from_str(text).expect("test extras parse")
    }

    fn body(error: ApiError) -> Value {
        error.body_json()
    }

    fn hint_names(body: &Value, word: &str) -> bool {
        body["hint"]
            .as_str()
            .is_some_and(|hint| hint.contains(word))
    }

    fn extend(target: &mut Map<String, Value>, extra: &str) {
        for (key, value) in extras(extra) {
            target.insert(key, value);
        }
    }

    #[test]
    fn the_sam3_mode_words_are_design_excluded_and_name_the_closed_13() {
        // LEG M12 manager ruling: sam3/sam3_video are DESIGN-EXCLUDED v1 words.
        // The stock compile arms exist (jobs.rs:453-457); the vocabulary does not
        // carry the words, and the door refuses them naming every member of the 13.
        // (The verified class is `bodyInvalid` — an out-of-vocabulary word — NOT the
        // `modeUnsupported` a Deferred in-vocabulary word earns.)
        assert_eq!(MODES.len(), 13, "the closed vocabulary stays 13 words");
        assert!(
            !MODES.contains(&"sam3") && !MODES.contains(&"sam3_video"),
            "the sam3 words are excluded by ruling, not by omission"
        );
        for mode in ["sam3", "sam3_video"] {
            let error = fill("minimax-h3", mode, None, &DefaultsSheet::default(), None)
                .expect_err("the sam3 words are outside the closed vocabulary");
            let refusal = body(error);
            assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
            let hint = refusal["hint"].as_str().expect("hint");
            assert!(hint.contains(&format!("mode '{mode}'")), "{hint}");
            for word in MODES {
                assert!(
                    hint_names(&refusal, word),
                    "the refusal must name the closed 13; missing '{word}': {hint}"
                );
            }
        }
    }

    /// A complete image request for a split-loader family: every resolver slot filled.
    fn full_slots() -> Map<String, Value> {
        extras(
            r#"{
                "checkpoint": "anima/something.safetensors",
                "positivePrompt": "a lighthouse at dusk",
                "outputPrefix": "agent/run",
                "diffusion": {
                    "textEncoder": "qwen3-0.6b.safetensors",
                    "clipType": "stable_diffusion",
                    "vae": "wan_2.1_vae.safetensors",
                    "family": "anima"
                }
            }"#,
        )
    }

    #[test]
    fn combo_tier_dial_lands_with_its_source_tag() {
        let sheet = sheet(r#"{"combos":{"anima:t2i":{"steps":35}}}"#);
        let plan = fill("anima", "t2i", None, &sheet, None)
            .expect("bare t2i fills")
            .plan();
        assert_eq!(dial_value(&plan.fields, "steps"), Some(json!(35)));
        assert_eq!(dial_source(&plan.fields, "steps"), "combo");
    }

    #[test]
    fn request_dial_beats_the_combo_tier() {
        let sheet = sheet(r#"{"combos":{"anima:t2i":{"steps":35}}}"#);
        let dials = Dials {
            steps: Some(12),
            ..Dials::default()
        };
        let plan = fill("anima", "t2i", Some(&dials), &sheet, None)
            .expect("request dials fill")
            .plan();
        assert_eq!(dial_value(&plan.fields, "steps"), Some(json!(12)));
        assert_eq!(dial_source(&plan.fields, "steps"), "request");
    }

    #[test]
    fn floors_supply_seed_mode_format_and_compression() {
        let plan = fill("anima", "t2i", None, &sheet("{}"), None)
            .expect("bare fill")
            .plan();
        assert_eq!(dial_value(&plan.fields, "seedMode"), Some(json!("random")));
        assert_eq!(dial_value(&plan.fields, "imageFormat"), Some(json!("png")));
        assert_eq!(
            dial_value(&plan.fields, "imageCompression"),
            Some(json!(44))
        );
        let seed = plan.seed.as_u64().expect("a random seed is drawn");
        assert!(seed <= u64::from(u32::MAX), "the stock seed domain");
        assert_eq!(plan.seed_value_source, "floor");
    }

    #[test]
    fn fixed_seed_without_a_seed_names_the_missing_key() {
        let dials = Dials {
            seed_mode: Some("fixed".to_owned()),
            ..Dials::default()
        };
        let refused = fill("anima", "t2i", Some(&dials), &sheet("{}"), None)
            .expect_err("fixed seedMode without a seed refuses");
        let body = body(refused);
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "seed") && hint_names(&body, "seedMode"));
    }

    #[test]
    fn fixed_seed_uses_the_requested_value() {
        let dials = Dials {
            seed_mode: Some("fixed".to_owned()),
            ..Dials::default()
        };
        let plan = fill(
            "anima",
            "t2i",
            Some(&dials),
            &sheet("{}"),
            Some(&extras(r#"{"seed":42}"#)),
        )
        .expect("an explicit seed satisfies fixed seedMode")
        .plan();
        assert_eq!(plan.seed, json!(42));
        assert_eq!(plan.seed_value_source, "request");
    }

    #[test]
    fn random_seed_draws_differ_across_calls() {
        let first = fill("anima", "t2i", None, &sheet("{}"), None)
            .expect("first fill")
            .plan();
        let second = fill("anima", "t2i", None, &sheet("{}"), None)
            .expect("second fill")
            .plan();
        assert_ne!(first.seed, second.seed);
    }

    #[test]
    fn seed_outside_the_json_safe_range_refuses() {
        let body = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"seed":"42"}"#)),
            )
            .expect_err("a string seed refuses"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "seed"));
    }

    #[test]
    fn t2i_drops_a_ladder_denoise_and_records_the_law() {
        let sheet = sheet(r#"{"families":{"anima":{"denoise":0.6}}}"#);
        let plan = fill("anima", "t2i", None, &sheet, None)
            .expect("bare fill")
            .plan();
        assert_eq!(dial_value(&plan.fields, "denoise"), None);
        assert!(
            plan.dropped
                .iter()
                .any(|dropped| dropped.field == "denoise"),
            "the drop is recorded, not silent: {:?}",
            plan.dropped
        );
    }

    #[test]
    fn t2i_refuses_a_key_the_mode_does_not_run() {
        let body = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"inputImage":"deas-inputs/pic.png"}"#)),
            )
            .expect_err("t2i carries no inputImage"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "inputImage"));
    }

    #[test]
    fn i2i_refuses_a_missing_input_image_by_name() {
        let body = body(
            fill("anima", "i2i", None, &sheet("{}"), None).expect_err("i2i needs a source image"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "inputImage"));
    }

    #[test]
    fn i2i_pairs_a_request_input_image_with_a_ladder_denoise() {
        let sheet = sheet(r#"{"families":{"anima":{"denoise":0.5}}}"#);
        let mut request = full_slots();
        extend(&mut request, r#"{"inputImage":"deas-inputs/pic.png"}"#);
        let plan = fill("anima", "i2i", None, &sheet, Some(&request))
            .expect("i2i fills")
            .plan();
        let intent = plan
            .complete_or_refuse()
            .expect("slots landed, so complete");
        assert_eq!(intent["inputImage"], "deas-inputs/pic.png");
        assert_eq!(intent["denoise"], 0.5);
        assert_eq!(intent["recipeId"], IMAGE_RECIPE_ID);
        assert_eq!(intent["version"], 1);
    }

    #[test]
    fn i2i_without_a_denoise_value_refuses_naming_denoise() {
        let body = body(
            fill(
                "anima",
                "i2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"inputImage":"deas-inputs/pic.png"}"#)),
            )
            .expect_err("compile pairs denoise with inputImage"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "denoise"));
    }

    #[test]
    fn inpaint_refuses_input_resize_because_of_the_mask_law() {
        let sheet = sheet(r#"{"families":{"anima":{"denoise":0.8}}}"#);
        let body = body(
            fill(
                "anima",
                "inpaint",
                None,
                &sheet,
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png",
                        "inputMask":"deas-masks/2f4d9a1e-1c2b-4d3e-8f5a-6b7c8d9e0f11.png",
                        "inputResize":{"width":1024,"height":1024,"crop":"disabled"}}"#,
                )),
            )
            .expect_err("a mask paints an unresized source"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "inputResize"));
    }

    #[test]
    fn inpaint_names_its_missing_mask() {
        let sheet = sheet(r#"{"families":{"anima":{"denoise":0.8}}}"#);
        let body = body(
            fill(
                "anima",
                "inpaint",
                None,
                &sheet,
                Some(&extras(r#"{"inputImage":"deas-inputs/pic.png"}"#)),
            )
            .expect_err("inpaint needs a mask"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "inputMask"));
    }

    #[test]
    fn inpaint_completes_with_a_mask_and_blur() {
        let sheet = sheet(r#"{"families":{"anima":{"denoise":0.8}}}"#);
        let mut request = full_slots();
        extend(
            &mut request,
            r#"{"inputImage":"deas-inputs/pic.png",
                "inputMask":"deas-masks/2f4d9a1e-1c2b-4d3e-8f5a-6b7c8d9e0f11.png",
                "maskBlur":16}"#,
        );
        let plan = fill("anima", "inpaint", None, &sheet, Some(&request))
            .expect("inpaint fills")
            .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(intent["maskBlur"], 16);
        assert!(!intent
            .as_object()
            .expect("object")
            .contains_key("inputResize"));
    }

    #[test]
    fn missing_slots_name_every_open_gap() {
        let plan = fill("anima", "t2i", None, &sheet("{}"), None)
            .expect("bare fill")
            .plan();
        let expected = vec!["checkpoint", "diffusion", "outputPrefix", "positivePrompt"];
        assert_eq!(plan.missing_slots(), expected);
        assert_eq!(
            plan.complete_or_refuse().expect_err("slots stay open"),
            expected
        );
    }

    #[test]
    fn a_checkpoint_family_does_not_gate_the_diffusion_slot() {
        let plan = fill("sdxl", "t2i", None, &sheet("{}"), None)
            .expect("bare fill")
            .plan();
        assert!(!plan.missing_slots().contains(&"diffusion"));
    }

    #[test]
    fn complete_request_emits_exactly_the_key_law() {
        let plan = fill("anima", "t2i", None, &sheet("{}"), Some(&full_slots()))
            .expect("fills")
            .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        let object = intent.as_object().expect("a flat intent object");
        for field in REQUIRED_FIELDS {
            assert!(object.contains_key(field), "required {field} missing");
        }
        // 13 required + family + imageFormat + imageCompression + diffusion, and nothing
        // else: no ladder vocabulary words, no floor rows compile never counts.
        assert_eq!(object.len(), 17, "{:?}", object.keys().collect::<Vec<_>>());
        for stray in ["seedMode", "batch", "denoise"] {
            assert!(!object.contains_key(stray), "{stray} must never appear");
        }
        assert_eq!(object["family"], "anima");
        assert_eq!(object["negativePrompt"], "");
    }

    #[test]
    fn negative_prompt_falls_through_to_stock_then_to_empty() {
        let stock = fill("moss-image", "t2i", None, &sheet("{}"), None)
            .expect("moss fills")
            .plan();
        let negative = dial_value(&stock.fields, "negativePrompt").expect("stock supplies one");
        assert_eq!(dial_source(&stock.fields, "negativePrompt"), "stock");
        assert!(negative.as_str().is_some_and(|text| !text.is_empty()));

        let bare = fill("sdxl", "t2i", None, &sheet("{}"), None)
            .expect("sdxl fills")
            .plan();
        assert_eq!(dial_value(&bare.fields, "negativePrompt"), None);
        // Only the prompt/naming/model slots stay open: the ladder filled every range.
        assert_eq!(
            bare.missing_slots(),
            vec!["checkpoint", "outputPrefix", "positivePrompt"]
        );
        let intent = fill(
            "sdxl",
            "t2i",
            None,
            &sheet("{}"),
            Some(&extras(
                r#"{"checkpoint":"xl/base.safetensors","positivePrompt":"x","outputPrefix":"agent/r"}"#,
            )),
        ).expect("checkpoint family fills").plan()
        .complete_or_refuse()
        .expect("complete");
        assert_eq!(intent["negativePrompt"], "");
    }

    #[test]
    fn envelope_bytes_are_stable_for_the_same_fill() {
        let mut first = fill("anima", "t2i", None, &sheet("{}"), None)
            .expect("first fill")
            .plan();
        let mut second = fill("anima", "t2i", None, &sheet("{}"), None)
            .expect("second fill")
            .plan();
        // Only the drawn seed may differ; the schema and field order cannot drift.
        first.seed = json!(0);
        second.seed = json!(0);
        assert_eq!(
            serde_json::to_string(&first.envelope()).expect("the envelope serializes"),
            serde_json::to_string(&second.envelope()).expect("the envelope serializes")
        );
    }

    #[test]
    fn envelope_carries_the_api_version_and_recipe_identity() {
        let plan = fill("sdxl", "t2i", None, &sheet("{}"), None)
            .expect("bare fill")
            .plan();
        let envelope = serde_json::to_value(plan.envelope()).expect("serializes");
        assert_eq!(envelope["apiVersion"], ENVELOPE_VERSION);
        assert_eq!(envelope["family"], "sdxl");
        assert_eq!(envelope["mode"], "t2i");
        assert_eq!(envelope["recipe"]["recipeId"], IMAGE_RECIPE_ID);
        assert_eq!(envelope["recipe"]["version"], 1);
        assert_eq!(envelope["seed"]["mode"], "random");
        assert_eq!(envelope["seed"]["modeSource"], "floor");
        assert!(envelope["fields"].is_array());
        assert_eq!(envelope["missingSlots"][0], "checkpoint");
    }

    #[test]
    fn the_refmod_mode_word_is_the_h3_only_export_arm() {
        // E28 (LEG AF2-M24c): `refmod` left the Deferred class — it is the
        // drainable RefMod export ROW. The word still answers `modeUnsupported`
        // for a foreign family (the H3-only ruling, now naming the reason, not a
        // planned leg); only `minimax-h3` (or an omitted family) runs it.
        let refused = fill("anima", "refmod", None, &sheet("{}"), None)
            .expect_err("anima has no RefMod export arm");
        let refusal = body(refused);
        assert_eq!(refusal["reason"], "modeUnsupported");
        assert!(
            hint_names(&refusal, "minimax-h3") && hint_names(&refusal, "cannot run it"),
            "the hint names the one family and the reason: {refusal}"
        );
        let refused = fill("minimax-h3-hyperflow", "refmod", None, &sheet("{}"), None)
            .expect_err("no export arm is proven for the HyperFlow row");
        assert_eq!(body(refused)["reason"], "modeUnsupported");
        // An omitted family (the door passes "") is the one family, not a refusal
        // class of its own — the grammar walls answer instead (both-empty here).
        let refused = fill("", "refmod", None, &sheet("{}"), Some(&extras("{}")))
            .expect_err("the default family still meets the at-least-one wall");
        let refusal = body(refused);
        assert_eq!(refusal["reason"], "bodyInvalid");
        assert!(hint_names(&refusal, "at least one"));
    }

    #[test]
    fn the_refmod_row_fills_the_closed_export_map_not_a_plan() {
        // Manager ruling 2/4: the RefmodExport arm returns the compile-shaped
        // export MAP (no IntentPlan, no ladder fields, no seed, no slots).
        // `media` is door-built by `lane_media_items` (lane order, own-lane
        // slots); the folded `--refmod` rows fold to bare names.
        let mut request = extras(
            r#"{
                "name": "hero",
                "description": "main cast",
                "conceptType": "identity",
                "images": ["deas-inputs/a.png", "deas-inputs/b.png"],
                "videos": [],
                "refmods": [{"slot": 1, "name": "old/set.safetensors", "strength": 0.7}]
            }"#,
        );
        crate::agent_api::e16::fold(&mut request).expect("the door's fold lands first");
        let outcome = fill("minimax-h3", "refmod", None, &sheet("{}"), Some(&request))
            .expect("the closed grammar fills");
        let export = match outcome {
            FillOutcome::Export(export) => export,
            FillOutcome::Plan(_) => panic!("the refmod arm never fills a render plan"),
        };
        assert_eq!(
            export,
            json!({
                "name": "hero",
                "description": "main cast",
                "conceptType": "identity",
                "media": [
                    {"type": "image", "file": "deas-inputs/a.png", "slot": 0},
                    {"type": "image", "file": "deas-inputs/b.png", "slot": 1}
                ],
                "refmods": ["old/set.safetensors"]
            }),
            "the exact jobs_refmod::compile-shaped request"
        );
        // The pictureN alias rides the same arrays (E16, folded at the door).
        let mut aliased =
            extras(r#"{"picture1": "deas-inputs/a.png", "--refmod": "one.safetensors"}"#);
        crate::agent_api::e16::fold(&mut aliased).expect("the door's fold lands");
        let export = fill("", "refmod", None, &sheet("{}"), Some(&aliased))
            .expect("an omitted family defaults to the one export family")
            .expect_export();
        assert_eq!(
            export["media"],
            json!([{"type": "image", "file": "deas-inputs/a.png", "slot": 0}])
        );
        assert_eq!(export["refmods"], json!(["one.safetensors"]));
        assert!(
            export.get("vae").is_none() && export.get("audioVae").is_none(),
            "unsent optionals never ride"
        );
    }

    #[test]
    fn the_refmod_row_refuses_every_key_outside_its_closed_set() {
        // Ruling 3: model, positivePrompt, slots, seed, frames, dials, family
        // blocks and stray keys are refused NAMING the closed set; `media` is
        // refused as a request key because the door builds it (ruling 4).
        for (key, body_text) in [
            (
                "model",
                r#"{"model":"x.safetensors","refmods":["one.safetensors"]}"#,
            ),
            (
                "positivePrompt",
                r#"{"positivePrompt":"p","refmods":["one.safetensors"]}"#,
            ),
            (
                "checkpoint",
                r#"{"checkpoint":"x.safetensors","refmods":["one.safetensors"]}"#,
            ),
            ("seed", r#"{"seed":42,"refmods":["one.safetensors"]}"#),
            ("frames", r#"{"frames":121,"refmods":["one.safetensors"]}"#),
            (
                "dials",
                r#"{"dials":{"steps":20},"refmods":["one.safetensors"]}"#,
            ),
            ("h3", r#"{"h3":{},"refmods":["one.safetensors"]}"#),
            ("turbo", r#"{"turbo":true,"refmods":["one.safetensors"]}"#),
            (
                "nonsense",
                r#"{"nonsense":1,"refmods":["one.safetensors"]}"#,
            ),
        ] {
            let refused = fill(
                "minimax-h3",
                "refmod",
                None,
                &sheet("{}"),
                Some(&extras(body_text)),
            )
            .expect_err("{key} is outside the refmod grammar");
            let refusal = body(refused);
            assert_eq!(refusal["reason"], "bodyInvalid", "{key}: {refusal}");
            let hint = refusal["hint"].as_str().expect("hint");
            assert!(
                hint.contains(&format!(
                    "'{key}' is not an intent key the 'refmod' door accepts"
                )),
                "the refusal names the offending key: {hint}"
            );
            assert!(
                hint.contains("the closed set is"),
                "the refusal names the closed set: {hint}"
            );
        }
        let refused = fill(
            "minimax-h3",
            "refmod",
            None,
            &sheet("{}"),
            Some(&extras(r#"{"media":[{"type":"image","file":"a","slot":0}],"images":["deas-inputs/a.png"]}"#)),
        )
        .expect_err("media is door-built, never client-supplied");
        let refusal = body(refused);
        assert_eq!(refusal["reason"], "bodyInvalid");
        assert!(
            hint_names(&refusal, "built door-side"),
            "the media refusal says why: {refusal}"
        );
    }

    #[test]
    fn the_refmod_row_value_walls_are_the_creation_doors_shared_ones() {
        // Ruling 4's walls, shared not restated: at-least-one, the conceptType
        // vocabulary, the description cap, the saved-name grammar (an empty-name
        // bag row bounces at the door, never as prepareRefused poison).
        let refused = fill(
            "minimax-h3",
            "refmod",
            None,
            &sheet("{}"),
            Some(&extras("{}")),
        )
        .expect_err("neither references nor saved names");
        let refusal = body(refused);
        assert_eq!(refusal["reason"], "bodyInvalid");
        assert!(hint_names(&refusal, "at least one"));
        let refused = fill(
            "minimax-h3",
            "refmod",
            None,
            &sheet("{}"),
            Some(&extras(
                r#"{"conceptType":"vibe","refmods":["one.safetensors"]}"#,
            )),
        )
        .expect_err("conceptType rides the closed five");
        let refusal = body(refused);
        assert!(hint_names(&refusal, "conceptType must be one of"));
        let long = "x".repeat(4_001);
        let refused = fill(
            "minimax-h3",
            "refmod",
            None,
            &sheet("{}"),
            Some(&extras(&format!(
                r#"{{"description":"{long}","refmods":["one.safetensors"]}}"#
            ))),
        )
        .expect_err("the stock 4000-char cap holds at the row door too");
        let refusal = body(refused);
        assert!(hint_names(&refusal, "at most 4000 characters"));
        let refused = fill(
            "minimax-h3",
            "refmod",
            None,
            &sheet("{}"),
            Some(&extras(r#"{"refmods":[{"slot":1,"strength":0.5}]}"#)),
        )
        .expect_err("an empty saved name bounces at the door");
        let refusal = body(refused);
        assert!(hint_names(&refusal, "library name"));
        let refused = fill(
            "minimax-h3",
            "refmod",
            None,
            &sheet("{}"),
            Some(&extras(r#"{"images":["C:\\Elsewhere\\a.png"]}"#)),
        )
        .expect_err("an unplaced reference name is refused by the media grammar");
        let refusal = body(refused);
        assert_eq!(refusal["reason"], "bodyInvalid");
        assert!(hint_names(&refusal, "placed input"));
    }

    #[test]
    fn only_minimax_h3_serves_the_refmod_word_in_the_families_surface() {
        // The runnable law (ruling 5) has one reading for BOTH the queue door and
        // `GET /v1/families`: only the H3 row answers the word; hyperflow and the
        // image families never see a promise the door would refuse.
        assert!(runnable_modes("minimax-h3").contains(&"refmod"));
        for family in ["anima", "wan", "minimax-h3-hyperflow", "yue2"] {
            assert!(
                !runnable_modes(family).contains(&"refmod"),
                "{family} must not promise the export row"
            );
        }
    }

    #[test]
    fn unknown_mode_and_unknown_family_are_body_invalid() {
        let mode = body(
            fill("anima", "paint", None, &sheet("{}"), None).expect_err("an unknown mode word"),
        );
        assert_eq!(mode["reason"], "bodyInvalid");
        assert!(hint_names(&mode, "t2i"));

        let family = body(
            fill("not-a-family", "t2i", None, &sheet("{}"), None)
                .expect_err("an unknown family id"),
        );
        assert_eq!(family["reason"], "bodyInvalid");
        assert!(hint_names(&family, "not-a-family"));
    }

    #[test]
    fn video_only_families_refuse_the_image_modes() {
        for family in ["wan", "minimax-h3-hyperflow"] {
            let body = body(
                fill(family, "t2i", None, &sheet("{}"), None)
                    .expect_err("{family} is a video recipe only"),
            );
            assert_eq!(body["reason"], "modeUnsupported", "family {family}");
        }
    }

    #[test]
    fn a_family_without_the_mode_pipeline_refuses() {
        // `mage` declares t2i only, so it cannot run an i2i leg.
        let body = body(
            fill("mage", "i2i", None, &sheet("{}"), None).expect_err("no i2i pipeline declared"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "pipelines"));
    }

    #[test]
    fn moss_image_refusals_and_drops_follow_the_stock_law() {
        let body = body(
            fill(
                "moss-image",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"sigmas":[1.0,0.0]}"#)),
            )
            .expect_err("custom sigmas are unverified on MOSS-Image"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "sigmas"));

        let plan = fill(
            "moss-image",
            "t2i",
            None,
            &sheet(r#"{"families":{"moss-image":{"options":{"attention":"pytorch attention"}}}}"#),
            None,
        )
        .expect("a sheet option drop is not a refusal")
        .plan();
        assert_eq!(dial_value(&plan.fields, "options"), None);
        assert!(plan
            .dropped
            .iter()
            .any(|dropped| dropped.field == "options"));
    }

    #[test]
    fn upscale_mode_floors_denoise_at_zero() {
        let dials = Dials {
            width: Some(1536),
            height: Some(1536),
            ..Dials::default()
        };
        let plan = fill(
            "sdxl",
            "upscale",
            Some(&dials),
            &sheet("{}"),
            Some(&extras(
                r#"{"checkpoint":"xl/base.safetensors",
                    "positivePrompt":"upscale",
                    "outputPrefix":"agent/up",
                    "inputImage":"deas-inputs/pic.png",
                    "inputResize":{"width":1536,"height":1536,"crop":"disabled"},
                    "upscaleModel":"RealESRGAN_x4plus.pth"}"#,
            )),
        )
        .expect("the upscale leg fills")
        .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(intent["denoise"], 0.0);
        assert_eq!(intent["upscaleModel"], "RealESRGAN_x4plus.pth");
        assert_eq!(intent["width"], 1536);
    }

    #[test]
    fn a_resize_that_disagrees_with_the_output_size_refuses() {
        let body = body(
            fill(
                "sdxl",
                "upscale",
                None,
                &sheet("{}"),
                Some(&extras(
                    r#"{"checkpoint":"xl/base.safetensors",
                        "positivePrompt":"upscale",
                        "outputPrefix":"agent/up",
                        "inputImage":"deas-inputs/pic.png",
                        "inputResize":{"width":1536,"height":1536,"crop":"disabled"},
                        "upscaleModel":"RealESRGAN_x4plus.pth"}"#,
                )),
            )
            .expect_err("compile demands resize plus padding equal the output edges"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "inputResize"));
    }

    #[test]
    fn unknown_extra_key_is_refused_by_name() {
        let body = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"nonsense":1}"#)),
            )
            .expect_err("the key vocabulary is closed"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "nonsense"));
    }

    #[test]
    fn a_dial_key_in_the_extras_plane_is_refused() {
        let body = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"steps":20}"#)),
            )
            .expect_err("dials belong in the dials block"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "dials"));
    }

    #[test]
    fn a_request_family_key_is_refused() {
        let body = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"family":"sdxl"}"#)),
            )
            .expect_err("the plane writes the family key"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "family"));
    }

    #[test]
    fn refine_sigmas_must_match_the_first_pass() {
        let body = body(
            fill(
                "sdxl",
                "refine",
                None,
                &sheet("{}"),
                Some(&extras(
                    r#"{"refine":{"width":2048,"height":2048,"denoise":0.4,"sigmas":[1.0,0.5,0.0]}}"#,
                )),
            ).expect_err("refine.sigmas rides the first pass schedule"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "refine.sigmas"));
    }

    #[test]
    fn a_gguf_checkpoint_needs_the_diffusion_recipe() {
        let body = body(
            fill(
                "flux",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(
                    r#"{"checkpoint":"flux/base.gguf","positivePrompt":"x","outputPrefix":"agent/r"}"#,
                )),
            ).expect_err("a GGUF base cannot load as a checkpoint"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "GGUF"));
    }

    #[test]
    fn native_reference_method_must_pair_with_the_clip_type() {
        let body = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(
                    r#"{"nativeImageReference":{"method":"krea-2","images":["deas-inputs/pic.png"]}}"#,
                )),
            ).expect_err("the method pairs with diffusion.clipType"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "clipType"));
    }

    #[test]
    fn unsafe_identifiers_refuse_before_any_intent_is_built() {
        let mask = body(
            fill(
                "anima",
                "inpaint",
                None,
                &sheet(r#"{"families":{"anima":{"denoise":0.8}}}"#),
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png","inputMask":"../escape.png"}"#,
                )),
            )
            .expect_err("only an uploaded mask name is legal"),
        );
        assert_eq!(mask["reason"], "bodyInvalid");

        let prefix = body(
            fill(
                "anima",
                "t2i",
                None,
                &sheet("{}"),
                Some(&extras(r#"{"outputPrefix":"../outside"}"#)),
            )
            .expect_err("no traversal in an output prefix"),
        );
        assert_eq!(prefix["reason"], "bodyInvalid");
    }

    #[test]
    fn h3_edit_laws_are_enforced_at_the_door() {
        let body = body(
            fill(
                "minimax-h3",
                "i2i",
                None,
                &sheet(r#"{"families":{"minimax-h3":{"denoise":0.6}}}"#),
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png","h3Edit":{"shiftVideo":1.0,"shiftAudio":1.0}}"#,
                )),
            ).expect_err("h3Edit needs the minimax encoder"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "h3Edit"));
    }

    // --- LEG M9c: the video recipe arms (ref2va / video) ---------------------

    /// Stock's video key law mirrored as test constants (`jobs_video::FIELDS` /
    /// `OPTIONAL`, read there and pinned here as the whitelist the emitted flat
    /// intent must never leave).
    const STOCK_VIDEO_FIELDS: [&str; 17] = [
        "recipeId",
        "version",
        "family",
        "positivePrompt",
        "negativePrompt",
        "model",
        "textEncoder",
        "vae",
        "seed",
        "width",
        "height",
        "frames",
        "frameRate",
        "steps",
        "cfg",
        "sampler",
        "scheduler",
    ];
    const STOCK_VIDEO_OPTIONAL: [&str; 14] = [
        "dials",
        "streamDecode",
        "faceRefine",
        "enhancedPreview",
        "latentUpscale",
        "videoPost",
        "outputPrefix",
        "sourceVideo",
        "output",
        "loras",
        "options",
        "firstFrame",
        "lastFrame",
        "chunks",
    ];
    /// Not in the stock OPTIONAL array: the audio wrapper `jobs::compile`
    /// validates through `audio_post::settings` and STRIPS before dispatch
    /// (jobs.rs:448-451; jobs_audio_post.rs:13-32). LEG M15: the door emits it
    /// for video intents, so the whitelist mirror carries it with its own
    /// source home cited — a third stock array, not a fudge of the second.
    const STOCK_VIDEO_WRAPPER_KEYS: [&str; 1] = ["audioEnhance"];

    /// Complete h3 video slots: the resolver answers checkpoint + the split-loader
    /// recipe for `loader: "diffusion"` families; the door maps them onto the
    /// video arm's model/textEncoder/vae.
    fn h3_slots(prefix: &str) -> Map<String, Value> {
        extras(&format!(
            r#"{{
                "checkpoint": "{prefix}/model.safetensors",
                "positivePrompt": "a lighthouse at dusk",
                "outputPrefix": "agent/run",
                "diffusion": {{
                    "textEncoder": "minimax_h3.safetensors",
                    "clipType": "minimax",
                    "vae": "h3_video_vae.safetensors"
                }},
                "h3": {{
                    "audioVae": "h3_audio_vae.safetensors",
                    "shiftVideo": 1.0,
                    "shiftAudio": 1.0
                }}
            }}"#
        ))
    }

    fn ref2va(family: &str, extra: &str) -> Result<IntentPlan, ApiError> {
        let mut request = h3_slots(if family == "minimax-h3" {
            "minimax_h3"
        } else {
            "hyperflow"
        });
        extend(&mut request, extra);
        fill(family, "ref2va", None, &sheet("{}"), Some(&request)).map(FillOutcome::plan)
    }

    #[test]
    fn ref2va_media_builder_pins_lane_slots_per_stock_lane_order() {
        // Mirror of `validate_h3_media`: slot is the item's position in its own
        // lane (0-based, `slot < lane max`), lanes ordered images, videos, audio.
        let plan = ref2va(
            "minimax-h3",
            r#"{"images":["deas-inputs/a.png","deas-inputs/b.png","deas-inputs/c.png"],
                "videos":["deas-input-v1.mp4","deas-input-v2.mp4"],
                "audio":["deas-inputs/song.wav"]}"#,
        )
        .expect("ref2va fills");
        let intent = plan.complete_or_refuse().expect("complete");
        let media = intent["h3"]["media"].as_array().expect("media");
        assert_eq!(media.len(), 6);
        let slots_of = |kind: &str| -> Vec<u64> {
            media
                .iter()
                .filter(|item| item["type"] == kind)
                .map(|item| item["slot"].as_u64().expect("slot"))
                .collect()
        };
        assert_eq!(slots_of("image"), vec![0, 1, 2]);
        assert_eq!(slots_of("video"), vec![0, 1]);
        assert_eq!(slots_of("audio"), vec![0]);
        assert_eq!(intent["h3"]["mode"], "REF2VA");
        assert_eq!(intent["recipeId"], VIDEO_RECIPE_ID);
        assert_eq!(intent["model"], "minimax_h3/model.safetensors");
        assert_eq!(intent["textEncoder"], "minimax_h3.safetensors");
        assert_eq!(intent["vae"], "h3_video_vae.safetensors");
        // The raw arrays are consumed by the arm: the whitelist never sees them.
        for stray in [
            "images",
            "videos",
            "audio",
            "refmods",
            "diffusion",
            "checkpoint",
        ] {
            assert!(
                !intent.as_object().expect("object").contains_key(stray),
                "{stray} leaked"
            );
        }
    }

    #[test]
    fn a_trim_decorated_audio_entry_lands_the_stock_trim_pair_on_its_media_row() {
        // The audio-trim law at the door: `validate_h3_media`'s trim SHAPE is
        // mirrored (finite seconds 0..=3600, trimStart < trimEnd) and the pair
        // lands on the lane row verbatim; the 2–15 s clip wall stays stock-side
        // at prepare, where it counts the TRIMMED span.
        let plan = ref2va(
            "minimax-h3",
            r#"{"audio":[{"file":"deas-inputs/a.mp3","trimStart":3.43,"trimEnd":15.14}]}"#,
        )
        .expect("a decorated audio reference fills");
        let intent = plan.complete_or_refuse().expect("complete");
        let media = intent["h3"]["media"].as_array().expect("media");
        assert_eq!(media.len(), 1);
        assert_eq!(
            media[0],
            json!({
                "type": "audio",
                "file": "deas-inputs/a.mp3",
                "slot": 0,
                "trimStart": 3.43,
                "trimEnd": 15.14
            }),
            "the trim pair rides the row byte-equal"
        );
    }

    #[test]
    fn a_trim_start_only_entry_emits_trim_start_without_trim_end() {
        let plan = ref2va(
            "minimax-h3",
            r#"{"videos":[{"file":"deas-input-v1.mp4","trimStart":2.0}]}"#,
        )
        .expect("a trimStart-only entry fills");
        let intent = plan.complete_or_refuse().expect("complete");
        let row = &intent["h3"]["media"][0];
        assert_eq!(row["type"], "video");
        assert_eq!(row["trimStart"], json!(2.0));
        assert!(row.get("trimEnd").is_none(), "no trimEnd key is minted");
    }

    #[test]
    fn a_trim_end_not_after_trim_start_refuses_naming_the_stock_order_law() {
        for pair in [
            r#""trimStart":15.0,"trimEnd":15.0"#,
            r#""trimStart":15.14,"trimEnd":3.43"#,
        ] {
            let error = body(
                ref2va(
                    "minimax-h3",
                    &format!(r#"{{"audio":[{{"file":"deas-inputs/a.mp3",{pair}}}]}}"#),
                )
                .expect_err("trimStart must precede trimEnd"),
            );
            assert_eq!(error["reason"], "bodyInvalid", "{pair}");
            assert!(
                hint_names(&error, "trimStart must come before trimEnd"),
                "the hint names the stock order law: {error}"
            );
        }
    }

    #[test]
    fn a_trim_beyond_3600_refuses_naming_the_stock_range_law() {
        let error = body(
            ref2va(
                "minimax-h3",
                r#"{"audio":[{"file":"deas-inputs/a.mp3","trimStart":3601.0}]}"#,
            )
            .expect_err("the stock trim range"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        assert!(
            hint_names(&error, "0..=3600"),
            "the hint names the range: {error}"
        );
    }

    #[test]
    fn an_entry_object_with_a_foreign_key_refuses_naming_the_closed_set() {
        // `mediaMode` is a real stock h3.media word but a UI-only one: the door's
        // entry closed set is file, trimStart?, trimEnd? (the stock trim law).
        let error = body(
            ref2va(
                "minimax-h3",
                r#"{"videos":[{"file":"deas-input-v1.mp4","mediaMode":"audio"}]}"#,
            )
            .expect_err("the closed entry set"),
        );
        assert_eq!(error["reason"], "bodyInvalid");
        let hint = error["hint"].as_str().expect("hint");
        assert!(
            hint.contains("mediaMode"),
            "the refusal names the key: {hint}"
        );
        assert!(
            hint.contains("closed set"),
            "the refusal names the closed set: {hint}"
        );
    }

    #[test]
    fn the_images_lane_refuses_entry_objects_naming_the_string_law() {
        for entry in [
            r#"{"file":"deas-inputs/a.png","trimStart":1.0,"trimEnd":5.0}"#,
            r#"{"file":"deas-inputs/a.png"}"#,
        ] {
            let error = body(
                ref2va("minimax-h3", &format!(r#"{{"images":[{entry}]}}"#))
                    .expect_err("images stay string-only"),
            );
            assert_eq!(error["reason"], "bodyInvalid", "{entry}");
            let hint = error["hint"].as_str().expect("hint");
            assert!(
                hint.contains("images"),
                "the refusal names the lane: {hint}"
            );
            assert!(
                hint.contains("plain placement names"),
                "the refusal names the string law: {hint}"
            );
        }
    }

    #[test]
    fn hyperflow_ref2va_refuses_video_refs_naming_the_image_only_law() {
        let body = body(
            ref2va(
                "minimax-h3-hyperflow",
                r#"{"videos":["deas-input-v1.mp4"]}"#,
            )
            .expect_err("GGUF refs are images only"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "image references only"));
    }

    #[test]
    fn refmods_strength_edges_refuse_zero_and_one_point_one() {
        for strength in ["0.0", "1.1"] {
            let body = body(
                ref2va(
                    "minimax-h3",
                    &format!(
                        r#"{{"images":["deas-inputs/a.png"],"refmods":[{{"slot":1,"name":"char.safetensors","strength":{strength}}}]}}"#
                    ),
                )
                .expect_err("strength is (0, 1]"),
            );
            assert_eq!(body["reason"], "bodyInvalid", "{strength}");
            assert!(hint_names(&body, "strength"));
        }
        let plan = ref2va(
            "minimax-h3",
            r#"{"images":["deas-inputs/a.png"],"refmods":[{"slot":1,"name":"char.safetensors","strength":1.0}]}"#,
        )
        .expect("1.0 is inside (0, 1]");
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(intent["h3"]["refmods"][0]["slot"], 1);
    }

    #[test]
    fn refmods_row_negatives_answer_with_the_stock_strings_verbatim() {
        // LEG M15: the door arm now CALLS `jobs_video::validate_refmods` (:1035,
        // reached stock-side from `validate_h3`:927), so each refusal below is
        // the stock sentence itself, not a door-restated copy. The same rows
        // die compile-side in the stock suite's own row loop
        // (jobs_video_tests.rs:2444-2459) and in the harness's two-wall test
        // (intent_truth.rs), which is where the agreement is pinned.
        for bad in [
            r#"[{"slot":1,"name":"a.safetensors","strength":1},{"slot":1,"name":"b.safetensors","strength":1}]"#,
            r#"[{"slot":9,"name":"a.safetensors","strength":1}]"#,
            r#"[1]"#,
            r#"[{"slot":1,"name":"a.safetensors","strength":1,"enabled":false}]"#,
        ] {
            let answer = body(
                ref2va(
                    "minimax-h3",
                    &format!(r#"{{"images":["deas-inputs/a.png"],"refmods":{bad}}}"#),
                )
                .expect_err("this row breaks the stock law"),
            );
            assert_eq!(answer["reason"], "bodyInvalid", "{bad}");
            assert!(
                hint_names(&answer, "Invalid h3.refmods row"),
                "{bad} -> {answer}"
            );
        }
        // The cap string is stock's own too: nine distinct rows, no dup wall.
        let rows: Vec<String> = (1..=9)
            .map(|n| format!(r#"{{"slot":{n},"name":"a.safetensors","strength":1}}"#))
            .collect();
        let answer = body(
            ref2va(
                "minimax-h3",
                &format!(
                    r#"{{"images":["deas-inputs/a.png"],"refmods":[{}]}}"#,
                    rows.join(",")
                ),
            )
            .expect_err("nine rows is outside the 1-8 cap"),
        );
        assert!(hint_names(&answer, "h3.refmods: 1-8 rows"), "{answer}");
    }

    #[test]
    fn audio_enhance_wrapper_lands_the_intent_and_stock_shape_laws_fire_at_the_door() {
        // LEG M15: the video arm calls the stock `audio_post::settings` law
        // (jobs_audio_post.rs:13-32, pub(crate) widened visibility-only). The
        // wrapper lands top-level and survives to the plan (the drain hands it
        // to the stock machinery, which strips it from the recipe and runs the
        // native post-render stage — jobs.rs:448-451/2387); the graph truth is
        // pinned by the intent-truth differential, not by this unit test.
        let plan = ref2va(
            "minimax-h3",
            r#"{"images":["deas-inputs/a.png"],"audioEnhance":{"mode":"clean","profile":"mix"}}"#,
        )
        .expect("clean/mix is stock-legal on the video recipe");
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(
            intent["audioEnhance"],
            json!({"mode": "clean", "profile": "mix"}),
            "the wrapper rides verbatim, top-level, exactly where stock reads it"
        );
        // deep is speech-only stock-side; the door answers the stock sentence.
        let answer = body(
            ref2va(
                "minimax-h3",
                r#"{"images":["deas-inputs/a.png"],"audioEnhance":{"mode":"deep","profile":"mix"}}"#,
            )
            .expect_err("deep/mix is no stage"),
        );
        assert_eq!(answer["reason"], "bodyInvalid");
        assert!(hint_names(&answer, "Deep is speech-only"), "{answer}");
        // The shape law: mode alone is not a settings object (both keys are
        // required, `deny_unknown_fields`, device an optional auto|cpu|cuda).
        let answer = body(
            ref2va(
                "minimax-h3",
                r#"{"images":["deas-inputs/a.png"],"audioEnhance":{"mode":"clean"}}"#,
            )
            .expect_err("profile is required stock-side"),
        );
        assert!(hint_names(&answer, "AUDIO_SETTINGS: Expected"), "{answer}");
        let answer = body(
            ref2va(
                "minimax-h3",
                r#"{"images":["deas-inputs/a.png"],"audioEnhance":{"mode":"clean","profile":"mix","bogus":1}}"#,
            )
            .expect_err("unknown settings keys are refused stock-side"),
        );
        assert!(hint_names(&answer, "AUDIO_SETTINGS: Expected"), "{answer}");
    }

    #[test]
    fn ref2va_names_the_required_h3_fields_it_cannot_fabricate() {
        let request = extras(
            r#"{"checkpoint":"minimax_h3/model.safetensors",
                "positivePrompt":"x",
                "diffusion":{"textEncoder":"minimax_h3.safetensors","clipType":"minimax","vae":"h3_video_vae.safetensors"},
                "images":["deas-inputs/a.png"],
                "h3":{"shiftVideo":1.0,"shiftAudio":1.0}}"#,
        );
        let body = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("audioVae required"),
        );
        assert!(hint_names(&body, "audioVae"));
    }

    #[test]
    fn a_missing_path_style_reference_is_refused_naming_the_reference() {
        let body = body(
            ref2va("minimax-h3", r#"{"images":["C:\\inputs\\pic.png"]}"#)
                .expect_err("placement happened at the door; the arm sees grammar"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "C:\\inputs\\pic.png"));
    }

    #[test]
    fn video_mode_h3_pins_mode_vocabulary_and_the_director_slot_law() {
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"h3":{"mode":"I2VA","audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0},"images":["deas-inputs/first.png"]}"#,
        );
        let plan = fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
            .expect("I2VA fills")
            .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(intent["h3"]["mode"], "I2VA");
        assert_eq!(intent["h3"]["references"][0]["slot"], 0);
        assert_eq!(
            intent["h3"]["references"][0]["image"],
            "deas-inputs/first.png"
        );

        // The REF2VA word belongs to the ref2va mode.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"h3":{"mode":"REF2VA","audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0}}"#,
        );
        let rejection = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("REF2VA is the other mode"),
        );
        assert!(hint_names(&rejection, "ref2va"));

        // T2VA carries no image references.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"h3":{"mode":"T2VA","audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0},"images":["deas-inputs/first.png"]}"#,
        );
        let rejection = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("T2VA carries no refs"),
        );
        assert!(hint_names(&rejection, "T2VA"));
    }

    // AF2-M25a: the stock continuity law (`validate_continuity`, jobs_video.rs,
    // extracted from `validate_h3`'s `cont_ok` arm) mirrored at the door. A
    // grammar-bad `h3.continuity` never reaches stock prepare: the refusal is
    // bodyInvalid + the single home's hint, the same wall class the media and
    // refmods tests exercise - so the poison-row guard is never spent on
    // grammar. A legal row rides the intent verbatim.
    fn fl2va_continuity(continuity: &str) -> Map<String, Value> {
        // Stock-valid FL2VA row (director images, slots 0+1) carrying the given
        // continuity object as the request wrote it.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            &format!(
                r#"{{"h3":{{"mode":"FL2VA","audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0,"continuity":{continuity}}},"images":["deas-inputs/first.png","deas-inputs/second.png"]}}"#
            ),
        );
        request
    }

    #[test]
    fn video_h3_carries_a_legal_continuity_row_verbatim() {
        let request = fl2va_continuity(
            r#"{"session":"drill-1","sourceId":"","capture":false,"action":"walks forward","outputMode":"full"}"#,
        );
        let intent = fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
            .expect("FL2VA + a legal continuity row fills")
            .plan()
            .complete_or_refuse()
            .expect("complete");
        assert_eq!(
            intent["h3"]["continuity"],
            json!({"session": "drill-1", "sourceId": "", "capture": false, "action": "walks forward", "outputMode": "full"})
        );
    }

    #[test]
    fn the_door_refuses_an_unknown_continuity_key_naming_the_closed_set() {
        let request = fl2va_continuity(
            r#"{"session":"drill-1","sourceId":"","capture":false,"action":"walks forward","outputMode":"full","output":"full"}"#,
        );
        let refusal = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("`output` is not a continuity key; the door refuses, not prepare"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(hint_names(&refusal, "h3.continuity"), "{refusal}");
        assert!(
            hint_names(&refusal, "closed set"),
            "the hint names the closed key law: {refusal}"
        );
    }

    #[test]
    fn the_door_refuses_source_kind_video_without_a_hex_source_id() {
        let request = fl2va_continuity(
            r#"{"session":"drill-1","sourceId":"clip-1","sourceKind":"video","capture":false,"action":"walks forward","outputMode":"full"}"#,
        );
        let refusal = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("sourceKind video needs a 64-lowercase-hex media id"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(hint_names(&refusal, "sourceKind"), "{refusal}");
    }

    #[test]
    fn continuity_overlap_frames_pins_the_director_ladder() {
        let request = fl2va_continuity(
            r#"{"session":"drill-1","sourceId":"","capture":false,"action":"walks forward","outputMode":"full","overlapFrames":42}"#,
        );
        let refusal = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("42 is off the 73/56/39/22/5 ladder"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(hint_names(&refusal, "overlapFrames"), "{refusal}");
        let request = fl2va_continuity(
            r#"{"session":"drill-1","sourceId":"","capture":false,"action":"walks forward","outputMode":"full","overlapFrames":73}"#,
        );
        let intent = fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
            .expect("73 rides through")
            .plan()
            .complete_or_refuse()
            .expect("complete");
        assert_eq!(intent["h3"]["continuity"]["overlapFrames"], 73);
    }

    #[test]
    fn the_door_refuses_continuity_rows_missing_a_required_field() {
        // capture, action and outputMode are required facts (the stock `cont_ok`
        // arms): a missing one is a door 422 naming the field family, never a
        // prepareRefused poison count.
        for (field, row) in [
            (
                "capture",
                r#"{"session":"drill-1","sourceId":"","action":"walks forward","outputMode":"full"}"#,
            ),
            (
                "action",
                r#"{"session":"drill-1","sourceId":"","capture":false,"outputMode":"full"}"#,
            ),
            (
                "outputMode",
                r#"{"session":"drill-1","sourceId":"","capture":false,"action":"walks forward"}"#,
            ),
        ] {
            let refusal = body(
                fill(
                    "minimax-h3",
                    "video",
                    None,
                    &sheet("{}"),
                    Some(&fl2va_continuity(row)),
                )
                .expect_err("{field} is required stock-side"),
            );
            assert_eq!(refusal["reason"], "bodyInvalid", "{field}: {refusal}");
            assert!(
                hint_names(&refusal, field),
                "the hint names {field}: {refusal}"
            );
        }
    }

    #[test]
    fn continuity_session_imports_is_refused_at_the_door() {
        // `_imports` is the stock import namespace; a row may not claim it.
        let request = fl2va_continuity(
            r#"{"session":"_imports","sourceId":"","capture":false,"action":"walks forward","outputMode":"full"}"#,
        );
        let refusal = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("_imports is reserved stock-side"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(hint_names(&refusal, "session"), "{refusal}");
    }

    // AF2-M30: the stock closed h3 key set (`crate::jobs_video::H3_KEYS`, the
    // ten words `validate_h3` gates on) mirrored at the door's unknown-keys
    // wall. The live gap: row `cb46b38f-cf7e-471d-ad05-2f90e3646706` carried
    // `durationSeconds` at h3 top level (it belongs only inside
    // `h3.continuity`), passed the door (200 queue), died at stock prepare as
    // prepareRefused and burned the poison-row guard once. The door now
    // refuses foreign keys as bodyInvalid, naming every offender and the
    // closed set verbatim.
    #[test]
    fn the_door_refuses_h3_top_level_duration_seconds_naming_the_closed_set() {
        // Live-proof pin (row `cb46b38f-cf7e-471d-ad05-2f90e3646706`): the
        // misplaced word alone earns a door refusal, never a prepareRefused
        // poison count.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"h3":{"audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0,"durationSeconds":5.0}}"#,
        );
        let refusal = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request)).expect_err(
                "durationSeconds is not an h3 top-level key; the door refuses, not prepare",
            ),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(
            hint_names(&refusal, "h3.durationSeconds"),
            "the hint names the offending key by name: {refusal}"
        );
        assert!(
            hint_names(&refusal, "closed set"),
            "the hint names the closed key law: {refusal}"
        );
        for word in crate::jobs_video::H3_KEYS {
            assert!(
                hint_names(&refusal, word),
                "the hint quotes the closed set verbatim; missing '{word}': {refusal}"
            );
        }
        assert!(
            hint_names(&refusal, "h3.continuity"),
            "the hint carries the common-trap pointer: {refusal}"
        );
    }

    #[test]
    fn the_door_refuses_several_foreign_h3_keys_naming_all_sorted() {
        // One answer, every offender, sorted by key name (deterministic).
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"h3":{"audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0,"zzzAlien":1,"startSeconds":0.0,"modeX":"T2VA"}}"#,
        );
        let refusal = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("three foreign keys; the door refuses the whole block"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        let hint = refusal["hint"].as_str().expect("hint");
        let positions: Vec<usize> = ["'h3.modeX'", "'h3.startSeconds'", "'h3.zzzAlien'"]
            .iter()
            .map(|name| {
                hint.find(name)
                    .unwrap_or_else(|| panic!("names every offender by name: {refusal}"))
            })
            .collect();
        assert!(
            positions.windows(2).all(|w| w[0] < w[1]),
            "offenders are named sorted by key name: {hint}"
        );
    }

    #[test]
    fn a_closed_h3_block_rides_the_green_ref2va_grammar_unchanged() {
        // Regression for the exact live-green request shape: audioVae +
        // shiftVideo + shiftAudio, no mode (the door writes REF2VA), mode
        // ref2va. Every member of the closed set stays accepted by the wall.
        let plan = ref2va("minimax-h3", r#"{"images":["deas-inputs/a.png"]}"#)
            .expect("the green grammar stays green behind the wall");
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(intent["h3"]["mode"], "REF2VA");
        assert_eq!(intent["h3"]["audioVae"], "h3_audio_vae.safetensors");
        assert_eq!(intent["h3"]["shiftVideo"], 1.0);
        assert_eq!(intent["h3"]["shiftAudio"], 1.0);
    }

    #[test]
    fn the_media_and_references_built_by_door_refusals_still_fire_after_the_wall() {
        // Order pin: the unknown-keys wall runs FIRST, but the closed-set
        // members `media` and `references` can never trip it — their shipped
        // built-by-door refusals ride through with their exact strings.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"h3":{"audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0,"media":[]}}"#,
        );
        let refusal = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("h3.media is built by the door"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(
            hint_names(
                &refusal,
                "'h3.media' is built by the door from the reference arrays (images/videos/audio, pictureN/videoN/audioN); do not send it"
            ),
            "{refusal}"
        );
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"h3":{"mode":"T2VA","audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0,"references":[]}}"#,
        );
        let refusal = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("h3.references is built by the door"),
        );
        assert_eq!(refusal["reason"], "bodyInvalid", "{refusal}");
        assert!(
            hint_names(
                &refusal,
                "'h3.references' is built by the door from the reference arrays (images/videos/audio, pictureN/videoN/audioN); do not send it"
            ),
            "{refusal}"
        );
    }

    #[test]
    fn video_steps_gate_names_the_family_step_choices() {
        // HyperFlow samples 4/6/8 only (model_families video_recipe seam).
        let dials = Dials {
            steps: Some(7),
            ..Dials::default()
        };
        let mut request = h3_slots("hyperflow");
        extend(&mut request, r#"{"images":["deas-inputs/a.png"]}"#);
        let body = body(
            fill(
                "minimax-h3-hyperflow",
                "ref2va",
                Some(&dials),
                &sheet("{}"),
                Some(&request),
            )
            .expect_err("7 is not a distilled choice"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "4/6/8"));
    }

    #[test]
    fn sampler_grammar_and_empty_choice_refuse() {
        let dials = Dials {
            sampler: Some("".to_owned()),
            ..Dials::default()
        };
        let mut request = h3_slots("minimax_h3");
        extend(&mut request, r#"{"images":["deas-inputs/a.png"]}"#);
        let body = body(
            fill(
                "minimax-h3",
                "ref2va",
                Some(&dials),
                &sheet("{}"),
                Some(&request),
            )
            .expect_err("an empty sampler is refused"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "sampler"));
    }

    #[test]
    fn frames_floor_follows_the_builtin_video_block_and_the_grid_law() {
        // minimax-h3: fps 24, seconds 5 -> 120 frames, H3 grid 17k+5 rounds up to 124.
        let plan = ref2va("minimax-h3", r#"{"images":["deas-inputs/a.png"]}"#).expect("fills");
        assert_eq!(dial_value(&plan.fields, "frameRate"), Some(json!(24.0)));
        assert_eq!(dial_value(&plan.fields, "frames"), Some(json!(124)));
    }

    #[test]
    fn a_grid_illegal_frames_number_refuses_naming_the_law() {
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"frames":120}"#,
        );
        let body = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("120 is not 17k+5"),
        );
        assert!(hint_names(&body, "17k+5"));
    }

    #[test]
    fn a_partial_output_block_refuses_naming_the_stock_combine_law() {
        // LEG M13: the door arm for `output` now calls the stock `valid_output`
        // predicate (jobs_video.rs:209 via validate:1477), which requires EVERY key —
        // a lone {container} is refused here exactly as compile refuses it there.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"output":{"container":"MP4"}}"#,
        );
        let body = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("the block is all-keys-or-absent stock-side"),
        );
        assert!(hint_names(&body, "every required key present"));
        assert!(hint_names(&body, "codec"));
    }

    #[test]
    fn whitelist_discipline_video_intent_stays_inside_the_stock_key_law() {
        // The mirror of the two stock arrays is the law: every key the video arms
        // emit must be a required field, an optional key, or the family block.
        let plan = ref2va(
            "minimax-h3",
            // LEG M14a: the `videoPost` stage here is a LEGAL one — the door arm now
            // calls the stock TVE validator, and an empty block is a stock refusal
            // (jobs_video_tests.rs:980), so it can no longer serve as filler in a
            // whitelist probe.
            r#"{"images":["deas-inputs/a.png"],"videos":["deas-input-v1.mp4"],"audio":["deas-inputs/s.wav"],"videoPost":{"rtx":{"denoise":"High"}},"audioEnhance":{"mode":"clean","profile":"mix"},"output":{"codec":"Auto","container":"MP4","bitDepth":"Auto","quality":20,"audioCodec":"Auto","audioBitrate":"192k","saveFirstFrame":false,"saveLastFrame":false}}"#,
        )
        .expect("ref2va fills");
        let intent = plan.complete_or_refuse().expect("complete");
        let object = intent.as_object().expect("object");
        for key in object.keys() {
            assert!(
                STOCK_VIDEO_FIELDS.contains(&key.as_str())
                    || STOCK_VIDEO_OPTIONAL.contains(&key.as_str())
                    || STOCK_VIDEO_WRAPPER_KEYS.contains(&key.as_str())
                    || key == "h3",
                "'{key}' is outside the stock video whitelist"
            );
        }
        // The ltx/wan arms too, one complete run each, each on a fresh request:
        // another family's recipe block on a request is the cross-family refusal
        // law (its own test), never something an arm may swallow.
        let request = extras(
            r#"{"checkpoint":"ltx/model.safetensors","positivePrompt":"x",
                "diffusion":{"textEncoder":"gemma.safetensors","clipType":"ltxv","vae":"video_vae.safetensors"},
                "ltx":{"textProjection":"proj.safetensors","audioVae":"audio_vae.safetensors","passes":1}}"#,
        );
        let plan = fill("ltx-2", "video", None, &sheet("{}"), Some(&request))
            .expect("ltx video fills")
            .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        for key in intent.as_object().expect("object").keys() {
            assert!(
                STOCK_VIDEO_FIELDS.contains(&key.as_str())
                    || STOCK_VIDEO_OPTIONAL.contains(&key.as_str())
                    || key == "ltx",
                "'{key}' is outside the stock video whitelist (ltx)"
            );
        }
        let wan_request = extras(
            r#"{"checkpoint":"wan/model.safetensors","positivePrompt":"x",
                "diffusion":{"textEncoder":"umt5_xxl.safetensors","clipType":"wan","vae":"wan_2.1_vae.safetensors"},
                "wan":{"lowModel":"wan_low.safetensors","shiftHigh":5.0,"shiftLow":1.0,"refinerStep":2}}"#,
        );
        let plan = fill("wan", "video", None, &sheet("{}"), Some(&wan_request))
            .expect("wan video fills")
            .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        for key in intent.as_object().expect("object").keys() {
            assert!(
                STOCK_VIDEO_FIELDS.contains(&key.as_str())
                    || STOCK_VIDEO_OPTIONAL.contains(&key.as_str())
                    || key == "wan",
                "'{key}' is outside the stock video whitelist (wan)"
            );
        }
        assert_eq!(intent["wan"]["lowModel"], "wan_low.safetensors");
    }

    #[test]
    fn the_wrong_family_block_refuses_naming_the_families_block() {
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"ltx":{"passes":1}}"#,
        );
        let body = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("ltx block on an h3 family"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "'h3'"));
    }

    #[test]
    fn an_unknown_per_mode_key_names_the_accepted_set() {
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"grain":{"amount":2}}"#,
        );
        let body = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("grain is not an intent key"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "grain") && hint_names(&body, "videoPost"));
    }

    #[test]
    fn ref2va_on_a_non_video_family_refuses_naming_the_closed_four() {
        let body = body(
            fill("anima", "ref2va", None, &sheet("{}"), None)
                .expect_err("anima has no video recipe"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(
            &body,
            "ltx-2|wan|minimax-h3|minimax-h3-hyperflow"
        ));
    }

    #[test]
    fn triton_gated_compile_option_answers_the_prereq_cause() {
        // `options` is a ladder dial: it rides the dials block, never beside it.
        // The gate reads the resolved field, so any tier carrying `compile` answers
        // the prereq cause (modeUnsupported), not a shape refusal.
        let mut request = h3_slots("minimax_h3");
        extend(&mut request, r#"{"images":["deas-inputs/a.png"]}"#);
        let dials = Dials {
            options: Some(json!({"compile": "triton"})),
            ..Dials::default()
        };
        let body = body(
            fill(
                "minimax-h3",
                "ref2va",
                Some(&dials),
                &sheet("{}"),
                Some(&request),
            )
            .expect_err("the door cannot prove Triton"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "Triton"));
    }

    #[test]
    fn the_image_arm_answers_the_same_triton_cause_one_home_per_law() {
        // LEG M14a: the gate was the video arm's only. An IMAGE intent carrying
        // `options.compile` passed the door and met the prepare-side allowlist wall
        // (recipe_prerequisites builds allowlist.compile from the graph's
        // TorchCompileModel nodes; jobs.rs:1820 refuses what the owned environment does
        // not admit). Both arms now call `check_triton_gated_compile`.
        for mode in ["t2i", "i2i"] {
            let dials = Dials {
                options: Some(json!({"compile": "inductor"})),
                denoise: if mode == "i2i" { Some(0.6) } else { None },
                ..Dials::default()
            };
            let mut request = Map::new();
            if mode == "i2i" {
                request.insert("inputImage".to_owned(), json!("deas-inputs/a.png"));
            }
            let answer = fill("sdxl", mode, Some(&dials), &sheet("{}"), Some(&request));
            let body = body(answer.expect_err("the door cannot prove Triton on images either"));
            assert_eq!(body["reason"], "modeUnsupported", "{mode}: {body}");
            assert!(hint_names(&body, "Triton"), "{mode}: {body}");
        }
    }

    #[test]
    fn the_modes_table_mirrors_the_closed_vocabulary_one_row_per_word() {
        // The compile-side mirror can never drift from the door-side vocabulary:
        // every MODES word has exactly one MODE_SPECS row, same order.
        assert_eq!(MODE_SPECS.len(), MODES.len());
        for (mode, spec) in MODES.iter().zip(MODE_SPECS.iter()) {
            assert_eq!(&spec.mode, mode, "MODE_SPECS row out of step with MODES");
        }
    }

    #[test]
    fn a_beside_it_options_key_is_still_a_shape_refusal() {
        // The dial law keeps its precedence: an `options` sent beside the dials
        // block is bodyInvalid naming the block, whatever it contains.
        let mut request = h3_slots("minimax_h3");
        extend(
            &mut request,
            r#"{"images":["deas-inputs/a.png"],"options":{"compile":"triton"}}"#,
        );
        let body = body(
            fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
                .expect_err("options is a dial"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "dials block"));
    }

    #[test]
    fn e16_shorthand_fold_lands_the_same_plan_as_the_structured_shape() {
        let mut shorthand = h3_slots("minimax_h3");
        extend(
            &mut shorthand,
            r#"{"picture1":"deas-inputs/a.png","picture2":"deas-inputs/b.png","--lora":"one.safetensors:0.5,two.safetensors:0.7","--refmod":"char.safetensors"}"#,
        );
        crate::agent_api::e16::fold(&mut shorthand).expect("fold lands");
        let dials = Dials {
            steps: Some(20),
            ..Dials::default()
        };
        let plan_a = fill(
            "minimax-h3",
            "ref2va",
            Some(&dials),
            &sheet("{}"),
            Some(&shorthand),
        )
        .expect("shorthand fills")
        .plan();
        let mut plan_b_request = h3_slots("minimax_h3");
        extend(
            &mut plan_b_request,
            r#"{"images":["deas-inputs/a.png","deas-inputs/b.png"],"loras":[{"name":"one.safetensors","strength":0.5},{"name":"two.safetensors","strength":0.7}],"refmods":[{"slot":1,"name":"char.safetensors","strength":1.0}]}"#,
        );
        let plan_b = fill(
            "minimax-h3",
            "ref2va",
            Some(&dials),
            &sheet("{}"),
            Some(&plan_b_request),
        )
        .expect("structured fills")
        .plan();
        assert_eq!(
            plan_a.extras(),
            plan_b.extras(),
            "both shapes land one plan"
        );
    }

    #[test]
    fn the_defaults_ladder_untouched_video_modes_keep_the_tier_order() {
        let filled = sheet(r#"{"combos":{"minimax-h3:ref2va":{"steps":20}}}"#);
        let dials = Dials {
            steps: Some(40),
            ..Dials::default()
        };
        let mut request = h3_slots("minimax_h3");
        extend(&mut request, r#"{"images":["deas-inputs/a.png"]}"#);
        let plan = fill(
            "minimax-h3",
            "ref2va",
            Some(&dials),
            &filled,
            Some(&request),
        )
        .expect("fills")
        .plan();
        assert_eq!(dial_value(&plan.fields, "steps"), Some(json!(40)));
        assert_eq!(dial_source(&plan.fields, "steps"), "request");
        let plan = fill("minimax-h3", "ref2va", None, &filled, Some(&request))
            .expect("combo fills")
            .plan();
        assert_eq!(dial_value(&plan.fields, "steps"), Some(json!(20)));
        assert_eq!(dial_source(&plan.fields, "steps"), "combo");
        // With no request or combo tier, the builtin stock tier wins (30 for H3).
        let plan = fill("minimax-h3", "ref2va", None, &sheet("{}"), Some(&request))
            .expect("stock fills")
            .plan();
        assert_eq!(dial_value(&plan.fields, "steps"), Some(json!(30)));
        assert_eq!(dial_source(&plan.fields, "steps"), "stock");
    }

    #[test]
    fn video_grids_mirror_the_stock_latent_law() {
        // Pinned against the private `jobs_video::grid` table: LTX /32 8k+1,
        // Wan /16 4k+1, H3 /32 17k+5 (the comment above that fn states it).
        assert_eq!(video_grid("ltx-2"), (32, 8, 1));
        assert_eq!(video_grid("wan"), (16, 4, 1));
        assert_eq!(video_grid("minimax-h3"), (32, 17, 5));
        assert_eq!(video_grid("minimax-h3-hyperflow"), (32, 17, 5));
    }

    // ── The music arm (LEG M9e) ────────────────────────────────────────────────────

    /// A YuE2 music request with every resolver slot the queue door would resolve, a
    /// fixed seed so the two mode words compare byte-for-byte, and no music-specific
    /// key: everything else the arm completes from stock homes.
    fn music_slots() -> Map<String, Value> {
        extras(
            r#"{
                "checkpoint": "yue2/yue2-model.safetensors",
                "positivePrompt": "a driving folk reel",
                "outputPrefix": "agent/song",
                "seed": 7
            }"#,
        )
    }

    /// The ACE arm's slots helper (LEG M14b): the four resolver slots a music run
    /// needs, checkpoint named per loader form.
    fn ace_slots(checkpoint: &str) -> Map<String, Value> {
        let mut slots = extras(
            r#"{
                "positivePrompt": "a driving folk reel",
                "outputPrefix": "agent/song",
                "seed": 7
            }"#,
        );
        slots.insert("checkpoint".to_owned(), json!(checkpoint));
        slots
    }

    /// The 3-key ACE split triple, grammar-legal names (the 1.5 loader law).
    const ACE_SPLIT: &str = r#"{"textEncoder":"ace/qwen_0.6b.safetensors","textEncoder2":"ace/qwen_1.7b.safetensors","vae":"ace/ace_1.5_vae.safetensors"}"#;

    /// A legal full `ace{}` block for probe mutation (the stock plugin's twelve keys).
    const ACE_BLOCK: &str = r#""shift":3,"lyricsStrength":1,"bpm":120,"lmCfg":2,"temperature":0.85,"topP":0.9,"topK":30,"minP":0,"timeSignature":"4","language":"en","keyScale":"C major","generateAudioCodes":true"#;

    #[test]
    fn the_music_key_law_is_the_stock_intent_struct_exactly() {
        // Source-lift gate (law): the stock derive is `deny_unknown_fields`, so the arm
        // may emit nothing outside `struct Intent`'s own field list. The derive renames
        // camelCase, so each snake_case field appears in its camel form.
        const SOURCE: &str = include_str!("../jobs_music.rs");
        let start = SOURCE
            .find("struct Intent {")
            .expect("the stock music Intent struct");
        let body = &SOURCE[start..start + SOURCE[start..].find('}').expect("struct end")];
        let camel = |name: &str| {
            let mut out = String::new();
            let mut upper = false;
            for ch in name.chars() {
                if ch == '_' {
                    upper = true;
                    continue;
                }
                out.push(if upper { ch.to_ascii_uppercase() } else { ch });
                upper = false;
            }
            out
        };
        let mut required: Vec<String> = Vec::new();
        let mut optional: Vec<String> = Vec::new();
        for line in body.lines() {
            let Some((name, kind)) = line
                .trim()
                .strip_suffix(',')
                .and_then(|line| line.split_once(':'))
            else {
                continue;
            };
            if kind.trim().starts_with("Option<") {
                optional.push(camel(name.trim()));
            } else {
                required.push(camel(name.trim()));
            }
        }
        assert!(
            required.len() > 10 && !optional.is_empty(),
            "the stock struct parsed: {required:?} | {optional:?}"
        );
        required.sort();
        optional.sort();
        let mut mine: Vec<String> = MUSIC_REQUIRED_FIELDS
            .iter()
            .map(|key| (*key).to_owned())
            .collect();
        mine.sort();
        assert_eq!(
            mine, required,
            "MUSIC_REQUIRED_FIELDS is the stock struct's non-Option half"
        );
        let mut passthrough: Vec<String> = MUSIC_PASSTHROUGH_KEYS
            .iter()
            .map(|key| (*key).to_owned())
            .collect();
        passthrough.sort();
        assert_eq!(
            passthrough, optional,
            "the arm's optional keys are exactly the stock struct's Option half"
        );
    }

    #[test]
    fn a_bare_yue2_music_fill_lands_the_stock_seeds() {
        let plan = fill("yue2", "music", None, &sheet("{}"), Some(&music_slots()))
            .expect("music fills on the t2m pipeline word")
            .plan();
        let intent = plan
            .complete_or_refuse()
            .expect("the arm completes every key it owns");
        assert_eq!(intent["recipeId"], MUSIC_RECIPE_ID);
        assert_eq!(intent["version"], 1);
        assert_eq!(
            intent["mode"], "t2m",
            "the stock recipe word, not the door's word"
        );
        assert_eq!(intent["planning"], "off");
        assert_eq!(
            intent["style"], "a driving folk reel",
            "the prompt slot is the music recipe's conditioning text"
        );
        assert_eq!(
            intent["lyrics"], "",
            "no lyrics is the instrumental posture stock accepts"
        );
        assert_eq!(intent["maxDuration"], MUSIC_DURATION_FLOOR);
        assert_eq!(
            intent["steps"], 32,
            "the YuE2 defaults block is the ladder's stock tier"
        );
        assert_eq!(intent["generation"]["temperature"], 1.0);
        // M11b: this pin read `100.0` and thereby PINNED the floor-emission defect —
        // the stock `generation.topK` is a u64 and compile refused the float. The
        // emission integralizes it; the pin now proves the integer type.
        assert_eq!(intent["generation"]["topK"], json!(100));
        // The strict deny law, asserted over the emitted set rather than asserted about it.
        let mut allowed: Vec<&str> = MUSIC_REQUIRED_FIELDS.to_vec();
        allowed.extend_from_slice(&MUSIC_PASSTHROUGH_KEYS);
        for key in intent.as_object().expect("a flat intent").keys() {
            assert!(
                allowed.contains(&key.as_str()),
                "{key} is not a stock music field: {intent}"
            );
        }
    }

    #[test]
    fn the_t2m_word_and_the_generic_music_word_land_one_intent() {
        let music = fill("yue2", "music", None, &sheet("{}"), Some(&music_slots()))
            .expect("music fills")
            .plan();
        let concrete = fill("yue2", "t2m", None, &sheet("{}"), Some(&music_slots()))
            .expect("t2m fills")
            .plan();
        assert_eq!(
            music.complete_or_refuse().expect("complete"),
            concrete.complete_or_refuse().expect("complete"),
            "two door words, one recipe"
        );
    }

    #[test]
    fn a_lora_on_a_music_mode_refuses_naming_the_family_has_no_loras() {
        let mut request = music_slots();
        extend(&mut request, r#"{"--lora":"one.safetensors:0.5"}"#);
        crate::agent_api::e16::fold(&mut request).expect("the shorthand folds into a loras bag");
        let refused = fill("yue2", "music", None, &sheet("{}"), Some(&request))
            .expect_err("a music recipe has no loras field to fold into");
        let body = body(refused);
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "no loras field"), "{body}");
    }

    #[test]
    fn two_audio_references_refuse_naming_the_cap_of_one() {
        let mut request = music_slots();
        extend(
            &mut request,
            r#"{"audio":["deas-inputs/one.flac","deas-inputs/two.flac"]}"#,
        );
        let refused = fill("yue2", "music", None, &sheet("{}"), Some(&request))
            .expect_err("the stock sourceAudio field is one file");
        let body = body(refused);
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "at most 1 audio reference"), "{body}");
    }

    #[test]
    fn an_image_or_video_reference_refuses_naming_the_missing_lanes() {
        let mut request = music_slots();
        extend(&mut request, r#"{"images":["deas-inputs/frame.png"]}"#);
        let body = body(
            fill("yue2", "music", None, &sheet("{}"), Some(&request))
                .expect_err("the music recipe has no image lane"),
        );
        assert_eq!(body["reason"], "modeUnsupported");
        assert!(hint_names(&body, "no image or video lane"), "{body}");
    }

    #[test]
    fn an_audio_reference_lands_the_cover_row_and_demands_its_encoder() {
        let mut request = music_slots();
        extend(
            &mut request,
            r#"{"audio":["deas-inputs/cover-source.flac"],"audioEncoder":"beats_rapper_encoder.pt"}"#,
        );
        let plan = fill("yue2", "music", None, &sheet("{}"), Some(&request))
            .expect("a cover fills")
            .plan();
        let intent = plan.complete_or_refuse().expect("complete");
        assert_eq!(intent["mode"], "cover");
        assert_eq!(intent["planning"], "melody", "the cover row's own law");
        assert_eq!(intent["sourceAudio"], "deas-inputs/cover-source.flac");
        assert_eq!(intent["audioEncoder"], "beats_rapper_encoder.pt");

        let mut bare = music_slots();
        extend(&mut bare, r#"{"audio":["deas-inputs/cover-source.flac"]}"#);
        let body = body(
            fill("yue2", "music", None, &sheet("{}"), Some(&bare))
                .expect_err("a cover needs the encoder that transcribes it"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "audioEncoder"), "{body}");
    }

    #[test]
    fn the_planning_combination_law_refuses_both_stock_mismatches() {
        let mut bare_plan = music_slots();
        extend(&mut bare_plan, r#"{"planning":"full"}"#);
        let answer = body(
            fill("yue2", "music", None, &sheet("{}"), Some(&bare_plan))
                .expect_err("planning full demands an abc block"),
        );
        assert!(hint_names(&answer, "abc"), "{answer}");

        let mut mismatched = music_slots();
        extend(
            &mut mismatched,
            r#"{"planning":"off","abc":{"maxTokens":8192,"temperature":0.7,"topP":0.9,"topK":30,"repetitionPenalty":1.005,"penaltyWindow":100}}"#,
        );
        let answer = body(
            fill("yue2", "music", None, &sheet("{}"), Some(&mismatched))
                .expect_err("planning off runs no ABC pass"),
        );
        assert!(hint_names(&answer, "planning off"), "{answer}");

        let mut planned = music_slots();
        extend(
            &mut planned,
            r#"{"planning":"full","abc":{"maxTokens":8192,"temperature":0.7,"topP":0.9,"topK":30,"repetitionPenalty":1.005,"penaltyWindow":100}}"#,
        );
        let intent = fill("yue2", "music", None, &sheet("{}"), Some(&planned))
            .expect("a planned t2m fills")
            .plan()
            .complete_or_refuse()
            .expect("complete");
        assert_eq!(intent["planning"], "full");
        assert_eq!(intent["abc"]["maxTokens"], 8192, "the block lands verbatim");
    }

    #[test]
    fn the_ace_step_music_families_run_the_open_leg_on_stock_workbench_seeds() {
        // LEG M14b OPENED this leg. The M9e-era refusal pin
        // (`the_ace_step_music_families_meet_the_stock_ace_arm_gate`, fill_plane's
        // 4369-era test) is retired: the door now mirrors stock
        // `jobs_music::compile`'s dispatch completely. A bare ACE fill lands the
        // stock Workbench's OWN seeds: the profile row is the ladder's stock tier
        // (the ACE sheet rows carry no `defaults` block), defaultAceSettings with
        // the profile shift rides the floor, and the 120 s duration seed lands
        // snapped to the family latent grid (`normalizeAceDuration`, not an
        // invented number).
        let one = fill(
            "ace-step-1-0",
            "music",
            None,
            &sheet("{}"),
            Some(&ace_slots("ace/ace.safetensors")),
        )
        .expect("the ACE arm is live")
        .plan()
        .complete_or_refuse()
        .expect("the arm completes every key it owns");
        assert_eq!(one["recipeId"], MUSIC_RECIPE_ID);
        assert_eq!(one["mode"], "t2m", "the stock gate's only mode word");
        assert_eq!(
            one["planning"], "off",
            "the stock gate's only planning word"
        );
        assert_eq!(
            one["steps"], 50,
            "the 1.0 profile row is the ladder's stock tier"
        );
        assert_eq!(one["cfg"], 5.0);
        assert_eq!(one["sampler"], "euler");
        assert_eq!(one["scheduler"], "simple");
        assert_eq!(
            one["ace"]["shift"], 5.0,
            "the profile shift overrides the Workbench seed"
        );
        assert_eq!(
            one["ace"]["bpm"],
            json!(120),
            "integer members emit integral"
        );
        assert_eq!(one["ace"]["topK"], json!(0));
        assert_eq!(one["ace"]["language"], "en");
        assert_eq!(one["ace"]["keyScale"], "C major");
        assert_eq!(one["ace"]["generateAudioCodes"], json!(true));
        assert_eq!(
            one["lyrics"], "",
            "instrumental posture, as stock accepts it"
        );
        let duration = one["maxDuration"]
            .as_f64()
            .expect("the seed duration landed");
        assert_eq!(
            (duration * 44100.0 / 4096.0).round(),
            1292.0,
            "120.0 s is OFF the 1.0 grid; the floor is the stock UI's snap (1292 frames), not 120.0"
        );
        assert!(
            (duration * 44100.0 / 512.0 / 8.0).floor() == (duration * 44100.0 / 4096.0).round(),
            "the 1.0 truncation law must hold for our own floor, or compile refuses us"
        );
        let mut turbo_request = ace_slots("ace/ace-step-1.5-turbo.safetensors");
        extend(
            &mut turbo_request,
            &format!(r#"{{"diffusion":{ACE_SPLIT}}}"#),
        );
        let turbo = fill(
            "ace-step-1-5-turbo",
            "t2m",
            None,
            &sheet("{}"),
            Some(&turbo_request),
        )
        .expect("the 1.5 split form fills")
        .plan()
        .complete_or_refuse()
        .expect("with its triple the arm completes");
        assert_eq!(turbo["steps"], 8, "the turbo row's own profile seed");
        assert_eq!(turbo["cfg"], 1.0);
        assert_eq!(turbo["ace"]["shift"], 3.0);
        assert_eq!(
            turbo["maxDuration"], 120.0,
            "the 1.5 grid (1920 of 48000 = 0.04 s frames) answers 120.0 exactly"
        );
        assert_eq!(
            turbo["diffusion"]["textEncoder2"], "ace/qwen_1.7b.safetensors",
            "the ACE struct's one optional key lands from the resolver slot"
        );
        // The strict ACE deny law, asserted over the emitted sets.
        for key in one.as_object().expect("a flat intent").keys() {
            assert!(
                MUSIC_ACE_REQUIRED_FIELDS.contains(&key.as_str()),
                "{key} is not a stock ACE music field: {one}"
            );
        }
        for key in turbo.as_object().expect("a flat intent").keys() {
            assert!(
                MUSIC_ACE_REQUIRED_FIELDS.contains(&key.as_str()) || key == "diffusion",
                "{key} is outside the ACE struct: {turbo}"
            );
        }
    }

    #[test]
    fn the_ace_music_key_law_is_the_stock_ace_intent_struct_exactly() {
        // Source-lift gate (law): the YuE2 twin's gate, run against the stock ACE
        // struct. Required half vs `MUSIC_ACE_REQUIRED_FIELDS`; the struct's whole
        // Option half is `diffusion` alone — a resolver-slot key, never a
        // passthrough, and no YuE2 optional key can ride the ACE arm.
        const SOURCE: &str = include_str!("../jobs_music_ace.rs");
        let start = SOURCE
            .find("struct Intent {")
            .expect("the stock ACE music Intent struct");
        let body_src = &SOURCE[start..start + SOURCE[start..].find('}').expect("struct end")];
        let camel = |name: &str| {
            let mut out = String::new();
            let mut upper = false;
            for ch in name.chars() {
                if ch == '_' {
                    upper = true;
                    continue;
                }
                out.push(if upper { ch.to_ascii_uppercase() } else { ch });
                upper = false;
            }
            out
        };
        let mut required: Vec<String> = Vec::new();
        let mut optional: Vec<String> = Vec::new();
        for line in body_src.lines() {
            let Some((name, kind)) = line
                .trim()
                .strip_suffix(',')
                .and_then(|line| line.split_once(':'))
            else {
                continue;
            };
            if kind.trim().starts_with("Option<") {
                optional.push(camel(name.trim()));
            } else {
                required.push(camel(name.trim()));
            }
        }
        assert!(
            required.len() > 10 && optional == ["diffusion".to_owned()],
            "the stock ACE struct parsed: {required:?} | {optional:?}"
        );
        required.sort();
        let mut mine: Vec<String> = MUSIC_ACE_REQUIRED_FIELDS
            .iter()
            .map(|key| (*key).to_owned())
            .collect();
        mine.sort();
        assert_eq!(
            mine, required,
            "MUSIC_ACE_REQUIRED_FIELDS is the stock ACE struct's non-Option half"
        );
    }

    #[test]
    fn the_yue2_only_music_keys_refuse_an_ace_family_naming_each() {
        // The wrong-body negative: a YuE2-shaped body on an ACE family. The stock
        // derive is `deny_unknown_fields` — the door refuses each key by the cause,
        // naming the key AND the arm it belongs to (the compile-side twin is pinned
        // in `intent_truth` against the raw stock arm).
        for key in ["generation", "abc", "sourceAudio", "audioEncoder"] {
            let mut request = ace_slots("ace/ace.safetensors");
            extend(&mut request, &format!(r#"{{"{key}":{{}}}}"#));
            let answer = body(
                fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&request))
                    .expect_err("the ACE struct counts no YuE2 key"),
            );
            assert_eq!(answer["reason"], "bodyInvalid", "{key}");
            assert!(
                hint_names(&answer, key),
                "the refusal must name '{key}': {answer}"
            );
            assert!(
                hint_names(&answer, "YuE2"),
                "and the arm it belongs to: {answer}"
            );
        }
        let mut request = ace_slots("ace/ace.safetensors");
        extend(&mut request, r#"{"options":{"compile":"triton"}}"#);
        let answer = body(
            fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&request))
                .expect_err("options is not an ACE music key"),
        );
        assert_eq!(answer["reason"], "bodyInvalid");
        assert!(hint_names(&answer, "options"), "{answer}");
    }

    #[test]
    fn a_lora_on_an_ace_music_mode_refuses_naming_the_family_has_no_loras() {
        // M9e's no-loras law stands for the opened ACE arm: the stock ACE struct is
        // deny_unknown_fields and counts no loras key (its `Intent` struct was READ
        // for this leg — no loras field exists).
        let mut request = ace_slots("ace/ace.safetensors");
        extend(&mut request, r#"{"--lora":"one.safetensors:0.5"}"#);
        crate::agent_api::e16::fold(&mut request).expect("the shorthand folds into a loras bag");
        let refused = fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&request))
            .expect_err("the ACE music struct has no loras field to fold into");
        let answer = body(refused);
        assert_eq!(answer["reason"], "modeUnsupported");
        assert!(hint_names(&answer, "no loras field"), "{answer}");
    }

    #[test]
    fn the_ace_block_law_refuses_unknown_missing_and_fractional_members() {
        let probe = |extra: &str| -> Map<String, Value> {
            let mut request = ace_slots("ace/ace.safetensors");
            extend(&mut request, extra);
            request
        };
        let refuse = |extra: &str, names: &str| {
            let answer = body(
                fill(
                    "ace-step-1-0",
                    "music",
                    None,
                    &sheet("{}"),
                    Some(&probe(extra)),
                )
                .expect_err("the door refuses by the stock cause before compile can"),
            );
            assert_eq!(answer["reason"], "bodyInvalid", "{extra}");
            assert!(
                hint_names(&answer, names),
                "'{extra}' must name '{names}': {answer}"
            );
        };
        refuse(
            &format!(r#"{{"ace":{{{ACE_BLOCK},"unknown":1}}}}"#),
            "unknown",
        );
        refuse(r#"{"ace":{"shift":3,"bpm":120}}"#, "exactly 12 keys");
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"topK\":30", "\"topK\":30.5")
            ),
            "ace.topK: an integer is required",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"bpm\":120", "\"bpm\":120.5")
            ),
            "ace.bpm: an integer is required",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"bpm\":120", "\"bpm\":301")
            ),
            "ace.bpm: 10..300",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"topK\":30", "\"topK\":101")
            ),
            "ace.topK: 0..100",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"language\":\"en\"", "\"language\":\"xx\"")
            ),
            "ace.language",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"timeSignature\":\"4\"", "\"timeSignature\":\"5\"")
            ),
            "ace.timeSignature",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"generateAudioCodes\":true", "\"generateAudioCodes\":1")
            ),
            "generateAudioCodes",
        );
        refuse(
            &format!(
                r#"{{"ace":{{{}}}}}"#,
                ACE_BLOCK.replace("\"shift\":3", "\"shift\":\"3\"")
            ),
            "ace.shift",
        );
    }

    #[test]
    fn the_ace_integral_members_accept_integral_floats_and_emit_integers() {
        // The stock settings gate admits an INTEGRAL float (`as_f64` plus a
        // zero-fraction test), but the graph feeds the value into INT node inputs.
        // The M11 emission law integralizes at the door; the fraction side of the
        // law is a refusal (block-law test above). Two-wall agreement lives in
        // `intent_truth`: the stock arm accepts 30.0 too — and refuses 30.5.
        let block = ACE_BLOCK
            .replace("\"topK\":30", "\"topK\":30.0")
            .replace("\"bpm\":120", "\"bpm\":120.0");
        let mut request = ace_slots("ace/ace.safetensors");
        extend(&mut request, &format!(r#"{{"ace":{{{block}}}}}"#));
        let intent = fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&request))
            .expect("integral floats are legal stock-side")
            .plan()
            .complete_or_refuse()
            .expect("complete");
        assert_eq!(
            intent["ace"]["topK"],
            json!(30),
            "emitted as a JSON INTEGER"
        );
        assert!(intent["ace"]["topK"].is_i64(), "not 30.0: {intent}");
        assert_eq!(intent["ace"]["bpm"], json!(120));
        assert!(intent["ace"]["bpm"].is_i64(), "not 120.0: {intent}");
    }

    #[test]
    fn the_ace_diffusion_law_refuses_the_image_shape_the_1_0_pairing_and_a_missing_triple() {
        // 1.0 + split triple: the stock pairing law, refused at the door naming it.
        let mut one = ace_slots("ace/ace.safetensors");
        extend(&mut one, &format!(r#"{{"diffusion":{ACE_SPLIT}}}"#));
        let answer = body(
            fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&one))
                .expect_err("ACE-Step 1.0 is all-in-one only"),
        );
        assert_eq!(answer["reason"], "bodyInvalid");
        assert!(hint_names(&answer, "all-in-one checkpoint"), "{answer}");
        // `clipType` is the IMAGE recipe's key; the ACE struct denies it (the
        // DualCLIPLoader's "ace" type is hard-wired compiler-side).
        let mut clipped = ace_slots("ace/ace-step-1.5-turbo.safetensors");
        extend(
            &mut clipped,
            r#"{"diffusion":{"textEncoder":"ace/e1.safetensors","textEncoder2":"ace/e2.safetensors","vae":"ace/vae.safetensors","clipType":"ace"}}"#,
        );
        let answer = body(
            fill(
                "ace-step-1-5-turbo",
                "t2m",
                None,
                &sheet("{}"),
                Some(&clipped),
            )
            .expect_err("no clipType in the ACE split recipe"),
        );
        assert_eq!(answer["reason"], "bodyInvalid");
        assert!(hint_names(&answer, "clipType"), "{answer}");
        // Identical encoders: the stock split law.
        let mut twin = ace_slots("ace/ace-step-1.5-turbo.safetensors");
        extend(
            &mut twin,
            r#"{"diffusion":{"textEncoder":"ace/e1.safetensors","textEncoder2":"ace/e1.safetensors","vae":"ace/vae.safetensors"}}"#,
        );
        let answer = body(
            fill("ace-step-1-5-turbo", "t2m", None, &sheet("{}"), Some(&twin))
                .expect_err("the two encoders must be distinct"),
        );
        assert!(hint_names(&answer, "distinct"), "{answer}");
        // A GGUF component refuses (the stock split law names it).
        let mut gguf_component = ace_slots("ace/ace-step-1.5-turbo.safetensors");
        extend(
            &mut gguf_component,
            r#"{"diffusion":{"textEncoder":"ace/e1.gguf","textEncoder2":"ace/e2.safetensors","vae":"ace/vae.safetensors"}}"#,
        );
        let answer = body(
            fill(
                "ace-step-1-5-turbo",
                "t2m",
                None,
                &sheet("{}"),
                Some(&gguf_component),
            )
            .expect_err("the ACE split law refuses GGUF components"),
        );
        assert!(hint_names(&answer, "non-GGUF"), "{answer}");
        // A 1.5 row WITHOUT the triple stays open naming the slot (the sheet's
        // loader law): one-wall stricter than compile, and the refusal says so —
        // compile would emit an all-in-one graph around a UNET name that the
        // prereq wall then refuses.
        let plan = fill(
            "ace-step-1-5-turbo",
            "t2m",
            None,
            &sheet("{}"),
            Some(&ace_slots("ace/ace-step-1.5-turbo.safetensors")),
        )
        .expect("fill runs")
        .plan();
        let missing = plan
            .complete_or_refuse()
            .expect_err("the split triple is a required slot for a diffusion-loader row");
        assert!(missing.contains(&"diffusion"), "{missing:?}");
    }

    #[test]
    fn an_ace_duration_off_the_family_grid_or_the_stock_range_refuses() {
        for bad in ["120.0", "0.96", "1000.5"] {
            let mut request = ace_slots("ace/ace.safetensors");
            extend(&mut request, &format!(r#"{{"maxDuration":{bad}}}"#));
            let answer = body(
                fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&request))
                    .expect_err("{bad} is not a legal ACE-1.0 duration"),
            );
            assert_eq!(answer["reason"], "bodyInvalid", "{bad}");
        }
        // 120.0 IS legal on the 1.5 grid (0.04 s frames) — the law is the FAMILY's
        // latent clock, not a global step.
        let mut request = ace_slots("ace/ace-step-1.5-turbo.safetensors");
        extend(
            &mut request,
            &format!(r#"{{"maxDuration":120.0,"diffusion":{ACE_SPLIT}}}"#),
        );
        fill(
            "ace-step-1-5-turbo",
            "t2m",
            None,
            &sheet("{}"),
            Some(&request),
        )
        .expect("120.0 rides the 1.5 grid")
        .plan();
    }

    #[test]
    fn the_ace_arm_refuses_gguf_bogus_planning_and_any_cover_posture() {
        let answer = body(
            fill(
                "ace-step-1-0",
                "music",
                None,
                &sheet("{}"),
                Some(&ace_slots("ace/ace.gguf")),
            )
            .expect_err("the stock ACE arm refuses GGUF checkpoints"),
        );
        assert!(hint_names(&answer, "GGUF"), "{answer}");
        let mut planned = ace_slots("ace/ace.safetensors");
        extend(&mut planned, r#"{"planning":"full"}"#);
        let answer = body(
            fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&planned))
                .expect_err("stock accepts planning off only"),
        );
        assert!(hint_names(&answer, "planning off"), "{answer}");
        let mut cover = ace_slots("ace/ace.safetensors");
        extend(&mut cover, r#"{"audio":["deas-inputs/song.flac"]}"#);
        let answer = body(
            fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&cover))
                .expect_err("the ACE arm runs no cover row"),
        );
        assert_eq!(answer["reason"], "modeUnsupported");
        assert!(hint_names(&answer, "no cover row"), "{answer}");
        // LEG M15 truth: `audioEnhance` IS a door key on the video arm (the
        // stock `audio_post::settings` law at the wall, the stage rides the
        // plan stock-side). The music arms keep their own strict extras law
        // and refuse it naming the closed set: stock is legal for
        // music-generation (jobs_audio_post.rs:18-23) but opening the music
        // extras set is a music-leg ruling — one-wall stricter, stated.
        let mut stray = ace_slots("ace/ace.safetensors");
        extend(&mut stray, r#"{"audioEnhance":{"mode":"clean"}}"#);
        let answer = body(
            fill("ace-step-1-0", "music", None, &sheet("{}"), Some(&stray))
                .expect_err("the wrapper is not a door key"),
        );
        assert!(hint_names(&answer, "audioEnhance"), "{answer}");
    }

    #[test]
    fn a_music_duration_off_the_grid_or_over_the_ceiling_refuses() {
        for bad in ["120.01", "900.5"] {
            let mut request = music_slots();
            extend(&mut request, &format!(r#"{{"maxDuration":{bad}}}"#));
            let answer = body(
                fill("yue2", "music", None, &sheet("{}"), Some(&request))
                    .expect_err("{bad} is not a legal music duration"),
            );
            assert_eq!(answer["reason"], "bodyInvalid", "{bad}");
        }
    }

    #[test]
    fn the_generation_block_must_stay_inside_the_stock_bounds() {
        let mut request = music_slots();
        extend(
            &mut request,
            r#"{"generation":{"temperature":9,"topP":0.95,"topK":100,"repetitionPenalty":1.2,"cfgScale":1}}"#,
        );
        let body = body(
            fill("yue2", "music", None, &sheet("{}"), Some(&request))
                .expect_err("temperature 9 is outside the stock range"),
        );
        assert_eq!(body["reason"], "bodyInvalid");
        assert!(hint_names(&body, "generation.temperature"), "{body}");
    }

    #[test]
    fn runnable_modes_serves_both_music_words_for_yue2_and_every_ace_step_family() {
        // LEG M14b opened the ACE leg: the `..._for_yue2_only` surface pin (the
        // transport.rs:2307 era) is retired. Every t2m-declaring family with a
        // compile arm — the YuE2 row or a `music`-profile row — answers both music
        // words; a family with no music pipeline still never sees them.
        for family in [
            "yue2",
            "ace-step-1-0",
            "ace-step-1-5-turbo",
            "ace-step-1-5-xl-base",
        ] {
            let modes = runnable_modes(family);
            assert!(
                modes.contains(&"music") && modes.contains(&"t2m"),
                "{family}: {modes:?}"
            );
        }
        let anima = runnable_modes("anima");
        assert!(
            !anima.contains(&"music") && !anima.contains(&"t2m"),
            "no music words without the pipeline: {anima:?}"
        );
    }

    #[test]
    fn the_music_seeds_the_arm_invents_nothing_are_inside_the_stock_bounds() {
        // Every completed value is a mirror of a stock home; the law test pins that the
        // mirrors at least satisfy the stock ranges they claim to sit inside.
        for &(key, min, max) in &MUSIC_GENERATION_BOUNDS {
            let seeded = MUSIC_GENERATION_DEFAULTS
                .iter()
                .find(|(name, _)| *name == key)
                .unwrap_or_else(|| panic!("{key} has no stock seed"))
                .1;
            assert!(
                (min..=max).contains(&seeded),
                "generation.{key} seed {seeded} is outside {min}..{max}"
            );
        }
        let scaled = MUSIC_DURATION_FLOOR / MUSIC_DURATION_STEP;
        assert!(
            (scaled - scaled.round()).abs() < 1e-7,
            "the seeded duration rides the node's latent grid"
        );
        const {
            assert!(
                MUSIC_DURATION_STEP <= MUSIC_DURATION_FLOOR
                    && MUSIC_DURATION_FLOOR <= MUSIC_DURATION_LIMIT
            );
        }
        assert_eq!(MUSIC_MAX_AUDIO, 1);
    }

    /* ---------- LEG resolution-sanity: the canvas gates at the door ---------- */

    /// The frames-x-pixels budget: the per-frame laws bound each factor, only the
    /// product bounds the decode. One pair straddles the named constant exactly.
    #[test]
    fn the_video_pixel_frame_budget_refuses_a_film_past_the_wall() {
        let dials = Dials {
            width: Some(4096),
            height: Some(4096),
            ..Dials::default()
        };
        let ltx = extras(
            r#"{"checkpoint":"ltx/model.safetensors","positivePrompt":"x",
                "diffusion":{"textEncoder":"gemma.safetensors","clipType":"ltxv","vae":"video_vae.safetensors"},
                "ltx":{"textProjection":"proj.safetensors","audioVae":"audio_vae.safetensors","passes":1}}"#,
        );
        let over = body(
            fill(
                "ltx-2",
                "video",
                Some(&dials),
                &sheet("{}"),
                Some(&ltx_request(&ltx, 257)),
            )
            .expect_err("4096x4096x257 = 4.3e9+1 pixels-frames"),
        );
        assert_eq!(over["reason"], "bodyInvalid");
        assert!(hint_names(&over, "pixels-frames"));
        assert!(hint_names(&over, "4096x4096 x 257"));
        // One grid step under the wall: 4096x4096x249 = 4,278,190,080 fits.
        fill(
            "ltx-2",
            "video",
            Some(&dials),
            &sheet("{}"),
            Some(&ltx_request(&ltx, 249)),
        )
        .expect("inside the budget fills");
        const {
            assert!(MAX_VIDEO_PIXEL_FRAMES == 4_294_967_296);
        }
    }

    /// The ltx video request of the budget pair: the shared slots/diffusion/`ltx`
    /// block plus the per-case `frames` dial.
    fn ltx_request(ltx: &Map<String, Value>, frames: u64) -> Map<String, Value> {
        let mut request = ltx.clone();
        extend(&mut request, &format!(r#"{{"frames":{frames}}}"#));
        request
    }

    /// The raised floor: 8x8 (one latent cell) fills at the door; 0 (the floor
    /// edge from below) is refused naming the new law.
    #[test]
    fn the_image_canvas_floor_is_eight_and_refuses_the_edge_below_it() {
        let dials = Dials {
            width: Some(8),
            height: Some(8),
            ..Dials::default()
        };
        let plan = fill("sdxl", "t2i", Some(&dials), &sheet("{}"), None)
            .expect("8x8 is the latent-grid floor")
            .plan();
        assert_eq!(dial_value(&plan.fields, "width"), Some(json!(8)));
        assert_eq!(dial_value(&plan.fields, "height"), Some(json!(8)));
        let dials = Dials {
            width: Some(0),
            ..Dials::default()
        };
        let refused = body(
            fill("sdxl", "t2i", Some(&dials), &sheet("{}"), None)
                .expect_err("0 is under the floor"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "width 0"), "{refused}");
        assert!(hint_names(&refused, "8..=8192"), "{refused}");
    }

    /// The video arm's floor moved with the image arm's: an under-floor width is
    /// refused naming the 8..=8192 bound (the family grid is a separate law).
    #[test]
    fn the_video_canvas_floor_names_the_eight_bound() {
        let dials = Dials {
            width: Some(4),
            height: Some(704),
            ..Dials::default()
        };
        let request = extras(
            r#"{"checkpoint":"ltx/model.safetensors","positivePrompt":"x",
                "diffusion":{"textEncoder":"gemma.safetensors","clipType":"ltxv","vae":"video_vae.safetensors"},
                "ltx":{"textProjection":"proj.safetensors","audioVae":"audio_vae.safetensors","passes":1}}"#,
        );
        let refused = body(
            fill("ltx-2", "video", Some(&dials), &sheet("{}"), Some(&request))
                .expect_err("4 is under the floor"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "integer 8..=8192"), "{refused}");
    }

    /// The refine block is a second render canvas: the door admits the stock
    /// edges and product, and refuses an oversized one before the spool sees it.
    #[test]
    fn the_refine_block_is_gated_by_the_canvas_law_at_the_door() {
        let refused = body(
            fill(
                "sdxl",
                "refine",
                None,
                &sheet("{}"),
                Some(&extras(
                    r#"{"refine":{"width":16384,"height":1024,"denoise":0.4}}"#,
                )),
            )
            .expect_err("a 16384 refine edge never reaches the spool"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "refine.width"), "{refused}");
        let refused = body(
            fill(
                "sdxl",
                "refine",
                None,
                &sheet("{}"),
                Some(&extras(
                    r#"{"refine":{"width":8192,"height":4096,"denoise":0.4}}"#,
                )),
            )
            .expect_err("8192x4096 is 33.5M"),
        );
        assert!(hint_names(&refused, "16.7M"), "{refused}");
        let admitted = fill(
            "sdxl",
            "refine",
            None,
            &sheet("{}"),
            Some(&extras(
                r#"{"checkpoint":"sd/model.safetensors","positivePrompt":"x","outputPrefix":"agent/r","refine":{"width":8192,"height":2048,"denoise":0.4}}"#,
            )),
        )
        .expect("8192x2048 is exactly 16.7M and admits")
        .plan();
        assert!(admitted.extras.contains_key("refine"));
    }

    /// The latent-upscale result canvas is measured at the door with the stock
    /// size function over the merged dials, and the scale range law mirrors the
    /// stock family law (h3 1..=8, ltx exactly 2).
    #[test]
    fn the_latent_upscale_result_canvas_is_gated_at_the_door() {
        let upscale = |scale: &str| {
            format!(
                r#"{{"latentUpscale":{{"model":"minimax/minimax_h3_latent_upscaler.safetensors","scale":{scale},"steps":4,"denoise":0.5}}}}"#
            )
        };
        let mut request = h3_slots("minimax_h3");
        extend(&mut request, &upscale("8.0"));
        let refused = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("1024x768 x 8 = 8192x6144 crosses the edge"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "8192x6144"), "{refused}");
        let mut request = h3_slots("minimax_h3");
        extend(&mut request, &upscale("9.0"));
        let refused = body(
            fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
                .expect_err("scale 9 is outside the stock range"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "1..=8"), "{refused}");
        let mut request = h3_slots("minimax_h3");
        extend(&mut request, &upscale("4.0"));
        // The accept case must clear the whole door, so it carries the family's
        // mode leg too (`h3.mode` is the stock H3 requirement).
        extend(
            &mut request,
            r#"{"h3":{"mode":"T2VA","audioVae":"h3_audio_vae.safetensors","shiftVideo":1.0,"shiftAudio":1.0}}"#,
        );
        let plan = fill("minimax-h3", "video", None, &sheet("{}"), Some(&request))
            .expect("1024x768 x 4 = 4096x3072 is inside the canvas law")
            .plan();
        assert!(plan.extras.contains_key("latentUpscale"));
        let ltx = |scale: &str| {
            extras(&format!(
                r#"{{"checkpoint":"ltx/model.safetensors","positivePrompt":"x",
                "diffusion":{{"textEncoder":"gemma.safetensors","clipType":"ltxv","vae":"video_vae.safetensors"}},
                "ltx":{{"textProjection":"proj.safetensors","audioVae":"audio_vae.safetensors","passes":1}},
                "latentUpscale":{{"model":"ltx/ltx_2_spatial_upscaler.safetensors","scale":{scale}}}}}"#
            ))
        };
        let request = ltx("3.0");
        let refused = body(
            fill("ltx-2", "video", None, &sheet("{}"), Some(&request))
                .expect_err("ltx-2 pins scale exactly 2"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "exactly 2"), "{refused}");
        let request = ltx("2.0");
        let dials = Dials {
            width: Some(7360),
            height: Some(704),
            ..Dials::default()
        };
        let refused = body(
            fill("ltx-2", "video", Some(&dials), &sheet("{}"), Some(&request))
                .expect_err("7360x704 doubles to a 14720 edge"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "14720x1408"), "{refused}");
    }

    /// The i2i canvas law at the door: an unresized `inputImage` renders at its
    /// own dims, so the PLACED file's header dims ride the canvas law.
    #[test]
    fn an_oversized_placed_input_image_is_refused_at_the_door() {
        let root = tempfile::tempdir().expect("input root");
        let folder = root.path().join("deas-inputs");
        std::fs::create_dir_all(&folder).expect("placement folder");
        let head = |width: u32, height: u32| -> Vec<u8> {
            let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            bytes.extend_from_slice(&13u32.to_be_bytes());
            bytes.extend_from_slice(b"IHDR");
            bytes.extend_from_slice(&width.to_be_bytes());
            bytes.extend_from_slice(&height.to_be_bytes());
            bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
            bytes
        };
        std::fs::write(folder.join("big.png"), head(10_000, 10_000)).expect("placed");
        std::fs::write(folder.join("legal.png"), head(8, 8)).expect("placed");
        let sheet = sheet(r#"{"families":{"anima":{"denoise":0.5}}}"#);
        let request = extras(r#"{"inputImage":"deas-inputs/big.png"}"#);
        let refused = body(
            fill_at(
                "anima",
                "i2i",
                None,
                &sheet,
                Some(&request),
                Some(root.path()),
            )
            .expect_err("a 10000x10000 placed input cannot become a canvas"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "10000x10000"), "{refused}");
        assert!(hint_names(&refused, "inputImage"), "{refused}");
        let request = extras(r#"{"inputImage":"deas-inputs/legal.png"}"#);
        fill_at(
            "anima",
            "i2i",
            None,
            &sheet,
            Some(&request),
            Some(root.path()),
        )
        .expect("an 8x8 placed input is the latent-grid floor");
        // Absent file / no threaded root: the wall is inert, the existing grammar
        // laws own the placement, and the compile-side mirror catches the row.
        let request = extras(r#"{"inputImage":"deas-inputs/absent.png"}"#);
        fill_at(
            "anima",
            "i2i",
            None,
            &sheet,
            Some(&request),
            Some(root.path()),
        )
        .expect("the existence law is the queue door's, not this wall's");
        let request = extras(r#"{"inputImage":"deas-inputs/big.png"}"#);
        fill("anima", "i2i", None, &sheet, Some(&request))
            .expect("no root threaded: the compile-side mirror owns this row");
    }

    /// `inputResize` targets ride the canvas law; `inpaintCrop` rides compile's
    /// numeric crop mirror (keys, bounds, model-aligned target, product) plus the
    /// ladder half (the rectangle inside the merged source edges); `inputLayers`
    /// rides compile's layer numerics (x/y bounded, width/height 1..=8192).
    #[test]
    fn the_resize_crop_and_layer_legs_mirror_the_compile_numerics() {
        // A target off the canvas grid while the pad-equality law still holds
        // (1020 + 2 + 2 == the merged 1024): the size wall is what refuses.
        let dials = Dials {
            width: Some(1024),
            height: Some(1024),
            denoise: Some(0.5),
            ..Dials::default()
        };
        let refused = body(
            fill(
                "sdxl",
                "upscale",
                Some(&dials),
                &sheet("{}"),
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png","inputResize":{"width":1020,"height":1024,"crop":"disabled","pad":{"left":2,"right":2,"top":0,"bottom":0}},"upscaleModel":"4x-UltraSharp.pth"}"#,
                )),
            )
            .expect_err("1020 is off the canvas grid"),
        );
        assert_eq!(refused["reason"], "modeUnsupported", "{refused}");
        assert!(hint_names(&refused, "inputResize"), "{refused}");
        assert!(hint_names(&refused, "8..=8192"), "{refused}");

        let mask = sheet(r#"{"families":{"anima":{"denoise":0.8}}}"#);
        let refused = body(
            fill(
                "anima",
                "inpaint",
                None,
                &mask,
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png","inputMask":"deas-masks/00000000-0000-4000-8000-000000000000.png","inpaintCrop":{"x":40,"y":20,"width":1000,"height":800,"targetWidth":1024,"targetHeight":768}}"#,
                )),
            )
            .expect_err("40+1000 crosses the merged 1024 width"),
        );
        assert_eq!(refused["reason"], "modeUnsupported");
        assert!(hint_names(&refused, "source rectangle"), "{refused}");
        let refused = body(
            fill(
                "anima",
                "inpaint",
                None,
                &mask,
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png","inputMask":"deas-masks/00000000-0000-4000-8000-000000000000.png","inpaintCrop":{"x":40,"y":20,"width":100,"height":80,"targetWidth":8200,"targetHeight":768}}"#,
                )),
            )
            .expect_err("an 8200 target edge is off the canvas grid"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "8..=8192"), "{refused}");
        let refused = body(
            fill(
                "anima",
                "i2i",
                None,
                &mask,
                Some(&extras(
                    r#"{"inputImage":"deas-inputs/pic.png","inputLayers":[{"image":"deas-inputs/layer.png","x":0,"y":0,"width":9000,"height":64}]}"#,
                )),
            )
            .expect_err("a 9000-wide layer crosses the 8192 bound"),
        );
        assert_eq!(refused["reason"], "bodyInvalid");
        assert!(hint_names(&refused, "1..=8192"), "{refused}");
    }

    /// LORA FAMILY ROUTING (owner ruling 2026-11-22): the `loras[]` shape wall must
    /// let a 12-hex handle and a full 64-hex fingerprint through its format arm -
    /// those are identity words, not file names, and the extension law cannot see
    /// them. The door rewrite (`routes::resolve_lora_bag`) turns them into the
    /// entry's real index name before the spool; a genuine non-safetensors name
    /// still dies at this wall.
    #[test]
    fn a_hex_lora_reference_passes_the_shape_wall_format_arm() {
        let handle = json!([{"name":"c3d19c1a0def","strength":0.6}]);
        check_passthrough_shape("loras", &handle).expect("the handle form passes");
        let digest = json!([{
            "name": "c3d19c1a0defce6b9005a2c8e1ef5935aaee90cc6ee932d1ed301729af9eca13",
            "strength": 0.6
        }]);
        check_passthrough_shape("loras", &digest).expect("the fingerprint form passes");
        let gguf = json!([{"name":"loose.gguf","strength":0.6}]);
        check_passthrough_shape("loras", &gguf).expect_err("a real GGUF name still dies");
    }
}
