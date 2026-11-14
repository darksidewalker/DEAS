use super::*;
use serde_json::json;

#[test]
fn latent_upscale_baseline_first_dependency_closure() {
    fn closure(
        g: &Value,
        id: &str,
        stack: &mut Vec<String>,
        seen: &mut std::collections::BTreeSet<String>,
    ) {
        assert!(
            !stack.iter().any(|s| s == id),
            "graph cycle: {stack:?} -> {id}"
        );
        if !seen.insert(id.to_owned()) {
            return;
        }
        stack.push(id.to_owned());
        for v in g[id]["inputs"].as_object().unwrap().values() {
            if let Some(a) = v.as_array().filter(|a| a.len() == 2 && a[1].is_number()) {
                if let Some(dep) = a[0].as_str().filter(|dep| g.get(*dep).is_some()) {
                    closure(g, dep, stack, seen);
                }
            }
        }
        stack.pop();
    }
    for mode in ["none", "full", "segment"] {
        let segment = mode == "segment";
        for fixes in 0..4 {
            let mut i = h3();
            i["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":1,"denoise":0.2});
            if mode != "none" {
                i["h3"]["mode"] = json!("REF2VA");
                i["h3"]["references"] = json!([]);
                i["h3"]["media"] = json!([]);
                i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","sourceFrames":243,"capture":true,"action":"turn","outputMode":mode});
            }
            if fixes & 1 != 0 {
                i["videoPost"] = json!({"derope":{"preset":"balanced","inject":0.48}});
            }
            if fixes & 2 != 0 {
                i["faceRefine"] = face_block();
            }
            let g = compile(&i).unwrap();
            let mut baseline = std::collections::BTreeSet::new();
            closure(&g, "B7", &mut vec![], &mut baseline);
            for forbidden in ["U", "PG", "DRP", "RE", "RC"] {
                assert!(
                    !baseline.contains(forbidden),
                    "baseline pulls {forbidden}: {baseline:?}"
                );
            }
            assert!(!baseline
                .iter()
                .any(|id| g[id]["class_type"] == "DEAS_H3FaceRefine"));
            assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
            assert_eq!(g["PG"]["inputs"]["baseline"], json!(["B7", 1]));
            if segment {
                // Pack validation requires the only SegmentDecode's audio DIRECTLY on exporter 7.
                assert_eq!(g["SD"]["inputs"]["latent"], json!(["SP", 0]));
                assert_eq!(g["7"]["inputs"]["audio"], json!(["SD", 1]));
                assert_eq!(
                    g.as_object()
                        .unwrap()
                        .values()
                        .filter(|n| n["class_type"] == "DaSiWaH3ContinuitySegmentDecode")
                        .count(),
                    1
                );
            } else {
                assert_eq!(g["7"]["inputs"]["audio"], json!(["PG", 1]));
                assert_eq!(g["PG"]["inputs"]["audio"], json!(["SD", 1]));
            }
            closure(&g, "7", &mut vec![], &mut std::collections::BTreeSet::new());
        }
    }
    for passes in [1, 3] {
        let mut i = ltx();
        i["ltx"]["passes"] = json!(passes);
        if passes > 1 {
            i["ltx"]["spatialUpscaler"] = json!("ltx-spatial-upscaler.safetensors");
        }
        i["latentUpscale"] = json!({"model":"ltx-spatial-upscaler.safetensors","scale":2});
        let g = compile(&i).unwrap();
        let mut baseline = std::collections::BTreeSet::new();
        closure(&g, "B7", &mut vec![], &mut baseline);
        for forbidden in ["U", "UML", "PG"] {
            assert!(!baseline.contains(forbidden));
        }
        assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
        assert_eq!(g["PG"]["inputs"]["image"], json!(["6", 0]));
        assert_eq!(g["7"]["inputs"]["audio"], json!(["AD", 0]));
        closure(&g, "7", &mut vec![], &mut std::collections::BTreeSet::new());
    }
}

#[test]
fn enhanced_preview_patches_all_sampling_branches_and_preserves_every_other_graph_value() {
    let mut multi = ltx();
    multi["ltx"]["passes"] = json!(3);
    multi["ltx"]["spatialUpscaler"] = json!("ltx-spatial-upscaler.safetensors");
    let mut upscale = h3();
    upscale["latentUpscale"] =
        json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":3,"denoise":0.3});
    let mut hyper = h3();
    hyper["family"] = json!("minimax-h3-hyperflow");
    hyper["model"] = json!("hyperflow.gguf");
    for mut intent in [ltx(), multi, wan(), h3(), upscale, hyper] {
        let old = compile(&intent).unwrap();
        let family = intent["family"].as_str().unwrap().to_owned();
        let preview = match family.as_str() {
            "ltx-2" => json!({"decoder":"vae","model":"LTX2/taeltx2_3.safetensors"}),
            "wan" => json!({"decoder":"tiny","model":"Wan/taew2_1.safetensors"}),
            _ => json!({"decoder":"tiny","model":"taeh3.safetensors"}),
        };
        intent["enhancedPreview"] = preview.clone();
        let graph = compile(&intent).unwrap();
        assert_eq!(graph, compile(&intent).unwrap());
        let wrappers: Vec<_> = graph
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, n)| n["class_type"] == "ModelPreviewOverrideKJ")
            .collect();
        assert_eq!(wrappers.len(), if family == "wan" { 2 } else { 1 });
        for (_, node) in &wrappers {
            let p = &node["inputs"];
            assert_eq!(p["max_resolution"], 512);
            assert_eq!(p["jpeg_quality"], 80);
            assert_eq!(p["suppress_default_preview"], false);
            assert_eq!(p["preview_frames"], 120);
            assert_eq!(p["preview_fps"], 8);
            assert!(p.get("audio_vae").is_none());
            if family == "ltx-2" {
                assert_eq!(p["tiny_vae"], "none");
                assert_eq!(p["vae"], json!(["VPV", 0]));
            } else {
                assert_eq!(p["tiny_vae"], preview["model"]);
                assert!(p.get("vae").is_none());
            }
        }
        if family == "ltx-2" {
            assert_eq!(graph["VPV"]["inputs"]["vae_name"], preview["model"]);
            assert!(requirements(&intent)
                .iter()
                .any(|(k, v)| *k == "vaes" && v.contains(&"LTX2/taeltx2_3.safetensors")));
        }
        let mut restored = graph.clone();
        restored
            .as_object_mut()
            .unwrap()
            .retain(|id, _| !id.starts_with("VP"));
        for node in restored.as_object_mut().unwrap().values_mut() {
            if let Some(id) = node["inputs"]["model"][0]
                .as_str()
                .filter(|id| id.starts_with("VP"))
            {
                node["inputs"]["model"] = graph[id]["inputs"]["model"].clone();
            }
        }
        assert_eq!(
            serde_json::to_vec(&restored).unwrap(),
            serde_json::to_vec(&old).unwrap()
        );
        intent.as_object_mut().unwrap().remove("enhancedPreview");
        assert_eq!(compile(&intent).unwrap(), old);
    }
}

#[test]
fn enhanced_preview_admission_requires_exact_fresh_family_config() {
    let mut intent = h3();
    let preview = json!({"decoder":"tiny","model":"H3/taeh3.safetensors"});
    let allow = json!({"nodes":["ModelPreviewOverrideKJ"],"videoPreviews":{"minimax-h3":preview}});
    assert!(validate_preview_capability(&intent, &json!({})).is_ok());
    intent["enhancedPreview"] = preview.clone();
    assert!(validate_preview_capability(&intent, &allow).is_ok());
    assert!(validate_preview_capability(&intent, &json!({})).is_err());
    let mut wrong = allow.clone();
    wrong["videoPreviews"]["minimax-h3"]["model"] = json!("taeh3.safetensors");
    assert!(validate_preview_capability(&intent, &wrong).is_err());
    wrong = allow.clone();
    wrong["nodes"] = json!([]);
    assert!(validate_preview_capability(&intent, &wrong).is_err());
    for invalid in [
        json!(null),
        json!(false),
        json!({"decoder":"vae","model":"taeh3.safetensors"}),
        json!({"decoder":"tiny","model":"../taeh3.safetensors"}),
        json!({"decoder":"tiny","model":"taeh3.safetensors","extra":true}),
    ] {
        intent["enhancedPreview"] = invalid;
        assert!(compile(&intent).is_err());
    }
    let mut ltx = ltx();
    ltx["enhancedPreview"] = json!({"decoder":"vae","model":"LTX2/taeltx2_3.safetensors"});
    let mut allow = json!({"nodes":["ModelPreviewOverrideKJ","VAELoader"],"vaes":["LTX2/taeltx2_3.safetensors"],"videoPreviews":{"ltx-2":ltx["enhancedPreview"]}});
    assert!(validate_preview_capability(&ltx, &allow).is_ok());
    allow["vaes"] = json!([]);
    assert!(validate_preview_capability(&ltx, &allow).is_err());
    let mut wan = wan();
    wan["enhancedPreview"] = json!({"decoder":"tiny","model":"taew2_2.safetensors"});
    assert!(compile(&wan).is_err());
    wan["enhancedPreview"] = json!({"decoder":"vae","model":"lighttaew2_1.safetensors"});
    assert!(compile(&wan).is_err());
}

#[test]
fn gguf_video_models_load_via_gguf_loader_and_loras_stay_rejected() {
    for original in [ltx(), wan(), h3()] {
        let mut i = original.clone();
        i["model"] = json!("model.gguf");
        let graph = compile(&i).unwrap();
        assert_eq!(graph["1"]["class_type"], "UnetLoaderGGUF");
        assert!(graph["1"]["inputs"].get("weight_dtype").is_none());
        i["loras"] = json!([{"name":"style.safetensors","strength":0.5}]);
        assert!(compile(&i).unwrap_err().contains("LoRA on a GGUF base"));
        i["loras"] = json!([{"name":"style.gguf","strength":0.5}]);
        assert!(compile(&i).unwrap_err().contains("GGUF LoRA"));
    }
    for name in ["model.gguf", "model.GGUF"] {
        let mut i = ltx();
        i["model"] = json!(name);
        assert_eq!(compile(&i).unwrap()["1"]["class_type"], "UnetLoaderGGUF");
    }
    let mut i = wan();
    i["wan"]["lowModel"] = json!("low.gguf");
    let graph = compile(&i).unwrap();
    assert_eq!(graph["1L"]["class_type"], "UnetLoaderGGUF");
    i["loras"] = json!([{"name":"style.safetensors","strength":0.5}]);
    assert!(compile(&i).unwrap_err().contains("LoRA on a GGUF base"));
}

#[test]
fn gguf_video_encoders_and_requirements_follow_the_selected_loader() {
    for mut i in [ltx(), wan(), h3()] {
        i["textEncoder"] = json!("encoder.GGUF");
        let graph = compile(&i).unwrap();
        let dual = i["family"] == "ltx-2";
        assert_eq!(
            graph["C"]["class_type"],
            if dual {
                "DualCLIPLoaderGGUF"
            } else {
                "CLIPLoaderGGUF"
            }
        );
        let required = requirements(&i);
        let field = if dual {
            "ggufDualTextEncoders"
        } else {
            "ggufTextEncoders"
        };
        assert!(required
            .iter()
            .any(|(key, names)| *key == field && names.contains(&"encoder.GGUF")));
        if dual {
            assert!(required.iter().any(|(key, names)| *key == field
                && names.contains(&i["ltx"]["textProjection"].as_str().unwrap())));
        }
        i["vae"] = json!("vae.gguf");
        assert!(compile(&i).unwrap_err().contains("GGUF VAE"));
    }
}

#[test]
fn ref2va_continuation_uses_requested_seconds_without_new_take_frame_roundtrip() {
    let mut intent = h3();
    intent["frames"] = json!(158);
    intent["h3"]["mode"] = json!("REF2VA");
    intent["h3"]["references"] = json!([]);
    intent["h3"]["media"] = json!([]);
    intent["h3"]["continuity"] = json!({"session":"duration-test","sourceId":"parent","capture":true,"action":"turn","outputMode":"segment","durationSeconds":6.0});
    assert_eq!(compile(&intent).unwrap()["D"]["inputs"]["duration"], 6.0);
    for invalid in [
        json!(0),
        json!(-1),
        json!(15.01),
        json!("6"),
        json!(null),
        json!(true),
    ] {
        let mut bad = intent.clone();
        bad["h3"]["continuity"]["durationSeconds"] = invalid;
        assert!(compile(&bad).is_err());
    }
    let mut first = intent.clone();
    first["h3"]["continuity"]["sourceId"] = json!("");
    first["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/ref.png","slot":0}]);
    assert!(compile(&first).is_err());
    let mut frame_mode = h3();
    frame_mode["h3"]["continuity"] = intent["h3"]["continuity"].clone();
    assert!(compile(&frame_mode).is_err());
    intent["h3"]["continuity"]
        .as_object_mut()
        .unwrap()
        .remove("durationSeconds");
    assert_eq!(
        compile(&intent).unwrap()["D"]["inputs"]["duration"],
        158.0 / 24.0
    );
}

#[test]
fn windows_video_models_preserve_ids_but_inputs_stay_portable() {
    for mut i in [ltx(), wan(), h3()] {
        for key in ["model", "textEncoder", "vae"] {
            i[key] = json!(format!(
                "models\\{}",
                i[key].as_str().unwrap().replace('/', "\\")
            ));
        }
        let block = block(i["family"].as_str().unwrap());
        for key in ["textProjection", "audioVae", "lowModel"] {
            if let Some(name) = i[block][key].as_str() {
                i[block][key] = json!(name.replace('/', "\\"));
            }
        }
        i["loras"] = json!([{"name":r"styles\detail.safetensors","strength":0.55}]);
        let graph = compile(&i).unwrap();
        assert!(graph
            .as_object()
            .unwrap()
            .values()
            .any(|node| { node["inputs"]["lora_name"] == r"styles\detail.safetensors" }));
        assert!(serde_json::to_string(&graph)
            .unwrap()
            .contains(&serde_json::to_string(&i["model"]).unwrap()));
        i["firstFrame"] = json!(r"deas-inputs\image.png");
        assert!(compile(&i).is_err());
    }
}

#[test]
fn omitted_video_output_prefix_defaults_to_raw() {
    let mut intent = ltx();
    intent.as_object_mut().unwrap().remove("outputPrefix");
    intent.as_object_mut().unwrap().remove("output");
    let graph = compile(&intent).unwrap();
    assert_eq!(graph["7"]["inputs"]["filename_prefix"], "raw/video/DEAS");
    let mut explicit = intent.clone();
    explicit["outputPrefix"] = effective_output_prefix(&intent);
    explicit["output"] = effective_output(&intent);
    assert_eq!(compile(&explicit).unwrap(), graph);
}

#[test]
fn latent_post_upscale_ltx_preserves_final_pass_baseline_and_audio() {
    for passes in 1..=3 {
        let mut i = ltx();
        i["ltx"]["passes"] = json!(passes);
        if passes > 1 {
            i["ltx"]["spatialUpscaler"] = json!("old.safetensors");
        }
        let before = compile(&i).unwrap();
        i["latentUpscale"] =
            json!({"model":"post/ltx-2.3-spatial-upscaler-x2-1.1.safetensors","scale":2});
        let g = compile(&i).unwrap();
        assert_eq!(
            g["U"]["inputs"]["samples"],
            before["6"]["inputs"]["samples"]
        );
        assert_eq!(g["U"]["class_type"], "LTXVLatentUpsampler");
        assert_eq!(g["U"]["inputs"]["upscale_model"], json!(["UML", 0]));
        assert_eq!(
            g["UML"]["inputs"]["model_name"],
            "post/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
        );
        assert_eq!(g["6"]["inputs"]["samples"], json!(["U", 0]));
        assert_eq!(g["B6"], before["6"]);
        assert_eq!(g["AD"], before["AD"]);
        let mut baseline = g["7"].clone();
        baseline["inputs"]["images"] = json!(["B6", 0]);
        baseline["inputs"]["filename_prefix"] = json!("video/2026-10-18/x_original");
        assert_eq!(g["B7"], baseline);
        let required = requirements(&i);
        assert_eq!(
            required
                .iter()
                .find(|(k, _)| *k == "latentUpscaleModels")
                .unwrap()
                .1,
            if passes > 1 {
                vec![
                    "old.safetensors",
                    "post/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
                ]
            } else {
                vec!["post/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"]
            }
        );
    }
}

#[test]
fn latent_post_upscale_rejects_untrusted_intent() {
    for (mut i, options) in [
        (ltx(), json!(null)),
        (ltx(), json!({"model":"interpolation","scale":2})),
        (ltx(), json!({"model":"../bad.safetensors","scale":2})),
        (ltx(), json!({"model":"x.pt","scale":2})),
        (ltx(), json!({"model":"x.safetensors","scale":1})),
        (ltx(), json!({"model":"x.safetensors","scale":2,"steps":1})),
        (wan(), json!({"model":"x.safetensors","scale":2})),
        (
            h3(),
            json!({"model":"x.safetensors","scale":0.99,"steps":1,"denoise":0.2}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":8.01,"steps":1,"denoise":0.2}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":0,"denoise":0.2}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":101,"denoise":0.2}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":1.01}),
        ),
        (h3(), json!({"model":"x.safetensors","scale":2,"steps":1})),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"cfg":20.5}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"precision":"int8"}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"scheduler":"Simple; rm"}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"memoryBudgetMb":131073}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"guardSensitivity":1.4}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"guardMode":"any"}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"spikeGuard":"yes"}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":{"unknown":1}}),
        ),
        (
            h3(),
            json!({"model":"x.safetensors","scale":2,"steps":1,"denoise":0.2,"advanced":[]}),
        ),
    ] {
        let mut options = options;
        if options["model"] == "x.safetensors" {
            options["model"] = if i["family"] == "ltx-2" {
                json!("ltx-spatial-upscaler.safetensors")
            } else {
                json!("minimax_h3_latent_upscaler.safetensors")
            };
        }
        i["latentUpscale"] = options;
        assert!(compile(&i).is_err(), "accepted {}", i["latentUpscale"]);
    }
    for mut i in [ltx(), h3()] {
        i["latentUpscale"] = if i["family"] == "ltx-2" {
            json!({"model":"folder/ltx-spatial-upscaler.sft","scale":2})
        } else {
            json!({"model":"folder/minimax_h3_latent_upscaler.sft","scale":1,"steps":100,"denoise":0})
        };
        assert!(compile(&i).is_ok());
    }
}

#[test]
fn h3_latent_advanced_options_override_only_the_given_node_inputs() {
    let mut i = h3();
    i["latentUpscale"] =
        json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":3,"denoise":0.3});
    let plain = compile(&i).unwrap();
    i["latentUpscale"]["advanced"] = json!({
        "cfg":1.5,"scheduler":"beta","precision":"bf16","memoryBudgetMb":24000,
        "spatialTiling":false,"temporalChunking":false,"spikeGuard":true,"guardSensitivity":3.5,
        "guardStrength":0.5,"guardMode":"both","memoryPlanning":false,"memoryReservePct":10.0,
        "continuitySoftRefine":true,"continuityMaskStrength":0.25,"sharpness":4
    });
    let g = compile(&i).unwrap();
    let u = &g["U"]["inputs"];
    for (input, value) in [
        ("cfg", json!(1.5)),
        ("scheduler", json!("beta")),
        ("upscale_precision", json!("bf16")),
        ("memory_budget_mb", json!(24000)),
        ("spatial_tiling", json!(false)),
        ("temporal_chunking", json!(false)),
        ("spike_guard", json!(true)),
        ("guard_sensitivity", json!(3.5)),
        ("guard_strength", json!(0.5)),
        ("guard_mode", json!("both")),
        ("enforce_memory_budget", json!(false)),
        ("memory_reserve_pct", json!(10.0)),
        ("continuity_soft_refine", json!(true)),
        ("continuity_mask_strength", json!(0.25)),
        ("upscale_sharpness", json!(4)),
    ] {
        assert_eq!(u[input], value, "{input}");
    }
    for bad in [json!(0), json!(7), json!(2.5), json!("3")] {
        let mut b = i.clone();
        b["latentUpscale"]["advanced"] = json!({"sharpness": bad});
        assert!(compile(&b).is_err(), "sharpness {bad}");
    }
    // Refine steps/denoise stay the upscaler's own values, never the generation steps.
    assert_eq!(u["steps"], json!(3));
    assert_eq!(u["denoise"], json!(0.3));
    // Omitted advanced options keep the node defaults: an empty object compiles like none.
    i["latentUpscale"]["advanced"] = json!({});
    assert_eq!(compile(&i).unwrap(), plain);
    assert_eq!(plain["U"]["inputs"]["scheduler"], json!("simple"));
    assert_eq!(plain["U"]["inputs"]["memory_reserve_pct"], json!(5.0));
    // Packs before 0.5.47 lack the input: unchanged sharpness is never emitted.
    assert!(plain["U"]["inputs"].get("upscale_sharpness").is_none());
}

#[test]
fn latent_post_upscale_h3_wires_prepared_context_and_processed_publish() {
    let mut i = h3();
    let before = compile(&i).unwrap();
    i["latentUpscale"] = json!({"model":"h3/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors","scale":1.5,"steps":3,"denoise":0.25});
    let g = compile(&i).unwrap();
    assert_eq!(g["U"]["class_type"], "DaSiWaH3TiledUpscale");
    let inputs = &g["U"]["inputs"];
    for (key, value) in [
        ("noise", json!(["N", 0])),
        ("model", json!(["SS", 0])),
        ("conditioning", json!(["G", 0])),
        ("latent", json!(["SP", 0])),
        ("continuity_context", json!(["SP", 1])),
        ("director_guide", json!(["D", 0])),
        ("vae", json!(["V", 0])),
        ("sampler", json!(["Q", 0])),
        (
            "upscale_model",
            json!("h3/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"),
        ),
        ("scale", json!(1.5)),
        ("steps", json!(3)),
        ("denoise", json!(0.25)),
        ("seed", json!(7)),
        ("cfg", json!(1.0)),
        ("scheduler", json!("simple")),
        ("upscale_precision", json!("auto")),
        ("memory_budget_mb", json!(0)),
        ("spatial_tiling", json!(true)),
        ("temporal_chunking", json!(true)),
        ("enforce_memory_budget", json!(true)),
        ("memory_reserve_pct", json!(5.0)),
        ("continuity_soft_refine", json!(false)),
        ("continuity_mask_strength", json!(1.0)),
        ("spike_guard", json!(false)),
        ("guard_sensitivity", json!(4.3)),
        ("guard_strength", json!(1.0)),
        ("guard_mode", json!("burn_direction")),
    ] {
        assert_eq!(inputs[key], value, "{key}");
    }
    assert_eq!(g["SP"], before["SP"]);
    assert_eq!(g["BSD"], before["SD"]);
    let mut processed = before["SD"].clone();
    processed["inputs"]["latent"] = json!(["U", 0]);
    assert_eq!(g["SD"], processed);
    let mut processed_saver = before["7"].clone();
    processed_saver["inputs"]["images"] = json!(["PG", 0]);
    processed_saver["inputs"]["audio"] = json!(["PG", 1]);
    assert_eq!(g["7"], processed_saver);
    assert_eq!(g["P"], before["P"]);
    let mut baseline = before["7"].clone();
    baseline["inputs"]["images"] = json!(["BSD", 0]);
    baseline["inputs"]["audio"] = json!(["BSD", 1]);
    baseline["inputs"]["filename_prefix"] = json!("video/2026-10-18/x_original");
    assert_eq!(g["B7"], baseline);
    let required = requirements(&i);
    assert_eq!(
        required
            .iter()
            .find(|(k, _)| *k == "h3LatentUpscaleModels")
            .unwrap()
            .1,
        vec!["h3/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"]
    );
    assert!(required
        .iter()
        .find(|(k, _)| *k == "latentUpscaleModels")
        .unwrap()
        .1
        .is_empty());
}

#[test]
fn latent_post_upscale_bounds_canvas_prefix_and_h3_capture() {
    for (family, width, height, scale, ok) in [
        ("ltx-2", 4096, 4096, 2.0, false),
        ("ltx-2", 4096, 1024, 2.0, true),
        ("minimax-h3", 4096, 64, 2.00390625, true), // 8208: tie rounds down to even 8192.
        ("minimax-h3", 4096, 64, 2.01171875, false), // 8240: tie rounds up to even 8256.
        ("minimax-h3", 4096, 4096, 1.00390625, true), // Both 4112 ties round down.
        ("minimax-h3", 4096, 4096, 1.004, false),
    ] {
        let mut i = if family == "ltx-2" { ltx() } else { h3() };
        i["width"] = json!(width);
        i["height"] = json!(height);
        i["latentUpscale"] = if family == "ltx-2" {
            json!({"model":"ltx-spatial-upscaler.safetensors","scale":scale})
        } else {
            json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":scale,"steps":1,"denoise":0.2})
        };
        assert_eq!(
            compile(&i).is_ok(),
            ok,
            "{family} {width}x{height} * {scale}"
        );
    }
    let mut i = h3();
    i["latentUpscale"] =
        json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":1,"denoise":0.2});
    for capture in [false, true] {
        for mode in ["full", "segment"] {
            i["h3"]["continuity"] = json!({"session":"take","sourceId":"","action":"","capture":capture,"outputMode":mode});
            assert_eq!(compile(&i).is_ok(), !(capture && mode == "segment"));
        }
    }
    i["h3"].as_object_mut().unwrap().remove("continuity");
    for (length, ok) in [(171, true), (172, false), (180, false)] {
        i["outputPrefix"] = json!("x".repeat(length));
        assert_eq!(compile(&i).is_ok(), ok, "prefix {length}");
    }
}

#[test]
fn h3_latent_upscale_segment_capture_decodes_processed_on_core_nodes() {
    let mut i = h3();
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    i["h3"]["media"] = json!([]);
    i["latentUpscale"] =
        json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":1,"denoise":0.2});
    i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","capture":true,"action":"she turns around","outputMode":"segment"});
    // Fail closed without the pinned clip's frame count (prepare looks it up in the session list).
    assert!(compile(&i).is_err());
    i["h3"]["continuity"]["sourceFrames"] = json!(243);
    let g = compile(&i).unwrap();
    // Exactly one SegmentDecode, before upscale, supplies exact segment audio to both products.
    assert_eq!(g["SD"]["inputs"]["latent"], json!(["SP", 0]));
    assert_eq!(g["U"]["inputs"]["latent"], json!(["SP", 0]));
    assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
    assert!(
        g.get("BSD").is_none(),
        "segment capture uses exactly one SegmentDecode"
    );
    let decodes = g
        .as_object()
        .unwrap()
        .values()
        .filter(|n| n["class_type"] == "DaSiWaH3ContinuitySegmentDecode")
        .count();
    assert_eq!(decodes, 1);
    // Processed side: core decode of the upscaled window cropped to the new segment (the pinned
    // 243-frame clip starts the window at 102, frames/24 duration = 119 frames) plus its audio.
    assert_eq!(g["UD"]["inputs"]["samples"], json!(["U", 0]));
    assert_eq!(
        g["CB"]["inputs"],
        json!({"image":["UD",0],"batch_index":141,"length":119})
    );
    assert_eq!(
        g["SD"]["inputs"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["audio_vae", "context", "latent", "vae"],
        "SegmentDecode accepts no duration input"
    );
    assert_eq!(g["B7"]["inputs"]["images"], json!(["SD", 0]));
    assert_eq!(g["B7"]["inputs"]["audio"], json!(["SD", 1]));
    assert_eq!(
        g["B7"]["inputs"]["filename_prefix"],
        json!("video/2026-10-18/x_original")
    );
    assert_eq!(
        g["7"]["inputs"]["filename_prefix"],
        json!("video/2026-10-18/x")
    );
    // An authored duration snaps the crop to 17-frame steps; video sources stay fail-closed.
    i["h3"]["continuity"]["durationSeconds"] = json!(10.0);
    let g = compile(&i).unwrap();
    assert_eq!(g["CB"]["inputs"]["length"], json!(238));
    i["h3"]["continuity"]["sourceKind"] = json!("video");
    i["h3"]["continuity"]["sourceId"] = json!("0123456789abcdef".repeat(4));
    assert!(compile(&i).is_err());
}

#[test]
fn latent_post_upscale_rejects_cross_family_models_even_when_core_lists_them() {
    for (mut i, model) in [
        (
            ltx(),
            "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors",
        ),
        (ltx(), "folder/other.safetensors"),
        (ltx(), "ltx-checkpoint.safetensors"),
        (h3(), "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"),
        (h3(), "folder/other.safetensors"),
        (h3(), "minimax_h3_latent_upscaler_ltx.safetensors"),
    ] {
        i["latentUpscale"] = if i["family"] == "ltx-2" {
            json!({"model":model,"scale":2})
        } else {
            json!({"model":model,"scale":2,"steps":1,"denoise":0.2})
        };
        assert!(compile(&i).is_err(), "accepted {model}");
    }
    for (mut i, model) in [
        (ltx(), r"LTX2\ltx-2.3-spatial-upscaler-x2-1.1.safetensors"),
        (h3(), r"H3\minimax_h3_latent_upscaler_3d_conv_v1_fp16.sft"),
    ] {
        i["latentUpscale"] = if i["family"] == "ltx-2" {
            json!({"model":model,"scale":2})
        } else {
            json!({"model":model,"scale":2,"steps":1,"denoise":0.2})
        };
        assert!(compile(&i).is_ok());
    }
}

#[test]
fn tve_post_chain_runs_after_the_decode_with_a_source_rate_baseline() {
    let post = json!({"rtx":{"upscale":{"mode":"VSR","quality":"Ultra","scale":2}},"frameGeneration":{"engine":"rtx","multiplier":2,"mode":"HIGH"}});
    for (mut i, decoded, audio) in [
        (ltx(), json!(["6", 0]), Some(json!(["AD", 0]))),
        (wan(), json!(["6", 0]), None),
        (h3(), json!(["SD", 0]), Some(json!(["SD", 1]))),
    ] {
        let plain = compile(&i).unwrap();
        assert!(plain.get("PG").is_none() && plain.get("B7").is_none());
        i["videoPost"] = post.clone();
        let g = compile(&i).unwrap();
        // Baseline-first: the whole post chain is the gate's lazy input, B7's filename its eager one.
        assert_eq!(
            g["PG"],
            json!({"class_type":"DEAS_VideoPostprocessGate","inputs":{"baseline":["B7",1],"image":["PF",0]}})
        );
        assert_eq!(g["PR"]["inputs"]["images"], decoded);
        assert_eq!(g["PF"]["inputs"]["images"], json!(["PR", 0]));
        assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
        assert_eq!(
            g["7"]["inputs"]["frame_rate"],
            i["frameRate"].as_f64().unwrap() * 2.0
        );
        assert_eq!(g["B7"]["inputs"]["images"], decoded);
        assert_eq!(
            g["B7"]["inputs"]["audio"],
            audio.clone().unwrap_or(Value::Null)
        );
        assert_eq!(
            g["B7"]["inputs"]["filename_prefix"],
            "video/2026-10-18/x_original"
        );
        assert_eq!(
            g["B7"]["inputs"]["frame_rate"],
            if i["family"] == "minimax-h3" {
                json!(["D", 8])
            } else {
                i["frameRate"].clone()
            }
        );
        assert!(requirements(&i)
            .iter()
            .all(|(k, _)| *k != "frameInterpolationModels"));
        i["videoPost"] = json!({"upscaleModel":"2x.safetensors","frameGeneration":{"engine":"rife","multiplier":3,"model":"rife_v4.26.safetensors"}});
        let g = compile(&i).unwrap();
        assert_eq!(g["PM"]["inputs"]["image"], decoded);
        assert_eq!(g["PG"]["inputs"]["image"], json!(["PF", 0]));
        assert_eq!(g["PF"]["inputs"]["interp_model"], json!(["PFL", 0]));
        assert!(requirements(&i)
            .contains(&("frameInterpolationModels", vec!["rife_v4.26.safetensors"])));
        assert!(requirements(&i).contains(&("upscaleModels", vec!["2x.safetensors"])));
        i["videoPost"] = json!({});
        assert!(compile(&i).unwrap_err().contains("videoPost"));
    }
    // With a latent upscale the baseline stays the pre-upscale decode and the chain follows the upscale.
    let mut i = ltx();
    i["latentUpscale"] = json!({"model":"ltx-2.3-spatial-upscaler-x2-1.1.safetensors","scale":2});
    i["videoPost"] = json!({"rtx":{"denoise":"High"}});
    let g = compile(&i).unwrap();
    assert_eq!(g["B7"]["inputs"]["images"], json!(["B6", 0]));
    assert_eq!(
        g["PG"]["inputs"],
        json!({"baseline":["B7",1],"image":["PR",0]})
    );
    assert_eq!(g["PR"]["inputs"]["images"], json!(["6", 0]));
    assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
    assert_eq!(g["7"]["inputs"]["frame_rate"], 24);
}

#[test]
fn seamless_loop_runs_first_and_its_audio_passes_the_baseline_gate() {
    for (mut i, decoded, audio, fps) in [
        (ltx(), json!(["6", 0]), Some(json!(["AD", 0])), json!(24)),
        (wan(), json!(["6", 0]), None, wan()["frameRate"].clone()),
        (
            h3(),
            json!(["SD", 0]),
            Some(json!(["SD", 1])),
            json!(["D", 8]),
        ),
    ] {
        i["videoPost"] = json!({"rtx":{"denoise":"High"}});
        let without = compile(&i).unwrap();
        i["videoPost"]["loop"] =
            json!({"backend":"rife","model":"rife_v4.26.safetensors","audio":"beat"});
        i["videoPost"]["frameGeneration"] = json!({"engine":"rtx","multiplier":2,"mode":"HIGH"});
        let g = compile(&i).unwrap();
        let mut lp = json!({"images":decoded,"frame_rate":fps,"exact_endpoint":false,
            "interpolation_backend":"RIFE / FILM","audio_loop":"Beat-aware","model_name":"rife_v4.26.safetensors"});
        if let Some(a) = &audio {
            lp["audio"] = a.clone();
        }
        assert_eq!(
            g["LP"],
            json!({"class_type":"DaSiWa_SeamlessLoop","inputs":lp})
        );
        assert_eq!(g["PR"]["inputs"]["images"], json!(["LP", 0]));
        assert_eq!(g["PG"]["inputs"]["image"], json!(["PF", 0]));
        // Frame generation still multiplies the generation fps after the loop.
        assert_eq!(
            g["7"]["inputs"]["frame_rate"],
            i["frameRate"].as_f64().unwrap() * 2.0
        );
        // Baseline untouched: original frames and audio, not the loop's.
        assert_eq!(g["B7"], without["B7"]);
        assert_eq!(g["B7"]["inputs"]["images"], decoded);
        match &audio {
            Some(_) => {
                assert_eq!(g["PG"]["inputs"]["audio"], json!(["LP", 1]));
                assert_eq!(g["7"]["inputs"]["audio"], json!(["PG", 1]));
            }
            None => {
                assert!(g["PG"]["inputs"].get("audio").is_none());
                assert!(g["7"]["inputs"].get("audio").is_none());
            }
        }
        assert!(requirements(&i)
            .contains(&("frameInterpolationModels", vec!["rife_v4.26.safetensors"])));
        i["videoPost"]["loop"] = json!({"backend":"rtx","audio":"crossfade"});
        let g = compile(&i).unwrap();
        assert_eq!(
            g["LP"]["inputs"]["interpolation_backend"],
            "RTX Frame Generation"
        );
        assert_eq!(g["LP"]["inputs"]["audio_loop"], "Crossfade");
        assert!(g["LP"]["inputs"].get("model_name").is_none());
        assert!(requirements(&i)
            .iter()
            .all(|(k, _)| *k != "frameInterpolationModels"));
        // Loop off: graph identical to one compiled without the key at all.
        i["videoPost"].as_object_mut().unwrap().remove("loop");
        let g = compile(&i).unwrap();
        assert!(g.get("LP").is_none());
        assert_eq!(g["7"]["inputs"].get("audio"), audio.as_ref());
        assert_eq!(g["PG"]["inputs"].as_object().unwrap().len(), 2);
    }
    for bad in [
        json!({"backend":"rife","audio":"crossfade"}),
        json!({"backend":"rife","model":"../x.pth","audio":"crossfade"}),
        json!({"backend":"rtx","model":"rife_v4.26.safetensors","audio":"crossfade"}),
        json!({"backend":"rtx","audio":"loud"}),
        json!({"backend":"film","audio":"crossfade"}),
        json!({"backend":"rtx"}),
        json!({}),
    ] {
        let mut i = ltx();
        i["videoPost"] = json!({"loop":bad});
        assert!(
            compile(&i).unwrap_err().contains("videoPost.loop"),
            "{}",
            i["videoPost"]
        );
    }
    // Loop alone is a valid post chain.
    let mut i = ltx();
    i["videoPost"] = json!({"loop":{"backend":"rtx","audio":"crossfade"}});
    let g = compile(&i).unwrap();
    assert_eq!(g["PG"]["inputs"]["image"], json!(["LP", 0]));
    assert_eq!(g["7"]["inputs"]["frame_rate"], 24);
    use crate::install::Backend;
    assert!(crate::jobs_video_post::validate_rtx_hardware(&i, Some(&Backend::Amd)).is_err());
    i["videoPost"]["loop"] =
        json!({"backend":"rife","model":"rife_v4.26.safetensors","audio":"crossfade"});
    assert!(crate::jobs_video_post::validate_rtx_hardware(&i, Some(&Backend::Amd)).is_ok());
}

pub(crate) fn ltx() -> Value {
    json!({
        "recipeId":"video-generation","version":1,"family":"ltx-2",
        "positivePrompt":"a fox","negativePrompt":"text and subtitles",
        "model":"LTX2/ltx.safetensors","textEncoder":"gemma_3_12B_it_fp8.safetensors","vae":"LTX2/video_vae.safetensors",
        "seed":7,"width":1280,"height":704,"frames":121,"frameRate":24,"steps":8,"cfg":1,"sampler":"euler_cfg_pp","scheduler":"linear_quadratic",
        "outputPrefix":"video/2026-10-18/x",
        "output":{"codec":"Auto","container":"Auto","bitDepth":"Auto","quality":20,"audioCodec":"Auto","audioBitrate":"192k","saveFirstFrame":false,"saveLastFrame":false},
        "ltx":{"textProjection":"ltx-2.3_text_projection_bf16.safetensors","audioVae":"LTX2/audio_vae.safetensors","passes":1}
    })
}

pub(crate) fn wan() -> Value {
    let mut i = ltx();
    i["family"] = json!("wan");
    i.as_object_mut().unwrap().remove("ltx");
    i["model"] = json!("WAN22/high.safetensors");
    i["textEncoder"] = json!("umt5_xxl_fp8.safetensors");
    i["vae"] = json!("Wan/wan_2.1_vae.safetensors");
    i["width"] = json!(528);
    i["height"] = json!(768);
    i["frames"] = json!(81);
    i["frameRate"] = json!(16);
    i["steps"] = json!(4);
    i["sampler"] = json!("euler");
    i["firstFrame"] = json!("first.png");
    i["wan"] =
        json!({"lowModel":"WAN22/low.safetensors","shiftHigh":5,"shiftLow":5,"refinerStep":2});
    i
}

#[test]
fn h3_derope_second_pass_sits_behind_the_baseline_gate() {
    let mut i = h3();
    i["videoPost"] =
        json!({"derope":{"preset":"balanced","inject":0.48,"lora":"h3_turbo.safetensors"}});
    let g = compile(&i).unwrap();
    assert_eq!(
        g["DRP"]["inputs"],
        json!({"images":["SD",0],"samples":["SP",0],"vae":["V",0],"preset":"balanced",
            "frame_rate":i["frameRate"],"audio":["SD",1],"audio_vae":["AV",0],"conditioning":["G",0],"keep_keyframes":true})
    );
    // Turbo pass: LoRA on the shifted model, Motion Lab's 6-step beta schedule cut to the inject tail.
    assert_eq!(g["DRL"]["inputs"]["model"], json!(["SS", 0]));
    assert_eq!(
        g["DRZ"]["inputs"],
        json!({"model":["DRL",0],"scheduler":"beta","steps":6,"denoise":1.0})
    );
    assert_eq!(
        g["DRS"]["inputs"],
        json!({"sigmas":["DRZ",0],"denoise":0.48})
    );
    assert_eq!(
        g["DRK"]["inputs"],
        json!({"noise":["N",0],"guider":["DRG",0],"sampler":["Q",0],"sigmas":["DRS",1],"latent_image":["DRP",0]})
    );
    // FL2VA/L2VA keyframes carry absolute frame indices: pass 2 uses the remapped conditioning.
    assert_eq!(g["DRG"]["inputs"]["conditioning"], json!(["DRP", 3]));
    assert_eq!(
        g["DRR"]["inputs"],
        json!({"images":["DRD",0],"hold_map":["DRP",1]})
    );
    // Baseline saved first with its own frames; the result keeps the baseline audio.
    assert_eq!(
        g["PG"]["inputs"],
        json!({"baseline":["B7",1],"image":["DRR",0]})
    );
    assert_eq!(g["B7"]["inputs"]["images"], json!(["SD", 0]));
    assert_eq!(g["7"]["inputs"]["audio"], json!(["SD", 1]));
    assert!(requirements(&i).contains(&("loras", vec!["h3_turbo.safetensors"])));
    // Face refinement works on the de-roped frames, not the other way round.
    let mut both = i.clone();
    both["faceRefine"] = face_block();
    let g = compile(&both).unwrap();
    assert!(g
        .as_object()
        .unwrap()
        .values()
        .any(|n| n["class_type"] == "DEAS_H3FaceRefine"
            && n["inputs"]["images"] == json!(["DRR", 0])));

    // A turbo LoRA the generation already carries is not stacked again.
    let mut chained = i.clone();
    chained["loras"] = json!([{"name":"h3_turbo.safetensors","strength":1.0}]);
    let g = compile(&chained).unwrap();
    assert!(g.get("DRL").is_none());
    assert_eq!(g["DRZ"]["inputs"]["steps"], 6);

    // Generation model: 25 steps on the generation scheduler unless the owner marks the chain
    // distilled. The step count alone decides nothing (the fixture runs 4 steps).
    i["videoPost"]["derope"] = json!({"preset":"economy","inject":0.7});
    let g = compile(&i).unwrap();
    assert!(g.get("DRL").is_none());
    assert_eq!(
        g["DRZ"]["inputs"],
        json!({"model":["SS",0],"scheduler":"simple","steps":25,"denoise":1.0})
    );
    // Distilled: the generation chain as-is (its turbo LoRA included, never stacked) on the turbo schedule.
    i["videoPost"]["derope"]["distilled"] = json!(true);
    i["steps"] = json!(30);
    let mut with_lora = i.clone();
    with_lora["loras"] = json!([{"name":"h3_turbo.safetensors","strength":1.0}]);
    for x in [&i, &with_lora] {
        let g = compile(x).unwrap();
        assert!(g.get("DRL").is_none());
        assert_eq!(
            g["DRZ"]["inputs"],
            json!({"model":["SS",0],"scheduler":"beta","steps":6,"denoise":1.0})
        );
    }
    let g = compile(&with_lora).unwrap();
    assert_eq!(g["DRG"]["inputs"]["model"], json!(["SS", 0]));
    assert!(g
        .as_object()
        .unwrap()
        .values()
        .any(|n| n["class_type"] == "LoraLoaderModelOnly"
            && n["inputs"]["lora_name"] == "h3_turbo.safetensors"));
    for bad in [json!(false), json!("true"), json!(1)] {
        i["videoPost"]["derope"]["distilled"] = bad;
        assert!(compile(&i).is_err());
    }
    i["videoPost"]["derope"]["distilled"] = json!(true);
    i["videoPost"]["derope"]["lora"] = json!("h3_turbo.safetensors");
    assert!(
        compile(&i).is_err(),
        "a turbo LoRA pass is already distilled"
    );
    i["videoPost"]["derope"] = json!({"preset":"economy","inject":0.7});

    for (field, value) in [
        ("preset", json!("loud")),
        ("inject", json!(0.5)),
        ("lora", json!("../x.safetensors")),
        ("steps", json!(6)),
    ] {
        let mut bad = i.clone();
        bad["videoPost"]["derope"][field] = value;
        assert!(compile(&bad).unwrap_err().contains("videoPost.derope"));
    }
    let mut ltx_intent = ltx();
    ltx_intent["videoPost"] = i["videoPost"].clone();
    assert!(compile(&ltx_intent).unwrap_err().contains("derope"));
}

#[test]
fn derope_and_face_refine_run_on_the_base_decode_before_the_latent_upscale() {
    let mut i = h3();
    i["videoPost"] =
        json!({"derope":{"preset":"balanced","inject":0.48,"lora":"h3_turbo.safetensors"}});
    i["faceRefine"] = face_block();
    i["latentUpscale"] = json!({"model":"h3/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors","scale":1.5,"steps":3,"denoise":0.25});
    let g = compile(&i).unwrap();
    // Base decode of the sampled latent: the baseline and the input of both fixes.
    assert_eq!(g["BSD"]["inputs"]["latent"], json!(["SP", 0]));
    assert_eq!(g["B7"]["inputs"]["images"], json!(["BSD", 0]));
    assert_eq!(g["DRP"]["inputs"]["images"], json!(["BSD", 0]));
    assert_eq!(g["DRP"]["inputs"]["audio"], json!(["BSD", 1]));
    let (refine, _) = g
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, n)| n["class_type"] == "DEAS_H3FaceRefine")
        .unwrap();
    assert_eq!(g[refine]["inputs"]["images"], json!(["DRR", 0]));
    // Refined frames re-encoded beside the untouched audio latent, then upscaled and decoded.
    assert_eq!(
        g["RE"]["inputs"],
        json!({"pixels":[refine,0],"vae":["V",0]})
    );
    assert_eq!(g["RS"]["inputs"], json!({"av_latent":["SP",0]}));
    assert_eq!(
        g["RC"]["inputs"],
        json!({"video_latent":["RE",0],"audio_latent":["RS",1]})
    );
    assert_eq!(g["U"]["inputs"]["latent"], json!(["RC", 0]));
    assert_eq!(g["SD"]["inputs"]["latent"], json!(["U", 0]));
    // Everything after the baseline sits behind the gate, the saver's audio included.
    assert_eq!(
        g["PG"]["inputs"],
        json!({"baseline":["B7",1],"image":["SD",0],"audio":["SD",1]})
    );
    assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
    assert_eq!(g["7"]["inputs"]["audio"], json!(["PG", 1]));

    // Without a fix the upscale keeps reading the sampled latent directly.
    i.as_object_mut().unwrap().remove("faceRefine");
    i.as_object_mut().unwrap().remove("videoPost");
    let g = compile(&i).unwrap();
    assert_eq!(g["U"]["inputs"]["latent"], json!(["SP", 0]));
    assert!(g.get("RE").is_none());
}

fn continued(mode: &str) -> Value {
    let mut i = h3();
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    i["h3"]["media"] = json!([]);
    i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","capture":true,"action":"she turns around","outputMode":mode});
    i["videoPost"] =
        json!({"derope":{"preset":"balanced","inject":0.48,"lora":"h3_turbo.safetensors"}});
    i
}

#[test]
fn derope_keep_background_is_opt_in_and_uses_the_unprocessed_pass_input() {
    let mut ordinary = h3();
    ordinary["videoPost"] = json!({"derope":{"preset":"balanced","inject":0.48}});
    let mut segment = continued("segment");
    segment["h3"]["continuity"]["sourceFrames"] = json!(243);
    for base in [ordinary, continued("full"), segment] {
        for upscale in [false, true] {
            let mut i = base.clone();
            if upscale {
                i["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":1,"denoise":0.2});
            }
            let old = compile(&i).unwrap();
            i["videoPost"]["derope"]["keepBackground"] = json!(false);
            assert_eq!(compile(&i).unwrap(), old);
            i["videoPost"]["derope"]["keepBackground"] = json!(true);
            let mut on = compile(&i).unwrap();
            assert_eq!(
                on["DRR"]["inputs"]["baseline"],
                on["DRP"]["inputs"]["images"]
            );
            assert_eq!(on["DRR"]["inputs"]["keep_background"], true);
            on["DRR"]["inputs"]
                .as_object_mut()
                .unwrap()
                .remove("baseline");
            on["DRR"]["inputs"]
                .as_object_mut()
                .unwrap()
                .remove("keep_background");
            assert_eq!(on, old); // Includes Original, audio and the existing baseline-first gate.
            for bad in [json!("true"), json!(1), Value::Null] {
                i["videoPost"]["derope"]["keepBackground"] = bad;
                assert!(compile(&i).unwrap_err().contains("videoPost.derope"));
            }
        }
    }
}

#[test]
fn derope_follows_continuity_on_the_decoded_timeline() {
    // Full timeline: SegmentPrepare returns the cumulative latent and SD decodes all of it.
    let g = compile(&continued("full")).unwrap();
    assert_eq!(g["DRP"]["inputs"]["images"], json!(["SD", 0]));
    assert_eq!(g["DRP"]["inputs"]["samples"], json!(["SP", 0]));
    // A continuation's keyframes index the sampled clip, so pass 2 runs without them.
    assert_eq!(g["DRP"]["inputs"]["keep_keyframes"], false);
    assert!(g.get("BA").is_none());

    // New segment only: de-rope the whole render window, then cut back to the new segment.
    let mut i = continued("segment");
    assert!(compile(&i).unwrap_err().contains("sourceFrames"));
    assert!(needs_source_frames(&i));
    i["h3"]["continuity"]["sourceFrames"] = json!(243);
    i["faceRefine"] = face_block();
    let g = compile(&i).unwrap();
    assert_eq!(g["BA"]["inputs"]["samples"], json!(["SP", 0]));
    assert_eq!(
        g["WA"]["inputs"],
        json!({"samples":["SP",0],"vae":["AV",0]})
    );
    assert_eq!(g["DRP"]["inputs"]["images"], json!(["BA", 0]));
    assert_eq!(g["DRP"]["inputs"]["audio"], json!(["WA", 0]));
    assert_eq!(
        g["WC"]["inputs"],
        json!({"image":["DRR",0],"batch_index":141,"length":119})
    );
    let refine = g
        .as_object()
        .unwrap()
        .values()
        .find(|n| n["class_type"] == "DEAS_H3FaceRefine")
        .unwrap();
    assert_eq!(refine["inputs"]["images"], json!(["WC", 0]));
    assert_eq!(refine["inputs"]["audio"], json!(["SD", 1]));
    assert_eq!(g["B7"]["inputs"]["images"], json!(["SD", 0]));

    // With latent upscale the refined window is re-encoded; core decode/crop stays behind PG.
    i["latentUpscale"] =
        json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":1,"denoise":0.2});
    let g = compile(&i).unwrap();
    assert!(g.get("WC").is_none());
    let (refine, node) = g
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, n)| n["class_type"] == "DEAS_H3FaceRefine")
        .unwrap();
    assert_eq!(node["inputs"]["images"], json!(["DRR", 0]));
    assert_eq!(node["inputs"]["audio"], json!(["WA", 0]));
    assert_eq!(g["RE"]["inputs"]["pixels"], json!([refine, 0]));
    assert_eq!(g["U"]["inputs"]["latent"], json!(["RC", 0]));
    assert_eq!(g["CB"]["inputs"]["image"], json!(["UD", 0]));
    assert_eq!(g["7"]["inputs"]["audio"], json!(["SD", 1]));

    // Imported-video sources build their window inside SegmentPrepare: no compile-time crop.
    let mut video = continued("segment");
    video["h3"]["continuity"]["sourceKind"] = json!("video");
    video["h3"]["continuity"]["sourceFrames"] = json!(243);
    assert!(compile(&video).unwrap_err().contains("derope"));
}

pub(crate) fn h3() -> Value {
    let mut i = ltx();
    i["family"] = json!("minimax-h3");
    i.as_object_mut().unwrap().remove("ltx");
    i["model"] = json!("MiniMaxH3/fl2va.safetensors");
    i["textEncoder"] = json!("qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors");
    i["vae"] = json!("MiniMaxH3/video_vae.safetensors");
    i["width"] = json!(1024);
    i["height"] = json!(768);
    i["frames"] = json!(124);
    i["steps"] = json!(4);
    i["sampler"] = json!("euler");
    i["scheduler"] = json!("simple");
    i["h3"] = json!({"mode":"I2VA","audioVae":"MiniMaxH3/audio_vae.safetensors","shiftVideo":10,"shiftAudio":3,"references":[{"slot":0,"image":"deas-inputs/a.png"}]});
    i
}

#[test]
fn hyperflow_ref2va_and_fl2va_route_their_own_director_inputs() {
    for mode in ["REF2VA", "FL2VA"] {
        let mut i = h3();
        i["family"] = json!("minimax-h3-hyperflow");
        i["model"] = json!(format!(
            "MiniMaxH3/minimax_h3_{}_hyperflow_flash_14b-Q8_0.gguf",
            mode.to_lowercase()
        ));
        i["h3"]["mode"] = json!(mode);
        if mode == "REF2VA" {
            i["h3"]["references"] = json!([]);
            i["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
        } else {
            i["h3"]["references"] = json!([{"slot":0,"image":"deas-inputs/a.png"},{"slot":1,"image":"deas-inputs/b.png"}]);
        }
        let graph = compile(&i).unwrap();
        let inputs = &graph["D"]["inputs"];
        let socket = if mode == "REF2VA" {
            "ref2va_model"
        } else {
            "fl2va_model"
        };
        assert_eq!(inputs[socket], json!(["1", 0]));
        assert!(inputs
            .get(if mode == "REF2VA" {
                "fl2va_model"
            } else {
                "ref2va_model"
            })
            .is_none());
        assert_eq!(inputs["mode"], mode);
        assert_eq!(graph["1"]["class_type"], "HyperFlowGGUFLoader");
        if mode == "REF2VA" {
            for (kind, file) in [
                ("video", "deas-input-clip.mp4"),
                ("audio", "deas-inputs/voice.wav"),
            ] {
                let mut unsupported = i.clone();
                unsupported["h3"]["media"] = json!([
                    {"type":"image","file":"deas-inputs/a.png","slot":0},
                    {"type":kind,"file":file,"slot":0}
                ]);
                assert!(compile(&unsupported)
                    .unwrap_err()
                    .contains("image references only"));
                unsupported["family"] = json!("minimax-h3");
                unsupported["model"] = json!("MiniMaxH3/ref2va.safetensors");
                assert!(compile(&unsupported).is_ok());
            }
        }
    }
}

#[test]
fn hyperflow_flash_uses_its_own_loader_and_saved_schedule() {
    let mut i = h3();
    i["family"] = json!("minimax-h3-hyperflow");
    i["model"] = json!("MiniMaxH3/minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf");
    let graph = compile(&i).unwrap();
    assert_eq!(graph["1"]["class_type"], "HyperFlowGGUFLoader");
    assert!(graph["1"]["inputs"].get("weight_dtype").is_none());
    assert_eq!(graph["Z"]["class_type"], "HyperFlowSigmas");
    assert_eq!(graph["Z"]["inputs"]["model"], json!(["D", 5]));
    assert_eq!(graph["Z"]["inputs"]["steps"], 4);
    assert_eq!(graph["B"]["inputs"]["model"], json!(["D", 5]));
    for n in graph.as_object().unwrap().values() {
        assert_ne!(n["class_type"], "MiniMaxH3SigmaShift");
        assert_ne!(n["class_type"], "BasicScheduler");
    }
    for steps in [4u64, 6, 8] {
        let mut ok = i.clone();
        ok["steps"] = json!(steps);
        assert!(compile(&ok).is_ok(), "steps {steps}");
    }
    for bad in [3u64, 5, 7, 9] {
        let mut b = i.clone();
        b["steps"] = json!(bad);
        assert!(
            compile(&b).unwrap_err().contains("only samples 4/6/8"),
            "steps {bad}"
        );
    }
    let mut b = i.clone();
    b["sampler"] = json!("dpmpp_2m");
    assert!(compile(&b).unwrap_err().contains("runs euler only"));
    let mut safetensors = i.clone();
    safetensors["model"] = json!("MiniMaxH3/hyperflow_int8_convrot.safetensors");
    assert!(compile(&safetensors).unwrap_err().contains("GGUF only"));
    let required = requirements(&i);
    assert!(required
        .iter()
        .any(|(key, names)| *key == "ggufDiffusionModels"
            && names.contains(&"MiniMaxH3/minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf")));
    // Learned latent upscale stays unverified and fail-closed on this variant.
    let mut u = i.clone();
    u["latentUpscale"] = json!({"model":"ltxup.safetensors","scale":2,"steps":4,"denoise":0.4});
    assert!(compile(&u).is_err());
}

#[test]
fn rejects_unknown_fields_bad_grids_and_foreign_family_blocks() {
    for (key, value) in [
        ("extra", json!(1)),
        ("frames", json!(120)),
        ("width", json!(1000)),
        ("frameRate", json!(0)),
        ("chunks", json!(1)),
        ("output", json!({"codec":"H.266"})),
        (
            "wan",
            json!({"lowModel":"a","shiftHigh":5,"shiftLow":5,"refinerStep":2}),
        ),
        (
            "ltx",
            json!({"textProjection":"a","audioVae":"b","passes":2}),
        ),
        (
            "ltx",
            json!({"textProjection":"a","audioVae":"b","passes":1,"spatialUpscaler":"u"}),
        ),
    ] {
        let mut bad = ltx();
        bad[key] = value;
        assert!(compile(&bad).is_err(), "accepted {key}");
    }
    let mut missing = ltx();
    missing.as_object_mut().unwrap().remove("ltx");
    assert!(compile(&missing).is_err());
    let mut wan_bad = wan();
    wan_bad["wan"]["refinerStep"] = json!(4);
    assert!(
        compile(&wan_bad).is_err(),
        "refiner step must be below steps"
    );
    wan_bad = wan();
    wan_bad.as_object_mut().unwrap().remove("firstFrame");
    assert!(compile(&wan_bad).is_err(), "Wan needs a first frame");
    for bad in [
        json!({"mode":"REF2VA"}),
        json!({"references":[]}),
        json!({"mode":"T2VA"}),
        json!({"mode":"FL2VA","references":[{"slot":2,"image":"deas-inputs/a.png"}]}),
        json!({"references":[{"slot":0,"image":"a.png"}]}),
        json!({"continuity":{"session":"x/y","sourceId":"","capture":true,"action":"","outputMode":"full"}}),
    ] {
        let mut i = h3();
        for (k, v) in bad.as_object().unwrap() {
            i["h3"][k] = v.clone();
        }
        assert!(compile(&i).is_err(), "accepted {bad}");
    }
}

#[test]
fn ltx_single_pass_matches_omniforge_wiring() {
    let g = compile(&ltx()).unwrap();
    assert_eq!(g["1"]["class_type"], "UNETLoader");
    assert_eq!(
        g["C"]["inputs"],
        json!({"clip_name1":"gemma_3_12B_it_fp8.safetensors","clip_name2":"ltx-2.3_text_projection_bf16.safetensors","type":"ltxv"})
    );
    assert_eq!(g["AV"]["inputs"]["vae_name"], "LTX2/audio_vae.safetensors");
    assert_eq!(g["CN"]["inputs"]["frame_rate"], 24);
    assert_eq!(
        g["EL"]["inputs"],
        json!({"width":1280,"height":704,"length":121,"batch_size":1})
    );
    assert_eq!(
        g["EA"]["inputs"],
        json!({"frames_number":121,"frame_rate":24,"batch_size":1,"audio_vae":["AV",0]})
    );
    assert_eq!(
        g["CAT"]["inputs"],
        json!({"video_latent":["EL",0],"audio_latent":["EA",0]})
    );
    assert_eq!(
        g["GU"]["inputs"],
        json!({"model":["1",0],"positive":["CN",0],"negative":["CN",1],"cfg":1})
    );
    assert_eq!(
        g["Z"]["inputs"],
        json!({"model":["1",0],"scheduler":"linear_quadratic","steps":8,"denoise":1.0})
    );
    assert_eq!(
        g["5"]["inputs"],
        json!({"noise":["N",0],"guider":["GU",0],"sampler":["Q",0],"sigmas":["Z",0],"latent_image":["CAT",0]})
    );
    assert_eq!(g["SEP"]["inputs"]["av_latent"], json!(["5", 0]));
    assert_eq!(g["6"]["inputs"], json!({"samples":["SEP",0],"vae":["V",0]}));
    assert_eq!(
        g["AD"]["inputs"],
        json!({"samples":["SEP",1],"audio_vae":["AV",0]})
    );
    assert_eq!(g["7"]["class_type"], "DaSiWa_EnhancedVideoCombine");
    assert_eq!(g["7"]["inputs"]["audio"], json!(["AD", 0]));
    assert_eq!(g["7"]["inputs"]["frame_rate"], 24);
    assert_eq!(g["7"]["inputs"]["quality"], 20);
    assert_eq!(g["7"]["inputs"]["filename_prefix"], "video/2026-10-18/x");
    assert!(g.get("G1").is_none() && g.get("CR").is_none());
    for n in g.as_object().unwrap().values() {
        assert!(
            VIDEO_NODES.contains(&n["class_type"].as_str().unwrap())
                || ["UNETLoader", "VAELoader", "CLIPTextEncode", "VAEDecode"]
                    .contains(&n["class_type"].as_str().unwrap()),
            "{n}"
        );
    }
}

#[test]
fn ltx_guides_chunking_loras_and_tiled_decode() {
    let mut i = ltx();
    i["firstFrame"] = json!("a.png");
    i["lastFrame"] = json!("b.png [output]");
    i["chunks"] = json!(3);
    i["loras"] = json!([{"name":"LTX2/x.safetensors","strength":0.55}]);
    i["options"] = json!({"attention":"comfy kitchen attention","vaeTile":512});
    let g = compile(&i).unwrap();
    assert_eq!(g["8"]["inputs"]["image"], "a.png");
    assert_eq!(
        g["8S"]["inputs"],
        json!({"image":["8",0],"upscale_method":"lanczos","width":1280,"height":704,"crop":"center"})
    );
    assert_eq!(
        g["8P"]["inputs"],
        json!({"image":["8S",0],"img_compression":18})
    );
    assert_eq!(
        g["G1"]["inputs"],
        json!({"positive":["CN",0],"negative":["CN",1],"vae":["V",0],"latent":["EL",0],"image":["8P",0],"frame_idx":0,"strength":1.0})
    );
    assert_eq!(g["G2"]["inputs"]["latent"], json!(["G1", 2]));
    assert_eq!(g["G2"]["inputs"]["frame_idx"], -1);
    assert_eq!(g["CAT"]["inputs"]["video_latent"], json!(["G2", 2]));
    assert_eq!(g["GU"]["inputs"]["positive"], json!(["G2", 0]));
    assert_eq!(
        g["CR"]["inputs"],
        json!({"positive":["G2",0],"negative":["G2",1],"latent":["SEP",0]})
    );
    assert_eq!(g["6"]["class_type"], "VAEDecodeTiled");
    assert_eq!(g["6"]["inputs"]["samples"], json!(["CR", 2]));
    assert_eq!(g["6"]["inputs"]["tile_size"], 512);
    assert_eq!(g["L1"]["inputs"]["model"], json!(["1", 0]));
    assert_eq!(g["L1"]["inputs"]["clip"], json!(["C", 0]));
    assert_eq!(g["A"]["inputs"]["model"], json!(["L1", 0]));
    assert_eq!(
        g["H"],
        json!({"class_type":"LTXVChunkFeedForward","inputs":{"model":["A",0],"chunks":3,"dim_threshold":4096}})
    );
    assert_eq!(g["GU"]["inputs"]["model"], json!(["H", 0]));
    assert_eq!(g["Z"]["inputs"]["model"], json!(["H", 0]));
    assert_eq!(g["2"]["inputs"]["clip"], json!(["L1", 1]));
    let req = requirements(&i);
    assert_eq!(
        req.iter().find(|(k, _)| *k == "images").unwrap().1,
        vec!["a.png"]
    );
    assert_eq!(
        req.iter().find(|(k, _)| *k == "textEncoders").unwrap().1,
        vec![
            "gemma_3_12B_it_fp8.safetensors",
            "ltx-2.3_text_projection_bf16.safetensors"
        ]
    );
}

#[test]
fn ltx_multipass_upsamples_the_latent_and_readds_guides() {
    let mut i = ltx();
    i["firstFrame"] = json!("a.png");
    i["ltx"]["passes"] = json!(3);
    i["ltx"]["spatialUpscaler"] = json!("ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
    let g = compile(&i).unwrap();
    assert_eq!(g["EL"]["inputs"]["width"], 640);
    assert_eq!(g["EL"]["inputs"]["height"], 352);
    assert_eq!(
        g["8H"]["inputs"],
        json!({"image":["8P",0],"upscale_method":"lanczos","width":640,"height":352,"crop":"disabled"})
    );
    assert_eq!(g["G1"]["inputs"]["image"], json!(["8H", 0]));
    assert_eq!(
        g["UP"]["inputs"],
        json!({"samples":["CR",2],"upscale_model":["UL",0],"vae":["V",0]})
    );
    assert_eq!(g["G1b"]["inputs"]["latent"], json!(["UP", 0]));
    assert_eq!(g["G1b"]["inputs"]["image"], json!(["8P", 0]));
    assert_eq!(
        g["CATb"]["inputs"],
        json!({"video_latent":["G1b",2],"audio_latent":["SEP",1]})
    );
    assert_eq!(g["Zb"]["inputs"]["steps"], 4);
    assert_eq!(g["Zb"]["inputs"]["denoise"], 0.4);
    assert_eq!(g["G1c"]["inputs"]["latent"], json!(["CRb", 2]));
    assert_eq!(g["CATc"]["inputs"]["audio_latent"], json!(["SEPb", 1]));
    assert_eq!(g["Zc"]["inputs"]["steps"], 2);
    assert_eq!(g["6"]["inputs"]["samples"], json!(["CRc", 2]));
    assert_eq!(g["AD"]["inputs"]["samples"], json!(["SEPc", 1]));
    i["ltx"]["passes"] = json!(2);
    let g = compile(&i).unwrap();
    assert!(g.get("Zc").is_none());
    assert_eq!(g["6"]["inputs"]["samples"], json!(["CRb", 2]));
    assert_eq!(
        requirements(&i)
            .iter()
            .find(|(k, _)| *k == "latentUpscaleModels")
            .unwrap()
            .1,
        vec!["ltx-2.3-spatial-upscaler-x2-1.1.safetensors"]
    );
}

#[test]
fn wan_high_low_split_matches_fastfidelity() {
    let g = compile(&wan()).unwrap();
    assert_eq!(g["1"]["inputs"]["unet_name"], "WAN22/high.safetensors");
    assert_eq!(g["1L"]["inputs"]["unet_name"], "WAN22/low.safetensors");
    assert_eq!(
        g["C"]["inputs"],
        json!({"clip_name":"umt5_xxl_fp8.safetensors","type":"wan"})
    );
    assert_eq!(
        g["SH"],
        json!({"class_type":"ModelSamplingSD3","inputs":{"model":["1",0],"shift":5}})
    );
    assert_eq!(g["SL"]["inputs"]["model"], json!(["1L", 0]));
    assert_eq!(g["W"]["class_type"], "WanImageToVideo");
    assert_eq!(g["W"]["inputs"]["start_image"], json!(["8S", 0]));
    assert_eq!(g["W"]["inputs"]["length"], 81);
    assert_eq!(
        g["KH"]["inputs"],
        json!({"model":["SH",0],"add_noise":"enable","noise_seed":7,"steps":4,"cfg":1,"sampler_name":"euler","scheduler":"linear_quadratic","positive":["W",0],"negative":["W",1],"latent_image":["W",2],"start_at_step":0,"end_at_step":2,"return_with_leftover_noise":"enable"})
    );
    assert_eq!(g["KL"]["inputs"]["add_noise"], "disable");
    assert_eq!(g["KL"]["inputs"]["latent_image"], json!(["KH", 0]));
    assert_eq!(g["KL"]["inputs"]["start_at_step"], 2);
    assert_eq!(g["KL"]["inputs"]["end_at_step"], 10000);
    assert_eq!(g["6"]["inputs"]["samples"], json!(["KL", 0]));
    assert!(g["7"]["inputs"].get("audio").is_none());
    let mut flf = wan();
    flf["lastFrame"] = json!("last.png");
    flf["chunks"] = json!(2);
    let g = compile(&flf).unwrap();
    assert_eq!(g["W"]["class_type"], "WanFirstLastFrameToVideo");
    assert_eq!(g["W"]["inputs"]["end_image"], json!(["9S", 0]));
    assert_eq!(g["H"]["class_type"], "WanChunkFeedForward");
    assert_eq!(g["lH"]["inputs"]["model"], json!(["1L", 0]));
    assert_eq!(g["SL"]["inputs"]["model"], json!(["lH", 0]));
    assert_eq!(
        requirements(&flf)
            .iter()
            .find(|(k, _)| *k == "diffusionModels")
            .unwrap()
            .1,
        vec!["WAN22/high.safetensors", "WAN22/low.safetensors"]
    );
}

#[test]
fn h3_drives_director_guide_segment_nodes_and_publish() {
    let g = compile(&h3()).unwrap();
    assert_eq!(
        g["C"]["inputs"],
        json!({"clip_name":"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors","type":"minimax"})
    );
    let d = &g["D"];
    assert_eq!(d["class_type"], "MiniMaxH3Director");
    assert_eq!(d["inputs"]["mode"], "I2VA");
    assert_eq!(d["inputs"]["prompt"], "a fox");
    assert_eq!(d["inputs"]["duration"], 124.0 / 24.0);
    assert_eq!(d["inputs"]["frame_rate"], 24);
    assert_eq!(d["inputs"]["fl2va_model"], json!(["1", 0]));
    assert!(d["inputs"].get("ref2va_model").is_none());
    let timeline: Value =
        serde_json::from_str(d["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        timeline["items"],
        json!([{"id":"ref0","type":"image","value":"deas-inputs/a.png","slot":0,"order":0,"enabled":true}])
    );
    assert_eq!(timeline["resolution"]["input_scaling"], "Fill and crop");
    // The Director's input scaling is optional, from its fixed list only.
    let mut scaled = h3();
    scaled["h3"]["inputScaling"] = json!("Long side with divisible crop");
    let g = compile(&scaled).unwrap();
    let timeline: Value =
        serde_json::from_str(g["D"]["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        timeline["resolution"]["input_scaling"],
        "Long side with divisible crop"
    );
    for bad in [json!("fill and crop"), json!(""), json!(1)] {
        scaled["h3"]["inputScaling"] = bad;
        assert!(compile(&scaled).is_err());
    }
    assert_eq!(
        timeline["continuity"],
        json!({"version":3,"session":"deas","capture":false,"output_mode":"full"})
    );
    assert_eq!(
        g["G"]["inputs"],
        json!({"clip":["C",0],"vae":["V",0],"guide":["D",0],"audio_vae":["AV",0]})
    );
    assert_eq!(
        g["SS"]["inputs"],
        json!({"model":["D",5],"shift_video":10,"shift_audio":3})
    );
    assert_eq!(
        g["B"]["inputs"],
        json!({"model":["SS",0],"conditioning":["G",0]})
    );
    assert_eq!(g["Z"]["inputs"]["model"], json!(["SS", 0]));
    assert_eq!(g["5"]["inputs"]["latent_image"], json!(["G", 1]));
    assert_eq!(
        g["SP"]["inputs"],
        json!({"sampled":["5",0],"context":["G",2]})
    );
    assert_eq!(
        g["SD"]["inputs"],
        json!({"latent":["SP",0],"vae":["V",0],"audio_vae":["AV",0],"context":["SP",1]})
    );
    assert_eq!(g["7"]["inputs"]["images"], json!(["SD", 0]));
    assert_eq!(g["7"]["inputs"]["audio"], json!(["SD", 1]));
    assert_eq!(g["7"]["inputs"]["frame_rate"], json!(["D", 8]));
    assert_eq!(
        g["P"]["inputs"],
        json!({"filename":["7",1],"ticket":["SP",2]})
    );
    assert!(g.get("3").is_none(), "H3 has no negative prompt");
    assert_eq!(
        requirements(&h3())
            .iter()
            .find(|(k, _)| *k == "images")
            .unwrap()
            .1,
        vec!["deas-inputs/a.png"]
    );
    // Continuity: a planned first take captures; later steps pin the previous clip and send new seconds.
    let mut c = h3();
    c["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"","capture":true,"action":"","outputMode":"segment"});
    let t: Value = serde_json::from_str(
        compile(&c).unwrap()["D"]["inputs"]["timeline_data"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        t["continuity"],
        json!({"version":3,"session":"deas-ab12cd34","capture":true,"output_mode":"segment"})
    );
    c["h3"]["continuity"]["sourceId"] = json!("clip_1");
    c["h3"]["continuity"]["action"] = json!("she turns around");
    let t: Value = serde_json::from_str(
        compile(&c).unwrap()["D"]["inputs"]["timeline_data"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        t["continuity"],
        json!({"version":3,"session":"deas-ab12cd34","source_kind":"checkpoint","source_id":"clip_1","capture":true,"output_mode":"segment","continuation_prompt":"she turns around"})
    );
}

#[test]
fn h3_continuity_video_maps_only_source_fields_for_all_options() {
    let mut i = h3();
    let source = "0123456789abcdef".repeat(4);
    for capture in [false, true] {
        for output in ["full", "segment"] {
            for overlap in [None, Some(73), Some(56), Some(39), Some(22), Some(5)] {
                i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":source,"capture":capture,"action":"she turns around","outputMode":output});
                if let Some(frames) = overlap {
                    i["h3"]["continuity"]["overlapFrames"] = json!(frames);
                }
                let baseline = compile(&i).unwrap();
                let mut expected = baseline.clone();
                let mut timeline: Value = serde_json::from_str(
                    baseline["D"]["inputs"]["timeline_data"].as_str().unwrap(),
                )
                .unwrap();
                timeline["continuity"]["source_kind"] = json!("video");
                timeline["continuity"]
                    .as_object_mut()
                    .unwrap()
                    .remove("source_id");
                timeline["continuity"]["source_video_id"] = json!(source);
                expected["D"]["inputs"]["timeline_data"] = json!(timeline.to_string());
                i["h3"]["continuity"]["sourceKind"] = json!("video");
                assert_eq!(compile(&i).unwrap(), expected);
                i["h3"]["continuity"]
                    .as_object_mut()
                    .unwrap()
                    .remove("sourceKind");
                assert_eq!(compile(&i).unwrap(), baseline);
            }
        }
    }
}

#[test]
fn h3_continuity_source_kind_and_video_ids_are_strict() {
    let mut i = h3();
    for source in [
        "",
        "clip_1",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ] {
        i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":source,"capture":true,"action":"","outputMode":"segment"});
        let baseline = compile(&i).unwrap();
        for kind in [
            json!(null),
            json!(false),
            json!(42),
            json!([]),
            json!({}),
            json!("checkpoint"),
            json!("Video"),
            json!(""),
        ] {
            i["h3"]["continuity"]["sourceKind"] = kind.clone();
            assert!(compile(&i).is_err(), "accepted sourceKind={kind}");
        }
        i["h3"]["continuity"]
            .as_object_mut()
            .unwrap()
            .remove("sourceKind");
        assert_eq!(compile(&i).unwrap(), baseline);
    }
    i["h3"]["continuity"]["sourceKind"] = json!("video");
    for source in [
        json!(""),
        json!("clip_1"),
        json!("a".repeat(63)),
        json!("a".repeat(65)),
        json!("A".repeat(64)),
        json!("g".repeat(64)),
        json!("é".repeat(32)),
        json!(null),
        json!(42),
        json!(false),
        json!([]),
        json!({}),
    ] {
        i["h3"]["continuity"]["sourceId"] = source.clone();
        assert!(compile(&i).is_err(), "accepted video sourceId={source}");
    }
}

#[test]
fn h3_continuity_rejects_reserved_session_only() {
    let mut i = h3();
    for source in ["", "clip_1", "_imports"] {
        i["h3"]["continuity"] = json!({"session":"_imports","sourceId":source,"capture":true,"action":"","outputMode":"segment"});
        assert!(validate(&i).is_err(), "accepted reserved session");
        assert!(compile(&i).is_err(), "compiled reserved session");
    }
    assert!(continuity_id("_imports"), "clip IDs are not session names");
}

#[test]
fn h3_continuity_identifier_contract_preserves_valid_graphs() {
    let mut i = h3();
    i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","capture":true,"action":"","outputMode":"segment"});
    let baseline = compile(&i).unwrap();
    let timeline: Value =
        serde_json::from_str(baseline["D"]["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
    for id in [
        "a",
        "_",
        "-",
        "123",
        "My_session-42",
        "_imports2",
        "_IMPORTS",
        &"a".repeat(80),
    ] {
        for source in ["", "clip_1", "_imports", id] {
            i["h3"]["continuity"]["session"] = json!(id);
            i["h3"]["continuity"]["sourceId"] = json!(source);
            let mut expected = baseline.clone();
            let mut timeline = timeline.clone();
            timeline["continuity"]["session"] = json!(id);
            if source.is_empty() {
                for key in ["source_kind", "source_id", "continuation_prompt"] {
                    timeline["continuity"].as_object_mut().unwrap().remove(key);
                }
            } else {
                timeline["continuity"]["source_id"] = json!(source);
            }
            expected["D"]["inputs"]["timeline_data"] = json!(timeline.to_string());
            assert_eq!(
                compile(&i).unwrap(),
                expected,
                "session={id}, sourceId={source}"
            );
        }
    }
    for field in ["session", "sourceId"] {
        for bad in [
            "a/b",
            "a\\b",
            "..",
            "a.b",
            "a b",
            " a",
            "a ",
            "é",
            "a\n",
            "a\0",
            &"a".repeat(81),
        ] {
            i["h3"]["continuity"]["session"] = json!("deas-ab12cd34");
            i["h3"]["continuity"]["sourceId"] = json!("clip_1");
            i["h3"]["continuity"][field] = json!(bad);
            assert!(compile(&i).is_err(), "accepted {field}={bad:?}");
        }
    }
    i["h3"]["continuity"]["session"] = json!("");
    i["h3"]["continuity"]["sourceId"] = json!("");
    assert!(compile(&i).is_err(), "accepted empty session");
}

#[test]
fn h3_continuity_overlap_frames_maps_only_explicit_checkpoint_options() {
    let mut i = h3();
    i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","capture":true,"action":"she turns around","outputMode":"segment"});
    let omitted = compile(&i).unwrap();
    let timeline: Value =
        serde_json::from_str(omitted["D"]["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        timeline["continuity"],
        json!({"version":3,"session":"deas-ab12cd34","source_kind":"checkpoint","source_id":"clip_1","capture":true,"output_mode":"segment","continuation_prompt":"she turns around"})
    );
    for frames in [73, 56, 39, 22, 5] {
        i["h3"]["continuity"]["overlapFrames"] = json!(frames);
        let mut expected = omitted.clone();
        let mut timeline = timeline.clone();
        timeline["continuity"]["overlap_frames"] = json!(frames);
        expected["D"]["inputs"]["timeline_data"] = json!(timeline.to_string());
        assert_eq!(compile(&i).unwrap(), expected, "overlapFrames={frames}");
    }
    i["h3"]["continuity"]
        .as_object_mut()
        .unwrap()
        .remove("overlapFrames");
    assert_eq!(compile(&i).unwrap(), omitted);

    i["h3"]["continuity"]["sourceId"] = json!("");
    let first_capture = compile(&i).unwrap();
    for frames in [73, 56, 39, 22, 5] {
        i["h3"]["continuity"]["overlapFrames"] = json!(frames);
        assert_eq!(
            compile(&i).unwrap(),
            first_capture,
            "first capture overlapFrames={frames}"
        );
    }
}

#[test]
fn h3_continuity_overlap_frames_rejects_malformed_values_and_unknown_keys() {
    let mut i = h3();
    for source in ["", "clip_1"] {
        i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":source,"capture":true,"action":"","outputMode":"segment"});
        for bad in [
            json!(null),
            json!(true),
            json!(false),
            json!("22"),
            json!(22.0),
            json!(22.5),
            json!(-1),
            json!(0),
            json!(4),
            json!(6),
            json!(21),
            json!(23),
            json!(38),
            json!(40),
            json!(55),
            json!(57),
            json!(72),
            json!(74),
            json!(u64::MAX),
            json!([]),
            json!({}),
        ] {
            i["h3"]["continuity"]["overlapFrames"] = bad.clone();
            assert!(
                compile(&i).is_err(),
                "accepted overlapFrames={bad}, sourceId={source}"
            );
        }
        i["h3"]["continuity"]["overlapFrames"] = json!(22);
        for key in ["unknown", "overlap_frames", "sourceKind"] {
            i["h3"]["continuity"][key] = json!(true);
            assert!(compile(&i).is_err(), "accepted continuity.{key}");
            i["h3"]["continuity"].as_object_mut().unwrap().remove(key);
        }
    }
}

#[test]
fn ltx_video_to_video_guides_the_trimmed_source_and_keyframes_at_their_frames() {
    let mut i = ltx();
    i["sourceVideo"] = json!("deas-input-1.mp4");
    i["ltx"]["sourceStrength"] = json!(0.8);
    i["ltx"]["keyframes"] = json!([{"image":"b.png","frame":48,"strength":0.6},{"image":"c.png [output]","frame":-1,"strength":1}]);
    let g = compile(&i).unwrap();
    assert_eq!(
        g["SV"],
        json!({"class_type":"LoadVideo","inputs":{"file":"deas-input-1.mp4"}})
    );
    assert_eq!(
        g["SVT"]["inputs"],
        json!({"image":["SVC",0],"batch_index":0,"length":121})
    );
    assert_eq!(g["SVS"]["inputs"]["crop"], "center");
    assert_eq!(
        g["SVP"]["inputs"],
        json!({"image":["SVS",0],"img_compression":18})
    );
    // Source first, then keyframes in order, each chained into the next guide.
    let guide = |n: &str| {
        (
            g[n]["inputs"]["image"].clone(),
            g[n]["inputs"]["frame_idx"].clone(),
            g[n]["inputs"]["strength"].clone(),
        )
    };
    assert_eq!(guide("G1"), (json!(["SVP", 0]), json!(0), json!(0.8)));
    assert_eq!(guide("G2"), (json!(["K1P", 0]), json!(48), json!(0.6)));
    assert_eq!(guide("G3"), (json!(["K2P", 0]), json!(-1), json!(1.0)));
    assert_eq!(g["G2"]["inputs"]["latent"], json!(["G1", 2]));
    assert_eq!(g["K2"]["inputs"]["image"], "c.png [output]");
    assert_eq!(g["CR"]["class_type"], "LTXVCropGuides");
    // Multipass: half-size copies for pass 1, full guides re-added in pass 2.
    i["ltx"]["passes"] = json!(2);
    i["ltx"]["spatialUpscaler"] = json!("up.safetensors");
    let g = compile(&i).unwrap();
    assert_eq!(g["G1"]["inputs"]["image"], json!(["SVH", 0]));
    assert_eq!(g["G1b"]["inputs"]["image"], json!(["SVP", 0]));
    assert_eq!(g["G3b"]["inputs"]["strength"], json!(1.0));
    let req = requirements(&i);
    assert_eq!(
        req.iter().find(|r| r.0 == "images").unwrap().1,
        vec!["b.png"]
    );
    for (path, value) in [
        ("sourceVideo", json!("sub/a.mp4")),
        ("sourceStrength", json!(1.5)),
        ("keyframes", json!([])),
        (
            "keyframes",
            json!([{"image":"b.png","frame":121,"strength":1}]),
        ),
        (
            "keyframes",
            json!([{"image":"../b.png","frame":0,"strength":1}]),
        ),
    ] {
        let mut bad = i.clone();
        if path == "sourceVideo" {
            bad[path] = value
        } else {
            bad["ltx"][path] = value
        }
        assert!(compile(&bad).is_err(), "accepted {path}");
    }
    let mut lone = ltx();
    lone["ltx"]["sourceStrength"] = json!(1);
    assert!(compile(&lone).is_err(), "strength without a source video");
    let mut foreign = h3();
    foreign["sourceVideo"] = json!("deas-input-1.mp4");
    assert!(compile(&foreign).is_err(), "sourceVideo is LTX only");
}

#[test]
fn h3_ref2va_puts_images_videos_and_audio_on_the_director_timeline() {
    let mut i = h3();
    i["model"] = json!("MiniMaxH3/ref2va_turbo.safetensors");
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    i["h3"]["media"] = json!([
        {"type":"image","file":"deas-inputs/a.png","slot":0},
        {"type":"video","file":"deas-input-v.mp4","slot":0,"mediaMode":"video_audio","trimStart":1,"trimEnd":6},
        {"type":"audio","file":"deas-inputs/s.wav","slot":1}
    ]);
    let g = compile(&i).unwrap();
    let d = &g["D"]["inputs"];
    assert_eq!(d["mode"], "REF2VA");
    assert_eq!(d["ref2va_model"], json!(["1", 0]));
    assert!(d.get("fl2va_model").is_none());
    let t: Value = serde_json::from_str(d["timeline_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        t["items"],
        json!([
            {"id":"m0","type":"image","value":"deas-inputs/a.png","slot":0,"order":0,"enabled":true},
            {"id":"m1","type":"video","value":"deas-input-v.mp4","slot":0,"order":1,"enabled":true,"media_mode":"video_audio","trim_start":1,"trim_end":6},
            {"id":"m2","type":"audio","value":"deas-inputs/s.wav","slot":1,"order":2,"enabled":true}
        ])
    );
    let req = requirements(&i);
    assert_eq!(
        req.iter().find(|r| r.0 == "images").unwrap().1,
        vec!["deas-inputs/a.png"]
    );
    let item = |v: Value| json!([v]);
    for media in [
        json!([]),
        item(json!({"type":"audio","file":"deas-inputs/s.wav","slot":0})), // audio alone
        item(json!({"type":"image","file":"a.png","slot":0})),             // not uploaded
        item(json!({"type":"image","file":"deas-inputs/a.png","slot":9})), // lane has 0..8
        item(json!({"type":"image","file":"deas-inputs/a.png","slot":0,"trimStart":1})),
        item(json!({"type":"video","file":"deas-input-v.mp4","slot":0,"mediaMode":"loop"})),
        item(json!({"type":"video","file":"deas-input-v.mp4","slot":0,"trimStart":5,"trimEnd":2})),
        json!([{"type":"image","file":"deas-inputs/a.png","slot":0},{"type":"image","file":"deas-inputs/b.png","slot":0}]),
        json!((0..4)
            .map(|n| json!({"type":"video","file":"deas-input-v.mp4","slot":n}))
            .collect::<Vec<_>>()),
    ] {
        let mut bad = i.clone();
        bad["h3"]["media"] = media.clone();
        assert!(compile(&bad).is_err(), "accepted {media}");
    }
    let mut cont = i.clone();
    cont["h3"]["continuity"] =
        json!({"session":"s1","sourceId":"clip_1","capture":false,"action":"","outputMode":"full"});
    assert!(compile(&cont).is_ok(), "REF2VA continuation");
    let mut stray = h3();
    stray["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
    assert!(compile(&stray).is_err(), "media outside REF2VA");
}

#[test]
fn h3_reference_crop_limits_match_director_stream_totals() {
    let mut intent = h3();
    intent["h3"]["mode"] = json!("REF2VA");
    intent["h3"]["references"] = json!([]);
    for end in [1.0, 15.1] {
        intent["h3"]["media"] =
            json!([{"type":"video","file":"deas-input-v.mp4","slot":0,"trimEnd":end}]);
        assert!(compile(&intent).is_err());
    }
    intent["h3"]["media"] = json!([
        {"type":"video","file":"deas-input-v.mp4","slot":0,"mediaMode":"video_audio","trimEnd":10},
        {"type":"audio","file":"deas-inputs/a.wav","slot":0,"trimEnd":6}
    ]);
    assert!(compile(&intent).is_err());
    intent["h3"]["media"][0]["mediaMode"] = json!("video");
    assert!(compile(&intent).is_ok());
    let mut media: Vec<Value> = (0..9)
        .map(|n| json!({"type":"image","file":"deas-inputs/a.png","slot":n}))
        .collect();
    media
        .push(json!({"type":"video","file":"deas-input-v.mp4","slot":0,"mediaMode":"video_audio"}));
    media.push(json!({"type":"audio","file":"deas-inputs/a.wav","slot":0}));
    intent["h3"]["media"] = json!(media);
    assert!(compile(&intent).is_ok());
    media.push(json!({"type":"audio","file":"deas-inputs/b.wav","slot":1}));
    intent["h3"]["media"] = json!(media);
    assert!(compile(&intent).is_err());
}

/// `cargo test --lib dump_video_graphs -- --ignored --nocapture` prints the three graphs for an offline
/// `execution.validate_prompt` run against the real ComfyUI checkout (see the deas-development skill).
#[test]
#[ignore]
fn dump_video_graphs() {
    let mut l = ltx();
    l["firstFrame"] = json!("ref.png");
    l["ltx"]["passes"] = json!(2);
    l["ltx"]["spatialUpscaler"] = json!("ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
    let mut w = wan();
    w["lastFrame"] = json!("ref.png");
    w["chunks"] = json!(2);
    let mut v2v = ltx();
    v2v["sourceVideo"] = json!("source.mp4");
    v2v["ltx"]["sourceStrength"] = json!(0.8);
    v2v["ltx"]["keyframes"] = json!([{"image":"ref.png","frame":48,"strength":0.6}]);
    let mut r = h3();
    r["h3"]["mode"] = json!("REF2VA");
    r["h3"]["references"] = json!([]);
    r["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0},{"type":"video","file":"deas-input-source.mp4","slot":0,"mediaMode":"video"}]);
    let mut hf = h3();
    hf["family"] = json!("minimax-h3-hyperflow");
    hf["model"] = json!("MiniMaxH3/hyperflow_flash.gguf");
    hf["steps"] = json!(6);
    hf["h3"]["references"] = json!([]);
    hf["h3"]["mode"] = json!("T2VA");
    let mut regen = regenerate_intent();
    regen["loras"] = json!([]);
    regen.as_object_mut().unwrap().remove("options");
    let mut regen_fixes = regen.clone();
    regen_fixes["latentUpscale"]["regenerate"]["model"] =
        json!("MiniMaxH3/minimax_h3_fl2va_pruned_bf16.safetensors");
    regen_fixes["videoPost"] = json!({"derope":{"preset":"balanced","inject":0.48}});
    regen_fixes["faceRefine"] = face_block();
    let continued = |mode: &str| {
        let mut i = regen.clone();
        i["h3"]["mode"] = json!("REF2VA");
        i["h3"]["references"] = json!([]);
        i["h3"]["media"] = json!([]);
        i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","sourceFrames":243,"capture":true,"action":"turn","outputMode":mode});
        i
    };
    let (regen_full, regen_segment) = (continued("full"), continued("segment"));
    println!(
        "{}",
        json!({"ltx":compile(&l).unwrap(),"wan":compile(&w).unwrap(),"h3":compile(&h3()).unwrap(),"ltx_v2v":compile(&v2v).unwrap(),"h3_ref2va":compile(&r).unwrap(),"hyperflow":compile(&hf).unwrap(),
            "h3_regenerate":compile(&regen).unwrap(),"h3_regenerate_own_model_fixes":compile(&regen_fixes).unwrap(),
            "h3_regenerate_continuity_full":compile(&regen_full).unwrap(),"h3_regenerate_continuity_segment":compile(&regen_segment).unwrap()})
    );
}

#[test]
#[ignore]
fn dump_tve_graphs() {
    // Real file names of the owner's ComfyUI checkout, so validate_video_graphs.py checks the combos too.
    let post = json!({"upscaleModel":"2x-AnimeSharpV4_RCAN.safetensors",
        "rtx":{"denoise":"High","deblur":"Low","upscale":{"mode":"VSR","quality":"Ultra","scale":2}},
        "frameGeneration":{"engine":"rife","multiplier":2,"model":"rife_v4.26.safetensors"}});
    let mut rtx_fg = post.clone();
    rtx_fg["frameGeneration"] = json!({"engine":"rtx","multiplier":3,"mode":"HIGH"});
    let mut graphs = json!({});
    for (name, mut i) in [("ltx", ltx()), ("wan", wan()), ("h3", h3())] {
        i["videoPost"] = post.clone();
        graphs[format!("{name}_tve_rife")] = compile(&i).unwrap();
        i["videoPost"] = rtx_fg.clone();
        graphs[format!("{name}_tve_rtx")] = compile(&i).unwrap();
    }
    let enhance = json!({"recipeId":"video-enhance","version":1,"sourceVideo":"source.mp4","frameRate":24,"seed":7,"videoPost":post});
    graphs["enhance"] = compile(&enhance).unwrap();
    let mut derope = h3();
    derope["videoPost"] = json!({"derope":{"preset":"balanced","inject":0.48,
        "lora":"MiniMaxH3/turbo/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors"}});
    graphs["h3_derope_turbo"] = compile(&derope).unwrap();
    derope["videoPost"] = json!({"derope":{"preset":"max quality","inject":0.7}});
    graphs["h3_derope_full"] = compile(&derope).unwrap();
    derope["faceRefine"] = face_block();
    derope["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors","scale":1.5,"steps":3,"denoise":0.25});
    graphs["h3_derope_face_upscale"] = compile(&derope).unwrap();
    let lora =
        json!("MiniMaxH3/turbo/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors");
    let mut segment = continued("segment");
    segment["videoPost"]["derope"]["lora"] = lora.clone();
    segment["h3"]["continuity"]["sourceFrames"] = json!(243);
    segment["faceRefine"] = face_block();
    graphs["h3_derope_segment"] = compile(&segment).unwrap();
    segment["latentUpscale"] = derope["latentUpscale"].clone();
    graphs["h3_derope_segment_upscale"] = compile(&segment).unwrap();
    let mut full = continued("full");
    full["videoPost"]["derope"]["lora"] = lora;
    graphs["h3_derope_full_timeline"] = compile(&full).unwrap();
    for (name, mut intent) in [
        ("plain", h3()),
        ("full", full),
        ("segment_upscale", segment),
        ("face_upscale", derope),
    ] {
        if intent["videoPost"]["derope"].is_null() {
            intent["videoPost"] = json!({"derope":{"preset":"balanced","inject":0.48}});
        }
        intent["videoPost"]["derope"]["keepBackground"] = json!(true);
        graphs[format!("h3_background_{name}")] = compile(&intent).unwrap();
    }
    println!("{graphs}");
}

#[test]
#[ignore]
fn dump_latent_upscale_graphs() {
    let mut graphs = json!({});
    for passes in 1..=3 {
        let mut i = ltx();
        i["ltx"]["passes"] = json!(passes);
        if passes > 1 {
            i["ltx"]["spatialUpscaler"] = json!("ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
        }
        i["latentUpscale"] =
            json!({"model":"ltx-2.3-spatial-upscaler-x2-1.1.safetensors","scale":2});
        graphs[format!("ltx_post_{passes}")] = compile(&i).unwrap();
    }
    for capture in [false, true] {
        let mut i = h3();
        i["h3"]["continuity"] = json!({"session":"deas","sourceId":"","action":"","capture":capture,"outputMode":"full"});
        i["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors","scale":2,"steps":1,"denoise":0.2});
        graphs[format!("h3_post_capture_{capture}")] = compile(&i).unwrap();
    }
    for fixes in [false, true] {
        let mut i = continued("segment");
        i["h3"]["continuity"]["sourceFrames"] = json!(243);
        if fixes {
            i["videoPost"] = json!({"derope":{"preset":"balanced","inject":0.48}});
            i["faceRefine"] = face_block();
        } else {
            i.as_object_mut().unwrap().remove("videoPost");
        }
        i["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors","scale":2,"steps":1,"denoise":0.2});
        graphs[format!("h3_segment_fixes_{fixes}")] = compile(&i).unwrap();
    }
    println!("{graphs}");
}

#[test]
fn h3_ref2va_refmods_reach_the_timeline_and_may_stand_alone() {
    let mut i = h3();
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    // RefMods alone (no timeline media) are a valid REF2VA set; with them, audio no longer needs a picture.
    i["h3"]["media"] = json!([{"type":"audio","file":"deas-inputs/s.wav","slot":0}]);
    i["h3"]["refmods"] = json!([{"slot":1,"name":"chars/hero","strength":0.8,"description":"the hero"},{"slot":3,"name":"place","strength":1}]);
    let g = compile(&i).unwrap();
    let t: Value =
        serde_json::from_str(g["D"]["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        t["refmods"],
        json!([{"slot":1,"name":"chars/hero","enabled":true,"strength":0.8,"description":"the hero"},{"slot":3,"name":"place","enabled":true,"strength":1,"description":""}])
    );
    i["h3"]["media"] = json!([]);
    assert!(compile(&i).is_ok());
    for rows in [
        json!([]),
        json!([{"slot":0,"name":"a","strength":1}]),
        json!([{"slot":1,"name":"a","strength":1},{"slot":1,"name":"b","strength":1}]),
        json!([{"slot":1,"name":"../a","strength":1}]),
        json!([{"slot":1,"name":"a","strength":0}]),
        json!([{"slot":1,"name":"a","strength":1.5}]),
        json!([{"slot":1,"name":"a","strength":1,"enabled":false}]),
        json!((1..=9)
            .map(|n| json!({"slot":n,"name":"a","strength":1}))
            .collect::<Vec<_>>()),
    ] {
        i["h3"]["refmods"] = rows;
        assert!(compile(&i).is_err());
    }
    // RefMods are REF2VA-only; without them an empty media list stays invalid.
    let mut other = h3();
    other["h3"]["refmods"] = json!([{"slot":1,"name":"a","strength":1}]);
    assert!(compile(&other).is_err());
    i["h3"].as_object_mut().unwrap().remove("refmods");
    assert!(compile(&i).is_err());
}

#[test]
fn h3_ref2va_first_take_keeps_media_requirements_even_when_capture_is_enabled() {
    let mut i = h3();
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    i["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
    for capture in [false, true] {
        for flag in [None, Some(false), Some(true)] {
            i["h3"]["continuity"] = json!({"session":"s1","sourceId":"","capture":capture,"action":"unused","outputMode":"segment","overlapFrames":22});
            let mut expected =
                json!({"version":3,"session":"s1","capture":capture,"output_mode":"segment"});
            if let Some(flag) = flag {
                i["h3"]["continuity"]["useReferences"] = json!(flag);
                expected["use_references"] = json!(flag);
            }
            let g = compile(&i).unwrap();
            let t: Value =
                serde_json::from_str(g["D"]["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
            assert_eq!(t["continuity"], expected);
            assert_eq!(t["items"][0]["value"], "deas-inputs/a.png");
            assert_eq!(
                requirements(&i).iter().find(|r| r.0 == "images").unwrap().1,
                vec!["deas-inputs/a.png"]
            );
            let mut empty = i.clone();
            empty["h3"]["media"] = json!([]);
            assert!(
                compile(&empty).is_err(),
                "capture is not a continuation source"
            );
        }
    }
    i["h3"].as_object_mut().unwrap().remove("continuity");
    i["h3"]["media"] = json!([]);
    assert!(compile(&i).is_err());
}

#[test]
fn h3_ref2va_continuation_retains_strict_flags_media_and_source_validation() {
    let mut i = h3();
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    i["h3"]["media"] = json!([]);
    i["h3"]["continuity"] = json!({"session":"s1","sourceId":"clip_1","capture":false,"action":"","outputMode":"full","useReferences":true});
    assert!(compile(&i).is_err(), "useReferences true needs references");
    i["h3"]["refmods"] = json!([{"slot":1,"name":"chars/hero","strength":1}]);
    assert!(compile(&i).is_ok(), "RefMods alone are valid references");
    i["h3"].as_object_mut().unwrap().remove("refmods");
    for flag in [
        json!(null),
        json!(0),
        json!(1),
        json!("false"),
        json!("true"),
        json!([]),
        json!({}),
    ] {
        i["h3"]["continuity"]["useReferences"] = flag.clone();
        assert!(compile(&i).is_err(), "accepted useReferences={flag}");
    }
    i["h3"]["continuity"]["useReferences"] = json!(false);
    assert!(compile(&i).is_ok());
    for media in [
        json!(null),
        json!({}),
        json!([{"type":"image","file":"../a.png","slot":0}]),
        json!([{"type":"image","file":"deas-inputs/a.png","slot":9}]),
        json!([{"type":"audio","file":"deas-inputs/a.wav","slot":0}]),
        json!([{"type":"video","file":"deas-input-v.mp4","slot":0,"trimStart":6,"trimEnd":1}]),
        json!([{"type":"video","file":"deas-input-v.mp4","slot":0,"mediaMode":"loop"}]),
        json!([{"type":"image","file":"deas-inputs/a.png","slot":0,"extra":true}]),
    ] {
        i["h3"]["media"] = media.clone();
        assert!(
            compile(&i).is_err(),
            "accepted ignored malformed media={media}"
        );
    }
    i["h3"]["media"] = json!([]);
    i["h3"]["refmods"] = json!([{"slot":1,"name":"../hero","strength":1}]);
    assert!(compile(&i).is_err(), "ignored RefMods still validate");
    i["h3"].as_object_mut().unwrap().remove("refmods");
    for source in [json!(null), json!(1), json!("../clip"), json!("")] {
        i["h3"]["continuity"]["sourceId"] = source.clone();
        assert!(compile(&i).is_err(), "accepted empty-media source={source}");
    }
    i["h3"]["continuity"]
        .as_object_mut()
        .unwrap()
        .remove("sourceId");
    assert!(compile(&i).is_err());
    i["h3"]["continuity"]["sourceId"] = json!("clip_1");
    i["h3"]["continuity"]["sourceKind"] = json!("video");
    assert!(compile(&i).is_err(), "imported video IDs stay strict");
}

#[test]
fn h3_ref2va_continuation_requires_only_effective_reference_images() {
    let mut i = h3();
    i["h3"]["mode"] = json!("REF2VA");
    i["h3"]["references"] = json!([]);
    i["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/stale.png","slot":0}]);
    i["h3"]["refmods"] = json!([{"slot":1,"name":"chars/stale","strength":1}]);
    i["h3"]["continuity"] =
        json!({"session":"s1","sourceId":"clip_1","capture":false,"action":"","outputMode":"full"});
    for flag in [None, Some(false), Some(true)] {
        if let Some(flag) = flag {
            i["h3"]["continuity"]["useReferences"] = json!(flag);
        }
        let g = compile(&i).unwrap();
        let t: Value =
            serde_json::from_str(g["D"]["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
        // Preserve valid descriptors in the timeline; Director decides whether to consume them.
        assert_eq!(t["items"][0]["value"], "deas-inputs/stale.png");
        assert_eq!(t["refmods"][0]["name"], "chars/stale");
        let req = requirements(&i);
        assert_eq!(
            req.iter().find(|r| r.0 == "images").unwrap().1,
            if flag == Some(true) {
                vec!["deas-inputs/stale.png"]
            } else {
                vec![]
            }
        );
    }
}

#[test]
fn h3_ref2va_continuation_maps_reference_choice_and_preserves_segment_chain() {
    for video in [false, true] {
        for capture in [false, true] {
            for output in ["full", "segment"] {
                for flag in [None, Some(false), Some(true)] {
                    let mut i = h3();
                    i["h3"]["mode"] = json!("REF2VA");
                    i["h3"]["references"] = json!([]);
                    i["h3"]["media"] = json!([]);
                    i["h3"]["continuity"] = json!({"session":"s1","sourceId":"clip_1","capture":capture,"action":"  she turns around\n","outputMode":output,"overlapFrames":22});
                    if video {
                        i["h3"]["continuity"]["sourceKind"] = json!("video");
                        i["h3"]["continuity"]["sourceId"] = json!("a".repeat(64));
                    }
                    if let Some(flag) = flag {
                        i["h3"]["continuity"]["useReferences"] = json!(flag);
                    }
                    if flag == Some(true) {
                        i["h3"]["media"] = json!([
                            {"type":"image","file":"deas-inputs/a.png","slot":0},
                            {"type":"video","file":"deas-input-v.mp4","slot":0,"mediaMode":"video_audio","trimStart":1,"trimEnd":6}
                        ]);
                        i["h3"]["refmods"] = json!([{"slot":1,"name":"chars/hero","strength":0.8,"description":"the hero"}]);
                    }
                    let g = compile(&i).unwrap();
                    let t: Value =
                        serde_json::from_str(g["D"]["inputs"]["timeline_data"].as_str().unwrap())
                            .unwrap();
                    let mut expected = json!({"version":3,"session":"s1","capture":capture,"output_mode":output,"continuation_prompt":"  she turns around\n","overlap_frames":22});
                    expected["source_kind"] = json!(if video { "video" } else { "checkpoint" });
                    expected[if video {
                        "source_video_id"
                    } else {
                        "source_id"
                    }] = i["h3"]["continuity"]["sourceId"].clone();
                    if let Some(flag) = flag {
                        expected["use_references"] = json!(flag);
                    }
                    assert_eq!(t["continuity"], expected);
                    if flag == Some(true) {
                        assert_eq!(
                            t["items"][1],
                            json!({"id":"m1","type":"video","value":"deas-input-v.mp4","slot":0,"order":1,"enabled":true,"media_mode":"video_audio","trim_start":1,"trim_end":6})
                        );
                        assert_eq!(
                            t["refmods"],
                            json!([{"slot":1,"name":"chars/hero","enabled":true,"strength":0.8,"description":"the hero"}])
                        );
                    } else {
                        assert_eq!(t["items"], json!([]));
                    }
                    assert_eq!(g["D"]["inputs"]["ref2va_model"], json!(["1", 0]));
                    assert!(g["D"]["inputs"].get("fl2va_model").is_none());
                    assert_eq!(
                        g["SP"]["inputs"],
                        json!({"sampled":["5",0],"context":["G",2]})
                    );
                    assert_eq!(
                        g["SD"]["inputs"],
                        json!({"latent":["SP",0],"vae":["V",0],"audio_vae":["AV",0],"context":["SP",1]})
                    );
                    assert_eq!(g["7"]["inputs"]["images"], json!(["SD", 0]));
                    assert_eq!(g["7"]["inputs"]["audio"], json!(["SD", 1]));
                    assert_eq!(
                        g["P"]["inputs"],
                        json!({"filename":["7",1],"ticket":["SP",2]})
                    );
                }
            }
        }
    }
}

// Pins the Director-parity Join clips contract BEFORE DEAS emits it (docs/PLAN.md §4.1).
// Source: ComfyUI-DaSiWa-Nodes 0.5.42, nodes/h3_continuity/{assembly,assembly_node,transition}.py;
// nodes registered in the pack root __init__.py:21-25. If the pack changes any shape below,
// this test fails at the next source check and the emit slice must align to the pack, not here.
#[test]
fn h3_join_contract_pins_pack_nodes_and_json_schema() {
    // Exact node names and INPUT_TYPES "required" keys (input order fixed for the emit slice).
    let nodes: [(&str, &[&str]); 3] = [
        (
            "DaSiWaH3ClipAssemble",
            &["assembly_data", "filename_prefix"],
        ),
        (
            "DaSiWaH3TransitionGuide",
            &["clip", "vae", "guide", "transition_data", "audio_vae"],
        ),
        (
            "DaSiWaH3TransitionRender",
            &["latent", "vae", "audio_vae", "transition"],
        ),
    ];
    // The emit slice wires all three join nodes into H3_CONTINUITY_NODES; presence evidence
    // rides the same pack registration as the three continuity nodes.
    for (name, _) in nodes {
        assert!(
            H3_CONTINUITY_NODES.contains(&name),
            "join node {name} left the continuity node list; re-check this contract"
        );
    }

    // assembly_data wire shape (assembly.py::_request; media rows per _plan).
    let assembly = json!({
        "version": 1,
        "rows": [
            {"kind": "media", "filename": "clipA.mp4", "trim_start": 0, "trim_end": null},
            {"kind": "media", "filename": "sub/clipB.mp4", "trim_start": 12, "trim_end": 100},
        ],
        "repair_transitions": false,
        "copy_video": true,
        "audio_policy": "preserve",
    });
    assert_eq!(assembly["version"], json!(1));
    // _request: exactly these control keys; repair_transitions true is a hard error (bridges
    // belong to Transition Guide/Render), audio_policy only accepts "preserve".
    assert_eq!(assembly["repair_transitions"], json!(false));
    assert_eq!(assembly["audio_policy"], json!("preserve"));
    // Rows: 1..=100 (MAX_ROWS), one kind only, never mixed.
    let rows = assembly["rows"].as_array().unwrap();
    assert!(!rows.is_empty() && rows.len() <= 100);
    let kinds: Vec<&str> = rows.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert!(kinds.iter().all(|k| *k == kinds[0]) && ["media", "checkpoint"].contains(&kinds[0]));
    // Media handles are input-root-relative (assembly.py::_local: <=1024 chars, no NUL/'..'),
    // trims are numbers with trim_end null meaning "to end"; the join total stays <= 1 hour.
    for row in rows {
        let name = row["filename"].as_str().unwrap();
        assert!(
            !name.is_empty() && name.len() <= 1024 && !name.contains("..") && !name.contains('\0')
        );
    }
    // Checkpoint chain row shape (resolve_checkpoints): one session, parent-chain order,
    // ready status, identical width/height/fps(24)/mode_family, export coverage contract
    // kind "full"|"segment" with start_frame == covered and start_frame + frames == clip frames.
    let chain_row = json!({"kind": "checkpoint", "session": "deas-ab12cd34", "clip_id": "clip_1"});
    let mut keys: Vec<String> = chain_row.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["clip_id", "kind", "session"]);
    // Output prefix contract on the node input, not in assembly_data
    // (assembly_node.py + assemble()): [A-Za-z0-9_-]{1,80}; output is a new unique MP4.
    let prefix_ok = |p: &str| {
        !p.is_empty()
            && p.len() <= 80
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    assert!(
        prefix_ok("H3_Joined")
            && !prefix_ok("")
            && !prefix_ok(&"a".repeat(81))
            && !prefix_ok("a.b")
    );
    // Whole request stays <= 64 KiB serialized (MAX_JSON).
    assert!(assembly.to_string().len() <= 65536);
    // Media constraints probed per row (_plan): average rate exactly 24, 8-bit yuv420p SDR
    // (HDR trc 16/18 and BT.2020 primaries rejected), identical color props across rows;
    // lossless copy only for {h264, hevc, av1, vp9} (COPY_CODECS), else re-encode.

    // transition_data wire shape (transition.py::transition_spec): exactly two media rows.
    let transition = json!({
        "version": 1,
        "rows": [{"kind": "media", "filename": "a.mp4"}, {"kind": "media", "filename": "b.mp4"}],
        "context_frames": 22,
        "transition_frames": 29,
        "prompt": "match the camera pan across the desk",
        "filename_prefix": "H3_Transition",
    });
    assert_eq!(transition["rows"].as_array().unwrap().len(), 2);
    assert!(transition["prompt"].as_str().unwrap().len() <= 4000);
    // H3 temporal grid rules: context >= 5 and 17k+5; transition >= 12 and 2*context+gap
    // stays on 17k+5; derived window_frames/guide_b_frame per the spec's return.
    for (context, gap) in [(5usize, 12usize), (22, 29), (39, 46), (56, 12)] {
        assert!(context >= 5 && context % 17 == 5);
        assert!(gap >= 12 && (2 * context + gap) % 17 == 5);
        let (window, guide_b) = (2 * context + gap, context + gap);
        assert_eq!(window % 17, 5);
        assert!(guide_b > gap && guide_b < window);
    }
    for bad_context in [4usize, 20] {
        assert!(
            bad_context < 5 || bad_context % 17 != 5,
            "accepted context {bad_context}"
        );
    }
    for bad_gap in [11usize, 13] {
        assert!(
            bad_gap < 12 || (2 * 22 + bad_gap) % 17 != 5,
            "accepted gap {bad_gap}"
        );
    }
    // Director defaults pinned by the plan item are grid-legal: 22/29 -> window 73 = 4*17+5.
    assert_eq!(2 * 22 + 29, 73);
}

#[test]
fn h3_join_compile_emits_pinned_assembly_prompt() {
    let files = json!({"recipeId":"h3-join","version":1,
        "h3":{"join":{"kind":"files",
            "files":[{"filename":"takeA.mp4"},{"filename":"sub/takeB.mp4","trimStart":2.5,"trimEnd":10},
                     {"filename":"takeC.mp4","trimStart":0,"trimEnd":null}],
            "copyVideo":true,"filenamePrefix":"My_Join-1"}}});
    let g = compile(&files).unwrap();
    assert_eq!(g.as_object().unwrap().len(), 1);
    assert_eq!(g["7"]["class_type"], json!("DaSiWaH3ClipAssemble"));
    assert_eq!(g["7"]["inputs"]["filename_prefix"], json!("My_Join-1"));
    let data: Value =
        serde_json::from_str(g["7"]["inputs"]["assembly_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        data,
        json!({"version":1,
        "rows":[
            {"kind":"media","filename":"takeA.mp4","trim_start":0.0,"trim_end":null},
            {"kind":"media","filename":"sub/takeB.mp4","trim_start":2.5,"trim_end":10.0},
            {"kind":"media","filename":"takeC.mp4","trim_start":0.0,"trim_end":null}],
        "repair_transitions":false,"copy_video":true,"audio_policy":"preserve"})
    );
    let segments = json!({"recipeId":"h3-join","version":1,
        "h3":{"join":{"kind":"segments","session":"deas-ab12cd34","chain":["clip_1","clip_2"]}}});
    let g = compile(&segments).unwrap();
    let data: Value =
        serde_json::from_str(g["7"]["inputs"]["assembly_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        data["rows"][0],
        json!({"kind":"checkpoint","session":"deas-ab12cd34","clip_id":"clip_1"})
    );
    assert_eq!(data["copy_video"], json!(false));
    assert_eq!(g["7"]["inputs"]["filename_prefix"], json!("H3_Joined"));
    assert!(is_video(&segments) && is_join(&segments));
    assert!(requirements(&segments).is_empty());
    // A generation intent's strict h3 block rejects a stray join beside continuity/media.
    let mut h = h3();
    h["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","capture":true,"action":"","outputMode":"segment"});
    assert!(!is_join(&h));
    compile(&h).unwrap();
    h["h3"].as_object_mut().unwrap().insert(
        "join".into(),
        json!({"kind":"files","files":[{"filename":"a.mp4"}]}),
    );
    assert!(
        compile(&h).is_err(),
        "h3.join inside a generation intent must not silently pass"
    );
}

#[test]
fn h3_join_rejects_invalid_blocks() {
    let base = || {
        json!({"recipeId":"h3-join","version":1,
        "h3":{"join":{"kind":"files","files":[{"filename":"a.mp4"}]}}})
    };
    let cases: Vec<(Value, &str)> = vec![
        (json!({"kind":"other"}), "kind"),
        (json!({"kind":"files","files":[]}), "empty files"),
        (
            json!({"kind":"files","files":[{"filename":"../a.mp4"}]}),
            "path escape",
        ),
        (
            json!({"kind":"files","files":[{"filename":"/abs/a.mp4"}]}),
            "absolute path",
        ),
        (
            json!({"kind":"files","files":[{"filename":"C:/a.mp4"}]}),
            "drive path",
        ),
        (
            json!({"kind":"files","files":[{"filename":"a\0.mp4"}]}),
            "NUL",
        ),
        (
            json!({"kind":"files","files":[{"filename":"a.mp4","trimStart":-1}]}),
            "negative trim",
        ),
        (
            json!({"kind":"files","files":[{"filename":"a.mp4","trimStart":5,"trimEnd":5}]}),
            "empty trim",
        ),
        (
            json!({"kind":"files","files":[{"filename":"a.mp4","trimEnd":"x"}]}),
            "non-numeric trim",
        ),
        (
            json!({"kind":"segments","session":"_imports","chain":["clip_1"]}),
            "reserved session",
        ),
        (
            json!({"kind":"segments","session":"de-as ok","chain":["clip_1"]}),
            "bad session",
        ),
        (
            json!({"kind":"segments","session":"s","chain":[]}),
            "empty chain",
        ),
        (
            json!({"kind":"segments","session":"s","chain":["a b"]}),
            "bad clip id",
        ),
        (
            json!({"kind":"segments","session":"s","chain":["clip_1"],"copyVideo":"yes"}),
            "copyVideo type",
        ),
        (
            json!({"kind":"files","files":[{"filename":"a.mp4"}],"filenamePrefix":"a.b"}),
            "prefix charset",
        ),
        (
            json!({"kind":"files","files":[{"filename":"a.mp4"}],"filenamePrefix":""}),
            "empty prefix",
        ),
    ];
    for (join_block, why) in cases {
        let mut i = base();
        i["h3"]["join"] = join_block;
        assert!(compile(&i).is_err(), "accepted {why}");
    }
    for (version, why) in [(json!(2), "version"), (Value::Null, "missing version")] {
        let mut i = base();
        if version.is_null() {
            i.as_object_mut().unwrap().remove("version");
        } else {
            i["version"] = version;
        }
        assert!(compile(&i).is_err(), "accepted {why}");
    }
    for extra in ["continuity", "media"] {
        let mut i = base();
        i["h3"][extra] = json!({});
        assert!(compile(&i).is_err(), "accepted h3.{extra} beside join");
    }
    let wide = json!({"filename": "a".repeat(700)});
    let mut base_wide = base();
    base_wide["h3"]["join"]["files"] = json!(vec![wide; 100]);
    assert!(compile(&base_wide).is_err(), "accepted over-budget rows");
    assert!(
        validate(&base()).is_err(),
        "generation validate() must not accept a join intent"
    );
}

/// `cargo test --lib dump_join_graph -- --ignored --nocapture` prints the join prompt for
/// `tools/validate_video_graphs.py` (node names, inputs and link types against the real checkout).
#[test]
#[ignore]
fn dump_join_graph() {
    println!(
        "{}",
        json!({"h3_join": compile(&json!({"recipeId":"h3-join","version":1,
            "h3":{"join":{"kind":"files","files":[{"filename":"source.mp4","trimEnd":0.5},{"filename":"source.mp4","trimStart":0.5}]}}}))
            .unwrap()})
    );
}

fn face_block() -> Value {
    json!({"samCheckpoint":"SAM3/sam3.1_multiplex_fp16.safetensors","prompt":"a detailed face","threshold":0.5,
        "maxObjects":4,"detectInterval":1,"denoise":0.35,"cropFactor":2.5,"feather":6})
}

#[test]
fn h3_i2v_face_refine_accepts_empty_generation_and_refine_prompts() {
    let mut i = h3();
    i["positivePrompt"] = json!("");
    i["faceRefine"] = face_block();
    i["faceRefine"]["prompt"] = json!("");
    let g = compile(&i).unwrap();
    assert_eq!(g["FRC"]["inputs"]["prompt"], json!(""));
    assert_eq!(g["FRT"]["inputs"]["text"], json!("face"));
    assert_eq!(g["FR"]["inputs"]["images"], json!(["SD", 0]));
}

#[test]
fn h3_face_refine_chains_after_decode_behind_the_baseline_gate() {
    let baseline = compile(&h3()).unwrap();
    let mut i = h3();
    i["faceRefine"] = face_block();
    let g = compile(&i).unwrap();
    assert_eq!(g["FR"]["inputs"]["images"], json!(["SD", 0]));
    assert_eq!(g["FR"]["inputs"]["audio"], json!(["SD", 1]));
    assert_eq!(g["FR"]["inputs"]["fps"], json!(["D", 8]));
    assert_eq!(g["FRG"]["inputs"]["model"], g["B"]["inputs"]["model"]);
    // The 4-step fixture at 0.35 would run one step: refine extends the generation schedule.
    assert_eq!(g["FRZ"]["inputs"]["sigmas"], json!(["FRB", 0]));
    let mut own = g["Z"].clone();
    own["inputs"]["steps"] = json!(6);
    assert_eq!(g["FRB"], own);
    // Generation guides stay out of the refine conditioning.
    assert_eq!(g["FRG"]["inputs"]["conditioning"], json!(["FRC", 0]));
    assert_eq!(
        g["PG"]["inputs"],
        json!({"baseline":["B7",1],"image":["FR",0]})
    );
    assert_eq!(g["7"]["inputs"]["images"], json!(["PG", 0]));
    assert_eq!(g["B7"]["inputs"]["images"], json!(["SD", 0]));
    assert_eq!(g["B7"]["inputs"]["audio"], json!(["SD", 1]));
    // Everything the generation graph already had is unchanged except the saver's image link.
    for (k, v) in baseline.as_object().unwrap() {
        if k != "7" {
            assert_eq!(&g[k], v, "{k}");
        }
    }
    let mut with_post = i.clone();
    with_post["videoPost"] = json!({"upscaleModel":"2x.safetensors"});
    let g = compile(&with_post).unwrap();
    // TVE upscales the refined frames, still behind the one gate; B7 stays the raw decode.
    let chain_input = g.as_object().unwrap().values().find(|n| {
        n["inputs"].to_string().contains("[\"FR\",0]")
            && n["class_type"] != "DEAS_VideoPostprocessGate"
    });
    assert!(chain_input.is_some(), "{g}");
    assert_eq!(g["PG"]["inputs"]["baseline"], json!(["B7", 1]));
    assert_eq!(g["B7"]["inputs"]["images"], json!(["SD", 0]));
    assert!(requirements(&i).contains(&(
        "checkpoints",
        vec!["SAM3/sam3.1_multiplex_fp16.safetensors"]
    )));
    for bad in [
        {
            let mut b = i.clone();
            b["latentUpscale"] = json!({"model":"x.safetensors","scale":2,"steps":4,"denoise":0.4});
            b
        },
        {
            let mut b = ltx();
            b["faceRefine"] = face_block();
            b
        },
        {
            let mut b = i.clone();
            b["faceRefine"]["denoise"] = json!(0);
            b
        },
    ] {
        assert!(compile(&bad).is_err(), "{bad}");
    }
}

/// `cargo test --lib dump_face_refine_graphs -- --ignored --nocapture` prints both refine graphs for
/// `tools/validate_video_graphs.py`.
#[test]
#[ignore]
fn dump_face_refine_graphs() {
    let mut i = h3();
    i["faceRefine"] = face_block();
    let standalone = json!({"recipeId":"h3-face-refine","version":1,"family":"minimax-h3","model":"MiniMaxH3/fl2va.safetensors",
        "textEncoder":"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors","vae":"MiniMaxH3/video_vae.safetensors",
        "audioVae":"MiniMaxH3/audio_vae.safetensors","sourceVideo":"source.mp4","startSeconds":0.0,"durationSeconds":1.0,
        "seed":7,"steps":30,"sampler":"euler","scheduler":"simple","shiftVideo":12.0,"shiftAudio":3.0,"faceRefine":face_block()});
    println!(
        "{}",
        json!({"h3_face_refine_chain":compile(&i).unwrap(),"h3_face_refine":compile(&standalone).unwrap()})
    );
}

fn regenerate_intent() -> Value {
    let mut i = h3();
    i["width"] = json!(1344);
    i["loras"] = json!([{"name":"MiniMaxH3/turbo/turbo.safetensors","strength":1.0}]);
    i["options"] = json!({"attention":"sage"});
    i["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors",
        "regenerate":{"lora":"open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors","target":"2K"}});
    i
}

#[test]
fn h3_regenerate_original_preserves_canvas_without_learned_upscaler() {
    let mut i = regenerate_intent();
    i["height"] = json!(992);
    i["latentUpscale"] = json!({"model":"interpolation", "regenerate":{
        "lora":"open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors", "target":"Original"}});
    let g = compile(&i).unwrap();
    assert_eq!(latent_upscale_size(&i), (1344, 992));
    assert_eq!(regenerate_size(1344, 992, "Original"), (1344, 992));
    assert_eq!(g["U"]["inputs"]["target"], "Original");
    assert_eq!(g["U"]["inputs"]["upscale_model"], "interpolation");
    assert!(requirements(&i)
        .iter()
        .filter(|(field, _)| *field == "h3LatentUpscaleModels")
        .all(|(_, names)| names.is_empty()));
    assert!(requirements(&i)
        .iter()
        .any(|(field, names)| *field == "loras"
            && names.contains(&"open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors")));
    let mut old_target = i.clone();
    old_target["latentUpscale"]["regenerate"]["target"] = json!("2K");
    assert!(
        compile(&old_target)
            .unwrap_err()
            .contains("Invalid latentUpscale"),
        "interpolation is not a learned upscaler for the old targets"
    );
    let mut no_lora = i.clone();
    no_lora["latentUpscale"]["regenerate"]
        .as_object_mut()
        .unwrap()
        .remove("lora");
    assert!(compile(&no_lora).is_err());
}

#[test]
fn h3_regenerate_replaces_the_upscale_node_on_a_lora_free_base_chain() {
    let i = regenerate_intent();
    let g = compile(&i).unwrap();
    let u = &g["U"]["inputs"];
    assert_eq!(g["U"]["class_type"], "DaSiWaH3HiResRegenerate");
    assert_eq!(
        u["lora_name"],
        "open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors"
    );
    assert_eq!(
        (
            u["target"].clone(),
            u["strength"].clone(),
            u["spatial_tiling"].clone()
        ),
        (json!("2K"), json!(1.0), json!(true))
    );
    assert_eq!(u["upscale_model"], i["latentUpscale"]["model"]);
    assert_eq!(
        (u["noise"].clone(), u["seed"].clone()),
        (json!(["N", 0]), i["seed"].clone())
    );
    for (input, link) in [
        ("continuity_context", json!(["SP", 1])),
        ("director_guide", json!(["D", 0])),
        ("vae", json!(["V", 0])),
        ("conditioning", json!(["G", 0])),
        ("latent", json!(["SP", 0])),
    ] {
        assert_eq!(u[input], link, "{input}");
    }
    // Workbench options on the base, generation LoRAs (Turbo) only on the sampling chain.
    assert_eq!(u["model"], json!(["RA", 0]));
    assert_eq!(g["RA"]["inputs"]["model"], json!(["1", 0]));
    assert!(g.get("RL1").is_none() && g.get("L1").is_some());
    assert!(u.get("scale").is_none() && u.get("denoise").is_none());
    assert_eq!(latent_upscale_size(&i), (2560, 1440));
    let mut baseline = std::collections::BTreeSet::new();
    fn deps(g: &Value, id: &str, seen: &mut std::collections::BTreeSet<String>) {
        if !seen.insert(id.to_owned()) {
            return;
        }
        for v in g[id]["inputs"].as_object().unwrap().values() {
            if let Some(dep) = v
                .as_array()
                .filter(|a| a.len() == 2 && a[1].is_number())
                .and_then(|a| a[0].as_str())
                .filter(|d| g.get(*d).is_some())
            {
                deps(g, dep, seen);
            }
        }
    }
    deps(&g, "B7", &mut baseline);
    assert!(
        !baseline.contains("U") && !baseline.contains("RA"),
        "baseline pulls the regenerate pass"
    );
    assert_eq!(g["SD"]["inputs"]["latent"], json!(["U", 0]));
    // Own base model: loaded beside the generation model, still without the generation LoRAs.
    let mut own = regenerate_intent();
    own["latentUpscale"]["regenerate"]["model"] =
        json!("MiniMaxH3/minimax_h3_fl2va_pruned_bf16.safetensors");
    own["latentUpscale"]["regenerate"]["spatialTiling"] = json!(false);
    let g = compile(&own).unwrap();
    assert_eq!(
        g["RM"]["inputs"]["unet_name"],
        "MiniMaxH3/minimax_h3_fl2va_pruned_bf16.safetensors"
    );
    assert_eq!(g["RA"]["inputs"]["model"], json!(["RM", 0]));
    assert_eq!(g["U"]["inputs"]["spatial_tiling"], false);
    let required = requirements(&own);
    assert!(required.contains(&(
        "loras",
        vec!["open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors"]
    )));
    assert!(required.contains(&(
        "diffusionModels",
        vec!["MiniMaxH3/minimax_h3_fl2va_pruned_bf16.safetensors"]
    )));
    assert!(required.contains(&(
        "h3LatentUpscaleModels",
        vec!["minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"]
    )));
}

#[test]
fn h3_regenerate_rejects_mixed_or_invalid_settings() {
    for (path, value) in [
        ("scale", json!(2.0)),
        ("denoise", json!(0.2)),
        ("advanced", json!({"cfg":1.0})),
    ] {
        let mut i = regenerate_intent();
        i["latentUpscale"][path] = value;
        assert!(
            compile(&i).unwrap_err().contains("Invalid latentUpscale"),
            "{path}"
        );
    }
    for (key, value) in [
        ("target", json!("8K")),
        ("lora", json!("../evil.safetensors")),
        ("lora", json!("regen.ckpt")),
        ("model", json!("MiniMaxH3/model.gguf")),
        ("spatialTiling", json!("yes")),
        ("strength", json!(0.5)),
    ] {
        let mut i = regenerate_intent();
        i["latentUpscale"]["regenerate"][key] = value;
        assert!(
            compile(&i).unwrap_err().contains("Invalid latentUpscale"),
            "{key}"
        );
    }
}

#[test]
fn h3_regenerate_size_follows_the_reference_grids() {
    for ((w, h, target), expected) in [
        ((1344, 768, "2K"), (2560, 1440)),
        ((1344, 768, "1080P"), (1920, 1088)),
        ((1344, 768, "4K"), (3840, 2176)),
        ((1024, 576, "2K"), (2560, 1440)),
        ((768, 1344, "2K"), (1440, 2560)),
        ((768, 768, "2K"), (1440, 1440)),
        ((1024, 768, "2K"), (1920, 1440)),
    ] {
        assert_eq!(regenerate_size(w, h, target), expected, "{w}x{h} {target}");
    }
}

#[test]
fn h3_capture_with_seamless_loop_publishes_the_original() {
    for (mode, upscale) in [
        ("segment", false),
        ("segment", true),
        ("full", false),
        ("full", true),
    ] {
        let mut i = h3();
        i["h3"]["mode"] = json!("REF2VA");
        i["h3"]["references"] = json!([]);
        i["h3"]["media"] = json!([]);
        i["h3"]["continuity"] = json!({"session":"deas-ab12cd34","sourceId":"clip_1","capture":true,"action":"turn","outputMode":mode,"sourceFrames":243});
        if upscale {
            i["latentUpscale"] = json!({"model":"minimax_h3_latent_upscaler.safetensors","scale":2,"steps":1,"denoise":0.2});
        }
        i["videoPost"] = json!({"rtx":{"denoise":"High"}});
        // Without a loop the Processed export stays the checkpoint (unchanged behaviour).
        assert_eq!(
            compile(&i).unwrap()["P"]["inputs"]["filename"],
            json!(["7", 1])
        );
        i["videoPost"]["loop"] =
            json!({"backend":"rife","model":"rife_v4.26.safetensors","audio":"beat"});
        let g = compile(&i).unwrap();
        // The pack (h3_continuity/validation.py) needs the export's audio straight from the decode and
        // its duration equal to the saved latent; the loop's retimed audio stays on Processed only.
        assert_eq!(
            g["P"]["inputs"]["filename"],
            json!(["B7", 1]),
            "{mode} upscale={upscale}"
        );
        assert_eq!(g["7"]["inputs"]["audio"], json!(["PG", 1]));
        assert_eq!(g["PG"]["inputs"]["audio"], json!(["LP", 1]));
        assert_eq!(g["B7"]["inputs"]["pingpong"], json!(false));
        if mode == "segment" {
            assert_eq!(g["B7"]["inputs"]["images"], json!(["SD", 0]));
            assert_eq!(g["B7"]["inputs"]["audio"], json!(["SD", 1]));
        }
    }
}
