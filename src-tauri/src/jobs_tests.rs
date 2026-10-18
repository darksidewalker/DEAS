use super::*;

#[test]
fn wildcard_plugin_keeps_base_prompts_and_rule_snapshot() {
    let mut i = intent();
    i["wildcard"] = json!({"style":"Booru","seed":7,"reroll":3,"token_budget":200,"auto_reroll":true,"selection_state":{"Art/Light/wildcards":{"enabled":true,"weight":1.2}}});
    let graph = compile(&i).unwrap();
    assert_eq!(
        graph["WP"]["class_type"],
        "DaSiWa_WildcardPresetPromptBuilder"
    );
    assert_eq!(graph["WP"]["inputs"]["positive_input"], i["positivePrompt"]);
    assert_eq!(graph["WP"]["inputs"]["negative_input"], i["negativePrompt"]);
    assert_eq!(graph["WP"]["inputs"]["auto_reroll"], true);
    assert_eq!(
        serde_json::from_str::<Value>(graph["WP"]["inputs"]["selection_state"].as_str().unwrap())
            .unwrap(),
        i["wildcard"]["selection_state"]
    );
    assert_eq!(graph["2"]["inputs"]["text"], json!(["WP", 0]));
    assert_eq!(graph["3"]["inputs"]["text"], json!(["WP", 1]));
    let mut saved = graph.clone();
    civitai_saver(
        &mut saved,
        &json!(["DaSiWa_MetadataConfig", "DaSiWa_MetadataImageSaver"]),
    );
    assert_eq!(saved["M"]["inputs"]["text_positive"], json!(["WP", 0]));
    assert_eq!(saved["M"]["inputs"]["text_negative"], json!(["WP", 1]));
    for patch in [
        json!({"seed":-1}),
        json!({"seed":4294967296_u64}),
        json!({"reroll":2147483648_u64}),
        json!({"style":"other"}),
        json!({"token_budget":0}),
        json!({"auto_reroll":"yes"}),
        json!({"selection_state":[]}),
        json!({"extra":true}),
    ] {
        let mut bad = i.clone();
        for (k, v) in patch.as_object().unwrap() {
            bad["wildcard"][k] = v.clone();
        }
        assert!(compile(&bad).unwrap_err().contains("wildcard"));
    }
}

pub(super) fn intent() -> Value {
    json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"a cat", "negativePrompt":"", "checkpoint":"sd/model.safetensors",
        "seed":123,"width":512,"height":768,"steps":20,"cfg":7,
        "sampler":"euler","scheduler":"normal","outputPrefix":"DEAS_test"})
}

#[test]
fn output_naming_paths_are_bounded_relative_and_safe_on_windows() {
    let mut i = intent();
    i["outputPrefix"] = json!("image/2026_10_18/12-34-56-123-My_Model");
    let graph = compile(&i).unwrap();
    assert_eq!(graph["7"]["inputs"]["filename_prefix"], i["outputPrefix"]);
    for bad in [
        "", "../out", "/out", "a//b", "a/./b", "a/../b", "a\\b", "a:b", "a\n", "a/%seed%", "CON",
        "aux.png", "a/NUL", "a/name.",
    ] {
        i["outputPrefix"] = json!(bad);
        assert!(compile(&i).is_err(), "{bad:?}");
    }
    for bad in ["x".repeat(181), vec!["x".repeat(170); 3].join("/") + "/x"] {
        i["outputPrefix"] = json!(bad);
        assert!(compile(&i).is_err());
    }
}

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROMPT_ID: &str = "cd5936d0-9f0f-4b82-8cda-b01c241bc669";

#[tokio::test]
async fn wildcard_library_is_bounded_read_only_and_preserves_category_order() {
    let raw = r#"{"categories":{"Z first":[],"A second":[]}}"#;
    let (base, task) = server(move |path, _| {
        assert_eq!(
            path,
            "GET /comfy/dasiwa/wildcard-preset-prompt-builder/library HTTP/1.1"
        );
        (200, raw.to_owned())
    })
    .await;
    assert_eq!(
        crate::wildcard::native_wildcard_library(base)
            .await
            .unwrap(),
        raw
    );
    task.abort();
    for (status, body) in [
        (302, "{}".to_owned()),
        (404, "{}".to_owned()),
        (200, "{\"categories\":[]}".to_owned()),
        (200, "x".repeat(2 * 1024 * 1024 + 1)),
    ] {
        let (base, task) = server(move |_, _| (status, body.clone())).await;
        assert!(crate::wildcard::native_wildcard_library(base)
            .await
            .is_err());
        task.abort();
    }
}

#[tokio::test]
async fn wildcard_prepare_requires_original_plugin_without_submitting() {
    for installed in [false, true] {
        let (base, task) = server(move |path, _| {
            assert_eq!(path, "GET /comfy/object_info HTTP/1.1");
            let mut n = nodes();
            if installed {
                n[crate::wildcard::NODE] = json!({});
            }
            (200, n.to_string())
        })
        .await;
        let mut i = intent();
        i["wildcard"] = json!({"style":"Booru","seed":0,"reroll":0,"token_budget":200,"auto_reroll":true,"selection_state":{}});
        let result = Jobs::default().prepare(base, i).await;
        if installed {
            assert_eq!(
                result.unwrap()["graph"]["WP"]["class_type"],
                crate::wildcard::NODE
            );
        } else {
            let error = result.unwrap_err();
            assert!(error.contains(crate::wildcard::NODE), "{error}");
        }
        task.abort();
    }
}

fn nodes() -> Value {
    json!({"CheckpointLoaderSimple":{"input":{"required":{"ckpt_name":[["sd/model.safetensors"]]}}},
        "CLIPTextEncode":{},"EmptyLatentImage":{},"KSampler":{"input":{"required":{"sampler_name":[["euler"]],"scheduler":[["normal"]]}}},"VAEDecode":{},"SaveImage":{},
        "LoadImage":{"input":{"required":{"image":[["ref.png","my ref ä.png","../bad.png"]]}}},"VAEEncode":{}})
}

async fn server<F>(mut respond: F) -> (String, tokio::task::JoinHandle<()>)
where
    F: FnMut(String, Value) -> (u16, String) + Send + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/comfy", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            let (head_end, length) = loop {
                let mut buf = [0; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]);
                    let length = head
                        .lines()
                        .filter_map(|l| l.split_once(':'))
                        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    break (end + 4, length);
                }
            };
            while bytes.len() < head_end + length {
                let mut buf = [0; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            let path = String::from_utf8_lossy(&bytes[..head_end])
                .lines()
                .next()
                .unwrap()
                .to_owned();
            let body = if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&bytes[head_end..head_end + length]).unwrap()
            };
            // The live-preview websocket is best effort: refusing it must not affect the job.
            let (code, body) = if path.starts_with("GET /comfy/ws?clientId=") {
                (404, "{}".to_owned())
            } else {
                respond(path, body)
            };
            if code == 0 {
                continue;
            } // Simulate a lost POST reply after receipt.
            let head = format!("HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:9/forbidden\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
        }
    });
    (base, task)
}

#[tokio::test]
async fn explicit_prepare_submit_and_correlated_completion() {
    let posts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = posts.clone();
    let mut tuple = Value::Null;
    let mut polls = 0;
    let (base, server) = server(move |path, body| {
        match path.as_str() {
            "GET /comfy/object_info HTTP/1.1" => (200,nodes().to_string()),
            "POST /comfy/prompt HTTP/1.1" => {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                assert_eq!(body.as_object().unwrap().len(),3);
                assert_eq!(body["extra_data"],json!({"preview_method":"auto","extra_pnginfo":{"deas_output_naming":true}}));
                assert_eq!(body["prompt"],compile(&intent()).unwrap());
                assert!(uuid::Uuid::parse_str(body["client_id"].as_str().unwrap()).is_ok());
                tuple = json!([1,PROMPT_ID,body["prompt"],{"client_id":body["client_id"]},["7"]]);
                (200,json!({"prompt_id":PROMPT_ID,"number":1,"node_errors":{}}).to_string())
            },
            p if p == format!("GET /comfy/history/{PROMPT_ID} HTTP/1.1") => {
                polls += 1;
                (200,if polls < 3 {json!({})} else {json!({PROMPT_ID:{"prompt":tuple,"outputs":{"7":{"images":[{"filename":"DEAS_0001.png","subfolder":"","type":"output"}]}},"status":{"completed":true,"status_str":"success","messages":[]}}})}.to_string())
            },
            "GET /comfy/queue HTTP/1.1" => (200,if polls == 1 {json!({"queue_running":[],"queue_pending":[tuple]})} else {json!({"queue_running":[tuple],"queue_pending":[]})}.to_string()),
            _ => panic!("Unexpected request: {path}")
        }
    }).await;
    let jobs = Jobs::default();
    let plan = jobs.prepare(base.clone(), intent()).await.unwrap();
    assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(plan["generationReady"], false);
    assert_eq!(plan["baseUrl"], format!("{base}/"));
    let id = plan["id"].as_str().unwrap().to_owned();
    assert!(jobs.submit(id.clone(), false).await.is_err());
    assert!(jobs.submit("foreign-plan".into(), true).await.is_err());
    let job = jobs.submit(id.clone(), true).await.unwrap();
    assert_eq!(job["state"], "queued");
    assert_eq!(job["intent"], plan["intent"]);
    assert_eq!(job["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(job["generationReady"], false);
    assert!(jobs.submit(id.clone(), true).await.is_err());
    assert!(jobs.prepare(base.clone(), intent()).await.is_err());
    assert!(jobs.status("foreign-job".into()).await.is_err());
    let job_id = job["id"].as_str().unwrap().to_owned();
    for expected in ["queued", "running", "succeeded"] {
        let status = jobs.status(job_id.clone()).await.unwrap();
        assert_eq!(status["state"], expected, "{status}");
        assert_eq!(status["intent"], plan["intent"]);
        assert_eq!(status["generationReady"], false);
        if expected == "succeeded" {
            assert_eq!(status["outputs"].as_array().unwrap().len(), 1);
        }
    }
    assert!(jobs.submit(id, true).await.is_err());
    assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), 1);
    server.abort();
}

#[test]
fn invalid_intents_cannot_smuggle_graphs_or_unbounded_inputs() {
    for field in intent().as_object().unwrap().keys() {
        let mut value = intent();
        value.as_object_mut().unwrap().remove(field);
        assert!(compile(&value).is_err(), "missing {field}");
    }
    for (field, bad) in [
        ("graph", json!({})),
        ("version", json!("1")),
        ("recipeId", json!("Director")),
        ("positivePrompt", json!("x".repeat(16385))),
        ("negativePrompt", json!("\0")),
        ("positivePrompt", json!("😀".repeat(8193))),
        ("positivePrompt", json!(false)),
        ("checkpoint", json!("../model")),
        ("checkpoint", json!("/model")),
        ("checkpoint", json!("dir\\model")),
        ("checkpoint", json!(" model")),
        ("checkpoint", json!("dir//model")),
        ("checkpoint", json!("https://host/model")),
        ("checkpoint", json!("a".repeat(256))),
        ("checkpoint", json!("")),
        ("seed", json!(9_007_199_254_740_992_u64)),
        ("seed", json!(-1)),
        ("seed", json!(0.5)),
        ("width", json!(65)),
        ("width", json!(8200)),
        ("height", json!(56)),
        ("steps", json!(151)),
        ("steps", json!(0)),
        ("cfg", json!(30.1)),
        ("cfg", json!("7")),
        ("sampler", json!("../other")),
        ("scheduler", json!(null)),
        ("outputPrefix", json!("../x")),
        ("outputPrefix", json!("")),
        ("outputPrefix", json!("a".repeat(181))),
        ("outputPrefix", json!("image.")),
    ] {
        let mut value = intent();
        value[field] = bad;
        assert!(compile(&value).is_err(), "accepted {field}: {value}");
    }
    let mut edge = intent();
    edge["positivePrompt"] = json!("😀".repeat(8192));
    edge["cfg"] = json!(0.25);
    edge["seed"] = json!(9_007_199_254_740_991_u64);
    edge["version"] = json!(1.0);
    assert!(compile(&edge).is_ok());
}

#[test]
fn optional_loras_chain_between_checkpoint_and_sampler() {
    let mut with = intent();
    with["loras"] = json!([{"name":"style/a.safetensors","strength":0.8},{"name":"b.safetensors","strength":-1}]);
    let graph = compile(&with).unwrap();
    assert_eq!(graph["L1"]["inputs"]["model"], json!(["1", 0]));
    assert_eq!(graph["L2"]["inputs"]["clip"], json!(["L1", 1]));
    assert_eq!(graph["L2"]["inputs"]["strength_model"], json!(-1));
    assert_eq!(graph["5"]["inputs"]["model"], json!(["L2", 0]));
    assert_eq!(graph["2"]["inputs"]["clip"], json!(["L2", 1]));
    assert_eq!(graph["7"]["class_type"], "SaveImage");
    with["loras"] = json!([]);
    assert_eq!(compile(&with).unwrap(), compile(&intent()).unwrap());
    for bad in [
        json!("x"),
        json!([{"name":"../a","strength":1}]),
        json!([{"name":"a","strength":11}]),
        json!([{"name":"a","strength":1,"extra":1}]),
        json!(vec![json!({"name":"a","strength":1}); 9]),
    ] {
        with["loras"] = bad;
        assert!(compile(&with).is_err(), "accepted loras: {with}");
    }
}

#[test]
fn options_chain_model_patches_and_tile_the_vae() {
    let mut with = intent();
    with["loras"] = json!([{"name":"a.safetensors","strength":1}]);
    with["inputImage"] = json!("ref.png");
    with["denoise"] = json!(0.5);
    with["options"] = json!({"attention":"comfy kitchen attention","cache":{"node":"EasyCache","threshold":0.2},"compile":"inductor","vaeTile":512});
    let graph = compile(&with).unwrap();
    assert_eq!(graph["A"]["inputs"]["model"], json!(["L1", 0]));
    assert_eq!(graph["A"]["inputs"]["attention"], "comfy kitchen attention");
    assert_eq!(graph["E"]["class_type"], "EasyCache");
    assert_eq!(graph["E"]["inputs"]["model"], json!(["A", 0]));
    assert_eq!(graph["T"]["inputs"]["model"], json!(["E", 0]));
    assert_eq!(graph["5"]["inputs"]["model"], json!(["T", 0]));
    assert_eq!(graph["6"]["class_type"], "VAEDecodeTiled");
    assert_eq!(graph["6"]["inputs"]["tile_size"], 512);
    assert_eq!(graph["9"]["class_type"], "VAEEncodeTiled");
    assert_eq!(graph["9"]["inputs"]["pixels"], json!(["8", 0]));
    let mut sage = intent();
    sage["options"] = json!({"sage":"sageattn_qk_int8_pv_fp8_cuda++"});
    assert_eq!(
        compile(&sage).unwrap()["5"]["inputs"]["model"],
        json!(["K", 0])
    );
    let mut empty = intent();
    empty["options"] = json!({});
    assert_eq!(compile(&empty).unwrap(), compile(&intent()).unwrap());
    for bad in [
        json!({"attention":"pytorch attention","sage":"auto"}),
        json!({"fp16Accumulation":true}),
        json!({"cache":{"node":"TeaCache","threshold":0.2}}),
        json!({"cache":{"node":"EasyCache","threshold":4}}),
        json!({"vaeTile":500}),
        json!({"vaeTile":128}),
        json!({"attention":" padded"}),
        json!({"unknown":true}),
        json!([]),
    ] {
        empty["options"] = bad;
        assert!(compile(&empty).is_err(), "accepted options: {empty}");
    }
}

#[test]
fn dasiwa_saver_replaces_save_image_only_when_both_nodes_exist() {
    let mut graph = compile(&intent()).unwrap();
    civitai_saver(
        &mut graph,
        &json!(["SaveImage", "DaSiWa_MetadataImageSaver"]),
    );
    assert_eq!(graph, compile(&intent()).unwrap());
    civitai_saver(
        &mut graph,
        &json!(["DaSiWa_MetadataImageSaver", "DaSiWa_MetadataConfig"]),
    );
    assert_eq!(graph["7"]["class_type"], "DaSiWa_MetadataImageSaver");
    assert_eq!(graph["7"]["inputs"]["filename_prefix"], "DEAS_test");
    assert_eq!(graph["7"]["inputs"]["metadata_config"], json!(["M", 0]));
    assert_eq!(graph["M"]["inputs"]["node_latent"], json!(["5", 0]));
}

#[test]
fn optional_input_image_switches_to_image_to_image() {
    let mut with = intent();
    with["inputImage"] = json!("ref.png");
    with["denoise"] = json!(0.6);
    let graph = compile(&with).unwrap();
    assert_eq!(graph["8"]["class_type"], "LoadImage");
    assert_eq!(graph["9"]["inputs"]["pixels"], json!(["8", 0]));
    assert_eq!(graph["5"]["inputs"]["latent_image"], json!(["9", 0]));
    assert_eq!(graph["5"]["inputs"]["denoise"], json!(0.6));
    assert!(graph.get("4").is_none());
    for (field, bad) in [
        ("denoise", json!(1.5)),
        ("inputImage", json!("../x.png")),
        ("inputImage", json!(" padded.png")),
        ("inputImage", json!("C:/x.png")),
    ] {
        let mut v = with.clone();
        v[field] = bad;
        assert!(compile(&v).is_err(), "accepted {field}: {v}");
    }
    let mut alone = intent();
    alone["denoise"] = json!(0.5);
    assert!(compile(&alone).is_err());
}

#[test]
fn input_mask_resamples_only_the_painted_area_and_composites_onto_the_source() {
    let mut with = intent();
    with["inputImage"] = json!("out.png [output]");
    with["denoise"] = json!(0.8);
    with["inputMask"] = json!("deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png");
    let graph = compile(&with).unwrap();
    assert_eq!(
        graph["W"]["inputs"],
        json!({"image":"deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png","channel":"red"})
    );
    assert_eq!(graph["5"]["inputs"]["latent_image"], json!(["X", 0]));
    assert_eq!(graph["X"]["inputs"]["samples"], json!(["9", 0]));
    assert_eq!(graph["Y"]["inputs"]["destination"], json!(["8", 0]));
    assert_eq!(graph["7"]["inputs"]["images"], json!(["Y", 0]));
    // The DaSiWa saver keeps the composite.
    let mut saver = graph.clone();
    civitai_saver(
        &mut saver,
        &json!(["DaSiWa_MetadataImageSaver", "DaSiWa_MetadataConfig"]),
    );
    assert_eq!(saver["7"]["inputs"]["images"], json!(["Y", 0]));
    for bad in [
        json!("deas-masks/x.png"),
        json!("ref.png"),
        json!("deas-masks/../3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png"),
    ] {
        let mut v = with.clone();
        v["inputMask"] = bad;
        assert!(compile(&v).is_err(), "accepted {v}");
    }
    let mut resized = with.clone();
    resized["inputResize"] = json!({"width":512,"height":768,"crop":"disabled"});
    assert!(
        compile(&resized).is_err(),
        "mask must match the unresized source"
    );
    let mut no_image = intent();
    no_image["inputMask"] = with["inputMask"].clone();
    assert!(compile(&no_image).is_err());
}

#[test]
fn inpaint_crop_and_blur_use_model_resolution_and_restore_original_coordinates() {
    let mut i = intent();
    i["inputImage"] = json!("out.png [output]");
    i["denoise"] = json!(0.8);
    i["inputMask"] = json!("deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png");
    i["maskBlur"] = json!(8);
    i["inpaintCrop"] =
        json!({"x":40,"y":20,"width":120,"height":80,"targetWidth":1024,"targetHeight":1024});
    let g = compile(&i).unwrap();
    assert_eq!(
        g["IC"]["inputs"],
        json!({"image":["8",0],"x":40,"y":20,"width":120,"height":80})
    );
    assert_eq!(
        g["IS"]["inputs"],
        json!({"image":["IC",0],"upscale_method":"lanczos","width":1024,"height":1024,"crop":"disabled"})
    );
    assert_eq!(g["9"]["inputs"]["pixels"], json!(["IS", 0]));
    assert_eq!(
        g["MB"]["inputs"],
        json!({"image":["MI",0],"blur_radius":8,"sigma":1})
    );
    assert_eq!(g["MC"]["inputs"]["mask"], json!(["BM", 0]));
    assert_eq!(g["X"]["inputs"]["mask"], json!(["NM", 0]));
    assert_eq!(
        g["Y"]["inputs"],
        json!({"destination":["8",0],"source":["IR",0],"x":40,"y":20,"resize_source":false,"mask":["MC",0]})
    );
    assert_eq!(g["IR"]["inputs"]["width"], 120);
    assert_eq!(g["IR"]["inputs"]["height"], 80);
    for bad in [json!(-1), json!(1.5), json!(32), json!(65), Value::Null] {
        let mut v = i.clone();
        v["maskBlur"] = bad;
        assert!(compile(&v).is_err());
    }
    for (key, bad) in [
        ("x", json!(-1)),
        ("width", json!(9000)),
        ("targetWidth", json!(999)),
        ("extra", json!(1)),
    ] {
        let mut v = i.clone();
        v["inpaintCrop"][key] = bad;
        assert!(compile(&v).is_err());
    }
    let mut layered = i.clone();
    layered["inputLayers"] =
        json!([{"image":"out.png [output]","x":0,"y":0,"width":64,"height":64}]);
    layered["options"] = json!({"vaeTile":512});
    let layered = compile(&layered).unwrap();
    assert_eq!(layered["IC"]["inputs"]["image"], json!(["B0", 0]));
    assert_eq!(layered["Y"]["inputs"]["destination"], json!(["B0", 0]));
    assert_eq!(layered["9"]["class_type"], "VAEEncodeTiled");
    assert_eq!(layered["9"]["inputs"]["pixels"], json!(["IS", 0]));
    let mut no_mask = i.clone();
    no_mask.as_object_mut().unwrap().remove("inputMask");
    assert!(compile(&no_mask).is_err());
    i.as_object_mut().unwrap().remove("inpaintCrop");
    i["maskBlur"] = json!(0);
    let zero = compile(&i).unwrap();
    i.as_object_mut().unwrap().remove("maskBlur");
    assert_eq!(zero, compile(&i).unwrap());
}

#[tokio::test]
async fn prepare_requires_only_emitted_crop_and_blur_nodes() {
    let mut failures = vec![];
    for (crop, blur) in [(false, 0), (false, 8), (true, 0), (true, 8)] {
        let mut i = intent();
        i["inputImage"] = json!("ref.png");
        i["denoise"] = json!(0.8);
        i["inputMask"] = json!("deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png");
        i["maskBlur"] = json!(blur);
        if crop {
            i["inpaintCrop"] = json!({"x":40,"y":20,"width":120,"height":80,"targetWidth":1024,"targetHeight":1024});
        }
        let mut required = vec![
            "LoadImageMask",
            "SetLatentNoiseMask",
            "ImageCompositeMasked",
        ];
        if crop {
            required.extend(["ImageScale", "ImageCrop", "CropMask"]);
        }
        if crop || blur > 0 {
            required.extend(["MaskToImage", "ImageToMask"]);
        }
        if blur > 0 {
            required.push("ImageBlur");
        }
        for absent in std::iter::once(None).chain(required.iter().copied().map(Some)) {
            let mut info = nodes();
            for name in &required {
                info[*name] = json!({});
            }
            if let Some(name) = absent {
                info.as_object_mut().unwrap().remove(name);
            }
            let (base, task) = server(move |path, _| {
                assert_eq!(path, "GET /comfy/object_info HTTP/1.1");
                (200, info.to_string())
            })
            .await;
            let result = Jobs::default().prepare(base, i.clone()).await;
            task.abort();
            match (absent, result) {
                (None, Ok(_)) => {}
                (Some(name), Err(error)) if error.contains(name) => {}
                (absent, result) => failures.push(format!(
                    "crop={crop}, blur={blur}, absent={absent:?}: {result:?}"
                )),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn mask_upload_posts_a_fresh_png_name_into_the_mask_folder() {
    assert!(
        native_mask_upload("http://127.0.0.1:1/".into(), b"GIF89a".to_vec())
            .await
            .is_err()
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/comfy", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        while !bytes.ends_with(b"--\r\n") {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        assert!(
            text.starts_with("POST /comfy/upload/image HTTP/1.1"),
            "{text}"
        );
        let name = text
            .split("filename=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        assert!(
            text.contains("name=\"subfolder\"\r\n\r\ndeas-masks\r\n")
                && text.contains("\x0c\x0d\x0e")
        );
        let body = json!({"name":name,"subfolder":"deas-masks","type":"input"}).to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        name
    });
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(b"\x0c\x0d\x0e");
    let stored = native_mask_upload(base, png).await.unwrap();
    assert_eq!(stored, format!("deas-masks/{}", task.await.unwrap()));
    assert!(mask_name(&stored));
}

#[test]
fn input_layers_paste_scaled_images_onto_the_source_before_resize_and_inpaint() {
    let mut with = intent();
    with["inputImage"] = json!("src.png [output]");
    with["denoise"] = json!(0.6);
    with["inputLayers"] = json!([{"image":"cat.png","x":10,"y":20,"width":100,"height":50},{"image":"dog.png [output]","x":0,"y":0,"width":8,"height":8}]);
    let graph = compile(&with).unwrap();
    assert_eq!(graph["R0"]["inputs"]["image"], json!(["I0", 0]));
    assert_eq!(
        graph["B0"]["inputs"],
        json!({"destination":["8",0],"source":["R0",0],"x":10,"y":20,"resize_source":false})
    );
    assert_eq!(graph["B1"]["inputs"]["destination"], json!(["B0", 0]));
    assert_eq!(graph["9"]["inputs"]["pixels"], json!(["B1", 0]));
    let mut resized = with.clone();
    resized["inputResize"] = json!({"width":512,"height":768,"crop":"disabled"});
    assert_eq!(
        compile(&resized).unwrap()["S"]["inputs"]["image"],
        json!(["B1", 0])
    );
    let mut masked = with.clone();
    masked["inputMask"] = json!("deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png");
    assert_eq!(
        compile(&masked).unwrap()["Y"]["inputs"]["destination"],
        json!(["B1", 0])
    );
    for bad in [
        json!([]),
        json!([{"image":"../x.png","x":0,"y":0,"width":8,"height":8}]),
        json!([{"image":"x.png","x":0,"y":0,"width":0,"height":8}]),
        json!([{"image":"x.png","x":-1,"y":0,"width":8,"height":8}]),
        json!([{"image":"x.png","x":0,"y":0,"width":8}]),
        json!(vec![
            json!({"image":"x.png","x":0,"y":0,"width":8,"height":8});
            5
        ]),
    ] {
        let mut v = with.clone();
        v["inputLayers"] = bad;
        assert!(compile(&v).is_err(), "accepted {v}");
    }
    let mut no_image = intent();
    no_image["inputLayers"] = with["inputLayers"].clone();
    assert!(compile(&no_image).is_err());
}

#[tokio::test]
async fn prepare_checks_input_layers_against_the_backend_list() {
    let mut list = nodes();
    list["ImageScale"] = json!({});
    list["ImageCompositeMasked"] = json!({});
    list["LoadImageMask"] = json!({});
    list["SetLatentNoiseMask"] = json!({});
    let (base, task) = server(move |_, _| (200, list.to_string())).await;
    let jobs = Jobs::default();
    let mut with = intent();
    with["inputImage"] = json!("ref.png");
    with["denoise"] = json!(0.6);
    // The uploaded mask is not in object_info's top-level input list; ComfyUI checks it.
    with["inputMask"] = json!("deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png");
    with["inputLayers"] = json!([{"image":"my ref ä.png","x":0,"y":0,"width":8,"height":8},{"image":"DEAS/out.png [output]","x":0,"y":0,"width":8,"height":8}]);
    assert!(jobs.prepare(base.clone(), with.clone()).await.is_ok());
    with["inputLayers"][0]["image"] = json!("missing.png");
    assert!(jobs.prepare(base, with).await.is_err());
    task.abort();
}

/// `DEAS_LIVE_COMFY=<url> DEAS_LIVE_MASK=<png> cargo test --lib live_mask_upload -- --ignored --nocapture` (throwaway backend only).
#[tokio::test]
#[ignore]
async fn live_mask_upload() {
    let base = std::env::var("DEAS_LIVE_COMFY").unwrap();
    let png = std::fs::read(std::env::var("DEAS_LIVE_MASK").unwrap()).unwrap();
    println!("{}", native_mask_upload(base, png).await.unwrap());
}

#[test]
fn refine_pass_upscales_resizes_and_resamples_after_the_first_decode() {
    let mut i = intent();
    i["refine"] =
        json!({"width":1024,"height":1536,"denoise":0.3,"upscaleModel":"2x-Sharp.safetensors"});
    let g = compile(&i).unwrap();
    assert_eq!(g["RU"]["inputs"]["image"], json!(["6", 0]));
    assert_eq!(g["RL"]["inputs"]["model_name"], "2x-Sharp.safetensors");
    assert_eq!(
        g["RS"]["inputs"],
        json!({"image":["RU",0],"upscale_method":"lanczos","width":1024,"height":1536,"crop":"disabled"})
    );
    assert_eq!(g["RE"]["inputs"]["pixels"], json!(["RS", 0]));
    assert_eq!(g["R5"]["inputs"]["latent_image"], json!(["RE", 0]));
    assert_eq!(g["R5"]["inputs"]["denoise"], json!(0.3));
    assert_eq!(g["R5"]["inputs"]["seed"], json!(123));
    assert_eq!(g["7"]["inputs"]["images"], json!(["R6", 0]));
    // Same size without a model: no resample of the first pass.
    i["refine"] = json!({"width":512,"height":768,"denoise":0.3});
    let g = compile(&i).unwrap();
    assert!(g.get("RS").is_none() && g.get("RL").is_none());
    assert_eq!(g["RE"]["inputs"]["pixels"], json!(["6", 0]));
    // Model-fixed schedules carry their own refine tail.
    i["steps"] = json!(2);
    i["sigmas"] = json!([1.0, 0.5, 0.0]);
    assert!(compile(&i).is_err());
    i["refine"]["sigmas"] = json!([0.5, 0.0]);
    let g = compile(&i).unwrap();
    assert_eq!(g["RZ"]["inputs"]["sigmas"], "0.5, 0");
    assert_eq!(g["R5"]["class_type"], "SamplerCustomAdvanced");
    for (k, bad) in [
        ("width", json!(1001)),
        ("denoise", json!(0)),
        ("upscaleModel", json!("../x.pth")),
        ("extra", json!(1)),
    ] {
        let mut v = i.clone();
        v["refine"][k] = bad;
        assert!(compile(&v).is_err(), "accepted {k}");
    }
}

#[test]
fn upscale_model_runs_on_the_source_before_the_exact_resize() {
    let mut i = intent();
    i["inputImage"] = json!("ref.png");
    i["denoise"] = json!(0.35);
    i["upscaleModel"] = json!("2x-Sharp.safetensors");
    assert!(compile(&i).is_err(), "upscaleModel needs inputResize");
    i["inputResize"] = json!({"width":512,"height":768,"crop":"disabled"});
    let g = compile(&i).unwrap();
    assert_eq!(g["UM"]["inputs"]["image"], json!(["8", 0]));
    assert_eq!(g["S"]["inputs"]["image"], json!(["UM", 0]));
    assert_eq!(g["9"]["inputs"]["pixels"], json!(["S", 0]));
}

#[tokio::test]
async fn prepare_checks_upscale_models_against_the_v3_backend_list() {
    let mut list = nodes();
    list["UpscaleModelLoader"] = json!({"input":{"required":{"model_name":["COMBO",{"multiselect":false,"options":["2x-Sharp.safetensors"]}]}}});
    list["ImageUpscaleWithModel"] = json!({});
    list["ImageScale"] = json!({});
    let (base, task) = server(move |_, _| (200, list.to_string())).await;
    let jobs = Jobs::default();
    let mut with = intent();
    with["refine"] =
        json!({"width":1024,"height":1536,"denoise":0.3,"upscaleModel":"2x-Sharp.safetensors"});
    assert!(jobs.prepare(base.clone(), with.clone()).await.is_ok());
    with["refine"]["upscaleModel"] = json!("missing.pth");
    assert!(jobs.prepare(base, with).await.is_err());
    task.abort();
}

#[tokio::test]
async fn prepare_validates_input_image_against_the_backend_list() {
    let (base, task) = server(|_, _| (200, nodes().to_string())).await;
    let jobs = Jobs::default();
    let mut with = intent();
    with["inputImage"] = json!("ref.png");
    with["denoise"] = json!(0.6);
    assert!(jobs.prepare(base.clone(), with.clone()).await.is_ok());
    with["inputImage"] = json!("my ref ä.png"); // user file names with spaces/umlauts work
    assert!(jobs.prepare(base.clone(), with.clone()).await.is_ok());
    with["inputImage"] = json!("DEAS/out.png [output]"); // output images are resolved by ComfyUI, not object_info
    assert!(jobs.prepare(base.clone(), with.clone()).await.is_ok());
    with["inputImage"] = json!("missing.png");
    assert!(jobs.prepare(base, with).await.is_err());
    task.abort();
}

#[tokio::test]
async fn prepare_requires_fresh_native_prerequisites_and_replaces_only_unsubmitted_plan() {
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = count.clone();
    let (base, task) = server(move |path, _| {
        assert_eq!(path, "GET /comfy/object_info HTTP/1.1");
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        (200, nodes().to_string())
    })
    .await;
    let jobs = Jobs::default();
    let first = jobs.prepare(base.clone(), intent()).await.unwrap();
    let second = jobs.prepare(base.clone(), intent()).await.unwrap();
    assert_ne!(first["id"], second["id"]);
    assert!(jobs
        .submit(first["id"].as_str().unwrap().into(), true)
        .await
        .is_err());
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2);
    task.abort();
    for field in ["node", "model", "sampler", "scheduler"] {
        let mut info = nodes();
        match field {
            "node" => {
                info.as_object_mut().unwrap().remove("SaveImage");
            }
            "model" => {
                info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0] = json!([])
            }
            "sampler" => info["KSampler"]["input"]["required"]["sampler_name"][0] = json!([]),
            _ => info["KSampler"]["input"]["required"]["scheduler"][0] = json!([]),
        }
        let (base, task) = server(move |path, _| {
            assert!(path.starts_with("GET "));
            (200, info.to_string())
        })
        .await;
        assert!(
            Jobs::default().prepare(base, intent()).await.is_err(),
            "{field}"
        );
        task.abort();
    }
    for url in [
        "http://user:secret@localhost:9",
        "http://@localhost:9",
        "http://localhost:9/?token=x",
        "http://localhost:9/#x",
        "file:///etc/passwd",
    ] {
        assert!(jobs.prepare(url.into(), intent()).await.is_err());
    }
}

#[tokio::test]
async fn post_ambiguity_keeps_native_id_without_retry_or_success_claim() {
    for (code,reply,expected) in [
        (0,String::new(),"unknown"), (302,"{}".into(),"unknown"),
        (200,"<html>not comfy</html>".into(),"unknown"), (200,"{broken".into(),"unknown"),
        (500,"{}".into(),"unknown"), (401,"{}".into(),"unknown"),
        (200,json!({"prompt_id":"../unsafe","number":1,"node_errors":{}}).to_string(),"unknown"),
        (200,json!({"prompt_id":PROMPT_ID.to_uppercase(),"number":1,"node_errors":{}}).to_string(),"unknown"),
        (200,json!({"prompt_id":PROMPT_ID,"number":-1,"node_errors":{}}).to_string(),"unknown"),
        (200,json!({"prompt_id":PROMPT_ID,"number":1}).to_string(),"unknown"),
        (400,json!({"error":{"message":"invalid prompt"},"node_errors":{"5":{"errors":["bad model"]}}}).to_string(),"failed"),
        (200,json!({"prompt_id":PROMPT_ID,"number":1,"node_errors":{"5":{"errors":["invalid"]}}}).to_string(),"failed"),
        (200," ".repeat(RESPONSE_LIMIT+1),"unknown"),
    ] {
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = count.clone();
        let (base,task) = server(move |path,_| {
            if path == "GET /comfy/object_info HTTP/1.1" {return (200,nodes().to_string());}
            assert_eq!(path,"POST /comfy/prompt HTTP/1.1");
            observed.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            (code,reply.clone())
        }).await;
        let jobs = Jobs::default();
        let plan = jobs.prepare(base,intent()).await.unwrap();
        let plan_id = plan["id"].as_str().unwrap().to_owned();
        let job = jobs.submit(plan_id.clone(),true).await.unwrap();
        assert_eq!(job["state"],expected,"{job}");
        assert!(job["promptId"].is_null());
        assert!(canonical_uuid(job["id"].as_str().unwrap()));
        assert_eq!(job["outputs"],json!([]));
        assert_eq!(job["generationReady"],false);
        assert!(job["error"].as_str().unwrap().chars().count() <= 800);
        assert_eq!(jobs.status(job["id"].as_str().unwrap().into()).await.unwrap(),job);
        assert!(jobs.submit(plan_id,true).await.is_err());
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst),1);
        task.abort();
    }
}

#[tokio::test]
async fn concurrent_submit_reserves_job_before_any_network_await() {
    let (base, task) = server(|path, _| {
        if path.starts_with("GET ") {
            (200, nodes().to_string())
        } else {
            (
                400,
                json!({"error":{"message":"validation failed"},"node_errors":{}}).to_string(),
            )
        }
    })
    .await;
    let jobs = Jobs::default();
    let plan = jobs.prepare(base.clone(), intent()).await.unwrap();
    let id = plan["id"].as_str().unwrap().to_owned();
    let (first, duplicate) =
        tokio::join!(jobs.submit(id.clone(), true), jobs.submit(id.clone(), true));
    assert!(first.is_ok());
    assert!(duplicate.is_err());
    assert_eq!(first.unwrap()["state"], "failed");
    assert!(jobs.submit(id, true).await.is_err());
    let next = jobs.prepare(base, intent()).await.unwrap();
    assert_ne!(plan["id"], next["id"]);
    task.abort();
}

#[tokio::test]
async fn history_and_queue_refuse_foreign_identity_and_unsafe_outputs() {
    for (case, expected) in [
        ("six_fields", "succeeded"),
        ("error", "failed"),
        ("foreign_id", "unknown"),
        ("foreign_client", "unknown"),
        ("foreign_graph", "unknown"),
        ("foreign_key", "unknown"),
        ("bad_tuple", "unknown"),
        ("bad_status", "unknown"),
        ("empty_outputs", "unknown"),
        ("other_node", "unknown"),
        ("filename_path", "unknown"),
        ("filename_url", "unknown"),
        ("subfolder_traversal", "unknown"),
        ("subfolder_absolute", "unknown"),
        ("backslash", "unknown"),
        ("encoded_path", "unknown"),
        ("temp_output", "unknown"),
        ("too_many", "unknown"),
        ("absent", "unknown"),
        ("foreign_queue", "unknown"),
        ("queue_graph", "unknown"),
        ("queue_client", "unknown"),
        ("duplicate_queue", "unknown"),
        ("incomplete", "running"),
        ("history_html", "unknown"),
        ("history_redirect", "unknown"),
        ("queue_bad_json", "unknown"),
    ] {
        let mut tuple = Value::Null;
        let (base,task) = server(move |path,body| {
            if path == "GET /comfy/object_info HTTP/1.1" {return (200,nodes().to_string());}
            if path == "POST /comfy/prompt HTTP/1.1" {
                tuple = json!([0,PROMPT_ID,body["prompt"],{"client_id":body["client_id"],"create_time":1234},["7"]]);
                return (200,json!({"prompt_id":PROMPT_ID,"number":0,"node_errors":{}}).to_string());
            }
            if path == format!("GET /comfy/history/{PROMPT_ID} HTTP/1.1") {
                if case == "history_html" {return (200,"<html>error</html>".into());}
                if case == "history_redirect" {return (302,"{}".into());}
                if ["absent","foreign_queue","queue_graph","queue_client","duplicate_queue","queue_bad_json"].contains(&case) {return (200,"{}".into());}
                let mut entry = json!({"prompt":tuple,"outputs":{"7":{"images":[{"filename":"image.png","subfolder":"DEAS/run-1","type":"output"}]}},"status":{"completed":true,"status_str":"success","messages":[]}});
                match case {
                    "six_fields" => entry["prompt"].as_array_mut().unwrap().push(json!({"hidden":"not returned"})),
                    "error" => entry["status"] = json!({"completed":true,"status_str":"error","messages":[["execution_error",{"node_id":"5","node_type":"KSampler","exception_type":"RuntimeError","exception_message":"failure".repeat(1000)}]]}),
                    "foreign_id" => entry["prompt"][1] = json!("other"),
                    "foreign_client" => entry["prompt"][3]["client_id"] = json!("other"),
                    "foreign_graph" => entry["prompt"][2]["5"]["inputs"]["seed"] = json!(999),
                    "bad_tuple" => entry["prompt"] = json!([]),
                    "bad_status" => entry["status"]["completed"] = json!("true"),
                    "empty_outputs" => entry["outputs"]["7"]["images"] = json!([]),
                    "other_node" => entry["outputs"] = json!({"99":{"images":[{"filename":"image.png","subfolder":"","type":"output"}]}}),
                    "filename_path" => entry["outputs"]["7"]["images"][0]["filename"] = json!("../image.png"),
                    "filename_url" => entry["outputs"]["7"]["images"][0]["filename"] = json!("https://host/image.png"),
                    "subfolder_traversal" => entry["outputs"]["7"]["images"][0]["subfolder"] = json!("../private"),
                    "subfolder_absolute" => entry["outputs"]["7"]["images"][0]["subfolder"] = json!("/private"),
                    "backslash" => entry["outputs"]["7"]["images"][0]["subfolder"] = json!("dir\\private"),
                    "encoded_path" => entry["outputs"]["7"]["images"][0]["filename"] = json!("%2e%2e%2fimage.png"),
                    "temp_output" => entry["outputs"]["7"]["images"][0]["type"] = json!("temp"),
                    "too_many" => entry["outputs"]["7"]["images"] = json!(vec![json!({"filename":"image.png","subfolder":"","type":"output"});65]),
                    "incomplete" => entry["status"]["completed"] = json!(false),
                    _ => {},
                }
                return (200,if case == "foreign_key" {json!({"other":entry})} else {json!({PROMPT_ID:entry})}.to_string());
            }
            assert_eq!(path,"GET /comfy/queue HTTP/1.1");
            if case == "queue_bad_json" {return (200,"[".into());}
            let mut matching = tuple.clone();
            if case == "foreign_queue" {matching[1] = json!("other");}
            if case == "queue_graph" {matching[2] = json!({});}
            if case == "queue_client" {matching[3]["client_id"] = json!("other");}
            (200,match case {
                "absent" => json!({"queue_running":[],"queue_pending":[]}),
                "duplicate_queue" => json!({"queue_running":[matching],"queue_pending":[tuple]}),
                _ => json!({"queue_running":[matching],"queue_pending":[]}),
            }.to_string())
        }).await;
        let jobs = Jobs::default();
        let plan = jobs.prepare(base, intent()).await.unwrap();
        let queued = jobs
            .submit(plan["id"].as_str().unwrap().into(), true)
            .await
            .unwrap();
        let job = jobs
            .status(queued["id"].as_str().unwrap().into())
            .await
            .unwrap();
        assert_eq!(job["state"], expected, "case {case}: {job}");
        assert_eq!(job["generationReady"], false);
        if expected != "succeeded" {
            assert_eq!(job["outputs"], json!([]));
        }
        if let Some(error) = job["error"].as_str() {
            assert!(error.chars().count() <= 800);
        }
        if case == "error" {
            assert!(job["error"].as_str().unwrap().contains("KSampler"));
        }
        assert!(jobs
            .submit(plan["id"].as_str().unwrap().into(), true)
            .await
            .is_err());
        task.abort();
    }
}

#[tokio::test]
async fn streamed_responses_and_total_request_duration_are_bounded() {
    for chunked in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = crate::validate_base_url(&format!("http://{}", listener.local_addr().unwrap()))
            .unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            if chunked {
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
                let chunk = format!(
                    "{:x}\r\n{}\r\n0\r\n\r\n",
                    RESPONSE_LIMIT + 1,
                    " ".repeat(RESPONSE_LIMIT + 1)
                );
                let _ = socket.write_all(chunk.as_bytes()).await;
            } else {
                tokio::time::sleep(Duration::from_secs(11)).await;
            }
        });
        let start = std::time::Instant::now();
        let error = get(&client().unwrap(), &base, "history/test")
            .await
            .unwrap_err();
        if chunked {
            assert!(error.contains("size limit"));
        } else {
            assert!(start.elapsed() >= Duration::from_secs(9));
            assert!(start.elapsed() < Duration::from_secs(11));
        }
        task.abort();
    }
}

#[tokio::test]
async fn current_session_snapshot_survives_frontend_remount_without_network() {
    let jobs = Jobs::default();
    assert_eq!(jobs.current().unwrap(), Value::Null);
    let (base, task) = server(|path, _| {
        if path.starts_with("GET ") {
            (200, nodes().to_string())
        } else {
            (0, String::new())
        }
    })
    .await;
    let plan = jobs.prepare(base, intent()).await.unwrap();
    assert_eq!(jobs.current().unwrap(), Value::Null);
    let job = jobs
        .submit(plan["id"].as_str().unwrap().into(), true)
        .await
        .unwrap();
    task.abort();
    assert_eq!(job["state"], "unknown");
    assert_eq!(jobs.current().unwrap(), job);
    assert_eq!(jobs.current().unwrap(), job);
    assert_eq!(Jobs::default().current().unwrap(), Value::Null);
}

#[test]
fn native_graph_matches_fixed_typescript_compiler() {
    let graph = compile(&intent()).unwrap();
    assert_eq!(
        graph,
        json!({
            "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sd/model.safetensors"}},
            "2":{"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["1",1]}},
            "3":{"class_type":"CLIPTextEncode","inputs":{"text":"","clip":["1",1]}},
            "4":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":768,"batch_size":1}},
            "5":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0],"seed":123,"steps":20,"cfg":7,"sampler_name":"euler","scheduler":"normal","denoise":1}},
            "6":{"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
            "7":{"class_type":"SaveImage","inputs":{"images":["6",0],"filename_prefix":"DEAS_test"}}
        })
    );
}

#[test]
fn resize_graph_and_validation() {
    let mut image = intent();
    image["inputImage"] = json!("ref.png");
    image["denoise"] = json!(0.6);
    let old = compile(&image).unwrap();
    for crop in ["disabled", "center"] {
        let resize = json!({"width":512,"height":768,"crop":crop});
        image["inputResize"] = resize.clone();
        let graph = compile(&image).unwrap();
        assert_eq!(
            graph["S"],
            json!({"class_type":"ImageScale","inputs":{"image":["8",0],"upscale_method":"lanczos","width":512,"height":768,"crop":crop}})
        );
        assert_eq!(graph["9"]["inputs"]["pixels"], json!(["S", 0]));
        assert!(graph.get("P").is_none());
        let mut split = image.clone();
        split["diffusion"] = json!({"textEncoder":"clip","clipType":"sdxl","vae":"vae"});
        split["loras"] = json!([{"name":"lora","strength":1}]);
        let split = compile(&split).unwrap();
        assert_eq!(split["9"]["inputs"]["vae"], json!(["V", 0]));
        assert_eq!(split["5"]["inputs"]["model"], json!(["L1", 0]));
        let pad = json!({"left":8,"right":16,"top":24,"bottom":32});
        image["inputResize"]["pad"] = pad.clone();
        image["width"] = json!(536);
        image["height"] = json!(824);
        let graph = compile(&image).unwrap();
        assert_eq!(
            graph["P"],
            json!({"class_type":"ImagePadForOutpaint","inputs":{"image":["S",0],"left":8,"right":16,"top":24,"bottom":32,"feathering":0}})
        );
        assert_eq!(graph["9"]["inputs"]["pixels"], json!(["P", 0]));
        assert_eq!(graph["5"], old["5"]);
        image["width"] = json!(512);
        image["height"] = json!(768);
        let mut bad = vec![
            json!(null),
            json!([]),
            json!("resize"),
            json!({}),
            json!({"width":512,"height":768}),
            json!({"width":512,"height":768,"crop":crop,"extra":1}),
        ];
        for field in ["width", "height"] {
            for value in [
                json!(0),
                json!(-8),
                json!(7),
                json!(511),
                json!(512.5),
                json!(8200),
                json!("512"),
            ] {
                let mut r = resize.clone();
                r[field] = value;
                bad.push(r);
            }
        }
        for value in [json!("fit"), json!(null), json!(1)] {
            let mut r = resize.clone();
            r["crop"] = value;
            bad.push(r);
        }
        for value in [
            json!(null),
            json!([]),
            json!({}),
            json!({"left":0,"right":0,"top":0}),
            json!({"left":0,"right":0,"top":0,"bottom":0,"extra":0}),
            json!({"left":8,"right":0,"top":0,"bottom":0}),
        ] {
            let mut r = resize.clone();
            r["pad"] = value;
            bad.push(r);
        }
        for value in [json!(-8), json!(1), json!(8.5), json!(8200), json!("8")] {
            let mut r = resize.clone();
            r["pad"] = pad.clone();
            r["pad"]["left"] = value;
            bad.push(r);
        }
        for r in bad {
            image["inputResize"] = r;
            assert!(compile(&image).is_err(), "accepted {image}");
        }
        let mut text = intent();
        text["inputResize"] = resize;
        assert!(compile(&text).is_err());
    }
    image.as_object_mut().unwrap().remove("inputResize");
    assert_eq!(compile(&image).unwrap(), old);
    for (width, height, valid) in [
        (3840, 2160, true),
        (4096, 4096, true),
        (8192, 2048, true),
        (2048, 8192, true),
        (8192, 2056, false),
    ] {
        let mut v = intent();
        v["width"] = json!(width);
        v["height"] = json!(height);
        assert_eq!(compile(&v).is_ok(), valid);
    }
}

#[tokio::test]
async fn prepare_requires_only_used_resize_nodes() {
    for absent in [None, Some("ImageScale"), Some("ImagePadForOutpaint")] {
        let mut info = nodes();
        info["ImageScale"] = json!({});
        info["ImagePadForOutpaint"] = json!({});
        if let Some(name) = absent {
            info.as_object_mut().unwrap().remove(name);
        }
        let (base, task) = server(move |_, _| (200, info.to_string())).await;
        let jobs = Jobs::default();
        let mut v = intent();
        v["inputImage"] = json!("ref.png");
        v["denoise"] = json!(0.6);
        assert!(jobs.prepare(base.clone(), v.clone()).await.is_ok());
        v["inputResize"] = json!({"width":512,"height":768,"crop":"disabled"});
        assert_eq!(
            jobs.prepare(base.clone(), v.clone()).await.is_ok(),
            absent != Some("ImageScale")
        );
        v["inputResize"]["pad"] = json!({"left":0,"right":0,"top":0,"bottom":0});
        assert_eq!(jobs.prepare(base, v).await.is_ok(), absent.is_none());
        task.abort();
    }
}

#[test]
fn diffusion_intent_splits_model_text_encoder_and_vae() {
    let mut value = intent();
    value["diffusion"] = json!({"textEncoder":"qwen3vl_4b.safetensors","clipType":"krea2","vae":"q/vae.safetensors"});
    value["loras"] = json!([{"name":"k.safetensors","strength":0.5}]);
    let g = compile(&value).unwrap();
    assert_eq!(g["1"]["class_type"], "UNETLoader");
    assert_eq!(g["1"]["inputs"]["unet_name"], value["checkpoint"]);
    assert_eq!(
        g["C"]["inputs"],
        json!({"clip_name":"qwen3vl_4b.safetensors","type":"krea2"})
    );
    assert_eq!(g["L1"]["inputs"]["clip"], json!(["C", 0]));
    assert_eq!(g["2"]["inputs"]["clip"], json!(["L1", 1]));
    assert_eq!(g["6"]["inputs"]["vae"], json!(["V", 0]));
    for bad in [
        json!({"textEncoder":"a.safetensors","clipType":"krea2"}),
        json!({"textEncoder":"../a","clipType":"krea2","vae":"v"}),
        json!({"textEncoder":"a","clipType":"kr ea","vae":"v"}),
    ] {
        value["diffusion"] = bad;
        assert!(compile(&value).is_err(), "accepted {value}");
    }
}

/// Qwen Image 2.1 Turbo: the checkpoint's saved 8-step schedule (official ComfyUI template) replaces KSampler.
#[test]
fn fixed_sigmas_compile_to_manual_sigmas_and_custom_sampler() {
    let mut value = intent();
    value["steps"] = json!(8);
    value["sigmas"] =
        json!([1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0]);
    let g = compile(&value).unwrap();
    assert_eq!(
        g["Z"]["inputs"]["sigmas"],
        "1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"
    );
    assert_eq!(g["5"]["class_type"], "SamplerCustomAdvanced");
    assert_eq!(g["5"]["inputs"]["latent_image"], json!(["4", 0]));
    assert_eq!(g["G"]["inputs"]["model"], json!(["1", 0]));
    assert_eq!(g["G"]["inputs"]["cfg"], value["cfg"]);
    assert_eq!(g["Q"]["inputs"]["sampler_name"], value["sampler"]);
    assert_eq!(g["N"]["inputs"]["noise_seed"], value["seed"]);
    assert_eq!(g["6"]["inputs"]["samples"], json!(["5", 0]));
    assert!(g.get("KSampler").is_none());
    // Image-to-image: the tail of the schedule carries the strength; SamplerCustomAdvanced has no denoise.
    value["inputImage"] = json!("in.png");
    value["denoise"] = json!(0.5);
    value["steps"] = json!(4);
    value["sigmas"] = json!([0.89508, 0.845148, 0.704534, 0.414568, 0]);
    let g = compile(&value).unwrap();
    assert_eq!(g["5"]["inputs"]["latent_image"], json!(["9", 0]));
    assert!(g["5"]["inputs"].get("denoise").is_none());
    for bad in [
        json!([1.0, 0.5]),                // steps mismatch
        json!([1.0, 0.5, 0.5, 0.2, 0]),   // not descending
        json!([1.0, 0.8, 0.6, 0.4, 0.2]), // no zero tail
        json!([1.0, 0.8, 0.6, "0.4", 0]),
        json!("1, 0"),
    ] {
        value["sigmas"] = bad;
        assert!(compile(&value).is_err(), "accepted {value}");
    }
}

#[test]
fn graph_correlation_accepts_comfy_float_rewrites_only() {
    let sent =
        json!({"5":{"inputs":{"cfg":1,"denoise":1,"seed":18446744073709551615u64,"steps":8}}});
    let stored =
        json!({"5":{"inputs":{"cfg":1.0,"denoise":1.0,"seed":18446744073709551615u64,"steps":8}}});
    assert!(same(&stored, &sent));
    assert!(!same(
        &json!({"5":{"inputs":{"cfg":1.5}}}),
        &json!({"5":{"inputs":{"cfg":1}}})
    ));
    assert!(!same(
        &json!({"5":{"inputs":{"cfg":1,"x":0}}}),
        &json!({"5":{"inputs":{"cfg":1}}})
    ));
    assert!(!same(&json!(["1", 0]), &json!(["1", 0, 0])));
}

#[test]
fn preview_frames_need_known_format_and_magic() {
    let jpeg = [&[0, 0, 0, 1, 0, 0, 0, 1][..], &[0xFF, 0xD8, 0xFF, 0xE0]].concat();
    assert_eq!(
        preview_frame(&jpeg).unwrap(),
        "data:image/jpeg;base64,/9j/4A=="
    );
    let png = [&[0, 0, 0, 1, 0, 0, 0, 2][..], b"\x89PNG\r\n\x1a\n"].concat();
    assert!(preview_frame(&png)
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert!(preview_frame(&[0, 0, 0, 1, 0, 0, 0, 2, 0xFF, 0xD8, 0xFF]).is_none());
    assert!(preview_frame(&[0, 0, 0, 4, 0, 0, 0, 1, 0xFF, 0xD8, 0xFF]).is_none());
    assert!(preview_frame(&[0, 0, 0, 1]).is_none());
}
