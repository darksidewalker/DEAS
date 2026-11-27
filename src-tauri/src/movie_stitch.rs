//! Movie Maker film stitching with blends (UX-22d7f): joins the scene clips in order with FFmpeg when at least one transition is a
//! *Blend* — a crossfade of picture (`xfade`) and sound (`acrossfade`) — and hard cuts (`concat`) elsewhere. Without blends the Join
//! clips recipe on the backend stays the stitcher. Every clip is brought to the first clip's canvas, 24 fps and 48 kHz stereo; a clip
//! without sound gets silence of its own length. The result is written next to the first clip under a fresh name, never overwriting.
use crate::video_post::{inspect_source, run_tool};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};

const CLIP_EXT: [&str; 4] = ["mp4", "mov", "mkv", "webm"];
const MAX_CLIPS: usize = 60;
const MAX_FILM_SECONDS: f64 = 3600.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StitchRequest {
    /// Absolute clip paths in film order.
    pub clips: Vec<String>,
    /// One entry per boundary (`clips.len() - 1`): crossfade seconds into the next clip, or `None` for a hard cut.
    pub blends: Vec<Option<f64>>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StitchResult {
    pub path: String,
    pub seconds: f64,
}
fn fail(code: &str) -> String {
    code.to_owned()
}
fn extension(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}
#[derive(Debug, PartialEq)]
pub struct Clip {
    pub path: PathBuf,
    pub seconds: f64,
    pub has_audio: bool,
}
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub clips: Vec<Clip>,
    pub blends: Vec<Option<f64>>,
    pub width: u32,
    pub height: u32,
    pub seconds: f64,
}
/// The film's length: the clips' lengths minus every crossfade.
pub fn film_seconds(clips: &[f64], blends: &[Option<f64>]) -> f64 {
    clips.iter().sum::<f64>() - blends.iter().flatten().sum::<f64>()
}
/// Checks the boundaries against the clip lengths: a crossfade is 0.25–3 s and at most half of either clip it joins.
pub fn check_blends(clips: &[f64], blends: &[Option<f64>]) -> Result<(), String> {
    if clips.len() < 2 || blends.len() != clips.len() - 1 {
        return Err(fail("MOVIE_STITCH_PLAN"));
    }
    for (n, b) in blends.iter().enumerate() {
        if let Some(b) = b {
            if !b.is_finite()
                || !(0.25..=3.0).contains(b)
                || *b > clips[n] / 2.0
                || *b > clips[n + 1] / 2.0
            {
                return Err(fail("MOVIE_STITCH_BLEND"));
            }
        }
    }
    Ok(())
}
pub fn plan(req: &StitchRequest) -> Result<Plan, String> {
    if req.clips.len() < 2 || req.clips.len() > MAX_CLIPS || req.blends.len() + 1 != req.clips.len()
    {
        return Err(fail("MOVIE_STITCH_PLAN"));
    }
    let mut clips = Vec::with_capacity(req.clips.len());
    let (mut width, mut height) = (0, 0);
    for raw in &req.clips {
        let path = PathBuf::from(raw);
        if !path.is_absolute()
            || !std::fs::metadata(&path).is_ok_and(|m| m.is_file())
            || !CLIP_EXT.contains(&extension(&path).as_str())
        {
            return Err(fail("MOVIE_STITCH_CLIP"));
        }
        let info = inspect_source(&path).map_err(|_| fail("MOVIE_STITCH_CLIP"))?;
        let seconds = info
            .duration_seconds
            .filter(|s| *s > 0.0 && *s <= MAX_FILM_SECONDS)
            .ok_or_else(|| fail("MOVIE_STITCH_CLIP"))?;
        if info.width == 0 || info.height == 0 {
            return Err(fail("MOVIE_STITCH_CLIP"));
        }
        if clips.is_empty() {
            (width, height) = (info.width, info.height);
        }
        clips.push(Clip {
            path,
            seconds,
            has_audio: info.audio_streams > 0,
        });
    }
    let lengths: Vec<f64> = clips.iter().map(|c| c.seconds).collect();
    check_blends(&lengths, &req.blends)?;
    let seconds = film_seconds(&lengths, &req.blends);
    Ok(Plan {
        clips,
        blends: req.blends.clone(),
        width: width & !1,
        height: height & !1,
        seconds,
    })
}
/// The FFmpeg filter graph; outputs `[vout]` and `[aout]`.
pub fn graph(p: &Plan) -> String {
    let (w, h) = (p.width, p.height);
    let mut g: Vec<String> = Vec::new();
    for (i, c) in p.clips.iter().enumerate() {
        g.push(format!(
            "[{i}:v:0]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p,setsar=1,settb=AVTB[v{i}]"
        ));
        g.push(if c.has_audio {
            format!(
                "[{i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
            )
        } else {
            format!(
                "aevalsrc=0|0:c=stereo:s=48000:d={:.3},aformat=sample_fmts=fltp[a{i}]",
                c.seconds
            )
        });
    }
    let (mut v, mut a, mut length) = ("v0".to_owned(), "a0".to_owned(), p.clips[0].seconds);
    for (n, blend) in p.blends.iter().enumerate() {
        let i = n + 1;
        let (nv, na) = (format!("vx{i}"), format!("ax{i}"));
        match blend {
            Some(b) => {
                g.push(format!(
                    "[{v}][v{i}]xfade=transition=fade:duration={b:.3}:offset={:.3}[{nv}]",
                    length - b
                ));
                g.push(format!("[{a}][a{i}]acrossfade=d={b:.3}[{na}]"));
                length += p.clips[i].seconds - b;
            }
            None => {
                g.push(format!(
                    "[{v}][{a}][v{i}][a{i}]concat=n=2:v=1:a=1[{nv}][{na}]"
                ));
                length += p.clips[i].seconds;
            }
        }
        (v, a) = (nv, na);
    }
    g.push(format!("[{v}]null[vout]"));
    g.push(format!("[{a}]anull[aout]"));
    g.join(";")
}
pub fn args(p: &Plan, output: &Path) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
    ]
    .iter()
    .map(Into::into)
    .collect();
    for c in &p.clips {
        a.push("-i".into());
        a.push(c.path.clone().into());
    }
    a.push("-filter_complex".into());
    a.push(graph(p).into());
    a.extend(
        [
            "-map",
            "[vout]",
            "-map",
            "[aout]",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-n",
        ]
        .iter()
        .map(std::ffi::OsString::from),
    );
    a.push(output.into());
    a
}
/// `film.mp4`, then `film-2.mp4` …, next to the first clip; never an existing file.
fn fresh_names(first: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    (1..200).map(move |n| {
        first.with_file_name(if n == 1 {
            "film.mp4".to_owned()
        } else {
            format!("film-{n}.mp4")
        })
    })
}
pub fn stitch(req: &StitchRequest, cancel: &AtomicBool) -> Result<StitchResult, String> {
    let p = plan(req)?;
    let first = p.clips[0].path.clone();
    let partial = first.with_file_name(format!(".film-{}.partial.mp4", std::process::id()));
    let _ = std::fs::remove_file(&partial);
    let mut command = Command::new("ffmpeg");
    command.args(args(&p, &partial));
    let result = run_tool(
        command,
        Duration::from_secs(900 + (p.seconds * 20.0) as u64),
        cancel,
        None,
    );
    if let Err(e) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(if e.starts_with("VIDEO_TOOL_MISSING") {
            fail("MOVIE_STITCH_TOOL")
        } else if e.starts_with("AUDIO_CANCELLED") {
            fail("MOVIE_STITCH_CANCELLED")
        } else {
            fail("MOVIE_STITCH_FFMPEG")
        });
    }
    for target in fresh_names(&first) {
        match std::fs::hard_link(&partial, &target) {
            Ok(()) => {
                let _ = std::fs::remove_file(&partial);
                return Ok(StitchResult {
                    path: target.to_string_lossy().into_owned(),
                    seconds: (p.seconds * 1000.0).round() / 1000.0,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => break,
        }
    }
    let _ = std::fs::remove_file(&partial);
    Err(fail("MOVIE_STITCH_WRITE"))
}
#[tauri::command]
pub async fn native_movie_stitch(request: StitchRequest) -> Result<StitchResult, String> {
    let out =
        tauri::async_runtime::spawn_blocking(move || stitch(&request, &AtomicBool::new(false)))
            .await
            .map_err(|_| fail("MOVIE_STITCH_FFMPEG"))?;
    match &out {
        Ok(r) => crate::logs::push(
            crate::logs::Source::Deas,
            &format!(
                "INFO: Movie Maker stitched the film with blends seconds={:.3}",
                r.seconds
            ),
        ),
        Err(code) => crate::logs::push(
            crate::logs::Source::Deas,
            &format!("WARN: Movie Maker film stitch failed code={code}"),
        ),
    }
    out
}

#[cfg(test)]
#[path = "movie_stitch_tests.rs"]
mod tests;
