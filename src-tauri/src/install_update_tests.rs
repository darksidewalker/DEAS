// Include inside install.rs's existing #[cfg(test)] mod tests.
#[cfg(target_os = "linux")]
#[test]
fn update_maintenance_preserves_active_and_stopped_on_recoverable_failure() {
    for active in [false, true] {
        let (_tmp, approved) = crate::backend::tests::fixture(crate::backend::tests::SERVER);
        let engine = Engine::default();
        lock(&engine.inner).approved = Some(approved);
        if active {
            engine.backend_start().unwrap();
            crate::backend::tests::await_state(&engine.backend, "running");
        }
        // This scratch environment deliberately has no uv or Git checkout: no network or packages.
        assert_eq!(
            engine
                .update(false, true, UpdateScope::Comfy)
                .unwrap()
                .state,
            "running"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !engine.installation_idle() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let status = lock(&engine.inner).status.clone();
        assert_eq!(status.state, "failed");
        assert!(status.error.unwrap().contains("managed uv"));
        assert_eq!(engine.backend.active(), active);
        assert!(lock(&engine.inner).approved.is_some());
        if active {
            crate::backend::tests::await_state(&engine.backend, "running");
        }
        engine.shutdown_backend();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn update_maintenance_refusals_do_not_stop_the_owned_backend() {
    let (_tmp, approved) = crate::backend::tests::fixture(crate::backend::tests::SERVER);
    let engine = Engine::default();
    lock(&engine.inner).approved = Some(approved);
    engine.backend_start().unwrap();
    let before = crate::backend::tests::await_state(&engine.backend, "running");
    assert!(engine.update(false, false, UpdateScope::Comfy).is_err());
    assert!(engine.update(true, true, UpdateScope::Torch).is_err());
    lock(&engine.inner).status.state = "running".into();
    assert!(engine.update(false, true, UpdateScope::Comfy).is_err());
    let after = engine.backend.status();
    assert_eq!(after.state, "running");
    assert_eq!(after.endpoint, before.endpoint);
    engine.shutdown_backend();
}

#[cfg(target_os = "linux")]
#[test]
fn maintenance_resume_rejects_changed_launch_proof_and_logs_error() {
    let (tmp, approved) = crate::backend::tests::fixture(crate::backend::tests::SERVER);
    let engine = Engine::default();
    lock(&engine.inner).approved = Some(approved);
    std::fs::write(tmp.path().join("ComfyUI/main.py"), "# replaced").unwrap();
    let cursor = crate::logs::after(0).last().map_or(0, |entry| entry.seq);
    let error = engine
        .resume_after_maintenance(true, &lock(&engine.inner))
        .unwrap_err();
    assert!(error.contains("could not restart after maintenance"));
    assert!(crate::logs::after(cursor)
        .iter()
        .any(|entry| entry.source == crate::logs::Source::Deas
            && entry.text == format!("ERROR: {error}")));
    lock(&engine.inner).approved = None;
    assert!(engine
        .resume_after_maintenance(true, &lock(&engine.inner))
        .is_err());
    assert!(!engine.backend.active());
    assert!(engine
        .resume_after_maintenance(false, &lock(&engine.inner))
        .is_ok());
}
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

#[test]
fn reinstall_records_driver_update_but_refuses_other_compute_capability() {
    let gpu = |uuid: &str, driver: &str, cc: &str| -> torch_profile::Hardware {
        serde_json::from_value(serde_json::json!({"vendor":"NVIDIA","name":"NVIDIA GeForce RTX 4090","uuid":uuid,"driverVersion":driver,"computeCapability":cc})).unwrap()
    };
    let recorded = gpu("GPU-a", "580.10", "8.9");
    let updated =
        refreshed_hardware(&recorded, gpu("GPU-b", "595.02", "8.9"), &Backend::Nvidia).unwrap();
    assert_eq!(
        (updated.uuid.as_str(), updated.driver_version.as_str()),
        ("GPU-b", "595.02")
    );
    assert!(
        refreshed_hardware(&recorded, gpu("GPU-a", "595.02", "12.0"), &Backend::Nvidia)
            .unwrap_err()
            .contains("compute capability changed (8.9 -> 12.0)")
    );
    // The fresh-install driver gate still applies.
    assert!(refreshed_hardware(&recorded, gpu("GPU-a", "570.1", "8.9"), &Backend::Nvidia).is_err());
}

#[test]
fn a_cycle_fence_refuses_an_environment_update_at_entry() {
    let _gate = crate::resources::fence_test_gate();
    // §14.6/E14: mutating the environment while a cycle owns the card takes the engine out
    // from under the handoff. The gate is the first statement of `native_install_update`
    // (and so of `native_install_repair`, which routes through it); it is extracted here
    // because the command needs a live AppHandle, and it spawns no worker when it refuses.
    assert!(
        update_fence_gate().is_ok(),
        "an open fence leaves the update exactly as shipped"
    );
    assert!(crate::resources::fence_claim(), "the cycle owns the fence");
    let error = update_fence_gate().expect_err("the update waits behind the fence");
    crate::resources::fence_release();
    assert!(error.starts_with("CYCLE_FENCE:"), "{error}");
    assert!(error.contains("environment update"), "{error}");
}

/// A repair plan small enough to park in `pin_repair` by hand (the same shape the
/// outdated-pin preview leaves behind), for the order law below.
fn parked_plan(root: &Path) -> Plan {
    Plan {
        id: "pin-plan".into(),
        gguf_ref: None,
        preview_ref: None,
        reopen_id: None,
        repair: None,
        request: request(root),
        steps: vec![],
        warnings: vec![],
        unsupported_options: vec![],
        can_execute: true,
        hardware: None,
        torch: None,
    }
}

#[test]
fn a_held_fence_refuses_a_repair_before_the_pin_is_consumed() {
    let _gate = crate::resources::fence_test_gate();
    // D4 gate-order fix: `native_install_repair` now checks the cycle fence BEFORE arming
    // the pin. A held fence refuses at the gate; because the gate runs first, the one-time
    // `pin_repair` token survives UNCONSUMED and no repair is adopted - the engine is
    // byte-unchanged by the refusal. (Arming first, as shipped, took the token and nulled
    // `approved` before the refusal could run.)
    let engine = Engine::default();
    let tmp = scratch();
    let token = "repair-token".to_owned();
    lock(&engine.inner).pin_repair = Some((token.clone(), parked_plan(tmp.path())));
    let approved_before = lock(&engine.inner).approved.is_some();

    // The gate is the FIRST statement of the fixed `native_install_repair`; a held fence
    // refuses there, so `arm_pin_repair` is never reached.
    assert!(crate::resources::fence_claim(), "a cycle owns the fence");
    let error = update_fence_gate().expect_err("the held fence refuses the repair");
    assert!(error.starts_with("CYCLE_FENCE:"), "{error}");

    {
        let g = lock(&engine.inner);
        assert!(
            g.pin_repair.is_some(),
            "the arm never ran: the one-time token survives the refusal"
        );
        assert!(g.repair.is_none(), "a refused repair adopts no plan");
        assert_eq!(
            g.approved.is_some(),
            approved_before,
            "the refusal changes no approval state (arm, not run, would have nulled it)"
        );
    }
    crate::resources::fence_release();

    // With the fence down the SAME token arms normally - proving the refusal was the fence,
    // not staleness, and that the fix is the ORDER not a broken arm.
    engine.arm_pin_repair(&token, true).unwrap();
    assert!(
        lock(&engine.inner).pin_repair.is_none(),
        "the token is consumed once the gate clears"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_held_fence_leaves_an_approved_environment_approved_when_a_repair_is_refused() {
    let _gate = crate::resources::fence_test_gate();
    // Companion to the order test, in the install-fixture style: an APPROVED environment
    // keeps its approval across a fence-held repair refusal, because the gate-before-arm
    // fix means `arm_pin_repair` (the only path that nulls `approved`) never runs.
    let (_tmp, approved) = crate::backend::tests::fixture(crate::backend::tests::SERVER);
    let engine = Engine::default();
    lock(&engine.inner).approved = Some(approved);
    let scratch_dir = scratch();
    let token = "repair-token".to_owned();
    lock(&engine.inner).pin_repair = Some((token, parked_plan(scratch_dir.path())));

    assert!(crate::resources::fence_claim(), "a cycle owns the fence");
    assert!(
        update_fence_gate().is_err(),
        "the held fence refuses the repair"
    );
    {
        let g = lock(&engine.inner);
        assert!(g.approved.is_some(), "approval survives the refused repair");
        assert!(g.pin_repair.is_some(), "the pin is never consumed by a refusal");
        assert!(g.repair.is_none(), "no repair is adopted");
    }
    crate::resources::fence_release();
}

