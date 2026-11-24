//! Cover source preflight: before a YuE2 cover uploads its audio/video source, ffprobe confirms an audio
//! stream and bounds the PCM that core `LoadAudio` will decode in one piece (float32, all channels, the
//! whole file). Only the output FLAC was bounded before; a sound-less video or a multi-hour recording
//! reached the backend and failed or exhausted memory there.
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// Same bounds as a returned FLAC (`jobs_outputs.rs`): 15 minutes and 768 MiB of float32 PCM.
pub(crate) const COVER_MAX_SECONDS: f64 = 900.0;
pub(crate) const COVER_PCM_LIMIT: u64 = 768 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverSource {
    pub seconds: f64,
    pub sample_rate: u64,
    pub channels: u64,
    /// Bytes of float32 PCM `LoadAudio` holds for this file.
    pub pcm_bytes: u64,
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite() && *n > 0.0)
}

/// Judges ffprobe's JSON for the first audio stream. Pure, so the rules are tested without media.
pub(crate) fn assess(probe: &Value, name: &str) -> Result<CoverSource, String> {
    let Some(stream) = probe["streams"].as_array().and_then(|s| s.first()) else {
        return Err(format!(
            "MUSIC_SOURCE: \"{name}\" has no audio stream, so there is no melody to cover. Choose an audio file or a video with sound."
        ));
    };
    let sample_rate = number(&stream["sample_rate"]).map(|r| r as u64);
    let channels = stream["channels"].as_u64().filter(|c| *c > 0);
    let (Some(sample_rate), Some(channels)) = (sample_rate, channels) else {
        return Err(format!(
            "MUSIC_SOURCE: The audio of \"{name}\" has no readable sample rate or channel count; convert it to WAV, FLAC or MP3 and try again."
        ));
    };
    let Some(seconds) =
        number(&stream["duration"]).or_else(|| number(&probe["format"]["duration"]))
    else {
        return Err(format!(
            "MUSIC_SOURCE: The length of \"{name}\" cannot be read, so its decoded size cannot be bounded; convert it to WAV, FLAC or MP3 and try again."
        ));
    };
    let pcm_bytes = (seconds * sample_rate as f64).ceil() as u64 * channels * 4;
    if seconds > COVER_MAX_SECONDS || pcm_bytes > COVER_PCM_LIMIT {
        return Err(format!(
            "MUSIC_SOURCE: \"{name}\" lasts {:.1} min ({sample_rate} Hz, {channels} channel(s)); a cover source may last at most {} min and decode to at most {} MiB (this one needs {} MiB). Trim it to the part you want covered, or mix it down to stereo.",
            seconds / 60.0,
            COVER_MAX_SECONDS / 60.0,
            COVER_PCM_LIMIT >> 20,
            pcm_bytes.div_ceil(1 << 20)
        ));
    }
    Ok(CoverSource {
        seconds,
        sample_rate,
        channels,
        pcm_bytes,
    })
}

fn probe(path: &Path) -> Result<Value, String> {
    let mut command = Command::new("ffprobe");
    command
        .args(["-v", "error", "-protocol_whitelist", "file"])
        .args(["-select_streams", "a:0"])
        .args([
            "-show_entries",
            "stream=sample_rate,channels,duration:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .stdin(std::process::Stdio::null());
    let out = crate::video_post::run_tool(
        command,
        Duration::from_secs(10),
        &AtomicBool::new(false),
        None,
    )
    .map_err(|e| {
        if e.starts_with("VIDEO_TOOL_MISSING") {
            "MUSIC_SOURCE: FFmpeg is not installed. Install FFmpeg (with ffprobe) and make it available on PATH, then restart DEAS.".to_string()
        } else if e.contains("TIMEOUT") {
            "MUSIC_SOURCE: Reading the cover source took too long and was stopped; try a shorter or repaired file.".to_string()
        } else {
            "MUSIC_SOURCE: FFmpeg could not read the cover source; the file may be damaged or in a format FFmpeg cannot decode.".to_string()
        }
    })?;
    serde_json::from_slice(&out).map_err(|_| {
        "MUSIC_SOURCE: FFmpeg returned unreadable metadata for the cover source.".into()
    })
}

/// Checks a local cover source before it is uploaded; nothing is decoded, copied or sent.
#[tauri::command]
pub async fn native_music_source_check(path: String) -> Result<CoverSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&path);
        if !source.is_file() {
            return Err("MUSIC_SOURCE: The cover source file no longer exists.".to_string());
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("source");
        let result = probe(source).and_then(|p| assess(&p, name));
        if let Err(e) = &result {
            crate::logs::push(
                crate::logs::Source::Deas,
                &format!("WARNING: Music operation=cover-source-check refused: {e}"),
            );
        }
        result
    })
    .await
    .map_err(|_| "MUSIC_SOURCE: The cover source check stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_short_stereo_song_passes_with_its_decoded_size() {
        let p = json!({"streams":[{"sample_rate":"44100","channels":2,"duration":"180.000000"}],"format":{"duration":"180.02"}});
        let s = assess(&p, "song.mp3").unwrap();
        assert_eq!((s.sample_rate, s.channels), (44100, 2));
        assert_eq!(s.pcm_bytes, 180 * 44100 * 2 * 4);
    }

    #[test]
    fn a_video_without_sound_names_the_file_and_what_to_choose() {
        let e = assess(
            &json!({"streams":[],"format":{"duration":"12.0"}}),
            "clip.mp4",
        )
        .unwrap_err();
        assert!(e.contains("\"clip.mp4\" has no audio stream"), "{e}");
        assert!(e.contains("Choose an audio file or a video with sound"));
        assert!(assess(&json!({"format":{}}), "x.mkv").is_err());
    }

    #[test]
    fn the_container_duration_is_used_when_the_stream_has_none() {
        let p =
            json!({"streams":[{"sample_rate":"48000","channels":1}],"format":{"duration":"10.5"}});
        assert_eq!(assess(&p, "a.webm").unwrap().seconds, 10.5);
    }

    #[test]
    fn unknown_length_rate_or_channels_are_refused_rather_than_guessed() {
        let no_length = json!({"streams":[{"sample_rate":"48000","channels":2}],"format":{}});
        assert!(assess(&no_length, "a.ogg")
            .unwrap_err()
            .contains("cannot be read"));
        let no_rate = json!({"streams":[{"sample_rate":"0","channels":2,"duration":"3"}]});
        assert!(assess(&no_rate, "a.ogg")
            .unwrap_err()
            .contains("sample rate"));
        let no_channels = json!({"streams":[{"sample_rate":"48000","duration":"3"}]});
        assert!(assess(&no_channels, "a.ogg").is_err());
    }

    #[test]
    #[ignore = "requires installed FFmpeg/FFprobe with libx264"]
    fn real_ffprobe_accepts_the_tone_and_refuses_a_silent_video() {
        let tone = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/music/tone.flac");
        let s = assess(&probe(&tone).unwrap(), "tone.flac").unwrap();
        assert!(s.seconds > 0.0 && s.sample_rate > 0 && s.channels > 0);
        let dir = tempfile::tempdir().unwrap();
        let silent = dir.path().join("silent ü.mp4");
        let made = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x48:r=24",
            ])
            .args(["-frames:v", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&silent)
            .status()
            .unwrap();
        assert!(made.success());
        let e = assess(&probe(&silent).unwrap(), "silent ü.mp4").unwrap_err();
        assert!(e.contains("has no audio stream"), "{e}");
    }

    #[test]
    fn too_long_or_too_large_sources_are_refused_with_the_numbers() {
        let long = json!({"streams":[{"sample_rate":"44100","channels":2,"duration":"901"}]});
        let e = assess(&long, "concert.flac").unwrap_err();
        assert!(
            e.contains("15.0 min") && e.contains("at most 15 min") && e.contains("Trim it"),
            "{e}"
        );
        // 10 min of 8 channels at 96 kHz is under 15 min but decodes to ~1.7 GiB.
        let wide = json!({"streams":[{"sample_rate":"96000","channels":8,"duration":"600"}]});
        let e = assess(&wide, "master.wav").unwrap_err();
        assert!(e.contains("768 MiB") && e.contains("1758 MiB"), "{e}");
        // Exactly at the time limit with modest PCM passes.
        let edge = json!({"streams":[{"sample_rate":"48000","channels":2,"duration":"900"}]});
        assert!(assess(&edge, "edge.wav").is_ok());
    }
}
