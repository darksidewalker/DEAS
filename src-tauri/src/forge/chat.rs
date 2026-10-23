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
    /// A hard ceiling on the answer (num_predict / max_tokens).
    pub max_tokens: Option<u32>,
    pub timeout: Duration,
}

/// The request for a round: endpoint, body and which wire shape answers.
fn request(r: &Round<'_>, stream: bool) -> Result<(reqwest::Url, Value, bool), String> {
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
        if let Some(n) = r.max_tokens {
            options["num_predict"] = json!(n);
        }
        json!({ "model": r.model, "messages": r.messages, "stream": stream, "think": false, "options": options })
    } else {
        let mut b = json!({ "model": r.model, "messages": r.messages, "stream": stream, "chat_template_kwargs": { "enable_thinking": false } });
        if let Some(t) = r.temperature {
            b["temperature"] = json!(t);
        }
        if let Some(p) = r.top_p {
            b["top_p"] = json!(p);
        }
        if let Some(n) = r.max_tokens {
            b["max_tokens"] = json!(n);
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
    Ok((url, body, ollama))
}

async fn post(
    url: reqwest::Url,
    body: &Value,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .build()
        .map_err(|_| "Cannot create LLM HTTP client")?;
    client.post(url).json(body).send().await.map_err(|e| {
        if e.is_timeout() {
            "The LLM took too long to answer".to_string()
        } else {
            "LLM server unavailable or transport failed".to_string()
        }
    })
}

fn http_error(status: reqwest::StatusCode, bytes: &[u8]) -> String {
    let detail = String::from_utf8_lossy(bytes);
    let detail: String = detail.chars().take(300).collect();
    format!(
        "LLM server returned HTTP {}: {}",
        status.as_u16(),
        detail.trim()
    )
}

pub async fn round(r: Round<'_>) -> Result<Reply, String> {
    let (url, body, ollama) = request(&r, false)?;
    let mut response = post(url, &body, r.timeout).await?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "LLM response failed")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("LLM response exceeds byte limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(http_error(status, &bytes));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "LLM server returned invalid JSON")?;
    parse(&value, ollama)
}

/// A round whose text arrives as it is written: `on_text` gets each piece, and
/// `stop` ends it early (what has arrived so far is the reply).
pub async fn stream_round(
    r: Round<'_>,
    on_text: &mut (dyn FnMut(&str) + Send),
    stop: &std::sync::atomic::AtomicBool,
) -> Result<Reply, String> {
    let (url, body, ollama) = request(&r, true)?;
    let mut response = post(url, &body, r.timeout).await?;
    let status = response.status();
    if !status.is_success() {
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "LLM response failed")? {
            if bytes.len() > 4096 {
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        return Err(http_error(status, &bytes));
    }
    let mut parser = StreamParser::new(ollama);
    let mut total = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(|_| "LLM response failed")? {
        total += chunk.len();
        if total > MAX_RESPONSE {
            return Err("LLM response exceeds byte limit".into());
        }
        for piece in parser.feed(&chunk) {
            on_text(&piece);
        }
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            parser.stopped = true;
            break;
        }
    }
    parser.finish()
}

/// Assembles a streamed answer: OpenAI's SSE `data:` lines with `delta`s (tool
/// calls arrive in pieces by index), or Ollama's NDJSON with whole messages.
pub struct StreamParser {
    ollama: bool,
    pending: Vec<u8>,
    content: String,
    calls: Vec<(Option<String>, String, String, Option<Value>)>,
    finish: Option<String>,
    pub stopped: bool,
    saw_any: bool,
}

impl StreamParser {
    pub fn new(ollama: bool) -> Self {
        Self {
            ollama,
            pending: vec![],
            content: String::new(),
            calls: vec![],
            finish: None,
            stopped: false,
            saw_any: false,
        }
    }

    /// The text pieces in this chunk, in order.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some(at) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=at).collect();
            let line = String::from_utf8_lossy(&line).trim().to_string();
            if let Some(piece) = self.line(&line) {
                out.push(piece);
            }
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<String> {
        let json = if self.ollama {
            line
        } else {
            let data = line.strip_prefix("data:")?.trim();
            if data == "[DONE]" {
                return None;
            }
            data
        };
        let v: Value = serde_json::from_str(json).ok()?;
        self.saw_any = true;
        if self.ollama {
            if let Some(calls) = v["message"]["tool_calls"].as_array() {
                for c in calls {
                    let f = &c["function"];
                    if let Some(name) = f["name"].as_str() {
                        self.calls.push((
                            c["id"].as_str().map(String::from),
                            name.to_string(),
                            String::new(),
                            Some(f["arguments"].clone()),
                        ));
                    }
                }
            }
            if let Some(reason) = v["done_reason"].as_str() {
                self.finish = Some(reason.to_string());
            }
            let text = v["message"]["content"].as_str().unwrap_or("");
            if text.is_empty() {
                return None;
            }
            self.content.push_str(text);
            return Some(text.to_string());
        }
        let choice = &v["choices"][0];
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish = Some(reason.to_string());
        }
        let delta = &choice["delta"];
        if let Some(calls) = delta["tool_calls"].as_array() {
            for c in calls {
                let index = c["index"]
                    .as_u64()
                    .unwrap_or(self.calls.len().saturating_sub(1) as u64)
                    as usize;
                while self.calls.len() <= index {
                    self.calls.push((None, String::new(), String::new(), None));
                }
                let slot = &mut self.calls[index];
                if let Some(id) = c["id"].as_str() {
                    slot.0 = Some(id.to_string());
                }
                if let Some(name) = c["function"]["name"].as_str() {
                    slot.1.push_str(name);
                }
                match &c["function"]["arguments"] {
                    Value::String(a) => slot.2.push_str(a),
                    Value::Null => {}
                    other => slot.3 = Some(other.clone()),
                }
            }
        }
        let text = delta["content"].as_str().unwrap_or("");
        if text.is_empty() {
            return None;
        }
        self.content.push_str(text);
        Some(text.to_string())
    }

    pub fn finish(mut self) -> Result<Reply, String> {
        if !self.pending.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.pending))
                .trim()
                .to_string();
            self.line(&rest);
        }
        if !self.saw_any && !self.stopped {
            return Err("LLM server returned no message".into());
        }
        let calls = self
            .calls
            .into_iter()
            .filter(|c| !c.1.is_empty())
            .map(|(id, name, args, whole)| ToolCall {
                id,
                name,
                arguments: whole.unwrap_or(Value::String(args)),
            })
            .collect();
        Ok(Reply {
            content: self.content,
            calls,
            truncated: self.finish.as_deref() == Some("length"),
        })
    }
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

/// A user turn with pictures (data URIs): content parts for an OpenAI-compatible
/// server, an `images` list of bare base64 for Ollama.
pub fn user_with_images(text: &str, images: &[String], ollama: bool) -> Value {
    if images.is_empty() {
        return json!({ "role": "user", "content": text });
    }
    if ollama {
        let bare: Vec<&str> = images
            .iter()
            .map(|u| u.split_once(",").map_or(u.as_str(), |(_, b)| b))
            .collect();
        return json!({ "role": "user", "content": text, "images": bare });
    }
    let mut parts = vec![json!({ "type": "text", "text": text })];
    parts.extend(
        images
            .iter()
            .map(|u| json!({ "type": "image_url", "image_url": { "url": u } })),
    );
    json!({ "role": "user", "content": parts })
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
    fn openai_stream_assembles_text_and_tool_calls_split_across_chunks() {
        let mut p = StreamParser::new(false);
        let mut text = vec![];
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_",
        );
        text.extend(p.feed(sse.as_bytes()));
        let rest = concat!(
            "guide\",\"arguments\":\"{\\\"name\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"ltx\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        text.extend(p.feed(rest.as_bytes()));
        assert_eq!(text, vec!["Hel", "lo"]);
        let r = p.finish().unwrap();
        assert_eq!(r.content, "Hello");
        assert_eq!(r.calls.len(), 1);
        assert_eq!(r.calls[0].name, "read_guide");
        assert_eq!(r.calls[0].id.as_deref(), Some("c1"));
        assert_eq!(r.calls[0].arguments, json!("{\"name\":\"ltx\"}"));
    }

    #[test]
    fn ollama_stream_assembles_text_tool_calls_and_length_stop() {
        let mut p = StreamParser::new(true);
        let nd = concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"A \"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"search_tags\",\"arguments\":{\"query\":\"boots\"}}}]},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"b\"},\"done\":true,\"done_reason\":\"length\"}",
        );
        let mut text = p.feed(nd.as_bytes());
        let r = {
            text.extend(std::iter::empty::<String>());
            p.finish().unwrap()
        };
        assert_eq!(text, vec!["A "]);
        assert_eq!(r.content, "A b");
        assert!(r.truncated);
        assert_eq!(r.calls[0].arguments, json!({ "query": "boots" }));
        assert!(StreamParser::new(false).finish().is_err());
    }

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
