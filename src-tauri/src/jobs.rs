//! Native-owned classic diagnostic execution; never accepts a frontend graph.
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

#[path = "jobs_outputs.rs"]
mod job_outputs;
pub(crate) use job_outputs::validate_envelope as validate_png_envelope;
pub use job_outputs::{native_job_export, native_job_output, OutputPreview};

const RESPONSE_LIMIT: usize = 1024 * 1024;
/// MiniMax H3 image edit (the Director's "Image Inpaint" mode, built from the native node it calls).
pub(crate) const H3_EDIT_NODES: [&str; 7] = [
    "MiniMaxH3ImageToVideo",
    "MiniMaxH3SigmaShift",
    "BasicScheduler",
    "BasicGuider",
    "SamplerCustomAdvanced",
    "LTXVSeparateAVLatent",
    "ImageFromBatch",
];
const REQUIRED_NODES: [&str; 6] = [
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
];

#[derive(Default)]
pub struct Jobs(Mutex<Session>, tokio::sync::Mutex<()>);

#[derive(Default)]
struct Session {
    preparing: Option<String>,
    plan: Option<Plan>,
    job: Option<Job>,
    output: Option<std::sync::Arc<job_outputs::CachedOutput>>,
    completed: std::collections::VecDeque<job_outputs::CompletedOutputs>,
}

#[derive(Clone)]
struct Plan {
    id: String,
    base: reqwest::Url,
    intent: Value,
    graph: Value,
    consumed: bool,
    media_root: Option<job_outputs::MediaRoot>,
}

impl Plan {
    fn snapshot(&self) -> Value {
        json!({"id":self.id,"baseUrl":self.base.as_str(),"intent":self.intent,"graph":self.graph,"generationReady":false})
    }
}

#[derive(Clone)]
struct Job {
    id: String,
    plan: Plan,
    client_id: String,
    prompt_id: Option<String>,
    state: &'static str,
    outputs: Vec<Value>,
    error: Option<String>,
    submitting: bool,
    polling: bool,
    metadata: Option<Value>,
    live: Arc<Mutex<Live>>,
}

/// Display-only sampler progress and latest preview pushed over the job's own websocket.
#[derive(Default)]
struct Live {
    value: u64,
    max: u64,
    preview: Option<String>,
}

impl Job {
    fn terminal(&self) -> bool {
        matches!(self.state, "succeeded" | "failed")
    }
    fn snapshot(&self) -> Value {
        let mut value = json!({"id":self.id,"baseUrl":self.plan.base.as_str(),"promptId":self.prompt_id,"state":self.state,"outputs":self.outputs,"error":self.error,"generationReady":false,"intent":self.plan.intent,"metadata":self.metadata,"appVersion":env!("CARGO_PKG_VERSION")});
        if matches!(self.state, "queued" | "running") {
            if let Ok(live) = self.live.lock() {
                if live.max > 0 {
                    value["progress"] = json!({"value":live.value,"max":live.max});
                }
                if let Some(preview) = &live.preview {
                    value["preview"] = json!(preview);
                }
            }
        }
        value
    }
    fn unknown(&mut self, error: String) {
        self.state = "unknown";
        self.outputs.clear();
        self.error = Some(bounded(&error));
    }
}

fn bounded(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(800).collect()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
        .map_err(|_| "Could not create diagnostic HTTP client".into())
}

async fn request(
    client: &reqwest::Client,
    base: &reqwest::Url,
    path: &str,
    body: Option<Value>,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = base.join(path).map_err(|_| "Invalid native job endpoint")?;
    let request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    // Do not echo URLs/transport internals into the frontend.
    let mut response = request
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "Native job request failed; execution may be unknown")?;
    let status = response.status();
    if status.is_redirection() {
        return Err(format!(
            "Native job endpoint returned HTTP {status}; redirects forbidden"
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err("Native job response size limit exceeded".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Native job response interrupted")?
    {
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err("Native job response size limit exceeded".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Native job endpoint returned invalid JSON (HTTP {status})"))?;
    Ok((status, value))
}

async fn get(client: &reqwest::Client, base: &reqwest::Url, path: &str) -> Result<Value, String> {
    let (status, value) = request(client, base, path, None).await?;
    if !status.is_success() {
        return Err(format!("Native job endpoint returned HTTP {status}"));
    }
    Ok(value)
}

fn compile(i: &Value) -> Result<Value, String> {
    if crate::jobs_video::is_video(i) {
        return crate::jobs_video::compile(i);
    }
    const FIELDS: [&str; 13] = [
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
    let fields = &FIELDS;
    let object = i.as_object().ok_or("Expected a diagnostic intent object")?;
    // An absent or empty LoRA list compiles the plain graph.
    let loras = object
        .get("loras")
        .map(|v| v.as_array().ok_or("Invalid loras"))
        .transpose()?;
    // `inputImage` + `denoise` switch the recipe to image-to-image (LoadImage → VAEEncode instead of an empty latent).
    let image = object.get("inputImage");
    let resize = object.get("inputResize");
    if image.is_some() != object.contains_key("denoise") {
        return Err("inputImage and denoise must be given together".into());
    }
    // `inputMask` (inpaint) is a mask this app uploaded via `native_mask_upload`, painted at the source's own size.
    let mask = object.get("inputMask");
    if mask
        .is_some_and(|m| image.is_none() || resize.is_some() || !m.as_str().is_some_and(mask_name))
    {
        return Err("Invalid inputMask: an uploaded mask for an unresized inputImage".into());
    }
    let blur = object.get("maskBlur");
    if blur.is_some_and(|b| {
        mask.is_none()
            || b.as_u64().is_none_or(|n| {
                n > 31
                    || n >= i["width"]
                        .as_u64()
                        .unwrap_or(0)
                        .min(i["height"].as_u64().unwrap_or(0))
            })
    }) {
        return Err(
            "Invalid maskBlur: integer 0..31 smaller than source edges, with inputMask".into(),
        );
    }
    let crop = object.get("inpaintCrop");
    if crop.is_some_and(|c| {
        mask.is_none()
            || c.as_object().is_none_or(|o| o.len() != 6)
            || ["x", "y", "width", "height", "targetWidth", "targetHeight"]
                .iter()
                .any(|k| {
                    c[*k]
                        .as_u64()
                        .is_none_or(|n| n > 8192 || (n == 0 && !["x", "y"].contains(k)))
                })
            || c["x"].as_u64().unwrap_or(8193) + c["width"].as_u64().unwrap_or(8193)
                > i["width"].as_u64().unwrap_or(0)
            || c["y"].as_u64().unwrap_or(8193) + c["height"].as_u64().unwrap_or(8193)
                > i["height"].as_u64().unwrap_or(0)
            || ["targetWidth", "targetHeight"]
                .iter()
                .any(|k| c[*k].as_u64().is_none_or(|n| n < 64 || n % 8 != 0))
            || c["targetWidth"].as_u64().unwrap_or(8193)
                * c["targetHeight"].as_u64().unwrap_or(8193)
                > 16_777_216
    }) {
        return Err("Invalid inpaintCrop: bounded source rectangle and model-aligned target dimensions with inputMask".into());
    }
    // `inputLayers` paste up to 4 extra images (input or `[output]` files) onto the source, in source pixels, before encoding.
    let layers = object.get("inputLayers");
    if layers.is_some_and(|l| {
        image.is_none()
            || l.as_array().is_none_or(|a| {
                a.is_empty()
                    || a.len() > 4
                    || a.iter().any(|layer| {
                        layer.as_object().is_none_or(|o| o.len() != 5)
                            || !layer["image"].as_str().is_some_and(model_name)
                            || ["x", "y", "width", "height"].iter().any(|k| {
                                !layer[*k]
                                    .as_u64()
                                    .is_some_and(|n| n <= 8192 && (n > 0 || ["x", "y"].contains(k)))
                            })
                    })
            })
    }) {
        return Err(
            "Invalid inputLayers: 1-4 {image, x, y, width, height} on an inputImage".into(),
        );
    }
    // `diffusion` loads `checkpoint` as a diffusion model with a separate text encoder and VAE.
    let diffusion = object.get("diffusion");
    if diffusion.is_some_and(|d| {
        d.as_object().is_none_or(|o| o.len() != 3)
            || !["textEncoder", "vae"]
                .iter()
                .all(|k| d[*k].as_str().is_some_and(model_name))
            || !d["clipType"].as_str().is_some_and(safe_choice)
    }) {
        return Err("Invalid diffusion: expected {textEncoder, clipType, vae}".into());
    }
    // `h3Edit` (MiniMax H3 sigma shifts) marks the H3 image edit; it belongs exactly to the `minimax` text encoder.
    let h3 = object.get("h3Edit");
    let h3_family = diffusion.is_some_and(|d| d["clipType"] == "minimax");
    if h3_family != h3.is_some()
        || h3.is_some_and(|h| {
            h.as_object().is_none_or(|o| o.len() != 2)
                || !["shiftVideo", "shiftAudio"].iter().all(|k| {
                    h[*k]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && (0.01..=100.0).contains(&n))
                })
        })
    {
        return Err(
            "Invalid h3Edit: {shiftVideo, shiftAudio} exactly for the MiniMax H3 encoder".into(),
        );
    }
    if h3.is_some()
        && (image.is_none() || object.contains_key("sigmas") || object.contains_key("refine"))
    {
        return Err(
            "MiniMax H3 edits an inputImage; custom sigmas and the refine pass are not supported"
                .into(),
        );
    }
    // Workbench Options: model patches and tiled VAE; absent or empty compiles the plain graph.
    let options = object.get("options");
    let wildcard = object.get("wildcard");
    if let Some(rules) = wildcard {
        crate::wildcard::validate(rules)?;
    }
    if options.is_some_and(|o| !valid_options(o)) {
        return Err("Invalid options".into());
    }
    // `sigmas` is a model-fixed schedule (steps + 1 values, descending to 0): ManualSigmas → SamplerCustomAdvanced replaces KSampler.
    let sigmas = object.get("sigmas");
    if sigmas.is_some_and(|s| !valid_sigmas(s, i["steps"].as_f64())) {
        return Err(
            "Invalid sigmas: expected steps + 1 finite values, strictly descending, ending at 0"
                .into(),
        );
    }
    let upscale = object.get("upscaleModel");
    if upscale.is_some_and(|u| resize.is_none() || !u.as_str().is_some_and(model_name)) {
        return Err("Invalid upscaleModel: a listed upscale model with inputResize".into());
    }
    // `refine` is a second pass after the first decode (SwarmUI refiner/upscale).
    let refine = object.get("refine");
    if refine.is_some_and(|r| !valid_refine(r, sigmas.is_some())) {
        return Err("Invalid refine: aligned size, denoise in (0, 1], optional listed upscale model, sigmas exactly with the first pass, tiled {tileWidth, tileHeight, overlap} aligned to 8 with overlap below the tile".into());
    }
    // Options → Output: DaSiWa saver format/compression (used only when that saver is present).
    let format = object.get("imageFormat");
    let compression = object.get("imageCompression");
    if format.is_some_and(|f| !f.as_str().is_some_and(|f| ["png", "webp"].contains(&f)))
        || compression.is_some_and(|c| !c.as_u64().is_some_and(|c| c <= 100))
    {
        return Err("Invalid imageFormat (png|webp) or imageCompression (0..=100)".into());
    }
    if object.len()
        != fields.len()
            + usize::from(upscale.is_some())
            + usize::from(refine.is_some())
            + usize::from(format.is_some())
            + usize::from(compression.is_some())
            + usize::from(options.is_some())
            + usize::from(wildcard.is_some())
            + usize::from(loras.is_some())
            + 2 * usize::from(image.is_some())
            + usize::from(diffusion.is_some())
            + usize::from(h3.is_some())
            + usize::from(resize.is_some())
            + usize::from(sigmas.is_some())
            + usize::from(mask.is_some())
            + usize::from(blur.is_some())
            + usize::from(crop.is_some())
            + usize::from(layers.is_some())
        || fields.iter().any(|key| !object.contains_key(*key))
    {
        return Err("Missing or unknown diagnostic intent fields".into());
    }
    if i["recipeId"] != "checkpoint-text-to-image-diagnostic" || i["version"].as_f64() != Some(1.0)
    {
        return Err("Unsupported diagnostic recipe or version".into());
    }
    for field in ["positivePrompt", "negativePrompt"] {
        if !i[field]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 16384 && !s.contains('\0'))
        {
            return Err(format!(
                "Invalid {field}: maximum 16384 UTF-16 units, no NUL"
            ));
        }
    }
    if !i["checkpoint"].as_str().is_some_and(model_name) {
        return Err("Unsafe checkpoint identifier".into());
    }
    if let Some(image) = image {
        if !image.as_str().is_some_and(model_name) {
            return Err("Unsafe input image identifier".into());
        }
        if !i["denoise"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
        {
            return Err("Invalid denoise: expected 0..=1".into());
        }
    }
    let loras = loras.map(Vec::as_slice).unwrap_or_default();
    if loras.len() > 8
        || loras.iter().any(|l| {
            l.as_object().is_none_or(|o| o.len() != 2)
                || !l["name"].as_str().is_some_and(model_name)
                || !l["strength"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (-10.0..=10.0).contains(&n))
        })
    {
        return Err("Invalid loras: at most 8 of {name, strength in [-10, 10]}".into());
    }
    for (field, min, max, integer, alignment) in [
        ("seed", 0.0, 9_007_199_254_740_991.0, true, 1.0),
        ("width", 64.0, 8192.0, true, 8.0),
        ("height", 64.0, 8192.0, true, 8.0),
        ("steps", 1.0, 150.0, true, 1.0),
        ("cfg", 0.0, 30.0, false, 1.0),
    ] {
        if !i[field].as_f64().is_some_and(|n| {
            n.is_finite() && n >= min && n <= max && (!integer || n % alignment == 0.0)
        }) {
            return Err(format!("Invalid diagnostic {field}"));
        }
    }
    if i["width"].as_f64().unwrap() * i["height"].as_f64().unwrap() > 16_777_216.0 {
        return Err("Diagnostic pixel limit exceeded".into());
    }
    if let Some(r) = resize {
        let aligned = |v: &Value, min: f64| {
            v.as_f64()
                .is_some_and(|n| n.is_finite() && n >= min && n <= 8192.0 && n % 8.0 == 0.0)
        };
        if image.is_none()
            || r.as_object().is_none_or(|o| {
                !(3..=4).contains(&o.len())
                    || o.keys()
                        .any(|k| !["width", "height", "crop", "pad"].contains(&k.as_str()))
            })
            || !aligned(&r["width"], 8.0)
            || !aligned(&r["height"], 8.0)
            || !r["crop"]
                .as_str()
                .is_some_and(|c| ["disabled", "center"].contains(&c))
        {
            return Err("Invalid inputResize: requires image, aligned dimensions and crop".into());
        }
        let pad = r.get("pad");
        if pad.is_some_and(|p| {
            p.as_object().is_none_or(|o| o.len() != 4)
                || !["left", "right", "top", "bottom"]
                    .iter()
                    .all(|k| aligned(&p[*k], 0.0))
        }) {
            return Err("Invalid inputResize padding".into());
        }
        let padding = |key: &str| pad.map_or(0.0, |p| p[key].as_f64().unwrap());
        if r["width"].as_f64().unwrap() + padding("left") + padding("right")
            != i["width"].as_f64().unwrap()
            || r["height"].as_f64().unwrap() + padding("top") + padding("bottom")
                != i["height"].as_f64().unwrap()
        {
            return Err("inputResize plus padding must match output dimensions".into());
        }
    }
    // Any sampler/scheduler the backend lists is allowed; preparation checks them against object_info.
    if !["sampler", "scheduler"]
        .iter()
        .all(|f| i[*f].as_str().is_some_and(safe_choice))
    {
        return Err("Unsafe sampler or scheduler".into());
    }
    if !i["outputPrefix"].as_str().is_some_and(safe_output_prefix) {
        return Err("Unsafe output prefix".into());
    }
    let mut graph = json!({
        "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":i["checkpoint"]}},
        "2":{"class_type":"CLIPTextEncode","inputs":{"text":i["positivePrompt"],"clip":["1",1]}},
        "3":{"class_type":"CLIPTextEncode","inputs":{"text":i["negativePrompt"],"clip":["1",1]}},
        "4":{"class_type":"EmptyLatentImage","inputs":{"width":i["width"],"height":i["height"],"batch_size":1}},
        "5":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0],"seed":i["seed"],"steps":i["steps"],"cfg":i["cfg"],"sampler_name":i["sampler"],"scheduler":i["scheduler"],"denoise":1}},
        "6":{"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
        "7":{"class_type":"SaveImage","inputs":{"images":["6",0],"filename_prefix":i["outputPrefix"]}}
    });
    let (mut model, mut clip, mut vae) = (json!(["1", 0]), json!(["1", 1]), json!(["1", 2]));
    if let Some(rules) = wildcard {
        let mut inputs = rules.clone();
        inputs["selection_state"] = json!(rules["selection_state"].to_string());
        inputs["positive_input"] = i["positivePrompt"].clone();
        inputs["negative_input"] = i["negativePrompt"].clone();
        graph["WP"] = json!({"class_type":crate::wildcard::NODE,"inputs":inputs});
        graph["2"]["inputs"]["text"] = json!(["WP", 0]);
        graph["3"]["inputs"]["text"] = json!(["WP", 1]);
    }
    if let Some(d) = diffusion {
        graph["1"] = json!({"class_type":"UNETLoader","inputs":{"unet_name":i["checkpoint"],"weight_dtype":"default"}});
        graph["C"] = json!({"class_type":"CLIPLoader","inputs":{"clip_name":d["textEncoder"],"type":d["clipType"]}});
        graph["V"] = json!({"class_type":"VAELoader","inputs":{"vae_name":d["vae"]}});
        (clip, vae) = (json!(["C", 0]), json!(["V", 0]));
    }
    // Chain LoraLoaders after the loaders; the last one feeds the sampler and both encoders.
    for (n, lora) in loras.iter().enumerate() {
        let id = format!("L{}", n + 1);
        graph[&id] = json!({"class_type":"LoraLoader","inputs":{"model":model,"clip":clip,"lora_name":lora["name"],"strength_model":lora["strength"],"strength_clip":lora["strength"]}});
        (model, clip) = (json!([id, 0]), json!([id, 1]));
    }
    let o = options.cloned().unwrap_or_default();
    // Patches chain after the LoRAs; compile last so it sees every other patch.
    let mut patch = |id: &str, node: &str, mut inputs: Value| {
        inputs["model"] = model.clone();
        graph[id] = json!({"class_type":node,"inputs":inputs});
        model = json!([id, 0]);
    };
    if let Some(a) = o["attention"].as_str() {
        patch("A", "ModelAttentionBackend", json!({"attention":a}));
    }
    if let Some(s) = o["sage"].as_str() {
        patch("K", "PathchSageAttentionKJ", json!({"sage_attention":s}));
    }
    if let Some(c) = o.get("cache") {
        // start/end are the nodes' own defaults.
        patch(
            "E",
            c["node"].as_str().unwrap(),
            json!({"reuse_threshold":c["threshold"],"start_percent":0.15,"end_percent":0.95,"verbose":false}),
        );
    }
    if let Some(b) = o["compile"].as_str() {
        patch("T", "TorchCompileModel", json!({"backend":b}));
    }
    graph["2"]["inputs"]["clip"] = clip.clone();
    graph["3"]["inputs"]["clip"] = clip;
    graph["5"]["inputs"]["model"] = model;
    graph["6"]["inputs"]["vae"] = vae.clone();
    if let Some(s) = sigmas {
        // f64 Display matches JS number formatting, so both compilers emit the same string.
        let list = s
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_f64)
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        graph["N"] = json!({"class_type":"RandomNoise","inputs":{"noise_seed":i["seed"]}});
        graph["G"] = json!({"class_type":"CFGGuider","inputs":{"model":graph["5"]["inputs"]["model"],"positive":["2",0],"negative":["3",0],"cfg":i["cfg"]}});
        graph["Q"] = json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":i["sampler"]}});
        graph["Z"] = json!({"class_type":"ManualSigmas","inputs":{"sigmas":list}});
        graph["5"] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":["G",0],"sampler":["Q",0],"sigmas":["Z",0],"latent_image":["4",0]}});
    }
    if let Some(image) = image {
        graph["8"] = json!({"class_type":"LoadImage","inputs":{"image":image}});
        // Layers are pasted in source pixels, so they come before any resize and stay under an inpaint composite.
        // shortcut: pasted opaque (alpha ignored); feed LoadImage's inverted mask when cut-outs matter.
        let mut base = json!(["8", 0]);
        for (n, layer) in layers
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let (load, scale, paste) = (format!("I{n}"), format!("R{n}"), format!("B{n}"));
            graph[&load] = json!({"class_type":"LoadImage","inputs":{"image":layer["image"]}});
            graph[&scale] = json!({"class_type":"ImageScale","inputs":{"image":[load,0],"upscale_method":"lanczos","width":layer["width"],"height":layer["height"],"crop":"disabled"}});
            graph[&paste] = json!({"class_type":"ImageCompositeMasked","inputs":{"destination":base,"source":[scale,0],"x":layer["x"],"y":layer["y"],"resize_source":false}});
            base = json!([paste, 0]);
        }
        graph["9"] = json!({"class_type":"VAEEncode","inputs":{"pixels":base,"vae":vae}});
        if let Some(r) = resize {
            let mut scaled = base.clone();
            if let Some(u) = upscale {
                graph["UL"] = json!({"class_type":"UpscaleModelLoader","inputs":{"model_name":u}});
                graph["UM"] = json!({"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["UL",0],"image":base}});
                scaled = json!(["UM", 0]);
            }
            graph["S"] = json!({"class_type":"ImageScale","inputs":{"image":scaled,"upscale_method":"lanczos","width":r["width"],"height":r["height"],"crop":r["crop"]}});
            if let Some(p) = r.get("pad") {
                graph["P"] = json!({"class_type":"ImagePadForOutpaint","inputs":{"image":["S",0],"left":p["left"],"right":p["right"],"top":p["top"],"bottom":p["bottom"],"feathering":0}});
            }
            graph["9"]["inputs"]["pixels"] =
                json!([if r.get("pad").is_some() { "P" } else { "S" }, 0]);
        }
        graph["5"]["inputs"]["latent_image"] = json!(["9", 0]);
        if let Some(m) = mask {
            // Only the painted area is resampled, then composited onto the untouched source pixels.
            graph["W"] = json!({"class_type":"LoadImageMask","inputs":{"image":m,"channel":"red"}});
            let mut mask_link = json!(["W", 0]);
            if blur.and_then(Value::as_u64).unwrap_or(0) > 0 {
                graph["MI"] = json!({"class_type":"MaskToImage","inputs":{"mask":mask_link}});
                graph["MB"] = json!({"class_type":"ImageBlur","inputs":{"image":["MI",0],"blur_radius":i["maskBlur"],"sigma":1}});
                graph["BM"] =
                    json!({"class_type":"ImageToMask","inputs":{"image":["MB",0],"channel":"red"}});
                mask_link = json!(["BM", 0]);
            }
            let mut noise_mask = mask_link.clone();
            let mut decoded = json!(["6", 0]);
            if let Some(c) = crop {
                graph["IC"] = json!({"class_type":"ImageCrop","inputs":{"image":base,"x":c["x"],"y":c["y"],"width":c["width"],"height":c["height"]}});
                graph["IS"] = json!({"class_type":"ImageScale","inputs":{"image":["IC",0],"upscale_method":"lanczos","width":c["targetWidth"],"height":c["targetHeight"],"crop":"disabled"}});
                graph["9"]["inputs"]["pixels"] = json!(["IS", 0]);
                graph["MC"] = json!({"class_type":"CropMask","inputs":{"mask":mask_link,"x":c["x"],"y":c["y"],"width":c["width"],"height":c["height"]}});
                graph["CI"] = json!({"class_type":"MaskToImage","inputs":{"mask":["MC",0]}});
                graph["MS"] = json!({"class_type":"ImageScale","inputs":{"image":["CI",0],"upscale_method":"bilinear","width":c["targetWidth"],"height":c["targetHeight"],"crop":"disabled"}});
                graph["NM"] =
                    json!({"class_type":"ImageToMask","inputs":{"image":["MS",0],"channel":"red"}});
                graph["IR"] = json!({"class_type":"ImageScale","inputs":{"image":["6",0],"upscale_method":"lanczos","width":c["width"],"height":c["height"],"crop":"disabled"}});
                noise_mask = json!(["NM", 0]);
                mask_link = json!(["MC", 0]);
                decoded = json!(["IR", 0]);
            }
            graph["X"] = json!({"class_type":"SetLatentNoiseMask","inputs":{"samples":["9",0],"mask":noise_mask}});
            graph["Y"] = json!({"class_type":"ImageCompositeMasked","inputs":{"destination":base,"source":decoded,"x":crop.map_or(json!(0),|c|c["x"].clone()),"y":crop.map_or(json!(0),|c|c["y"].clone()),"resize_source":false,"mask":mask_link}});
            graph["5"]["inputs"]["latent_image"] = json!(["X", 0]);
            graph["7"]["inputs"]["images"] = json!(["Y", 0]);
        }
        if sigmas.is_none() {
            graph["5"]["inputs"]["denoise"] = i["denoise"].clone();
        }
        graph.as_object_mut().unwrap().remove("4");
    }
    if let Some(r) = refine {
        let mut image = graph["7"]["inputs"]["images"].clone();
        if let Some(u) = r.get("upscaleModel") {
            graph["RL"] = json!({"class_type":"UpscaleModelLoader","inputs":{"model_name":u}});
            graph["RU"] = json!({"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["RL",0],"image":image}});
            image = json!(["RU", 0]);
        }
        // The first pass always ends at width×height; a same-size lanczos pass would only resample.
        if r.get("upscaleModel").is_some() || r["width"] != i["width"] || r["height"] != i["height"]
        {
            graph["RS"] = json!({"class_type":"ImageScale","inputs":{"image":image,"upscale_method":"lanczos","width":r["width"],"height":r["height"],"crop":"disabled"}});
            image = json!(["RS", 0]);
        }
        graph["RE"] = json!({"class_type":"VAEEncode","inputs":{"pixels":image,"vae":vae}});
        // Tiled: the refine sampler gets the model through the tiling patch (its own guider on the sigmas path); the first pass keeps the plain model.
        let mut guider = json!(["G", 0]);
        let mut model = if r.get("sigmas").is_some() {
            graph["G"]["inputs"]["model"].clone()
        } else {
            graph["5"]["inputs"]["model"].clone()
        };
        if let Some(t) = r.get("tiled") {
            graph["RT"] = json!({"class_type":"DaSiWaTiledDiffusion","inputs":{"model":model,"tile_width":t["tileWidth"],"tile_height":t["tileHeight"],"overlap":t["overlap"]}});
            model = json!(["RT", 0]);
            if r.get("sigmas").is_some() {
                graph["RG"] = graph["G"].clone();
                graph["RG"]["inputs"]["model"] = model.clone();
                guider = json!(["RG", 0]);
            }
        }
        if let Some(s) = r.get("sigmas") {
            let list = s
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_f64)
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            graph["RZ"] = json!({"class_type":"ManualSigmas","inputs":{"sigmas":list}});
            graph["R5"] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":guider,"sampler":["Q",0],"sigmas":["RZ",0],"latent_image":["RE",0]}});
        } else {
            graph["R5"] = graph["5"].clone();
            graph["R5"]["inputs"]["model"] = model;
            graph["R5"]["inputs"]["latent_image"] = json!(["RE", 0]);
            graph["R5"]["inputs"]["denoise"] = r["denoise"].clone();
        }
        graph["R6"] = json!({"class_type":"VAEDecode","inputs":{"samples":["R5",0],"vae":vae}});
        graph["7"]["inputs"]["images"] = json!(["R6", 0]);
    }
    if let Some(h) = h3 {
        h3_edit(&mut graph, i, h)?;
    }
    if let Some(tile) = o.get("vaeTile") {
        // Spatial tiles; the temporal values are the node defaults (used by video VAEs only).
        let tiles = json!({"tile_size":tile,"overlap":64,"temporal_size":64,"temporal_overlap":8});
        for (id, node) in [
            ("6", "VAEDecodeTiled"),
            ("9", "VAEEncodeTiled"),
            ("R6", "VAEDecodeTiled"),
            ("RE", "VAEEncodeTiled"),
        ] {
            if let Some(n) = graph.get_mut(id) {
                n["class_type"] = json!(node);
                n["inputs"]
                    .as_object_mut()
                    .unwrap()
                    .extend(tiles.as_object().unwrap().clone());
            }
        }
    }
    Ok(graph)
}

/// MiniMax H3 has no image latent: like the DaSiWa Director's "Image Inpaint" mode, the picture that would be
/// encoded becomes the first frame of a native 5-frame pass (prompt encoded by `MiniMaxH3ImageToVideo`, no negative),
/// sampled with the H3 sigma shift, and frame 0 of the decode replaces the image decode. Mask, crop, layers and
/// the composite stay as built, so only the painted area changes.
fn h3_edit(graph: &mut Value, i: &Value, h: &Value) -> Result<(), String> {
    let pixels = graph["9"]["inputs"]["pixels"].clone();
    let c = &i["inpaintCrop"];
    let (w, hgt) = if c.is_object() {
        (c["targetWidth"].clone(), c["targetHeight"].clone())
    } else {
        (i["width"].clone(), i["height"].clone())
    };
    if [&w, &hgt]
        .iter()
        .any(|n| n.as_u64().is_none_or(|n| n % 32 != 0))
    {
        return Err("MiniMax H3 edits need a canvas on its 32 px grid".into());
    }
    let model = graph["5"]["inputs"]["model"].clone();
    let clip = graph["2"]["inputs"]["clip"].clone();
    let vae = graph["6"]["inputs"]["vae"].clone();
    let text = graph["2"]["inputs"]["text"].clone();
    let g = graph.as_object_mut().unwrap();
    for id in ["2", "3", "9", "X"] {
        g.remove(id);
    }
    // The decode feeds every former consumer of node 6 (saver, crop rescale, composite) through frame 0.
    for node in g.values_mut() {
        for v in node["inputs"].as_object_mut().unwrap().values_mut() {
            if *v == json!(["6", 0]) {
                *v = json!(["F", 0]);
            }
        }
    }
    g.insert("HE".into(), json!({"class_type":"MiniMaxH3ImageToVideo","inputs":{"clip":clip,"vae":vae,"prompt":text,"width":w,"height":hgt,"length":5,"first_frame":pixels}}));
    g.insert("SS".into(), json!({"class_type":"MiniMaxH3SigmaShift","inputs":{"model":model,"shift_video":h["shiftVideo"],"shift_audio":h["shiftAudio"]}}));
    g.insert(
        "N".into(),
        json!({"class_type":"RandomNoise","inputs":{"noise_seed":i["seed"]}}),
    );
    g.insert(
        "Q".into(),
        json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":i["sampler"]}}),
    );
    g.insert("Z".into(), json!({"class_type":"BasicScheduler","inputs":{"model":["SS",0],"scheduler":i["scheduler"],"steps":i["steps"],"denoise":1.0}}));
    g.insert(
        "B".into(),
        json!({"class_type":"BasicGuider","inputs":{"model":["SS",0],"conditioning":["HE",0]}}),
    );
    g.insert("5".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["N",0],"guider":["B",0],"sampler":["Q",0],"sigmas":["Z",0],"latent_image":["HE",1]}}));
    g.insert(
        "SEP".into(),
        json!({"class_type":"LTXVSeparateAVLatent","inputs":{"av_latent":["5",0]}}),
    );
    g.get_mut("6").unwrap()["inputs"]["samples"] = json!(["SEP", 0]);
    g.insert("F".into(), json!({"class_type":"ImageFromBatch","inputs":{"image":["6",0],"batch_index":0,"length":1}}));
    Ok(())
}

fn valid_refine(r: &Value, first_sigmas: bool) -> bool {
    let edge = |k: &str| {
        r[k].as_u64()
            .is_some_and(|n| (64..=8192).contains(&n) && n % 8 == 0)
    };
    r.as_object().is_some_and(|o| {
        o.keys().all(|k| {
            [
                "width",
                "height",
                "denoise",
                "upscaleModel",
                "sigmas",
                "tiled",
            ]
            .contains(&k.as_str())
        }) && o.contains_key("sigmas") == first_sigmas
    }) && edge("width")
        && r.get("tiled").is_none_or(|t| {
            let px = |k: &str| {
                t[k].as_u64()
                    .filter(|n| (64..=8192).contains(n) && n % 8 == 0)
            };
            t.as_object().is_some_and(|o| o.len() == 3)
                && px("tileWidth")
                    .zip(px("tileHeight"))
                    .zip(t["overlap"].as_u64())
                    .is_some_and(|((w, h), ov)| ov % 8 == 0 && ov < w.min(h))
        })
        && edge("height")
        && r["width"].as_u64().unwrap() * r["height"].as_u64().unwrap() <= 16_777_216
        && r["denoise"].as_f64().is_some_and(|d| d > 0.0 && d <= 1.0)
        && r.get("upscaleModel")
            .is_none_or(|u| u.as_str().is_some_and(model_name))
        && r.get("sigmas").is_none_or(|s| valid_sigmas(s, None))
}

/// `steps` = `None` checks only the schedule shape (2–151 values).
fn valid_sigmas(s: &Value, steps: Option<f64>) -> bool {
    let Some(list) = s.as_array() else {
        return false;
    };
    let values: Vec<f64> = list.iter().filter_map(Value::as_f64).collect();
    values.len() == list.len()
        && (2..=151).contains(&list.len())
        && steps.is_none_or(|n| n == list.len() as f64 - 1.0)
        && values
            .iter()
            .all(|v| v.is_finite() && (0.0..=1000.0).contains(v))
        && values.windows(2).all(|w| w[0] > w[1])
        && values.last() == Some(&0.0)
}

/// Output prefix folders/stem: bounded, ASCII, no traversal, no Windows device names.
pub(crate) fn safe_output_prefix(s: &str) -> bool {
    s.len() <= 512
        && s.rsplit_once('/')
            .is_none_or(|(folder, _)| folder.len() <= 255)
        && s.split('/').all(|p| {
            let stem = p.split('.').next().unwrap_or("").to_ascii_lowercase();
            !p.is_empty()
                && p.len() <= 180
                && p != "."
                && p != ".."
                && !p.ends_with('.')
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                && !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                && !(stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && stem.as_bytes()[3].is_ascii_digit())
        })
}

pub(crate) fn valid_options(o: &Value) -> bool {
    let Some(map) = o.as_object() else {
        return false;
    };
    let choice = |k: &str| o.get(k).is_none_or(|v| v.as_str().is_some_and(safe_option));
    map.keys().all(|k| {
        ["attention", "sage", "cache", "compile", "vaeTile"].contains(&k.as_str())
    }) && choice("attention")
        && choice("sage")
        && choice("compile")
        // Two attention patches would silently override each other.
        && !(map.contains_key("attention") && map.contains_key("sage"))
        && o.get("cache").is_none_or(|c| {
            c.as_object().is_some_and(|m| m.len() == 2)
                && c["node"]
                    .as_str()
                    .is_some_and(|n| ["EasyCache", "LazyCache"].contains(&n))
                && c["threshold"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=3.0).contains(&n))
        })
        && o.get("vaeTile").is_none_or(|v| {
            v.as_u64()
                .is_some_and(|n| (256..=4096).contains(&n) && n % 64 == 0)
        })
}

/// Civitai links resources only by hash from an A1111 `parameters` chunk, which core
/// `SaveImage` cannot write; the DaSiWa saver (Output package) adds it beside `prompt`/`workflow`.
fn civitai_saver(graph: &mut Value, nodes: &Value, intent: &Value) {
    let has = |n: &str| nodes.as_array().is_some_and(|a| a.iter().any(|v| v == n));
    if !(has("DaSiWa_MetadataImageSaver") && has("DaSiWa_MetadataConfig")) {
        return;
    }
    graph["M"] = json!({"class_type":"DaSiWa_MetadataConfig","inputs":{"save_workflow":true,"model_hash":"","node_positive":["2",0],"node_negative":["3",0],"node_model":["1",0],"node_latent":["5",0]}});
    if graph.get("WP").is_some() {
        // Graph tracing cannot resolve random text; use this execution's actual strings.
        graph["M"]["inputs"]["text_positive"] = json!(["WP", 0]);
        graph["M"]["inputs"]["text_negative"] = json!(["WP", 1]);
    }
    // compression 44 = PNG level 4 (the saver maps 0–100 onto PNG levels / WebP quality).
    let format = intent.get("imageFormat").cloned().unwrap_or(json!("png"));
    let compression = intent.get("imageCompression").cloned().unwrap_or(json!(44));
    graph["7"] = json!({"class_type":"DaSiWa_MetadataImageSaver","inputs":{"images":graph["7"]["inputs"]["images"],"filename_prefix":graph["7"]["inputs"]["filename_prefix"],"file_format":format,"compression":compression,"save_output":true,"metadata_config":["M",0]}});
}

/// Model/input file identifier as ComfyUI lists it (relative to its folder): spaces and
/// non-ASCII letters are fine; traversal, absolute/host paths, URLs, `\` `:` `%`, control
/// characters and padded segments are not.
pub(crate) fn model_name(s: &str) -> bool {
    s.len() <= 255
        && s.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.trim() == segment
                && !segment
                    .chars()
                    .any(|c| c.is_control() || "\\:%".contains(c))
        })
}

const MASK_FOLDER: &str = "deas-masks";

/// Only names `native_mask_upload` hands out: `deas-masks/<uuid>.png` (inpaint masks and flattened painted layers).
fn mask_name(s: &str) -> bool {
    s.strip_prefix("deas-masks/")
        .and_then(|n| n.strip_suffix(".png"))
        .is_some_and(|id| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok())
}

/// Option-node enum choice as listed (`pytorch attention`, `sageattn_qk_int8_pv_fp8_cuda++`).
pub(crate) fn safe_option(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.trim() == s
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" _.+-".contains(&b))
}

/// Backend enum choice (sampler, scheduler, CLIP type): short safe ASCII, never a path.
pub(crate) fn safe_choice(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn safe_path(s: &str, empty: bool) -> bool {
    (empty && s.is_empty())
        || s.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
}

impl Jobs {
    fn current(&self) -> Result<Value, String> {
        Ok(self
            .lock()?
            .job
            .as_ref()
            .map(Job::snapshot)
            .unwrap_or(Value::Null))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Session>, String> {
        self.0
            .lock()
            .map_err(|_| "Native job state unavailable".into())
    }

    async fn prepare(&self, base_url: String, intent: Value) -> Result<Value, String> {
        let base = crate::validate_base_url(&base_url)?;
        let mut graph = compile(&intent)?;
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut session = self.lock()?;
            if session.job.as_ref().is_some_and(|j| !j.terminal()) {
                return Err("An in-flight or unknown native job must not be replaced".into());
            }
            session.plan = None;
            session.preparing = Some(id.clone());
        }
        let prerequisites =
            crate::recipe_prerequisites::native_recipe_prerequisites(base.to_string()).await?;
        let allow = &prerequisites["allowlist"];
        let diffusion = &intent["diffusion"];
        let split = diffusion.is_object();
        let video = crate::jobs_video::is_video(&intent);
        // Video recipes name their models/encoders/VAEs/images per family; image recipes below.
        let mut required: Vec<(&str, Vec<&str>)> = if video {
            crate::jobs_video::requirements(&intent)
        } else {
            vec![
                (
                    if split {
                        "diffusionModels"
                    } else {
                        "checkpoints"
                    },
                    vec![intent["checkpoint"].as_str().unwrap()],
                ),
                (
                    "textEncoders",
                    diffusion["textEncoder"].as_str().into_iter().collect(),
                ),
                (
                    "clipTypes",
                    diffusion["clipType"].as_str().into_iter().collect(),
                ),
                ("vaes", diffusion["vae"].as_str().into_iter().collect()),
                (
                    "images",
                    // object_info lists only the input folder; ComfyUI resolves an `[output]` file itself (containment + existence in LoadImage).
                    intent["inputImage"]
                        .as_str()
                        .into_iter()
                        .chain(
                            intent["inputLayers"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|l| l["image"].as_str()),
                        )
                        .filter(|s| !s.ends_with(" [output]") && !mask_name(s))
                        .collect(),
                ),
            ]
        };
        required.extend([
            (
                "nodes",
                REQUIRED_NODES
                    .iter()
                    .copied()
                    .filter(|_| !video)
                    .chain(
                        graph
                            .as_object()
                            .unwrap()
                            .values()
                            .filter_map(|n| n["class_type"].as_str())
                            .filter(|name| {
                                video
                                    || [
                                        "ImageScale",
                                        "ImageCrop",
                                        "CropMask",
                                        "MaskToImage",
                                        "ImageToMask",
                                        "ImageBlur",
                                        "ImagePadForOutpaint",
                                        "LoadImageMask",
                                        "SetLatentNoiseMask",
                                        "ImageCompositeMasked",
                                        "VAEEncode",
                                        "UpscaleModelLoader",
                                        "ImageUpscaleWithModel",
                                    ]
                                    .contains(name)
                                    || crate::recipe_prerequisites::SIGMA_NODES.contains(name)
                                    || H3_EDIT_NODES.contains(name)
                                    || crate::recipe_prerequisites::OPTION_NODES.contains(name)
                                    || *name == crate::wildcard::NODE
                            }),
                    )
                    .collect(),
            ),
            (
                "nodes",
                if split || video {
                    vec!["UNETLoader", "CLIPLoader", "VAELoader"]
                } else {
                    vec![]
                },
            ),
            (
                "nodes",
                if intent["inputImage"].is_string() {
                    vec!["LoadImage", "VAEEncode"]
                } else {
                    vec![]
                },
            ),
            (
                "loras",
                intent["loras"]
                    .as_array()
                    .map(|l| l.iter().filter_map(|x| x["name"].as_str()).collect())
                    .unwrap_or_default(),
            ),
            ("samplers", vec![intent["sampler"].as_str().unwrap()]),
            (
                "attention",
                intent["options"]["attention"]
                    .as_str()
                    .into_iter()
                    .collect(),
            ),
            (
                "sage",
                intent["options"]["sage"].as_str().into_iter().collect(),
            ),
            (
                "compile",
                intent["options"]["compile"].as_str().into_iter().collect(),
            ),
            ("schedulers", vec![intent["scheduler"].as_str().unwrap()]),
            (
                "upscaleModels",
                [&intent["upscaleModel"], &intent["refine"]["upscaleModel"]]
                    .into_iter()
                    .filter_map(Value::as_str)
                    .collect(),
            ),
        ]);
        for (field, required) in required {
            let available = allow[field]
                .as_array()
                .ok_or("Malformed native prerequisites")?;
            if let Some(missing) = required
                .iter()
                // LoadImage lists only top-level files; the backend loader/Director validates DEAS-uploaded references.
                .find(|name| {
                    !(field == "images" && name.starts_with("deas-inputs/"))
                        && !available.iter().any(|v| v.as_str() == Some(**name))
                })
            {
                return Err(format!(
                    "Diagnostic {field} are not available on this backend: {missing}"
                ));
            }
        }
        if !video {
            civitai_saver(&mut graph, &allow["nodes"], &intent);
        }
        let plan = Plan {
            id: id.clone(),
            base,
            intent,
            graph,
            consumed: false,
            media_root: None,
        };
        let mut session = self.lock()?;
        if session.preparing.as_deref() != Some(id.as_str()) {
            return Err("Diagnostic preparation was superseded".into());
        }
        session.preparing = None;
        let snapshot = plan.snapshot();
        session.plan = Some(plan);
        Ok(snapshot)
    }

    async fn submit(&self, plan_id: String, confirmed: bool) -> Result<Value, String> {
        if !confirmed {
            return Err("Explicit diagnostic submission confirmation is required".into());
        }
        let client = client()?;
        // Consume before the first await: a lost response must never authorize a retry.
        let mut job = {
            let mut session = self.lock()?;
            if session.job.as_ref().is_some_and(|j| !j.terminal()) {
                return Err("A native job is already in flight or unknown".into());
            }
            let plan = session
                .plan
                .as_mut()
                .filter(|p| p.id == plan_id)
                .ok_or("Unknown or stale native plan")?;
            if plan.consumed {
                return Err("This native plan was already submitted; retries are forbidden".into());
            }
            plan.consumed = true;
            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                plan: plan.clone(),
                client_id: uuid::Uuid::new_v4().to_string(),
                prompt_id: None,
                state: "unknown",
                outputs: vec![],
                error: Some("Submission in progress; do not retry".into()),
                submitting: true,
                polling: false,
                metadata: None,
                live: Arc::default(),
            };
            session.output = None;
            session.job = Some(job.clone());
            job
        };
        // Connect before POST so this client's progress/preview frames are not missed.
        watch(&job.plan.base, &job.client_id, job.live.clone()).await;
        let result = request(
            &client,
            &job.plan.base,
            "prompt",
            Some(json!({"prompt":job.plan.graph,"client_id":job.client_id,"extra_data":{"preview_method":"auto","extra_pnginfo":{"deas_output_naming":true}}})),
        )
        .await;
        match result {
            Ok((status, value)) => {
                let rejected = value.get("error").is_some_and(|e| !e.is_null())
                    || value["node_errors"]
                        .as_object()
                        .is_some_and(|e| !e.is_empty());
                if (status.is_success() || status == reqwest::StatusCode::BAD_REQUEST) && rejected {
                    job.state = "failed";
                    job.error = Some(bounded(&format!(
                        "Backend rejected diagnostic: error={}, node_errors={}",
                        value["error"], value["node_errors"]
                    )));
                } else if status.is_success()
                    && value["node_errors"]
                        .as_object()
                        .is_some_and(|e| e.is_empty())
                    && value["number"]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n >= 0.0)
                    && value["prompt_id"].as_str().is_some_and(canonical_uuid)
                {
                    job.prompt_id = value["prompt_id"].as_str().map(str::to_owned);
                    job.state = "queued";
                    job.error = None;
                } else {
                    job.unknown(format!(
                        "Unrecognized submission reply (HTTP {status}); do not retry"
                    ));
                }
            }
            Err(error) => job.unknown(error),
        }
        job.submitting = false;
        let result = job.snapshot();
        self.lock()?.job = Some(job);
        Ok(result)
    }

    async fn status(&self, job_id: String) -> Result<Value, String> {
        let mut job = {
            let mut session = self.lock()?;
            let job = session
                .job
                .as_mut()
                .filter(|j| j.id == job_id)
                .ok_or("Unknown native job")?;
            if job.terminal() || job.submitting || job.polling || job.prompt_id.is_none() {
                return Ok(job.snapshot());
            }
            job.polling = true;
            job.clone()
        };
        let result = tokio::time::timeout(Duration::from_secs(15), poll(&mut job)).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => job.unknown(error),
            Err(_) => job.unknown("Native job status deadline exceeded".into()),
        }
        job.polling = false;
        let mut session = self.lock()?;
        let current = session
            .job
            .as_mut()
            .filter(|j| j.id == job_id)
            .ok_or("Native job changed during status request")?;
        *current = job;
        let result = current.snapshot();
        session.retain_completed();
        Ok(result)
    }
}

fn canonical_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
}

/// Graph equality as ComfyUI stores it: its validator rewrites FLOAT inputs (`1` → `1.0`).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y || x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Decode one ComfyUI binary preview frame (`u32 event=1`, `u32 format`, image) into a data URL.
fn preview_frame(frame: &[u8]) -> Option<String> {
    use base64::Engine;
    let (head, image) = (frame.get(..8)?, &frame[8..]);
    let mime = match (&head[..4], &head[4..]) {
        ([0, 0, 0, 1], [0, 0, 0, 1]) if image.starts_with(&[0xFF, 0xD8, 0xFF]) => "jpeg",
        ([0, 0, 0, 1], [0, 0, 0, 2]) if image.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
        _ => return None,
    };
    Some(format!(
        "data:image/{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(image)
    ))
}

/// Best-effort live view over `/ws?clientId=`; failures only mean no preview.
// shortcut: plain ws only (no TLS feature), https endpoints get no live preview; add rustls if remote https backends matter.
async fn watch(base: &reqwest::Url, client_id: &str, live: Arc<Mutex<Live>>) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
    let Ok(mut url) = base.join("ws") else { return };
    if base.scheme() != "http" || url.set_scheme("ws").is_err() {
        return;
    }
    url.query_pairs_mut().append_pair("clientId", client_id);
    let config = WebSocketConfig::default().max_message_size(Some(RESPONSE_LIMIT * 16));
    let connect = tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false);
    let Ok(Ok((mut socket, _))) = tokio::time::timeout(Duration::from_secs(3), connect).await
    else {
        return;
    };
    tokio::spawn(async move {
        // execution_start is directed to this unique client, unlike broadcast interruptions.
        let mut prompt_id: Option<String> = None;
        // Ends with the job's own completion events, idle silence, or when the job is dropped.
        while Arc::strong_count(&live) > 1 {
            let Ok(Some(Ok(message))) =
                tokio::time::timeout(Duration::from_secs(600), socket.next()).await
            else {
                break;
            };
            match message {
                Message::Binary(frame) => {
                    if let Some(preview) = preview_frame(&frame) {
                        let Ok(mut live) = live.lock() else { break };
                        live.preview = Some(preview);
                    }
                }
                Message::Text(text) => {
                    let event: Value = serde_json::from_str(&text).unwrap_or_default();
                    match event["type"].as_str() {
                        Some("execution_start") if prompt_id.is_none() => {
                            prompt_id = event["data"]["prompt_id"]
                                .as_str()
                                .filter(|id| !id.is_empty())
                                .map(str::to_owned);
                        }
                        Some("progress")
                            if event["data"]["prompt_id"].is_null()
                                || (prompt_id.is_some()
                                    && event["data"]["prompt_id"].as_str()
                                        == prompt_id.as_deref()) =>
                        {
                            let Ok(mut live) = live.lock() else { break };
                            live.value = event["data"]["value"].as_u64().unwrap_or(0);
                            live.max = event["data"]["max"].as_u64().unwrap_or(0);
                        }
                        Some("execution_success" | "execution_error" | "execution_interrupted")
                            if prompt_id.is_some()
                                && event["data"]["prompt_id"].as_str() == prompt_id.as_deref() =>
                        {
                            break
                        }
                        _ => {}
                    }
                }
                Message::Close(_) => {
                    let _ = tokio::time::timeout(Duration::from_secs(1), socket.flush()).await;
                    return;
                }
                // Tungstenite queues the matching pong; flush it even on an otherwise idle socket.
                Message::Ping(_)
                    if !matches!(
                        tokio::time::timeout(Duration::from_secs(1), socket.flush()).await,
                        Ok(Ok(()))
                    ) =>
                {
                    break;
                }
                _ => {}
            }
        }
        // A TCP drop races ComfyUI's queued sends; finish the WebSocket close handshake instead.
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            socket.close(None).await?;
            while let Some(message) = socket.next().await {
                if matches!(message?, Message::Close(_)) {
                    break;
                }
            }
            Ok::<_, tokio_tungstenite::tungstenite::Error>(())
        })
        .await;
    });
}

fn correlate(tuple: &Value, job: &Job) -> Result<(), String> {
    let tuple = tuple
        .as_array()
        .filter(|t| (5..=6).contains(&t.len()))
        .ok_or("Malformed backend prompt tuple")?;
    if !tuple[0].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
        || tuple[1].as_str() != job.prompt_id.as_deref()
        || !same(&tuple[2], &job.plan.graph)
        || tuple[3]["client_id"].as_str() != Some(job.client_id.as_str())
        || !tuple[4]
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string))
    {
        return Err("Backend prompt/client/graph correlation failed; foreign job refused".into());
    }
    Ok(())
}

fn outputs(entry: &Value) -> Result<Vec<Value>, String> {
    let all = entry["outputs"]
        .as_object()
        .ok_or("Malformed history outputs")?;
    let Some(node) = all.get("7") else {
        return Ok(vec![]);
    };
    // Image savers list `images`; the DaSiWa video combine lists the video under `gifs` (plus frame PNGs under `images`).
    let images: Vec<&Value> = ["images", "gifs"]
        .iter()
        .filter_map(|k| node.get(*k))
        .map(|v| v.as_array().ok_or("Malformed diagnostic image outputs"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();
    if images.len() > 64 {
        return Err("Too many diagnostic image outputs".into());
    }
    images
        .iter()
        .map(|image| {
            let filename = image["filename"]
                .as_str()
                .ok_or("Missing output filename")?;
            let subfolder = image["subfolder"]
                .as_str()
                .ok_or("Missing output subfolder")?;
            if filename.len() > 255
                || filename.contains('/')
                || !safe_path(filename, false)
                || subfolder.len() > 255
                || !safe_path(subfolder, true)
                || image["type"] != "output"
            {
                return Err("Unsafe diagnostic output reference".into());
            }
            let mut out = json!({"filename":filename,"subfolder":subfolder,"type":"output"});
            // MIME type the combine reports (`video/webm`), so the UI can pick a player.
            if let Some(format) = image["format"].as_str().filter(|f| {
                f.len() <= 64
                    && f.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/.+-".contains(&b))
            }) {
                out["format"] = json!(format);
            }
            Ok(out)
        })
        .collect()
}

#[cfg(test)]
#[test]
fn metadata_uses_only_matching_monotonic_execution_events() {
    let messages = vec![
        json!(["execution_start", {"prompt_id":"foreign","timestamp":1}]),
        json!(["execution_start", {"prompt_id":"p","timestamp":1000}]),
        json!(["execution_success", {"prompt_id":"p","timestamp":14310}]),
    ];
    assert_eq!(
        execution_metadata(&messages, "p"),
        Some(json!({"startedAt":1000,"generationMs":13310}))
    );
    assert_eq!(execution_metadata(&[], "p"), None);
    assert_eq!(
        execution_metadata(&[messages[1].clone()], "p").unwrap()["generationMs"],
        Value::Null
    );
    let reversed = vec![
        messages[1].clone(),
        json!(["execution_success", {"prompt_id":"p","timestamp":999}]),
    ];
    assert_eq!(
        execution_metadata(&reversed, "p").unwrap()["generationMs"],
        Value::Null
    );
}

// Only correlated backend event timestamps describe execution; queue/poll latency is not generation time.
fn execution_metadata(messages: &[Value], prompt_id: &str) -> Option<Value> {
    let timestamp = |kind: &str| {
        messages.iter().find_map(|m| {
            (m[0] == kind && m[1]["prompt_id"].as_str() == Some(prompt_id))
                .then(|| m[1]["timestamp"].as_u64())
                .flatten()
        })
    };
    let start = timestamp("execution_start")?;
    let duration = timestamp("execution_success").and_then(|end| end.checked_sub(start));
    Some(json!({"startedAt":start,"generationMs":duration}))
}

async fn poll(job: &mut Job) -> Result<(), String> {
    let client = client()?;
    let prompt_id = job.prompt_id.as_deref().ok_or("No correlated prompt ID")?;
    let history = get(&client, &job.plan.base, &format!("history/{prompt_id}")).await?;
    let entries = history.as_object().ok_or("Malformed backend history")?;
    if entries.keys().any(|id| id != prompt_id) {
        return Err("Foreign prompt in backend history".into());
    }
    if let Some(entry) = entries.get(prompt_id) {
        correlate(&entry["prompt"], job)?;
        let status = &entry["status"];
        let completed = status["completed"]
            .as_bool()
            .ok_or("Missing history completion flag")?;
        let messages = status["messages"]
            .as_array()
            .ok_or("Malformed history status messages")?;
        job.metadata = execution_metadata(messages, prompt_id);
        match status["status_str"].as_str() {
            Some("error") => {
                job.state = "failed";
                let diagnostic = messages
                    .iter()
                    .find(|m| m[0] == "execution_error")
                    .map(|m| {
                        format!(
                            "node {} ({}): {}: {}",
                            m[1]["node_id"].as_str().unwrap_or("unknown"),
                            m[1]["node_type"].as_str().unwrap_or("unknown"),
                            m[1]["exception_type"].as_str().unwrap_or("Error"),
                            m[1]["exception_message"]
                                .as_str()
                                .unwrap_or("Backend execution failed")
                        )
                    })
                    .unwrap_or_else(|| "Backend reported diagnostic execution error".into());
                job.error = Some(
                    bounded(&diagnostic.replace(['\r', '\n'], " "))
                        .trim()
                        .to_owned(),
                );
                job.outputs.clear();
                return Ok(());
            }
            Some("success") if completed => {
                let images = outputs(entry)?;
                if images.is_empty() {
                    return Err("Completed history has no diagnostic image output".into());
                }
                job.outputs = images;
                job.state = "succeeded";
                job.error = None;
                return Ok(());
            }
            Some("success") => {}
            _ => return Err("Malformed history execution status".into()),
        }
    }
    let queue = get(&client, &job.plan.base, "queue").await?;
    let mut found = None;
    for (field, state) in [("queue_running", "running"), ("queue_pending", "queued")] {
        let entries = queue[field].as_array().ok_or("Malformed backend queue")?;
        for tuple in entries {
            if tuple.get(1).and_then(Value::as_str) == job.prompt_id.as_deref() {
                correlate(tuple, job)?;
                if found.is_some() {
                    return Err("Duplicate prompt ID in backend queue".into());
                }
                found = Some(state);
            }
        }
    }
    job.state =
        found.ok_or("Correlated prompt absent from history and queue; execution unknown")?;
    job.error = None;
    job.outputs.clear();
    Ok(())
}

#[tauri::command]
pub async fn native_job_prepare(
    state: tauri::State<'_, Jobs>,
    base_url: String,
    intent: Value,
) -> Result<Value, String> {
    state.prepare(base_url, intent).await
}
#[tauri::command]
pub async fn native_job_submit(
    state: tauri::State<'_, Jobs>,
    engine: tauri::State<'_, crate::install::Engine>,
    plan_id: String,
    confirmed: bool,
) -> Result<Value, String> {
    {
        let mut session = state.lock()?;
        if let Some(plan) = session
            .plan
            .as_mut()
            .filter(|p| p.id == plan_id && !p.consumed)
        {
            plan.media_root = job_outputs::MediaRoot::owned(&engine, plan.base.as_str());
        }
    }
    state.submit(plan_id, confirmed).await
}
#[tauri::command]
pub async fn native_job_status(
    state: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<Value, String> {
    state.status(job_id).await
}

/// Read the last native session job without contacting or adopting a backend.
#[tauri::command]
pub fn native_job_current(state: tauri::State<'_, Jobs>) -> Result<Value, String> {
    state.current()
}

/// Store an inpaint mask PNG drawn in the app in the backend's input folder (ComfyUI `upload/image`) under a fresh name.
#[tauri::command]
pub async fn native_mask_upload(base_url: String, png: Vec<u8>) -> Result<String, String> {
    if png.len() > 64 << 20 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Mask must be a PNG of at most 64 MiB".into());
    }
    upload(&base_url, MASK_FOLDER, "", "png", png).await
}

const INPUT_FOLDER: &str = "deas-inputs";

/// Kind and extension of a reference file by its magic bytes: images (PNG/JPEG/WebP), videos (MP4/MOV, WebM/MKV)
/// and audio (WAV, MP3, FLAC, Ogg, M4A). Anything else is refused.
pub(crate) fn sniff_media(head: &[u8]) -> Option<(&'static str, &'static str)> {
    let at = |i: usize, m: &[u8]| head.get(i..i + m.len()) == Some(m);
    Some(if at(0, b"\x89PNG\r\n\x1a\n") {
        ("image", "png")
    } else if at(0, b"\xff\xd8\xff") {
        ("image", "jpg")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        ("image", "webp")
    } else if at(0, b"RIFF") && at(8, b"WAVE") {
        ("audio", "wav")
    } else if at(4, b"ftyp") {
        match head.get(8..12) {
            Some(b"M4A ") => ("audio", "m4a"),
            Some(b"qt  ") => ("video", "mov"),
            _ => ("video", "mp4"),
        }
    } else if at(0, b"\x1a\x45\xdf\xa3") {
        // EBML: the DocType string sits in the first header bytes.
        if head.windows(4).any(|w| w == b"webm") {
            ("video", "webm")
        } else {
            ("video", "mkv")
        }
    } else if at(0, b"ID3") || (head.len() > 1 && head[0] == 0xff && head[1] & 0xe0 == 0xe0) {
        ("audio", "mp3")
    } else if at(0, b"fLaC") {
        ("audio", "flac")
    } else if at(0, b"OggS") {
        ("audio", "ogg")
    } else {
        return None;
    })
}

/// Copy a reference file the user picked in the media dock into the backend's input folder (the H3 Director
/// and core `LoadVideo` resolve input-folder names only). Images/audio go to `deas-inputs/`; videos to the input
/// root as `deas-input-<uuid>.<ext>`, because core `LoadVideo` lists top-level input files only.
#[tauri::command]
pub async fn native_input_upload(base_url: String, path: String) -> Result<String, String> {
    upload_input(&base_url, &path, false)
        .await
        .inspect_err(|_| h3_session_failure("", H3SessionFailure::InputUpload))
}

/// Explicit OS selection authorizes upload only, never video preparation or generation.
#[tauri::command]
pub async fn native_h3_video_upload(base_url: String) -> Result<Option<String>, String> {
    crate::validate_base_url(&base_url)
        .inspect_err(|_| h3_session_failure("", H3SessionFailure::InputUpload))?;
    let selected = rfd::AsyncFileDialog::new()
        .set_title("DEAS — Upload local video")
        .add_filter("Video", &["mp4", "mov", "webm", "mkv"])
        .pick_file()
        .await;
    selected_video_upload(&base_url, selected.map(|file| file.path().to_owned())).await
}

async fn selected_video_upload(
    base_url: &str,
    path: Option<std::path::PathBuf>,
) -> Result<Option<String>, String> {
    let Some(path) = path else { return Ok(None) };
    let result = async {
        let path = path.to_str().ok_or("Video path must be UTF-8")?;
        upload_input(base_url, path, true).await.map(Some)
    }
    .await;
    result.inspect_err(|_| h3_session_failure("", H3SessionFailure::InputUpload))
}

async fn upload_input(base_url: &str, path: &str, video_only: bool) -> Result<String, String> {
    crate::validate_base_url(base_url)?;
    let mut file = std::fs::File::open(path).map_err(|_| "Reference file unreadable")?;
    let meta = file.metadata().map_err(|_| "Reference file not found")?;
    if !meta.is_file() {
        return Err("Reference must be a regular file".into());
    }
    let mut head = [0u8; 64];
    let n = std::io::Read::read(&mut file, &mut head).map_err(|_| "Reference file unreadable")?;
    let (kind, ext) = sniff_media(&head[..n])
        .ok_or("Reference must be a PNG, JPEG or WebP image, an MP4/MOV/WebM/MKV video or WAV/MP3/FLAC/Ogg/M4A audio")?;
    if video_only && kind != "video" {
        return Err("Reference must be an MP4/MOV/WebM/MKV video".into());
    }
    // shortcut: the whole file is held in memory for the multipart body; stream it if larger references are needed.
    let limit: u64 = if kind == "image" { 64 << 20 } else { 512 << 20 };
    if meta.len() > limit {
        return Err(format!(
            "Reference must be a file of at most {} MiB",
            limit >> 20
        ));
    }
    use std::io::{Read, Seek};
    file.rewind().map_err(|_| "Reference file unreadable")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Reference file unreadable")?;
    if bytes.len() as u64 > limit {
        return Err("Reference exceeds upload size limit".into());
    }
    if kind == "video" {
        upload(base_url, "", "deas-input-", ext, bytes).await
    } else {
        upload(base_url, INPUT_FOLDER, "", ext, bytes).await
    }
}

async fn upload(
    base_url: &str,
    folder: &str,
    prefix: &str,
    ext: &str,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let base = crate::validate_base_url(base_url)?;
    let name = format!("{prefix}{}.{ext}", uuid::Uuid::new_v4());
    let boundary = format!("deas-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(bytes.len() + 512);
    for (field, value) in [
        ("subfolder", folder),
        ("type", "input"),
        ("overwrite", "false"),
    ] {
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
    body.extend(&bytes);
    body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    let url = base
        .join("upload/image")
        .map_err(|_| "Invalid native job endpoint")?;
    let mut response = client()?
        .post(url)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|_| "Upload failed")?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err("Upload response size limit exceeded".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Upload response interrupted")?
    {
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err("Upload response size limit exceeded".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    if !status.is_success() || value["name"] != name.as_str() || value["subfolder"] != folder {
        return Err(format!("Upload rejected (HTTP {status})"));
    }
    Ok(if folder.is_empty() {
        name
    } else {
        format!("{folder}/{name}")
    })
}

/// Probe/hash an existing input-relative video; backend owns source identity and later VAE import.
#[tauri::command]
pub async fn native_h3_video_prepare(base_url: String, filename: String) -> Result<Value, String> {
    let result = async {
        if filename.is_empty()
            || filename.len() > 4096
            || filename
                .chars()
                .any(|c| c.is_control() || "\\:".contains(c))
            || filename
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
            || ["[output]", "[temp]"]
                .iter()
                .any(|s| filename.trim_end().ends_with(s))
        {
            return Err("Invalid input-relative video filename".into());
        }
        let base = crate::validate_base_url(&base_url)?;
        // Hashing twice plus a bounded PyAV probe can exceed the normal diagnostic deadline.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .map_err(|_| "Could not create video preparation HTTP client")?;
        let (status, v) = request(
            &client,
            &base,
            "df_h3_continuity/video",
            Some(json!({"filename":filename})),
        )
        .await?;
        if !status.is_success() {
            return Err(format!("Video preparation endpoint returned HTTP {status}"));
        }
        if v["filename"] != filename
            || v["kind"] != "video"
            || !["clip_id", "sha256"]
                .iter()
                .all(|k| v[*k].as_str().is_some_and(h3_source_id))
            || !["width", "height"].iter().all(|k| h3_video_edge(&v[*k]))
            || !["fps", "seconds"]
                .iter()
                .all(|k| v[*k].as_f64().is_some_and(|n| n.is_finite() && n > 0.0))
            || !v["has_audio"].is_boolean()
        {
            return Err("Malformed video preparation response".into());
        }
        Ok(
            json!({"sourceId":v["clip_id"],"filename":filename,"sha256":v["sha256"],
            "width":v["width"],"height":v["height"],"fps":v["fps"].as_f64(),
            "seconds":v["seconds"].as_f64(),"hasAudio":v["has_audio"]}),
        )
    }
    .await;
    result.inspect_err(|_| h3_session_failure("", H3SessionFailure::VideoPrepare))
}

fn h3_source_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn h3_video_edge(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| (1..=65536).contains(&n))
}

#[derive(Clone, Copy)]
enum H3SessionFailure {
    InvalidSession,
    InvalidEndpoint,
    Request,
    Shape,
    VideoPrepare,
    InputUpload,
}

fn h3_session_failure(session: &str, cause: H3SessionFailure) {
    // One fixed slot per cause, not per untrusted session or endpoint.
    static LAST: Mutex<[(Option<std::time::Instant>, u64); 6]> = Mutex::new([(None, 0); 6]);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let (at, repeats) = &mut last[cause as usize];
    let recurring = at.is_some_and(|at| at.elapsed() < Duration::from_secs(60));
    if recurring {
        *repeats = repeats.saturating_add(1);
        if *repeats != 1 {
            return;
        }
    } else {
        *at = Some(std::time::Instant::now());
    }
    let diagnostic = match cause {
        H3SessionFailure::InvalidSession => "WARN: H3 continuity session-list: invalid session",
        H3SessionFailure::InvalidEndpoint => {
            "WARN: H3 continuity session-list: invalid backend endpoint"
        }
        H3SessionFailure::Request => "ERROR: H3 continuity session-list: backend request failed",
        H3SessionFailure::Shape => "ERROR: H3 continuity session-list: malformed response",
        H3SessionFailure::VideoPrepare => "ERROR: H3 continuity video-prepare: preparation failed",
        H3SessionFailure::InputUpload => "ERROR: Native input-upload: validation or upload failed",
    };
    let correlation = if crate::jobs_video::continuity_id(session) {
        format!("; session={session}")
    } else {
        String::new()
    };
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("{diagnostic}{correlation}; repeated={repeats} (further repeats limited to once per minute)"),
    );
    if !recurring {
        *repeats = 0;
    }
}

/// Read-only list of the DaSiWa H3 continuity clips of one session (`clip_id`, `parent`, `frames`, `export`),
/// so the continuity planner can pin the clip a finished step produced.
#[tauri::command]
pub async fn native_h3_session(base_url: String, session: String) -> Result<Value, String> {
    if !crate::jobs_video::continuity_id(&session) {
        h3_session_failure(&session, H3SessionFailure::InvalidSession);
        return Err("Invalid continuity session".into());
    }
    let base = crate::validate_base_url(&base_url)
        .inspect_err(|_| h3_session_failure(&session, H3SessionFailure::InvalidEndpoint))?;
    let value = get(
        &client().inspect_err(|_| h3_session_failure(&session, H3SessionFailure::Request))?,
        &base,
        &format!("df_h3_continuity/session/{session}"),
    )
    .await
    .inspect_err(|_| h3_session_failure(&session, H3SessionFailure::Request))?;
    let clips = value["clips"]
        .as_array()
        .ok_or("Malformed continuity session")
        .inspect_err(|_| h3_session_failure(&session, H3SessionFailure::Shape))?
        .iter()
        .take(200)
        .filter(|c| c["clip_id"].as_str().is_some_and(crate::jobs_video::continuity_id))
        .map(|c| {
            let mut clip = json!({"clipId":c["clip_id"],"parent":c["parent_id"].as_str().filter(|p| crate::jobs_video::continuity_id(p)),
                "frames":c["frames"].as_u64(),"completed":c["completed_ns"].as_u64().unwrap_or(0),
                "export":c["export"].as_object().filter(|e| e["filename"].as_str().is_some_and(|f| safe_path(f, false))).map(|e| json!({"filename":e["filename"],"subfolder":e["subfolder"].as_str().unwrap_or(""),"type":e["type"]}))});
            // ClipStore lists provenance at the clip root; its clip_id is the backend's VAE cache identity.
            let provenance = &c["provenance"];
            if provenance["kind"] == "imported_video"
                && provenance["source_video_id"].as_str().is_some_and(h3_source_id)
                && ["width", "height"].iter().all(|k| h3_video_edge(&c[*k]))
                && c["mode_family"].as_str().is_some_and(|m| ["fl2va", "ref2va"].contains(&m))
            {
                clip["importedVideo"] = json!({"sourceId":provenance["source_video_id"],
                    "width":c["width"],"height":c["height"],"modeFamily":c["mode_family"]});
            }
            clip
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"latestId":value["latest_id"].as_str().filter(|l| crate::jobs_video::continuity_id(l)),"clips":clips}),
    )
}

/// Read-only DaSiWa RefMod library (`GET /dasiwa/refmods`, files in `models/refmods`): names, member kinds and
/// descriptions only, so the References tab can offer them; the Director loads the files itself at run time.
#[tauri::command]
pub async fn native_h3_refmods(base_url: String) -> Result<Value, String> {
    let base = crate::validate_base_url(&base_url)?;
    Ok(refmod_entries(
        &get(&client()?, &base, "dasiwa/refmods").await?,
    ))
}

fn refmod_entries(v: &Value) -> Value {
    let kinds = ["image", "video", "audio"];
    v.as_array()
        .into_iter()
        .flatten()
        .take(500)
        .filter(|e| e["name"].as_str().is_some_and(model_name))
        .filter_map(|e| {
            let members: Vec<&str> = e["kinds"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            (!members.is_empty()
                && members.len() <= 16
                && members.iter().all(|k| kinds.contains(k)))
            .then(|| {
                let description: String = e["description"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(2000)
                    .collect();
                json!({"name":e["name"],"kinds":members,"description":description})
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
