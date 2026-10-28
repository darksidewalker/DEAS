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
    #[serde(default)]
    forge: Option<String>,
    #[serde(default, rename = "clipType")]
    clip_type: Option<String>,
    #[serde(default)]
    multiple: Option<u64>,
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

pub(crate) fn prompt_forge_target(name: &str) -> Option<&'static str> {
    let name = name.trim();
    families()
        .iter()
        .find(|f| {
            f.id.eq_ignore_ascii_case(name)
                || f.forge
                    .as_deref()
                    .is_some_and(|v| v.eq_ignore_ascii_case(name))
                || f.bases.iter().any(|v| v.eq_ignore_ascii_case(name))
        })?
        .forge
        .as_deref()
}

pub(crate) fn image_multiple(clip_type: &str) -> Option<u64> {
    families()
        .iter()
        .find(|f| f.clip_type.as_deref() == Some(clip_type))?
        .multiple
}

fn read_header(path: &Path) -> Option<(serde_json::Map<String, Value>, u64)> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut len = [0u8; 8];
    file.read_exact(&mut len).ok()?;
    let len = u64::from_le_bytes(len);
    if len > MAX_HEADER || len > meta.len().checked_sub(8)? {
        return None;
    }
    let mut buf = vec![0; len as usize];
    file.read_exact(&mut buf).ok()?;
    Some((serde_json::from_slice(&buf).ok()?, meta.len() - 8 - len))
}

/// Header keys joined with `_` folded to `.`, preserving the existing main-family policy.
fn header(path: &Path) -> Option<(String, String)> {
    let (head, _) = read_header(path)?;
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

/// Validate tensor descriptors and payload bounds without reading any weight bytes.
fn valid_tensors(head: &serde_json::Map<String, Value>, payload: u64) -> Option<()> {
    let mut ranges = Vec::new();
    for (key, tensor) in head {
        if key == "__metadata__" {
            if !tensor.as_object()?.values().all(Value::is_string) {
                return None;
            }
            continue;
        }
        let width = match tensor.get("dtype")?.as_str()? {
            "BOOL" | "U8" | "I8" | "F8_E4M3" | "F8_E5M2" | "F8_E4M3FN" => 1,
            "BF16" | "F16" | "I16" | "U16" => 2,
            "F32" | "I32" | "U32" => 4,
            "F64" | "I64" | "U64" => 8,
            _ => return None,
        };
        let shape = tensor.get("shape")?.as_array()?;
        if shape.len() > 8 {
            return None;
        }
        let bytes = shape
            .iter()
            .try_fold(width, |n: u64, d| n.checked_mul(d.as_u64()?))?;
        let offsets = tensor.get("data_offsets")?.as_array()?;
        if offsets.len() != 2 {
            return None;
        }
        let (start, end) = (offsets[0].as_u64()?, offsets[1].as_u64()?);
        if end.checked_sub(start)? != bytes || end > payload {
            return None;
        }
        ranges.push((start, end));
    }
    ranges.sort_unstable();
    let mut end = 0;
    for (start, next) in ranges {
        if start != end {
            return None;
        }
        end = next;
    }
    (end == payload).then_some(())
}

fn safetensors(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["safetensors", "sft"].contains(&e.to_ascii_lowercase().as_str()))
}

/// Stable companion architecture ID, not a model-family or inference-readiness claim.
/// Evidence: ComfyUI b1a247c9 comfy/sd.py, text_encoders/{llama,qwen3vl,lt}.py,
/// umt5_config_xxl.json, ldm/wan/{vae,vae2_2}.py and lightricks/vae/audio_vae.py;
/// local headers corroborate shapes.
/// shortcut: packed weights/other architectures stay unknown; add signatures only with evidence.
pub fn detect_component(category: &str, path: &Path) -> Option<&'static str> {
    if !["text_encoders", "clip", "vae"].contains(&category) || !safetensors(path) {
        return None;
    }
    let (head, payload) = read_header(path)?;
    valid_tensors(&head, payload)?;
    let shape = |key: &str, expected: &[u64]| {
        head.get(key)
            .and_then(|v| v.get("shape"))
            .and_then(Value::as_array)
            .is_some_and(|s| {
                s.len() == expected.len()
                    && s.iter().zip(expected).all(|(v, d)| v.as_u64() == Some(*d))
            })
    };
    if category == "vae" {
        // Flux2 packs a 32-channel spatial VAE into 128-channel /16 latents (comfy/sd.py).
        if shape("encoder.conv_in.weight", &[128, 3, 3, 3])
            && shape("decoder.conv_in.weight", &[512, 32, 3, 3])
            && shape("decoder.conv_out.weight", &[3, 128, 3, 3])
            && shape("encoder.quant_conv.weight", &[64, 64, 1, 1])
            && shape("bn.running_mean", &[128])
            && shape("bn.running_var", &[128])
        {
            return Some("flux2-vae");
        }
        // Wan 2.1 and original Qwen Image share this architecture; do not invent separate IDs.
        if shape("conv2.weight", &[16, 16, 1, 1, 1])
            && shape("encoder.conv1.weight", &[96, 3, 3, 3, 3])
            && shape("decoder.conv1.weight", &[384, 16, 3, 3, 3])
            && shape("decoder.middle.0.residual.0.gamma", &[384, 1, 1, 1])
            && shape("decoder.head.2.weight", &[3, 96, 3, 3, 3])
            && !head.contains_key("decoder.upsamples.0.upsamples.0.residual.2.weight")
        {
            return Some("wan-2.1-vae");
        }
        if shape("conv2.weight", &[64, 64, 1, 1, 1])
            && shape("encoder.conv1.weight", &[96, 4, 1, 3, 3])
            && shape("decoder.conv1.weight", &[1152, 64, 1, 3, 3])
            && shape("decoder.middle.0.residual.0.gamma", &[1152, 1, 1, 1])
            && shape("decoder.head.2.weight", &[4, 144, 1, 3, 3])
            && head.contains_key("decoder.upsamples.0.upsamples.0.residual.2.weight")
        {
            return Some("qwen-image-2.1-vae");
        }
        for prefix in ["audio_vae.", "autoencoder."] {
            if shape(
                &format!("{prefix}encoder.conv_in.conv.weight"),
                &[128, 2, 3, 3],
            ) && shape(
                &format!("{prefix}decoder.conv_in.conv.weight"),
                &[512, 8, 3, 3],
            ) && shape(
                &format!("{prefix}decoder.conv_out.conv.weight"),
                &[2, 128, 3, 3],
            ) && shape(
                &format!("{prefix}per_channel_statistics.mean-of-means"),
                &[128],
            ) && (shape(
                "vocoder.vocoder.resblocks.0.convs1.0.weight",
                &[768, 768, 3],
            ) || shape("vocoder.resblocks.0.convs1.0.weight", &[768, 768, 3]))
            {
                return Some("ltx-2.3-audio-vae");
            }
        }
        return None;
    }
    // Qwen3.5-9B hybrid linear/full attention, as selected by MOSS_IMAGE in comfy/sd.py.
    if shape("model.language_model.embed_tokens.weight", &[248320, 4096])
        && shape(
            "model.language_model.layers.0.input_layernorm.weight",
            &[4096],
        )
        && shape("model.language_model.layers.0.linear_attn.A_log", &[32])
        && shape(
            "model.language_model.layers.0.linear_attn.in_proj_qkv.weight",
            &[8192, 4096],
        )
        && shape(
            "model.language_model.layers.31.self_attn.q_proj.weight",
            &[8192, 4096],
        )
        && shape(
            "model.language_model.layers.31.mlp.up_proj.weight",
            &[12288, 4096],
        )
    {
        return Some("qwen3.5-9b");
    }
    // Both raw HF and ComfyUI's flattened Qwen3-VL text prefixes occur in local exports.
    for prefix in ["model.", "model.language_model."] {
        let at = |key: &str, dims: &[u64]| shape(&format!("{prefix}{key}"), dims);
        for (id, hidden, q, intermediate, visual) in [
            ("qwen3-0.6b", 1024, 2048, 3072, None),
            ("qwen3-vl-4b", 2560, 4096, 9728, Some(4096)),
            ("qwen3-vl-8b", 4096, 4096, 12288, Some(4608)),
        ] {
            let last = if visual.is_some() { 35 } else { 27 };
            if !at("embed_tokens.weight", &[151936, hidden])
                || !at("layers.0.post_attention_layernorm.weight", &[hidden])
                || !at("layers.0.self_attn.q_norm.weight", &[128])
                || !at("layers.0.self_attn.q_proj.weight", &[q, hidden])
                || !at(
                    &format!("layers.{last}.mlp.up_proj.weight"),
                    &[intermediate, hidden],
                )
            {
                continue;
            }
            if let Some(visual) = visual {
                if !shape(
                    "model.visual.deepstack_merger_list.0.norm.weight",
                    &[visual],
                ) || !shape("model.visual.merger.linear_fc2.weight", &[hidden, visual])
                {
                    continue;
                }
            } else if head
                .keys()
                .any(|k| k.contains("visual.") || k.starts_with("model.layers.28."))
            {
                continue;
            }
            return Some(id);
        }
    }
    if shape("shared.weight", &[256384, 4096])
        && shape(
            "encoder.block.0.layer.0.SelfAttention.k.weight",
            &[4096, 4096],
        )
        && shape(
            "encoder.block.23.layer.1.DenseReluDense.wi_1.weight",
            &[10240, 4096],
        )
    {
        return Some("umt5-xxl");
    }
    if shape(
        "text_embedding_projection.audio_aggregate_embed.weight",
        &[2048, 188160],
    ) && shape(
        "text_embedding_projection.audio_aggregate_embed.bias",
        &[2048],
    ) && shape(
        "text_embedding_projection.video_aggregate_embed.weight",
        &[4096, 188160],
    ) && shape(
        "text_embedding_projection.video_aggregate_embed.bias",
        &[4096],
    ) {
        return Some("ltx-2.3-text-projection");
    }
    None
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
    let by_header = safetensors(path)
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

    #[test]
    fn moss_identity_requires_both_model_signature_keys() {
        let dir = tempfile::tempdir().unwrap();
        let keys = [
            "shared_block_modulation.weight",
            "layers.0.proj.ffn_up_gate.weight",
        ];
        let both = serde_json::json!({keys[0]:{}, keys[1]:{}});
        let path = write(dir.path(), "renamed.safetensors", both.clone());
        assert_eq!(
            detect("diffusion_models", &path, None).as_deref(),
            Some("moss-image")
        );
        assert_eq!(detect("loras", &path, None), None);
        for key in keys {
            let mut partial = both.clone();
            partial.as_object_mut().unwrap().remove(key);
            let path = write(dir.path(), "mossImage_sft_bf16.safetensors", partial);
            assert_eq!(detect("diffusion_models", &path, None), None);
        }
    }

    type Signature<'a> = &'a [(&'a str, &'a [u64])];

    // Sparse payloads exercise real header/offset validation without allocating model weights.
    fn component_file(dir: &Path, name: &str, tensors: Signature<'_>) -> std::path::PathBuf {
        let mut head = serde_json::Map::new();
        let mut end = 0;
        for (key, shape) in tensors {
            let start = end;
            end += shape.iter().product::<u64>() * 2;
            head.insert(
                (*key).into(),
                serde_json::json!({"dtype":"BF16", "shape":shape, "data_offsets":[start,end]}),
            );
        }
        let path = write(dir, name, Value::Object(head));
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(file.metadata().unwrap().len() + end).unwrap();
        path
    }

    #[test]
    fn moss_companions_identify_unpacked_architectures_not_packed_weights() {
        let dir = tempfile::tempdir().unwrap();
        let qwen: Signature<'_> = &[
            ("model.language_model.embed_tokens.weight", &[248320, 4096]),
            (
                "model.language_model.layers.0.input_layernorm.weight",
                &[4096],
            ),
            ("model.language_model.layers.0.linear_attn.A_log", &[32]),
            (
                "model.language_model.layers.0.linear_attn.in_proj_qkv.weight",
                &[8192, 4096],
            ),
            (
                "model.language_model.layers.31.self_attn.q_proj.weight",
                &[8192, 4096],
            ),
            (
                "model.language_model.layers.31.mlp.up_proj.weight",
                &[12288, 4096],
            ),
        ];
        let vae: Signature<'_> = &[
            ("encoder.conv_in.weight", &[128, 3, 3, 3]),
            ("decoder.conv_in.weight", &[512, 32, 3, 3]),
            ("decoder.conv_out.weight", &[3, 128, 3, 3]),
            ("encoder.quant_conv.weight", &[64, 64, 1, 1]),
            ("bn.running_mean", &[128]),
            ("bn.running_var", &[128]),
        ];
        for (category, id, signature) in [("clip", "qwen3.5-9b", qwen), ("vae", "flux2-vae", vae)] {
            let path = component_file(dir.path(), "renamed.safetensors", signature);
            assert_eq!(detect_component(category, &path), Some(id));
            for n in 0..signature.len() {
                let mut wrong = signature.to_vec();
                wrong[n].1 = &[1];
                let path = component_file(dir.path(), "mossImage_sft_txt_int4.safetensors", &wrong);
                assert_eq!(
                    detect_component(category, &path),
                    None,
                    "{}",
                    signature[n].0
                );
            }
        }
        let mut packed = qwen.to_vec();
        packed[3].1 = &[8192, 2048];
        packed[4].1 = &[8192, 2048];
        packed[5].1 = &[12288, 2048];
        let path = component_file(dir.path(), "qwen3.5_9b.safetensors", &packed);
        assert_eq!(detect_component("text_encoders", &path), None);
    }

    const QWEN_06: &[(&str, &[u64])] = &[
        ("model.embed_tokens.weight", &[151936, 1024]),
        ("model.layers.0.post_attention_layernorm.weight", &[1024]),
        ("model.layers.0.self_attn.q_norm.weight", &[128]),
        ("model.layers.0.self_attn.q_proj.weight", &[2048, 1024]),
        ("model.layers.27.mlp.up_proj.weight", &[3072, 1024]),
    ];

    #[test]
    fn companion_detection_ignores_renaming_and_category_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let path = component_file(dir.path(), "qwen_3_600m.safetensors", QWEN_06);
        assert_eq!(detect_component("text_encoders", &path), Some("qwen3-0.6b"));
        let renamed = dir
            .path()
            .join("dasiwaAnima_luminousLabyrinthV1_txt.safetensors");
        std::fs::rename(path, &renamed).unwrap();
        assert_eq!(detect_component("clip", &renamed), Some("qwen3-0.6b"));
        assert_eq!(detect_component("vae", &renamed), None);
        assert_eq!(detect_component("loras", &renamed), None);
        assert_eq!(detect("text_encoders", &renamed, Some("Anima")), None);
        let wrong_format = renamed.with_extension("pt");
        std::fs::rename(renamed, &wrong_format).unwrap();
        assert_eq!(detect_component("clip", &wrong_format), None);
    }

    #[test]
    fn companion_detection_rejects_wrong_shapes_unknown_and_malformed_headers() {
        let dir = tempfile::tempdir().unwrap();
        for (key, _) in QWEN_06 {
            let mut tensors = QWEN_06.to_vec();
            tensors.iter_mut().find(|(k, _)| k == key).unwrap().1 = &[1];
            let path = component_file(dir.path(), "qwen_3_600m.safetensors", &tensors);
            assert_eq!(detect_component("text_encoders", &path), None, "{key}");
        }
        let path = component_file(dir.path(), "unknown.sft", &[("random.weight", &[1024])]);
        assert_eq!(detect_component("text_encoders", &path), None);
        let path = component_file(dir.path(), "truncated.safetensors", QWEN_06);
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(file.metadata().unwrap().len() - 1).unwrap();
        assert_eq!(detect_component("text_encoders", &path), None);
        for head in [
            serde_json::json!({"x":{"shape":[1],"dtype":"BF16","data_offsets":[2,0]}}),
            serde_json::json!({"x":{"shape":[u64::MAX,2],"dtype":"BF16","data_offsets":[0,0]}}),
            serde_json::json!({"x":{"shape":[-1],"dtype":"BF16","data_offsets":[0,0]}}),
            serde_json::json!({"x":{"shape":[1],"dtype":"BAD","data_offsets":[0,2]}}),
            serde_json::json!({"model.layers.0.self_attn.q_norm.weight":{}}),
        ] {
            let path = write(dir.path(), "bad.safetensors", head);
            assert_eq!(detect_component("text_encoders", &path), None);
        }
        for bytes in [
            vec![],
            vec![0; 7],
            (MAX_HEADER + 1).to_le_bytes().to_vec(),
            [8u64.to_le_bytes().as_slice(), b"{"].concat(),
        ] {
            let path = dir.path().join("bad.sft");
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(detect_component("clip", &path), None);
        }
    }

    #[test]
    fn companion_tensor_validation_rejects_bad_descriptors_and_overlaps() {
        let tensor = serde_json::json!({"dtype":"BF16","shape":[2],"data_offsets":[0,4]});
        let valid = serde_json::json!({"a":tensor});
        assert_eq!(valid_tensors(valid.as_object().unwrap(), 4), Some(()));
        for (field, bad) in [
            ("shape", serde_json::json!([-1])),
            ("shape", serde_json::json!([u64::MAX, 2])),
            ("shape", serde_json::json!([1, 1, 1, 1, 1, 1, 1, 1, 1])),
            ("dtype", serde_json::json!("unknown")),
            ("data_offsets", serde_json::json!([4, 0])),
            ("data_offsets", serde_json::json!([0, 2])),
            ("data_offsets", serde_json::json!([0, 4, 4])),
            ("data_offsets", serde_json::json!([4, 8])),
        ] {
            let mut head = valid.clone();
            head["a"][field] = bad;
            assert_eq!(valid_tensors(head.as_object().unwrap(), 4), None, "{field}");
        }
        for bad in [serde_json::json!(0), serde_json::json!({"config":7})] {
            let mut head = valid.clone();
            head["__metadata__"] = bad;
            assert_eq!(valid_tensors(head.as_object().unwrap(), 4), None);
        }
        let overlap = serde_json::json!({"a":tensor,"b":tensor});
        assert_eq!(valid_tensors(overlap.as_object().unwrap(), 4), None);
        assert_eq!(valid_tensors(valid.as_object().unwrap(), 5), None);
    }

    #[test]
    fn companion_signatures_discriminate_architectures_and_export_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        for prefix in ["model.", "model.language_model."] {
            for (id, hidden, mlp, visual) in [
                ("qwen3-vl-4b", 2560, 9728, 4096),
                ("qwen3-vl-8b", 4096, 12288, 4608),
            ] {
                let keys = [
                    "embed_tokens.weight",
                    "layers.0.post_attention_layernorm.weight",
                    "layers.0.self_attn.q_norm.weight",
                    "layers.0.self_attn.q_proj.weight",
                    "layers.35.mlp.up_proj.weight",
                ]
                .map(|k| format!("{prefix}{k}"));
                let dims = [
                    vec![151936, hidden],
                    vec![hidden],
                    vec![128],
                    vec![4096, hidden],
                    vec![mlp, hidden],
                ];
                let mut tensors: Vec<_> = keys
                    .iter()
                    .zip(&dims)
                    .map(|(k, s)| (k.as_str(), s.as_slice()))
                    .collect();
                let norm = [visual];
                let merger = [hidden, visual];
                tensors.push(("model.visual.deepstack_merger_list.0.norm.weight", &norm));
                tensors.push(("model.visual.merger.linear_fc2.weight", &merger));
                let path = component_file(dir.path(), "renamed.sft", &tensors);
                assert_eq!(detect_component("text_encoders", &path), Some(id));
                tensors.pop();
                let path = component_file(dir.path(), "qwen3vl_4b.safetensors", &tensors);
                assert_eq!(detect_component("text_encoders", &path), None);
            }
        }
        let cases: &[(&str, &str, Signature<'_>)] = &[
            (
                "vae",
                "wan-2.1-vae",
                &[
                    ("conv2.weight", &[16, 16, 1, 1, 1]),
                    ("encoder.conv1.weight", &[96, 3, 3, 3, 3]),
                    ("decoder.conv1.weight", &[384, 16, 3, 3, 3]),
                    ("decoder.middle.0.residual.0.gamma", &[384, 1, 1, 1]),
                    ("decoder.head.2.weight", &[3, 96, 3, 3, 3]),
                ],
            ),
            (
                "vae",
                "qwen-image-2.1-vae",
                &[
                    ("conv2.weight", &[64, 64, 1, 1, 1]),
                    ("encoder.conv1.weight", &[96, 4, 1, 3, 3]),
                    ("decoder.conv1.weight", &[1152, 64, 1, 3, 3]),
                    ("decoder.middle.0.residual.0.gamma", &[1152, 1, 1, 1]),
                    ("decoder.head.2.weight", &[4, 144, 1, 3, 3]),
                    ("decoder.upsamples.0.upsamples.0.residual.2.weight", &[1]),
                ],
            ),
            (
                "text_encoders",
                "umt5-xxl",
                &[
                    ("shared.weight", &[256384, 4096]),
                    (
                        "encoder.block.0.layer.0.SelfAttention.k.weight",
                        &[4096, 4096],
                    ),
                    (
                        "encoder.block.23.layer.1.DenseReluDense.wi_1.weight",
                        &[10240, 4096],
                    ),
                ],
            ),
            (
                "vae",
                "ltx-2.3-audio-vae",
                &[
                    ("audio_vae.encoder.conv_in.conv.weight", &[128, 2, 3, 3]),
                    ("audio_vae.decoder.conv_in.conv.weight", &[512, 8, 3, 3]),
                    ("audio_vae.decoder.conv_out.conv.weight", &[2, 128, 3, 3]),
                    ("audio_vae.per_channel_statistics.mean-of-means", &[128]),
                    (
                        "vocoder.vocoder.resblocks.0.convs1.0.weight",
                        &[768, 768, 3],
                    ),
                ],
            ),
            (
                "text_encoders",
                "ltx-2.3-text-projection",
                &[
                    (
                        "text_embedding_projection.audio_aggregate_embed.weight",
                        &[2048, 188160],
                    ),
                    (
                        "text_embedding_projection.audio_aggregate_embed.bias",
                        &[2048],
                    ),
                    (
                        "text_embedding_projection.video_aggregate_embed.weight",
                        &[4096, 188160],
                    ),
                    (
                        "text_embedding_projection.video_aggregate_embed.bias",
                        &[4096],
                    ),
                ],
            ),
        ];
        for (category, id, tensors) in cases {
            let path = component_file(dir.path(), "unrelated-name.safetensors", tensors);
            assert_eq!(detect_component(category, &path), Some(*id));
            assert_eq!(
                detect_component(if *category == "vae" { "clip" } else { "vae" }, &path),
                None
            );
            for i in 0..tensors.len() {
                let mut wrong = tensors.to_vec();
                wrong[i].1 = &[2];
                let path = component_file(dir.path(), "familiar-name.safetensors", &wrong);
                // The Wan 2.2 layout marker is a presence guard, not a learned weight signature.
                if !wrong[i].0.contains("upsamples.0.upsamples") {
                    assert_eq!(
                        detect_component(category, &path),
                        None,
                        "{id}: {}",
                        wrong[i].0
                    );
                }
            }
        }
    }

    /// `DEAS_LIVE_MODELS=<models root> cargo test --lib live_family_scan -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_family_scan() {
        let root = std::env::var("DEAS_LIVE_MODELS").expect("DEAS_LIVE_MODELS");
        let started = std::time::Instant::now();
        let models = crate::downloads::models::scan(Path::new(&root)).unwrap();
        for m in models.iter().filter(|m| {
            [
                "checkpoints",
                "diffusion_models",
                "unet",
                "loras",
                "text_encoders",
                "clip",
                "vae",
            ]
            .contains(&m.category.as_str())
        }) {
            println!(
                "{:<17} {:<28} {}",
                m.category,
                m.component
                    .as_deref()
                    .or(m.family.as_deref())
                    .unwrap_or("-"),
                m.name
            );
        }
        println!("{} files in {:?}", models.len(), started.elapsed());
    }
}
