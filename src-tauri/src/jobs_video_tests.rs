use super::*;
use serde_json::json;

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
    assert!(compile(&cont).is_err(), "REF2VA continuation");
    let mut stray = h3();
    stray["h3"]["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
    assert!(compile(&stray).is_err(), "media outside REF2VA");
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
    println!(
        "{}",
        json!({"ltx":compile(&l).unwrap(),"wan":compile(&w).unwrap(),"h3":compile(&h3()).unwrap(),"ltx_v2v":compile(&v2v).unwrap(),"h3_ref2va":compile(&r).unwrap()})
    );
}
