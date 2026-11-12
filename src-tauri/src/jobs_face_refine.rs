//! H3 face refinement: SAM3.1 tracks faces per shot, the bundled `DEAS_H3FaceRefine` adapter
//! re-samples each face in a square 768 crop with the graph's own H3 sampler and stitches it back.
//! Used standalone on an existing video (`h3-face-refine`) and chained after H3 generation
//! (`faceRefine` on a video intent). Both write the unrefined baseline `B7` before refining.
use crate::jobs::{comfy_model_name, model_name, safe_output_prefix};
use serde_json::{json, Value};

/// Refinement nodes no other recipe list already admits into the backend allowlist
/// (the frontend `faceRefineNodes` additionally checks the shared gate/loader/SAM nodes).
pub(crate) const ALLOW_NODES: [&str; 3] = [
    "DEAS_H3FaceRefine",
    "MiniMaxH3ImageToVideo",
    "SplitSigmasDenoise",
];
const BLOCK: [&str; 11] = [
    "samCheckpoint",
    "prompt",
    "threshold",
    "maxObjects",
    "detectInterval",
    "sceneThreshold",
    "denoise",
    "cropFactor",
    "feather",
    "minFace",
    "subjects",
];
const RECIPE: [&str; 19] = [
    "recipeId",
    "version",
    "family",
    "model",
    "textEncoder",
    "vae",
    "audioVae",
    "sourceVideo",
    "startSeconds",
    "durationSeconds",
    "seed",
    "steps",
    "sampler",
    "scheduler",
    "shiftVideo",
    "shiftAudio",
    "faceRefine",
    "outputPrefix",
    "output",
];

fn finite(v: &Value, min: f64, max: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (min..=max).contains(&n))
}

pub(crate) fn is_face_refine(i: &Value) -> bool {
    i["recipeId"] == "h3-face-refine"
}

/// The `faceRefine` block, shared by the standalone recipe and the generation chain.
pub(crate) fn validate(f: &Value) -> Result<(), String> {
    let o = f.as_object().ok_or("faceRefine must be an object")?;
    let ok = o.keys().all(|k| BLOCK.contains(&k.as_str()))
        && BLOCK
            .iter()
            .filter(|k| !["sceneThreshold", "minFace", "subjects"].contains(*k))
            .all(|k| o.contains_key(*k))
        && f["samCheckpoint"].as_str().is_some_and(comfy_model_name)
        && f["prompt"]
            .as_str()
            .is_some_and(|p| p.len() <= 16384)
        && finite(&f["threshold"], 0.0, 1.0)
        && f["maxObjects"].as_u64().is_some_and(|n| (1..=64).contains(&n))
        // Core io.Int's default upper bound is signed 32-bit.
        && f["detectInterval"]
            .as_u64()
            .is_some_and(|n| (1..=2_147_483_647).contains(&n))
        && f.get("sceneThreshold")
            .is_none_or(|v| finite(v, f64::MIN_POSITIVE, 1.0))
        && f["denoise"].as_f64().is_some_and(|n| n > 0.0 && n <= 1.0)
        && finite(&f["cropFactor"], 1.2, 8.0)
        && f["feather"].as_u64().is_some_and(|n| n <= 256)
        && f.get("minFace")
            .is_none_or(|n| n.as_u64().is_some_and(|n| n <= 4096))
        && f.get("subjects")
            .is_none_or(|s| s == "all" || s == "primary");
    if ok {
        Ok(())
    } else {
        Err("Invalid faceRefine block".into())
    }
}

/// Adds SAM tracking, the text-only H3 conditioning and the refine adapter behind the baseline
/// gate. Expects the house H3 ids `C`/`V`/`AV`/`N`/`Q`/`Z` in `g`; returns the refined images.
pub(crate) fn insert(
    g: &mut Value,
    images: Value,
    audio: Option<Value>,
    fps: Value,
    model: Value,
    f: &Value,
) -> Value {
    g["FRS"] =
        json!({"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":f["samCheckpoint"]}});
    g["FRT"] = json!({"class_type":"CLIPTextEncode","inputs":{"clip":["FRS",1],"text":"face"}});
    // Text-only conditioning: generation guides/references belong to the generation canvas.
    g["FRC"] = json!({"class_type":"MiniMaxH3ImageToVideo","inputs":{"clip":["C",0],"vae":["V",0],"prompt":f["prompt"],"width":768,"height":768,"length":5}});
    g["FRG"] =
        json!({"class_type":"BasicGuider","inputs":{"model":model,"conditioning":["FRC",0]}});
    // SplitSigmasDenoise runs round(steps × strength) steps: a short (distilled) schedule at a low
    // strength runs 1 or even 0. Keep the strength but give refine its own schedule with >= 2 steps.
    let strength = f["denoise"].as_f64().unwrap_or(1.0);
    let steps = g["Z"]["inputs"]["steps"].as_f64().unwrap_or(0.0);
    let sigmas = if steps > 0.0 && steps * strength < 1.5 {
        g["FRB"] = g["Z"].clone();
        g["FRB"]["inputs"]["steps"] = json!((2.0 / strength).ceil().max(steps) as u64);
        json!(["FRB", 0])
    } else {
        json!(["Z", 0])
    };
    g["FRZ"] = json!({"class_type":"SplitSigmasDenoise","inputs":{"sigmas":sigmas,"denoise":f["denoise"]}});
    let mut inputs = json!({
        "images":images,"fps":fps,"sam_model":["FRS",0],"sam_conditioning":["FRT",0],
        "detection_threshold":f["threshold"],"max_objects":f["maxObjects"],"detect_interval":f["detectInterval"],
        "scene_threshold":f.get("sceneThreshold").cloned().unwrap_or(json!(0.0)),
        "noise":["N",0],"guider":["FRG",0],"sampler":["Q",0],"sigmas":["FRZ",1],"vae":["V",0],
        "crop_factor":f["cropFactor"],"feather":f["feather"],
    });
    if let Some(n) = f.get("minFace") {
        inputs["min_face"] = n.clone();
    }
    if let Some(s) = f.get("subjects") {
        inputs["subjects"] = s.clone();
    }
    if let Some(a) = audio {
        inputs["audio"] = a;
        inputs["audio_vae"] = json!(["AV", 0]);
    }
    g["FR"] = json!({"class_type":"DEAS_H3FaceRefine","inputs":inputs});
    json!(["FR", 0])
}

/// Standalone refinement of an existing (H3-rate) video in the input folder.
pub(crate) fn compile(i: &Value) -> Result<Value, String> {
    let o = i.as_object().ok_or("Invalid h3-face-refine intent")?;
    let family = i["family"].as_str().unwrap_or_default();
    let names = [&i["model"], &i["textEncoder"], &i["vae"], &i["audioVae"]];
    let ok = o.keys().all(|k| RECIPE.contains(&k.as_str()))
        && RECIPE[..17].iter().all(|k| o.contains_key(*k))
        && i["version"].as_u64() == Some(1)
        && ["minimax-h3", "minimax-h3-hyperflow"].contains(&family)
        && names
            .iter()
            .all(|n| n.as_str().is_some_and(comfy_model_name))
        && i["sourceVideo"]
            .as_str()
            .is_some_and(|s| model_name(s) && !s.contains(['/', '[', ']']))
        && finite(&i["startSeconds"], 0.0, f64::MAX)
        && i["durationSeconds"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0)
        && i["seed"].as_u64().is_some()
        && i["steps"].as_u64().is_some_and(|n| (1..=200).contains(&n))
        && [&i["sampler"], &i["scheduler"]]
            .iter()
            .all(|s| s.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 64))
        && finite(&i["shiftVideo"], 0.01, 100.0)
        && finite(&i["shiftAudio"], 0.01, 100.0)
        && i.get("outputPrefix")
            .is_none_or(|p| p.as_str().is_some_and(safe_output_prefix))
        && i.get("output").is_none_or(crate::jobs_video::valid_output);
    if !ok {
        return Err("Invalid h3-face-refine intent".into());
    }
    validate(&i["faceRefine"])?;
    let mut g = json!({
        "1":crate::jobs_video::unet_loader(family, &i["model"]),
        "C":crate::jobs::clip_loader(&i["textEncoder"], &json!("minimax")),
        "V":{"class_type":"VAELoader","inputs":{"vae_name":i["vae"]}},
        "AV":{"class_type":"VAELoader","inputs":{"vae_name":i["audioVae"]}},
        "N":{"class_type":"RandomNoise","inputs":{"noise_seed":i["seed"]}},
        "Q":{"class_type":"KSamplerSelect","inputs":{"sampler_name":i["sampler"]}},
        "2":{"class_type":"LoadVideo","inputs":{"file":i["sourceVideo"]}},
        "W":{"class_type":"DEAS_SAM3VideoWindow","inputs":{"video":["2",0],"model":["FRS",0],
            "start_seconds":i["startSeconds"],"duration_seconds":i["durationSeconds"],
            "max_objects":i["faceRefine"]["maxObjects"],"include_audio":true}},
        "VC":{"class_type":"GetVideoComponents","inputs":{"video":["W",0]}},
    });
    let model = crate::jobs_video::h3_schedule(
        &mut g,
        json!(["1", 0]),
        family,
        i,
        &i["shiftVideo"],
        &i["shiftAudio"],
    );
    let (audio, fps) = (json!(["VC", 1]), json!(["VC", 2]));
    let refined = insert(
        &mut g,
        json!(["VC", 0]),
        Some(audio.clone()),
        fps.clone(),
        model,
        &i["faceRefine"],
    );
    gate(&mut g, refined);
    crate::jobs_video::combine(
        &mut g,
        json!(["PG", 0]),
        Some(audio.clone()),
        fps.clone(),
        i,
    );
    crate::jobs_video::baseline_combine(&mut g, json!(["VC", 0]), Some(audio), fps, i);
    Ok(g)
}

/// Baseline-first: the refine chain sits behind the gate's lazy input, after `B7` is encoded.
pub(crate) fn gate(g: &mut Value, images: Value) {
    g["PG"] = json!({"class_type":"DEAS_VideoPostprocessGate","inputs":{"baseline":["B7",1],"image":images}});
}

pub(crate) fn requirements(i: &Value) -> Vec<(&'static str, Vec<&str>)> {
    fn s(v: &Value) -> &str {
        v.as_str().unwrap_or_default()
    }
    let model = s(&i["model"]);
    let gguf = crate::jobs::is_gguf(model);
    vec![
        ("diffusionModels", if gguf { vec![] } else { vec![model] }),
        (
            "ggufDiffusionModels",
            if gguf { vec![model] } else { vec![] },
        ),
        ("textEncoders", vec![s(&i["textEncoder"])]),
        ("clipTypes", vec!["minimax"]),
        ("vaes", vec![s(&i["vae"]), s(&i["audioVae"])]),
        ("checkpoints", vec![s(&i["faceRefine"]["samCheckpoint"])]),
        ("videos", vec![s(&i["sourceVideo"])]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn block() -> Value {
        json!({"samCheckpoint":"SAM3/sam3.1_multiplex_fp16.safetensors","prompt":"a detailed face","threshold":0.5,
            "maxObjects":4,"detectInterval":1,"denoise":0.35,"cropFactor":2.5,"feather":6})
    }
    fn intent() -> Value {
        json!({"recipeId":"h3-face-refine","version":1,"family":"minimax-h3","model":"MiniMaxH3/h3.safetensors",
            "textEncoder":"qwen3vl_32b_minimax_h3_int4_convrot.safetensors","vae":"MiniMaxH3/video_vae.safetensors",
            "audioVae":"MiniMaxH3/audio_vae.safetensors","sourceVideo":"take.mp4","startSeconds":0.0,"durationSeconds":5.0,
            "seed":7,"steps":30,"sampler":"euler","scheduler":"simple","shiftVideo":12.0,"shiftAudio":3.0,"faceRefine":block()})
    }

    #[test]
    fn empty_face_prompts_reach_conditioning_without_replacement() {
        for prompt in ["", "  "] {
            let mut i = intent();
            i["faceRefine"]["prompt"] = json!(prompt);
            let g = crate::jobs::compile(&i).unwrap();
            assert_eq!(g["FRC"]["inputs"]["prompt"], json!(prompt));
            assert_eq!(g["FRT"]["inputs"]["text"], json!("face"));
        }
    }

    #[test]
    fn standalone_graph_windows_with_audio_refines_behind_baseline_gate() {
        let g = crate::jobs::compile(&intent()).unwrap();
        assert_eq!(g["W"]["inputs"]["include_audio"], json!(true));
        assert_eq!(g["W"]["inputs"]["model"], json!(["FRS", 0]));
        assert_eq!(g["FR"]["inputs"]["images"], json!(["VC", 0]));
        assert_eq!(g["FR"]["inputs"]["audio"], json!(["VC", 1]));
        assert_eq!(g["FR"]["inputs"]["audio_vae"], json!(["AV", 0]));
        assert_eq!(g["FR"]["inputs"]["fps"], json!(["VC", 2]));
        assert_eq!(g["FR"]["inputs"]["sigmas"], json!(["FRZ", 1]));
        assert_eq!(g["FR"]["inputs"]["scene_threshold"], json!(0.0));
        assert_eq!(g["FRZ"]["inputs"], json!({"sigmas":["Z",0],"denoise":0.35}));
        assert_eq!(g["FRG"]["inputs"]["model"], json!(["SS", 0]));
        assert_eq!(g["SS"]["inputs"]["model"], json!(["1", 0]));
        assert_eq!(g["FRC"]["inputs"]["prompt"], json!("a detailed face"));
        assert_eq!(
            g["PG"]["inputs"],
            json!({"baseline":["B7",1],"image":["FR",0]})
        );
        assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
        assert_eq!(g["B7"]["inputs"]["images"], json!(["VC", 0]));
        assert_eq!(g["7"]["inputs"]["audio"], json!(["VC", 1]));
        assert_eq!(g["B7"]["inputs"]["audio"], json!(["VC", 1]));
        for node in [
            "DEAS_H3FaceRefine",
            "DEAS_VideoPostprocessGate",
            "CheckpointLoaderSimple",
            "CLIPTextEncode",
            "MiniMaxH3ImageToVideo",
            "SplitSigmasDenoise",
        ] {
            assert!(g.to_string().contains(node), "{node}");
        }
        assert!(crate::jobs_video::is_video(&intent()));
        assert_eq!(
            requirements(&intent())[5],
            (
                "checkpoints",
                vec!["SAM3/sam3.1_multiplex_fp16.safetensors"]
            )
        );
    }

    /// object_info as the bundled adapter reports it on the owned backend (captured live).
    fn live_object_info() -> Value {
        json!({"DEAS_H3FaceRefine":{"input":{"required":{"images":["IMAGE"],"fps":["FLOAT",{"default":24.0,"min":0.0,"max":1000.0}],
            "sam_model":["MODEL"],"sam_conditioning":["CONDITIONING"],"detection_threshold":["FLOAT",{"default":0.5,"min":0.0,"max":1.0}],
            "max_objects":["INT",{"default":4,"min":1,"max":64}],"detect_interval":["INT",{"default":1,"min":1,"max":2147483647}],
            "scene_threshold":["FLOAT",{"default":0.0,"min":0.0,"max":1.0}],"noise":["NOISE"],"guider":["GUIDER"],"sampler":["SAMPLER"],
            "sigmas":["SIGMAS"],"vae":["VAE"],"crop_factor":["FLOAT",{"default":2.5,"min":1.2,"max":8.0}],"feather":["INT",{"default":6,"min":0,"max":256}]},
            "optional":{"audio":["AUDIO"],"audio_vae":["VAE"]}},"output":["IMAGE"]},
            "DEAS_SAM3VideoWindow":{"input":{"optional":{"include_audio":["BOOLEAN",{"default":false}]}}}})
    }

    #[test]
    fn readiness_requires_the_audio_aware_adapter_pair() {
        assert!(crate::recipe_prerequisites::face_refine_ready(
            &live_object_info()
        ));
        let mut old_window = live_object_info();
        old_window["DEAS_SAM3VideoWindow"]["input"] = json!({});
        assert!(!crate::recipe_prerequisites::face_refine_ready(&old_window));
        let mut no_audio = live_object_info();
        no_audio["DEAS_H3FaceRefine"]["input"]["optional"] = json!({});
        assert!(!crate::recipe_prerequisites::face_refine_ready(&no_audio));
        let mut changed = live_object_info();
        changed["DEAS_H3FaceRefine"]["input"]["required"]["sigmas"] = json!(["FLOAT"]);
        assert!(!crate::recipe_prerequisites::face_refine_ready(&changed));
    }

    #[test]
    fn refined_job_reports_paired_processed_then_original_not_a_mask_preview() {
        let g = compile(&intent()).unwrap();
        // History entry shape the live owned-backend run returned (DaSiWa combine `gifs`).
        let gif = |name: &str| json!({"filename":name,"subfolder":"","type":"output","format":"video/mp4"});
        let entry = json!({"outputs":{"7":{"gifs":[gif("fr_refined_00001_audio.mp4")]},"B7":{"gifs":[gif("fr_refined_original_00001_audio.mp4")]}}});
        let out = crate::jobs::job_outputs(&entry, &g).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(
            (out[0]["filename"].as_str(), out[0]["role"].as_str()),
            (Some("fr_refined_00001_audio.mp4"), Some("processed"))
        );
        assert_eq!(
            (out[1]["filename"].as_str(), out[1]["role"].as_str()),
            (
                Some("fr_refined_original_00001_audio.mp4"),
                Some("original")
            )
        );
    }

    #[test]
    fn invalid_recipes_and_blocks_fail_closed() {
        for (k, v) in [
            ("version", json!(2)),
            ("family", json!("wan")),
            ("sourceVideo", json!("nested/take.mp4")),
            ("sourceVideo", json!("take.mp4 [output]")),
            ("model", json!("../h3.safetensors")),
            ("steps", json!(0)),
            ("shiftVideo", json!(0)),
            ("durationSeconds", json!(0)),
            ("outputPrefix", json!("../x")),
            ("extra", json!(1)),
        ] {
            let mut i = intent();
            i[k] = v;
            assert!(compile(&i).is_err(), "{k}");
        }
        for (k, v) in [
            ("prompt", json!(null)),
            ("prompt", json!("x".repeat(16385))),
            ("denoise", json!(0)),
            ("denoise", json!(1.5)),
            ("cropFactor", json!(1.0)),
            ("feather", json!(257)),
            ("feather", json!(1.5)),
            ("maxObjects", json!(65)),
            ("detectInterval", json!(0)),
            ("sceneThreshold", json!(0)),
            ("threshold", json!(1.1)),
            ("samCheckpoint", json!("../sam.safetensors")),
            ("other", json!(true)),
        ] {
            let mut b = block();
            b[k] = v;
            assert!(validate(&b).is_err(), "{k}");
        }
        for k in block().as_object().unwrap().keys() {
            let mut b = block();
            b.as_object_mut().unwrap().remove(k);
            assert!(validate(&b).is_err(), "{k}");
        }
        let mut cuts = block();
        cuts["sceneThreshold"] = json!(0.3);
        assert!(validate(&cuts).is_ok());
        // Optional minimum face size: absent = refine every face, never stacked onto the node otherwise.
        for (n, ok) in [
            (json!(0), true),
            (json!(96), true),
            (json!(4097), false),
            (json!(-1), false),
            (json!(1.5), false),
        ] {
            let mut b = block();
            b["minFace"] = n.clone();
            assert_eq!(validate(&b).is_ok(), ok, "{n}");
        }
        let mut g = json!({});
        let mut b = block();
        insert(
            &mut g,
            json!(["SD", 0]),
            None,
            json!(24),
            json!(["SS", 0]),
            &b,
        );
        assert!(g["FR"]["inputs"].get("min_face").is_none());
        assert!(
            g.get("FRB").is_none(),
            "no schedule of its own without a Z to extend"
        );
        b["minFace"] = json!(96);
        insert(
            &mut g,
            json!(["SD", 0]),
            None,
            json!(24),
            json!(["SS", 0]),
            &b,
        );
        assert_eq!(g["FR"]["inputs"]["min_face"], 96);
        assert!(g["FR"]["inputs"].get("subjects").is_none());
        // Optional subject scope: absent = every tracked face; only all/primary pass.
        for (s, ok) in [
            (json!("primary"), true),
            (json!("all"), true),
            (json!("largest"), false),
            (json!(1), false),
        ] {
            let mut b = block();
            b["subjects"] = s.clone();
            assert_eq!(validate(&b).is_ok(), ok, "{s}");
        }
        b["subjects"] = json!("primary");
        insert(
            &mut g,
            json!(["SD", 0]),
            None,
            json!(24),
            json!(["SS", 0]),
            &b,
        );
        assert_eq!(g["FR"]["inputs"]["subjects"], "primary");
        // Refine runs >= 2 steps: 4 steps at 0.35 (round(1.4) = 1) get a 6-step schedule (2 run),
        // 8 steps (3 run) keep the generation schedule; strength unchanged.
        for (steps, own) in [(4, Some(6)), (8, None), (2, Some(6)), (30, None)] {
            let mut g = json!({"Z":{"class_type":"BasicScheduler","inputs":{"model":["SS",0],"scheduler":"simple","steps":steps,"denoise":1.0}}});
            insert(
                &mut g,
                json!(["SD", 0]),
                None,
                json!(24),
                json!(["SS", 0]),
                &b,
            );
            match own {
                Some(n) => {
                    assert_eq!(g["FRB"]["inputs"]["steps"], n);
                    assert_eq!(g["FRB"]["inputs"]["scheduler"], "simple");
                    assert_eq!(
                        g["FRZ"]["inputs"],
                        json!({"sigmas":["FRB",0],"denoise":0.35})
                    );
                }
                None => {
                    assert!(g.get("FRB").is_none());
                    assert_eq!(g["FRZ"]["inputs"]["sigmas"], json!(["Z", 0]));
                }
            }
        }
        b["denoise"] = json!(0.1); // 4 steps × 0.1 ran 0 steps; now 20 total, 2 run
        let mut g =
            json!({"Z":{"class_type":"HyperFlowSigmas","inputs":{"model":["1",0],"steps":4}}});
        insert(
            &mut g,
            json!(["SD", 0]),
            None,
            json!(24),
            json!(["1", 0]),
            &b,
        );
        assert_eq!(g["FRB"]["inputs"], json!({"model":["1",0],"steps":20}));
    }
}
