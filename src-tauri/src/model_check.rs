//! Decisions over inspected facts; no model I/O, hashing, provider calls or execution permission.
use crate::downloads::models::LocalModel;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCheck {
    pub identity: &'static str,
    pub integrity: &'static str,
    pub compatibility: &'static str,
    pub availability: &'static str,
    pub evidence: Vec<String>,
    pub reasons: Vec<Reason>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Reason {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ModelCheck {
    fn block(&mut self, code: &'static str, detail: Option<String>) {
        self.compatibility = "blocked";
        self.reasons.push(Reason { code, detail });
    }
}

pub(crate) fn describe(
    model: &LocalModel,
    header_family: Option<&str>,
    provider_family: Option<&str>,
    structural_integrity: Option<bool>,
) -> ModelCheck {
    let mut check = ModelCheck {
        identity: if model.info.is_some() {
            "sha256"
        } else {
            "unverified"
        },
        integrity: match structural_integrity {
            Some(true) => "headerChecked",
            Some(false) => "broken",
            None => "unchecked",
        },
        compatibility: "unknown",
        availability: "available",
        evidence: vec![],
        reasons: vec![],
    };
    if model.info.is_some() {
        check.evidence.push("sha256".into());
    }
    if header_family.is_some() {
        check.evidence.push("header".into());
    }
    if provider_family.is_some() {
        check.evidence.push("provider".into());
    }
    if model.component.is_some() {
        check.evidence.push("component".into());
    }
    if model.family_override.is_some() {
        check.evidence.push("declaration".into());
    }
    if let Some(error) = &model.metadata_error {
        check.block("metadata", Some(error.clone()));
    }
    if let Some(error) = &model.integrity {
        check.block("integrity", Some(error.clone()));
    }
    if header_family
        .zip(provider_family)
        .is_some_and(|(h, p)| !crate::model_families::structurally_compatible(h, p))
        || model
            .family_override
            .as_deref()
            .zip(header_family)
            .is_some_and(|(d, h)| !crate::model_families::structurally_compatible(d, h))
        || model
            .family_override
            .as_deref()
            .zip(provider_family)
            .is_some_and(|(d, p)| !crate::model_families::structurally_compatible(d, p))
        || model.family_evidence == Some(crate::model_families::FamilyEvidence::Conflict)
    {
        check.block(
            "conflict",
            Some("Structural, identity or declaration evidence disagree".into()),
        );
    }
    if model.misplaced_all_in_one {
        check.block(
            "component",
            Some("All-in-one checkpoint requires the checkpoints namespace".into()),
        );
    }
    // Inspection alone cannot prove a recipe's loaders or companions are available.
    if check.compatibility == "unknown" {
        check.reasons.push(Reason {
            code: "unverified",
            detail: Some("Recipe compatibility requires selected-model and backend checks".into()),
        });
    }
    check
}

/// Registered backend fields only; absent files remain backend authority.
pub(crate) fn categories(field: &str) -> &'static [&'static str] {
    match field {
        "checkpoints" => &["checkpoints"],
        "diffusionModels" | "ggufDiffusionModels" => &["diffusion_models", "unet"],
        "loras" => &["loras"],
        "textEncoders" | "dualTextEncoders" | "ggufTextEncoders" | "ggufDualTextEncoders" => {
            &["text_encoders", "clip"]
        }
        "vaes" | "audioVaes" => &["vae"],
        "textProjections" => &["text_encoders", "clip"],
        "visionModels" => &["clip_vision"],
        "upscaleModels" => &["upscale_models"],
        "latentUpscaleModels" | "h3LatentUpscaleModels" => &["latent_upscale_models"],
        "audioEncoders" => &["audio_encoders"],
        _ => &[],
    }
}
