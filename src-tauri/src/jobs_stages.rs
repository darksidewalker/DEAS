//! Observed execution only: a cached or unobserved graph node is not a completed pass.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

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
    subevents: BTreeSet<(u8, u64, u64, u8)>,
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
                        subevents: BTreeSet::new(),
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
        if kind == "dasiwa_h3_regenerate_stage" {
            self.regenerate_phase(data);
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
            "submission_rejected" => ("node_id", "rejected", 32),
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

    fn regenerate_phase(&mut self, data: &Value) {
        let Some(id) = data["node"].as_str() else {
            return;
        };
        let Some(node) = self
            .nodes
            .get_mut(id)
            .filter(|node| node.stage == "h3-regenerate")
        else {
            return;
        };
        let (phase_id, phase) = match data["phase"].as_str() {
            Some("lora") => (0, "lora"),
            Some("latent-upscale") => (1, "latent-upscale"),
            Some("refine") => (2, "refine"),
            _ => return,
        };
        let (event_id, event) = match data["outcome"].as_str() {
            Some("started") => (0, "started"),
            Some("completed") => (1, "completed"),
            Some("failed") => (2, "failed"),
            Some("cancelled") => (3, "cancelled"),
            _ => return,
        };
        let Some(pass) = data["pass"]
            .as_u64()
            .filter(|n| (1..=2).contains(n) && (phase_id == 1 || *n == 1))
        else {
            return;
        };
        let Some(chunks) = data["chunks"].as_u64().filter(|n| (1..=4096).contains(n)) else {
            return;
        };
        let Some(chunk) = data["chunk"].as_u64().filter(|n| (1..=chunks).contains(n)) else {
            return;
        };
        let Some(elapsed) = data["elapsed_ms"].as_u64().filter(|n| *n <= 604_800_000) else {
            return;
        };
        // Bound untrusted telemetry independently of the graph's node/event counters.
        if node.subevents.len() >= 4096 || !node.subevents.insert((phase_id, pass, chunk, event_id))
        {
            return;
        }
        let mut details = String::new();
        for key in ["source_width", "source_height", "width", "height", "steps"] {
            if let Some(value) = data[key].as_u64().filter(|n| (1..=32768).contains(n)) {
                details.push_str(&format!(" {key}={value}"));
            }
        }
        if let Some(cfg) = data["cfg"]
            .as_f64()
            .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
        {
            details.push_str(&format!(" cfg={cfg}"));
        }
        for key in ["spatial_tiling", "spatial_split"] {
            if let Some(value) = data[key].as_bool() {
                details.push_str(&format!(" {key}={value}"));
            }
        }
        let severity = if event == "failed" { "ERROR" } else { "INFO" };
        crate::logs::push(crate::logs::Source::Deas, &format!(
            "{severity}: execution-stage job={} node={id} stage=h3-regenerate phase={phase} event={event} pass={pass} chunk={chunk} chunks={chunks} elapsed_ms={elapsed}{details}", self.job,
        ));
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
                if ["failed", "rejected"].contains(&event) {
                    "ERROR"
                } else {
                    "INFO"
                },
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
            "INFO: execution-stage job={} event=summary outcome={outcome} planned={} started={} cached={} completed={} failed={} rejected={} not-observed=[{missing}] (missing events do not prove a stage was skipped or unstarted)",
            self.job, self.nodes.len(), count(1), count(2), count(4), count(8), count(32),
        ));
    }
}

fn stage(id: &str, class: &str) -> &'static str {
    match class {
        "LoraLoader" | "LoraLoaderModelOnly" => "lora-patch",
        "ModelAttentionBackend" | "PathchSageAttentionKJ" => "attention-setup",
        "EasyCache" | "LazyCache" => "cache-setup",
        "TorchCompileModel" => "compile-setup",
        "MiniMaxChunkFeedForward" | "LTXVChunkFeedForward" | "WanChunkFeedForward" => {
            "feed-forward-chunking"
        }
        "BasicScheduler" | "SplitSigmasDenoise" | "ManualSigmas" | "HyperFlowSigmas" => {
            "sampling-schedule"
        }
        "ModelSamplingSD3" | "MiniMaxH3SigmaShift" => "sampling-setup",
        "KSamplerSelect" => "sampler-setup",
        "MiniMaxH3Director"
        | "MiniMaxH3DirectorGuide"
        | "MiniMaxH3ImageToVideo"
        | "MiniMaxH3ReferenceToVideo"
        | "LTXVAddGuide"
        | "LTXVConditioning" => "video-conditioning",
        "TextEncodeQwenImage21" | "DEAS_ImagePromptEncode" | "unCLIPConditioning" => {
            "image-conditioning"
        }
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
        "strength_model",
        "strength_clip",
        "chunks",
        "seq_threshold",
        "chunk_size",
        "reuse_threshold",
        "start_percent",
        "end_percent",
        "deblur",
        "chunking",
        "chunk_frames",
        "use_mmap",
        "multiplier",
        "automatic_shot_change_detection",
        "shot_change",
        "exact_endpoint",
        "keep_background",
        "keep_keyframes",
        "guard_sensitivity",
        "guard_strength",
        "continuity_mask_strength",
        "upscale_sharpness",
        "detection_threshold",
        "max_objects",
        "detect_interval",
        "scene_threshold",
        "crop_factor",
        "feather",
        "min_face",
        "fps",
        "duration",
        "seconds",
        "bpm",
        "generate_audio_codes",
        "lyrics_strength",
        "cfg_scale",
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "repetition_penalty",
        "penalty_window",
        "max_abc_tokens",
    ] {
        let value = &inputs[key];
        if value.is_boolean()
            || value.as_f64().is_some_and(|v| {
                v.is_finite()
                    && v <= 16_777_216.0
                    && v >= if ["strength_model", "strength_clip"].contains(&key) {
                        -16_777_216.0
                    } else {
                        0.0
                    }
            })
        {
            result.push_str(&format!(" {key}={value}"));
        }
    }
    for (key, choices) in [
        ("target", &crate::jobs_video::REGENERATE_TARGETS[..]),
        (
            "attention",
            &["pytorch attention", "comfy kitchen attention"][..],
        ),
        ("backend", &["inductor", "cudagraphs"][..]),
        (
            "sage_attention",
            &[
                "disabled",
                "auto",
                "sageattn_qk_int8_pv_fp16_cuda",
                "sageattn_qk_int8_pv_fp16_triton",
                "sageattn_qk_int8_pv_fp8_cuda",
                "sageattn_qk_int8_pv_fp8_cuda++",
            ][..],
        ),
        (
            "denoise_quality",
            &crate::jobs_video_post::RTX_QUALITIES[..],
        ),
        ("deblur_quality", &crate::jobs_video_post::RTX_QUALITIES[..]),
        (
            "upscale_quality",
            &crate::jobs_video_post::RTX_QUALITIES[..],
        ),
        (
            "upscale",
            &[
                "Off",
                "VSR",
                "High Bitrate",
                "Streaming Medium",
                "Streaming Ultra",
            ][..],
        ),
        (
            "mode",
            &[
                "LOW",
                "MEDIUM",
                "HIGH",
                "full",
                "melody",
                "vocal",
                "instrumental",
            ][..],
        ),
        (
            "interpolation_backend",
            &["RIFE / FILM", "RTX Frame Generation"][..],
        ),
        ("audio_loop", &["Crossfade", "Beat-aware"][..]),
        ("preset", &crate::jobs_video_post::DEROPE_PRESETS[..]),
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
    fn execution_stage_options_are_identified_and_settings_remain_private() {
        for (class, expected) in [
            ("LoraLoader", "lora-patch"),
            ("LoraLoaderModelOnly", "lora-patch"),
            ("ModelAttentionBackend", "attention-setup"),
            ("PathchSageAttentionKJ", "attention-setup"),
            ("EasyCache", "cache-setup"),
            ("LazyCache", "cache-setup"),
            ("TorchCompileModel", "compile-setup"),
            ("MiniMaxChunkFeedForward", "feed-forward-chunking"),
            ("LTXVChunkFeedForward", "feed-forward-chunking"),
            ("WanChunkFeedForward", "feed-forward-chunking"),
            ("BasicScheduler", "sampling-schedule"),
            ("KSamplerSelect", "sampler-setup"),
            ("MiniMaxH3Director", "video-conditioning"),
            ("MiniMaxH3DirectorGuide", "video-conditioning"),
            ("MiniMaxH3ImageToVideo", "video-conditioning"),
            ("MiniMaxH3ReferenceToVideo", "video-conditioning"),
            ("LTXVAddGuide", "video-conditioning"),
            ("TextEncodeQwenImage21", "image-conditioning"),
            ("DEAS_ImagePromptEncode", "image-conditioning"),
            ("ModelSamplingSD3", "sampling-setup"),
            ("MiniMaxH3SigmaShift", "sampling-setup"),
            ("ManualSigmas", "sampling-schedule"),
            ("HyperFlowSigmas", "sampling-schedule"),
        ] {
            assert_eq!(stage("X", class), expected, "{class}");
        }
        let settings = settings(&json!({
            "strength_model":-0.5,"strength_clip":0.7,"chunks":4,"reuse_threshold":0.2,
            "attention":"comfy kitchen attention","backend":"inductor",
            "chunk_frames":8,"use_mmap":true,"deblur":true,"deblur_quality":"Ultra",
            "upscale":"VSR","multiplier":2,"mode":"HIGH","keep_background":true,
            "guard_sensitivity":4.3,"upscale_sharpness":3,"crop_factor":2,
            "duration":5,"generate_audio_codes":true,"temperature":0.8,"top_p":0.9,
            "lora_name":"private.safetensors","lyrics":"private","seed":123,
            "scheduler":"private","subjects":"private"
        }));
        for field in [
            "strength_model=-0.5",
            "strength_clip=0.7",
            "chunks=4",
            "reuse_threshold=0.2",
            "attention=comfy kitchen attention",
            "backend=inductor",
            "chunk_frames=8",
            "use_mmap=true",
            "deblur=true",
            "deblur_quality=Ultra",
            "upscale=VSR",
            "multiplier=2",
            "mode=HIGH",
            "keep_background=true",
            "guard_sensitivity=4.3",
            "upscale_sharpness=3",
            "crop_factor=2",
            "duration=5",
            "generate_audio_codes=true",
            "temperature=0.8",
            "top_p=0.9",
        ] {
            assert!(settings.contains(field), "missing {field}: {settings}");
        }
        assert!(!settings.contains("private") && !settings.contains("seed="));
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
    fn regenerate_internal_phases_are_bounded_owned_and_deduplicated() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut stages = Stages::new(
            &id,
            &json!({
                "U":{"class_type":"DaSiWaH3HiResRegenerate"}, "5":{"class_type":"KSampler"}
            }),
        );
        let event = json!({"node":"U", "phase":"latent-upscale", "outcome":"started",
            "pass":2,"chunk":1,"chunks":2,"elapsed_ms":0,
            "source_width":2560,"source_height":1440,"width":3840,"height":2176,
            "prompt":"private", "lora_name":"private.safetensors", "spatial_tiling":true, "spatial_split":false});
        let mut wrong_node = event.clone();
        wrong_node["node"] = json!("5");
        stages.event("dasiwa_h3_regenerate_stage", &wrong_node);
        for (key, value) in [
            ("phase", json!("private")),
            ("outcome", json!("private")),
            ("pass", json!(3)),
            ("chunk", json!(0)),
            ("chunks", json!(999999)),
            ("elapsed_ms", json!(-1)),
        ] {
            let mut invalid = event.clone();
            invalid[key] = value;
            stages.event("dasiwa_h3_regenerate_stage", &invalid);
        }
        stages.event("dasiwa_h3_regenerate_stage", &event);
        stages.event("dasiwa_h3_regenerate_stage", &event);
        let mut completed = event.clone();
        completed["outcome"] = json!("completed");
        completed["elapsed_ms"] = json!(123);
        stages.event("dasiwa_h3_regenerate_stage", &completed);
        let mut failed = event.clone();
        failed["phase"] = json!("refine");
        failed["pass"] = json!(1);
        failed["outcome"] = json!("failed");
        failed["steps"] = json!(3);
        stages.event("dasiwa_h3_regenerate_stage", &failed);
        let logs = lines(&id);
        assert_eq!(logs.len(), 3, "start, completion, failure only");
        assert!(logs[0].contains("stage=h3-regenerate phase=latent-upscale event=started"));
        assert!(logs[0].contains("pass=2 chunk=1 chunks=2"));
        assert!(logs[0].contains("source_width=2560"));
        assert!(logs[0].contains("spatial_tiling=true spatial_split=false"));
        assert!(logs[0].contains("width=3840"));
        assert!(logs[1].contains("elapsed_ms=123"));
        assert!(logs[2].starts_with("ERROR:") && logs[2].contains("phase=refine event=failed"));
        assert!(logs.iter().all(|line| !line.contains("private")));
    }

    #[test]
    fn execution_stage_submission_rejection_is_not_an_execution_failure() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut stages = Stages::new(&id, &json!({"5":{"class_type":"KSampler"}}));
        let rejection = json!({"node_id":"5", "error":"private"});
        stages.event("submission_rejected", &rejection);
        stages.event("submission_rejected", &rejection);
        stages.finish("failed");
        let logs = lines(&id);
        assert_eq!(logs.len(), 2, "one node rejection and one summary");
        assert!(logs[0].starts_with("ERROR:"));
        assert!(logs[0].contains("node=5 stage=sampling event=rejected"));
        assert!(logs[1].contains("started=0"));
        assert!(logs[1].contains("rejected=1"));
        assert!(logs[1].contains("failed=0"));
        assert!(logs.iter().all(|line| !line.contains("private")));
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
