//! Trusted local developer CLI only: no IPC authority, queue, scheduler or GPU initialization.
//! Bounds: 256 MiB source/output, 512px source, 2048px result, 10s, 600 frames, 120fps.
//! RGB is one reusable input plus one callback result; OS pipes provide backpressure.
//! At most two codec children run together; every pipe/wait loop checks cancellation and
//! the shared 300s deadline with 3ms idle polling, including stalls (no fake progress).
//! Probe JSON is capped at 2 MiB and stderr retention at 16 KiB per owned child.
//! Fixed argv invokes native ffmpeg/ffprobe on PATH, never a shell or Python/Go worker.
//! The trusted synchronous callback must return: cancellation cannot preempt native inference.
//! shortcut: Linux-only nonblocking pipes/process groups; enable other platforms only after
//! proving equivalent cleanup and atomic no-replace publication. Same-user hostile path races
//! are outside this trusted CLI contract; do not expose this function as frontend IPC.
use crate::video_upscale::RgbFrame;
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

/// Number of frames actually processed and verified in the published MP4.
#[derive(Debug)]
pub struct StreamResult {
    pub frames: usize,
    pub width: u32,
    pub height: u32,
}

/// The callback can directly call `SpatialUpscaler::upscale`; tests use CPU-only mocks.
/// Existing destinations (including symlinks) are never replaced. Source remains the baseline.
pub fn upscale_video(
    source: &Path,
    output: &Path,
    cancel: &AtomicBool,
    mut process: impl FnMut(&RgbFrame) -> Result<RgbFrame, String>,
) -> Result<StreamResult, String> {
    let id = uuid::Uuid::new_v4();
    #[cfg(target_os = "linux")]
    let result = linux::run(source, output, cancel, &mut process);
    #[cfg(not(target_os = "linux"))]
    let result: Result<StreamResult, String> = {
        let _ = (source, output, cancel, &mut process);
        Err("VIDEO_STREAM_PLATFORM: streaming is not yet verified on this platform".into())
    };
    let (severity, outcome) = match &result {
        Ok(_) => ("INFO", "published"),
        Err(_) if cancel.load(Ordering::Relaxed) => ("INFO", "cancelled"),
        Err(_) => ("ERROR", "failed"),
    };
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("{severity}: video-stream operationId={id} outcome={outcome}"),
    );
    result
}

#[cfg(any(target_os = "linux", test))]
fn check_ticks(ticks: &[i64], tn: i64, td: i64, n: u32, d: u32) -> Result<(), String> {
    if ticks.len() < 2
        || ticks.len() > 600
        || tn <= 0
        || td <= 0
        || n == 0
        || d == 0
        || u64::from(n) > 120 * u64::from(d)
        || ticks[0] != 0
    {
        return Err("VIDEO_TIMING: missing/unsupported cadence or nonzero start".into());
    }
    // i128 avoids rounding away VFR differences (including nominal == average headers).
    for (i, &tick) in ticks.iter().enumerate() {
        if i128::from(tick) * i128::from(tn) * i128::from(n)
            != i as i128 * i128::from(d) * i128::from(td)
        {
            return Err("VIDEO_TIMING: every frame must have exact rational CFR timestamps".into());
        }
    }
    if ticks.len() as u64 * u64::from(d) > 10 * u64::from(n) {
        return Err("VIDEO_LIMIT: clips must be at most ten seconds".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use serde_json::Value;
    use std::{
        fs::{self, File},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, RawFd},
            unix::{
                fs::{MetadataExt, OpenOptionsExt},
                process::CommandExt,
            },
        },
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    const CAP: u64 = 256 * 1024 * 1024;
    const METADATA_CAP: usize = 2 * 1024 * 1024;
    const ERR_CAP: usize = 16 * 1024;
    const LIMIT: Duration = Duration::from_secs(300);
    fn io(e: std::io::Error) -> String {
        format!("VIDEO_STREAM_IO: {e}")
    }
    fn guard(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
        if cancel.load(Ordering::Relaxed) {
            return Err("VIDEO_CANCELLED".into());
        }
        if Instant::now() >= deadline {
            return Err("VIDEO_STREAM_TIMEOUT: five-minute operation deadline".into());
        }
        Ok(())
    }
    fn nonblock(fd: RawFd) -> Result<(), String> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    struct Owned {
        child: Child,
        errors: Vec<u8>,
    }
    impl Owned {
        fn spawn(mut cmd: Command) -> Result<Self, String> {
            cmd.process_group(0).stderr(Stdio::piped());
            // File cap is enforced by the OS even if a muxer ignores ffmpeg's -fs.
            unsafe {
                cmd.pre_exec(|| {
                    let lim = libc::rlimit {
                        rlim_cur: CAP,
                        rlim_max: CAP,
                    };
                    if libc::setrlimit(libc::RLIMIT_FSIZE, &lim) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let child = cmd.spawn().map_err(io)?;
            let owned = Self {
                child,
                errors: Vec::new(),
            };
            nonblock(owned.child.stderr.as_ref().unwrap().as_raw_fd())?;
            if let Some(p) = &owned.child.stdout {
                nonblock(p.as_raw_fd())?;
            }
            if let Some(p) = &owned.child.stdin {
                nonblock(p.as_raw_fd())?;
            }
            Ok(owned)
        }
        fn drain(&mut self) -> Result<(), String> {
            let mut buf = [0; 4096];
            // Bound each drain too: a noisy child cannot starve timeout/cancel checks.
            for _ in 0..16 {
                match self.child.stderr.as_mut().unwrap().read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let take = n.min(ERR_CAP.saturating_sub(self.errors.len()));
                        self.errors.extend_from_slice(&buf[..take]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(io(e)),
                }
            }
            Ok(())
        }
        // WNOWAIT reserves the leader PID until Drop kills its owned group and reaps it.
        fn status(&self) -> Result<Option<bool>, String> {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            } != 0
            {
                return Err(io(std::io::Error::last_os_error()));
            }
            if unsafe { info.si_pid() } == 0 {
                return Ok(None);
            }
            Ok(Some(
                info.si_code == libc::CLD_EXITED && unsafe { info.si_status() } == 0,
            ))
        }
        fn finish(&mut self, cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
            loop {
                guard(cancel, deadline)?;
                self.drain()?;
                if let Some(ok) = self.status()? {
                    self.drain()?;
                    if ok && self.errors.is_empty() {
                        return Ok(());
                    }
                    // Bounded native diagnostics are private, not forwarded to shared Logs.
                    return Err(format!(
                        "VIDEO_CODEC_FAILED: {}",
                        String::from_utf8_lossy(&self.errors)
                    ));
                }
                thread::sleep(Duration::from_millis(3));
            }
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
    }
    fn base(program: &str) -> Command {
        let mut c = Command::new(program);
        c.args(["-v", "error", "-max_alloc", "67108864", "-threads", "1"]);
        c
    }
    fn input(c: &mut Command, path: &Path) {
        c.args([
            "-protocol_whitelist",
            "file,pipe",
            "-probesize",
            "4194304",
            "-analyzeduration",
            "1000000",
            "-i",
        ])
        .arg(path);
    }
    fn capture(mut c: Command, cancel: &AtomicBool, deadline: Instant) -> Result<Vec<u8>, String> {
        c.stdin(Stdio::null()).stdout(Stdio::piped());
        let mut p = Owned::spawn(c)?;
        let mut result = Vec::new();
        let mut buf = [0; 8192];
        loop {
            guard(cancel, deadline)?;
            p.drain()?;
            match p.child.stdout.as_mut().unwrap().read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if result.len() + n > METADATA_CAP {
                        return Err("VIDEO_METADATA_LIMIT".into());
                    }
                    result.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(3))
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => (),
                Err(e) => return Err(io(e)),
            }
        }
        p.finish(cancel, deadline)?;
        Ok(result)
    }
    #[derive(Debug, PartialEq, Eq)]
    struct Identity(u64, u64, u64, i64, i64, i64, i64);
    fn identity(path: &Path) -> Result<Identity, String> {
        let m = fs::symlink_metadata(path).map_err(io)?;
        if !m.is_file() || m.len() > CAP {
            return Err("VIDEO_SOURCE: regular source up to 256 MiB required".into());
        }
        Ok(Identity(
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        ))
    }
    fn number(v: &Value, k: &str) -> Result<i64, String> {
        v[k].as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| v[k].as_i64())
            .ok_or_else(|| format!("VIDEO_METADATA: missing {k}"))
    }
    fn rational(s: &str) -> Result<(i64, i64), String> {
        let (a, b) = s.split_once('/').ok_or("VIDEO_TIMING: missing rational")?;
        let a = a
            .parse::<i64>()
            .map_err(|_| "VIDEO_TIMING: invalid rational")?;
        let b = b
            .parse::<i64>()
            .map_err(|_| "VIDEO_TIMING: invalid rational")?;
        if a <= 0 || b <= 0 || a > 1_000_000_000 || b > 1_000_000_000 {
            return Err("VIDEO_TIMING: rational outside bound".into());
        }
        Ok((a, b))
    }
    struct Probe {
        count: usize,
        video: Value,
        audio: Option<Value>,
        seconds: f64,
    }
    fn probe(
        path: &Path,
        n: u32,
        d: u32,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<Probe, String> {
        let mut c = base("ffprobe");
        c.args(["-show_streams", "-show_format", "-of", "json"]);
        input(&mut c, path);
        let metadata: Value = serde_json::from_slice(&capture(c, cancel, deadline)?)
            .map_err(|_| "VIDEO_METADATA: invalid JSON")?;
        let streams = metadata["streams"]
            .as_array()
            .ok_or("VIDEO_METADATA: no streams")?;
        let videos: Vec<_> = streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .collect();
        let audios: Vec<_> = streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .collect();
        if videos.len() != 1 || audios.len() > 1 || streams.len() != videos.len() + audios.len() {
            return Err("VIDEO_STREAMS: exactly one video, at most one audio, no subtitle/data/attachment streams".into());
        }
        let v = videos[0];
        if !matches!(v["color_range"].as_str(), Some("tv" | "pc")) {
            return Err("VIDEO_COLOR: unknown source range".into());
        }
        let (tn, td) = rational(
            v["time_base"]
                .as_str()
                .ok_or("VIDEO_TIMING: no time base")?,
        )?;
        if number(v, "start_pts")? != 0 {
            return Err("VIDEO_TIMING: nonzero video start".into());
        }
        let seconds = number(v, "duration_ts")? as f64 * tn as f64 / td as f64;
        if !seconds.is_finite() || seconds <= 0.0 || seconds > 10.0 {
            return Err("VIDEO_LIMIT: known duration at most ten seconds required".into());
        }
        if let Some(a) = audios.first() {
            if number(a, "start_pts")? != 0 {
                return Err("VIDEO_AUDIO: nonzero audio start unsupported".into());
            }
            let (an, ad) = rational(
                a["time_base"]
                    .as_str()
                    .ok_or("VIDEO_AUDIO: missing time base")?,
            )?;
            let duration = number(a, "duration_ts")? as f64 * an as f64 / ad as f64;
            if (duration - seconds).abs() > 0.05 {
                return Err("VIDEO_AUDIO: audio/video duration differs by over 50ms".into());
            }
        }
        let mut c = base("ffprobe");
        c.args([
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=pts,interlaced_frame,width,height,pix_fmt,color_space,color_transfer,color_primaries,color_range,sample_aspect_ratio,side_data_list",
            "-of",
            "json",
        ]);
        input(&mut c, path);
        let frames: Value = serde_json::from_slice(&capture(c, cancel, deadline)?)
            .map_err(|_| "VIDEO_METADATA: invalid frame JSON")?;
        let frames = frames["frames"]
            .as_array()
            .ok_or("VIDEO_TIMING: no frame timestamps")?;
        if frames.len() > 600 {
            return Err("VIDEO_LIMIT: at most 600 frames".into());
        }
        let mut ticks = Vec::with_capacity(frames.len());
        for f in frames {
            if number(f, "interlaced_frame")? != 0 {
                return Err("VIDEO_INTERLACED: interlaced frame".into());
            }
            for key in [
                "width",
                "height",
                "pix_fmt",
                "color_space",
                "color_transfer",
                "color_primaries",
                "color_range",
                "sample_aspect_ratio",
            ] {
                if f[key].is_null() || f[key] != v[key] {
                    return Err(format!("VIDEO_FRAME_METADATA: unknown/changing {key}"));
                }
            }
            if let Some(side) = f.get("side_data_list") {
                for entry in side
                    .as_array()
                    .ok_or("VIDEO_FRAME_METADATA: malformed side data")?
                {
                    let kind = entry["side_data_type"]
                        .as_str()
                        .ok_or("VIDEO_FRAME_METADATA: unknown side data")?;
                    if kind.contains("Mastering display")
                        || kind.contains("Content light")
                        || kind.contains("DOVI")
                        || kind.contains("HDR")
                        || kind.contains("Display Matrix")
                        || entry.get("rotation").is_some()
                    {
                        return Err(
                            "VIDEO_FRAME_METADATA: HDR/rotation frame side data unsupported".into(),
                        );
                    }
                }
            }
            ticks.push(number(f, "pts")?);
        }
        check_ticks(&ticks, tn, td, n, d)?;
        // Require exact stream duration too; never trim or silently manufacture a final frame.
        if i128::from(number(v, "duration_ts")?) * i128::from(tn) * i128::from(n)
            != ticks.len() as i128 * i128::from(d) * i128::from(td)
        {
            return Err("VIDEO_TIMING: stream duration differs from complete CFR frames".into());
        }
        Ok(Probe {
            count: ticks.len(),
            video: v.clone(),
            audio: audios.first().map(|a| (*a).clone()),
            seconds,
        })
    }
    fn transfer_read(
        p: &mut Owned,
        buf: &mut [u8],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<usize, String> {
        let mut used = 0;
        while used < buf.len() {
            guard(cancel, deadline)?;
            p.drain()?;
            match p.child.stdout.as_mut().unwrap().read(&mut buf[used..]) {
                Ok(0) => break,
                Ok(n) => used += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(3))
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => (),
                Err(e) => return Err(io(e)),
            }
        }
        Ok(used)
    }
    fn transfer_write(
        p: &mut Owned,
        bytes: &[u8],
        decoder: &mut Owned,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        let mut used = 0;
        while used < bytes.len() {
            guard(cancel, deadline)?;
            p.drain()?;
            decoder.drain()?;
            match p.child.stdin.as_mut().unwrap().write(&bytes[used..]) {
                Ok(0) => return Err("VIDEO_PIPE: encoder closed pipe".into()),
                Ok(n) => used += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(3))
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => (),
                Err(e) => return Err(io(e)),
            }
        }
        Ok(())
    }
    fn validate_frame(f: &RgbFrame) -> Result<(), String> {
        if f.width == 0
            || f.height == 0
            || f.width > 2048
            || f.height > 2048
            || !f.width.is_multiple_of(2)
            || !f.height.is_multiple_of(2)
            || f.pixels.len() != f.width as usize * f.height as usize * 3
        {
            return Err("VIDEO_PROCESSOR: invalid/eccentric or over-2048 RGB result".into());
        }
        Ok(())
    }
    pub(super) fn run(
        source: &Path,
        output: &Path,
        cancel: &AtomicBool,
        process: &mut impl FnMut(&RgbFrame) -> Result<RgbFrame, String>,
    ) -> Result<StreamResult, String> {
        let deadline = Instant::now() + LIMIT;
        guard(cancel, deadline)?;
        if !source.is_absolute()
            || !output.is_absolute()
            || source
                .components()
                .chain(output.components())
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || output.extension().is_none_or(|x| x != "mp4")
        {
            return Err("VIDEO_PATH: absolute local paths without parent traversal and .mp4 output required".into());
        }
        if fs::symlink_metadata(output).is_ok() {
            return Err("VIDEO_OUTPUT_EXISTS: destination already exists".into());
        }
        let parent = output.parent().ok_or("VIDEO_OUTPUT: missing directory")?;
        let parent_before = fs::metadata(parent).map_err(io)?;
        if !parent_before.is_dir() {
            return Err("VIDEO_OUTPUT: parent not a directory".into());
        }
        let before = identity(source)?;
        // Hold no-follow source open until publication; recheck path and held inode at commit.
        let held = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(source)
            .map_err(io)?;
        let inspected = crate::video_post::inspect_source(source)?;
        guard(cancel, deadline)?;
        if !inspected.blockers.is_empty()
            || inspected.width > 512
            || inspected.height > 512
            || inspected.audio_streams > 1
            || inspected.subtitle_streams != 0
        {
            return Err(format!(
                "VIDEO_UNSUPPORTED: bounded SDR progressive yuv420p BT.709 required; blockers={:?}",
                inspected.blockers
            ));
        }
        let n = inspected.fps_numerator;
        let d = inspected.fps_denominator;
        let original = probe(source, n, d, cancel, deadline)?;
        // Private same-filesystem directory prevents following/clobbering any supplied temp path.
        let stage = tempfile::Builder::new()
            .prefix(".deas-video-")
            .tempdir_in(parent)
            .map_err(io)?;
        let staged = stage.path().join("result.mp4");
        let mut c = base("ffmpeg");
        c.args(["-nostdin", "-xerror", "-noautorotate"]);
        input(&mut c, source);
        c.args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-threads",
            "1",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
        let mut decoder = Owned::spawn(c)?;
        let mut frame = RgbFrame {
            width: inspected.width,
            height: inspected.height,
            pixels: vec![0; inspected.width as usize * inspected.height as usize * 3],
        };
        let mut encoder: Option<Owned> = None;
        let mut dimensions = (0, 0);
        for index in 0..original.count {
            if transfer_read(&mut decoder, &mut frame.pixels, cancel, deadline)?
                != frame.pixels.len()
            {
                return Err("VIDEO_DECODE: short RGB frame".into());
            }
            let processed = process(&frame)?;
            guard(cancel, deadline)?;
            validate_frame(&processed)?;
            if index == 0 {
                dimensions = (processed.width, processed.height);
                let mut c = base("ffmpeg");
                c.args([
                    "-nostdin",
                    "-xerror",
                    "-n",
                    "-filter_threads",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pixel_format",
                    "rgb24",
                    "-video_size",
                    &format!("{}x{}", dimensions.0, dimensions.1),
                    "-framerate",
                    &format!("{n}/{d}"),
                    "-i",
                    "pipe:0",
                ]);
                if original.audio.is_some() {
                    input(&mut c, source);
                }
                c.args(["-map", "0:v:0"]);
                if original.audio.is_some() {
                    c.args(["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]);
                } else {
                    c.arg("-an");
                }
                c.args([
                    "-map_metadata",
                    "-1",
                    "-map_chapters",
                    "-1",
                    "-c:v",
                    "libx264",
                    "-threads",
                    "1",
                    "-preset",
                    "fast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-vf",
                    "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setsar=1",
                    "-color_range",
                    "tv",
                    "-colorspace",
                    "bt709",
                    "-color_trc",
                    "bt709",
                    "-color_primaries",
                    "bt709",
                    "-x264-params",
                    "colorprim=bt709:transfer=bt709:colormatrix=bt709",
                    "-fps_mode",
                    "passthrough",
                    "-fs",
                    "268435456",
                    "-f",
                    "mp4",
                ])
                .arg(&staged)
                .stdin(Stdio::piped())
                .stdout(Stdio::null());
                encoder = Some(Owned::spawn(c)?);
            } else if dimensions != (processed.width, processed.height) {
                return Err("VIDEO_PROCESSOR: changing output dimensions".into());
            }
            transfer_write(
                encoder.as_mut().unwrap(),
                &processed.pixels,
                &mut decoder,
                cancel,
                deadline,
            )?;
        }
        let mut extra = [0];
        if transfer_read(&mut decoder, &mut extra, cancel, deadline)? != 0 {
            return Err("VIDEO_DECODE: extra frames beyond verified timing".into());
        }
        decoder.finish(cancel, deadline)?;
        let mut encoder = encoder.ok_or("VIDEO_PROCESSOR: no frames")?;
        drop(encoder.child.stdin.take());
        encoder.finish(cancel, deadline)?;
        drop(encoder);
        drop(decoder);
        if identity(&staged)?.2 >= CAP {
            return Err("VIDEO_OUTPUT_LIMIT".into());
        }
        let encoded = probe(&staged, n, d, cancel, deadline)?;
        if encoded.count != original.count
            || number(&encoded.video, "width")? != i64::from(dimensions.0)
            || number(&encoded.video, "height")? != i64::from(dimensions.1)
            || encoded.video["codec_name"] != "h264"
            || encoded.video["pix_fmt"] != "yuv420p"
            || encoded.video["color_space"] != "bt709"
            || encoded.video["color_transfer"] != "bt709"
            || encoded.video["color_primaries"] != "bt709"
            || encoded.video["color_range"] != "tv"
            || encoded.video["sample_aspect_ratio"] != "1:1"
            || encoded.audio.is_some() != original.audio.is_some()
            || (encoded.seconds - original.seconds).abs() > 0.000001
        {
            return Err("VIDEO_VERIFY: encoded video contract mismatch".into());
        }
        if let (Some(a), Some(b)) = (&original.audio, &encoded.audio) {
            if b["codec_name"] != "aac"
                || a["channels"] != b["channels"]
                || a["sample_rate"] != b["sample_rate"]
            {
                return Err("VIDEO_VERIFY: audio contract mismatch".into());
            }
        }
        // Decode *all* completed video/audio packets before publishing, not only its headers.
        let mut c = base("ffmpeg");
        c.args(["-nostdin", "-xerror"]);
        input(&mut c, &staged);
        c.args(["-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        Owned::spawn(c)?.finish(cancel, deadline)?;
        File::open(&staged).map_err(io)?.sync_all().map_err(io)?;
        let held_meta = held.metadata().map_err(io)?;
        let current_parent = fs::metadata(parent).map_err(io)?;
        if identity(source)? != before
            || held_meta.dev() != before.0
            || held_meta.ino() != before.1
            || held_meta.len() != before.2
            || held_meta.mtime() != before.3
            || held_meta.mtime_nsec() != before.4
            || held_meta.ctime() != before.5
            || held_meta.ctime_nsec() != before.6
            || current_parent.dev() != parent_before.dev()
            || current_parent.ino() != parent_before.ino()
        {
            return Err("VIDEO_CHANGED: source or destination directory changed".into());
        }
        guard(cancel, deadline)?;
        // link(2) is atomic no-replace, including an existing symlink. No rename fallback.
        fs::hard_link(&staged, output).map_err(io)?;
        Ok(StreamResult {
            frames: original.count,
            width: dimensions.0,
            height: dimensions.1,
        })
    }

    #[cfg(test)]
    mod process_tests {
        use super::*;
        #[test]
        #[ignore = "real native ffmpeg timeout/process-group cleanup"]
        fn owned_ffmpeg_timeout_kills_and_reaps_only_owned_leader() {
            let mut c = base("ffmpeg");
            c.args([
                "-nostdin",
                "-re",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=16x16:rate=25",
                "-f",
                "null",
                "-",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null());
            let mut child = Owned::spawn(c).unwrap();
            let pid = child.child.id() as i32;
            let result = child.finish(
                &AtomicBool::new(false),
                Instant::now() + Duration::from_millis(100),
            );
            assert!(result.unwrap_err().contains("TIMEOUT"));
            drop(child);
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            let mut status = 0;
            assert_eq!(
                unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
        }
    }
}

#[cfg(test)]
#[path = "video_stream_tests.rs"]
mod tests;
