use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![127; width as usize * height as usize * 4])
            .unwrap();
    }
    bytes
}

fn completed(base: &str) -> Jobs {
    let jobs = Jobs::default();
    let intent = super::super::tests::intent();
    jobs.lock().unwrap().job = Some(Job {
        id: "job-a".into(),
        plan: Plan {
            id: "plan".into(),
            base: reqwest::Url::parse(base).unwrap(),
            graph: compile(&intent).unwrap(),
            intent,
            consumed: true,
            media_root: None,
        },
        client_id: "client".into(),
        prompt_id: None,
        state: "succeeded",
        outputs: vec![json!({"filename":"image.png","subfolder":"DEAS/run-1","type":"output"})],
        error: None,
        submitting: false,
        polling: false,
        metadata: None,
        live: Arc::default(),
    });
    jobs
}

fn register_completed(jobs: &Jobs, root: &std::path::Path) {
    let mut session = jobs.lock().unwrap();
    session.job.as_mut().unwrap().plan.media_root = Some(MediaRoot::capture(root.into()).unwrap());
    session.retain_completed();
    for output in &session.job.as_ref().unwrap().outputs {
        let path = output_path(root, output);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, png_bytes(1, 1)).unwrap();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn owned_completion_root_tracks_launch_not_saved_settings_or_another_instance() {
    use crate::backend::tests::{await_state, fixture, SERVER};
    let script = SERVER.replace(
        "port=int(args[args.index('--port')+1])",
        "port=int(args[args.index('--port')+1])\nwith open('launch-output.txt','w') as f: f.write(args[args.index('--output-directory')+1])",
    );
    let (environment, approved) = fixture(&script);
    let output_a = environment.path().join("output-a");
    let output_b = environment.path().join("output-b");
    for path in [&output_a, &output_b] {
        std::fs::create_dir(path).unwrap();
    }
    let save_output = |output: &std::path::Path| {
        crate::settings::write(
            environment.path(),
            crate::settings::Folders {
                output: Some(output.to_str().unwrap().into()),
                ..Default::default()
            },
        )
        .unwrap();
    };
    save_output(&output_a);
    let engine = crate::install::Engine::default();
    engine.backend.start(approved.clone()).unwrap();
    let status = await_state(&engine.backend, "running");
    let endpoint = status.endpoint.unwrap();
    save_output(&output_b);
    assert_eq!(
        std::fs::read_to_string(environment.path().join("ComfyUI/launch-output.txt")).unwrap(),
        output_a.to_str().unwrap()
    );
    assert_eq!(
        engine.backend.status().endpoint.as_deref(),
        Some(endpoint.as_str())
    );
    let proof = MediaRoot::owned(&engine, &endpoint).expect("running launch retains output A");
    assert_eq!(proof.path, output_a);
    let jobs = completed(&endpoint);
    {
        let mut session = jobs.lock().unwrap();
        session.job.as_mut().unwrap().plan.media_root = Some(proof);
        session.retain_completed();
    }
    std::fs::create_dir_all(output_a.join("DEAS/run-1")).unwrap();
    std::fs::write(output_a.join("DEAS/run-1/image.png"), png_bytes(1, 1)).unwrap();
    jobs.media_move_ready(&output_a, &output_a.join("DEAS/run-1/image.png"))
        .unwrap();
    assert!(jobs
        .media_move_ready(&output_b, &output_b.join("DEAS/run-1/image.png"))
        .is_err());
    save_output(&output_a);
    assert_eq!(MediaRoot::owned(&engine, &endpoint).unwrap().path, output_a);
    assert!(MediaRoot::owned(&engine, "http://127.0.0.1:9/").is_none());
    let other = crate::install::Engine::default();
    assert!(MediaRoot::owned(&other, &endpoint).is_none());
    engine.backend.stop(); // Only the scratch fixture, never the user's backend.
    assert!(MediaRoot::owned(&engine, &endpoint).is_none());
    save_output(&output_b);
    engine.backend.start(approved).unwrap();
    let replacement = await_state(&engine.backend, "running");
    let replacement_endpoint = replacement.endpoint.clone().unwrap();
    assert_eq!(
        MediaRoot::owned(&engine, replacement.endpoint.as_deref().unwrap())
            .unwrap()
            .path,
        output_b
    );
    assert_eq!(
        serde_json::to_value(replacement).unwrap(),
        json!({"state":"running", "endpoint":replacement_endpoint,
            "error":null, "generationReady":false}),
        "launch paths must not enter the status wire format"
    );
}

#[test]
fn relocation_repairs_output_handles_without_rewriting_intent_or_media_bytes() {
    let jobs = completed("http://127.0.0.1:7801/");
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    register_completed(&jobs, &root);
    std::fs::create_dir_all(root.join("DEAS/run-1")).unwrap();
    std::fs::create_dir_all(root.join("starred/DEAS/run-1")).unwrap();
    let source = root.join("DEAS/run-1/image.png");
    let target = root.join("starred/DEAS/run-1/image.png");
    std::fs::write(&source, png_bytes(1, 1)).unwrap();
    let intent = jobs
        .lock()
        .unwrap()
        .job
        .as_ref()
        .unwrap()
        .plan
        .intent
        .clone();
    let moved = jobs
        .relocate_media(&root, &source, || {
            std::fs::rename(&source, &target).unwrap();
            Ok(target.clone())
        })
        .unwrap();
    assert_eq!(moved, target);
    assert!(!source.exists());
    assert_eq!(std::fs::read(&target).unwrap(), png_bytes(1, 1));
    let session = jobs.lock().unwrap();
    let job = session.job.as_ref().unwrap();
    assert_eq!(job.plan.intent, intent);
    assert_eq!(job.outputs[0]["subfolder"], "starred/DEAS/run-1");
    assert_eq!(job.outputs[0]["filename"], "image.png");
}
#[test]
fn relocation_blocks_incomplete_jobs_before_touching_the_file() {
    let jobs = completed("http://127.0.0.1:7801/");
    jobs.lock().unwrap().job.as_mut().unwrap().state = "running";
    assert!(jobs.media_move_idle().is_err());
    let dir = tempfile::tempdir().unwrap();
    assert!(Jobs::default()
        .media_move_ready(dir.path(), &dir.path().join("a.png"))
        .unwrap_err()
        .contains("missing or unreadable"));
    assert!(jobs
        .relocate_media(
            std::path::Path::new("/output"),
            std::path::Path::new("/output/a.png"),
            || panic!("must not move running output")
        )
        .is_err());
}

async fn complete_via_status(jobs: &Jobs, root: &std::path::Path, id: &str, video: bool) {
    let mut job = jobs.lock().unwrap().job.as_ref().unwrap().clone();
    job.id = id.into();
    job.state = "queued";
    job.prompt_id = Some(id.into());
    job.outputs.clear();
    job.plan.media_root = Some(MediaRoot::capture(root.into()).unwrap());
    let output = json!({"filename": if video {"clip.webm"} else {"image.png"},
        "subfolder":"DEAS/run-1","type":"output"});
    let products = if video {
        json!({"gifs":[output]})
    } else {
        json!({"images":[output]})
    };
    let history = json!({id:{
        "prompt":[1,id,job.plan.graph,{"client_id":job.client_id},["7"]],
        "status":{"completed":true,"status_str":"success","messages":[]},
        "outputs":{"7":products}
    }});
    let (base, server) = binary_server(
        history.to_string().into_bytes(),
        200,
        "Content-Type: application/json",
    )
    .await;
    job.plan.base = reqwest::Url::parse(&base).unwrap();
    jobs.lock().unwrap().job = Some(job);
    assert_eq!(jobs.status(id.into()).await.unwrap()["state"], "succeeded");
    server.await.unwrap();
}

#[tokio::test]
async fn retains_two_correlated_completions_and_repairs_earlier_output_after_latest_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let jobs = completed("http://127.0.0.1:9/");
    complete_via_status(&jobs, &root, "first", false).await;
    complete_via_status(&jobs, &root, "second", true).await;
    assert_eq!(jobs.lock().unwrap().completed.len(), 2);
    std::fs::create_dir_all(root.join("DEAS/run-1")).unwrap();
    // Arbitrary byte-preservation fixture, not a decoded video sample.
    std::fs::write(root.join("DEAS/run-1/clip.webm"), b"unparsed video bytes").unwrap();
    std::fs::create_dir(root.join("starred")).unwrap();
    let source = root.join("DEAS/run-1/image.png");
    let target = root.join("starred/image-collision-safe.png");
    std::fs::write(&source, png_bytes(1, 1)).unwrap();
    let cached = Arc::new(CachedOutput {
        job_id: "second".into(),
        index: 0,
        width: 1,
        height: 1,
        sha256: format!("{:x}", Sha256::digest([42])),
        bytes: vec![42],
    });
    jobs.lock().unwrap().output = Some(cached.clone());
    let latest = jobs.current().unwrap();
    jobs.media_move_ready(&root, &root.join("DEAS/run-1/clip.webm"))
        .unwrap();
    assert_eq!(
        jobs.relocate_media(&root, &source, || {
            assert!(
                jobs.0.try_lock().is_err(),
                "move must exclude submission/preparation"
            );
            std::fs::rename(&source, &target).unwrap();
            Ok(target.clone())
        })
        .unwrap(),
        target
    );
    assert!(jobs.media_move_ready(&root, &source).is_err());
    jobs.media_move_ready(&root, &target).unwrap();
    assert_eq!(
        jobs.relocate_media(&root, &target, || Ok(target.clone()))
            .unwrap(),
        target
    );
    assert_eq!(jobs.status("second".into()).await.unwrap(), latest);
    {
        let session = jobs.lock().unwrap();
        assert!(Arc::ptr_eq(session.output.as_ref().unwrap(), &cached));
        assert_eq!(session.output.as_ref().unwrap().bytes, [42]);
        assert_eq!(session.completed[0].outputs[0]["subfolder"], "starred");
        assert_eq!(
            session.completed[0].outputs[0]["filename"],
            "image-collision-safe.png"
        );
        assert_eq!(session.completed[1].outputs[0]["filename"], "clip.webm");
    }
    assert_eq!(std::fs::read(&target).unwrap(), png_bytes(1, 1));
    // Another submission's terminal failure must not erase either completion.
    {
        let mut session = jobs.lock().unwrap();
        let job = session.job.as_mut().unwrap();
        job.id = "third".into();
        job.state = "failed";
        job.outputs.clear();
    }
    jobs.media_move_ready(&root, &target).unwrap();
    jobs.media_move_ready(&root, &root.join("DEAS/run-1/clip.webm"))
        .unwrap();
}

#[tokio::test]
async fn latest_relocation_preserves_original_png_cache_and_executed_settings_on_repeated_status() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let bytes = png_bytes(512, 768);
    let (base, server) = binary_server(bytes.clone(), 200, "Content-Type: image/png").await;
    let jobs = completed(&base);
    register_completed(&jobs, &root);
    jobs.output("job-a".into(), 0).await.unwrap();
    server.await.unwrap();
    let cached = jobs.cached_output("job-a", 0).unwrap();
    let before = jobs.current().unwrap();
    let graph = jobs
        .lock()
        .unwrap()
        .job
        .as_ref()
        .unwrap()
        .plan
        .graph
        .clone();
    std::fs::create_dir_all(root.join("DEAS/run-1")).unwrap();
    std::fs::create_dir(root.join("starred")).unwrap();
    let source = root.join("DEAS/run-1/image.png");
    let target = root.join("starred/image.png");
    std::fs::write(&source, &bytes).unwrap();
    jobs.relocate_media(&root, &source, || {
        std::fs::rename(&source, &target).unwrap();
        Ok(target.clone())
    })
    .unwrap();
    for _ in 0..2 {
        jobs.relocate_media(&root, &target, || Ok(target.clone()))
            .unwrap();
        let status = jobs.status("job-a".into()).await.unwrap();
        assert_eq!(status["intent"], before["intent"]);
        assert_eq!(status["outputs"][0]["subfolder"], "starred");
        assert_eq!(jobs.output("job-a".into(), 0).await.unwrap().bytes, bytes);
        assert!(Arc::ptr_eq(
            &jobs.cached_output("job-a", 0).unwrap(),
            &cached
        ));
    }
    let session = jobs.lock().unwrap();
    assert_eq!(session.job.as_ref().unwrap().plan.graph, graph);
    assert_eq!(
        session.completed[0].outputs,
        session.job.as_ref().unwrap().outputs
    );
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[tokio::test]
async fn workbench_all_job_png_lookup_and_alias_repair() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let jobs = Jobs::default();
    let mut entries = vec![];
    for index in 0..3 {
        let bytes = png_bytes(512, 768);
        let (base, server) = binary_server(bytes.clone(), 200, "Content-Type: image/png").await;
        let held = Arc::new(completed(&base));
        let id = format!("job-{index}");
        held.lock().unwrap().job.as_mut().unwrap().id = id.clone();
        register_completed(&held, &root);
        jobs.lock().unwrap().workbench.push(held.clone());
        entries.push((held, id, bytes, server));
    }
    for (_, id, bytes, server) in &mut entries {
        assert_eq!(jobs.output(id.clone(), 0).await.unwrap().bytes, *bytes);
        (&mut *server).await.unwrap();
    }
    let source = root.join("DEAS/run-1/image.png");
    std::fs::create_dir(root.join("starred")).unwrap();
    let target = root.join("starred/image.png");
    jobs.relocate_media(&root, &source, || {
        std::fs::rename(&source, &target).unwrap();
        Ok(target.clone())
    })
    .unwrap();
    for (held, id, bytes, _) in entries {
        assert_eq!(
            held.current().unwrap()["outputs"][0]["subfolder"],
            "starred"
        );
        assert_eq!(
            held.lock().unwrap().completed[0].outputs[0]["subfolder"],
            "starred"
        );
        assert_eq!(jobs.output(id, 0).await.unwrap().bytes, bytes);
    }
}

#[test]
fn workbench_nonterminal_jobs_block_media_moves() {
    let jobs = Jobs::default();
    let held = Arc::new(completed("http://127.0.0.1:9/"));
    jobs.lock().unwrap().workbench.push(held.clone());
    assert!(jobs.media_move_idle().is_ok());
    for state in ["queued", "running", "unknown"] {
        held.lock().unwrap().job.as_mut().unwrap().state = state;
        assert!(jobs.media_move_idle().is_err(), "{state}");
    }
    held.lock().unwrap().job = None;
    assert!(jobs.media_move_idle().is_err(), "preparation reservation");
}

#[test]
fn native_move_rejects_missing_active_uncertain_and_unsafe_roots() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let jobs = completed("http://127.0.0.1:9/");
    let source = root.join("DEAS/run-1/image.png");
    assert!(
        jobs.media_move_ready(&root, &source).is_err(),
        "unbound endpoint"
    );
    assert!(MediaRoot::owned(&crate::install::Engine::default(), "http://127.0.0.1:9/").is_none());
    register_completed(&jobs, &root);
    for state in ["preparing", "queued", "running", "unknown"] {
        jobs.lock().unwrap().job.as_mut().unwrap().state = state;
        assert!(jobs.media_move_ready(&root, &source).is_err());
        assert!(jobs
            .relocate_media(&root, &source, || panic!("active move"))
            .is_err());
    }
    jobs.lock().unwrap().job.as_mut().unwrap().state = "succeeded";
    jobs.lock().unwrap().preparing = Some("next plan".into());
    assert!(jobs
        .relocate_media(&root, &source, || panic!("preparing move"))
        .is_err());
    jobs.lock().unwrap().preparing = None;
    for unknown in [
        root.join("unregistered.png"),
        root.join("DEAS/run-1/unknown.png"),
    ] {
        assert!(jobs
            .relocate_media(&root, &unknown, || panic!("unregistered move"))
            .is_err());
    }
    let other = tempfile::tempdir().unwrap();
    assert!(jobs
        .media_move_ready(other.path(), &other.path().join("DEAS/run-1/image.png"))
        .is_err());
    let old = root.with_extension("old");
    std::fs::rename(&root, &old).unwrap();
    std::fs::create_dir(&root).unwrap();
    assert!(jobs
        .relocate_media(&root, &source, || panic!("replaced root"))
        .is_err());
    std::fs::remove_dir(&root).unwrap();
    std::fs::rename(&old, &root).unwrap();
}

#[test]
fn root_bound_alias_repair_uses_nested_parent_and_failed_move_preserves_every_record() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let other = tempfile::tempdir().unwrap();
    let jobs = completed("http://127.0.0.1:9/");
    register_completed(&jobs, &root);
    let source = root.join("DEAS/run-1/image.png");
    {
        let mut session = jobs.lock().unwrap();
        let matching = session.completed[0].outputs.clone();
        let mut input = matching[0].clone();
        input["type"] = json!("input");
        session.completed[0].outputs.push(input);
        session.completed.push_back(CompletedOutputs {
            job_id: "foreign-root".into(),
            root: MediaRoot::capture(other.path().into()).unwrap(),
            outputs: matching.clone(),
        });
        session.completed.push_back(CompletedOutputs {
            job_id: "replaced-root".into(),
            root: MediaRoot {
                path: root.clone(),
                identity: (0, 0),
            },
            outputs: matching,
        });
    }
    let before: Vec<_> = jobs
        .lock()
        .unwrap()
        .completed
        .iter()
        .map(|record| record.outputs.clone())
        .collect();
    std::fs::write(root.join("starred"), b"blocked destination").unwrap();
    assert!(jobs
        .relocate_media(&root, &source, || crate::media::star::move_media(
            &root, &source
        ))
        .is_err());
    assert_eq!(std::fs::read(&source).unwrap(), png_bytes(1, 1));
    assert_eq!(
        jobs.lock()
            .unwrap()
            .completed
            .iter()
            .map(|record| record.outputs.clone())
            .collect::<Vec<_>>(),
        before
    );
    assert_eq!(
        jobs.lock().unwrap().job.as_ref().unwrap().outputs[0],
        before[0][0]
    );
    std::fs::remove_file(root.join("starred")).unwrap();
    #[cfg(target_os = "linux")]
    for (after_commit, replace_source) in [(false, false), (true, false), (true, true)] {
        let outside = tempfile::tempdir().unwrap();
        let displaced = outside.path().join("renamed-destination");
        let error = jobs
            .relocate_media(&root, &source, || {
                crate::media::star::move_media_checked(&root, &source, |committed| {
                    if committed == after_commit {
                        let destination = root.join("starred/DEAS/run-1");
                        std::fs::rename(&destination, &displaced).unwrap();
                        std::fs::create_dir(&destination).unwrap();
                        if replace_source {
                            std::fs::write(&source, b"concurrent replacement").unwrap();
                        }
                    }
                })
            })
            .unwrap_err();
        if replace_source {
            assert!(error.contains("could not be confirmed restored"), "{error}");
            assert_eq!(std::fs::read(&source).unwrap(), b"concurrent replacement");
            assert_eq!(
                std::fs::read(displaced.join("image.png")).unwrap(),
                png_bytes(1, 1)
            );
            std::fs::remove_file(&source).unwrap();
            std::fs::rename(displaced.join("image.png"), &source).unwrap();
        } else {
            if after_commit {
                assert!(error.contains("rolled back to source"), "{error}");
            }
            assert_eq!(std::fs::read(&source).unwrap(), png_bytes(1, 1));
            assert!(!displaced.join("image.png").exists());
        }
        let session = jobs.lock().unwrap();
        assert_eq!(
            session
                .completed
                .iter()
                .map(|record| record.outputs.clone())
                .collect::<Vec<_>>(),
            before
        );
        assert_eq!(session.job.as_ref().unwrap().outputs[0], before[0][0]);
    }
    let target = jobs
        .relocate_media(&root, &source, || {
            crate::media::star::move_media(&root, &source)
        })
        .unwrap();
    assert_eq!(target, root.join("starred/DEAS/run-1/image.png"));
    let session = jobs.lock().unwrap();
    assert_eq!(
        session.job.as_ref().unwrap().outputs[0]["subfolder"],
        "starred/DEAS/run-1"
    );
    assert_eq!(
        session.completed[0].outputs[0]["subfolder"],
        "starred/DEAS/run-1"
    );
    assert_eq!(session.completed[0].outputs[1], before[0][1]);
    assert_eq!(session.completed[1].outputs, before[1]);
    assert_eq!(session.completed[2].outputs, before[2]);
}
#[test]
fn unstar_repairs_root_bound_aliases_without_changing_submitted_intent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let jobs = completed("http://127.0.0.1:9/");
    register_completed(&jobs, &root);
    let intent = jobs.current().unwrap()["intent"].clone();
    let source = root.join("DEAS/run-1/image.png");
    let target = jobs
        .relocate_media(&root, &source, || {
            crate::media::star::move_media(&root, &source)
        })
        .unwrap();
    let returned = root.join("raw/DEAS/run-1/image.png");
    std::fs::create_dir_all(returned.parent().unwrap()).unwrap();
    std::fs::write(&returned, b"occupied").unwrap();
    let before = jobs.current().unwrap();
    assert!(jobs
        .relocate_media(&root, &target, || crate::media::star::unstar_media(
            &root, &target
        ))
        .is_err());
    assert_eq!(jobs.current().unwrap(), before);
    assert_eq!(std::fs::read(&returned).unwrap(), b"occupied");
    std::fs::remove_file(&returned).unwrap();
    assert_eq!(
        jobs.relocate_media(&root, &target, || crate::media::star::unstar_media(
            &root, &target
        ))
        .unwrap(),
        returned
    );
    let session = jobs.lock().unwrap();
    assert_eq!(
        session.job.as_ref().unwrap().outputs[0]["subfolder"],
        "raw/DEAS/run-1"
    );
    assert_eq!(
        session.completed[0].outputs[0]["subfolder"],
        "raw/DEAS/run-1"
    );
    assert_eq!(session.completed[0].outputs[0]["filename"], "image.png");
    drop(session);
    assert_eq!(jobs.current().unwrap()["intent"], intent);
    assert_eq!(std::fs::read(&returned).unwrap(), png_bytes(1, 1));
    assert!(!target.exists());
}
#[test]
fn completion_retention_is_bounded_deduplicated_and_failed_moves_preserve_records() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let jobs = completed("http://127.0.0.1:9/");
    for index in 0..=COMPLETED_LIMIT {
        {
            let mut session = jobs.lock().unwrap();
            let job = session.job.as_mut().unwrap();
            job.id = format!("job-{index}");
            job.outputs[0]["filename"] = json!(format!("{index}.png"));
        }
        register_completed(&jobs, &root);
        register_completed(&jobs, &root);
    }
    assert_eq!(jobs.lock().unwrap().completed.len(), COMPLETED_LIMIT);
    jobs.media_move_ready(&root, &root.join("DEAS/run-1/0.png"))
        .unwrap();
    jobs.media_move_ready(&root, &root.join("DEAS/run-1/1.png"))
        .unwrap();
    let source = root.join(format!("DEAS/run-1/{COMPLETED_LIMIT}.png"));
    let before = jobs.current().unwrap();
    assert!(jobs
        .relocate_media(&root, &source, || Err("fixture move failed".into()))
        .is_err());
    assert_eq!(jobs.current().unwrap(), before);
    jobs.media_move_ready(&root, &source).unwrap();
    assert_eq!(jobs.lock().unwrap().completed.len(), COMPLETED_LIMIT);
}

async fn binary_server(
    body: Vec<u8>,
    status: u16,
    headers: &str,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/prefix/comfy/", listener.local_addr().unwrap());
    let headers = headers.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if bytes.windows(4).any(|b| b == b"\r\n\r\n") {
                break;
            }
        }
        let head = format!("HTTP/1.1 {status} Fixture\r\n{headers}\r\nConnection: close\r\n\r\n");
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(&body).await;
        String::from_utf8(bytes).unwrap()
    });
    (base, task)
}

#[tokio::test]
async fn refuses_non_png_transport_and_invalid_complete_images_without_caching() {
    let good = png_bytes(512, 768);
    let mut crc = good.clone();
    crc[29] ^= 1;
    let mut trailing = good.clone();
    trailing.extend_from_slice(b"<script>unsafe</script>");
    for (name, body, status, headers) in [
        (
            "mime",
            good.clone(),
            200,
            "Content-Type: image/svg+xml".to_owned(),
        ),
        ("missing_mime", good.clone(), 200, String::new()),
        (
            "redirect",
            good.clone(),
            302,
            "Content-Type: image/png\r\nLocation: http://127.0.0.1:9/forbidden".into(),
        ),
        (
            "http_error",
            good.clone(),
            500,
            "Content-Type: image/png".into(),
        ),
        (
            "html",
            b"<html>error</html>".to_vec(),
            200,
            "Content-Type: image/png".into(),
        ),
        (
            "svg",
            b"<svg/>".to_vec(),
            200,
            "Content-Type: image/png".into(),
        ),
        (
            "truncated",
            good[..good.len() - 1].to_vec(),
            200,
            "Content-Type: image/png".into(),
        ),
        ("crc", crc, 200, "Content-Type: image/png".into()),
        (
            "dimensions",
            png_bytes(64, 64),
            200,
            "Content-Type: image/png".into(),
        ),
        ("trailing", trailing, 200, "Content-Type: image/png".into()),
        (
            "advertised_size",
            good,
            200,
            format!(
                "Content-Type: image/png\r\nContent-Length: {}",
                PNG_LIMIT + 1
            ),
        ),
        (
            "actual_size",
            vec![0; PNG_LIMIT + 1],
            200,
            "Content-Type: image/png".into(),
        ),
        (
            "chunked_size",
            format!(
                "{:x}\r\n{}\r\n0\r\n\r\n",
                PNG_LIMIT + 1,
                "x".repeat(PNG_LIMIT + 1)
            )
            .into_bytes(),
            200,
            "Content-Type: image/png\r\nTransfer-Encoding: chunked".into(),
        ),
    ] {
        let (base, server) = binary_server(body, status, &headers).await;
        let jobs = completed(&base);
        assert!(
            jobs.output("job-a".into(), 0).await.is_err(),
            "accepted {name}"
        );
        assert!(jobs.lock().unwrap().output.is_none(), "cached {name}");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn rejects_wrong_job_state_index_and_metadata_before_network() {
    let jobs = completed("http://127.0.0.1:9/");
    for state in ["queued", "running", "unknown", "failed"] {
        jobs.lock().unwrap().job.as_mut().unwrap().state = state;
        let error = jobs.output("job-a".into(), 0).await.err().unwrap();
        assert!(error.contains("succeeded"), "{error}");
    }
    jobs.lock().unwrap().job.as_mut().unwrap().state = "succeeded";
    assert!(jobs
        .output("other".into(), 0)
        .await
        .err()
        .unwrap()
        .contains("Unknown"));
    assert!(jobs
        .output("job-a".into(), 1)
        .await
        .err()
        .unwrap()
        .contains("index"));
    jobs.lock().unwrap().job.as_mut().unwrap().outputs[0]["filename"] = json!("../secret.png");
    assert!(jobs
        .output("job-a".into(), 0)
        .await
        .err()
        .unwrap()
        .contains("Unsafe"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn exports_only_cached_original_to_explicit_new_private_png() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    let dir = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let bytes = png_bytes(512, 768);
    let (base, server) = binary_server(bytes.clone(), 200, "Content-Type: image/png").await;
    let jobs = completed(&base);
    let path = dir.path().join("new.png");
    assert!(jobs.export_to("job-a", 0, Some(&path)).is_err());
    assert!(!path.exists());
    jobs.output("job-a".into(), 0).await.unwrap();
    server.await.unwrap(); // Export must work with its HTTP server gone.
    assert_eq!(jobs.export_to("job-a", 0, None).unwrap(), None);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let result = jobs.export_to("job-a", 0, Some(&path)).unwrap().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(result["size"], bytes.len());
    assert_eq!(result["sha256"], format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    for bad in [
        path.clone(),
        dir.path().join("bad.jpg"),
        std::path::PathBuf::from("relative.png"),
        dir.path().join("missing/new.png"),
    ] {
        assert!(jobs.export_to("job-a", 0, Some(&bad)).is_err());
    }
    let link = dir.path().join("link.png");
    symlink(&path, &link).unwrap();
    assert!(jobs.export_to("job-a", 0, Some(&link)).is_err());
    assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o640);
    let bad_parent = dir.path().join("writable");
    std::fs::create_dir(&bad_parent).unwrap();
    std::fs::set_permissions(&bad_parent, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(jobs
        .export_to("job-a", 0, Some(&bad_parent.join("x.png")))
        .is_err());
    let parent_link = dir.path().join("linked");
    symlink(dir.path(), &parent_link).unwrap();
    assert!(jobs
        .export_to("job-a", 0, Some(&parent_link.join("x.png")))
        .is_err());
    assert!(jobs
        .export_to("other", 0, Some(&dir.path().join("x.png")))
        .is_err());
    assert!(jobs
        .export_to("job-a", 1, Some(&dir.path().join("x.png")))
        .is_err());
    assert!(!dir.path().join("x.png").exists());
    assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".deas-")));
}

#[tokio::test]
async fn rejects_animation_and_crc_errors_in_image_end_and_ignored_metadata() {
    let good = png_bytes(512, 768);
    let mut variants = vec![png_bytes(2056, 64)];
    let mut offset = 8;
    while offset < good.len() {
        let length = u32::from_be_bytes(good[offset..offset + 4].try_into().unwrap()) as usize;
        if [&b"IDAT"[..], &b"IEND"[..]].contains(&&good[offset + 4..offset + 8]) {
            let mut bad = good.clone();
            bad[offset + 8 + length] ^= 1;
            variants.push(bad);
        }
        offset += length + 12;
    }
    let mut metadata = vec![];
    {
        let encoder = png::Encoder::new(&mut metadata, 512, 768);
        let mut writer = encoder.write_header().unwrap();
        writer.write_chunk(png::chunk::tEXt, b"key\0value").unwrap();
        writer.write_image_data(&vec![0; 512 * 768]).unwrap();
    }
    let text = metadata.windows(4).position(|b| b == b"tEXt").unwrap();
    metadata[text + 4 + 9] ^= 1;
    variants.push(metadata);
    let mut animated = vec![];
    {
        let mut encoder = png::Encoder::new(&mut animated, 512, 768);
        encoder.set_animated(1, 0).unwrap();
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![0; 512 * 768])
            .unwrap();
    }
    variants.push(animated);
    for (i, body) in variants.into_iter().enumerate() {
        let (base, server) = binary_server(body, 200, "Content-Type: image/png").await;
        let jobs = completed(&base);
        assert!(
            jobs.output("job-a".into(), 0).await.is_err(),
            "accepted corrupt/animated fixture {i}"
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn output_timeout_is_total_and_does_not_cache_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let jobs = completed(&format!("http://{}/", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(12)).await;
    });
    let start = std::time::Instant::now();
    assert!(jobs.output("job-a".into(), 0).await.is_err());
    assert!(start.elapsed() >= Duration::from_secs(9));
    assert!(start.elapsed() < Duration::from_secs(11));
    assert!(jobs.lock().unwrap().output.is_none());
    server.abort();
}

#[tokio::test]
async fn fetch_is_exclusive_and_replaced_jobs_cannot_publish_results() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let jobs = completed(&format!("http://{}/", listener.local_addr().unwrap()));
    let (received, ready) = tokio::sync::oneshot::channel();
    let (release, go) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        received.send(()).unwrap();
        go.await.unwrap();
        let body = png_bytes(512, 768);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
    });
    let fetch = jobs.output("job-a".into(), 0);
    let steer = async {
        ready.await.unwrap();
        let error =
            tokio::time::timeout(Duration::from_millis(200), jobs.output("job-a".into(), 0))
                .await
                .expect("duplicate fetch must fail immediately")
                .err()
                .unwrap();
        assert!(error.contains("progress"));
        jobs.lock().unwrap().job.as_mut().unwrap().id = "replacement".into();
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(fetch, steer);
    assert!(result.err().unwrap().contains("changed"));
    assert!(jobs.lock().unwrap().output.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn output_supports_4k_and_pixel_limit_with_bounded_decoding() {
    for (width, height, valid) in [
        (3840, 2160, true),
        (4096, 4096, true),
        (8192, 2048, true),
        (8200, 64, false),
        (8192, 2056, false),
    ] {
        let body = png_bytes(width, height);
        let (base, server) = binary_server(body, 200, "Content-Type: image/png").await;
        let jobs = completed(&base);
        {
            let mut state = jobs.lock().unwrap();
            let intent = &mut state.job.as_mut().unwrap().plan.intent;
            intent["width"] = json!(width);
            intent["height"] = json!(height);
        }
        assert_eq!(
            jobs.output("job-a".into(), 0).await.is_ok(),
            valid,
            "{width}x{height}"
        );
        assert_eq!(jobs.lock().unwrap().output.is_some(), valid);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn original_png_is_fetched_from_stored_metadata_and_cached() {
    let bytes = png_bytes(512, 768);
    let (base, server) = binary_server(
        bytes.clone(),
        200,
        &format!(
            "Content-Type: image/png; charset=binary\r\nContent-Length: {}",
            bytes.len()
        ),
    )
    .await;
    let jobs = completed(&base);
    let result = jobs.output("job-a".into(), 0).await.unwrap();
    assert_eq!(result.bytes, bytes);
    assert_eq!(result.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!((result.width, result.height), (512, 768));
    let request = server.await.unwrap();
    assert_eq!(
        request.lines().next().unwrap(),
        "GET /prefix/comfy/view?filename=image.png&subfolder=DEAS%2Frun-1&type=output HTTP/1.1"
    );
    assert_eq!(jobs.output("job-a".into(), 0).await.unwrap().bytes, bytes);
    assert!(jobs.current().unwrap().get("bytes").is_none());
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["mimeType"], "image/png");
    assert_eq!(value["jobId"], "job-a");
}
