//! Video recipes wired the way the owner's DaSiWa workflows do it (LTX OmniForge, Wan 2.2
//! FastFidelity, MiniMax H3 MythicAlchemy), not the ComfyUI templates. One intent,
//! `recipeId: "video-generation"`, discriminated by `family`.
use crate::jobs::{comfy_model_name, model_name, safe_choice, safe_output_prefix, valid_options};
use serde_json::{json, Value};

pub(crate) const FAMILIES: [&str; 4] = ["ltx-2", "wan", "minimax-h3", "minimax-h3-hyperflow"];
/// The HyperFlow Flash GGUF variant runs the same DaSiWa Director graph with a different loader and schedule.
pub(crate) fn is_h3(family: &str) -> bool {
    family == "minimax-h3" || family == "minimax-h3-hyperflow"
}
const FIELDS: [&str; 17] = [
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
const OPTIONAL: [&str; 14] = [
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
/// DaSiWa Enhanced Video Combine enums.
pub(crate) const CODECS: [&str; 5] = ["Auto", "AV1", "VP9", "H.265 (HEVC)", "H.264"];
pub(crate) const CONTAINERS: [&str; 6] = [
    "Auto",
    "WebM",
    "MKV",
    "MP4",
    "Animated WebP",
    "Animated AVIF",
];
pub(crate) const BIT_DEPTHS: [&str; 3] = ["Auto", "8-bit", "10-bit"];
pub(crate) const AUDIO_CODECS: [&str; 4] = ["Auto", "AAC", "Opus", "MP3"];
pub(crate) const AUDIO_BITRATES: [&str; 7] = ["64k", "96k", "128k", "160k", "192k", "256k", "320k"];
const H3_MODES: [&str; 5] = ["T2VA", "I2VA", "L2VA", "FL2VA", "REF2VA"];
/// The closed top-level key set of an `h3` row (AF2-M30): the same ten words
/// `validate_h3`'s `keys_in` arm gates on, extracted to module level so the set
/// has ONE home. Bump a word here and the agent door mirror
/// (`fill_plane.rs::build_h3_block`, the unknown-keys wall) follows the same
/// const — the door never restates this list. The live gap this pins: row
/// `cb46b38f-cf7e-471d-ad05-2f90e3646706` carried `durationSeconds` at h3
/// top level (it belongs inside `h3.continuity`, and only when continuity is
/// present); the door let it ride, stock prepare refused it as prepareRefused
/// and burned the poison-row guard. Same single-home doctrine as AF2-M25a
/// (`validate_continuity`) and AF2-M15 (`validate_refmods`).
pub(crate) const H3_KEYS: &[&str] = &[
    "mode",
    "audioVae",
    "shiftVideo",
    "shiftAudio",
    "references",
    "continuity",
    "media",
    "inputScaling",
    "refmods",
    "transition",
];
/// DaSiWa Director REF2VA lanes (slots per lane) and media modes of a video item.
const H3_LANES: [(&str, u64); 3] = [("image", 9), ("video", 3), ("audio", 3)];
const H3_MEDIA_MODES: [&str; 3] = ["video", "audio", "video_audio"];
/// Director `timeline_data.resolution.input_scaling` values (`helper_minimax_h3_director.py::INPUT_SCALING_MODES`).
const H3_INPUT_SCALING: [&str; 7] = [
    "Off",
    "Auto",
    "Target",
    "Fit",
    "Fill and crop",
    "Fit and pad",
    "Long side with divisible crop",
];
/// Every class the three graphs can emit; prepare() checks each against object_info.
pub(crate) const VIDEO_NODES: [&str; 42] = [
    "DEAS_H3StreamVideoSave",
    "ModelPreviewOverrideKJ",
    "DaSiWaH3TiledUpscale",
    "DaSiWaH3HiResRegenerate",
    "DualCLIPLoader",
    "LoraLoaderModelOnly",
    "RandomNoise",
    "KSamplerSelect",
    "BasicScheduler",
    "CFGGuider",
    "BasicGuider",
    "SamplerCustomAdvanced",
    "KSamplerAdvanced",
    "ModelSamplingSD3",
    "ImageScale",
    "LoadImage",
    "LoadVideo",
    "GetVideoComponents",
    "ImageFromBatch",
    "LTXVConditioning",
    "EmptyLTXVLatentVideo",
    "LTXVEmptyLatentAudio",
    "LTXVPreprocess",
    "LTXVAddGuide",
    "LTXVCropGuides",
    "LTXVConcatAVLatent",
    "LTXVSeparateAVLatent",
    "LTXVAudioVAEDecode",
    "LatentUpscaleModelLoader",
    "LTXVLatentUpsampler",
    "LTXVChunkFeedForward",
    "WanImageToVideo",
    "WanFirstLastFrameToVideo",
    "WanChunkFeedForward",
    "MiniMaxH3Director",
    "MiniMaxH3DirectorGuide",
    "HyperFlowGGUFLoader",
    "HyperFlowLoader",
    "HyperFlowSigmas",
    "MiniMaxH3SigmaShift",
    "MiniMaxChunkFeedForward",
    "DaSiWa_EnhancedVideoCombine",
];
pub(crate) const H3_CONTINUITY_NODES: [&str; 6] = [
    "DaSiWaH3ContinuitySegmentPrepare",
    "DaSiWaH3ContinuitySegmentDecode",
    "DaSiWaH3ContinuityPublish",
    "DaSiWaH3ClipAssemble",
    "DaSiWaH3TransitionGuide",
    "DaSiWaH3TransitionRender",
];
/// Experimental Dial Rack (`dials/nodes.py` of the optional ComfyUI-Dials or ComfyUI-MAINodes pack;
/// the same node ids in both): steering rows on the generation model, and the De-rope pass's hold map.
pub(crate) const DIAL_NODES: [&str; 2] = ["MAIDialRack", "MAIDialHoldMap"];
pub(crate) const DIAL_ROWS: usize = 8;
const DIAL_POINTS: usize = 64;
/// Row strength and curve level bound (the pack's own dial info caps strengths at 20).
pub(crate) const DIAL_LEVEL: f64 = 20.0;
/// Whole-piece seconds bound of a curve point.
const DIAL_SECONDS: f64 = 86_400.0;
/// Bound of a curve's authored blend steps: the largest sampler step count a job may ask for.
pub(crate) const DIAL_BLEND_STEPS: u64 = 150;
/// Jobs of at most this many sampler steps blend a time curve on every step by default.
const DIAL_BLEND_ALL: u64 = 8;

/// Sampler steps a time curve blends on (`timecurve.py`: the first `time.steps` steps run the model
/// twice and blend per latent frame, after which the row is off; one extra model call per blended
/// step). The node's own default is 2 whatever the step count. Provisional default (2026-11-16):
/// a job of at most `DIAL_BLEND_ALL` steps blends on all of them, a longer one on a third, at
/// least 2. Short schedules: on the 6-step chain a look dial followed its curve with 6 blend
/// steps and gave only a faint wash with 2, and the motion dial behaved the same with 6 as with 2
/// (one seed each). Long schedules: at 25 steps the motion dial did nothing with 2 and acted
/// with 8 (one seed); no look dial was tried there.
pub(crate) fn dial_blend_steps(steps: u64) -> u64 {
    if steps <= DIAL_BLEND_ALL {
        steps.max(1)
    } else {
        ((2 * steps + 3) / 6).max(2)
    }
}

/// Whether the bounded streaming decode path is available for this intent at all (same rules as
/// the `streamDecode` validation in `validate`). Host-memory admission uses it only to word its
/// advice - it never changes which path a job takes.
pub(crate) fn h3_stream_candidate(i: &Value) -> bool {
    is_video(i)
        && is_h3(i["family"].as_str().unwrap_or_default())
        && i.get("latentUpscale").is_some()
        && i["h3"]["continuity"]["outputMode"] != "segment"
        && i.get("videoPost").is_none()
        && i.get("faceRefine").is_none()
        && !matches!(
            i["output"]["container"].as_str(),
            Some("Animated WebP" | "Animated AVIF")
        )
}

pub(crate) fn is_video(intent: &Value) -> bool {
    intent["recipeId"] == "video-generation"
        || crate::jobs_video_post::is_enhance(intent)
        || is_join(intent)
        || crate::jobs_face_refine::is_face_refine(intent)
}

pub(crate) fn is_join(intent: &Value) -> bool {
    intent["recipeId"] == "h3-join"
}

/// Canvas multiple, frame step and frame offset: EmptyLTXVLatentVideo /32 & 8k+1, Wan /16 & 4k+1, H3 /32 & 17k+5.
fn grid(family: &str) -> (u64, u64, u64) {
    match family {
        "ltx-2" => (32, 8, 1),
        "wan" => (16, 4, 1),
        _ => (32, 17, 5),
    }
}

fn pick(o: &Value, key: &str, list: &[&str]) -> bool {
    o[key].as_str().is_some_and(|v| list.contains(&v))
}

pub(crate) fn continuity_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn keys_in(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}

pub(crate) fn valid_output(o: &Value) -> bool {
    keys_in(
        o,
        &[
            "codec",
            "container",
            "bitDepth",
            "quality",
            "audioCodec",
            "audioBitrate",
            "saveFirstFrame",
            "saveLastFrame",
            "imageFormat",
            "imageCompression",
        ],
    ) && pick(o, "codec", &CODECS)
        && pick(o, "container", &CONTAINERS)
        && pick(o, "bitDepth", &BIT_DEPTHS)
        && o["quality"].as_u64().is_some_and(|q| q <= 51)
        && pick(o, "audioCodec", &AUDIO_CODECS)
        && pick(o, "audioBitrate", &AUDIO_BITRATES)
        && o["saveFirstFrame"].is_boolean()
        && o["saveLastFrame"].is_boolean()
        && o.get("imageFormat")
            .is_none_or(|f| f.as_str().is_some_and(|f| ["png", "webp"].contains(&f)))
        && o.get("imageCompression")
            .is_none_or(|c| c.as_u64().is_some_and(|c| c <= 100))
}

fn finite(v: &Value, min: f64, max: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (min..=max).contains(&n))
}

pub(crate) fn learned_latent_model(name: &str) -> bool {
    comfy_model_name(name) && (name.ends_with(".safetensors") || name.ends_with(".sft"))
}

/// Post-upscale pixel canvas; H3 uses Python round's ties-to-even 32-pixel grid.
pub(crate) fn latent_upscale_size(i: &Value) -> (u64, u64) {
    if let Some(target) = i["latentUpscale"]["regenerate"]["target"].as_str() {
        let n = |key: &str| i[key].as_u64().unwrap_or(0);
        return regenerate_size(n("width"), n("height"), target);
    }
    let dimension = |key: &str| {
        let n = i[key].as_u64().unwrap_or(0);
        let Some(u) = i.get("latentUpscale") else {
            return n;
        };
        if i["family"] == "minimax-h3" {
            ((n as f64 * u["scale"].as_f64().unwrap_or(1.0) / 32.0).round_ties_even() as u64) * 32
        } else {
            n * 2
        }
    };
    (dimension("width"), dimension("height"))
}

/// H3 Hi-Res Regenerate targets: the reference's landscape grids (1080P/4K on whole latent patches).
pub(crate) const REGENERATE_TARGETS: [&str; 4] = ["1080P", "2K", "4K", "Original"];

/// Canvas of `DaSiWaH3HiResRegenerate`: the 16:9 grid for drafts within 5 % of 16:9 (orientation kept),
/// else the draft aspect at the target's short side. shortcut: copy of the pack's
/// `regenerate_size` (node pack 0.5.50); on pack drift only the planned size is off, the render is the pack's.
pub(crate) fn regenerate_size(width: u64, height: u64, target: &str) -> (u64, u64) {
    if target == "Original" {
        return (width, height);
    }
    let (long, short) = match target {
        "1080P" => (1920, 1088),
        "4K" => (3840, 2176),
        _ => (2560, 1440),
    };
    let (min, max) = (width.min(height).max(1) as f64, width.max(height) as f64);
    if (max / min / (long as f64 / short as f64) - 1.0).abs() <= 0.05 {
        return if height > width {
            (short, long)
        } else {
            (long, short)
        };
    }
    let scaled = |n: u64| ((n as f64 * short as f64 / min / 32.0).round_ties_even() as u64) * 32;
    (scaled(width), scaled(height))
}

fn valid_regenerate(r: &Value) -> bool {
    keys_in(
        r,
        &[
            "lora",
            "target",
            "model",
            "spatialTiling",
            "strength",
            "denoise",
            "sharpness",
        ],
    ) && r["lora"]
        .as_str()
        .is_some_and(|l| comfy_model_name(l) && l.ends_with(".safetensors"))
        && pick(r, "target", &REGENERATE_TARGETS)
        && r.get("strength").is_none_or(|s| finite(s, 0.0, 2.0))
        && r.get("denoise").is_none_or(|d| finite(d, 0.0, 1.0))
        && r.get("sharpness")
            .is_none_or(|s| s.as_i64().is_some_and(|s| (1..=6).contains(&s)))
        && r.get("model").is_none_or(|m| {
            m.as_str()
                .is_some_and(|m| comfy_model_name(m) && !crate::jobs::is_gguf(m))
        })
        && r.get("spatialTiling").is_none_or(Value::is_boolean)
}

/// `DaSiWaH3HiResRegenerate` in place of the Enhanced Upscale node: the refiner LoRA goes on a clone of
/// the loaded base (node `1`, or the card's own `model`) with the Workbench options but without the
/// generation LoRAs, because the merged regenerate LoRA already carries Turbo and Sharp.
fn h3_regenerate_node(g: &mut Value, i: &Value, conditioning: Value, latent: Value) -> Value {
    let u = &i["latentUpscale"];
    let r = &u["regenerate"];
    let base = match r.get("model") {
        Some(m) => {
            g["RM"] = unet_loader(i["family"].as_str().unwrap_or_default(), m);
            json!(["RM", 0])
        }
        None => json!(["1", 0]),
    };
    let mut plain = i.clone();
    plain["loras"] = json!([]);
    // Like the LoRAs, the dials stay on the generation chain.
    if let Some(o) = plain.as_object_mut() {
        o.remove("dials");
    }
    let model = model_chain(
        g,
        "R",
        base,
        None,
        &plain,
        "MiniMaxChunkFeedForward",
        "seq_threshold",
    );
    let mut node = json!({"class_type":"DaSiWaH3HiResRegenerate","inputs":{"model":model,"conditioning":conditioning,"latent":latent,
        "lora_name":r["lora"],"strength":r.get("strength").cloned().unwrap_or(json!(1.0)),"upscale_model":u["model"],"target":r["target"],"seed":i["seed"],
        "noise":["N",0],"spatial_tiling":r.get("spatialTiling").cloned().unwrap_or(json!(true))}});
    with_low_vram_defaults(&mut node);
    // Shared authoring values only reach the node when explicitly set; older packs and legacy intents stay untouched.
    if let Some(d) = r.get("denoise") {
        node["inputs"]["denoise"] = d.clone();
    }
    if let Some(s) = r.get("sharpness") {
        node["inputs"]["upscale_sharpness"] = s.clone();
    }
    node
}

pub(crate) fn h3_latent_model(name: &str) -> bool {
    let file = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    learned_latent_model(name)
        && file.starts_with("minimax_h3_latent_upscal")
        && !file.contains("ltx")
}

fn ltx_latent_model(name: &str) -> bool {
    let file = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    learned_latent_model(name)
        && file.starts_with("ltx")
        && file.contains("spatial")
        && file.contains("upscal")
}

/// Optional `DaSiWaH3TiledUpscale` inputs (intent key, node input); omitted keys keep the node defaults.
const H3_LATENT_ADVANCED_INPUTS: [(&str, &str); 19] = [
    ("cfg", "cfg"),
    ("scheduler", "scheduler"),
    ("precision", "upscale_precision"),
    ("memoryBudgetMb", "memory_budget_mb"),
    ("spatialTiling", "spatial_tiling"),
    ("temporalChunking", "temporal_chunking"),
    ("spikeGuard", "spike_guard"),
    ("guardSensitivity", "guard_sensitivity"),
    ("guardStrength", "guard_strength"),
    ("guardMode", "guard_mode"),
    ("memoryPlanning", "enforce_memory_budget"),
    ("memoryReservePct", "memory_reserve_pct"),
    ("continuitySoftRefine", "continuity_soft_refine"),
    ("continuityMaskStrength", "continuity_mask_strength"),
    ("sharpness", "upscale_sharpness"),
    ("temporalJoin", "temporal_join"),
    ("tileReferences", "tile_references"),
    ("weightResidency", "weight_residency"),
    ("maxResidentGb", "max_resident_gb"),
];

/// Node pack >= 0.5.62 low-VRAM tiling inputs, emitted on every H3 upscale and regenerate node:
/// ComfyUI's memory reservation sized for one tile and the exact prefix join between temporal
/// windows. Older packs ignore unknown inputs (V1 nodes), so they keep rendering as before.
fn with_low_vram_defaults(node: &mut Value) {
    let inputs = node["inputs"].as_object_mut().unwrap();
    inputs.insert("temporal_join".into(), json!("prefix"));
    inputs.insert("tile_references".into(), json!("full"));
    inputs.insert("tile_memory_estimate".into(), json!(true));
    // Whole model loaded when it fits beside one tile, otherwise streamed (less VRAM, same speed when compute-bound).
    inputs.insert("weight_residency".into(), json!("auto"));
    inputs.insert("max_resident_gb".into(), json!(0.0));
}

/// `DaSiWaH3TiledUpscale` over the house sampling nodes (`SS` model, `Q` sampler, `N` noise) with the
/// intent's `latentUpscale` settings; the video path adds its Continuity/Director/VAE links.
pub(crate) fn h3_upscale_node(i: &Value, conditioning: Value, latent: Value) -> Value {
    let u = &i["latentUpscale"];
    let mut node = json!({"class_type":"DaSiWaH3TiledUpscale","inputs":{
        "model":["SS",0],"conditioning":conditioning,"latent":latent,"sampler":["Q",0],"noise":["N",0],"sampler_name":i["sampler"],
        "scale":u["scale"],"upscale_model":u["model"],"steps":u["steps"],"denoise":u["denoise"],"seed":i["seed"],
        "cfg":1.0,"scheduler":"simple","memory_budget_mb":0,"upscale_precision":"auto",
        "continuity_soft_refine":false,"continuity_mask_strength":1.0,
        "spatial_tiling":true,"temporal_chunking":true,"spike_guard":false,
        "guard_sensitivity":4.3,"guard_strength":1.0,"guard_mode":"burn_direction",
        "enforce_memory_budget":true,"memory_reserve_pct":5.0
    }});
    with_low_vram_defaults(&mut node);
    if let Some(a) = u.get("advanced") {
        for (key, input) in H3_LATENT_ADVANCED_INPUTS {
            if let Some(v) = a.get(key) {
                node["inputs"][input] = v.clone();
            }
        }
    }
    node
}

fn valid_h3_latent_advanced(a: &Value) -> bool {
    let Some(o) = a.as_object() else {
        return false;
    };
    o.iter().all(|(k, v)| match k.as_str() {
        "cfg" => finite(v, 0.0, 20.0),
        // Exact backend scheduler names are lowercase identifiers; the backend rejects unknown ones.
        "scheduler" => v.as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        }),
        "precision" => matches!(v.as_str(), Some("auto" | "bf16" | "fp16" | "fp32")),
        "memoryBudgetMb" => v.as_u64().is_some_and(|n| n <= 131_072),
        "spatialTiling"
        | "temporalChunking"
        | "spikeGuard"
        | "memoryPlanning"
        | "continuitySoftRefine" => v.is_boolean(),
        "guardSensitivity" => finite(v, 1.5, 12.0),
        "guardStrength" | "continuityMaskStrength" => finite(v, 0.0, 1.0),
        "guardMode" => matches!(v.as_str(), Some("burn_direction" | "both")),
        "memoryReservePct" => finite(v, 0.0, 100.0),
        "sharpness" => v.as_u64().is_some_and(|n| (1..=6).contains(&n)),
        "temporalJoin" => matches!(v.as_str(), Some("prefix" | "crossfade")),
        "tileReferences" => matches!(v.as_str(), Some("full" | "crop_video" | "crop_all")),
        "weightResidency" => matches!(v.as_str(), Some("auto" | "keep" | "stream")),
        "maxResidentGb" => finite(v, 0.0, 1024.0),
        _ => false,
    })
}

pub(crate) fn regenerate_only(i: &Value) -> bool {
    i["family"] == "minimax-h3" && i["latentUpscale"]["regenerate"]["target"] == "Original"
}

pub(crate) fn validate_latent_upscale(i: &Value, family: &str) -> Result<(), String> {
    let Some(u) = i.get("latentUpscale") else {
        return Ok(());
    };
    let settings = match family {
        "ltx-2" => keys_in(u, &["model", "scale"]) && u["scale"].as_f64() == Some(2.0),
        // Hi-Res Regenerate replaces the upscale settings with its pinned recipe; H3 video only.
        "minimax-h3" if u.get("regenerate").is_some() => {
            is_video(i)
                && keys_in(u, &["model", "regenerate"])
                && valid_regenerate(&u["regenerate"])
        }
        "minimax-h3" => {
            keys_in(u, &["model", "scale", "steps", "denoise", "advanced"])
                && finite(&u["scale"], 1.0, 8.0)
                && u["steps"].as_u64().is_some_and(|n| (1..=100).contains(&n))
                && finite(&u["denoise"], 0.0, 1.0)
                && u.get("advanced").is_none_or(valid_h3_latent_advanced)
        }
        _ => false,
    };
    let model_valid = if regenerate_only(i) {
        u["model"] == "interpolation"
    } else {
        u["model"].as_str().is_some_and(if family == "minimax-h3" {
            h3_latent_model
        } else {
            ltx_latent_model
        })
    };
    if !settings || !model_valid {
        return Err("Invalid latentUpscale: learned .safetensors/.sft model and family-specific settings required".into());
    }
    let (w, h) = latent_upscale_size(i);
    if w > 8192 || h > 8192 || w * h > 16_777_216 {
        return Err("latentUpscale canvas exceeds dimension or pixel limits".into());
    }
    let prefix = format!("{}_original", effective_output_prefix(i).as_str().unwrap());
    if !safe_output_prefix(&prefix) {
        return Err("latentUpscale original output prefix exceeds limits".into());
    }
    if family == "minimax-h3"
        && i["h3"]["continuity"]["capture"] == true
        && i["h3"]["continuity"]["outputMode"] == "segment"
        && segment_crop_plan(i).is_none()
    {
        return Err("latentUpscale with captured segment output needs a pinned checkpoint clip (imported-video sources are unsupported) with its sourceFrames from the session list".into());
    }
    Ok(())
}

/// Compile-time copy of the node pack's segment_policy.render_layout crop fields: the core decode of
/// the prepared render window starts at the global frame offset, so the new segment is its final
/// extension frames. shortcut: mirrors the pack's layout constants; on pack drift the pack's own
/// render validation fails closed at runtime.
fn segment_crop_plan(i: &Value) -> Option<(u64, u64)> {
    let c = &i["h3"]["continuity"];
    if c["capture"] != true || c["outputMode"] != "segment" {
        return None;
    }
    // The node pack renders a segment crop only over a source window: a first take has none, and
    // an imported-video source builds its window latent inside SegmentPrepare (not reproducible
    // from compile-time fields), so only checkpoint pins are supported here.
    if c["sourceKind"] == "video" {
        return None;
    }
    let source = c["sourceFrames"].as_u64()?;
    let extension = continuation_extension(i)?;
    Some((source - source.saturating_sub(102) / 51 * 51, extension))
}

/// Continuation timing: newly visible seconds snapped to 17-frame steps. Without authored
/// duration the Director receives frames/24 seconds, so the snap runs on frames/17 directly.
fn continuation_extension(i: &Value) -> Option<u64> {
    let steps = match i["h3"]["continuity"]
        .get("durationSeconds")
        .and_then(Value::as_f64)
    {
        Some(s) => s * 24.0 / 17.0,
        None => i["frames"].as_f64()? / 17.0,
    };
    Some(((steps + 0.5).floor().max(1.0) as u64) * 17)
}

/// Piece frame at which a checkpoint continuation's sampled window starts: the pinned clip's
/// cumulative frame count minus the hidden overlap the pack resolves
/// (`h3_continuity/core.py::continuation_timing`: the largest of 73/56/39/22/5 that fits the
/// requested context (22 when omitted), `362 - extension` and the source). `None` when the intent
/// does not carry what that needs (no `sourceFrames`, an imported-video source, no legal overlap).
fn continuation_window_start(i: &Value) -> Option<u64> {
    let c = &i["h3"]["continuity"];
    if c["sourceKind"] == "video" {
        return None;
    }
    let source = c["sourceFrames"].as_u64()?;
    let requested = match c.get("overlapFrames") {
        Some(v) => v.as_u64()?,
        None => 22,
    };
    let available = requested
        .min(362u64.checked_sub(continuation_extension(i)?)?)
        .min(source);
    let overlap = [73, 56, 39, 22, 5].into_iter().find(|n| *n <= available)?;
    Some(source - overlap)
}

/// Rack rows that do something: on, with a non-zero strength (`MAIDialRack.execute` drops the rest).
fn active_dials(i: &Value) -> impl Iterator<Item = &Value> {
    i["dials"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["on"] != false && r["strength"].as_f64().is_some_and(|s| s != 0.0))
}

/// An active row carries a time curve (strength over clip time).
fn dial_curves(i: &Value) -> bool {
    active_dials(i).any(|r| r.get("time").is_some())
}

pub(crate) fn dial_file(s: &str) -> bool {
    s.strip_prefix("dials/")
        .is_some_and(|rest| !rest.is_empty())
        && model_name(s)
        && s.to_ascii_lowercase().ends_with(".safetensors")
}

/// One rack row, mirroring the pack's `presets.py::preset_rows` and `timecurve.py::check_spec`
/// for the subset this first version sends.
pub(crate) fn validate_dial_row(r: &Value) -> Result<(), String> {
    let row = r
        .as_object()
        .ok_or("Invalid dials: each row is an object")?;
    for (key, reason) in [
        (
            "input",
            "wired dial inputs are unsupported; name a saved dial file",
        ),
        ("hold", "hold rows are unsupported"),
        ("envelope", "step envelopes are unsupported"),
        ("blocks", "block strengths are unsupported"),
    ] {
        if row.contains_key(key) {
            return Err(format!(
                "Invalid dials: {reason} in this experimental version"
            ));
        }
    }
    if !keys_in(r, &["dial", "strength", "on", "time"]) {
        return Err("Invalid dials: a row is {dial, strength, on?, time?}".into());
    }
    if !r["dial"].as_str().is_some_and(dial_file) {
        return Err("Invalid dials: dial must be a .safetensors file inside dials/ (forward slashes, no traversal)".into());
    }
    if !finite(&r["strength"], -DIAL_LEVEL, DIAL_LEVEL) {
        return Err(format!(
            "Invalid dials: strength must be a number from -{DIAL_LEVEL} to {DIAL_LEVEL}"
        ));
    }
    if r.get("on").is_some_and(|on| !on.is_boolean()) {
        return Err("Invalid dials: on must be a boolean".into());
    }
    let Some(t) = r.get("time") else {
        return Ok(());
    };
    if t["type"] == "audio" {
        return Err(
            "Invalid dials: audio-driven time curves are unsupported in this experimental version"
                .into(),
        );
    }
    if !keys_in(
        t,
        &[
            "type", "points", "unit", "interp", "smooth", "steps", "audio",
        ],
    ) || t["type"] != "keys"
        || t["unit"] != "seconds"
        || t.get("interp")
            .is_some_and(|v| v != "linear" && v != "step")
        || t.get("smooth").is_some_and(|v| !finite(v, 0.0, 1.0))
        || t.get("audio")
            .is_some_and(|v| v != "follow" && v != "protect")
    {
        return Err("Invalid dials: time is {type keys, points, unit seconds, interp? linear|step, smooth? 0..1, steps?, audio? follow|protect}".into());
    }
    if t.get("steps").is_some_and(|v| {
        !v.as_u64()
            .is_some_and(|n| (1..=DIAL_BLEND_STEPS).contains(&n))
    }) {
        return Err(format!(
            "Invalid dials: time.steps (blend steps) must be a whole number from 1 to {DIAL_BLEND_STEPS}"
        ));
    }
    let points = t["points"]
        .as_array()
        .filter(|p| (1..=DIAL_POINTS).contains(&p.len()))
        .ok_or(format!(
            "Invalid dials: a time curve needs 1 to {DIAL_POINTS} [seconds, level] points"
        ))?;
    if !points.iter().all(|p| {
        p.as_array().is_some_and(|p| p.len() == 2)
            && finite(&p[0], -DIAL_SECONDS, DIAL_SECONDS)
            && finite(&p[1], -DIAL_LEVEL, DIAL_LEVEL)
    }) {
        return Err(format!("Invalid dials: time points are [seconds, level] numbers within ±{DIAL_SECONDS} s and ±{DIAL_LEVEL}"));
    }
    if !points
        .windows(2)
        .all(|w| w[0][0].as_f64() < w[1][0].as_f64())
    {
        return Err("Invalid dials: time points need strictly increasing seconds".into());
    }
    Ok(())
}

/// The optional `dials` rows and, for active time curves, the passes whose clip clock this
/// version cannot serve.
fn validate_dials(i: &Value, family: &str) -> Result<(), String> {
    let Some(dials) = i.get("dials") else {
        return Ok(());
    };
    // HyperFlow Flash is the H3 stack with its own loader and schedule; the Dial Rack takes it as MiniMax H3.
    if !is_h3(family) {
        return Err(
            "Invalid dials: dials are experimental and run on MiniMax H3 video only".into(),
        );
    }
    let rows = dials
        .as_array()
        .filter(|rows| rows.len() <= DIAL_ROWS)
        .ok_or(format!("Invalid dials: a list of at most {DIAL_ROWS} rows"))?;
    rows.iter().try_for_each(validate_dial_row)?;
    if !dial_curves(i) {
        return Ok(());
    }
    // The blend cannot cover more steps than the generation samples.
    let steps = i["steps"].as_u64().unwrap_or_default();
    if active_dials(i).any(|r| r["time"]["steps"].as_u64().is_some_and(|n| n > steps)) {
        return Err(format!(
            "Invalid dials: time.steps (blend steps) cannot exceed the job's {steps} sampler steps"
        ));
    }
    // A time curve is sampled against the clock of the clip its sampler renders. Only the
    // generation pass and De-rope's pass on a new take have a clock this version maps.
    if i["h3"].get("transition").is_some() {
        return Err("Invalid dials: time curves cannot run on an h3.transition window".into());
    }
    if i.get("faceRefine").is_some() {
        return Err("Invalid dials: time curves cannot run with faceRefine (its sampler pass has its own clip clock); use rows without a time curve".into());
    }
    if i.get("latentUpscale")
        .is_some_and(|u| u.get("regenerate").is_none())
    {
        return Err("Invalid dials: time curves cannot run with the tiled latent upscale (it samples the generation model on chunks with their own clip clock); use rows without a time curve".into());
    }
    if c_source(&i["h3"]) {
        if i["videoPost"].get("derope").is_some() {
            return Err("Invalid dials: time curves cannot run with videoPost.derope on a continued segment (the second pass renders a different window than the first); use rows without a time curve".into());
        }
        if i["h3"]["continuity"]["sourceKind"] == "video" {
            return Err("Invalid dials: time curves cannot run on a continuation of an imported video (its start in the piece is not known before the run)".into());
        }
        let start = continuation_window_start(i).ok_or("Invalid dials: time curves on a continued segment need the pinned checkpoint clip's sourceFrames from the session list and a legal context window")?;
        // The shifted curve is what the node checks: keep its times strictly increasing.
        let offset = start as f64 / 24.0;
        if active_dials(i).any(|r| {
            r["time"]["points"].as_array().is_some_and(|points| {
                points.windows(2).any(|w| {
                    w[0][0].as_f64().unwrap_or_default() - offset
                        >= w[1][0].as_f64().unwrap_or_default() - offset
                })
            })
        }) {
            return Err("Invalid dials: time points are too close together to shift onto the continued segment's window".into());
        }
    }
    Ok(())
}

/// The `rack` input of `MAIDialRack` (`execute` reads a JSON list of `{dial, strength, on?, time?}`
/// rows): the active rows only, each curve in the sampled clip's own seconds. Curves are authored
/// in whole-piece seconds, so a continued segment's window gets them shifted by its start.
/// Every curve carries its blend `steps`: the authored count, else `dial_blend_steps` of the job's
/// sampler steps (the node's fixed default of 2 does nothing visible on a long schedule).
/// A curve's `audio` mode is written only when the intent authors it.
/// `None` without an active row.
fn dial_rack(i: &Value) -> Option<String> {
    let offset = if c_source(&i["h3"]) && dial_curves(i) {
        continuation_window_start(i).expect("validated with dials") as f64 / 24.0
    } else {
        0.0
    };
    let rows: Vec<Value> = active_dials(i)
        .map(|r| {
            let mut row = json!({"dial":r["dial"],"strength":r["strength"]});
            if let Some(t) = r.get("time") {
                let points = if offset == 0.0 {
                    t["points"].clone()
                } else {
                    t["points"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|p| json!([p[0].as_f64().unwrap_or_default() - offset, p[1]]))
                        .collect()
                };
                let steps = t.get("steps").cloned().unwrap_or_else(|| {
                    json!(dial_blend_steps(i["steps"].as_u64().unwrap_or_default()))
                });
                row["time"] = json!({"interp":t.get("interp").cloned().unwrap_or(json!("linear")),"points":points,
                    "smooth":t.get("smooth").cloned().unwrap_or(json!(0)),"steps":steps,"type":"keys","unit":"seconds"});
                // The curve's audio mode only when authored: `follow` (the node's default, the
                // soundtrack is steered with the picture) or `protect` (the row leaves the audio
                // latent undialled). Without it the emitted row is what it was before the field.
                if let Some(audio) = t.get("audio") {
                    row["time"]["audio"] = audio.clone();
                }
            }
            row
        })
        .collect();
    (!rows.is_empty()).then(|| Value::Array(rows).to_string())
}

/// prepare() must look up the pinned clip's frame count before compiling this intent.
pub(crate) fn needs_source_frames(i: &Value) -> bool {
    is_video(i)
        && i["family"] == "minimax-h3"
        && (((i.get("latentUpscale").is_some() || i["videoPost"].get("derope").is_some())
            && i["h3"]["continuity"]["capture"] == true
            && i["h3"]["continuity"]["outputMode"] == "segment")
            // A dial time curve is shifted by the continuation window's start in the piece.
            || dial_curves(i))
        && i["h3"]["continuity"]["sourceKind"] != "video"
        && i["h3"]["continuity"]["sourceId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
}

/// prepare(): settles `h3.continuity.sourceFrames` from the session list's count (`found`). The
/// list is authoritative and replaces whatever the intent carries. One case is refused instead:
/// an intent with an active dial time curve that already carries a count (Studio sends the one
/// its rack dialog laid the curve out with) when the list has another count for the pinned clip,
/// or none. The curve was drawn against the count the intent carries, so shifting it by another
/// one would run a curve nobody authored. Without a curve nothing changes: the list's count
/// wins, and a carried count stays when the list has none.
pub(crate) fn confirm_source_frames(i: &mut Value, found: Option<u64>) -> Result<(), String> {
    let carried = i["h3"]["continuity"].get("sourceFrames").cloned();
    if let Some(carried) = carried.filter(|_| dial_curves(i)) {
        match found {
            Some(frames) if carried.as_u64() == Some(frames) => {}
            Some(frames) => return Err(format!("Invalid dials: the pinned clip has {frames} frames in the session list, but the time curves were laid out for {carried}; press Load checkpoints in the Continuity dialog and check the curves")),
            None => return Err(format!("Invalid dials: the pinned clip's frame count ({carried} when the time curves were laid out) could not be read from the session list; press Load checkpoints in the Continuity dialog")),
        }
    }
    if let Some(frames) = found {
        i["h3"]["continuity"]["sourceFrames"] = json!(frames);
    }
    Ok(())
}

/// The pinned source's frame count from the read-only session clip list: the staged import for video
/// sources (matching canvas and mode family), otherwise the pinned checkpoint clip.
pub(crate) fn source_frames(list: &Value, i: &Value) -> Option<u64> {
    let c = &i["h3"]["continuity"];
    let id = c["sourceId"].as_str().filter(|s| !s.is_empty())?;
    let clip = list["clips"].as_array()?.iter().find(|cl| {
        if c["sourceKind"] == "video" {
            let p = &cl["importedVideo"];
            p["sourceId"] == id
                && p["width"] == i["width"]
                && p["height"] == i["height"]
                && p["modeFamily"]
                    == (if i["h3"]["mode"] == "REF2VA" {
                        "ref2va"
                    } else {
                        "fl2va"
                    })
        } else {
            cl["clipId"] == id
        }
    })?;
    clip["frames"].as_u64()
}

fn validate_ltx(l: &Value, frames: u64, source: bool) -> Result<(), String> {
    let passes = l["passes"].as_u64().unwrap_or(0);
    // Keyframes (multi-reference): an image at a pixel frame (-1 = last) with its guide strength.
    let keyframes_ok = l.get("keyframes").is_none_or(|k| {
        k.as_array().is_some_and(|a| {
            !a.is_empty()
                && a.len() <= 8
                && a.iter().all(|x| {
                    keys_in(x, &["image", "frame", "strength"])
                        && x["image"].as_str().is_some_and(model_name)
                        && x["frame"]
                            .as_i64()
                            .is_some_and(|f| f == -1 || (0..frames as i64).contains(&f))
                        && finite(&x["strength"], 0.0, 1.0)
                })
        })
    });
    if !keyframes_ok {
        return Err(
            "Invalid ltx.keyframes: 1-8 {image, frame 0..frames-1 or -1, strength 0-1}".into(),
        );
    }
    if source != l.get("sourceStrength").is_some()
        || l.get("sourceStrength")
            .is_some_and(|s| !finite(s, 0.0, 1.0))
    {
        return Err("ltx.sourceStrength (0-1) belongs exactly to a sourceVideo".into());
    }
    if keys_in(
        l,
        &[
            "textProjection",
            "audioVae",
            "passes",
            "spatialUpscaler",
            "keyframes",
            "sourceStrength",
        ],
    ) && ["textProjection", "audioVae"]
        .iter()
        .all(|k| l[*k].as_str().is_some_and(comfy_model_name))
        && (1..=3).contains(&passes)
        && (passes == 1) == l.get("spatialUpscaler").is_none()
        && l.get("spatialUpscaler")
            .is_none_or(|s| s.as_str().is_some_and(comfy_model_name))
    {
        Ok(())
    } else {
        Err("Invalid ltx: {textProjection, audioVae, passes 1-3, spatialUpscaler exactly when passes > 1}".into())
    }
}

fn validate_wan(w: &Value, steps: u64) -> Result<(), String> {
    if keys_in(w, &["lowModel", "shiftHigh", "shiftLow", "refinerStep"])
        && w["lowModel"].as_str().is_some_and(comfy_model_name)
        && finite(&w["shiftHigh"], 0.0, 100.0)
        && finite(&w["shiftLow"], 0.0, 100.0)
        && w["refinerStep"]
            .as_u64()
            .is_some_and(|r| r >= 1 && r < steps)
    {
        Ok(())
    } else {
        Err("Invalid wan: {lowModel, shiftHigh, shiftLow, refinerStep below steps}".into())
    }
}

fn validate_h3(h: &Value) -> Result<(), String> {
    let mode = h["mode"]
        .as_str()
        .filter(|m| H3_MODES.contains(m))
        .ok_or("Unsupported H3 mode (Image Inpaint is not a recipe yet)")?;
    let refs = h["references"].as_array().cloned().unwrap_or_default();
    if (mode == "REF2VA") != h.get("media").is_some() {
        return Err("h3.media belongs exactly to REF2VA".into());
    }
    let refmods = h.get("refmods").is_some();
    if refmods && mode != "REF2VA" {
        return Err("h3.refmods belong to REF2VA".into());
    }
    if refmods {
        validate_refmods(&h["refmods"])?;
    }
    if mode == "REF2VA" {
        let allow_empty = c_source(h) && h["continuity"]["useReferences"] != true;
        validate_h3_media(&h["media"], refmods, allow_empty)?;
    }
    let slots: Vec<u64> = refs.iter().filter_map(|r| r["slot"].as_u64()).collect();
    // Director slot semantics: I2VA = slot 0, L2VA = slot 1, FL2VA = {0,1}, T2VA = none.
    let slots_ok = refs.len() == slots.len()
        && refs.iter().all(|r| {
            r.as_object().is_some_and(|o| o.len() == 2)
                && r["image"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("deas-inputs/") && model_name(s))
        })
        && match mode {
            "T2VA" | "REF2VA" => slots.is_empty(),
            "I2VA" => slots == [0],
            "L2VA" => slots == [1],
            _ => {
                !slots.is_empty()
                    && slots.len() <= 2
                    && slots.iter().all(|s| *s <= 1)
                    && slots.windows(2).all(|w| w[0] < w[1])
            }
        };
    // AF2-M25a: the `h3.continuity` row law has ONE home, `validate_continuity`
    // below: extraction verbatim (the arm moved here, its grammar did not
    // change), so this fn's answer words and truth table stay byte-identical.
    // `pub(crate)` visibility-only for the agent door, the M15
    // `validate_refmods` precedent.
    let cont_ok = validate_continuity(h).is_ok();

    if keys_in(h, H3_KEYS)
        && h["audioVae"].as_str().is_some_and(comfy_model_name)
        && (h.get("inputScaling").is_none() || pick(h, "inputScaling", &H3_INPUT_SCALING))
        && finite(&h["shiftVideo"], 0.01, 100.0)
        && finite(&h["shiftAudio"], 0.01, 100.0)
        && slots_ok
        && cont_ok
    {
        Ok(())
    } else {
        Err("Invalid h3: {mode, audioVae, shiftVideo, shiftAudio, references[{slot, image in deas-inputs/}], continuity?, inputScaling?}".into())
    }
}

/// The `h3.continuity` row law, one home: closed key set; `session` a continuity
/// id and never `_imports`; `sourceId` `''` (a new take) or a continuity id;
/// `sourceKind` only the word `video`, and then only with a 64-lowercase-hex
/// `sourceId`; `capture`, `action` (<= 50_000 chars) and `outputMode`
/// (full|segment) required; `overlapFrames` on the Director ladder (73, 56, 39,
/// 22, 5); `sourceFrames` grid-shaped (>= 5, (n - 5) % 17 == 0); `useReferences`
/// a boolean; `durationSeconds` finite, (0, 15], inside the stock REF2VA +
/// continuity-source interlock.
// AF2-M25a: extracted verbatim from `validate_h3`'s `cont_ok` arm - the arm moved
// here, its grammar did not change, and `validate_h3` keeps its own generic
// refusal words (byte-identical behavior: `cont_ok` is now
// `validate_continuity(h).is_ok()`). `pub(crate)` is visibility-only, the M15
// `validate_refmods` precedent: the agent door calls this law at its own wall so
// a grammar-bad continuity row answers at the door instead of burning the
// poison-row guard as prepareRefused. The field-naming strings below are the
// door's hint vocabulary; the durationSeconds arm keeps the stock mode/c_source
// interlock verbatim (mode re-derived from `h`, so one argument carries the
// whole h3 block) - the door sees only the request block with `mode` already
// resolved; the whole-intent authority stays stock-side.
pub(crate) fn validate_continuity(h: &Value) -> Result<(), String> {
    let Some(c) = h.get("continuity") else {
        return Ok(());
    };
    if !keys_in(
        c,
        &[
            "session",
            "sourceId",
            "sourceKind",
            "capture",
            "action",
            "outputMode",
            "overlapFrames",
            "useReferences",
            "durationSeconds",
            "sourceFrames",
        ],
    ) {
        return Err("Invalid h3.continuity: unknown key (closed set: session, sourceId, sourceKind, capture, action, outputMode, overlapFrames, useReferences, durationSeconds, sourceFrames)".into());
    }
    if !c["session"]
        .as_str()
        .is_some_and(|s| continuity_id(s) && s != "_imports")
    {
        return Err("Invalid h3.continuity.session: a continuity id (alphanumeric, '-', '_', <= 80, never '_imports')".into());
    }
    if !c["sourceId"]
        .as_str()
        .is_some_and(|s| s.is_empty() || continuity_id(s))
    {
        return Err("Invalid h3.continuity.sourceId: '' (a new take) or a continuity id".into());
    }
    if !c.get("sourceKind").is_none_or(|kind| {
        kind == "video"
            && c["sourceId"].as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    }) {
        return Err(
            "Invalid h3.continuity.sourceKind: 'video' needs a 64-lowercase-hex sourceId".into(),
        );
    }
    if !c["capture"].is_boolean() {
        return Err("Invalid h3.continuity.capture: a boolean is required".into());
    }
    if !c.get("useReferences").is_none_or(Value::is_boolean) {
        return Err("Invalid h3.continuity.useReferences: a boolean".into());
    }
    if !c.get("durationSeconds").is_none_or(|seconds| {
        h["mode"].as_str() == Some("REF2VA")
            && c_source(h)
            && seconds
                .as_f64()
                .is_some_and(|s| s.is_finite() && s > 0.0 && s <= 15.0)
    }) {
        return Err("Invalid h3.continuity.durationSeconds: finite (0, 15], and only with REF2VA + a continuity sourceId".into());
    }
    if !c
        .get("sourceFrames")
        .is_none_or(|n| n.as_u64().is_some_and(|n| n >= 5 && (n - 5) % 17 == 0))
    {
        return Err("Invalid h3.continuity.sourceFrames: >= 5 and (n - 5) % 17 == 0".into());
    }
    if !c["action"].as_str().is_some_and(|a| a.len() <= 50_000) {
        return Err("Invalid h3.continuity.action: a string <= 50000 chars is required".into());
    }
    if !pick(c, "outputMode", &["full", "segment"]) {
        return Err("Invalid h3.continuity.outputMode: required, full|segment".into());
    }
    if !c
        .get("overlapFrames")
        .is_none_or(|v| v.as_u64().is_some_and(|n| [73, 56, 39, 22, 5].contains(&n)))
    {
        return Err("Invalid h3.continuity.overlapFrames: one of 73, 56, 39, 22, 5".into());
    }
    Ok(())
}

fn c_source(h: &Value) -> bool {
    h["continuity"]["sourceId"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
}

/// REF2VA timeline media, mirroring the DaSiWa Director limits: ≤ 9 images, ≤ 3 videos, ≤ 3 audio, ≤ 12 files;
/// audio needs an image or video; unique slots per lane. Clip durations (2–15 s) are checked by the node.
/// Director RefMod rows (`_load_refmod_rows`): 1–8 unique slots 1–8, a library name, strength in (0, 1]
/// (the node skips 0), optional description. DEAS sends enabled rows only.
// `pub(crate)` since LEG M15 (visibility only, the M11 refmod-mod precedent): the
// agent door calls the stock row law at its own wall instead of mirroring it.
pub(crate) fn validate_refmods(r: &Value) -> Result<(), String> {
    let rows = r
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 8)
        .ok_or("h3.refmods: 1-8 rows")?;
    let mut slots = vec![];
    for x in rows {
        let slot = x["slot"].as_u64().filter(|s| (1..=8).contains(s));
        let ok = keys_in(x, &["slot", "name", "strength", "description"])
            && slot.is_some_and(|s| !slots.contains(&s))
            && x["name"]
                .as_str()
                .is_some_and(|n| model_name(n) && n != "None" && n != "(none)")
            && x["strength"].as_f64().is_some_and(|s| s > 0.0 && s <= 1.0)
            && x.get("description")
                .is_none_or(|d| d.as_str().is_some_and(|d| d.chars().count() <= 2000));
        if !ok {
            return Err(
                "Invalid h3.refmods row: {slot 1-8 unique, name, strength (0, 1], description?}"
                    .into(),
            );
        }
        slots.extend(slot);
    }
    Ok(())
}

/// Empty media is valid with RefMods or a continuation that ignores references; present items still validate.
pub(crate) fn validate_h3_media(m: &Value, refmods: bool, allow_empty: bool) -> Result<(), String> {
    let items = m
        .as_array()
        .filter(|a| (allow_empty || refmods || !a.is_empty()) && a.len() <= 12)
        .ok_or("h3.media: 1-12 items")?;
    let mut used: Vec<(&str, u64)> = vec![];
    let (mut videos, mut audio, mut visual) = (0, 0, 0);
    let (mut video_seconds, mut audio_seconds) = (0.0, 0.0);
    for x in items {
        let kind = x["type"].as_str().unwrap_or_default();
        let mode = x.get("mediaMode").and_then(Value::as_str);
        let trims = ["trimStart", "trimEnd"]
            .iter()
            .all(|k| x.get(*k).is_none_or(|t| finite(t, 0.0, 3600.0)))
            && match (x["trimStart"].as_f64(), x["trimEnd"].as_f64()) {
                (Some(a), Some(b)) => a < b,
                _ => true,
            };
        let ok = keys_in(
            x,
            &["type", "file", "slot", "mediaMode", "trimStart", "trimEnd"],
        ) && x["file"].as_str().is_some_and(|f| {
            (f.starts_with("deas-inputs/") || f.starts_with("deas-input-")) && model_name(f)
        }) && match kind {
            "image" => mode.is_none() && x.get("trimStart").is_none() && x.get("trimEnd").is_none(),
            "video" => mode.is_none_or(|m| H3_MEDIA_MODES.contains(&m)) && trims,
            "audio" => mode.is_none() && trims,
            _ => false,
        };
        // A video used as sound only sits in the audio lane.
        let lane = if kind == "video" && mode == Some("audio") {
            "audio"
        } else {
            kind
        };
        let slot = x["slot"].as_u64();
        let max = H3_LANES
            .iter()
            .find(|(l, _)| *l == lane)
            .map_or(0, |(_, n)| *n);
        if !ok || !slot.is_some_and(|s| s < max) || used.contains(&(lane, slot.unwrap())) {
            return Err("Invalid h3.media item: {type image|video|audio, file in deas-inputs/, slot unique per lane, mediaMode? (video), trimStart/trimEnd? (video/audio)}".into());
        }
        used.push((lane, slot.unwrap()));
        if kind != "image" {
            if let Some(end) = x["trimEnd"].as_f64() {
                let seconds = end - x["trimStart"].as_f64().unwrap_or(0.0);
                if !(2.0..=15.0).contains(&seconds) {
                    return Err("REF2VA clips must last 2-15 seconds".into());
                }
                if kind == "video" && mode != Some("audio") {
                    video_seconds += seconds;
                }
                if kind == "audio" || mode == Some("audio") || mode == Some("video_audio") {
                    audio_seconds += seconds;
                }
            }
        }
        match (kind, mode) {
            ("image", _) => visual += 1,
            ("video", Some("audio")) => audio += 1,
            ("video", Some("video_audio")) => {
                videos += 1;
                audio += 1;
                visual += 1;
            }
            ("video", _) => {
                videos += 1;
                visual += 1;
            }
            _ => audio += 1,
        }
    }
    if visual + audio > 12 {
        return Err("REF2VA allows at most 12 references (video with sound counts twice)".into());
    }
    if video_seconds > 15.0 || audio_seconds > 15.0 {
        return Err("REF2VA video and audio totals must each be at most 15 seconds".into());
    }
    if videos > 3 || audio > 3 {
        return Err("REF2VA allows at most 3 videos and 3 audio clips".into());
    }
    if audio > 0 && visual == 0 && !refmods {
        return Err("REF2VA audio needs an image or video reference".into());
    }
    Ok(())
}

/// Family-specific block key.
pub(crate) fn block(family: &str) -> &'static str {
    match family {
        "ltx-2" => "ltx",
        "wan" => "wan",
        _ => "h3",
    }
}

/// Model-free Join clips prompt: the assembly rows come from [`validate_join`] —
/// AF2-M31 made that fn the ONE home of the join grammar (extraction verbatim,
/// the arms moved, their wording and order did not) — and this fn keeps the
/// DaSiWaH3ClipAssemble emission: the pinned `data` JSON (pack 0.5.42
/// assembly.py::_request; trims are seconds, effective cuts snap to 24-fps
/// frames) and the house saver node.
///
/// Byte-identical behavior: every refusal `join` ever produced is `validate_join`'s
/// refusal, in the same order, because the whole validation half — row building
/// included, since the pack's 64 KiB budget law measures the BUILT rows — now runs
/// here before the graph is emitted. Chain ordering and export coverage stay
/// pack-verified at run time; DEAS does not duplicate that.
fn join(i: &Value) -> Result<Value, String> {
    let rows = validate_join(i)?;
    let j = &i["h3"]["join"];
    let prefix = filename_prefix(j, "H3_Joined", "h3.join")?;
    let data = json!({
        "version": 1,
        "rows": rows,
        "repair_transitions": false,
        "copy_video": j["copyVideo"].as_bool().unwrap_or(false),
        "audio_policy": if j["smoothAudioSeams"] == true { "smooth-seams" } else { "preserve" },
    });
    // Node "7" is the house saver-node id: native history output extraction reads only that node.
    Ok(
        json!({"7": {"class_type": "DaSiWaH3ClipAssemble", "inputs": {
            "assembly_data": data.to_string(),
            "filename_prefix": prefix,
        }}}),
    )
}

/// The `h3.join` row law, one home (AF2-M31): the recipe version wall, the
/// single-block `h3` shape, the two arms' grammar (segments: `session` a
/// continuity id and never `_imports`, `chain` 1..=100 continuity ids; files:
/// 1..=100 [`media_row`] entries — filename <= 1024, no `..`/NUL/`:`/leading
/// `/`, trims 0..=3600 with `trimEnd` after `trimStart`), the two booleans and
/// the pack's 64 KiB `assembly_data` budget measured over the BUILT rows — the
/// whole DaSiWaH3ClipAssemble contract pinned by
/// h3_join_contract_pins_pack_nodes_and_json_schema (pack 0.5.42
/// assembly.py::_request).
// AF2-M31: extracted verbatim from `join` — every arm moved here unchanged (word,
// order, short-circuit), and `join` now starts by calling this fn, so compile's
// answer words and truth table stay byte-identical (pinned by
// validate_join_is_the_single_home_of_the_join_law). `pub(crate)` is
// visibility-only, the M15 `validate_refmods` / M25a `validate_continuity`
// precedent: the agent door (`agent_api/results.rs`, POST /v1/videos/join — the
// AF2-M31 join door) calls this law at its own wall so a grammar-bad join body
// answers `bodyInvalid` naming the stock words at the door instead of burning the
// poison-row guard as prepareRefused at drain. The door's own closed-grammar wall runs FIRST
// so an unknown key is refused BY NAME — `join` itself never refused unknown keys
// inside the join block, and this extraction changed nothing on that posture.
// The answer is the BUILT pack rows (`Vec<Value>`, snake-case per
// assembly.py::_request), not `Ok(())`: the 64 KiB law is a law over the built
// rows, so a validation half that did not build them would be a second grammar.
// `join` consumes the rows verbatim; the door discards them (it queues the intent,
// the drain compiles it through `jobs::compile` — the same entry the rows ride).
pub(crate) fn validate_join(i: &Value) -> Result<Vec<Value>, String> {
    if i["version"].as_f64() != Some(1.0) {
        return Err("Unsupported join recipe version".into());
    }
    if i.get("h3").is_some_and(|h| {
        h.as_object()
            .is_none_or(|o| o.keys().len() != 1 || !o.contains_key("join"))
    }) {
        return Err("h3 block must carry only the join block".into());
    }
    let j = &i["h3"]["join"];
    if j["kind"]
        .as_str()
        .is_none_or(|k| k != "segments" && k != "files")
    {
        return Err("h3.join.kind must be segments or files".into());
    }
    let rows: Vec<Value> = if j["kind"] == "segments" {
        let session = j["session"]
            .as_str()
            .filter(|s| continuity_id(s) && *s != "_imports")
            .ok_or("Invalid h3.join.session")?;
        let chain = j["chain"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 100)
            .ok_or("h3.join.chain needs 1..=100 clip ids")?;
        chain
            .iter()
            .map(|c| {
                c.as_str()
                    .filter(|s| continuity_id(s))
                    .map(|clip| json!({"kind": "checkpoint", "session": session, "clip_id": clip}))
                    .ok_or("Invalid h3.join.chain entry".to_string())
            })
            .collect::<Result<_, _>>()?
    } else {
        let files = j["files"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 100)
            .ok_or("h3.join.files needs 1..=100 entries")?;
        files
            .iter()
            .map(|f| media_row(f, "h3.join.files"))
            .collect::<Result<_, _>>()?
    };
    if j.get("copyVideo").is_some_and(|b| !b.is_boolean()) {
        return Err("h3.join.copyVideo must be boolean".into());
    }
    if j.get("smoothAudioSeams").is_some_and(|b| !b.is_boolean()) {
        return Err("h3.join.smoothAudioSeams must be boolean".into());
    }
    let data = json!({
        "version": 1,
        "rows": rows,
        "repair_transitions": false,
        "copy_video": j["copyVideo"].as_bool().unwrap_or(false),
        "audio_policy": if j["smoothAudioSeams"] == true { "smooth-seams" } else { "preserve" },
    });
    if data.to_string().len() > 65536 {
        return Err("h3.join request exceeds the pack's 64 KiB budget".into());
    }
    Ok(rows)
}

/// One pack media row (assembly.py::_request): input-relative file, optional trims in seconds.
fn media_row(f: &Value, field: &str) -> Result<Value, String> {
    let name = f["filename"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 1024
                && !s.contains("..")
                && !s.contains('\0')
                && !s.contains(':')
                && !s.starts_with('/')
        })
        .ok_or(format!("Invalid {field}.filename"))?;
    let seconds = |k: &str| -> Result<Option<f64>, String> {
        match f.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_f64()
                .filter(|n| (0.0..=3600.0).contains(n))
                .map(Some)
                .ok_or(format!("Invalid {field}.{k}")),
        }
    };
    let start = seconds("trimStart")?.unwrap_or_default();
    let end = seconds("trimEnd")?;
    if end.is_some_and(|e| e <= start) {
        return Err(format!("{field} trim must end after its start"));
    }
    Ok(json!({"kind": "media", "filename": name, "trim_start": start, "trim_end": end}))
}

/// Pack filename prefix: 1-80 letters, digits, `_` or `-`. AF2-M31: `pub(crate)`
/// is visibility-only (the join door calls this same home beside its arm walls so
/// a bad prefix answers at the door, stock word verbatim); the emission order
/// inside `join` is untouched.
pub(crate) fn filename_prefix(block: &Value, default: &str, field: &str) -> Result<String, String> {
    match block.get("filenamePrefix") {
        None | Some(Value::Null) => Ok(default.to_string()),
        Some(v) => v
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 80
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .map(str::to_string)
            .ok_or(format!("Invalid {field}.filenamePrefix")),
    }
}

/// `transition_data` for DaSiWaH3TransitionGuide (pack transition.py::transition_spec): two media rows,
/// context 17k+5 >= 5 per side, bridge >= 12 keeping the 2*context+bridge window on 17k+5.
pub(crate) fn transition_data(i: &Value) -> Result<Option<Value>, String> {
    let Some(t) = i["h3"].get("transition") else {
        return Ok(None);
    };
    if !keys_in(
        t,
        &[
            "files",
            "contextFrames",
            "transitionFrames",
            "prompt",
            "filenamePrefix",
        ],
    ) {
        return Err("Unknown h3.transition fields".into());
    }
    let rows = t["files"]
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or("h3.transition.files needs exactly two clips")?
        .iter()
        .map(|f| media_row(f, "h3.transition.files"))
        .collect::<Result<Vec<_>, _>>()?;
    let context = t["contextFrames"]
        .as_u64()
        .filter(|c| *c >= 5 && c % 17 == 5)
        .ok_or("h3.transition.contextFrames must be 5, 22, 39 … (17k + 5)")?;
    let gap = t["transitionFrames"]
        .as_u64()
        .filter(|g| *g >= 12 && (2 * context + g) % 17 == 5 && 2 * context + g <= 3600)
        .ok_or("h3.transition.transitionFrames must keep the window on 17k + 5 (12, 29, 46 … with context 22)")?;
    let prompt = match t.get("prompt") {
        None | Some(Value::Null) => "",
        Some(p) => p
            .as_str()
            .filter(|p| p.chars().count() <= 4000 && !p.contains('\0'))
            .ok_or("h3.transition.prompt must be text of at most 4000 characters")?,
    };
    let prefix = filename_prefix(t, "H3_Transition", "h3.transition")?;
    Ok(Some(
        json!({"version":1,"rows":rows,"context_frames":context,"transition_frames":gap,"prompt":prompt,"filename_prefix":prefix}),
    ))
}

/// Turns a plain H3 generation into one transition window: the Director's model/sampler graph with the
/// Guide swapped for DaSiWaH3TransitionGuide, and only TransitionRender (`TR`) after the sampler.
/// The bridge lands in input/h3_transitions/ (job status `transition`), not as a job output.
fn transition_graph(g: &mut Value, data: &Value) {
    let window =
        data["context_frames"].as_u64().unwrap() * 2 + data["transition_frames"].as_u64().unwrap();
    g["D"]["inputs"]["duration"] = json!(window as f64 / 24.0);
    g["G"] = json!({"class_type":"DaSiWaH3TransitionGuide","inputs":{"clip":["C",0],"vae":["V",0],"guide":["D",0],"transition_data":data.to_string(),"audio_vae":["AV",0]}});
    g["TR"] = json!({"class_type":"DaSiWaH3TransitionRender","inputs":{"latent":["5",0],"vae":["V",0],"audio_vae":["AV",0],"transition":["G",2]}});
    // Keep only what the render needs; decode/export/continuity nodes of the plain generation go.
    let mut keep = std::collections::HashSet::new();
    let mut stack = vec!["TR".to_string()];
    while let Some(id) = stack.pop() {
        if !keep.insert(id.clone()) {
            continue;
        }
        for v in g[&id]["inputs"]
            .as_object()
            .into_iter()
            .flat_map(|o| o.values())
        {
            if let Some(src) = v
                .get(0)
                .and_then(Value::as_str)
                .filter(|_| v.as_array().is_some_and(|a| a.len() == 2))
            {
                stack.push(src.to_string());
            }
        }
    }
    g.as_object_mut().unwrap().retain(|id, _| keep.contains(id));
}

pub(crate) fn validate(i: &Value) -> Result<&str, String> {
    let object = i.as_object().ok_or("Expected a video intent object")?;
    let family = i["family"]
        .as_str()
        .filter(|f| FAMILIES.contains(f))
        .ok_or("Unknown video family")?;
    let block = block(family);
    if object
        .keys()
        .any(|k| !(FIELDS.contains(&k.as_str()) || OPTIONAL.contains(&k.as_str()) || k == block))
        || FIELDS.iter().any(|k| !object.contains_key(*k))
        || !object.contains_key(block)
    {
        return Err("Missing or unknown video intent fields".into());
    }
    if let Some(stream) = i.get("streamDecode") {
        if stream != &json!(true) {
            return Err("streamDecode must be true or omitted".into());
        }
        if !is_h3(family) || i.get("latentUpscale").is_none() {
            return Err("streamDecode requires H3 latent upscale or regenerate".into());
        }
        if i["h3"]["continuity"]["outputMode"] == "segment" {
            return Err("streamDecode requires the full timeline; new-segment decode needs the pack's exact crop and audio wiring".into());
        }
        if i.get("videoPost").is_some() || i.get("faceRefine").is_some() {
            return Err("streamDecode cannot run full-IMAGE post-processing (TVE, De-rope, Seamless loop or Face Refine)".into());
        }
        if matches!(
            i["output"]["container"].as_str(),
            Some("Animated WebP" | "Animated AVIF")
        ) {
            return Err("streamDecode requires a video container, not an animated image".into());
        }
    }
    if i["version"].as_f64() != Some(1.0) {
        return Err("Unsupported video recipe version".into());
    }
    for f in ["positivePrompt", "negativePrompt"] {
        if !i[f]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 16384 && !s.contains('\0'))
        {
            return Err(format!("Invalid {f}"));
        }
    }
    if i.get("sourceVideo").is_some_and(|v| {
        // core LoadVideo lists top-level input files only.
        !v.as_str()
            .is_some_and(|s| model_name(s) && !s.contains('/'))
    }) || (i.get("sourceVideo").is_some() && family != "ltx-2")
    {
        return Err("sourceVideo: a top-level input video, LTX only".into());
    }
    for f in ["model", "textEncoder", "vae", "firstFrame", "lastFrame"] {
        if let Some(v) = i.get(f) {
            let valid = if ["model", "textEncoder", "vae"].contains(&f) {
                comfy_model_name
            } else {
                model_name
            };
            if !v.as_str().is_some_and(valid) {
                return Err(format!("Unsafe {f}"));
            }
        }
    }
    let (multiple, step, offset) = grid(family);
    let int = |k: &str, min: u64, max: u64| {
        i[k].as_u64()
            .filter(|n| (min..=max).contains(n))
            .ok_or(format!("Invalid {k}"))
    };
    let (w, h) = (int("width", 64, 8192)?, int("height", 64, 8192)?);
    let frames = int("frames", offset.max(1), 3600)?;
    if w % multiple != 0 || h % multiple != 0 || w * h > 16_777_216 || (frames - offset) % step != 0
    {
        return Err(format!(
            "Canvas must be a multiple of {multiple} and frames {step}k+{offset}"
        ));
    }
    int("seed", 0, 9_007_199_254_740_991)?;
    let steps = int("steps", 1, 150)?;
    if !finite(&i["frameRate"], 1.0, 120.0) || !finite(&i["cfg"], 0.0, 30.0) {
        return Err("Invalid frameRate or cfg".into());
    }
    if !["sampler", "scheduler"]
        .iter()
        .all(|f| i[*f].as_str().is_some_and(safe_choice))
    {
        return Err("Unsafe sampler or scheduler".into());
    }
    let vr = crate::model_families::video_recipe(family);
    if !vr.step_choices.is_empty() && !vr.step_choices.contains(&steps) {
        let allowed = vr
            .step_choices
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join("/");
        return Err(format!("Invalid steps: {family} only samples {allowed}"));
    }
    if vr
        .fixed_sampler
        .is_some_and(|s| i["sampler"].as_str() != Some(s))
    {
        return Err(format!(
            "Invalid sampler: {family} runs {} only",
            vr.fixed_sampler.unwrap()
        ));
    }
    if i.get("chunks")
        .is_some_and(|c| !c.as_u64().is_some_and(|n| (2..=16).contains(&n)))
    {
        return Err("Invalid chunks: 2..=16".into());
    }
    if i.get("output").is_some_and(|o| !valid_output(o)) {
        return Err("Invalid output settings".into());
    }
    if let Some(p) = i.get("videoPost") {
        crate::jobs_video_post::validate(p)?;
        if let Some(d) = p.get("derope") {
            // Prepare reads the latent the baseline frames were decoded from: one plain new take only.
            let c = &i["h3"]["continuity"];
            let segment_continuation =
                c["capture"] == true && c["outputMode"] == "segment" && c_source(&i["h3"]);
            if family != "minimax-h3" || (segment_continuation && segment_crop_plan(i).is_none()) {
                return Err("videoPost.derope runs on MiniMax H3; a new-segment continuation needs a pinned checkpoint clip (imported-video sources are unsupported) with its sourceFrames from the session list".into());
            }
            if let Some(lora) = d["lora"].as_str() {
                crate::jobs::validate_lora_format(lora)?;
                if crate::jobs::is_gguf(i["model"].as_str().unwrap_or_default()) {
                    return Err(
                        "MODEL_FORMAT_UNSUPPORTED: LoRA on a GGUF base is not proven".into(),
                    );
                }
            }
        }
    }
    if let Some(f) = i.get("faceRefine") {
        // With latent upscale + segment capture, latentUpscale's own validation requires the
        // checkpoint window that refinement then works on.
        if !is_h3(family) {
            return Err("faceRefine runs on MiniMax H3".into());
        }
        crate::jobs_face_refine::validate(f)?;
    }
    if i["h3"].get("transition").is_some() {
        transition_data(i)?;
        // The window is a plain bridge render: no capture, no post stages (Render saves it directly).
        if !is_h3(family)
            || ["latentUpscale", "videoPost", "faceRefine"]
                .iter()
                .any(|k| i.get(*k).is_some())
            || i["h3"]["continuity"]["capture"] == true
        {
            return Err("h3.transition runs on MiniMax H3 without Continuity capture, latent upscale or post-processing".into());
        }
    }
    if i.get("loras").is_some_and(|l| {
        !l.as_array().is_some_and(|a| {
            a.len() <= 8
                && a.iter().all(|x| {
                    x.as_object().is_some_and(|o| o.len() == 2)
                        && x["name"].as_str().is_some_and(comfy_model_name)
                        && finite(&x["strength"], -10.0, 10.0)
                })
        })
    }) {
        return Err("Invalid loras".into());
    }
    if i.get("options").is_some_and(|o| !valid_options(o)) {
        return Err("Invalid options".into());
    }
    if i.get("outputPrefix")
        .is_some_and(|p| !p.as_str().is_some_and(safe_output_prefix))
    {
        return Err("Unsafe output prefix".into());
    }
    match family {
        "ltx-2" => validate_ltx(&i["ltx"], frames, i.get("sourceVideo").is_some())?,
        "wan" => validate_wan(&i["wan"], steps)?,
        _ => validate_h3(&i["h3"])?,
    }
    validate_dials(i, family)?;
    for name in [&i["vae"], &i["ltx"]["audioVae"], &i["h3"]["audioVae"]] {
        if crate::jobs::is_gguf(name.as_str().unwrap_or_default()) {
            return Err("MODEL_FORMAT_UNSUPPORTED: GGUF VAE is unsupported".into());
        }
    }
    // HyperFlow safetensors (INT8 convrot singles, bf16 conversion) are accepted:
    // unet_loader routes them to the pack's HyperFlowLoader.
    // GGUF ref2va supports images only; mixed references require upstream's Python runtime.
    if family == "minimax-h3-hyperflow"
        && i["h3"]["media"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["type"] != "image"))
    {
        return Err("HyperFlow Flash GGUF accepts image references only".into());
    }
    if crate::jobs::is_gguf(i["ltx"]["textProjection"].as_str().unwrap_or_default()) {
        return Err("MODEL_FORMAT_UNSUPPORTED: GGUF text projection is unsupported".into());
    }
    if i.get("enhancedPreview").is_some() && !valid_preview(i) {
        return Err("Invalid enhancedPreview: incompatible decoder/model for video family".into());
    }
    validate_latent_upscale(i, family)?;
    for lora in i["loras"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["name"].as_str())
    {
        crate::jobs::validate_lora_format(lora)?;
    }
    // LoRA on a quantized base needs execution proof per pipeline; not advertised yet.
    if i["loras"].as_array().is_some_and(|l| !l.is_empty())
        && [&i["model"], &i["wan"]["lowModel"]]
            .iter()
            .any(|name| crate::jobs::is_gguf(name.as_str().unwrap_or_default()))
    {
        return Err("MODEL_FORMAT_UNSUPPORTED: LoRA on a GGUF base is not proven".into());
    }
    Ok(family)
}

/// Exact known decoder basenames only: unknown architectures must not become preview choices.
pub(crate) fn preview_model_compatible(family: &str, decoder: &str, model: &str) -> bool {
    if !comfy_model_name(model) {
        return false;
    }
    let file = model.rsplit(['/', '\\']).next().unwrap_or_default();
    matches!(
        (family, decoder, file),
        (
            "minimax-h3" | "minimax-h3-hyperflow",
            "tiny",
            "taeh3.safetensors"
        ) | ("ltx-2", "vae", "taeltx2_3.safetensors")
            | (
                "wan",
                "tiny",
                "taew2_1.safetensors" | "lighttaew2_1.safetensors"
            )
    )
}

fn valid_preview(i: &Value) -> bool {
    let p = &i["enhancedPreview"];
    p.as_object().is_some_and(|o| o.len() == 2)
        && preview_model_compatible(
            i["family"].as_str().unwrap_or_default(),
            p["decoder"].as_str().unwrap_or_default(),
            p["model"].as_str().unwrap_or_default(),
        )
}

/// Recheck the exact negotiated family/decoder/file before native admission, never downgrade.
pub(crate) fn validate_preview_capability(intent: &Value, allow: &Value) -> Result<(), String> {
    let Some(preview) = intent.get("enhancedPreview") else {
        return Ok(());
    };
    let family = intent["family"].as_str().unwrap_or_default();
    let has_node = |node: &str| {
        allow["nodes"]
            .as_array()
            .is_some_and(|n| n.iter().any(|n| n == node))
    };
    if !valid_preview(intent)
        || allow["videoPreviews"].get(family) != Some(preview)
        || !has_node("ModelPreviewOverrideKJ")
        || (preview["decoder"] == "vae"
            && (!has_node("VAELoader")
                || !allow["vaes"]
                    .as_array()
                    .is_some_and(|v| v.contains(&preview["model"]))))
    {
        return Err("enhancedPreview: exact compatible decoder capability is unavailable; refresh backend prerequisites".into());
    }
    Ok(())
}

pub(crate) fn compile(i: &Value) -> Result<Value, String> {
    if is_join(i) {
        return join(i);
    }
    if crate::jobs_face_refine::is_face_refine(i) {
        return crate::jobs_face_refine::compile(i);
    }
    if crate::jobs_video_post::is_enhance(i) {
        return crate::jobs_video_post::compile_enhance(i);
    }
    let mut graph = match validate(i)? {
        "ltx-2" => ltx(i),
        "wan" => wan(i)?,
        _ => h3(i),
    };
    if let Some(data) = transition_data(i)? {
        transition_graph(&mut graph, &data);
    }
    if let Some(preview) = i.get("enhancedPreview") {
        // Patch each final sampling model, including Director output, split Wan and H3 upscale.
        let targets: Vec<(String, Value)> = graph
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, n)| {
                matches!(
                    n["class_type"].as_str(),
                    Some(
                        "BasicScheduler"
                            | "BasicGuider"
                            | "CFGGuider"
                            | "KSamplerAdvanced"
                            | "HyperFlowSigmas"
                            | "DaSiWaH3TiledUpscale"
                    )
                )
            })
            .map(|(id, n)| (id.clone(), n["inputs"]["model"].clone()))
            .collect();
        if preview["decoder"] == "vae" {
            graph["VPV"] = json!({"class_type":"VAELoader","inputs":{"vae_name":preview["model"]}});
        }
        let mut patched: Vec<(Value, String)> = Vec::new();
        for (target, model) in targets {
            let id = if let Some((_, id)) = patched.iter().find(|(source, _)| source == &model) {
                id.clone()
            } else {
                let id = format!("VP{}", patched.len() + 1);
                let mut inputs = json!({"model":model,"max_resolution":512,"jpeg_quality":80,"suppress_default_preview":false,"preview_frames":120,"preview_fps":8,"tiny_vae":"none"});
                if preview["decoder"] == "tiny" {
                    inputs["tiny_vae"] = preview["model"].clone();
                } else {
                    inputs["vae"] = json!(["VPV", 0]);
                }
                graph[&id] = json!({"class_type":"ModelPreviewOverrideKJ","inputs":inputs});
                patched.push((model, id.clone()));
                id
            };
            graph[&target]["inputs"]["model"] = json!([id, 0]);
        }
    }
    Ok(graph)
}

/// LoRAs, then the experimental Dial Rack (H3 only), then the Options patches, then the family's
/// feed-forward chunking; returns the final model link.
/// `clip` is `None` for model-only chains (Wan high/low, H3).
fn model_chain(
    g: &mut Value,
    prefix: &str,
    mut model: Value,
    mut clip: Option<&mut Value>,
    i: &Value,
    chunk_node: &str,
    threshold_key: &str,
) -> Value {
    for (n, lora) in i["loras"].as_array().into_iter().flatten().enumerate() {
        let id = format!("{prefix}L{}", n + 1);
        match clip.as_deref_mut() {
            Some(c) => {
                g[&id] = json!({"class_type":"LoraLoader","inputs":{"model":model,"clip":c.clone(),"lora_name":lora["name"],"strength_model":lora["strength"],"strength_clip":lora["strength"]}});
                *c = json!([id, 1]);
            }
            None => {
                g[&id] = json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":model,"lora_name":lora["name"],"strength_model":lora["strength"]}})
            }
        }
        model = json!([id, 0]);
    }
    if let Some(rack) = dial_rack(i) {
        let id = format!("{prefix}DR");
        g[&id] = json!({"class_type":"MAIDialRack","inputs":{"model":model,"rack":rack}});
        model = json!([id, 0]);
    }
    let o = &i["options"];
    let mut patch = |suffix: &str, node: &str, mut inputs: Value| {
        let id = format!("{prefix}{suffix}");
        inputs["model"] = model.clone();
        g[&id] = json!({"class_type":node,"inputs":inputs});
        model = json!([id, 0]);
    };
    if let Some(a) = o["attention"].as_str() {
        patch("A", "ModelAttentionBackend", json!({"attention":a}));
    }
    if let Some(s) = o["sage"].as_str() {
        patch("K", "PathchSageAttentionKJ", json!({"sage_attention":s}));
    }
    if let Some(c) = o.get("cache") {
        patch(
            "E",
            c["node"].as_str().unwrap(),
            json!({"reuse_threshold":c["threshold"],"start_percent":0.15,"end_percent":0.95,"verbose":false}),
        );
    }
    if let Some(n) = i["chunks"].as_u64() {
        // 4096 is the KJ default; the owner's workflows keep it.
        patch("H", chunk_node, json!({"chunks":n, threshold_key:4096}));
    }
    if let Some(b) = o["compile"].as_str() {
        patch("T", "TorchCompileModel", json!({"backend":b}));
    }
    model
}

/// Reference image → canvas (the workflows' TorchResize "Fill and crop" ≙ ImageScale crop=center).
fn input_image(g: &mut Value, id: &str, name: &Value, w: &Value, h: &Value) -> Value {
    g[id] = json!({"class_type":"LoadImage","inputs":{"image":name}});
    let scaled = format!("{id}S");
    g[&scaled] = json!({"class_type":"ImageScale","inputs":{"image":[id,0],"upscale_method":"lanczos","width":w,"height":h,"crop":"center"}});
    json!([scaled, 0])
}

fn decode(g: &mut Value, id: &str, samples: Value, vae: Value, i: &Value) {
    g[id] = match i["options"]["vaeTile"].as_u64() {
        Some(t) => {
            json!({"class_type":"VAEDecodeTiled","inputs":{"samples":samples,"vae":vae,"tile_size":t,"overlap":64,"temporal_size":64,"temporal_overlap":8}})
        }
        None => json!({"class_type":"VAEDecode","inputs":{"samples":samples,"vae":vae}}),
    };
}

/// Effective native combine settings, shared by execution and immutable history projection.
pub(crate) fn effective_output(i: &Value) -> Value {
    let mut output = json!({
        "codec":"Auto","container":"Auto","bitDepth":"Auto","quality":20,
        "audioCodec":"Auto","audioBitrate":"192k","saveFirstFrame":false,"saveLastFrame":false
    });
    if let Some(selected) = i["output"].as_object() {
        for (key, value) in selected {
            output[key] = value.clone();
        }
    }
    output
}

pub(crate) fn effective_output_prefix(i: &Value) -> Value {
    i.get("outputPrefix").cloned().unwrap_or_else(|| {
        json!(if crate::jobs_video_post::is_enhance(i) {
            "raw/tve/DEAS"
        } else {
            "raw/video/DEAS"
        })
    })
}

/// DaSiWa Enhanced Video Combine as node "7": the history reader looks there.
pub(crate) fn combine(
    g: &mut Value,
    images: Value,
    audio: Option<Value>,
    frame_rate: Value,
    i: &Value,
) {
    let o = effective_output(i);
    let mut inputs = json!({
        "images":images,"frame_rate":frame_rate,
        "codec":o["codec"],"container":o["container"],"bit_depth":o["bitDepth"],
        "quality":o["quality"],"log_level":"Standard","pingpong":false,"save_metadata":true,
        "filename_prefix":effective_output_prefix(i),"save_output":true,"pass_frames":false,"crop_to_audio":false,
        "audio_codec":o["audioCodec"],"audio_bitrate":o["audioBitrate"],
        "save_first_frame":o["saveFirstFrame"],"save_last_frame":o["saveLastFrame"],
        "seed":i["seed"]
    });
    if let Some(a) = audio {
        inputs["audio"] = a;
    }
    g["7"] = json!({"class_type":"DaSiWa_EnhancedVideoCombine","inputs":inputs});
}

/// Unprocessed baseline as "B7" at the pre-chain frame rate.
pub(crate) fn baseline_combine(
    g: &mut Value,
    images: Value,
    audio: Option<Value>,
    frame_rate: Value,
    i: &Value,
) {
    let mut saver = g["7"].clone();
    saver["inputs"]["images"] = images;
    match audio {
        Some(a) => saver["inputs"]["audio"] = a,
        None => {
            saver["inputs"].as_object_mut().unwrap().remove("audio");
        }
    }
    saver["inputs"]["frame_rate"] = frame_rate;
    saver["inputs"]["filename_prefix"] = json!(format!(
        "{}_original",
        effective_output_prefix(i).as_str().unwrap()
    ));
    g["B7"] = saver;
}

/// Optional TVE chain after the decode: returns (combine images, combine frame rate, combine audio).
fn post(
    g: &mut Value,
    images: Value,
    frame_rate: Value,
    audio: Option<Value>,
    i: &Value,
) -> (Value, Value, Option<Value>) {
    match i.get("videoPost") {
        Some(p) => {
            let looped = p.get("loop").is_some();
            let (images, audio) =
                crate::jobs_video_post::seamless_loop(g, images, frame_rate.clone(), audio, p);
            let out = crate::jobs_video_post::chain(g, images, p);
            // The whole chain (incl. its model loaders) sits behind the lazy input, so B7 (always
            // present with videoPost) is encoded before any post node starts.
            g["PG"] = json!({"class_type":"DEAS_VideoPostprocessGate","inputs":{"baseline":["B7",1],"image":out}});
            // Looped audio also passes the gate, else saver 7 would pull LP ahead of B7.
            let audio = match audio {
                Some(a) if looped => {
                    g["PG"]["inputs"]["audio"] = a;
                    Some(json!(["PG", 1]))
                }
                a => a,
            };
            let m = crate::jobs_video_post::multiplier(p);
            let fps = if m > 1 {
                json!(i["frameRate"].as_f64().unwrap() * m as f64)
            } else {
                frame_rate
            };
            (json!(["PG", 0]), fps, audio)
        }
        // A latent-upscale-only branch needs the same baseline-first lazy barrier.
        None if i.get("faceRefine").is_some() || i.get("latentUpscale").is_some() => {
            crate::jobs_face_refine::gate(g, images);
            (json!(["PG", 0]), frame_rate, audio)
        }
        None => (images, frame_rate, audio),
    }
}

/// The baseline is the first decode: before the latent upscale when there is one, else before the TVE chain.
fn needs_post_baseline(i: &Value) -> bool {
    (i.get("videoPost").is_some() || i.get("faceRefine").is_some())
        && i.get("latentUpscale").is_none()
}

/// One LTX sampling pass. `suffix` "" is the first pass; guides are re-added on the given video latent,
/// AV concat → SamplerCustomAdvanced → separate → crop guides. Returns (video latent link, audio latent link).
#[allow(clippy::too_many_arguments)]
fn ltx_pass(
    g: &mut Value,
    suffix: &str,
    video: Value,
    audio: Value,
    model: &Value,
    guides: &[(Value, i64, f64)],
    steps: Value,
    denoise: f64,
    i: &Value,
) -> (Value, Value) {
    let (mut cond, mut latent) = (json!(["CN"]), video);
    for (n, (image, idx, strength)) in guides.iter().enumerate() {
        let id = format!("G{}{suffix}", n + 1);
        g[&id] = json!({"class_type":"LTXVAddGuide","inputs":{"positive":[cond[0].clone(),0],"negative":[cond[0].clone(),1],"vae":["V",0],"latent":latent,"image":image,"frame_idx":idx,"strength":strength}});
        cond = json!([id]);
        latent = json!([id, 2]);
    }
    let (pos, neg) = (json!([cond[0].clone(), 0]), json!([cond[0].clone(), 1]));
    let (cat, z, gu, s, sep, cr) = (
        format!("CAT{suffix}"),
        format!("Z{suffix}"),
        format!("GU{suffix}"),
        format!("5{suffix}"),
        format!("SEP{suffix}"),
        format!("CR{suffix}"),
    );
    g[&cat] = json!({"class_type":"LTXVConcatAVLatent","inputs":{"video_latent":latent,"audio_latent":audio}});
    g[&z] = json!({"class_type":"BasicScheduler","inputs":{"model":model,"scheduler":i["scheduler"],"steps":steps,"denoise":denoise}});
    g[&gu] = json!({"class_type":"CFGGuider","inputs":{"model":model,"positive":pos,"negative":neg,"cfg":i["cfg"]}});
    g[&s] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":[gu,0],"sampler":["Q",0],"sigmas":[z,0],"latent_image":[cat,0]}});
    g[&sep] = json!({"class_type":"LTXVSeparateAVLatent","inputs":{"av_latent":[s,0]}});
    let audio_out = json!([sep.clone(), 1]);
    if guides.is_empty() {
        return (json!([sep, 0]), audio_out);
    }
    g[&cr] = json!({"class_type":"LTXVCropGuides","inputs":{"positive":pos,"negative":neg,"latent":[sep,0]}});
    (json!([cr, 2]), audio_out)
}

fn ltx(i: &Value) -> Value {
    let l = &i["ltx"];
    let passes = l["passes"].as_u64().unwrap();
    let (w, h) = (i["width"].as_u64().unwrap(), i["height"].as_u64().unwrap());
    // Multipass samples the first pass at half canvas (OmniForge), then upsamples the latent 2×.
    let (w1, h1) = if passes > 1 { (w / 2, h / 2) } else { (w, h) };
    let mut g = json!({
        "1":unet_loader("ltx-2",&i["model"]),
        "C":crate::jobs::dual_clip_loader(&i["textEncoder"], &l["textProjection"], "ltxv"),
        "V":{"class_type":"VAELoader","inputs":{"vae_name":i["vae"]}},
        "AV":{"class_type":"VAELoader","inputs":{"vae_name":l["audioVae"]}},
        "N":{"class_type":"RandomNoise","inputs":{"noise_seed":i["seed"]}},
        "Q":{"class_type":"KSamplerSelect","inputs":{"sampler_name":i["sampler"]}},
        "EL":{"class_type":"EmptyLTXVLatentVideo","inputs":{"width":w1,"height":h1,"length":i["frames"],"batch_size":1}},
        "EA":{"class_type":"LTXVEmptyLatentAudio","inputs":{"frames_number":i["frames"],"frame_rate":i["frameRate"],"batch_size":1,"audio_vae":["AV",0]}},
    });
    let mut clip = json!(["C", 0]);
    let model = model_chain(
        &mut g,
        "",
        json!(["1", 0]),
        Some(&mut clip),
        i,
        "LTXVChunkFeedForward",
        "dim_threshold",
    );
    g["2"] =
        json!({"class_type":"CLIPTextEncode","inputs":{"text":i["positivePrompt"],"clip":clip}});
    g["3"] =
        json!({"class_type":"CLIPTextEncode","inputs":{"text":i["negativePrompt"],"clip":clip}});
    g["CN"] = json!({"class_type":"LTXVConditioning","inputs":{"positive":["2",0],"negative":["3",0],"frame_rate":i["frameRate"]}});
    // Guides the way the Director adds them, after LTXVPreprocess(img_compression 18): a source video as one
    // multi-frame guide at 0 (video-to-video), first frame at 0, keyframe images at their frame, last frame at -1.
    let mut sources: Vec<(String, Value, i64, f64)> = vec![];
    if let Some(video) = i.get("sourceVideo") {
        g["SV"] = json!({"class_type":"LoadVideo","inputs":{"file":video}});
        g["SVC"] = json!({"class_type":"GetVideoComponents","inputs":{"video":["SV",0]}});
        // shortcut: source frames are taken at the file's own rate (as the WhatDreamsCost Director does); resample when fps differ noticeably.
        g["SVT"] = json!({"class_type":"ImageFromBatch","inputs":{"image":["SVC",0],"batch_index":0,"length":i["frames"]}});
        g["SVS"] = json!({"class_type":"ImageScale","inputs":{"image":["SVT",0],"upscale_method":"lanczos","width":i["width"],"height":i["height"],"crop":"center"}});
        sources.push((
            "SV".into(),
            json!(["SVS", 0]),
            0,
            l["sourceStrength"].as_f64().unwrap(),
        ));
    }
    for (key, src, idx) in [("firstFrame", "8", 0i64), ("lastFrame", "9", -1)] {
        if let Some(name) = i.get(key) {
            let scaled = input_image(&mut g, src, name, &i["width"], &i["height"]);
            sources.push((src.into(), scaled, idx, 1.0));
        }
    }
    for (n, k) in l["keyframes"].as_array().into_iter().flatten().enumerate() {
        let src = format!("K{}", n + 1);
        let scaled = input_image(&mut g, &src, &k["image"], &i["width"], &i["height"]);
        sources.push((
            src,
            scaled,
            k["frame"].as_i64().unwrap(),
            k["strength"].as_f64().unwrap(),
        ));
    }
    let mut full = vec![];
    let mut half = vec![];
    for (src, scaled, idx, strength) in sources {
        g[&format!("{src}P")] =
            json!({"class_type":"LTXVPreprocess","inputs":{"image":scaled,"img_compression":18}});
        full.push((json!([format!("{src}P"), 0]), idx, strength));
        if passes > 1 {
            g[&format!("{src}H")] = json!({"class_type":"ImageScale","inputs":{"image":[format!("{src}P"),0],"upscale_method":"lanczos","width":w1,"height":h1,"crop":"disabled"}});
            half.push((json!([format!("{src}H"), 0]), idx, strength));
        }
    }
    let guides = if passes > 1 { &half } else { &full };
    let (mut video, mut audio) = ltx_pass(
        &mut g,
        "",
        json!(["EL", 0]),
        json!(["EA", 0]),
        &model,
        guides,
        i["steps"].clone(),
        1.0,
        i,
    );
    if passes > 1 {
        g["UL"] = json!({"class_type":"LatentUpscaleModelLoader","inputs":{"model_name":l["spatialUpscaler"]}});
        g["UP"] = json!({"class_type":"LTXVLatentUpsampler","inputs":{"samples":video,"upscale_model":["UL",0],"vae":["V",0]}});
        // OmniForge pass 2/3 steps and denoise.
        (video, audio) = ltx_pass(
            &mut g,
            "b",
            json!(["UP", 0]),
            audio,
            &model,
            &full,
            json!(4),
            0.4,
            i,
        );
        if passes == 3 {
            (video, audio) = ltx_pass(&mut g, "c", video, audio, &model, &full, json!(2), 0.2, i);
        }
    }
    if let Some(u) = i.get("latentUpscale") {
        decode(&mut g, "B6", video.clone(), json!(["V", 0]), i);
        g["UML"] =
            json!({"class_type":"LatentUpscaleModelLoader","inputs":{"model_name":u["model"]}});
        g["U"] = json!({"class_type":"LTXVLatentUpsampler","inputs":{"samples":video,"upscale_model":["UML",0],"vae":["V",0]}});
        video = json!(["U", 0]);
    }
    decode(&mut g, "6", video, json!(["V", 0]), i);
    g["AD"] =
        json!({"class_type":"LTXVAudioVAEDecode","inputs":{"samples":audio,"audio_vae":["AV",0]}});
    let (images, fps, audio) = post(
        &mut g,
        json!(["6", 0]),
        i["frameRate"].clone(),
        Some(json!(["AD", 0])),
        i,
    );
    combine(&mut g, images, audio, fps, i);
    if i.get("latentUpscale").is_some() {
        baseline_combine(
            &mut g,
            json!(["B6", 0]),
            Some(json!(["AD", 0])),
            i["frameRate"].clone(),
            i,
        );
    } else if needs_post_baseline(i) {
        baseline_combine(
            &mut g,
            json!(["6", 0]),
            Some(json!(["AD", 0])),
            i["frameRate"].clone(),
            i,
        );
    }
    g
}

fn wan(i: &Value) -> Result<Value, String> {
    let w = &i["wan"];
    if i.get("firstFrame").is_none() {
        return Err("Wan 2.2 image-to-video needs a first frame".into());
    }
    let mut g = json!({
        "1":unet_loader("wan",&i["model"]),
        "1L":unet_loader("wan",&w["lowModel"]),
        "C":crate::jobs::clip_loader(&i["textEncoder"], &json!("wan")),
        "V":{"class_type":"VAELoader","inputs":{"vae_name":i["vae"]}},
        "2":{"class_type":"CLIPTextEncode","inputs":{"text":i["positivePrompt"],"clip":["C",0]}},
        "3":{"class_type":"CLIPTextEncode","inputs":{"text":i["negativePrompt"],"clip":["C",0]}},
    });
    // shortcut: one LoRA list with one strength on both high and low; upgrade to per-model lists for split LoRAs (lightx2v).
    let high = model_chain(
        &mut g,
        "",
        json!(["1", 0]),
        None,
        i,
        "WanChunkFeedForward",
        "dim_threshold",
    );
    let low = model_chain(
        &mut g,
        "l",
        json!(["1L", 0]),
        None,
        i,
        "WanChunkFeedForward",
        "dim_threshold",
    );
    g["SH"] =
        json!({"class_type":"ModelSamplingSD3","inputs":{"model":high,"shift":w["shiftHigh"]}});
    g["SL"] = json!({"class_type":"ModelSamplingSD3","inputs":{"model":low,"shift":w["shiftLow"]}});
    let start = input_image(&mut g, "8", &i["firstFrame"], &i["width"], &i["height"]);
    let mut inputs = json!({"positive":["2",0],"negative":["3",0],"vae":["V",0],"width":i["width"],"height":i["height"],"length":i["frames"],"batch_size":1,"start_image":start});
    let node = match i.get("lastFrame") {
        Some(last) => {
            inputs["end_image"] = input_image(&mut g, "9", last, &i["width"], &i["height"]);
            "WanFirstLastFrameToVideo"
        }
        None => "WanImageToVideo",
    };
    g["W"] = json!({"class_type":node,"inputs":inputs});
    let sampler = |model: Value, latent: Value, first: bool| {
        json!({"class_type":"KSamplerAdvanced","inputs":{
            "model":model,"add_noise":if first {"enable"} else {"disable"},"noise_seed":i["seed"],"steps":i["steps"],"cfg":i["cfg"],
            "sampler_name":i["sampler"],"scheduler":i["scheduler"],"positive":["W",0],"negative":["W",1],"latent_image":latent,
            "start_at_step":if first {json!(0)} else {w["refinerStep"].clone()},"end_at_step":if first {w["refinerStep"].clone()} else {json!(10000)},
            "return_with_leftover_noise":if first {"enable"} else {"disable"}}})
    };
    g["KH"] = sampler(json!(["SH", 0]), json!(["W", 2]), true);
    g["KL"] = sampler(json!(["SL", 0]), json!(["KH", 0]), false);
    decode(&mut g, "6", json!(["KL", 0]), json!(["V", 0]), i);
    let (images, fps, audio) = post(&mut g, json!(["6", 0]), i["frameRate"].clone(), None, i);
    combine(&mut g, images, audio, fps, i);
    if needs_post_baseline(i) {
        baseline_combine(&mut g, json!(["6", 0]), None, i["frameRate"].clone(), i);
    }
    Ok(g)
}

/// H3 sigma schedule as `Z` (shifted `BasicScheduler`, or the distilled family's own sigma node
/// reading the stored schedule); returns the model link the guiders sample.
/// De-rope second pass (MAINodes Motion Lab via DaSiWa De-rope Prepare/Recover): hold the hot motion
/// spans of the baseline, re-render them at partial denoise, drop the holds; Prepare also moves the
/// Director's frame-indexed keyframes onto the slowed clock. Feeds the post gate, so
/// the baseline saver runs first; the result keeps the baseline audio (Motion Lab's reference_mix 1).
fn derope(g: &mut Value, images: Value, audio: Value, model: Value, d: &Value, i: &Value) -> Value {
    // The owner declares a distilled generation chain (turbo checkpoint or a turbo LoRA in the
    // generation LoRAs): it then gets Motion Lab's turbo schedule on that same chain. The step count
    // is no evidence of distillation.
    let distilled = d["distilled"] == true;
    let in_chain = |name: &Value| {
        i["loras"]
            .as_array()
            .is_some_and(|l| l.iter().any(|x| &x["name"] == name))
    };
    let (model, steps, scheduler) = match d.get("lora") {
        // Motion Lab's turbo pass: 6 total steps on beta, of which inject × 6 run. A LoRA the
        // generation chain already carries is not stacked a second time.
        Some(lora) if !in_chain(lora) => {
            g["DRL"] = json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":model,"lora_name":lora,"strength_model":1.0}});
            (json!(["DRL", 0]), 6, json!("beta"))
        }
        Some(_) => (model, 6, json!("beta")),
        None if distilled => (model, 6, json!("beta")),
        None => (model, 25, i["scheduler"].clone()),
    };
    // The pass samples a stretched clip: Dial Hold Map gives the rack's time curves the hold map,
    // so they follow real clip time. Rows without a time curve need nothing.
    let model = if dial_curves(i) {
        g["DRH"] =
            json!({"class_type":"MAIDialHoldMap","inputs":{"model":model,"hold_map":["DRP",1]}});
        json!(["DRH", 0])
    } else {
        model
    };

    g["DRP"] = json!({"class_type":"DaSiWaH3DeropePrepare","inputs":{"images":images.clone(),"samples":["SP",0],"vae":["V",0],
        "preset":d["preset"],"frame_rate":i["frameRate"],"audio":audio,"audio_vae":["AV",0],"conditioning":["G",0],
        // A continuation's keyframes index the sampled clip, not the decoded timeline/window.
        "keep_keyframes":!c_source(&i["h3"])}});
    g["DRZ"] = json!({"class_type":"BasicScheduler","inputs":{"model":model,"scheduler":scheduler,"steps":steps,"denoise":1.0}});
    g["DRS"] = json!({"class_type":"SplitSigmasDenoise","inputs":{"sigmas":["DRZ",0],"denoise":d["inject"]}});
    g["DRG"] =
        json!({"class_type":"BasicGuider","inputs":{"model":model,"conditioning":["DRP",3]}});
    g["DRK"] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":["DRG",0],"sampler":["Q",0],"sigmas":["DRS",1],"latent_image":["DRP",0]}});
    decode(g, "DRD", json!(["DRK", 0]), json!(["V", 0]), i);
    g["DRR"] = json!({"class_type":"DaSiWaH3DeropeRecover","inputs":{"images":["DRD",0],"hold_map":["DRP",1]}});
    if d["keepBackground"] == true {
        g["DRR"]["inputs"]["baseline"] = images;
        g["DRR"]["inputs"]["keep_background"] = json!(true);
    }
    json!(["DRR", 0])
}

pub(crate) fn h3_schedule(
    g: &mut Value,
    model: Value,
    family: &str,
    i: &Value,
    shift_video: &Value,
    shift_audio: &Value,
) -> Value {
    match crate::model_families::video_recipe(family).sigma_node {
        // Distilled checkpoints sample their own stored schedule: no shift or scheduler chain runs.
        Some(node) => {
            g["Z"] = json!({"class_type":node,"inputs":{"model":model.clone(),"steps":i["steps"]}});
            model
        }
        None => {
            g["SS"] = json!({"class_type":"MiniMaxH3SigmaShift","inputs":{"model":model,"shift_video":shift_video,"shift_audio":shift_audio}});
            g["Z"] = json!({"class_type":"BasicScheduler","inputs":{"model":["SS",0],"scheduler":i["scheduler"],"steps":i["steps"],"denoise":1.0}});
            json!(["SS", 0])
        }
    }
}

fn h3(i: &Value) -> Value {
    let h = &i["h3"];
    let mut items: Vec<Value> = h["references"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(n, r)| json!({"id":format!("ref{}",r["slot"]),"type":"image","value":r["image"],"slot":r["slot"],"order":n,"enabled":true}))
        .collect();
    // REF2VA timeline media (Director item contract: value = input-relative file, trims in seconds).
    for (n, m) in h["media"].as_array().into_iter().flatten().enumerate() {
        let mut item = json!({"id":format!("m{n}"),"type":m["type"],"value":m["file"],"slot":m["slot"],"order":n,"enabled":true});
        for (from, to) in [
            ("mediaMode", "media_mode"),
            ("trimStart", "trim_start"),
            ("trimEnd", "trim_end"),
        ] {
            if let Some(v) = m.get(from) {
                item[to] = v.clone();
            }
        }
        items.push(item);
    }
    // Director continuity contract (v3): an empty source_id is a new take; parse_settings fills the rest.
    let c = &h["continuity"];
    let mut continuity = if c_source(h) {
        let mut continuity = json!({"version":3,"session":c["session"],"capture":c["capture"],"output_mode":c["outputMode"],"continuation_prompt":c["action"]});
        if c["sourceKind"] == "video" {
            continuity["source_kind"] = json!("video");
            continuity["source_video_id"] = c["sourceId"].clone();
        } else {
            continuity["source_kind"] = json!("checkpoint");
            continuity["source_id"] = c["sourceId"].clone();
        }
        if let Some(frames) = c.get("overlapFrames") {
            continuity["overlap_frames"] = frames.clone();
        }
        continuity
    } else {
        json!({"version":3,"session":c.get("session").cloned().unwrap_or(json!("deas")),"capture":c.get("capture").cloned().unwrap_or(json!(false)),"output_mode":c.get("outputMode").cloned().unwrap_or(json!("full"))})
    };
    if let Some(use_references) = c.get("useReferences") {
        continuity["use_references"] = use_references.clone();
    }
    // DEAS already chose the canvas; by default the Director fills/crops the references to it.
    let scaling = h
        .get("inputScaling")
        .cloned()
        .unwrap_or(json!("Fill and crop"));
    let mut timeline = json!({"version":1,"items":items,"prompt_blocks":[],"resolution":{"input_scaling":scaling},"continuity":continuity});
    // RefMods (saved REF2VA references in models/refmods), loaded by the Director itself.
    if let Some(rows) = h["refmods"].as_array() {
        timeline["refmods"] = rows
            .iter()
            .map(|r| json!({"slot":r["slot"],"name":r["name"],"enabled":true,"strength":r["strength"],"description":r.get("description").cloned().unwrap_or(json!(""))}))
            .collect();
    }
    let mut g = json!({
        "1":unet_loader(i["family"].as_str().unwrap_or_default(),&i["model"]),
        "C":crate::jobs::clip_loader(&i["textEncoder"], &json!("minimax")),
        "V":{"class_type":"VAELoader","inputs":{"vae_name":i["vae"]}},
        "AV":{"class_type":"VAELoader","inputs":{"vae_name":h["audioVae"]}},
        "N":{"class_type":"RandomNoise","inputs":{"noise_seed":i["seed"]}},
        "Q":{"class_type":"KSamplerSelect","inputs":{"sampler_name":i["sampler"]}},
    });
    let model = model_chain(
        &mut g,
        "",
        json!(["1", 0]),
        None,
        i,
        "MiniMaxChunkFeedForward",
        "seq_threshold",
    );
    // REF2VA extensions need authored seconds, not a roundtrip through the new-take 17k+5 grid.
    g["D"] = json!({"class_type":"MiniMaxH3Director","inputs":{"mode":h["mode"],"prompt":i["positivePrompt"],"width":i["width"],"height":i["height"],
        "duration":c.get("durationSeconds").cloned().unwrap_or_else(|| json!(i["frames"].as_f64().unwrap() / 24.0)),"ref_image_size":"match","timeline_data":timeline.to_string(),"builder_state":"","frame_rate":i["frameRate"]}});
    // The Director pulls only the socket of its mode: ref2va_model for REF2VA, fl2va_model otherwise.
    g["D"]["inputs"][if h["mode"] == "REF2VA" {
        "ref2va_model"
    } else {
        "fl2va_model"
    }] = model;
    g["G"] = json!({"class_type":"MiniMaxH3DirectorGuide","inputs":{"clip":["C",0],"vae":["V",0],"guide":["D",0],"audio_vae":["AV",0]}});
    let sampling = h3_schedule(
        &mut g,
        json!(["D", 5]),
        i["family"].as_str().unwrap_or_default(),
        i,
        &h["shiftVideo"],
        &h["shiftAudio"],
    );
    g["B"] = json!({"class_type":"BasicGuider","inputs":{"model":sampling.clone(),"conditioning":["G",0]}});
    g["5"] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":["B",0],"sampler":["Q",0],"sigmas":["Z",0],"latent_image":["G",1]}});
    // Segment Prepare/Decode serve both Director output modes and are plain decode without capture.
    g["SP"] = json!({"class_type":"DaSiWaH3ContinuitySegmentPrepare","inputs":{"sampled":["5",0],"context":["G",2]}});
    g["SD"] = json!({"class_type":"DaSiWaH3ContinuitySegmentDecode","inputs":{"latent":["SP",0],"vae":["V",0],"audio_vae":["AV",0],"context":["SP",1]}});
    let upscale = i.get("latentUpscale").is_some();
    let segment_capture = c["capture"] == true && c["outputMode"] == "segment";
    let derope_block = i["videoPost"].get("derope");
    let refining = derope_block.is_some() || i.get("faceRefine").is_some();
    // A continued new-segment capture decodes only the new segment from a render window that also
    // holds the source tail: De-rope (and a re-encode for the upscale) needs the whole window.
    let window =
        segment_capture && c_source(h) && (derope_block.is_some() || (upscale && refining));
    let (mut frames, mut audio) = if window {
        decode(&mut g, "BA", json!(["SP", 0]), json!(["V", 0]), i);
        g["WA"] =
            json!({"class_type":"VAEDecodeAudio","inputs":{"samples":["SP",0],"vae":["AV",0]}});
        (json!(["BA", 0]), json!(["WA", 0]))
    } else if upscale && !segment_capture {
        // With latent upscale, the fixes work on the base decode BSD (SD decodes the upscale).
        g["BSD"] = g["SD"].clone();
        (json!(["BSD", 0]), json!(["BSD", 1]))
    } else {
        (json!(["SD", 0]), json!(["SD", 1]))
    };
    // De-rope re-renders the whole clip, so it runs before face refinement and the TVE chain.
    if let Some(d) = derope_block {
        frames = derope(&mut g, frames, audio.clone(), sampling.clone(), d, i);
    }
    if window && !upscale {
        // Back to the new segment before face refinement; the segment decode carries its audio.
        let (start, count) = segment_crop_plan(i).expect("validated with videoPost.derope");
        g["WC"] = json!({"class_type":"ImageFromBatch","inputs":{"image":frames,"batch_index":start,"length":count}});
        frames = json!(["WC", 0]);
        audio = json!(["SD", 1]);
    }
    if let Some(f) = i.get("faceRefine") {
        frames = crate::jobs_face_refine::insert(
            &mut g,
            frames,
            Some(audio),
            json!(["D", 8]),
            sampling,
            f,
            (json!(["C", 0]), json!(["V", 0])),
        );
    }
    if upscale && refining {
        // Fix first, then upscale: re-encode the refined frames beside the untouched audio latent.
        g["RS"] = json!({"class_type":"LTXVSeparateAVLatent","inputs":{"av_latent":["SP",0]}});
        g["RE"] =
            json!({"class_type":"VAEEncode","inputs":{"pixels":frames.clone(),"vae":["V",0]}});
        g["RC"] = json!({"class_type":"LTXVConcatAVLatent","inputs":{"video_latent":["RE",0],"audio_latent":["RS",1]}});
    }
    // With latent upscale the post chain starts at its decode (core crop CB for segment capture).
    let decoded = if upscale && segment_capture {
        json!(["CB", 0])
    } else if upscale {
        json!(["SD", 0])
    } else {
        frames
    };

    let (images, fps, audio) = post(&mut g, decoded, json!(["D", 8]), Some(json!(["SD", 1])), i);
    // With latent upscale the saver's audio comes from the upscale decode: pass it through the gate
    // too, else saver 7 pulls the upscale (and everything before it) ahead of the baseline B7.
    let audio = match audio {
        Some(a) if upscale && !segment_capture && g["PG"]["inputs"].get("audio").is_none() => {
            g["PG"]["inputs"]["audio"] = a;
            Some(json!(["PG", 1]))
        }
        a => a,
    };
    combine(&mut g, images, audio, fps, i);
    if needs_post_baseline(i) {
        baseline_combine(
            &mut g,
            json!(["SD", 0]),
            Some(json!(["SD", 1])),
            json!(["D", 8]),
            i,
        );
    }
    if i.get("latentUpscale").is_some() {
        // Segment capture keeps its only SegmentDecode on SP for exact, pre-upscale audio cropping;
        // the pack requires that audio directly on exporter 7. Core nodes decode/crop Processed.
        let latent = if refining {
            json!(["RC", 0])
        } else {
            json!(["SP", 0])
        };
        g["U"] = if i["latentUpscale"].get("regenerate").is_some() {
            h3_regenerate_node(&mut g, i, json!(["G", 0]), latent)
        } else {
            h3_upscale_node(i, json!(["G", 0]), latent)
        };
        for (input, link) in [
            ("continuity_context", json!(["SP", 1])),
            ("director_guide", json!(["D", 0])),
            ("vae", json!(["V", 0])),
        ] {
            g["U"]["inputs"][input] = link;
        }
        if segment_capture {
            // The render plan is derived at runtime from the prepared latent tensor and context;
            // SegmentDecode accepts no duration input. The compile-time crop mirrors the pack's
            // continuation timing for the duration the Director received (durationSeconds else frames/24).
            let (crop_start, crop_frames) =
                segment_crop_plan(i).expect("validated in validate_latent_upscale");
            decode(&mut g, "UD", json!(["U", 0]), json!(["V", 0]), i);
            g["CB"] = json!({"class_type":"ImageFromBatch","inputs":{"image":["UD",0],"batch_index":crop_start,"length":crop_frames}});
            baseline_combine(
                &mut g,
                json!(["SD", 0]),
                Some(json!(["SD", 1])),
                json!(["D", 8]),
                i,
            );
        } else {
            g["SD"]["inputs"]["latent"] = json!(["U", 0]);
            baseline_combine(
                &mut g,
                json!(["BSD", 0]),
                Some(json!(["BSD", 1])),
                json!(["D", 8]),
                i,
            );
        }
    }
    // A seamless loop retimes the Processed ending (trim/crossfade), and the pack requires the checkpoint
    // export to match the saved latent with audio straight from its decode: capture the Original instead.
    let exporter = if i["videoPost"].get("loop").is_some() {
        "B7"
    } else {
        "7"
    };
    g["P"] = json!({"class_type":"DaSiWaH3ContinuityPublish","inputs":{"filename":[exporter,1],"ticket":["SP",2]}});
    if i["streamDecode"] == true {
        // Keep the exact house encoding/naming settings; no IMAGE or eager audio can pull U before B7.
        for (id, samples) in [("B7", json!(["SP", 0])), ("7", json!(["U", 0]))] {
            let saver = &mut g[id];
            saver["class_type"] = json!("DEAS_H3StreamVideoSave");
            let inputs = saver["inputs"].as_object_mut().unwrap();
            inputs.remove("images");
            inputs.remove("audio");
            inputs.remove("pingpong");
            inputs.remove("pass_frames");
            inputs.insert("samples".into(), samples);
            inputs.insert("vae".into(), json!(["V", 0]));
            inputs.insert("audio_vae".into(), json!(["AV", 0]));
        }
        g["7"]["inputs"]["baseline"] = json!(["B7", 1]);
        for id in ["BSD", "SD", "PG"] {
            g.as_object_mut().unwrap().remove(id);
        }
    }
    g
}

fn strs<'a>(v: &[&'a Value]) -> Vec<&'a str> {
    v.iter().filter_map(|x| x.as_str()).collect()
}

/// GGUF files load through the family's declared GGUF node (HyperFlow GGUFs need their own
/// loader; they carry no `general.architecture`), which takes no weight_dtype; families with a
/// dedicated safetensors loader (HyperFlow) get theirs the same way.
pub(crate) fn unet_loader(family: &str, name: &Value) -> Value {
    let vr = crate::model_families::video_recipe(family);
    if crate::jobs::is_gguf(name.as_str().unwrap_or_default()) {
        json!({"class_type":vr.gguf_loader,"inputs":{"unet_name":name}})
    } else if vr.safetensors_loader != "UNETLoader" {
        json!({"class_type":vr.safetensors_loader,"inputs":{"unet_name":name}})
    } else {
        json!({"class_type":"UNETLoader","inputs":{"unet_name":name,"weight_dtype":"default"}})
    }
}

/// Model/encoder/VAE/image/upscaler names prepare() must find in object_info, per allowlist field.
pub(crate) fn requirements(i: &Value) -> Vec<(&'static str, Vec<&str>)> {
    if is_join(i) {
        // Model-free assembly: the pack nodes ride H3_CONTINUITY_NODES evidence; no models/files needed.
        return Vec::new();
    }
    if crate::jobs_face_refine::is_face_refine(i) {
        return crate::jobs_face_refine::requirements(i);
    }
    if crate::jobs_video_post::is_enhance(i) {
        return crate::jobs_video_post::requirements(&i["videoPost"]);
    }
    let family = i["family"].as_str().unwrap_or_default();
    let b = &i[block(family)];
    let (gguf, plain): (Vec<&str>, Vec<&str>) = strs(&[&i["model"], &b["lowModel"]])
        .into_iter()
        .partition(|name| crate::jobs::is_gguf(name));
    let quantized_clip = crate::jobs::is_gguf(i["textEncoder"].as_str().unwrap_or_default());
    let (encoders, types) = match (quantized_clip, family == "ltx-2") {
        (true, true) => ("ggufDualTextEncoders", "ggufDualClipTypes"),
        (true, false) => ("ggufTextEncoders", "ggufClipTypes"),
        _ => ("textEncoders", "clipTypes"),
    };
    let mut required = vec![
        ("diffusionModels", plain),
        ("ggufDiffusionModels", gguf),
        (encoders, strs(&[&i["textEncoder"], &b["textProjection"]])),
        ("vaes", strs(&[&i["vae"], &b["audioVae"]])),
        (
            types,
            vec![match family {
                "ltx-2" => "ltxv",
                "wan" => "wan",
                _ => "minimax",
            }],
        ),
        (
            "images",
            // object_info lists only the input folder; ComfyUI resolves `[output]` files itself.
            strs(&[&i["firstFrame"], &i["lastFrame"]])
                .into_iter()
                .chain(
                    b["references"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|r| r["image"].as_str()),
                )
                .chain(
                    b["keyframes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|k| k["image"].as_str()),
                )
                .chain(
                    b["media"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|m| {
                            m["type"] == "image"
                                && !(is_h3(family)
                                    && b["mode"] == "REF2VA"
                                    && c_source(b)
                                    && b["continuity"]["useReferences"] != true)
                        })
                        .filter_map(|m| m["file"].as_str()),
                )
                .filter(|s| !s.ends_with(" [output]"))
                .collect(),
        ),
        (
            "h3LatentUpscaleModels",
            (family == "minimax-h3" && !regenerate_only(i))
                .then(|| i["latentUpscale"]["model"].as_str())
                .flatten()
                .into_iter()
                .collect(),
        ),
        (
            "latentUpscaleModels",
            strs(&[&b["spatialUpscaler"]])
                .into_iter()
                .chain(
                    (family == "ltx-2")
                        .then(|| i["latentUpscale"]["model"].as_str())
                        .flatten(),
                )
                .collect(),
        ),
    ];
    if i["enhancedPreview"]["decoder"] == "vae" {
        required.push(("vaes", strs(&[&i["enhancedPreview"]["model"]])));
    }
    let regenerate = &i["latentUpscale"]["regenerate"];
    for (field, key) in [("loras", "lora"), ("diffusionModels", "model")] {
        if let Some(name) = regenerate[key].as_str() {
            required.push((field, vec![name]));
        }
    }
    required.extend(crate::jobs_video_post::requirements(&i["videoPost"]));
    // Dial files live in models/loras/dials, so the backend lists them with the LoRAs.
    let dials: Vec<&str> = active_dials(i).filter_map(|r| r["dial"].as_str()).collect();
    if !dials.is_empty() {
        required.push(("loras", dials));
    }
    if let Some(sam) = i["faceRefine"]["samCheckpoint"].as_str() {
        required.push(("checkpoints", vec![sam]));
    }
    required
}

#[cfg(test)]
#[path = "jobs_video_tests.rs"]
pub(crate) mod tests;
