// Include inside install.rs's existing #[cfg(test)] mod tests.
#[test]
fn constraint_lines_keep_amd_pins_exact_and_append_pytorch_family() {
    let nvidia = torch_profile::select(
        &torch_profile::parse("GPU-t, NVIDIA GeForce 32 GB test GPU, 615.1, 12.0, 8192")
            .unwrap()
            .hardware(),
    )
    .unwrap();
    assert_eq!(
        constraint_lines(&nvidia),
        [
            "torch==2.14.1+cu130",
            "torchvision==0.29.1+cu130",
            "torchaudio==2.11.0+cu130"
        ]
    );
    let amd = torch_profile::amd("gfx1100");
    assert_eq!(
        constraint_lines(&amd),
        [
            "torch[device-gfx1100]==2.13.0+rocm10.0.0",
            "torchvision[device-gfx1100]==0.28.0+rocm10.0.0",
            "torchaudio==2.11.0.2+rocm10.0.0",
        ]
    );
}

#[test]
fn amd_profile_selects_vulkan_llama_wheel_family() {
    // abetlen publishes no ROCm/HIP wheels; Vulkan runs on the Radeon through the driver.
    let args = node_wheel_args("llama-cpp-python>=0.3.26\n", &torch_profile::amd("gfx1100"));
    assert!(args.windows(2).any(|w| w
        == [
            "--index",
            "https://abetlen.github.io/llama-cpp-python/whl/vulkan"
        ]));
    assert_eq!(args.last().unwrap(), "llama-cpp-python==0.3.36");
}

#[test]
fn amd_torch_target_never_swaps_the_rocm_profile_for_cpu() {
    // torch_target() probes only when current.cuda is set; an AMD plan has
    // cuda: None, which the older code path could have "upgraded" to CPU torch.
    let plan = Plan {
        id: "test".into(),
        gguf_ref: None,
        preview_ref: None,
        reopen_id: None,
        repair: None,
        request: Request {
            storage_path: "/nonexistent-deas-amd-plan".into(),
            backend: Backend::Amd,
            features: vec![],
            options: Options::default(),
            comfy_ref: "master".into(),
            folders: None,
            takeover: false,
        },
        steps: vec![],
        warnings: vec![],
        unsupported_options: vec![],
        can_execute: true,
        hardware: None,
        torch: Some(torch_profile::amd("gfx1100")),
    };
    assert!(torch_target(&plan).unwrap().is_none());
}
