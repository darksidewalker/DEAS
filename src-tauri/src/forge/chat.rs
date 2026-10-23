//! One chat round with tools against the configured LLM server — Ollama's
//! native API or an OpenAI-compatible one (llama.cpp, llama-swap, vLLM).
//! Thinking is switched off the way PromptForge does it, because a prompt
//! rewrite gains nothing from reasoning but latency.

use crate::llm::{LlmConfig, Provider};
use serde_json::{json, Value};
use std::time::Duration;

const MAX_RESPONSE: usize = 4 * 1024 * 1024;
/// Ollama loads context at request time; PromptForge runs prompts at 32k.
const OLLAMA_NUM_CTX: u32 = 32_768;

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: String,
    /// As sent: a JSON string (OpenAI) or an object (Ollama).
    pub arguments: Value,
}

#[derive(Debug)]
pub struct Reply {
    pub content: String,
    pub calls: Vec<ToolCall>,
    pub truncated: bool,
}

pub struct Round<'a> {
    pub config: &'a LlmConfig,
    pub model: &'a str,
    pub messages: &'a [Value],
    pub tools: Option<&'a [Value]>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub timeout: Duration,
}

pub async fn round(r: Round<'_>) -> Result<Reply, String> {
    let ollama = match r.config.provider {
        Provider::Ollama => true,
        Provider::Openai => false,
        Provider::Local => {
            return Err("Prompt Forge needs an LLM server (Ollama or OpenAI-compatible) set in Backend → LLM backend; the local GGUF runner cannot call tools yet.".into())
        }
    };
    let mut body = if ollama {
        let mut options = json!({ "num_ctx": OLLAMA_NUM_CTX });
        if let Some(t) = r.temperature {
            options["temperature"] = json!(t);
        }
        if let Some(p) = r.top_p {
            options["top_p"] = json!(p);
        }
        json!({ "model": r.model, "messages": r.messages, "stream": false, "think": false, "options": options })
    } else {
        let mut b = json!({ "model": r.model, "messages": r.messages, "stream": false, "chat_template_kwargs": { "enable_thinking": false } });
        if let Some(t) = r.temperature {
            b["temperature"] = json!(t);
        }
        if let Some(p) = r.top_p {
            b["top_p"] = json!(p);
        }
        b
    };
    if let Some(tools) = r.tools.filter(|t| !t.is_empty()) {
        body["tools"] = json!(tools);
    }
    let url = crate::llm::endpoint(
        r.config,
        if ollama {
            "api/chat"
        } else {
            "chat/completions"
        },
    )?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(r.timeout)
        .build()
        .map_err(|_| "Cannot create LLM HTTP client")?;
    let mut response = client.post(url).json(&body).send().await.map_err(|e| {
        if e.is_timeout() {
            "The LLM took too long to answer".to_string()
        } else {
            "LLM server unavailable or transport failed".to_string()
        }
    })?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "LLM response failed")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("LLM response exceeds byte limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes);
        let detail: String = detail.chars().take(300).collect();
        return Err(format!(
            "LLM server returned HTTP {}: {}",
            status.as_u16(),
            detail.trim()
        ));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "LLM server returned invalid JSON")?;
    parse(&value, ollama)
}

fn parse(value: &Value, ollama: bool) -> Result<Reply, String> {
    let (message, finish) = if ollama {
        (&value["message"], value["done_reason"].as_str())
    } else {
        (
            &value["choices"][0]["message"],
            value["choices"][0]["finish_reason"].as_str(),
        )
    };
    if !message.is_object() {
        return Err("LLM server returned no message".into());
    }
    let content = message["content"].as_str().unwrap_or("").to_string();
    let calls = message["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .filter_map(|c| {
                    let f = &c["function"];
                    let name = f["name"].as_str()?.to_string();
                    Some(ToolCall {
                        id: c["id"].as_str().map(String::from),
                        name,
                        arguments: f["arguments"].clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Reply {
        content,
        calls,
        truncated: finish == Some("length"),
    })
}

/// The model's own tool turn, echoed back before its results.
pub fn assistant_turn(content: &str, calls: &[ToolCall], ollama: bool) -> Value {
    let calls: Vec<Value> = calls
        .iter()
        .map(|c| {
            // Ollama's template walks an object; the OpenAI wire shape is a string.
            let args = if ollama {
                match &c.arguments {
                    Value::String(s) => serde_json::from_str::<Value>(s)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or(json!({})),
                    Value::Object(_) => c.arguments.clone(),
                    _ => json!({}),
                }
            } else {
                match &c.arguments {
                    Value::String(s) => json!(s),
                    other => json!(other.to_string()),
                }
            };
            let mut call =
                json!({ "type": "function", "function": { "name": c.name, "arguments": args } });
            if let Some(id) = &c.id {
                call["id"] = json!(id);
            }
            call
        })
        .collect();
    json!({ "role": "assistant", "content": content, "tool_calls": calls })
}

pub fn tool_result(call: &ToolCall, content: &str) -> Value {
    let mut msg = json!({ "role": "tool", "content": content, "tool_name": call.name });
    if let Some(id) = &call.id {
        msg["tool_call_id"] = json!(id);
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_wire_shapes_parse() {
        let openai = json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"search_tags","arguments":"{\"query\":\"boots\"}"}}]}}]});
        let r = parse(&openai, false).unwrap();
        assert_eq!(r.calls[0].name, "search_tags");
        assert_eq!(r.calls[0].arguments, json!("{\"query\":\"boots\"}"));
        let ollama = json!({"done":true,"done_reason":"length","message":{"role":"assistant","content":"x","tool_calls":[{"function":{"name":"read_guidance","arguments":{"name":"anima-model"}}}]}});
        let r = parse(&ollama, true).unwrap();
        assert!(r.truncated);
        assert_eq!(
            assistant_turn("", &r.calls, true)["tool_calls"][0]["function"]["arguments"]["name"],
            "anima-model"
        );
        assert_eq!(
            assistant_turn("", &r.calls, false)["tool_calls"][0]["function"]["arguments"],
            json!("{\"name\":\"anima-model\"}")
        );
    }
}
