use super::*;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

fn model_file(root: &Path, category: &str, name: &str) -> PathBuf {
    let path = root.join(category).join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let header = serde_json::to_vec(
        &json!({"fixture.weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}),
    )
    .unwrap();
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    bytes.extend([0u8; 4]);
    std::fs::write(&path, bytes).unwrap();
    path
}

async fn declaration(root: &Path, category: &str, name: &str) -> PathBuf {
    let path = model_file(root, category, name);
    crate::downloads::models::native_model_family_write(
        path.to_str().unwrap().into(),
        Some("sdxl".into()),
    )
    .await
    .unwrap();
    path
}

fn corrupt(path: &Path, replacement: bool) {
    if replacement {
        let other = path.with_extension("replacement");
        std::fs::write(&other, b"replaced weights").unwrap();
        std::fs::rename(other, path).unwrap();
    } else {
        std::fs::write(format!("{}.deas.json", path.display()), b"{broken").unwrap();
    }
}

async fn backend() -> (String, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let posts = Arc::new(AtomicUsize::new(0));
    let observed = posts.clone();
    let (base, task) = server(move |path, _| {
        if path == "GET /comfy/object_info HTTP/1.1" {
            let mut info = nodes();
            info["LoraLoader"] =
                json!({"input":{"required":{"lora_name":[["style/a.safetensors"]]}}});
            (200, info.to_string())
        } else {
            assert_eq!(path, "POST /comfy/prompt HTTP/1.1");
            observed.fetch_add(1, Ordering::SeqCst);
            (
                200,
                json!({"prompt_id":PROMPT_ID,"number":1,"node_errors":{}}).to_string(),
            )
        }
    })
    .await;
    (base, task, posts)
}

const H3_IMAGE_UPSCALER: &str = "minimax_h3_latent_upscaler_2d_conv_v1.safetensors";

async fn h3_image_backend() -> (String, tokio::task::JoinHandle<()>, Arc<AtomicUsize>, Value) {
    let mut draft = intent();
    draft["checkpoint"] = json!("MiniMaxH3/fl2va.safetensors");
    draft["diffusion"] = json!({"textEncoder":"qwen3vl.safetensors","clipType":"minimax","vae":"MiniMaxH3/video_vae.safetensors"});
    draft["h3Edit"] = json!({"shiftVideo":10,"shiftAudio":3});
    (draft["width"], draft["height"]) = (json!(1024), json!(768));
    draft["inputImage"] = json!("ref.png");
    draft["denoise"] = json!(1);
    draft["family"] = json!("minimax-h3");
    draft["latentUpscale"] =
        json!({"model":H3_IMAGE_UPSCALER,"scale":1.5,"steps":4,"denoise":0.35});
    let graph = compile(&draft).unwrap();
    let mut info = nodes();
    for node in graph.as_object().unwrap().values() {
        let class = node["class_type"].as_str().unwrap();
        if info.get(class).is_none() {
            info[class] = json!({});
        }
    }
    info["UNETLoader"] = json!({"input":{"required":{"unet_name":[[draft["checkpoint"]]]}}});
    info["CLIPLoader"] = json!({"input":{"required":{"clip_name":[[draft["diffusion"]["textEncoder"]]],"type":[["minimax"]]}}});
    info["VAELoader"] = json!({"input":{"required":{"vae_name":[[draft["diffusion"]["vae"]]]}}});
    info["DaSiWaH3TiledUpscale"]["input"]["required"]["upscale_model"] =
        json!([[H3_IMAGE_UPSCALER]]);
    let posts = Arc::new(AtomicUsize::new(0));
    let observed = posts.clone();
    let (base, task) = server(move |path, _| {
        if path == "GET /comfy/object_info HTTP/1.1" {
            (200, info.to_string())
        } else {
            assert_eq!(path, "POST /comfy/prompt HTTP/1.1");
            observed.fetch_add(1, Ordering::SeqCst);
            (
                200,
                json!({"prompt_id":PROMPT_ID,"number":1,"node_errors":{}}).to_string(),
            )
        }
    })
    .await;
    (base, task, posts, draft)
}

#[tokio::test]
async fn h3_image_latent_upscale_preparation_records_local_selection() {
    let (base, task, posts, draft) = h3_image_backend().await;
    let root = tempfile::tempdir().unwrap();
    model_file(root.path(), "latent_upscale_models", H3_IMAGE_UPSCALER);
    let jobs = Jobs::default();
    let prepared = jobs
        .prepare_with_models(base, draft, vec![root.path().into()])
        .await
        .unwrap();
    assert_eq!(
        prepared["graph"]["U"]["inputs"]["upscale_model"],
        H3_IMAGE_UPSCALER
    );
    let session = jobs.lock().unwrap();
    let selected = &session.plan.as_ref().unwrap().local_models.selected;
    assert_eq!(
        selected
            .iter()
            .filter(|(field, name)| field == "h3LatentUpscaleModels" && name == H3_IMAGE_UPSCALER)
            .count(),
        1
    );
    assert!(session.job.is_none());
    assert_eq!(posts.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn h3_image_latent_upscale_broken_file_or_sidecar_rejects_before_prompt() {
    let (base, task, posts, draft) = h3_image_backend().await;
    for replacement in [false, true] {
        for after_prepare in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = model_file(root.path(), "latent_upscale_models", H3_IMAGE_UPSCALER);
            let jobs = Jobs::default();
            let error = if after_prepare {
                let plan = jobs
                    .prepare_with_models(base.clone(), draft.clone(), vec![root.path().into()])
                    .await
                    .unwrap();
                corrupt(&path, replacement);
                jobs.submit(plan["id"].as_str().unwrap().into(), true)
                    .await
                    .unwrap_err()
            } else {
                corrupt(&path, replacement);
                jobs.prepare_with_models(base.clone(), draft.clone(), vec![root.path().into()])
                    .await
                    .unwrap_err()
            };
            let expected = if replacement {
                "MODEL_INTEGRITY_INVALID"
            } else {
                "MODEL_METADATA_INVALID"
            };
            assert!(error.contains(expected), "{error}");
            assert!(jobs.lock().unwrap().job.is_none());
            if !after_prepare {
                assert!(jobs.lock().unwrap().plan.is_none());
            }
        }
    }
    assert_eq!(posts.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
#[allow(clippy::result_large_err)] // Tungstenite fixes the handshake callback's error type.
async fn h3_image_latent_upscale_replaced_during_observer_connect_consumes_plan_and_closes_observer(
) {
    for replacement in [false, true] {
        let (base, task, posts, draft) = h3_image_backend().await;
        let root = tempfile::tempdir().unwrap();
        let path = model_file(root.path(), "latent_upscale_models", H3_IMAGE_UPSCALER);
        let jobs = Jobs::default();
        let plan = jobs
            .prepare_with_models(base, draft, vec![root.path().into()])
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        jobs.lock().unwrap().plan.as_mut().unwrap().base =
            crate::validate_base_url(&format!("http://{}", listener.local_addr().unwrap()))
                .unwrap();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                socket,
                move |_: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    corrupt(&path, replacement);
                    Ok(response)
                },
            )
            .await
            .unwrap();
            use futures_util::StreamExt;
            assert!(matches!(
                socket.next().await,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            ));
        });
        let id = plan["id"].as_str().unwrap().to_owned();
        let error = jobs.submit(id.clone(), true).await.unwrap_err();
        assert!(
            error.contains(if replacement {
                "MODEL_INTEGRITY_INVALID"
            } else {
                "MODEL_METADATA_INVALID"
            }),
            "{error}"
        );
        let job = jobs.lock().unwrap().job.clone().unwrap();
        assert_eq!(job.state, "failed");
        assert!(!job.submitting);
        assert!(job.plan.consumed);
        assert!(jobs.lock().unwrap().plan.as_ref().unwrap().consumed);
        assert!(job.prompt_id.is_none());
        let completed = job.live.lock().unwrap().observer.completion();
        super::observer_tests::finished(completed).await;
        tokio::time::timeout(Duration::from_secs(5), peer)
            .await
            .unwrap()
            .unwrap();
        assert!(jobs
            .submit(id, true)
            .await
            .unwrap_err()
            .contains("retries are forbidden"));
        assert_eq!(posts.load(Ordering::SeqCst), 0);
        task.abort();
    }
}

#[test]
fn model_check_second_encoder_uses_projection_slot_and_override_never_hides_corruption() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("text_encoders");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("projection.safetensors");
    let mut head = json!({});
    let mut end = 0u64;
    for (key, shape) in [
        ("audio_aggregate_embed.weight", vec![2048, 188160]),
        ("audio_aggregate_embed.bias", vec![2048]),
        ("video_aggregate_embed.weight", vec![4096, 188160]),
        ("video_aggregate_embed.bias", vec![4096]),
    ] {
        let next = end + shape.iter().product::<u64>();
        head[format!("text_embedding_projection.{key}")] =
            json!({"dtype":"U8", "shape":shape,"data_offsets":[end,next]});
        end = next;
    }
    let header = serde_json::to_vec(&head).unwrap();
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    std::fs::write(&path, &bytes).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(bytes.len() as u64 + end)
        .unwrap();
    assert_eq!(
        crate::model_families::detect_component("text_encoders", &path),
        Some("ltx-2.3-text-projection")
    );
    let mut models = LocalModels {
        roots: vec![root.path().into()],
        selected: vec![
            ("ggufDualTextEncoders".into(), "gemma.gguf".into()),
            (
                "ggufDualTextEncoders".into(),
                "projection.safetensors".into(),
            ),
        ],
        context: json!({"family":"ltx-2", "textEncoder":"gemma.gguf", "ltx":{"textProjection":"projection.safetensors"}}),
    };
    assert!(models.validate().is_ok());
    models.context = json!({"diffusion":{"family":"anima","textEncoder":"first.safetensors","textEncoder2":"projection.safetensors"}});
    assert!(models
        .validate()
        .unwrap_err()
        .contains("MODEL_COMPONENT_MISMATCH"));
    models.context["componentOverrides"] =
        json!({"textEncoders":true,"vaes":false,"audioVaes":false,"textProjections":false});
    assert!(models.validate().is_ok());
    let replacement = path.with_extension("replacement");
    std::fs::write(&replacement, b"partial").unwrap();
    std::fs::rename(replacement, &path).unwrap();
    assert!(models
        .validate()
        .unwrap_err()
        .contains("MODEL_INTEGRITY_INVALID"));
}

#[test]
fn model_check_auxiliary_checkpoint_is_not_the_generation_family() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("checkpoints");
    std::fs::create_dir(&dir).unwrap();
    let header = br#"{"__metadata__":{"modelspec.architecture":"sam3"}}"#;
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    std::fs::write(dir.join("sam.safetensors"), bytes).unwrap();
    let models = LocalModels {
        roots: vec![root.path().into()],
        selected: vec![("checkpoints".into(), "sam.safetensors".into())],
        context: json!({"family":"minimax-h3", "model":"h3.safetensors", "faceRefine":{"samCheckpoint":"sam.safetensors"}}),
    };
    assert!(models.validate().is_ok());
}

#[tokio::test]
async fn local_declaration_preparation_rechecks_scanned_model_and_lora_without_post() {
    let (base, task, posts) = backend().await;
    for category in ["checkpoints", "loras"] {
        for replacement in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let model = declaration(root.path(), "checkpoints", "sd/model.safetensors").await;
            let lora = declaration(root.path(), "loras", "style/a.safetensors").await;
            let scanned = crate::downloads::models::scan_roots(&[root.path().into()]).unwrap();
            assert_eq!(scanned.len(), 2);
            assert!(scanned.iter().all(
                |m| m.family_override.as_deref() == Some("sdxl") && m.metadata_error.is_none()
            ));
            corrupt(
                if category == "checkpoints" {
                    &model
                } else {
                    &lora
                },
                replacement,
            );
            let mut draft = intent();
            draft["loras"] = json!([{"name":"style/a.safetensors","strength":0.5}]);
            let jobs = Jobs::default();
            let error = jobs
                .prepare_with_models(base.clone(), draft, vec![root.path().into()])
                .await
                .unwrap_err();
            assert!(
                error.contains("MODEL_METADATA_INVALID"),
                "{category}: {error}"
            );
            assert!(jobs.lock().unwrap().plan.is_none());
        }
    }
    assert_eq!(posts.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn local_declaration_valid_and_undeclared_preparation_submit_normally() {
    let (base, task, posts) = backend().await;
    for declared in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let model = declaration(root.path(), "checkpoints", "sd/model.safetensors").await;
        if !declared {
            std::fs::remove_file(format!("{}.deas.json", model.display())).unwrap();
        }
        let jobs = Jobs::default();
        let plan = jobs
            .prepare_with_models(base.clone(), intent(), vec![root.path().into()])
            .await
            .unwrap();
        let job = jobs
            .submit(plan["id"].as_str().unwrap().into(), true)
            .await
            .unwrap();
        assert_eq!(job["state"], "queued");
    }
    assert_eq!(posts.load(Ordering::SeqCst), 2);
    task.abort();
}

#[tokio::test]
async fn local_declaration_submit_rechecks_after_successful_native_preparation() {
    let (base, task, posts) = backend().await;
    for category in ["checkpoints", "loras"] {
        for replacement in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let model = declaration(root.path(), "checkpoints", "sd/model.safetensors").await;
            let lora = declaration(root.path(), "loras", "style/a.safetensors").await;
            let mut draft = intent();
            draft["loras"] = json!([{"name":"style/a.safetensors","strength":0.5}]);
            let jobs = Jobs::default();
            let plan = jobs
                .prepare_with_models(base.clone(), draft, vec![root.path().into()])
                .await
                .unwrap();
            corrupt(
                if category == "checkpoints" {
                    &model
                } else {
                    &lora
                },
                replacement,
            );
            let error = jobs
                .submit(plan["id"].as_str().unwrap().into(), true)
                .await
                .unwrap_err();
            assert!(
                error.contains("MODEL_METADATA_INVALID"),
                "{category}: {error}"
            );
            assert!(jobs.lock().unwrap().job.is_none());
        }
    }
    assert_eq!(posts.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
#[allow(clippy::result_large_err)] // Tungstenite fixes the handshake callback's error type.
async fn local_declaration_changed_during_observer_connect_fails_before_prompt() {
    for (declared, replacement) in [(true, false), (true, true), (false, true)] {
        let (base, task, posts) = backend().await;
        let root = tempfile::tempdir().unwrap();
        let path = declaration(root.path(), "checkpoints", "sd/model.safetensors").await;
        if !declared {
            std::fs::remove_file(format!("{}.deas.json", path.display())).unwrap();
        }
        let jobs = Jobs::default();
        let plan = jobs
            .prepare_with_models(base, intent(), vec![root.path().into()])
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        // Route this held plan through a real handshake that invalidates the metadata.
        jobs.lock().unwrap().plan.as_mut().unwrap().base =
            crate::validate_base_url(&format!("http://{}", listener.local_addr().unwrap()))
                .unwrap();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                socket,
                move |_: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    corrupt(&path, replacement);
                    Ok(response)
                },
            )
            .await
            .unwrap();
            use futures_util::StreamExt;
            assert!(matches!(
                socket.next().await,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            ));
        });
        let id = plan["id"].as_str().unwrap().to_owned();
        let error = jobs.submit(id.clone(), true).await.unwrap_err();
        let expected = if declared {
            "MODEL_METADATA_INVALID"
        } else {
            "MODEL_INTEGRITY_INVALID"
        };
        assert!(error.contains(expected), "{error}");
        let job = jobs.lock().unwrap().job.clone().unwrap();
        assert_eq!(job.state, "failed");
        assert!(!job.submitting);
        assert!(job.plan.consumed);
        assert!(job.prompt_id.is_none());
        let completed = job.live.lock().unwrap().observer.completion();
        super::observer_tests::finished(completed).await;
        tokio::time::timeout(Duration::from_secs(5), peer)
            .await
            .unwrap()
            .unwrap();
        assert!(jobs
            .submit(id, true)
            .await
            .unwrap_err()
            .contains("retries are forbidden"));
        assert_eq!(posts.load(Ordering::SeqCst), 0);
        task.abort();
    }
}

#[tokio::test]
async fn local_declaration_external_backend_has_no_machine_path_authority() {
    let (base, task, posts) = backend().await;
    let root = tempfile::tempdir().unwrap();
    let path = declaration(root.path(), "checkpoints", "sd/model.safetensors").await;
    corrupt(&path, false);
    let engine = crate::install::Engine::default();
    assert!(LocalModels::owned(&engine, &base).is_empty());
    let jobs = Jobs::default();
    let plan = jobs
        .prepare_with_models(
            base,
            intent(),
            LocalModels::owned(&engine, "http://127.0.0.1:9"),
        )
        .await
        .unwrap();
    assert_eq!(
        jobs.submit(plan["id"].as_str().unwrap().into(), true)
            .await
            .unwrap()["state"],
        "queued"
    );
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn gguf_sidecar_split_preparation_checks_real_loader_catalog_fields() {
    for missing in ["", "UnetLoaderGGUF", "CLIPLoaderGGUF", "encoder-file"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("diffusion_models/renamed.gguf");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Advisory-family fixture only, not a loadable quantized model.
        std::fs::write(&path, b"unknown architecture fixture").unwrap();
        crate::downloads::models::native_model_family_write(
            path.to_str().unwrap().into(),
            Some("anima".into()),
        )
        .await
        .unwrap();
        let scanned = crate::downloads::models::scan_roots(&[root.path().into()]).unwrap();
        assert_eq!(scanned[0].family.as_deref(), Some("anima"));
        assert_eq!(scanned[0].family_override.as_deref(), Some("anima"));
        assert!(scanned[0].detected_family.is_none());
        let mut info = nodes();
        info["UnetLoaderGGUF"] = json!({"input":{"required":{"unet_name":[["renamed.gguf"]]}}});
        info["CLIPLoaderGGUF"] = json!({"input":{"required":{"clip_name":[["encoder.gguf"]],"type":[["stable_diffusion"]]}}});
        info["VAELoader"] = json!({"input":{"required":{"vae_name":[["vae.safetensors"]]}}});
        if missing == "encoder-file" {
            info["CLIPLoaderGGUF"]["input"]["required"]["clip_name"] = json!([[]]);
        } else if !missing.is_empty() {
            info.as_object_mut().unwrap().remove(missing);
        }
        let (base, task) = server(move |request, _| {
            assert_eq!(request, "GET /comfy/object_info HTTP/1.1");
            (200, info.to_string())
        })
        .await;
        let mut draft = intent();
        draft["checkpoint"] = json!("renamed.gguf");
        draft["diffusion"] = json!({"textEncoder":"encoder.gguf","clipType":"stable_diffusion","vae":"vae.safetensors"});
        let jobs = Jobs::default();
        let prepared = jobs
            .prepare_with_models(base, draft, vec![root.path().into()])
            .await;
        if missing.is_empty() {
            let plan = prepared.unwrap();
            assert_eq!(plan["graph"]["1"]["class_type"], "UnetLoaderGGUF");
            assert_eq!(plan["graph"]["C"]["class_type"], "CLIPLoaderGGUF");
        } else {
            assert!(prepared.is_err(), "missing {missing}");
        }
        assert!(jobs.lock().unwrap().job.is_none());
        task.abort();
        let reset = crate::downloads::models::native_model_family_write(
            path.to_str().unwrap().into(),
            None,
        )
        .await
        .unwrap();
        assert!(reset.family_override.is_none());
        assert!(reset.family.is_none());
    }
}

#[test]
fn gguf_image_companions_use_matching_loader_and_unsupported_formats_fail() {
    let mut draft = intent();
    draft["diffusion"] =
        json!({"textEncoder":"clip.gguf","clipType":"wan","vae":"vae.safetensors"});
    assert_eq!(
        compile(&draft).unwrap()["C"]["class_type"],
        "CLIPLoaderGGUF"
    );
    draft["diffusion"]["vae"] = json!("vae.gguf");
    assert!(compile(&draft).unwrap_err().contains("GGUF VAE"));
    draft = intent();
    draft["loras"] = json!([{"name":"legacy.ckpt","strength":1}]);
    assert!(compile(&draft).unwrap_err().contains("safetensors"));
}

#[test]
fn gguf_image_models_load_via_gguf_nodes_and_loras_stay_rejected() {
    for name in ["model.gguf", "model.GGUF"] {
        let mut draft = intent();
        draft["checkpoint"] = json!(name);
        assert!(compile(&draft)
            .unwrap_err()
            .contains("GGUF requires a diffusion recipe"));
        draft["diffusion"] =
            json!({"textEncoder":"clip.safetensors","clipType":"wan","vae":"vae.safetensors"});
        let graph = compile(&draft).unwrap();
        assert_eq!(graph["1"]["class_type"], "UnetLoaderGGUF");
        assert!(graph["1"]["inputs"].get("weight_dtype").is_none());
        // LoRA on a quantized base needs execution proof per pipeline; not advertised.
        draft["loras"] = json!([{"name":"style.safetensors","strength":0.5}]);
        assert!(compile(&draft).unwrap_err().contains("LoRA on a GGUF base"));
    }
    let mut draft = intent();
    draft["loras"] = json!([{"name":"style.gguf","strength":0.5}]);
    assert!(compile(&draft).unwrap_err().contains("GGUF LoRA"));
    draft = intent();
    draft["checkpoint"] = json!("legacy.ckpt");
    assert_eq!(
        compile(&draft).unwrap()["1"]["class_type"],
        "CheckpointLoaderSimple"
    );
}
