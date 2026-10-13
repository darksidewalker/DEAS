//! Read-only core object_info diagnosis, not model-load or generation proof.

use serde_json::{json, Value};
use std::time::Duration;

const REQUIRED_NODES: [&str; 6] = [
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
];

fn combo(nodes: &Value, node: &str, field: &str) -> Result<Vec<String>, String> {
    if nodes.get(node).is_none() {
        return Ok(Vec::new());
    }
    let schema = nodes[node]["input"]["required"][field]
        .as_array()
        .filter(|schema| {
            (1..=2).contains(&schema.len()) && schema.get(1).is_none_or(Value::is_object)
        })
        .ok_or_else(|| format!("object_info {node}.{field} has malformed combo schema"))?;
    let choices = schema[0]
        .as_array()
        .ok_or_else(|| format!("object_info {node}.{field} must be a combo array"))?;
    let mut seen = std::collections::HashSet::new();
    choices
        .iter()
        .map(|value| {
            let identifier = value.as_str().ok_or_else(|| {
                format!("object_info {node}.{field} contains a non-string choice")
            })?;
            // Checkpoints match the compiler's exact safe ASCII relative path grammar.
            let safe = if field == "ckpt_name" {
                identifier.len() <= 255
                    && identifier.split('/').all(|segment| {
                        !segment.is_empty()
                            && segment != "."
                            && segment != ".."
                            && segment
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                    })
            } else {
                !identifier.is_empty()
                    && identifier.len() <= 255
                    && identifier
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            };
            if !safe || !seen.insert(identifier) {
                return Err(format!(
                    "object_info {node}.{field} contains an unsafe or duplicate choice"
                ));
            }
            Ok(identifier.to_owned())
        })
        .collect()
}

fn parse(base: &reqwest::Url, nodes: &Value) -> Result<Value, String> {
    let definitions = nodes
        .as_object()
        .ok_or("object_info must be a JSON object")?;
    if definitions.values().any(|node| !node.is_object()) {
        return Err("object_info contains malformed node definitions".into());
    }
    Ok(json!({
        "baseUrl":base.as_str(), "recipeId":"checkpoint-text-to-image-diagnostic", "version":1,
        "allowlist":{
            "nodes":REQUIRED_NODES.iter().filter(|name| definitions.contains_key(**name)).collect::<Vec<_>>(),
            "checkpoints":combo(nodes, "CheckpointLoaderSimple", "ckpt_name")?,
            "samplers":combo(nodes, "KSampler", "sampler_name")?,
            "schedulers":combo(nodes, "KSampler", "scheduler")?
        }, "missingNodes":REQUIRED_NODES.iter().filter(|name| !definitions.contains_key(**name)).collect::<Vec<_>>(), "generationReady":false
    }))
}

/// Explicit core probe only; does not negotiate v2 or follow upstream metadata.
#[tauri::command]
pub async fn native_recipe_prerequisites(base_url: String) -> Result<Value, String> {
    let base = crate::validate_base_url(&base_url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("Could not create prerequisite client: {error}"))?;
    let nodes = crate::get_json(&client, &base, "object_info", false)
        .await?
        .ok_or("Missing object_info response")?;
    parse(&base, &nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn nodes() -> Value {
        json!({
            "CheckpointLoaderSimple": {"input":{"required":{"ckpt_name":[["sd/model.safetensors"], {}]}}},
            "CLIPTextEncode": {}, "EmptyLatentImage": {},
            "KSampler": {"input":{"required":{"sampler_name":[["euler", "dpmpp_2m"]],"scheduler":[["normal", "karras"]]}}},
            "VAEDecode": {}, "SaveImage": {}, "UnrelatedNode": {}
        })
    }

    async fn fixture(body: String) -> (String, tokio::task::JoinHandle<String>) {
        fixture_response(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()), Duration::ZERO).await
    }

    async fn fixture_response(
        response: String,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 1024];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            tokio::time::sleep(delay).await;
            // Oversize/timeout probes may close before the fixture finishes writing.
            let _ = socket.write_all(response.as_bytes()).await;
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}/comfy"), task)
    }

    #[tokio::test]
    async fn missing_nodes_are_diagnostics_with_empty_dependent_choices() {
        for absent in [
            vec!["CheckpointLoaderSimple"],
            vec!["KSampler"],
            REQUIRED_NODES.to_vec(),
        ] {
            let mut info = nodes();
            for name in &absent {
                info.as_object_mut().unwrap().remove(*name);
            }
            let (base, request) = fixture(info.to_string()).await;
            let result = native_recipe_prerequisites(base).await.unwrap();
            assert_eq!(result["missingNodes"], json!(absent));
            assert_eq!(
                result["allowlist"]["nodes"],
                json!(REQUIRED_NODES
                    .iter()
                    .filter(|n| !absent.contains(n))
                    .collect::<Vec<_>>())
            );
            if absent.contains(&"CheckpointLoaderSimple") {
                assert_eq!(result["allowlist"]["checkpoints"], json!([]));
            }
            if absent.contains(&"KSampler") {
                assert_eq!(result["allowlist"]["samplers"], json!([]));
                assert_eq!(result["allowlist"]["schedulers"], json!([]));
            }
            assert_eq!(result["generationReady"], false);
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_unsafe_or_duplicate_combo_identities_without_normalizing() {
        for (node, field, choices) in [
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["../model.safetensors"]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["/model.safetensors"]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["dir\\model.safetensors"]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["https://host/model"]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!([" model.safetensors"]),
            ),
            ("CheckpointLoaderSimple", "ckpt_name", json!(["dir//model"])),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["dir/./model"]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["m".repeat(256)]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["模型.safetensors"]),
            ),
            (
                "CheckpointLoaderSimple",
                "ckpt_name",
                json!(["model", "model"]),
            ),
            ("KSampler", "sampler_name", json!(["euler", "euler"])),
            ("KSampler", "scheduler", json!(["normal", "normal"])),
            ("KSampler", "sampler_name", json!([""])),
            ("KSampler", "scheduler", json!([" normal"])),
            ("KSampler", "scheduler", json!(["normal\u{0000}"])),
            ("KSampler", "scheduler", json!([null])),
            ("KSampler", "sampler_name", json!([42])),
        ] {
            let mut info = nodes();
            info[node]["input"]["required"][field][0] = choices.clone();
            let (base, request) = fixture(info.to_string()).await;
            assert!(
                native_recipe_prerequisites(base).await.is_err(),
                "accepted {node}.{field}: {choices}"
            );
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn malformed_present_combo_schema_fails_closed() {
        for schema in [
            json!([["model"], null]),
            json!([["model"], {}, {}]),
            json!({"0":["model"]}),
            json!([]),
            json!("CHECKPOINT"),
            json!(["CHECKPOINT"]),
            json!([null]),
        ] {
            for (node, field) in [
                ("CheckpointLoaderSimple", "ckpt_name"),
                ("KSampler", "sampler_name"),
                ("KSampler", "scheduler"),
            ] {
                let mut info = nodes();
                info[node]["input"]["required"][field] = schema.clone();
                let (base, request) = fixture(info.to_string()).await;
                assert!(
                    native_recipe_prerequisites(base).await.is_err(),
                    "accepted {node}.{field}: {schema}"
                );
                request.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn empty_model_inventory_is_not_generation_readiness() {
        let mut info = nodes();
        info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"] = json!([[]]);
        let (base, request) = fixture(info.to_string()).await;
        let result = native_recipe_prerequisites(base).await.unwrap();
        assert_eq!(result["allowlist"]["checkpoints"], json!([]));
        assert_eq!(result["missingNodes"], json!([]));
        assert_eq!(result["generationReady"], false);
        request.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_invalid_object_info_or_missing_present_node_fields() {
        let mut cases = vec![json!([]), json!(null), json!({"KSampler":null})];
        for node in ["CheckpointLoaderSimple", "KSampler"] {
            let mut info = nodes();
            info[node] = json!({});
            cases.push(info);
        }
        for info in cases {
            let (base, request) = fixture(info.to_string()).await;
            assert!(native_recipe_prerequisites(base).await.is_err());
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_errors_do_not_become_missing_node_diagnostics() {
        for status in [401, 403, 404, 500] {
            let response = format!(
                "HTTP/1.1 {status} Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
            let (base, request) = fixture_response(response, Duration::ZERO).await;
            let error = native_recipe_prerequisites(base).await.unwrap_err();
            assert!(error.contains(&format!("HTTP {status}")), "{error}");
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_html_and_invalid_json() {
        for body in ["<html>Not ComfyUI</html>", "{broken"] {
            let (base, request) = fixture(body.into()).await;
            assert!(native_recipe_prerequisites(base)
                .await
                .unwrap_err()
                .contains("invalid JSON"));
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn redirects_never_contact_the_destination() {
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let response = format!("HTTP/1.1 302 Found\r\nLocation: http://{}/object_info\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.local_addr().unwrap());
        let (base, request) = fixture_response(response, Duration::ZERO).await;
        assert!(native_recipe_prerequisites(base)
            .await
            .unwrap_err()
            .contains("HTTP 302"));
        request.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn bounds_declared_and_chunked_response_bytes() {
        let size = crate::MAX_RESPONSE_BYTES + 1;
        let declared =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n");
        let chunked = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{size:x}\r\n{}\r\n0\r\n\r\n", " ".repeat(size));
        for response in [declared, chunked] {
            let (base, request) = fixture_response(response, Duration::ZERO).await;
            assert!(native_recipe_prerequisites(base)
                .await
                .unwrap_err()
                .contains("response size limit"));
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn enforces_ten_second_total_request_timeout() {
        let (base, request) = fixture_response(String::new(), Duration::from_secs(11)).await;
        let started = std::time::Instant::now();
        assert!(native_recipe_prerequisites(base)
            .await
            .unwrap_err()
            .contains("request failed"));
        assert!(started.elapsed() >= Duration::from_secs(9));
        assert!(started.elapsed() < Duration::from_secs(11));
        request.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_unsafe_base_urls_before_network_access() {
        for base in [
            "file:///etc/passwd",
            "http://@localhost:8188",
            "http://user:secret@localhost:8188",
            "http://localhost:8188/?token=x",
            "http://localhost:8188/#fragment",
            "not a url",
        ] {
            assert!(native_recipe_prerequisites(base.into()).await.is_err());
        }
    }

    #[test]
    fn command_is_registered_with_local_read_only_permission() {
        assert!(include_str!("main.rs").contains("deas::native_recipe_prerequisites,"));
        let permissions: toml::Value =
            toml::from_str(include_str!("../permissions/api.toml")).unwrap();
        let permission = permissions["permission"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["identifier"].as_str() == Some("allow-native-recipe-prerequisites"))
            .expect("dedicated read-only permission missing");
        assert_eq!(
            permission["commands"]["allow"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["native_recipe_prerequisites"]
        );
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["local"], true);
        assert!(capability.get("remote").is_none());
        assert_eq!(capability["windows"], json!(["main"]));
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-native-recipe-prerequisites")));
    }

    #[tokio::test]
    async fn discovers_exact_core_choices_with_prefixed_get() {
        let (base, request) = fixture(nodes().to_string()).await;
        let result = native_recipe_prerequisites(base.clone()).await.unwrap();
        assert_eq!(
            result,
            json!({
                "baseUrl": format!("{base}/"), "recipeId":"checkpoint-text-to-image-diagnostic", "version":1,
                "allowlist":{
                    "nodes":["CheckpointLoaderSimple","CLIPTextEncode","EmptyLatentImage","KSampler","VAEDecode","SaveImage"],
                    "checkpoints":["sd/model.safetensors"], "samplers":["euler","dpmpp_2m"], "schedulers":["normal","karras"]
                }, "missingNodes":[], "generationReady":false
            })
        );
        assert!(request
            .await
            .unwrap()
            .starts_with("GET /comfy/object_info HTTP/1.1\r\n"));
    }
}
