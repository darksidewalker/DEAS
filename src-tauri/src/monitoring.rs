//! One read-only telemetry sample for the Monitoring tab: CPU, RAM, swap, disk and NVIDIA GPUs.
//! Works without the backend; nothing here writes, installs or touches ComfyUI.
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: u64,
    pub source: &'static str,
    pub cpu: Option<Cpu>,
    pub ram: Option<Memory>,
    pub swap: Option<Memory>,
    pub disks: Vec<Disk>,
    pub gpus: Vec<Gpu>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Cpu {
    pub percent: f64,
    pub count: u32,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Memory {
    pub used: u64,
    pub total: u64,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Disk {
    pub path: String,
    pub used: u64,
    pub total: u64,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub index: u32,
    pub name: String,
    pub utilization: Option<f64>,
    pub memory_used: Option<u64>,
    pub memory_total: Option<u64>,
    pub temperature: Option<f64>,
    pub power_w: Option<f64>,
    pub power_limit_w: Option<f64>,
}

/// CPU percent is a delta between two calls; the first call reports 0.
static CPU_TIMES: Mutex<Option<(u64, u64)>> = Mutex::new(None);
/// A missing `nvidia-smi` is reported once and not retried every second.
static NVIDIA_SMI_MISSING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn cpu_percent(idle: u64, total: u64) -> f64 {
    let mut guard = CPU_TIMES.lock().unwrap_or_else(|e| e.into_inner());
    let previous = guard.replace((idle, total));
    match previous {
        Some((prev_idle, prev_total)) if total > prev_total => {
            let busy = (total - prev_total).saturating_sub(idle.saturating_sub(prev_idle));
            (busy as f64 * 100.0 / (total - prev_total) as f64).clamp(0.0, 100.0)
        }
        _ => 0.0,
    }
}

#[cfg(target_os = "linux")]
fn cpu() -> Option<Cpu> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?.strip_prefix("cpu ")?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .filter_map(|f| f.parse().ok())
        .collect();
    if fields.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal; idle = idle + iowait
    let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
    let total: u64 = fields.iter().take(8).sum();
    let count = std::thread::available_parallelism().map_or(0, |n| n.get() as u32);
    Some(Cpu {
        percent: cpu_percent(idle, total),
        count,
    })
}
#[cfg(target_os = "linux")]
fn memory() -> (Option<Memory>, Option<Memory>) {
    let Ok(info) = std::fs::read_to_string("/proc/meminfo") else {
        return (None, None);
    };
    let kib = |key: &str| -> Option<u64> {
        info.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|rest| {
                rest.trim_start_matches(':')
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
            .map(|v| v * 1024)
    };
    let pair = |total: &str, free: &str| {
        let (total, free) = (kib(total)?, kib(free)?);
        Some(Memory {
            used: total.saturating_sub(free),
            total,
        })
    };
    (
        pair("MemTotal", "MemAvailable"),
        pair("SwapTotal", "SwapFree"),
    )
}
#[cfg(unix)]
fn disk(path: &std::path::Path) -> Option<Disk> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let frag = stat.f_frsize as u64;
    let total = stat.f_blocks as u64 * frag;
    Some(Disk {
        path: path.display().to_string(),
        used: total.saturating_sub(stat.f_bavail as u64 * frag),
        total,
    })
}

#[cfg(windows)]
fn cpu() -> Option<Cpu> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetSystemTimes;
    let mut idle: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    // Kernel time includes idle time.
    let (idle, total) = (ticks(idle), ticks(kernel) + ticks(user));
    Some(Cpu {
        percent: cpu_percent(idle, total),
        count: std::thread::available_parallelism().map_or(0, |n| n.get() as u32),
    })
}
#[cfg(windows)]
fn memory() -> (Option<Memory>, Option<Memory>) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return (None, None);
    }
    let ram = Memory {
        used: status.ullTotalPhys.saturating_sub(status.ullAvailPhys),
        total: status.ullTotalPhys,
    };
    // The page file alone: commit limit minus physical RAM.
    let swap_total = status.ullTotalPageFile.saturating_sub(status.ullTotalPhys);
    let swap_free = status.ullAvailPageFile.saturating_sub(status.ullAvailPhys);
    let swap = (swap_total > 0).then(|| Memory {
        used: swap_total.saturating_sub(swap_free.min(swap_total)),
        total: swap_total,
    });
    (Some(ram), swap)
}
#[cfg(windows)]
fn disk(path: &std::path::Path) -> Option<Disk> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) } == 0 {
        return None;
    }
    Some(Disk {
        path: path.display().to_string(),
        used: total.saturating_sub(avail),
        total,
    })
}
#[cfg(not(any(target_os = "linux", windows)))]
fn cpu() -> Option<Cpu> {
    None
}
#[cfg(not(any(target_os = "linux", windows)))]
fn memory() -> (Option<Memory>, Option<Memory>) {
    (None, None)
}

const GPU_QUERY: &str = "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit";

/// `nvidia-smi --format=csv,noheader,nounits` rows; unavailable fields (`[N/A]`) become `None`.
pub fn parse_gpus(csv: &str) -> Vec<Gpu> {
    csv.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(',').map(str::trim).collect();
            if f.len() != 8 {
                return None;
            }
            let num = |s: &str| s.parse::<f64>().ok();
            let mib = |s: &str| s.parse::<u64>().ok().map(|v| v * 1024 * 1024);
            Some(Gpu {
                index: f[0].parse().ok()?,
                name: f[1].chars().take(120).collect(),
                utilization: num(f[2]),
                memory_used: mib(f[3]),
                memory_total: mib(f[4]),
                temperature: num(f[5]),
                power_w: num(f[6]),
                power_limit_w: num(f[7]),
            })
        })
        .take(16)
        .collect()
}

async fn gpus() -> Result<Vec<Gpu>, String> {
    if NVIDIA_SMI_MISSING.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(vec![]);
    }
    let mut command = tokio::process::Command::new("nvidia-smi");
    command
        .args([GPU_QUERY, "--format=csv,noheader,nounits"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(crate::win::CREATE_NO_WINDOW);
    let output = match tokio::time::timeout(Duration::from_secs(3), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            NVIDIA_SMI_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err("nvidia-smi not found: GPU telemetry unavailable".into());
        }
        Ok(Err(e)) => return Err(format!("nvidia-smi failed: {e}")),
        Err(_) => return Err("nvidia-smi timed out".into()),
    };
    if !output.status.success() {
        return Err(format!("nvidia-smi exited with {}", output.status));
    }
    let text =
        String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(16384)]).into_owned();
    Ok(parse_gpus(&text))
}

pub async fn sample(root: Option<&std::path::Path>) -> Sample {
    let (ram, swap) = memory();
    let mut sample = Sample {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64),
        source: "native",
        cpu: cpu(),
        ram,
        swap,
        disks: root
            .filter(|r| r.is_absolute())
            .and_then(disk)
            .into_iter()
            .collect(),
        gpus: vec![],
        warnings: vec![],
    };
    match gpus().await {
        Ok(gpus) => sample.gpus = gpus,
        Err(warning) => sample.warnings.push(warning),
    }
    sample
}

/// Read-only: one telemetry sample; `root` only names the disk to report.
#[tauri::command]
pub async fn native_monitoring_sample(root: Option<String>) -> Sample {
    sample(root.as_deref().map(std::path::Path::new)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_rows_and_unavailable_fields() {
        let rows = parse_gpus(
            "0, NVIDIA GeForce RTX 5090, 3, 31355, 32607, 52, 38.64, 420.00\n1, Some GPU, [N/A], 10, 100, [N/A], [N/A], [N/A]\nbroken line\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "NVIDIA GeForce RTX 5090");
        assert_eq!(rows[0].utilization, Some(3.0));
        assert_eq!(rows[0].memory_used, Some(31355 * 1024 * 1024));
        assert_eq!(rows[0].power_w, Some(38.64));
        assert_eq!(rows[0].power_limit_w, Some(420.0));
        assert_eq!(rows[1].utilization, None);
        assert_eq!(rows[1].temperature, None);
    }

    #[test]
    fn cpu_percent_is_a_delta_clamped_to_range() {
        *CPU_TIMES.lock().unwrap() = None;
        assert_eq!(cpu_percent(100, 200), 0.0);
        // +100 total, +25 idle → 75 % busy
        assert_eq!(cpu_percent(125, 300), 75.0);
        // no progress → 0, never NaN
        assert_eq!(cpu_percent(125, 300), 0.0);
    }

    #[tokio::test]
    async fn sample_reports_host_memory_and_a_disk_for_an_absolute_root() {
        let value = sample(Some(std::env::temp_dir().as_path())).await;
        let ram = value.ram.expect("host RAM");
        assert!(ram.total > 0 && ram.used <= ram.total);
        assert_eq!(value.disks.len(), 1);
        assert!(value.disks[0].total >= value.disks[0].used);
        assert_eq!(value.source, "native");
        assert!(sample(Some(std::path::Path::new("relative")))
            .await
            .disks
            .is_empty());
    }
}
