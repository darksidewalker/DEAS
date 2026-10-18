//! Video recipes wired the way the owner's DaSiWa workflows do it (LTX OmniForge, Wan 2.2
//! FastFidelity, MiniMax H3 MythicAlchemy), not the ComfyUI templates. One intent,
//! `recipeId: "video-generation"`, discriminated by `family`.
use crate::jobs::{model_name, safe_choice, safe_output_prefix, valid_options};
use serde_json::{json, Value};

pub(crate) const FAMILIES: [&str; 3] = ["ltx-2", "wan", "minimax-h3"];
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
const OPTIONAL: [&str; 7] = [
    "outputPrefix",
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
const H3_MODES: [&str; 4] = ["T2VA", "I2VA", "L2VA", "FL2VA"];
/// Every class the three graphs can emit; prepare() checks each against object_info.
pub(crate) const VIDEO_NODES: [&str; 32] = [
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
    "MiniMaxH3SigmaShift",
    "MiniMaxChunkFeedForward",
    "DaSiWa_EnhancedVideoCombine",
];
pub(crate) const H3_CONTINUITY_NODES: [&str; 3] = [
    "DaSiWaH3ContinuitySegmentPrepare",
    "DaSiWaH3ContinuitySegmentDecode",
    "DaSiWaH3ContinuityPublish",
];

pub(crate) fn is_video(intent: &Value) -> bool {
    intent["recipeId"] == "video-generation"
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

fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn keys_in(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}

fn valid_output(o: &Value) -> bool {
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

fn validate_ltx(l: &Value) -> Result<(), String> {
    let passes = l["passes"].as_u64().unwrap_or(0);
    if keys_in(
        l,
        &["textProjection", "audioVae", "passes", "spatialUpscaler"],
    ) && ["textProjection", "audioVae"]
        .iter()
        .all(|k| l[*k].as_str().is_some_and(model_name))
        && (1..=3).contains(&passes)
        && (passes == 1) == l.get("spatialUpscaler").is_none()
        && l.get("spatialUpscaler")
            .is_none_or(|s| s.as_str().is_some_and(model_name))
    {
        Ok(())
    } else {
        Err("Invalid ltx: {textProjection, audioVae, passes 1-3, spatialUpscaler exactly when passes > 1}".into())
    }
}

fn validate_wan(w: &Value, steps: u64) -> Result<(), String> {
    if keys_in(w, &["lowModel", "shiftHigh", "shiftLow", "refinerStep"])
        && w["lowModel"].as_str().is_some_and(model_name)
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
        .ok_or("Unsupported H3 mode (REF2VA and Image Inpaint are not recipes yet)")?;
    let refs = h["references"].as_array().cloned().unwrap_or_default();
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
            "T2VA" => slots.is_empty(),
            "I2VA" => slots == [0],
            "L2VA" => slots == [1],
            _ => {
                !slots.is_empty()
                    && slots.len() <= 2
                    && slots.iter().all(|s| *s <= 1)
                    && slots.windows(2).all(|w| w[0] < w[1])
            }
        };
    let cont_ok = h.get("continuity").is_none_or(|c| {
        keys_in(
            c,
            &["session", "sourceId", "capture", "action", "outputMode"],
        ) && c["session"].as_str().is_some_and(id)
            && c["sourceId"]
                .as_str()
                .is_some_and(|s| s.is_empty() || id(s))
            && c["capture"].is_boolean()
            && c["action"].as_str().is_some_and(|a| a.len() <= 50_000)
            && pick(c, "outputMode", &["full", "segment"])
    });
    if keys_in(
        h,
        &[
            "mode",
            "audioVae",
            "shiftVideo",
            "shiftAudio",
            "references",
            "continuity",
        ],
    ) && h["audioVae"].as_str().is_some_and(model_name)
        && finite(&h["shiftVideo"], 0.01, 100.0)
        && finite(&h["shiftAudio"], 0.01, 100.0)
        && slots_ok
        && cont_ok
    {
        Ok(())
    } else {
        Err("Invalid h3: {mode, audioVae, shiftVideo, shiftAudio, references[{slot, image in deas-inputs/}], continuity?}".into())
    }
}

/// Family-specific block key.
pub(crate) fn block(family: &str) -> &'static str {
    match family {
        "ltx-2" => "ltx",
        "wan" => "wan",
        _ => "h3",
    }
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
    for f in ["model", "textEncoder", "vae", "firstFrame", "lastFrame"] {
        if let Some(v) = i.get(f) {
            if !v.as_str().is_some_and(model_name) {
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
    if i.get("chunks")
        .is_some_and(|c| !c.as_u64().is_some_and(|n| (2..=16).contains(&n)))
    {
        return Err("Invalid chunks: 2..=16".into());
    }
    if i.get("output").is_some_and(|o| !valid_output(o)) {
        return Err("Invalid output settings".into());
    }
    if i.get("loras").is_some_and(|l| {
        !l.as_array().is_some_and(|a| {
            a.len() <= 8
                && a.iter().all(|x| {
                    x.as_object().is_some_and(|o| o.len() == 2)
                        && x["name"].as_str().is_some_and(model_name)
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
        "ltx-2" => validate_ltx(&i["ltx"])?,
        "wan" => validate_wan(&i["wan"], steps)?,
        _ => validate_h3(&i["h3"])?,
    }
    Ok(family)
}

pub(crate) fn compile(i: &Value) -> Result<Value, String> {
    match validate(i)? {
        "ltx-2" => Ok(ltx(i)),
        "wan" => wan(i),
        _ => Ok(h3(i)),
    }
}

/// LoRAs, then the Options patches, then the family's feed-forward chunking; returns the final model link.
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

/// DaSiWa Enhanced Video Combine as node "7": the history reader looks there.
fn combine(g: &mut Value, images: Value, audio: Option<Value>, frame_rate: Value, i: &Value) {
    let o = &i["output"];
    let or = |key: &str, default: Value| o.get(key).cloned().unwrap_or(default);
    let mut inputs = json!({
        "images":images,"frame_rate":frame_rate,
        "codec":or("codec",json!("Auto")),"container":or("container",json!("Auto")),"bit_depth":or("bitDepth",json!("Auto")),
        "quality":or("quality",json!(20)),"log_level":"Standard","pingpong":false,"save_metadata":true,
        "filename_prefix":i.get("outputPrefix").cloned().unwrap_or(json!("video/DEAS")),"save_output":true,"pass_frames":false,"crop_to_audio":false,
        "audio_codec":or("audioCodec",json!("Auto")),"audio_bitrate":or("audioBitrate",json!("192k")),
        "save_first_frame":or("saveFirstFrame",json!(false)),"save_last_frame":or("saveLastFrame",json!(false)),
        "seed":i["seed"]
    });
    if let Some(a) = audio {
        inputs["audio"] = a;
    }
    g["7"] = json!({"class_type":"DaSiWa_EnhancedVideoCombine","inputs":inputs});
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
    guides: &[(Value, i64)],
    steps: Value,
    denoise: f64,
    i: &Value,
) -> (Value, Value) {
    let (mut cond, mut latent) = (json!(["CN"]), video);
    for (n, (image, idx)) in guides.iter().enumerate() {
        let id = format!("G{}{suffix}", n + 1);
        g[&id] = json!({"class_type":"LTXVAddGuide","inputs":{"positive":[cond[0].clone(),0],"negative":[cond[0].clone(),1],"vae":["V",0],"latent":latent,"image":image,"frame_idx":idx,"strength":1.0}});
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
        "1":{"class_type":"UNETLoader","inputs":{"unet_name":i["model"],"weight_dtype":"default"}},
        "C":{"class_type":"DualCLIPLoader","inputs":{"clip_name1":i["textEncoder"],"clip_name2":l["textProjection"],"type":"ltxv"}},
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
    // Guides the way the Director adds them: first frame at 0, last frame at -1, after LTXVPreprocess(img_compression 18).
    let mut full = vec![];
    let mut half = vec![];
    for (key, src, idx) in [("firstFrame", "8", 0i64), ("lastFrame", "9", -1)] {
        let Some(name) = i.get(key) else { continue };
        let scaled = input_image(&mut g, src, name, &i["width"], &i["height"]);
        g[&format!("{src}P")] =
            json!({"class_type":"LTXVPreprocess","inputs":{"image":scaled,"img_compression":18}});
        full.push((json!([format!("{src}P"), 0]), idx));
        if passes > 1 {
            g[&format!("{src}H")] = json!({"class_type":"ImageScale","inputs":{"image":[format!("{src}P"),0],"upscale_method":"lanczos","width":w1,"height":h1,"crop":"disabled"}});
            half.push((json!([format!("{src}H"), 0]), idx));
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
    decode(&mut g, "6", video, json!(["V", 0]), i);
    g["AD"] =
        json!({"class_type":"LTXVAudioVAEDecode","inputs":{"samples":audio,"audio_vae":["AV",0]}});
    combine(
        &mut g,
        json!(["6", 0]),
        Some(json!(["AD", 0])),
        i["frameRate"].clone(),
        i,
    );
    g
}

fn wan(i: &Value) -> Result<Value, String> {
    let w = &i["wan"];
    if i.get("firstFrame").is_none() {
        return Err("Wan 2.2 image-to-video needs a first frame".into());
    }
    let mut g = json!({
        "1":{"class_type":"UNETLoader","inputs":{"unet_name":i["model"],"weight_dtype":"default"}},
        "1L":{"class_type":"UNETLoader","inputs":{"unet_name":w["lowModel"],"weight_dtype":"default"}},
        "C":{"class_type":"CLIPLoader","inputs":{"clip_name":i["textEncoder"],"type":"wan"}},
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
    combine(&mut g, json!(["6", 0]), None, i["frameRate"].clone(), i);
    Ok(g)
}

fn h3(i: &Value) -> Value {
    let h = &i["h3"];
    let items: Vec<Value> = h["references"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(n, r)| json!({"id":format!("ref{}",r["slot"]),"type":"image","value":r["image"],"slot":r["slot"],"order":n,"enabled":true}))
        .collect();
    // Director continuity contract (v3): an empty source_id is a new take; parse_settings fills the rest.
    let c = &h["continuity"];
    let continuity = if c["sourceId"].as_str().is_some_and(|s| !s.is_empty()) {
        json!({"version":3,"session":c["session"],"source_kind":"checkpoint","source_id":c["sourceId"],"capture":c["capture"],"output_mode":c["outputMode"],"continuation_prompt":c["action"]})
    } else {
        json!({"version":3,"session":c.get("session").cloned().unwrap_or(json!("deas")),"capture":c.get("capture").cloned().unwrap_or(json!(false)),"output_mode":c.get("outputMode").cloned().unwrap_or(json!("full"))})
    };
    // DEAS already chose the canvas; the Director only fills/crops the references to it.
    let timeline = json!({"version":1,"items":items,"prompt_blocks":[],"resolution":{"input_scaling":"Fill and crop"},"continuity":continuity});
    let mut g = json!({
        "1":{"class_type":"UNETLoader","inputs":{"unet_name":i["model"],"weight_dtype":"default"}},
        "C":{"class_type":"CLIPLoader","inputs":{"clip_name":i["textEncoder"],"type":"minimax"}},
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
    // Director rounds duration·24 up to the 17k+5 grid, which `frames` already satisfies; in continuity it means new seconds.
    g["D"] = json!({"class_type":"MiniMaxH3Director","inputs":{"mode":h["mode"],"prompt":i["positivePrompt"],"width":i["width"],"height":i["height"],
        "duration":i["frames"].as_f64().unwrap() / 24.0,"ref_image_size":"match","timeline_data":timeline.to_string(),"builder_state":"","frame_rate":i["frameRate"],"fl2va_model":model}});
    g["G"] = json!({"class_type":"MiniMaxH3DirectorGuide","inputs":{"clip":["C",0],"vae":["V",0],"guide":["D",0],"audio_vae":["AV",0]}});
    g["SS"] = json!({"class_type":"MiniMaxH3SigmaShift","inputs":{"model":["D",5],"shift_video":h["shiftVideo"],"shift_audio":h["shiftAudio"]}});
    g["Z"] = json!({"class_type":"BasicScheduler","inputs":{"model":["SS",0],"scheduler":i["scheduler"],"steps":i["steps"],"denoise":1.0}});
    g["B"] = json!({"class_type":"BasicGuider","inputs":{"model":["SS",0],"conditioning":["G",0]}});
    g["5"] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":["B",0],"sampler":["Q",0],"sigmas":["Z",0],"latent_image":["G",1]}});
    // Segment Prepare/Decode serve both Director output modes and are plain decode without capture.
    g["SP"] = json!({"class_type":"DaSiWaH3ContinuitySegmentPrepare","inputs":{"sampled":["5",0],"context":["G",2]}});
    g["SD"] = json!({"class_type":"DaSiWaH3ContinuitySegmentDecode","inputs":{"latent":["SP",0],"vae":["V",0],"audio_vae":["AV",0],"context":["SP",1]}});
    combine(
        &mut g,
        json!(["SD", 0]),
        Some(json!(["SD", 1])),
        json!(["D", 8]),
        i,
    );
    g["P"] = json!({"class_type":"DaSiWaH3ContinuityPublish","inputs":{"filename":["7",1],"ticket":["SP",2]}});
    g
}

fn strs<'a>(v: &[&'a Value]) -> Vec<&'a str> {
    v.iter().filter_map(|x| x.as_str()).collect()
}

/// Model/encoder/VAE/image/upscaler names prepare() must find in object_info, per allowlist field.
pub(crate) fn requirements(i: &Value) -> Vec<(&'static str, Vec<&str>)> {
    let family = i["family"].as_str().unwrap_or_default();
    let b = &i[block(family)];
    vec![
        ("diffusionModels", strs(&[&i["model"], &b["lowModel"]])),
        (
            "textEncoders",
            strs(&[&i["textEncoder"], &b["textProjection"]]),
        ),
        ("vaes", strs(&[&i["vae"], &b["audioVae"]])),
        (
            "clipTypes",
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
                .filter(|s| !s.ends_with(" [output]"))
                .collect(),
        ),
        ("latentUpscaleModels", strs(&[&b["spatialUpscaler"]])),
    ]
}

#[cfg(test)]
#[path = "jobs_video_tests.rs"]
pub(crate) mod tests;
