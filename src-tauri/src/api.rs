//! Read-only negotiation, not execution readiness. No SDK/cloud defaults.
//!
//! Probe contract researched from official proxy commit
//! 1569dc17ec0dd293d4b9a0723e142204dacedb85, src/comfy_api_proxy/app.py
//! (health/list_jobs) and auth.py: health is unauthenticated and does NOT
//! contact ComfyUI, so also check the protected, bounded jobs listing.
//! https://docs.comfy.org/development/comfyui-server/api-proxy
//! Classic shape: Comfy-Org/ComfyUI server.py get_prompt/get_queue_info.
use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const MAX_PROBE_BYTES: usize = 64 * 1024;
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiNegotiation {
    pub base_url: String,
    pub protocol: &'static str,
    pub generation_ready: bool,
    /// Only operations actually observed. No upload/submission/cancel claims.
    pub capabilities: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NegotiationError {
    pub code: &'static str,
    pub endpoint: String,
    pub message: String,
}

fn failure(code: &'static str, endpoint: &str, message: impl Into<String>) -> NegotiationError {
    NegotiationError {
        code,
        endpoint: endpoint.into(),
        message: message.into(),
    }
}

async fn probe(
    client: &Client,
    base: &Url,
    endpoint: &str,
    optional: bool,
) -> Result<Option<Value>, NegotiationError> {
    let url = base
        .join(endpoint)
        .map_err(|_| failure("invalidEndpoint", endpoint, "Invalid probe endpoint"))?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| {
            failure(
                if e.is_timeout() {
                    "timeout"
                } else {
                    "transport"
                },
                endpoint,
                "Probe request failed",
            )
        })?;
    let status = response.status();
    if optional && status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        let code = if matches!(status.as_u16(), 401 | 403) {
            "authentication"
        } else if status.is_redirection() {
            "redirect"
        } else {
            "http"
        };
        return Err(failure(
            code,
            endpoint,
            format!("Probe returned HTTP {}", status.as_u16()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_PROBE_BYTES as u64)
    {
        return Err(failure(
            "responseTooLarge",
            endpoint,
            "Probe exceeded 65536-byte limit",
        ));
    }
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if matches!(media_type.as_str(), "text/html" | "application/xhtml+xml") {
        return Err(failure(
            "html",
            endpoint,
            "Probe returned HTML, not the API contract",
        ));
    }
    if media_type != "application/json"
        && !(media_type.starts_with("application/") && media_type.ends_with("+json"))
    {
        return Err(failure(
            "malformed",
            endpoint,
            "Probe must return a JSON content type",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        failure(
            if e.is_timeout() {
                "timeout"
            } else {
                "transport"
            },
            endpoint,
            "Probe body failed",
        )
    })? {
        if chunk.len() > MAX_PROBE_BYTES - body.len() {
            return Err(failure(
                "responseTooLarge",
                endpoint,
                "Probe exceeded 65536-byte limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    if body.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'<') {
        return Err(failure(
            "html",
            endpoint,
            "Probe returned HTML, not the API contract",
        ));
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| failure("malformed", endpoint, "Probe returned invalid JSON"))
}

async fn negotiate(base: Url) -> Result<ApiNegotiation, NegotiationError> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| failure("transport", "", "Could not create negotiation client"))?;
    let (protocol, capabilities) =
        if let Some(health) = probe(&client, &base, "api/v2/health", true).await? {
            if !health.is_object()
                || health.get("status").and_then(Value::as_str).is_none()
                || health.get("upstream").and_then(Value::as_str).is_none()
            {
                return Err(failure(
                    "malformed",
                    "api/v2/health",
                    "Expected status and upstream strings",
                ));
            }
            if health["status"] != "healthy"
                || crate::validate_base_url(health["upstream"].as_str().unwrap()).is_err()
            {
                return Err(failure(
                    "incompatible",
                    "api/v2/health",
                    "Unsupported v2 health contract",
                ));
            }
            // Never contact the returned upstream URL; it is untrusted metadata.
            let jobs = probe(&client, &base, "api/v2/jobs?limit=1", false)
                .await?
                .unwrap();
            let list = jobs.get("jobs").and_then(Value::as_array).ok_or_else(|| {
                failure("malformed", "api/v2/jobs?limit=1", "Expected jobs array")
            })?;
            if !jobs.get("truncated").is_some_and(Value::is_boolean) {
                return Err(failure(
                    "malformed",
                    "api/v2/jobs?limit=1",
                    "Expected truncated boolean",
                ));
            }
            if list.len() > 1 {
                return Err(failure(
                    "incompatible",
                    "api/v2/jobs?limit=1",
                    "Server ignored bounded list limit",
                ));
            }
            for job in list {
                let id = job.get("id").and_then(Value::as_str);
                let status = job.get("status").and_then(Value::as_str);
                if id.and_then(|id| uuid::Uuid::parse_str(id).ok()).is_none()
                    || !job.get("outputs").is_some_and(Value::is_array)
                    || status.is_none()
                {
                    return Err(failure(
                        "malformed",
                        "api/v2/jobs?limit=1",
                        "Malformed v2 job record",
                    ));
                }
                if !matches!(
                    status.unwrap(),
                    "queued"
                        | "running"
                        | "succeeded"
                        | "canceling"
                        | "canceled"
                        | "failed"
                        | "expired"
                ) {
                    return Err(failure(
                        "incompatible",
                        "api/v2/jobs?limit=1",
                        "Unsupported v2 job status",
                    ));
                }
            }
            ("v2", vec!["v2Health", "v2JobListing"])
        } else {
            // Only absence (404) of the optional v2 probe authorizes classic fallback.
            let prompt = probe(&client, &base, "prompt", false).await?.unwrap();
            if prompt
                .get("exec_info")
                .and_then(|v| v.get("queue_remaining"))
                .and_then(Value::as_u64)
                .is_none()
            {
                return Err(failure(
                    "malformed",
                    "prompt",
                    "Expected exec_info.queue_remaining nonnegative integer",
                ));
            }
            ("classic", vec!["classicQueueStatus"])
        };
    Ok(ApiNegotiation {
        base_url: base.to_string(),
        protocol,
        generation_ready: false,
        capabilities,
    })
}

/// Explicit selected endpoint only. No service start, credentials, assets or writes.
#[tauri::command]
pub async fn native_negotiate_api(base_url: String) -> Result<ApiNegotiation, NegotiationError> {
    let base =
        crate::validate_base_url(&base_url).map_err(|e| failure("invalidEndpoint", "", e))?;
    tokio::time::timeout(NEGOTIATION_TIMEOUT, negotiate(base))
        .await
        .map_err(|_| {
            failure(
                "timeout",
                "",
                "Negotiation exceeded 10-second total deadline",
            )
        })?
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
