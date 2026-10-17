//! Model-family detection driven by the data-only family plugin `src/families/builtin.json`
//! (shared with the frontend, which reads loaders, pipelines and defaults from it). Like SwarmUI's
//! class sorter it reads only the safetensors header: `modelspec.architecture` first, then key
//! signatures; the cached CivitAI base model is the fallback for other formats.
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

/// Headers of large quantized checkpoints stay well below this; anything bigger is not trusted.
const MAX_HEADER: u64 = 64 << 20;

#[derive(Deserialize)]
struct Family {
    id: String,
    architectures: Vec<String>,
    bases: Vec<String>,
    model: Vec<Vec<String>>,
    lora: Vec<Vec<String>>,
    /// Lowercase file-name substrings for variants that share a header with their base
    /// (Qwen Image 2.1 Turbo declares the same architecture as the base model).
    #[serde(default, rename = "fileMatch")]
    file_match: Vec<String>,
}

fn families() -> &'static [Family] {
    static FAMILIES: OnceLock<Vec<Family>> = OnceLock::new();
    FAMILIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/families/builtin.json"))
            .expect("bundled family plugin is valid")
    })
}

/// Header keys joined with `_` folded to `.`, so Kohya, diffusers and Comfy spellings of the
/// same tensor match one signature, plus the lowercased declared architecture.
fn header(path: &Path) -> Option<(String, String)> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut len = [0u8; 8];
    file.read_exact(&mut len).ok()?;
    let len = u64::from_le_bytes(len);
    if len > MAX_HEADER {
        return None;
    }
    let mut buf = vec![0; len as usize];
    file.read_exact(&mut buf).ok()?;
    let head: serde_json::Map<String, Value> = serde_json::from_slice(&buf).ok()?;
    let arch = head
        .get("__metadata__")
        .and_then(|m| m.get("modelspec.architecture"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    Some((
        head.keys()
            .map(|k| k.replace('_', "."))
            .collect::<Vec<_>>()
            .join("\n"),
        arch,
    ))
}

/// Family ID of a model (`checkpoints`, `diffusion_models`, `unet`) or LoRA file; `None` = unknown.
pub fn detect(category: &str, path: &Path, base: Option<&str>) -> Option<String> {
    let lora = category == "loras";
    if !lora && !["checkpoints", "diffusion_models", "unet"].contains(&category) {
        return None;
    }
    let file = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // File-name variants never claim LoRAs: those stay with the base family they were trained on.
    let all: Vec<&Family> = families()
        .iter()
        .filter(|f| {
            f.file_match.is_empty() || (!lora && f.file_match.iter().any(|s| file.contains(s)))
        })
        .collect();
    let safetensors = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["safetensors", "sft"].contains(&e.to_ascii_lowercase().as_str()));
    let by_header = safetensors
        .then(|| header(path))
        .flatten()
        .and_then(|(keys, arch)| {
            let declared = !arch.is_empty();
            all.iter()
                .find(|f| declared && f.architectures.iter().any(|a| arch.starts_with(a.as_str())))
                .or_else(|| {
                    all.iter().find(|f| {
                        (if lora { &f.lora } else { &f.model })
                            .iter()
                            .any(|signature| {
                                signature
                                    .iter()
                                    .all(|s| keys.contains(&s.replace('_', ".")))
                            })
                    })
                })
        });
    by_header
        .or_else(|| {
            base.and_then(|b| {
                all.iter()
                    .find(|f| f.bases.iter().any(|x| x.eq_ignore_ascii_case(b)))
            })
        })
        .map(|f| f.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, header: Value) -> std::path::PathBuf {
        let text = header.to_string();
        let mut bytes = (text.len() as u64).to_le_bytes().to_vec();
        bytes.extend(text.as_bytes());
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn detects_by_architecture_signature_and_base() {
        let dir = tempfile::tempdir().unwrap();
        let t = serde_json::json!({"dtype":"BF16","shape":[1],"data_offsets":[0,2]});
        let krea = write(
            dir.path(),
            "k.safetensors",
            serde_json::json!({"model.diffusion_model.txtfusion.projector.weight":t,"model.diffusion_model.blocks.0.attn.gate.weight":t}),
        );
        assert_eq!(
            detect("diffusion_models", &krea, None).as_deref(),
            Some("krea-2")
        );
        // Kohya spelling (`_` instead of `.`) of an Anima LoRA.
        let anima = write(
            dir.path(),
            "a.safetensors",
            serde_json::json!({"lora_unet_blocks_27_cross_attn_output_proj.lora_up.weight":t}),
        );
        assert_eq!(detect("loras", &anima, None).as_deref(), Some("anima"));
        let declared = write(
            dir.path(),
            "d.safetensors",
            serde_json::json!({"__metadata__":{"modelspec.architecture":"MiniMax-H3/lora"},"x":t}),
        );
        assert_eq!(
            detect("loras", &declared, None).as_deref(),
            Some("minimax-h3")
        );
        // Turbo shares the base header; only the file name tells them apart, and LoRAs stay with the base.
        let q =
            serde_json::json!({"__metadata__":{"modelspec.architecture":"qwen-image-2.1"},"x":t});
        let turbo = write(
            dir.path(),
            "qwen21TurboOfficial_bf16.safetensors",
            q.clone(),
        );
        assert_eq!(
            detect("diffusion_models", &turbo, None).as_deref(),
            Some("qwen-image-2.1-turbo")
        );
        let base = write(dir.path(), "qwen_image_2.1_int8.safetensors", q.clone());
        assert_eq!(
            detect("diffusion_models", &base, None).as_deref(),
            Some("qwen-image-2.1")
        );
        let lora = write(dir.path(), "turbo-style.safetensors", q);
        assert_eq!(
            detect("loras", &lora, None).as_deref(),
            Some("qwen-image-2.1")
        );
        let unknown = write(dir.path(), "u.safetensors", serde_json::json!({"x":t}));
        // "turbo" alone never makes a Qwen Turbo: the header (or CivitAI base) must match too.
        let sdxl_turbo = write(
            dir.path(),
            "sdxl_turbo.safetensors",
            serde_json::json!({"conditioner.embedders.1.model.ln_final.weight":t}),
        );
        assert_eq!(
            detect("checkpoints", &sdxl_turbo, None).as_deref(),
            Some("sdxl")
        );
        let odd_turbo = write(dir.path(), "turbo.safetensors", serde_json::json!({"x":t}));
        assert_eq!(
            detect("checkpoints", &odd_turbo, Some("SDXL Turbo")).as_deref(),
            Some("sdxl")
        );
        assert_eq!(detect("checkpoints", &odd_turbo, None), None);
        assert_eq!(detect("checkpoints", &unknown, None), None);
        assert_eq!(
            detect("checkpoints", &unknown, Some("illustrious")).as_deref(),
            Some("sdxl")
        );
        assert_eq!(detect("vae", &krea, None), None);
        let huge = dir.path().join("h.safetensors");
        std::fs::write(&huge, (MAX_HEADER + 1).to_le_bytes()).unwrap();
        assert_eq!(detect("checkpoints", &huge, None), None);
    }

    /// `DEAS_LIVE_MODELS=<models root> cargo test --lib live_family_scan -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_family_scan() {
        let root = std::env::var("DEAS_LIVE_MODELS").expect("DEAS_LIVE_MODELS");
        let started = std::time::Instant::now();
        let models = crate::downloads::models::scan(Path::new(&root)).unwrap();
        for m in models.iter().filter(|m| {
            ["checkpoints", "diffusion_models", "unet", "loras"].contains(&m.category.as_str())
        }) {
            println!(
                "{:<17} {:<16} {}",
                m.category,
                m.family.as_deref().unwrap_or("-"),
                m.name
            );
        }
        println!("{} files in {:?}", models.len(), started.elapsed());
    }
}
