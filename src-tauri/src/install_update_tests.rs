// Include inside install.rs's existing #[cfg(test)] mod tests.
fn old_cpu() -> torch_profile::Torch {
    torch_profile::Torch {
        packages: [
            "torch==2.7.0".into(),
            "torchvision==0.22.0".into(),
            "torchaudio==2.7.0".into(),
        ],
        index_url: "https://download.pytorch.org/whl/cpu".into(),
        cuda: None,
    }
}

#[test]
fn torch_update_persists_only_the_verified_profile_and_never_adds_gguf() {
    let tmp = scratch();
    let mut legacy = Engine::default().plan(request(tmp.path())).unwrap();
    legacy.gguf_ref = None;
    legacy.steps.retain(|s| s.id != "gguf");
    legacy.torch = Some(old_cpu());
    let root = Path::new(&legacy.request.storage_path);
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(
        root.join("deas-plan.json"),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();
    let mut updated = legacy.clone();
    updated.torch = Some(torch_profile::cpu());
    persist_updated_plan(&updated).unwrap();
    let stored: Plan =
        serde_json::from_slice(&std::fs::read(root.join("deas-plan.json")).unwrap()).unwrap();
    assert_eq!(
        stored.torch.unwrap().packages,
        torch_profile::cpu().packages
    );
    assert!(stored.gguf_ref.is_none());
    let current = std::fs::read(root.join("deas-plan.json")).unwrap();
    updated.request.comfy_ref = "different-unapproved-source".into();
    assert!(persist_updated_plan(&updated).is_err());
    assert_eq!(std::fs::read(root.join("deas-plan.json")).unwrap(), current);
}

#[test]
fn torch_update_is_gated_on_a_newer_profile_and_known_node_packs() {
    let tmp = scratch();
    let mut plan = Engine::default().plan(request(tmp.path())).unwrap();
    plan.torch = Some(old_cpu());
    let nodes = Path::new(&plan.request.storage_path).join("ComfyUI/custom_nodes");
    for owned in ["ComfyUI-DaSiWa-Nodes", "ComfyUI-GGUF", "__pycache__"] {
        std::fs::create_dir_all(nodes.join(owned)).unwrap();
    }
    std::fs::write(nodes.join("websocket_image_save.py"), "").unwrap();
    let engine = Engine::default();
    lock(&engine.inner).repair = Some(plan.clone());
    let check = engine.torch_check().unwrap();
    assert_eq!(check.from, old_cpu().packages.to_vec());
    assert_eq!(check.to, Some(torch_profile::cpu().packages.to_vec()));
    assert!(check.blocked.is_none());
    assert!(engine.update(true, true, UpdateScope::Torch).is_err());
    std::fs::create_dir(nodes.join("ComfyUI-Foreign")).unwrap();
    let blocked = engine.torch_check().unwrap().blocked.unwrap();
    assert!(blocked.contains("ComfyUI-Foreign"));
    if git_path().is_some() {
        assert!(engine
            .update(false, true, UpdateScope::Torch)
            .unwrap_err()
            .contains("ComfyUI-Foreign"));
    }
    plan.torch = Some(torch_profile::cpu());
    lock(&engine.inner).repair = Some(plan);
    assert_eq!(engine.torch_check().unwrap().to, None);
    if git_path().is_some() {
        assert!(engine.update(false, true, UpdateScope::Torch).is_err());
    }
    // Nothing was launched by any refused update.
    assert_ne!(lock(&engine.inner).status.state, "running");
}
