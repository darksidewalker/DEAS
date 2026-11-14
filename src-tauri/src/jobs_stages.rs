//! Observed execution only: a cached or unobserved graph node is not a completed pass.
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Stages {
    job: String,
    nodes: BTreeMap<String, Node>,
    unknown_failure: bool,
    finished: bool,
}

struct Node {
    stage: &'static str,
    settings: String,
    observed: u8,
}

impl Stages {
    pub(super) fn new(job: &str, graph: &Value) -> Self {
        let nodes = graph
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(id, _)| {
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .map(|(id, node)| {
                let class = node["class_type"].as_str().unwrap_or_default();
                let stage = stage(id, class);
                let kind = if stage == "prepare" {
                    String::new()
                } else {
                    format!(" kind={class}")
                };
                (
                    id.clone(),
                    Node {
                        stage,
                        settings: format!("{kind}{}", settings(&node["inputs"])),
                        observed: 0,
                    },
                )
            })
            .collect();
        Self {
            job: if super::canonical_uuid(job) {
                job.into()
            } else {
                "withheld".into()
            },
            nodes,
            unknown_failure: false,
            finished: false,
        }
    }

    pub(super) fn event(&mut self, kind: &str, data: &Value) {
        if self.finished {
            return;
        }
        if kind == "execution_cached" {
            for id in data["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                self.record(id, "cached", 2);
            }
            return;
        }
        let (field, event, flag) = match kind {
            "executing" => ("node", "started", 1),
            "executed" => ("node", "completed", 4),
            "execution_error" => ("node_id", "failed", 8),
            "execution_interrupted" => ("node_id", "interrupted", 16),
            _ => return,
        };
        let id = data[field].as_str().unwrap_or_default();
        if kind == "execution_error" && !self.nodes.contains_key(id) && !self.unknown_failure {
            self.unknown_failure = true;
            crate::logs::push(
                crate::logs::Source::Deas,
                &format!(
                    "ERROR: execution-stage job={} node=unknown stage=unknown event=failed",
                    self.job,
                ),
            );
        }
        self.record(id, event, flag);
    }

    fn record(&mut self, id: &str, event: &str, flag: u8) {
        let Some(node) = self.nodes.get_mut(id) else {
            return;
        };
        if node.observed & flag != 0 {
            return;
        }
        node.observed |= flag;
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!(
                "{}: execution-stage job={} node={id} stage={} event={event}{}",
                if event == "failed" { "ERROR" } else { "INFO" },
                self.job,
                node.stage,
                node.settings,
            ),
        );
    }

    pub(super) fn finish(&mut self, outcome: &str) {
        let outcome = match outcome {
            "succeeded" => "succeeded",
            "failed" => "failed",
            "cancelled" => "cancelled",
            _ => return,
        };
        if self.finished || self.job.is_empty() {
            return;
        }
        self.finished = true;
        let mut missing = BTreeMap::<_, usize>::new();
        for node in self.nodes.values().filter(|node| node.observed == 0) {
            *missing.entry(node.stage).or_default() += 1;
        }
        let missing = missing
            .into_iter()
            .map(|(stage, count)| format!("{stage}:{count}"))
            .collect::<Vec<_>>()
            .join(",");
        let count = |flag| {
            self.nodes
                .values()
                .filter(|node| node.observed & flag != 0)
                .count()
        };
        crate::logs::push(crate::logs::Source::Deas, &format!(
            "INFO: execution-stage job={} event=summary outcome={outcome} planned={} started={} cached={} completed={} failed={} not-observed=[{missing}] (missing events do not prove a stage was skipped or unstarted)",
            self.job, self.nodes.len(), count(1), count(2), count(4), count(8),
        ));
    }
}

fn stage(id: &str, class: &str) -> &'static str {
    match class {
        "DaSiWaH3HiResRegenerate" => "h3-regenerate",
        "DaSiWaH3TiledUpscale" | "LTXVLatentUpsampler" => "latent-upscale",
        "DaSiWaH3DeropePrepare" | "DaSiWaH3DeropeRecover" => "de-rope",
        "DEAS_H3FaceRefine" => "face-refine",
        "DEAS_SAM3VideoWindow" | "SAM3_Detect" | "SAM3_VideoTrack" | "SAM3_TrackToMask" => {
            "segmentation"
        }
        "KSampler" | "KSamplerAdvanced" | "SamplerCustomAdvanced" => match id {
            "R5" => "image-refine",
            "DRK" => "de-rope",
            _ => "sampling",
        },
        "ImageUpscaleWithModel" => "image-upscale",
        "ImageScale" => "image-resize",
        "DaSiWaTiledDiffusion" => "tiled-refine-setup",
        "DaSiWa_RTX_UpscalerRefiner" => "video-upscale-refine",
        "DaSiWa_RTX_FrameGeneration" | "FrameInterpolate" => "frame-interpolation",
        "DaSiWa_SeamlessLoop" => "seamless-loop",
        "VAEDecode" | "VAEDecodeTiled" | "DaSiWaH3ContinuitySegmentDecode" => "decode",
        "VAEDecodeAudio" | "LTXVAudioVAEDecode" => "audio-decode",
        "VAEEncode" | "VAEEncodeTiled" => "encode",
        "DaSiWa_MetadataImageSaver"
        | "SaveImage"
        | "SaveVideo"
        | "DaSiWa_EnhancedVideoCombine"
        | "SaveAudioAdvanced" => "save",
        "YuE2GenerateMusic" => "music-tokens",
        "YuE2GenerateABC" | "SheetSage2AudioToABC" => "music-score",
        "TextEncodeAceStepAudio" | "TextEncodeAceStepAudio1.5" => "music-conditioning",
        "DEAS_ImagePostprocessGate" | "DEAS_VideoPostprocessGate" => "postprocess-gate",
        "DaSiWaH3ClipAssemble" => "clip-assemble",
        "DaSiWaH3ContinuityPublish" => "continuity-publish",
        "CLIPTextEncode" => "text-encode",
        "CheckpointLoaderSimple"
        | "UNETLoader"
        | "UnetLoaderGGUF"
        | "VAELoader"
        | "CLIPLoader"
        | "CLIPLoaderGGUF"
        | "DualCLIPLoader"
        | "DualCLIPLoaderGGUF"
        | "UpscaleModelLoader"
        | "LatentUpscaleModelLoader"
        | "FrameInterpolationModelLoader"
        | "AudioEncoderLoader" => "model-load",
        _ => "prepare",
    }
}

fn settings(inputs: &Value) -> String {
    let mut result = String::new();
    // Deliberately exclude all text, filenames, seeds, links and arbitrary backend fields.
    for key in [
        "steps",
        "cfg",
        "denoise",
        "width",
        "height",
        "scale",
        "strength",
        "tile_size",
        "tile_width",
        "tile_height",
        "overlap",
        "temporal_size",
        "temporal_overlap",
        "memory_budget_mb",
        "memory_reserve_pct",
        "frame_rate",
        "max_duration",
        "spatial_tiling",
        "temporal_chunking",
        "spike_guard",
        "enforce_memory_budget",
        "continuity_soft_refine",
    ] {
        let value = &inputs[key];
        if value.is_boolean()
            || value
                .as_f64()
                .is_some_and(|v| v.is_finite() && (0.0..=16_777_216.0).contains(&v))
        {
            result.push_str(&format!(" {key}={value}"));
        }
    }
    for (key, choices) in [
        ("target", &crate::jobs_video::REGENERATE_TARGETS[..]),
        ("upscale_precision", &["auto", "bf16", "fp16", "fp32"][..]),
        ("guard_mode", &["burn_direction", "both"][..]),
        (
            "weight_dtype",
            &["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"][..],
        ),
    ] {
        if let Some(value) = inputs[key].as_str().filter(|v| choices.contains(v)) {
            result.push_str(&format!(" {key}={value}"));
        }
    }
    for key in [
        "ckpt_name",
        "unet_name",
        "vae_name",
        "clip_name",
        "clip_name1",
        "clip_name2",
        "lora_name",
        "upscale_model",
        "model_name",
    ] {
        if let Some(format) = inputs[key]
            .as_str()
            .and_then(|name| name.rsplit('.').next())
            .filter(|ext| ["safetensors", "sft", "gguf", "ckpt", "pt", "pth"].contains(ext))
        {
            result.push_str(&format!(" {key}_format={format}"));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(id: &str) -> Vec<String> {
        crate::logs::native_logs(0)
            .into_iter()
            .filter(|entry| entry.text.contains(&format!("execution-stage job={id} ")))
            .map(|entry| entry.text)
            .collect()
    }

    #[test]
    fn execution_stage_catalog_covers_processing_options_and_music() {
        for (id, class, expected) in [
            ("U", "DaSiWaH3HiResRegenerate", "h3-regenerate"),
            ("U", "DaSiWaH3TiledUpscale", "latent-upscale"),
            ("U", "LTXVLatentUpsampler", "latent-upscale"),
            ("DRP", "DaSiWaH3DeropePrepare", "de-rope"),
            ("DRK", "SamplerCustomAdvanced", "de-rope"),
            ("DRR", "DaSiWaH3DeropeRecover", "de-rope"),
            ("FR", "DEAS_H3FaceRefine", "face-refine"),
            ("PM", "ImageUpscaleWithModel", "image-upscale"),
            ("R5", "KSampler", "image-refine"),
            ("R5", "SamplerCustomAdvanced", "image-refine"),
            ("PR", "DaSiWa_RTX_UpscalerRefiner", "video-upscale-refine"),
            ("PF", "DaSiWa_RTX_FrameGeneration", "frame-interpolation"),
            ("PF", "FrameInterpolate", "frame-interpolation"),
            ("LP", "DaSiWa_SeamlessLoop", "seamless-loop"),
            ("6", "VAEDecodeTiled", "decode"),
            ("SD", "DaSiWaH3ContinuitySegmentDecode", "decode"),
            ("D", "VAEDecodeAudio", "audio-decode"),
            ("7", "DaSiWa_EnhancedVideoCombine", "save"),
            ("7", "DaSiWa_MetadataImageSaver", "save"),
            ("7", "SaveAudioAdvanced", "save"),
            ("M", "YuE2GenerateMusic", "music-tokens"),
            ("A", "YuE2GenerateABC", "music-score"),
            ("M", "TextEncodeAceStepAudio", "music-conditioning"),
            ("M", "TextEncodeAceStepAudio1.5", "music-conditioning"),
            ("4", "SAM3_Detect", "segmentation"),
            ("4", "SAM3_VideoTrack", "segmentation"),
            ("7", "SaveVideo", "save"),
            ("secret", "private arbitrary backend string", "prepare"),
        ] {
            assert_eq!(stage(id, class), expected, "{class}");
        }
    }

    #[test]
    fn execution_stage_settings_are_allowlisted_bounded_and_model_names_stay_private() {
        let id = uuid::Uuid::new_v4().to_string();
        let graph = json!({"U":{"class_type":"DaSiWaH3HiResRegenerate","inputs":{
            "target":"2K", "spatial_tiling":true,"strength":1.0,"upscale_precision":"bf16",
            "lora_name":"private refiner.safetensors","upscale_model":"https://user:password@host/private.safetensors",
            "prompt":"private prompt","scheduler":"private","steps":"private", "seed":123,
            "width":1e99,"unknown":42
        }}});
        let mut stages = Stages::new(&id, &graph);
        stages.event("executing", &json!({"node":"U"}));
        let logs = lines(&id);
        assert_eq!(logs.len(), 1);
        let log = &logs[0];
        assert!(log.contains("stage=h3-regenerate event=started"));
        assert!(log.contains("kind=DaSiWaH3HiResRegenerate"));
        assert!(log.contains("target=2K"));
        assert!(log.contains("upscale_precision=bf16"));
        assert!(log.contains("spatial_tiling=true"));
        assert!(log.contains("lora_name_format=safetensors"));
        assert!(log.contains("upscale_model_format=safetensors"));
        assert!(
            !log.contains("private")
                && !log.contains("password")
                && !log.contains("seed=")
                && !log.contains("width=")
                && !log.contains("unknown=")
        );
        assert!(log.len() < 2048);
    }

    #[test]
    fn execution_stage_failure_uses_graph_stage_not_backend_text() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut stages = Stages::new(
            &id,
            &json!({"5":{"class_type":"KSampler"}, "U":{"class_type":"DaSiWaH3HiResRegenerate"}}),
        );
        let data = json!({"node_id":"5", "node_type":"secret", "exception_message":"secret prompt https://user:password@host/?key=token", "exception_type":"secret", "executed":["U"]});
        stages.event("execution_error", &data);
        stages.event("execution_error", &data);
        let logs = lines(&id);
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("ERROR:"));
        assert!(logs[0].contains("node=5 stage=sampling event=failed"));
        assert!(!logs[0].contains("secret"));
        assert!(!logs[0].contains("password"));
        assert!(
            !logs[0].contains("h3-regenerate"),
            "do not invent starts from an executed list"
        );
    }

    #[test]
    fn execution_stage_cached_is_not_started_and_replay_is_deduplicated() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut stages = Stages::new(
            &id,
            &json!({"5":{"class_type":"KSampler","inputs":{"steps":20}}}),
        );
        let data = json!({"nodes":["5", "unknown", "5"]});
        stages.event("execution_cached", &data);
        stages.event("execution_cached", &data);
        let logs = lines(&id);
        assert_eq!(logs.len(), 1);
        assert!(logs[0].contains("node=5 stage=sampling event=cached"));
        assert!(!logs[0].contains("event=started"));
    }
}
