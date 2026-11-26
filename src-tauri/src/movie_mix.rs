//! Movie Maker music bed (UX-22d5b): mixes one music file onto the joined film with FFmpeg. The video stream is copied (never
//! re-encoded), the music is looped and cut to the film's length with a fade-out and ducked by the film's own sound when it has any
//! (the speech H3 generated stays audible), and the result is written next to the film under a fresh name — nothing is overwritten.
use crate::video_post::{inspect_source, run_tool};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};

const FILM_EXT: [&str; 4] = ["mp4", "mov", "mkv", "webm"];
const MUSIC_EXT: [&str; 8] = ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "wma"];
const MAX_FILM_SECONDS: f64 = 3600.0;
const MAX_MUSIC_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Integrated loudness (LUFS) the music is normalised to before its level is applied.
const LOUDNESS_TARGET: i32 = -24;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixRequest {
    pub film: String,
    pub music: String,
    /// Music level against its own file, dB (−40…6).
    pub level_db: f64,
    /// How strongly the music is pushed down under the film's own sound, dB (0 = not at all, up to 30).
    pub duck_db: f64,
    /// Fade-out at the end, seconds (0…10, at most half the film).
    pub fade_seconds: f64,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixResult {
    pub path: String,
    pub seconds: f64,
    pub ducked: bool,
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
fn regular(p: &Path) -> bool {
    p.is_absolute() && std::fs::metadata(p).is_ok_and(|m| m.is_file())
}
/// Everything a mix needs, after the inputs were checked.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub film: PathBuf,
    pub music: PathBuf,
    pub seconds: f64,
    pub has_audio: bool,
    pub level_db: f64,
    pub duck_db: f64,
    pub fade: f64,
}
fn finite(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && (lo..=hi).contains(&v)
}
pub fn plan(req: &MixRequest) -> Result<Plan, String> {
    if !finite(req.level_db, -40.0, 6.0)
        || !finite(req.duck_db, 0.0, 30.0)
        || !finite(req.fade_seconds, 0.0, 10.0)
    {
        return Err(fail("MOVIE_MIX_SETTINGS"));
    }
    let (film, music) = (PathBuf::from(&req.film), PathBuf::from(&req.music));
    if !regular(&film) || !FILM_EXT.contains(&extension(&film).as_str()) {
        return Err(fail("MOVIE_MIX_FILM"));
    }
    if !regular(&music)
        || !MUSIC_EXT.contains(&extension(&music).as_str())
        || std::fs::metadata(&music).map_or(true, |m| m.len() > MAX_MUSIC_BYTES)
    {
        return Err(fail("MOVIE_MIX_MUSIC"));
    }
    let info = inspect_source(&film).map_err(|_| fail("MOVIE_MIX_FILM"))?;
    let seconds = info
        .duration_seconds
        .filter(|s| *s > 0.0 && *s <= MAX_FILM_SECONDS)
        .ok_or_else(|| fail("MOVIE_MIX_FILM"))?;
    if info.width == 0 || info.height == 0 {
        return Err(fail("MOVIE_MIX_FILM"));
    }
    let mut probe = Command::new("ffprobe");
    probe
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            "-i",
        ])
        .arg(&music);
    let out = run_tool(
        probe,
        Duration::from_secs(60),
        &AtomicBool::new(false),
        None,
    )
    .map_err(|_| fail("MOVIE_MIX_MUSIC"))?;
    if !String::from_utf8_lossy(&out).contains("audio") {
        return Err(fail("MOVIE_MIX_MUSIC"));
    }
    Ok(Plan {
        film,
        music,
        seconds,
        has_audio: info.audio_streams > 0,
        level_db: req.level_db,
        duck_db: req.duck_db,
        fade: req.fade_seconds.min(seconds / 2.0),
    })
}
/// The FFmpeg filter graph; output label `[aout]`. Music: level, fade-out. Film sound present: the music is compressed by the film's
/// own audio (sidechain) and both are summed without normalising, so speech keeps its level.
pub fn graph(p: &Plan) -> String {
    let fade = if p.fade > 0.0 {
        format!(",afade=t=out:st={:.3}:d={:.3}", p.seconds - p.fade, p.fade)
    } else {
        String::new()
    };
    // The track is first brought to a fixed loudness, so the level setting means the same for a quiet generated track and a loud
    // mastered one (measured: an ACE-Step track sits near -34 dB RMS, a mastered song 20 dB higher).
    let music = format!(
        "[1:a:0]loudnorm=I={LOUDNESS_TARGET}:TP=-2:LRA=11,aresample=48000,volume={:.2}dB{fade}",
        p.level_db
    );
    if !p.has_audio {
        return format!("{music}[aout]");
    }
    if p.duck_db <= 0.0 {
        return format!("{music}[m];[0:a:0][m]amix=inputs=2:duration=first:normalize=0[aout]");
    }
    let ratio = (1.0 + p.duck_db / 2.0).clamp(1.0, 20.0);
    format!(
        "{music}[m];[0:a:0]asplit=2[orig][sc];[m][sc]sidechaincompress=threshold=0.03:ratio={ratio:.1}:attack=20:release=300:makeup=1[duck];[orig][duck]amix=inputs=2:duration=first:normalize=0[aout]"
    )
}
pub fn args(p: &Plan, output: &Path) -> Vec<std::ffi::OsString> {
    let ext = extension(&p.film);
    let codec = if ext == "webm" { "libopus" } else { "aac" };
    let mut a: Vec<std::ffi::OsString> = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
    ]
    .iter()
    .map(Into::into)
    .collect();
    a.push(p.film.clone().into());
    a.extend(
        ["-stream_loop", "-1", "-i"]
            .iter()
            .map(std::ffi::OsString::from),
    );
    a.push(p.music.clone().into());
    a.extend(["-filter_complex"].iter().map(std::ffi::OsString::from));
    a.push(graph(p).into());
    a.extend(
        [
            "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", codec, "-b:a", "192k", "-t",
        ]
        .iter()
        .map(std::ffi::OsString::from),
    );
    a.push(format!("{:.3}", p.seconds).into());
    if matches!(ext.as_str(), "mp4" | "mov") {
        a.extend(
            ["-movflags", "+faststart"]
                .iter()
                .map(std::ffi::OsString::from),
        );
    }
    a.push("-n".into());
    a.push(output.into());
    a
}
/// `<stem>-scored.<ext>`, then `-scored-2` …, in the film's folder; never an existing file.
fn fresh_names(film: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    let stem = film
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("film")
        .to_owned();
    let ext = extension(film);
    (1..100).map(move |n| {
        film.with_file_name(if n == 1 {
            format!("{stem}-scored.{ext}")
        } else {
            format!("{stem}-scored-{n}.{ext}")
        })
    })
}
pub fn mix(req: &MixRequest, cancel: &AtomicBool) -> Result<MixResult, String> {
    let p = plan(req)?;
    let ext = extension(&p.film);
    let partial = p.film.with_file_name(format!(
        ".{}.mix-{}.partial.{ext}",
        p.film
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("film"),
        std::process::id()
    ));
    let mut command = Command::new("ffmpeg");
    command.args(args(&p, &partial));
    let _ = std::fs::remove_file(&partial);
    let result = run_tool(
        command,
        Duration::from_secs(600 + (p.seconds * 4.0) as u64),
        cancel,
        None,
    );
    if let Err(e) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(if e.starts_with("VIDEO_TOOL_MISSING") {
            fail("MOVIE_MIX_TOOL")
        } else if e.starts_with("AUDIO_CANCELLED") {
            fail("MOVIE_MIX_CANCELLED")
        } else {
            fail("MOVIE_MIX_FFMPEG")
        });
    }
    // Publish without ever replacing a file: a hard link fails when the name exists, then the next name is tried.
    for target in fresh_names(&p.film) {
        match std::fs::hard_link(&partial, &target) {
            Ok(()) => {
                let _ = std::fs::remove_file(&partial);
                return Ok(MixResult {
                    path: target.to_string_lossy().into_owned(),
                    seconds: p.seconds,
                    ducked: p.has_audio && p.duck_db > 0.0,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => break,
        }
    }
    let _ = std::fs::remove_file(&partial);
    Err(fail("MOVIE_MIX_WRITE"))
}
fn report(code: &str) {
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("WARN: Movie Maker music mix failed code={code}"),
    );
}
/// Choose…: a music file from disk, by path (nothing copied); `None` on cancel.
#[tauri::command]
pub async fn native_movie_pick_music(title: String) -> Result<Option<String>, String> {
    if title.trim().is_empty() || title.len() > 240 || title.chars().any(char::is_control) {
        return Err(fail("MOVIE_MIX_DIALOG"));
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title(title)
        .add_filter("Audio", &MUSIC_EXT)
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    file.path()
        .to_str()
        .map(|p| Some(p.to_owned()))
        .ok_or_else(|| fail("MOVIE_MIX_MUSIC"))
}
#[tauri::command]
pub async fn native_movie_mix(request: MixRequest) -> Result<MixResult, String> {
    let out = tauri::async_runtime::spawn_blocking(move || mix(&request, &AtomicBool::new(false)))
        .await
        .map_err(|_| fail("MOVIE_MIX_FFMPEG"))?;
    match &out {
        Ok(_) => crate::logs::push(crate::logs::Source::Deas, "INFO: Movie Maker music mix finished; the film's own audio was kept and the original film is unchanged"),
        Err(code) => report(code),
    }
    out
}

#[cfg(test)]
#[path = "movie_mix_tests.rs"]
mod tests;
