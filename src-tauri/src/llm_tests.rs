use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

fn request() -> LlmRequest {
    LlmRequest {
        model: ModelRef {
            id: "fixture-model".into(),
            provider: Provider::Openai,
        },
        system: "System fixture".into(),
        prompt: "Prompt fixture".into(),
        max_tokens: 32,
        temperature: 0.2,
    }
}
fn config(provider: Provider, url: String) -> LlmConfig {
    LlmConfig {
        provider,
        base_url: url,
    }
}
fn http_fixture(
    status: u16,
    body: Vec<u8>,
    extra: &str,
) -> (String, std::thread::JoinHandle<(String, Value)>) {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = socket.local_addr().unwrap();
    let extra = extra.to_owned();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = socket.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let end = loop {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
            if bytes.ends_with(b"\r\n\r\n") {
                break bytes.len();
            }
        };
        let header = String::from_utf8(bytes).unwrap();
        let length: usize = header
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length:")
                    .map(|s| s.trim().parse().unwrap())
            })
            .unwrap_or(0);
        let mut data = vec![0; length];
        stream.read_exact(&mut data).unwrap();
        let _ = write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len());
        let _ = stream.write_all(&body);
        assert!(end > 0);
        (
            header.lines().next().unwrap().to_owned(),
            if data.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&data).unwrap()
            },
        )
    });
    (format!("http://{address}/prefix"), thread)
}

#[test]
fn config_roundtrip_defaults_and_boundary_validation() {
    let root = tempfile::tempdir().unwrap();
    let expected = LlmConfig::default();
    assert_eq!(read(root.path()).unwrap(), expected);
    assert_eq!(write(root.path(), expected.clone()).unwrap(), expected);
    assert_eq!(read(root.path()).unwrap(), expected);
    for url in [
        "file:///etc/passwd",
        "http://user:secret@localhost",
        "http://localhost/?key=secret",
        "http://localhost/#x",
        " http://localhost",
        "http://localhost/\n",
    ] {
        let mut bad = expected.clone();
        bad.base_url = url.into();
        assert!(write(root.path(), bad).is_err());
    }
    assert_eq!(
        serde_json::to_value(&expected).unwrap(),
        json!({"provider":"local","baseUrl":"http://127.0.0.1:11434"})
    );
    std::fs::write(root.path().join(FILE), br#"{"provider":"openai","baseUrl":"http://localhost/v1","model":"old","localModel":"/lost.gguf","fallback":true,"nCtx":1,"nGpuLayers":999}"#).unwrap();
    let migrated = read(root.path()).unwrap();
    assert_eq!(migrated.provider, Provider::Openai);
    write(root.path(), migrated).unwrap();
    let saved: Value =
        serde_json::from_slice(&std::fs::read(root.path().join(FILE)).unwrap()).unwrap();
    assert_eq!(saved.as_object().unwrap().len(), 2);
    let mut old_ipc = serde_json::to_value(&expected).unwrap();
    old_ipc["model"] = json!("removed");
    assert!(serde_json::from_value::<LlmConfig>(old_ipc).is_err());
    let mut unknown_disk = saved;
    unknown_disk["unknownSetting"] = json!(true);
    std::fs::write(
        root.path().join(FILE),
        serde_json::to_vec(&unknown_disk).unwrap(),
    )
    .unwrap();
    assert!(read(root.path()).is_err());
    let mut raw = serde_json::to_value(&expected).unwrap();
    raw["apiKey"] = json!("secret");
    assert!(serde_json::from_value::<LlmConfig>(raw).is_err());
    assert!(read(Path::new("relative")).is_err());
    std::fs::write(root.path().join(FILE), vec![b' '; 16385]).unwrap();
    assert!(read(root.path()).is_err());
    std::fs::write(root.path().join(FILE), br#"{"secret":"must-not-appear"}"#).unwrap();
    assert!(!read(root.path()).unwrap_err().contains("must-not-appear"));
}
#[cfg(unix)]
#[test]
fn refuses_symlink_settings_roots_and_unsafe_permissions() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("victim"), "untouched").unwrap();
    symlink(other.path().join("victim"), root.path().join(FILE)).unwrap();
    assert!(read(root.path()).is_err());
    assert!(write(root.path(), LlmConfig::default()).is_err());
    assert_eq!(
        std::fs::read_to_string(other.path().join("victim")).unwrap(),
        "untouched"
    );
    symlink(root.path(), other.path().join("alias")).unwrap();
    assert!(read(&other.path().join("alias")).is_err());
    std::fs::remove_file(root.path().join(FILE)).unwrap();
    write(root.path(), LlmConfig::default()).unwrap();
    std::fs::set_permissions(
        root.path().join(FILE),
        std::fs::Permissions::from_mode(0o666),
    )
    .unwrap();
    assert!(read(root.path()).is_err());
    assert!(write(root.path(), LlmConfig::default()).is_err());
}
#[test]
fn validates_requests_and_local_model_without_token_estimates() {
    assert!(validate_request(&request()).is_ok());
    for temperature in [f64::NAN, f64::INFINITY, -0.1, 2.1] {
        let mut bad = request();
        bad.temperature = temperature;
        assert!(validate_request(&bad).is_err());
    }
    for tokens in [0, 4096, 16385] {
        let mut bad = request();
        bad.max_tokens = tokens;
        assert!(validate_request(&bad).is_err());
    }
    for text in [" ".to_string(), "\0".into(), "a".repeat(MAX_INPUT + 1)] {
        let mut bad = request();
        bad.prompt = text;
        assert!(validate_request(&bad).is_err());
    }
    for id in [
        "/absolute.gguf",
        "../escape.gguf",
        "a/../x.gguf",
        "a\\x.gguf",
        "a%2fx.gguf",
        "./a.gguf",
        "a//b.gguf",
        ".hidden/a.gguf",
        "a:drive.gguf",
    ] {
        assert!(model_id(id, Provider::Local).is_err(), "{id}");
    }
    assert!(model_id("nested/模型 file.gguf", Provider::Local).is_ok());
}
#[tokio::test]
async fn actual_http_chat_payloads_and_prefixes() {
    for provider in [Provider::Ollama, Provider::Openai] {
        let body = if provider == Provider::Ollama {
            json!({"message":{"role":"assistant","content":"fixture reply"},"done":true})
        } else {
            json!({"choices":[{"message":{"role":"assistant","content":"fixture reply"}}]})
        };
        let (url, server) = http_fixture(200, serde_json::to_vec(&body).unwrap(), "");
        let cfg = config(provider, format!("{url}/v1"));
        assert_eq!(
            remote(&cfg, &request(), Duration::from_secs(5))
                .await
                .unwrap(),
            "fixture reply"
        );
        let (line, payload) = server.join().unwrap();
        assert_eq!(
            line,
            if provider == Provider::Ollama {
                "POST /prefix/v1/api/chat HTTP/1.1"
            } else {
                "POST /prefix/v1/chat/completions HTTP/1.1"
            }
        );
        assert_eq!(payload["model"], "fixture-model");
        assert_eq!(payload["messages"][0]["content"], request().system);
        assert_eq!(payload["messages"][1]["content"], request().prompt);
        assert_eq!(payload["stream"], false);
        if provider == Provider::Ollama {
            assert_eq!(payload["options"]["num_ctx"], 4096);
            assert_eq!(payload["options"]["num_predict"], 32);
        } else {
            assert_eq!(payload["max_tokens"], 32);
        }
    }
}
#[tokio::test]
async fn remote_errors_are_redacted_without_fallback_policy() {
    for status in [301, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504] {
        let (url, server) = http_fixture(
            status,
            b"SECRET prompt/error body".to_vec(),
            "Location: http://127.0.0.1:1/\r\n",
        );
        let error = remote(
            &config(Provider::Openai, url),
            &request(),
            Duration::from_secs(5),
        )
        .await
        .err()
        .unwrap();
        assert!(!error.contains("SECRET"));
        server.join().unwrap();
    }
    for body in [
        b"SECRET bad JSON".to_vec(),
        br#"{"error":"SECRET"}"#.to_vec(),
        br#"{"choices":[]}"#.to_vec(),
        br#"{"choices":[{"message":{"content":""}}]}"#.to_vec(),
        vec![b'x'; MAX_RESPONSE + 1],
    ] {
        let (url, server) = http_fixture(200, body, "");
        let error = remote(
            &config(Provider::Openai, url),
            &request(),
            Duration::from_secs(5),
        )
        .await
        .err()
        .unwrap();
        assert!(!error.contains("SECRET"));
        server.join().unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let error = remote(
        &config(Provider::Ollama, url),
        &request(),
        Duration::from_secs(2),
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("unavailable"));
    assert!(response_text(
        &json!({"message":{"role":"assistant","content":"partial"},"done":false}),
        Provider::Ollama
    )
    .is_err());
}
#[tokio::test]
async fn bounds_total_http_time_and_chunked_response_bytes() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        let _ = stream.read(&mut buf).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let start = std::time::Instant::now();
    let error = remote(
        &config(Provider::Openai, url),
        &request(),
        Duration::from_millis(100),
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(1));
    task.abort();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        let _ = stream.read(&mut buf).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        for _ in 0..=MAX_RESPONSE / 4096 {
            if stream.write_all(b"1000\r\n").await.is_err() {
                break;
            }
            if stream.write_all(&[b'x'; 4096]).await.is_err() {
                break;
            }
            if stream.write_all(b"\r\n").await.is_err() {
                break;
            }
        }
        let _ = stream.write_all(b"0\r\n\r\n").await;
    });
    let error = remote(
        &config(Provider::Openai, url),
        &request(),
        Duration::from_secs(5),
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("byte limit"));
    task.await.unwrap();
}
#[tokio::test]
async fn subprocess_output_reader_is_bounded() {
    assert_eq!(bounded_read(&b"abc"[..], 3).await.unwrap(), b"abc");
    assert!(bounded_read(&b"abcd"[..], 3).await.is_err());
}
#[test]
fn python_worker_mocked_import_fixtures() {
    // Fixtures only: this executes the real worker code with a fake llama_cpp import.
    let code = format!(
        r#"
import sys, types, tempfile, os
ns = {{'__name__': 'fixture'}}
exec({worker:?}, ns)
calls = []
class Fixture:
    def __init__(self, **kwargs): calls.append(kwargs)
    def create_chat_completion(self, **kwargs):
        calls.append(kwargs)
        return {{'choices':[{{'message':{{'content':'fixture text'}}}}]}}
    def close(self): calls.append('closed')
sys.modules['llama_cpp'] = types.SimpleNamespace(Llama=Fixture, llama_supports_gpu_offload=lambda: False)
with tempfile.TemporaryDirectory() as folder:
    path = os.path.join(folder, 'fixture.gguf')
    open(path, 'wb').close()
    payload = {{'modelPath':path, 'request':{{'system':'S','prompt':'P','maxTokens':32,'temperature':0.2}}}}
    assert ns['generate'](payload) == {{'text':'fixture text'}}
    assert calls[0] == {{'model_path':path,'n_ctx':4096,'n_gpu_layers':0,'verbose':False}}
    assert calls[1]['messages'] == [{{'role':'system','content':'S'}},{{'role':'user','content':'P'}}]
    assert calls[1]['stream'] is False and calls[1]['max_tokens'] == 32
    assert calls[-1] == 'closed'
    for field, value in [('maxTokens',0),('maxTokens',4096),('temperature',float('nan')),('prompt',' '),('prompt','\0')]:
        bad = {{'modelPath':path, 'request':dict(payload['request'])}}
        bad['request'][field] = value
        try: ns['generate'](bad)
        except ValueError: pass
        else: raise AssertionError(field)
    sys.modules['llama_cpp'].llama_supports_gpu_offload = lambda: True
    assert ns['generate'](payload) == {{'text':'fixture text'}}
    assert calls[-3]['n_gpu_layers'] == -1
    def broken(self, **kwargs): raise RuntimeError('SECRET prompt')
    Fixture.create_chat_completion = broken
    try: ns['generate'](payload)
    except RuntimeError: pass
    else: raise AssertionError('expected failure')
    assert calls[-1] == 'closed'
print('mocked llama_cpp fixtures passed')
"#,
        worker = include_str!("llm_worker.py")
    );
    let output = std::process::Command::new("python3")
        .args(["-I", "-c", &code])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn managed_worker_subprocess_mock_fixtures_bound_logs_time_and_errors() {
    // Real process/pipe lifecycle, mocked llama_cpp package; not model inference.
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new("python3")
        .args(["-m", "venv", "--without-pip"])
        .arg(root.path().join("venv"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lib = std::fs::read_dir(root.path().join("venv/lib"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let module = lib.join("site-packages/llama_cpp.py");
    let model = root.path().join("fixture.gguf");
    std::fs::write(&model, "GGUF fixture only").unwrap();
    let input = serde_json::to_vec(&json!({"modelPath":model,"request":request()})).unwrap();
    let fixture = |action: &str| {
        format!("import os, time\ndef llama_supports_gpu_offload(): return False\nclass Llama:\n def __init__(self, **kwargs): pass\n def close(self): pass\n def create_chat_completion(self, **kwargs):\n  {action}\n  return {{'choices':[{{'message':{{'content':'subprocess fixture'}}}}]}}\n")
    };
    std::fs::write(&module, fixture("os.write(1, b'native stdout fixture\\n')")).unwrap();
    assert_eq!(
        run_worker(root.path(), input.clone(), Duration::from_secs(5))
            .await
            .unwrap(),
        "subprocess fixture"
    );
    std::fs::write(&module, fixture("raise RuntimeError('SECRET prompt')")).unwrap();
    let error = run_worker(root.path(), input.clone(), Duration::from_secs(5))
        .await
        .unwrap_err();
    assert!(!error.contains("SECRET"));
    std::fs::write(&module, fixture("os.write(2, b'x' * (300 * 1024))")).unwrap();
    assert!(
        run_worker(root.path(), input.clone(), Duration::from_secs(5))
            .await
            .unwrap_err()
            .contains("byte limit")
    );
    std::fs::write(&module, fixture("time.sleep(10)")).unwrap();
    let start = std::time::Instant::now();
    assert_eq!(
        run_worker(root.path(), input, Duration::from_millis(100))
            .await
            .unwrap_err(),
        "Local LLM timed out"
    );
    assert!(start.elapsed() < Duration::from_secs(2));
}
#[tokio::test]
#[ignore = "real automatic GGUF inference; set DEAS_LIVE_LLM_ROOT"]
async fn live_gguf_smoke() {
    let root = std::env::var("DEAS_LIVE_LLM_ROOT").expect("DEAS_LIVE_LLM_ROOT");
    let root = Path::new(&root);
    let cfg = read(root).unwrap();
    let listed = models(root, &cfg).await.unwrap();
    let model = listed
        .models
        .iter()
        .find(|m| {
            m.provider == Provider::Local && m.id == "PromptForge-H3-4B-Uncensored-r4.Q8_0.gguf"
        })
        .expect("discovered local GGUF");
    println!(
        "Discovered {} models; selected {}",
        listed.models.len(),
        model.id
    );
    let req = LlmRequest {
        model: ModelRef {
            id: model.id.clone(),
            provider: model.provider,
        },
        system: "You are a concise assistant.".into(),
        prompt: "Write one short image prompt describing a red apple on a wooden table.".into(),
        max_tokens: 32,
        temperature: 0.0,
    };
    let start = std::time::Instant::now();
    let result = generate(root, &cfg, &req).await.unwrap();
    assert_eq!(result.backend, Provider::Local);
    assert!(!result.text.trim().is_empty());
    println!(
        "Real automatic GGUF generation: {} output bytes in {:?}: {}",
        result.text.len(),
        start.elapsed(),
        result.text
    );
}

fn gguf(path: &Path, arch: &str, kind: Option<&str>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut bytes = b"GGUF".to_vec();
    bytes.extend(3u32.to_le_bytes());
    bytes.extend(1u64.to_le_bytes());
    bytes.extend((if kind.is_some() { 2u64 } else { 1u64 }).to_le_bytes());
    let mut field = |key: &str, value: &str| {
        bytes.extend((key.len() as u64).to_le_bytes());
        bytes.extend(key.as_bytes());
        bytes.extend(8u32.to_le_bytes());
        bytes.extend((value.len() as u64).to_le_bytes());
        bytes.extend(value.as_bytes());
    };
    field("general.architecture", arch);
    if let Some(kind) = kind {
        field("general.type", kind);
    }
    std::fs::write(path, bytes).unwrap();
}
fn local_fixture(root: &Path) -> std::path::PathBuf {
    let base = root.join("ComfyUI/models/llm");
    gguf(&base.join("nested/模型 file.gguf"), "llama", Some("model"));
    gguf(&base.join("mmproj-llama.gguf"), "llama", Some("model"));
    gguf(&base.join("projector.gguf"), "llama", Some("projector"));
    gguf(&base.join("vision.gguf"), "clip", None);
    gguf(&base.join("diffusion.gguf"), "flux", None);
    gguf(&base.join(".hidden/secret.gguf"), "llama", None);
    std::fs::write(base.join("invalid.gguf"), b"bad").unwrap();
    base
}
#[test]
fn model_scan_filters_projectors_hidden_invalid_and_traversal() {
    let root = tempfile::tempdir().unwrap();
    let base = local_fixture(root.path());
    let found = local_models(root.path()).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "nested/模型 file.gguf");
    assert_eq!(
        resolve_local(root.path(), &found[0].id).unwrap(),
        base.join(&found[0].id)
    );
    for id in [
        "projector.gguf",
        "mmproj-llama.gguf",
        "invalid.gguf",
        "../outside.gguf",
    ] {
        assert!(resolve_local(root.path(), id).is_err());
    }
    std::fs::remove_file(base.join(&found[0].id)).unwrap();
    assert!(resolve_local(root.path(), &found[0].id).is_err());
    let mut deep = base.clone();
    for _ in 0..33 {
        deep.push("dir");
    }
    gguf(&deep.join("too-deep.gguf"), "llama", None);
    assert!(local_models(root.path()).unwrap().is_empty());
}
#[cfg(unix)]
#[test]
fn configured_root_alias_works_but_nested_symlinks_are_skipped() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    gguf(&external.path().join("llm/model.gguf"), "qwen3", None);
    let alias = root.path().join("model-alias");
    symlink(external.path(), &alias).unwrap();
    std::fs::write(
        root.path().join("deas-settings.json"),
        serde_json::to_vec(&json!({"models":alias})).unwrap(),
    )
    .unwrap();
    symlink(
        external.path().join("llm"),
        external.path().join("llm/nested-link"),
    )
    .unwrap();
    symlink(
        external.path().join("llm/model.gguf"),
        external.path().join("llm/link.gguf"),
    )
    .unwrap();
    assert_eq!(local_models(root.path()).unwrap().len(), 1);
    assert!(resolve_local(root.path(), "link.gguf").is_err());
    assert!(resolve_local(root.path(), "nested-link/model.gguf").is_err());
    assert_eq!(
        resolve_local(root.path(), "model.gguf").unwrap(),
        external.path().join("llm/model.gguf")
    );
}
#[test]
fn scanner_caps_entries_at_five_thousand() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().join("ComfyUI/models/llm");
    for n in 0..5002 {
        gguf(&base.join(format!("{n}.gguf")), "llama", None);
    }
    assert_eq!(local_models(root.path()).unwrap().len(), 5000);
}
#[tokio::test]
async fn discovery_keeps_local_models_with_remote_success_or_failure() {
    let root = tempfile::tempdir().unwrap();
    local_fixture(root.path());
    for provider in [Provider::Ollama, Provider::Openai] {
        let body = if provider == Provider::Ollama {
            json!({"models":[{"name":"remote:tag"}]})
        } else {
            json!({"data":[{"id":"remote:tag"}]})
        };
        let (url, server) = http_fixture(200, serde_json::to_vec(&body).unwrap(), "");
        let result = models(root.path(), &config(provider, format!("{url}/v1")))
            .await
            .unwrap();
        assert_eq!(result.models.len(), 2);
        assert_eq!(result.models[0].provider, Provider::Local);
        assert_eq!(result.models[1].provider, provider);
        assert!(result.warnings.is_empty());
        let (line, body) = server.join().unwrap();
        assert_eq!(body, Value::Null);
        assert_eq!(
            line,
            if provider == Provider::Ollama {
                "GET /prefix/v1/api/tags HTTP/1.1"
            } else {
                "GET /prefix/v1/models HTTP/1.1"
            }
        );
    }
    for (status, body) in [
        (503, b"SECRET".to_vec()),
        (200, b"bad SECRET JSON".to_vec()),
        (200, br#"{"data":[{"id":"\u0000"}]}"#.to_vec()),
    ] {
        let (url, server) = http_fixture(status, body, "");
        let result = models(root.path(), &config(Provider::Openai, url))
            .await
            .unwrap();
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.warnings.len(), 1);
        assert!(!result.warnings[0].contains("SECRET"));
        server.join().unwrap();
    }
    let result = models(root.path(), &LlmConfig::default()).await.unwrap();
    assert_eq!(result.models.len(), 1);
    assert!(result.warnings.is_empty());
}
fn http_sequence(
    responses: Vec<(u16, Value)>,
) -> (String, std::thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/prefix", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut requests = vec![];
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = vec![];
            while !header.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                stream.read_exact(&mut b).unwrap();
                header.push(b[0]);
            }
            let header = String::from_utf8(header).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|s| s.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut payload = vec![0; length];
            stream.read_exact(&mut payload).unwrap();
            requests.push((
                header.lines().next().unwrap().into(),
                if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&payload).unwrap()
                },
            ));
            let body = serde_json::to_vec(&body).unwrap();
            write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
        }
        requests
    });
    (url, server)
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn generation_exact_selection_no_fallback_and_local_is_independent() {
    let (root, _approved) = crate::backend::tests::fixture("# no service launched");
    local_fixture(root.path());
    let lib = std::fs::read_dir(root.path().join("venv/lib"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(lib.join("site-packages/llama_cpp.py"), "def llama_supports_gpu_offload(): return False\nclass Llama:\n def __init__(self, **kw): assert kw['n_gpu_layers'] == 0 and kw['n_ctx'] == 4096\n def close(self): pass\n def create_chat_completion(self, **kw): return {'choices':[{'message':{'content':'local selected'}}]}\n").unwrap();
    let cfg = config(Provider::Openai, "http://127.0.0.1:1/unavailable".into());
    let mut req = request();
    req.model = ModelRef {
        id: "nested/模型 file.gguf".into(),
        provider: Provider::Local,
    };
    let result = generate(root.path(), &cfg, &req).await.unwrap();
    assert_eq!(result.backend, Provider::Local);
    assert_eq!(result.text, "local selected");
    let permit = RUNS.try_acquire().unwrap();
    assert!(generate(root.path(), &cfg, &req)
        .await
        .unwrap_err()
        .contains("already running"));
    drop(permit);
    req.model = ModelRef {
        id: "fixture-model".into(),
        provider: Provider::Ollama,
    };
    assert!(generate(root.path(), &cfg, &req)
        .await
        .unwrap_err()
        .contains("not configured"));
    req.model.provider = Provider::Openai;
    let (url, server) = http_sequence(vec![(200, json!({"data":[{"id":"other-model"}]}))]);
    assert!(generate(root.path(), &config(Provider::Openai, url), &req)
        .await
        .unwrap_err()
        .contains("no longer available"));
    assert_eq!(server.join().unwrap().len(), 1);
    for status in [200, 401, 503] {
        let (url, server) = http_sequence(vec![
            (200, json!({"data":[{"id":"fixture-model"}]})),
            (
                status,
                json!({"choices":[{"message":{"role":"assistant","content":"remote selected"}}]}),
            ),
        ]);
        let result = generate(root.path(), &config(Provider::Openai, url), &req).await;
        if status == 200 {
            let result = result.unwrap();
            assert_eq!(result.backend, Provider::Openai);
            assert_eq!(result.text, "remote selected");
        } else {
            assert_eq!(
                result.unwrap_err(),
                format!("LLM server returned HTTP {status}")
            );
        }
        let calls = server.join().unwrap();
        assert_eq!(calls[0].0, "GET /prefix/models HTTP/1.1");
        assert_eq!(calls[1].0, "POST /prefix/chat/completions HTTP/1.1");
        assert_eq!(calls[1].1["model"], "fixture-model");
    }
}

#[tokio::test]
async fn forge_bounds_declared_and_chunked_responses_before_buffering() {
    let root = tempfile::tempdir().unwrap();
    let (url, server) = http_fixture(200, br#"{"models":[]}"#.to_vec(), "");
    assert_eq!(
        native_forge(
            url,
            root.path().to_string_lossy().into(),
            "models".into(),
            json!({})
        )
        .await
        .unwrap(),
        json!({"models":[]})
    );
    server.join().unwrap();
    for declared in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf).await;
            if declared {
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                            4 * MAX_RESPONSE + 1
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            } else {
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                    .await
                    .unwrap();
                for _ in 0..=4 * MAX_RESPONSE / 4096 {
                    if stream.write_all(b"1000\r\n").await.is_err()
                        || stream.write_all(&[b'x'; 4096]).await.is_err()
                        || stream.write_all(b"\r\n").await.is_err()
                    {
                        break;
                    }
                }
            }
            // Never finish the body: a post-buffer limit would wait for EOF.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            native_forge(
                url,
                root.path().to_string_lossy().into(),
                "models".into(),
                json!({}),
            ),
        )
        .await;
        task.abort();
        assert_eq!(
            result
                .expect("Forge waited for an oversized body to finish")
                .unwrap_err(),
            "Prompt Forge response too large"
        );
    }
}

#[test]
fn forge_forwards_only_node_pack_routes_with_the_saved_endpoint() {
    assert_eq!(forge_route("write").unwrap(), "dasiwa/llm/write");
    assert_eq!(forge_route("h3").unwrap(), "dasiwa/h3/forge");
    assert!(forge_route("../prompt").is_err() && forge_route("cancel").is_err());
    let ollama = LlmConfig {
        provider: Provider::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
    };
    assert_eq!(
        forge_settings(&ollama),
        json!({"ollama_url": "http://127.0.0.1:11434"})
    );
    assert_eq!(forge_settings(&LlmConfig::default()), json!({}));
}
