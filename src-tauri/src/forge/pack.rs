//! The Forge data pack: PromptForge's composed system prompts, segment blocks,
//! tool definitions, guidance documents and registry settings for the image
//! models, exported by PromptForge's own loaders so the text is exactly what
//! PromptForge sends. Read once per write; it is a small JSON file.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

pub const SEPARATOR: &str = "\n\n---\n\n";

#[derive(Debug, Deserialize)]
pub struct Pack {
    pub source: Value,
    #[serde(default)]
    pub creativity_order: Vec<String>,
    pub config: Value,
    pub defaults: Value,
    pub shared: Shared,
    pub models: HashMap<String, PackModel>,
}

#[derive(Debug, Deserialize)]
pub struct Shared {
    #[serde(default)]
    pub meta_segment: Option<String>,
    #[serde(default)]
    pub tag_search: Option<String>,
    #[serde(default)]
    pub guidance: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PackModel {
    pub entry: Value,
    pub system: String,
    #[serde(default)]
    pub system_by_mode: HashMap<String, String>,
    #[serde(default)]
    pub segment_blocks: HashMap<String, String>,
    #[serde(default)]
    pub guidance_tool: Vec<Value>,
    #[serde(default)]
    pub guidance_docs: HashMap<String, String>,
    #[serde(default)]
    pub search_tool: Vec<Value>,
}

impl Pack {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| {
            format!(
                "Prompt Forge data pack unavailable ({}): {e}",
                path.display()
            )
        })?;
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("Prompt Forge data pack is invalid: {e}"))
    }
}

impl PackModel {
    pub fn str(&self, key: &str) -> Option<&str> {
        self.entry.get(key).and_then(Value::as_str)
    }
    pub fn strings(&self, key: &str) -> Vec<String> {
        self.entry
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn flag(&self, key: &str) -> bool {
        self.entry
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
    /// `tag_style: space|underscore` marks the booru models.
    pub fn tag_style(&self) -> Option<&str> {
        self.str("tag_style")
    }
    pub fn modes(&self) -> Vec<String> {
        self.strings("modes")
    }
    /// The contract for this mode: `segments_by_mode`, else `segments`.
    pub fn expected(&self, mode: Option<&str>) -> Vec<String> {
        mode.and_then(|m| {
            self.entry
                .get("segments_by_mode")?
                .get(m)?
                .as_array()
                .cloned()
        })
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_else(|| self.strings("segments"))
    }
    pub fn system_for(&self, mode: Option<&str>) -> &str {
        mode.and_then(|m| self.system_by_mode.get(m))
            .map_or(self.system.as_str(), String::as_str)
    }
    /// What a person may switch off: the explaining segments and the negative.
    pub fn optional(&self) -> Vec<String> {
        let mut out = self.strings("meta_segments");
        if self.entry.get("has_negative").and_then(Value::as_bool) != Some(false) {
            out.extend(
                self.strings("segments")
                    .into_iter()
                    .filter(|l| l.to_lowercase().contains("negative")),
            );
        }
        out.dedup();
        out
    }
}

/// `prompts.segmentTail`: the contract list, the shared note before the first
/// explaining segment, then each segment's own block.
pub fn segment_tail(pack: &Pack, model: &PackModel, labels: &[String]) -> String {
    if labels.is_empty() {
        return String::new();
    }
    let list = labels
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{}. `{l}`", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let mut parts = vec![format!("## Segments to emit\n\n{list}")];
    let meta = model.strings("meta_segments");
    let mut meta_done = false;
    for label in labels {
        if meta.contains(label) && !meta_done {
            if let Some(shared) = pack
                .shared
                .meta_segment
                .as_deref()
                .filter(|s| !s.is_empty())
            {
                parts.push(shared.to_string());
            }
            meta_done = true;
        }
        if let Some(block) = model.segment_blocks.get(label).filter(|b| !b.is_empty()) {
            parts.push(block.clone());
        }
    }
    parts.join(SEPARATOR)
}
