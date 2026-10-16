pub mod auth;
pub use auth::{native_auth_remove, native_auth_restore, native_auth_set, native_auth_status};
pub mod downloads;
pub use downloads::{
    native_download_browse, native_download_cancel, native_download_catalog,
    native_download_import_catalog, native_download_plan, native_download_start,
    native_download_status,
};
pub mod api;
pub use api::native_negotiate_api;
pub mod jobs;
pub use jobs::{
    native_job_current, native_job_export, native_job_output, native_job_prepare,
    native_job_status, native_job_submit,
};
pub mod recipe_prerequisites;
pub use recipe_prerequisites::native_recipe_prerequisites;
pub mod backend;
pub use backend::{native_backend_start, native_backend_status, native_backend_stop};
pub mod hardware;
pub use hardware::native_detect_hardware;
pub mod directory;
pub use directory::native_pick_directory;
pub mod media;
pub use media::{native_media_describe, native_media_list};
pub mod install_defaults;
pub use install_defaults::native_install_defaults;
pub mod install;
pub use install::{
    native_install_cancel, native_install_plan, native_install_start, native_install_status,
};

use reqwest::Url;

fn validate_base_url(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input.trim())
        .map_err(|_| "Enter an absolute HTTP or HTTPS backend URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Backend URL must use HTTP or HTTPS and include a host".into());
    }
    let authority_has_credentials = input
        .trim()
        .split_once("://")
        .map(|(_, rest)| {
            rest.split(['/', '\\', '?', '#'])
                .next()
                .unwrap_or("")
                .contains('@')
        })
        .unwrap_or(false);
    if authority_has_credentials
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Backend URL must not contain credentials, a query, or a fragment".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

const REQUIRED_NODES: [&str; 2] = ["MiniMaxH3Director", "MiniMaxH3DirectorGuide"];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSnapshot {
    pub base_url: String,
    pub node_count: usize,
    pub devices: Vec<String>,
    pub missing_required_nodes: Vec<String>,
    pub capabilities: Vec<String>,
}

fn parse_snapshot(
    base: &Url,
    nodes: &serde_json::Value,
    stats: &serde_json::Value,
    features: Option<&serde_json::Value>,
) -> Result<BackendSnapshot, String> {
    let nodes = nodes
        .as_object()
        .ok_or("object_info must be a JSON object")?;
    if nodes.values().any(|node| !node.is_object()) {
        return Err("object_info contains malformed node definitions".into());
    }
    let reported_devices = stats
        .get("devices")
        .and_then(|v| v.as_array())
        .ok_or("system_stats must include a devices array")?;
    let devices = reported_devices
        .iter()
        .map(|device| {
            device
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| "system_stats contains a device without a name".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut capabilities = match features {
        Some(value) => value
            .as_object()
            .ok_or("features must be a JSON object")?
            .iter()
            .filter(|(_, value)| !value.is_null() && **value != serde_json::Value::Bool(false))
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>(),
        None => vec![],
    };
    capabilities.sort();
    Ok(BackendSnapshot {
        base_url: base.to_string(),
        node_count: nodes.len(),
        devices,
        missing_required_nodes: REQUIRED_NODES
            .iter()
            .filter(|name| !nodes.contains_key(**name))
            .map(|name| (*name).to_owned())
            .collect(),
        capabilities,
    })
}

// Bounds apply even to chunked responses with no Content-Length.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

async fn get_json(
    client: &reqwest::Client,
    base: &Url,
    endpoint: &str,
    optional: bool,
) -> Result<Option<serde_json::Value>, String> {
    let url = base
        .join(endpoint)
        .map_err(|_| "Invalid backend endpoint".to_string())?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("{endpoint} request failed: {error}"))?;
    if optional && response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    // error_for_status doesn't reject redirects, so require a success explicitly.
    if !response.status().is_success() {
        return Err(format!("{endpoint} returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "{endpoint} exceeded response size limit ({MAX_RESPONSE_BYTES} bytes)"
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("{endpoint} response failed: {error}"))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
            return Err(format!(
                "{endpoint} exceeded response size limit ({MAX_RESPONSE_BYTES} bytes)"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("{endpoint} returned invalid JSON: {error}"))
}

pub mod commands {
    use super::{get_json, parse_snapshot, validate_base_url, BackendSnapshot};
    use std::time::Duration;

    /// Observe an existing backend only: never install, launch, mutate, or stop it.
    #[tauri::command]
    pub async fn inspect_backend(base_url: String) -> Result<BackendSnapshot, String> {
        let base = validate_base_url(&base_url)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| format!("Could not create inspection client: {error}"))?;
        let nodes = get_json(&client, &base, "object_info", false)
            .await?
            .ok_or("Missing object_info response")?;
        let stats = get_json(&client, &base, "system_stats", false)
            .await?
            .ok_or("Missing system_stats response")?;
        let features = get_json(&client, &base, "features", true).await?;
        parse_snapshot(&base, &nodes, &stats, features.as_ref())
    }
}
pub use commands::inspect_backend;

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(
        responses: Vec<(&'static str, String)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = vec![];
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 4096];
                let count = stream.read(&mut bytes).await.unwrap();
                requests.push(
                    String::from_utf8_lossy(&bytes[..count])
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned(),
                );
                let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(header.as_bytes()).await.unwrap();
                // The client is permitted to drop the connection on an oversized response.
                let _ = stream.write_all(body.as_bytes()).await;
            }
            requests
        });
        (url, task)
    }

    #[tokio::test]
    async fn inspection_uses_only_get_and_tolerates_features_404() {
        let (url, server) = serve(vec![
            (
                "200 OK",
                r#"{"MiniMaxH3Director":{},"MiniMaxH3DirectorGuide":{}}"#.into(),
            ),
            (
                "200 OK",
                r#"{"devices":[{"name":"Test device reported by fixture"}]}"#.into(),
            ),
            ("404 Not Found", "".into()),
        ])
        .await;
        let snapshot = super::inspect_backend(url).await.unwrap();
        assert_eq!(snapshot.node_count, 2);
        assert!(snapshot.missing_required_nodes.is_empty());
        assert_eq!(snapshot.devices, ["Test device reported by fixture"]);
        assert!(snapshot.capabilities.is_empty());
        assert_eq!(
            server.await.unwrap(),
            [
                "GET /object_info HTTP/1.1",
                "GET /system_stats HTTP/1.1",
                "GET /features HTTP/1.1"
            ]
        );
    }

    #[tokio::test]
    async fn inspection_rejects_http_failure() {
        let (url, server) = serve(vec![("500 Internal Server Error", "{}".into())]).await;
        assert!(super::inspect_backend(url)
            .await
            .unwrap_err()
            .contains("500"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn inspection_rejects_invalid_json() {
        let (url, server) = serve(vec![("200 OK", "not JSON".into())]).await;
        assert!(super::inspect_backend(url)
            .await
            .unwrap_err()
            .contains("JSON"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn inspection_does_not_follow_redirects() {
        let (url, server) = serve(vec![(
            "302 Found\r\nLocation: http://127.0.0.1:9/private",
            "".into(),
        )])
        .await;
        assert!(super::inspect_backend(url)
            .await
            .unwrap_err()
            .contains("302"));
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn inspection_caps_response_size() {
        let (url, server) = serve(vec![("200 OK", " ".repeat(16 * 1024 * 1024 + 1))]).await;
        assert!(super::inspect_backend(url)
            .await
            .unwrap_err()
            .contains("size limit"));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn inspection_caps_chunked_response_without_content_length() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            assert!(count > 0);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let data = vec![b' '; 1024 * 1024];
            for _ in 0..17 {
                if stream.write_all(b"100000\r\n").await.is_err() {
                    break;
                }
                if stream.write_all(&data).await.is_err() {
                    break;
                }
                if stream.write_all(b"\r\n").await.is_err() {
                    break;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
        });
        assert!(super::inspect_backend(url)
            .await
            .unwrap_err()
            .contains("size limit"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn inspection_times_out_stalled_backend() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        });
        let start = std::time::Instant::now();
        let error = super::inspect_backend(url).await.unwrap_err();
        assert!(error.contains("request failed"), "{error}");
        assert!(start.elapsed() < std::time::Duration::from_secs(15));
        server.abort();
    }

    #[tokio::test]
    async fn inspection_preserves_backend_path_prefix_and_reported_features() {
        let (url, server) = serve(vec![
            ("200 OK", "{}".into()),
            ("200 OK", r#"{"devices":[]}"#.into()),
            ("200 OK", r#"{"reported_feature":true}"#.into()),
        ])
        .await;
        let snapshot = super::inspect_backend(format!("{url}/comfy"))
            .await
            .unwrap();
        assert_eq!(snapshot.capabilities, ["reported_feature"]);
        assert_eq!(
            server.await.unwrap(),
            [
                "GET /comfy/object_info HTTP/1.1",
                "GET /comfy/system_stats HTTP/1.1",
                "GET /comfy/features HTTP/1.1"
            ]
        );
    }

    #[test]
    fn rejects_empty_url_credentials() {
        assert!(super::validate_base_url("http://@localhost:8188").is_err());
    }

    #[test]
    fn parses_only_reported_backend_data() {
        let base = super::validate_base_url("http://localhost:8188").unwrap();
        let snapshot = super::parse_snapshot(
            &base,
            &serde_json::json!({"MiniMaxH3Director": {}, "OtherNode": {}}),
            &serde_json::json!({"devices": [{"name": "Real GPU", "type": "cuda"}]}),
            Some(&serde_json::json!({"preview": true, "disabled": false, "api": {"version": 1}})),
        )
        .unwrap();
        let snapshot = serde_json::to_value(snapshot).unwrap();
        assert_eq!(
            snapshot,
            serde_json::json!({"baseUrl":"http://localhost:8188/", "nodeCount":2, "devices":["Real GPU"], "missingRequiredNodes":["MiniMaxH3DirectorGuide"], "capabilities":["api", "preview"]})
        );
        assert!(super::parse_snapshot(
            &base,
            &serde_json::json!([]),
            &serde_json::json!({"devices":[]}),
            None
        )
        .is_err());
        assert!(
            super::parse_snapshot(&base, &serde_json::json!({}), &serde_json::json!({}), None)
                .is_err()
        );
        assert!(super::parse_snapshot(
            &base,
            &serde_json::json!({}),
            &serde_json::json!({"devices":[{}]}),
            None
        )
        .is_err());
        let empty = serde_json::to_value(
            super::parse_snapshot(
                &base,
                &serde_json::json!({}),
                &serde_json::json!({"devices":[]}),
                None,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(empty["capabilities"], serde_json::json!([]));
        assert_eq!(empty["devices"], serde_json::json!([]));
        assert_eq!(
            empty["missingRequiredNodes"],
            serde_json::json!(["MiniMaxH3Director", "MiniMaxH3DirectorGuide"])
        );
    }
    use super::*;
    #[test]
    fn validates_http_backend_urls() {
        assert_eq!(
            validate_base_url("http://127.0.0.1:8188").unwrap().as_str(),
            "http://127.0.0.1:8188/"
        );
        assert_eq!(
            validate_base_url("https://example.com/comfy")
                .unwrap()
                .as_str(),
            "https://example.com/comfy/"
        );
        for bad in [
            "file:///etc/passwd",
            "ftp://host",
            "http://user:pass@host",
            "http://host?token=x",
            "http://host/#fragment",
            "not a url",
        ] {
            assert!(validate_base_url(bad).is_err(), "accepted {bad}");
        }
    }
}
