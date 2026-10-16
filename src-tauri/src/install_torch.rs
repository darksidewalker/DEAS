//! Read-only NVIDIA discovery and the exact Go baseline Torch profiles.
use serde::Serialize;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub vendor: String,
    pub name: String,
    pub uuid: String,
    pub driver_version: String,
    pub compute_capability: String,
}
#[derive(Clone, Debug, Serialize)]
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
pub fn parse(output: &str) -> Result<Hardware, String> {
    let lines: Vec<_> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() != 1 {
        return Err("NVIDIA_GPU: expected exactly one visible GPU; multi-GPU selection is not ported. Select CPU explicitly or use a single-GPU host".into());
    }
    let fields: Vec<_> = lines[0].split(',').map(str::trim).collect();
    if fields.len() != 4
        || fields.iter().any(|s| s.is_empty() || *s == "N/A")
        || !fields[0].starts_with("GPU-")
    {
        return Err("NVIDIA_GPU: nvidia-smi returned invalid UUID/name/driver/capability; repair driver and re-plan".into());
    }
    Ok(Hardware {
        vendor: "NVIDIA".into(),
        uuid: fields[0].into(),
        name: fields[1].into(),
        driver_version: fields[2].into(),
        compute_capability: fields[3].into(),
    })
}
pub fn probe() -> Result<Hardware, String> {
    probe_program("nvidia-smi", Duration::from_secs(5))
}
fn probe_program(program: &str, timeout: Duration) -> Result<Hardware, String> {
    let mut command = Command::new(program);
    command
        .args([
            "--query-gpu=uuid,name,driver_version,compute_cap",
            "--format=csv,noheader,nounits",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
    let mut child = command.spawn().map_err(|e| format!("NVIDIA_DRIVER: cannot run nvidia-smi ({e}); install/repair the NVIDIA driver and re-plan"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("NVIDIA_GPU: missing probe output")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(16385).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                break Err(
                    "NVIDIA_DRIVER: nvidia-smi timed out; repair driver and re-plan".to_owned(),
                )
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
    if !status?.success() {
        return Err(
            "NVIDIA_DRIVER: nvidia-smi failed; repair driver/device permissions and re-plan".into(),
        );
    }
    if bytes.len() > 16384 {
        return Err("NVIDIA_GPU: probe output exceeds limit".into());
    }
    parse(std::str::from_utf8(&bytes).map_err(|_| "NVIDIA_GPU: invalid UTF-8")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str, driver: &str, cc: &str) -> Hardware {
        parse(&format!("GPU-test, {name}, {driver}, {cc}")).unwrap()
    }
    #[test]
    fn exact_go_profiles_and_failure_gates() {
        for name in [
            "NVIDIA GeForce RTX 5090",
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
        assert!(parse("GPU-a, A, 615.1, 12.0\nGPU-b, B, 615.1, 12.0").is_err());
    }
    #[test]
    #[ignore = "Read-only live NVIDIA preflight; no installation"]
    fn live_nvidia_preflight() {
        let hardware = probe().unwrap();
        let torch = select(&hardware).unwrap();
        println!("{}", serde_json::to_string(&hardware).unwrap());
        println!("{}", serde_json::to_string(&torch).unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn timeout_is_bounded() {
        let start = Instant::now();
        assert!(probe_program("/usr/bin/yes", Duration::from_millis(100)).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(probe_program("/nonexistent/nvidia-smi", Duration::from_millis(100)).is_err());
    }
}
