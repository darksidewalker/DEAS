//! Read-only NVIDIA discovery and the exact Go baseline Torch profiles.
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub vendor: String,
    pub name: String,
    /// NVIDIA: the `GPU-…` UUID from nvidia-smi. AMD: `AMD-<pci id>` from lspci.
    pub uuid: String,
    pub driver_version: String,
    /// NVIDIA: `major.minor` compute capability. AMD: the gfx target (gfx1030…
    /// gfx1201) resolved by `amd::amd_target`; reused so old plans keep serde shape.
    pub compute_capability: String,
    /// Total frame buffer in MiB from `nvidia-smi memory_total`; 0 when unknown
    /// (AMD probe, manifests written before this field existed). Display only.
    #[serde(default)]
    pub memory_total_mib: u64,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Torch {
    pub packages: [String; 3],
    pub index_url: String,
    pub cuda: Option<String>,
}
fn profile(versions: [&str; 3], index: &str, cuda: Option<&str>) -> Torch {
    Torch {
        packages: std::array::from_fn(|i| {
            format!(
                "{}=={}",
                ["torch", "torchvision", "torchaudio"][i],
                versions[i]
            )
        }),
        index_url: format!("https://download.pytorch.org/whl/{index}"),
        cuda: cuda.map(str::to_owned),
    }
}
pub fn cpu() -> Torch {
    // Deliberate existing CPU baseline, not Go's unpinned default profile.
    profile(["2.8.0", "0.23.0", "2.8.0"], "cpu", None)
}
/// Installer-proven ROCm pins (dasiwa-comfyui-installer amd.go); the pins carry
/// their `+rocm` build tag, so no index-family suffix is appended anywhere.
/// `cuda: None` also routes node wheels to the cpu llama-cpp family.
pub fn amd(target: &str) -> Torch {
    Torch {
        packages: [
            format!("torch[device-{target}]==2.13.0+rocm10.0.0"),
            format!("torchvision[device-{target}]==0.28.0+rocm10.0.0"),
            "torchaudio==2.11.0.2+rocm10.0.0".into(),
        ],
        index_url: crate::amd::AMD_INDEX_URL.into(),
        cuda: None,
    }
}
pub fn select(h: &Hardware) -> Result<Torch, String> {
    let name = h.name.to_ascii_uppercase();
    let cc: f32 = h
        .compute_capability
        .parse()
        .map_err(|_| "NVIDIA_GPU: invalid compute capability; update nvidia-smi and re-plan")?;
    let driver: Vec<u32> = h
        .driver_version
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| "NVIDIA_DRIVER: invalid driver version; update driver and re-plan")?;
    let legacy = name.contains("GTX 10")
        || name.contains("PASCAL")
        || name.contains("LEGACY")
        || (6.0..6.2).contains(&cc);
    if legacy {
        if !(6.0..6.2).contains(&cc) {
            return Err("NVIDIA_GPU: legacy name/capability mismatch; no CPU fallback".into());
        }
        if driver.as_slice() < [525, 60, 13].as_slice() {
            return Err(
                "NVIDIA_DRIVER: CUDA 12.1 requires Linux driver >=525.60.13; update and re-plan"
                    .into(),
            );
        }
        return Ok(profile(["2.4.1", "0.19.1", "2.4.1"], "cu121", Some("12.1")));
    }
    if !(7.5..13.0).contains(&cc) {
        return Err("NVIDIA_GPU: supported baseline requires Pascal 6.0/6.1 or compute capability 7.5–12.x; no CPU fallback".into());
    }
    if driver.first().copied().unwrap_or(0) < 580 {
        return Err(
            "NVIDIA_DRIVER: CUDA 13.0 requires Linux driver >=580; update and re-plan".into(),
        );
    }
    // Go config global/min_cuda_for_50xx=13.2; effectiveNVIDIACUDA maps
    // all 13.x to the complete cu130 trio (including stable-ABI Audio 2.11).
    Ok(profile(
        ["2.14.1", "0.29.1", "2.11.0"],
        "cu130",
        Some("13.0"),
    ))
}
fn version(spec: &str) -> Vec<u32> {
    let number = spec.split_once("==").map_or("", |(_, v)| v);
    number.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}
/// The profile this build would install instead of `current`, only when it is a newer Torch on
/// the same device class (CPU stays CPU, CUDA stays CUDA). `probed` is required for CUDA and must
/// pass the same hardware/driver gates as a fresh install.
pub fn newer(current: &Torch, probed: Option<&Hardware>) -> Result<Option<Torch>, String> {
    let target = match (&current.cuda, probed) {
        (None, _) => cpu(),
        (Some(_), Some(hardware)) => select(hardware)?,
        (Some(_), None) => return Err("NVIDIA_GPU: hardware probe required".into()),
    };
    let same_class = target.cuda.is_some() == current.cuda.is_some();
    Ok(
        (same_class && version(&target.packages[0]) > version(&current.packages[0]))
            .then_some(target),
    )
}
fn parse_line(line: &str) -> Result<Hardware, String> {
    let fields: Vec<_> = line.split(',').map(str::trim).collect();
    if fields.len() != 5
        || fields.iter().any(|s| s.is_empty() || *s == "N/A")
        || !fields[0].starts_with("GPU-")
    {
        return Err("NVIDIA_GPU: nvidia-smi returned invalid UUID/name/driver/capability/memory; repair driver and re-plan".into());
    }
    let memory_total_mib = fields[4]
        .parse::<u64>()
        .map_err(|_| "NVIDIA_GPU: nvidia-smi returned a non-numeric memory total; repair driver and re-plan")?;
    Ok(Hardware {
        vendor: "NVIDIA".into(),
        uuid: fields[0].into(),
        name: fields[1].into(),
        driver_version: fields[2].into(),
        compute_capability: fields[3].into(),
        memory_total_mib,
    })
}
/// Every visible GPU, in nvidia-smi index order. A `CUDA_VISIBLE_DEVICES` pin still narrows the list.
pub fn parse_all(output: &str) -> Result<Vec<Hardware>, String> {
    let lines: Vec<_> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Err("NVIDIA_GPU: nvidia-smi returned no visible GPU; install/repair the NVIDIA driver and re-plan".into());
    }
    lines.iter().map(|line| parse_line(line)).collect()
}
pub fn parse(output: &str) -> Result<Hardware, String> {
    let gpus = parse_all(output)?;
    if gpus.len() != 1 {
        return Err("NVIDIA_GPU: expected exactly one visible GPU; set CUDA_VISIBLE_DEVICES to pin one GPU, select CPU explicitly, or use a single-GPU host".into());
    }
    Ok(gpus.into_iter().next().unwrap())
}
/// Multi-GPU default: the passing GPU with the highest compute capability (lowest index on ties).
/// A card that fails the driver/capability gates never wins; if none passes, the first gate error is reported.
pub fn pick(gpus: &[Hardware]) -> Result<Hardware, String> {
    let mut best: Option<(f32, &Hardware)> = None;
    let mut first_error: Option<String> = None;
    for gpu in gpus {
        match select(gpu) {
            Ok(_) => match gpu.compute_capability.parse::<f32>() {
                Ok(cc) if best.map_or(true, |(current, _)| cc > current) => {
                    best = Some((cc, gpu));
                }
                _ => {
                    first_error.get_or_insert_with(|| {
                        "NVIDIA_GPU: invalid compute capability; update nvidia-smi and re-plan".into()
                    });
                }
            },
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    best.map(|(_, gpu)| gpu.clone())
        .ok_or_else(|| first_error.unwrap_or_else(|| "NVIDIA_GPU: no visible GPU".into()))
}
pub fn probe() -> Result<Hardware, String> {
    let bytes = run_probe("nvidia-smi", Duration::from_secs(5))?;
    parse(std::str::from_utf8(&bytes).map_err(|_| "NVIDIA_GPU: invalid UTF-8")?)
}
pub fn probe_all() -> Result<Vec<Hardware>, String> {
    let bytes = run_probe("nvidia-smi", Duration::from_secs(5))?;
    parse_all(std::str::from_utf8(&bytes).map_err(|_| "NVIDIA_GPU: invalid UTF-8")?)
}
fn probe_command(program: &str) -> Command {
    let mut command = Command::new(program);
    let mut args: Vec<String> = vec![
        "--query-gpu=uuid,name,driver_version,compute_cap,memory_total".to_owned(),
        "--format=csv,noheader,nounits".to_owned(),
    ];
    // nvidia-smi enumerates every GPU regardless of CUDA_VISIBLE_DEVICES; pass the variable through as -i so a multi-GPU host can pin one visible device. Unset keeps the full enumeration.
    if let Ok(visible) = std::env::var("CUDA_VISIBLE_DEVICES") {
        let visible = visible.trim().to_owned();
        if !visible.is_empty() {
            args.push("-i".to_owned());
            args.push(visible);
        }
    }
    command
        .args(args)
        // NVML uses the host driver environment; this query performs no installation.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::win::CREATE_NO_WINDOW);
    }
    command
}
/// Runs the read-only probe and returns its bounded stdout; parsing stays in `parse_all`.
fn run_probe(program: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let mut child = probe_command(program).spawn().map_err(|e| format!("NVIDIA_DRIVER: cannot run nvidia-smi ({e}); install/repair the NVIDIA driver and re-plan"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("NVIDIA_GPU: missing probe output")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(16385).read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr = child
        .stderr
        .take()
        .ok_or("NVIDIA_GPU: missing probe stderr")?;
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(16385).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                break Err(
                    "NVIDIA_DRIVER: nvidia-smi timed out; repair driver and re-plan".to_owned(),
                );
            }
            Err(e) => break Err(format!("NVIDIA_DRIVER: probe wait failed: {e}")),
        }
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    let bytes = reader
        .join()
        .map_err(|_| "NVIDIA_GPU: probe reader failed")?
        .map_err(|e| e.to_string())?;
    let errors = error_reader
        .join()
        .map_err(|_| "NVIDIA_GPU: probe stderr reader failed")?
        .map_err(|e| e.to_string())?;
    let status = status?;
    if bytes.len() > 16384 || errors.len() > 16384 {
        return Err("NVIDIA_GPU: probe output exceeds limit".into());
    }
    if !status.success() {
        return Err(format!(
            "NVIDIA_DRIVER: nvidia-smi failed ({status}, raw code {}); stdout: {}; stderr: {}",
            status
                .code()
                .map(|code| format!("{:#010x}", code as u32))
                .unwrap_or_else(|| "none".into()),
            String::from_utf8_lossy(&bytes).trim(),
            String::from_utf8_lossy(&errors).trim(),
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str, driver: &str, cc: &str) -> Hardware {
        parse(&format!("GPU-test, {name}, {driver}, {cc}, 8192")).unwrap()
    }
    #[test]
    fn newer_profile_only_upgrades_within_the_device_class() {
        let gpu = fixture("NVIDIA GeForce 32 GB test GPU", "615.71.09", "12.0");
        let old = profile(["2.9.0", "0.24.0", "2.9.0"], "cu128", Some("12.8"));
        assert_eq!(
            newer(&old, Some(&gpu)).unwrap().unwrap().packages[0],
            "torch==2.14.1"
        );
        assert!(newer(&select(&gpu).unwrap(), Some(&gpu)).unwrap().is_none());
        // Never a downgrade: a legacy GPU profile is older than an existing newer pin.
        let pascal = fixture("GTX 1080", "580.1.0", "6.1");
        assert!(newer(&old, Some(&pascal)).unwrap().is_none());
        assert!(newer(&old, Some(&fixture("GPU", "570.1.0", "12.0"))).is_err());
        assert!(newer(&old, None).is_err());
        let old_cpu = profile(["2.7.0", "0.22.0", "2.7.0"], "cpu", None);
        assert_eq!(
            newer(&old_cpu, None).unwrap().unwrap().packages,
            cpu().packages
        );
        assert!(newer(&cpu(), Some(&gpu)).unwrap().is_none());
    }
    #[test]
    fn exact_go_profiles_and_failure_gates() {
        for name in [
            "NVIDIA GeForce 32 GB test GPU",
            "Blackwell",
            "RTX 4090",
            "RTX 2080",
        ] {
            let p = select(&fixture(name, "615.71.09", "12.0")).unwrap();
            assert_eq!(
                p.packages,
                ["torch==2.14.1", "torchvision==0.29.1", "torchaudio==2.11.0"]
            );
            assert!(p.index_url.ends_with("cu130"));
        }
        for name in ["GTX 1080", "Pascal", "Tesla P100"] {
            assert_eq!(
                select(&fixture(name, "580.1.0", "6.1")).unwrap().packages[0],
                "torch==2.4.1"
            );
        }
        for (driver, cc) in [
            ("570.1.0", "12.0"),
            ("615.1", "7.0"),
            ("615.1", "5.2"),
            ("bad", "12.0"),
        ] {
            assert!(select(&fixture("GPU", driver, cc)).is_err());
        }
        assert!(select(&fixture("GTX 1080", "520.1.0", "6.1")).is_err());
        assert!(parse("").is_err());
        assert!(parse("GPU-a, A, 615.1, 12.0, 8192\nGPU-b, B, 615.1, 12.0, 8192").is_err());
        assert!(parse("GPU-a, A, 615.1, 12.0, not-a-number").is_err());
    }
    fn gpu(uuid: &str, name: &str, driver: &str, cc: &str) -> Hardware {
        Hardware {
            vendor: "NVIDIA".into(),
            uuid: uuid.into(),
            name: name.into(),
            driver_version: driver.into(),
            compute_capability: cc.into(),
            memory_total_mib: 8192,
        }
    }
    #[test]
    fn parse_all_keeps_index_order_and_rejects_invalid_rows() {
        let gpus = parse_all("GPU-a, Card A, 615.71.09, 8.9, 8192\nGPU-b, Card B, 615.71.09, 12.0, 16384\r\n").unwrap();
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].uuid, "GPU-a");
        assert_eq!(gpus[1].compute_capability, "12.0");
        assert_eq!(gpus[1].memory_total_mib, 16384);
        assert!(parse_all("").is_err());
        assert!(parse_all("   \n").is_err());
        assert!(parse_all("GPU-a, Card A, N/A, 8.9, 8192").is_err());
    }
    #[test]
    fn pick_prefers_higher_compute_capability_then_lower_index() {
        let older = gpu("GPU-a", "NVIDIA GeForce RTX 2080 SUPER", "615.71.09", "7.5");
        let newer = gpu("GPU-b", "NVIDIA GeForce RTX 5060 Ti", "615.71.09", "12.0");
        // List order never matters: the highest passing capability wins.
        assert_eq!(pick(&[older.clone(), newer.clone()]).unwrap().uuid, "GPU-b");
        assert_eq!(pick(&[newer.clone(), older.clone()]).unwrap().uuid, "GPU-b");
        // Equal capability: the lowest nvidia-smi index wins.
        let twin_a = gpu("GPU-a", "NVIDIA GeForce RTX 4090", "615.71.09", "8.9");
        let twin_b = gpu("GPU-b", "NVIDIA GeForce RTX 4090", "615.71.09", "8.9");
        assert_eq!(pick(&[twin_a.clone(), twin_b.clone()]).unwrap().uuid, "GPU-a");
    }
    #[test]
    fn pick_never_returns_a_gpu_that_fails_the_gates() {
        let old_driver = gpu("GPU-a", "NVIDIA GeForce RTX 4090", "570.1.0", "8.9");
        let passing = gpu("GPU-b", "NVIDIA GeForce RTX 2080 SUPER", "615.71.09", "7.5");
        assert_eq!(pick(&[old_driver.clone(), passing]).unwrap().uuid, "GPU-b");
        // No passing GPU: report the first gate error, never a fallback card.
        let modern = gpu("GPU-c", "NVIDIA GeForce RTX 3090", "615.71.09", "8.9");
        assert!(pick(&[old_driver.clone(), modern]).unwrap_err().contains("NVIDIA_DRIVER"));
    }
    #[cfg(unix)]
    #[test]
    fn probe_inherits_host_driver_environment() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("nvidia-smi");
        std::fs::write(
            &program,
            "#!/bin/sh\nprintf 'GPU-env, %s, 617.42, 8.9, 8192\\n' \"$HOME\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let expected = std::env::var("HOME").unwrap();
        assert!(!expected.is_empty());
        let bytes = run_probe(program.to_str().unwrap(), Duration::from_secs(1)).unwrap();
        let gpus = parse_all(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, expected);
    }
    #[test]
    #[ignore = "Read-only live NVIDIA preflight; no installation"]
    fn live_nvidia_preflight() {
        let hardware = probe().unwrap();
        let torch = select(&hardware).unwrap();
        println!("{}", serde_json::to_string(&hardware).unwrap());
        println!("{}", serde_json::to_string(&torch).unwrap());
    }
    #[test]
    fn reported_windows_4080_query_passes_unchanged() {
        let hardware = parse(
            "GPU-3a261b54-349e-40a0-c826-4f5cdd2cbdec, NVIDIA GeForce RTX 4080, 617.42, 8.9, 16384\r\n",
        )
        .unwrap();
        assert_eq!(hardware.name, "NVIDIA GeForce RTX 4080");
        assert_eq!(select(&hardware).unwrap().cuda.as_deref(), Some("13.0"));
    }
    #[cfg(unix)]
    #[test]
    fn probe_returns_real_process_diagnostics() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("nvidia-smi");
        std::fs::write(&program, "#!/bin/sh\nprintf 'driver diagnostic on stdout'\nprintf 'driver diagnostic on stderr' >&2\nexit 9\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = run_probe(program.to_str().unwrap(), Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("0x00000009"), "{error}");
        assert!(
            error.contains("stdout: driver diagnostic on stdout"),
            "{error}"
        );
        assert!(
            error.contains("stderr: driver diagnostic on stderr"),
            "{error}"
        );
        std::fs::write(&program, "#!/bin/sh\nexec /usr/bin/yes diagnostic >&2\n").unwrap();
        let start = Instant::now();
        let error = run_probe(program.to_str().unwrap(), Duration::from_millis(100)).unwrap_err();
        assert!(error.contains("exceeds limit") || error.contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[cfg(unix)]
    #[test]
    fn timeout_is_bounded() {
        let start = Instant::now();
        assert!(run_probe("/usr/bin/yes", Duration::from_millis(100)).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(run_probe("/nonexistent/nvidia-smi", Duration::from_millis(100)).is_err());
    }
}
