use super::*;

pub(super) fn intent() -> Value {
    json!({"recipeId":"checkpoint-text-to-image-diagnostic","version":1,
        "positivePrompt":"a cat", "negativePrompt":"", "checkpoint":"sd/model.safetensors",
        "seed":123,"width":512,"height":768,"steps":20,"cfg":7,
        "sampler":"euler","scheduler":"normal","outputPrefix":"DEAS_test"})
}

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROMPT_ID: &str = "cd5936d0-9f0f-4b82-8cda-b01c241bc669";

fn nodes() -> Value {
    json!({"CheckpointLoaderSimple":{"input":{"required":{"ckpt_name":[["sd/model.safetensors"]]}}},
        "CLIPTextEncode":{},"EmptyLatentImage":{},"KSampler":{"input":{"required":{"sampler_name":[["euler"]],"scheduler":[["normal"]]}}},"VAEDecode":{},"SaveImage":{}})
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
            let (code, body) = respond(path, body);
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
                assert_eq!(body.as_object().unwrap().len(),2);
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
    assert_eq!(job["generationReady"], false);
    assert!(jobs.submit(id.clone(), true).await.is_err());
    assert!(jobs.prepare(base.clone(), intent()).await.is_err());
    assert!(jobs.status("foreign-job".into()).await.is_err());
    let job_id = job["id"].as_str().unwrap().to_owned();
    for expected in ["queued", "running", "succeeded"] {
        let status = jobs.status(job_id.clone()).await.unwrap();
        assert_eq!(status["state"], expected, "{status}");
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
        ("checkpoint", json!("模型")),
        ("checkpoint", json!("dir//model")),
        ("checkpoint", json!("https://host/model")),
        ("checkpoint", json!("a".repeat(256))),
        ("checkpoint", json!("")),
        ("seed", json!(9_007_199_254_740_992_u64)),
        ("seed", json!(-1)),
        ("seed", json!(0.5)),
        ("width", json!(65)),
        ("width", json!(2056)),
        ("height", json!(56)),
        ("steps", json!(151)),
        ("steps", json!(0)),
        ("cfg", json!(30.1)),
        ("cfg", json!("7")),
        ("sampler", json!("other")),
        ("scheduler", json!(null)),
        ("outputPrefix", json!("../x")),
        ("outputPrefix", json!("")),
        ("outputPrefix", json!("a".repeat(129))),
        ("outputPrefix", json!("image.png")),
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
