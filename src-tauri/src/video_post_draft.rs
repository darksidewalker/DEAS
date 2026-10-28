//! Metadata-only output drafts; never execution authority or encoder discovery.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftSource {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub audio_streams: u32,
    pub subtitle_streams: u32,
    pub blockers: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftSettings {
    pub scale: u32,
    pub profile: DraftProfile,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum DraftProfile {
    #[serde(rename = "mp4-h264")]
    Mp4H264,
    #[serde(rename = "mkv-h264")]
    MkvH264,
    #[serde(rename = "webm-vp9")]
    WebmVp9,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOutput {
    pub filename: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub container: &'static str,
    pub video_encoder: &'static str,
    pub pixel_format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_encoder: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_bitrate: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPostDraft {
    pub kind: &'static str,
    pub version: u32,
    pub source: DraftSource,
    pub settings: DraftSettings,
    pub output: DraftOutput,
    pub blockers: Vec<String>,
    pub processing_ready: bool,
    pub timing_verified: bool,
    pub encoder_verified: bool,
}

#[tauri::command]
pub fn native_video_post_draft(
    source: DraftSource,
    settings: DraftSettings,
) -> Result<VideoPostDraft, String> {
    let id = uuid::Uuid::new_v4();
    let result = build_draft(source, settings);
    let (severity, outcome) = if result.is_ok() {
        ("INFO", "drafted")
    } else {
        ("ERROR", "failed")
    };
    // Keep caller metadata and error details out of shared Logs.
    crate::logs::push(
        crate::logs::Source::Deas,
        &format!("{severity}: video-post operation=draft operationId={id} outcome={outcome}"),
    );
    result
}

const SOURCE_BLOCKERS: [&str; 12] = [
    "cadenceUnknown",
    "cadenceMismatch",
    "interlaced",
    "fieldOrderUnknown",
    "rotation",
    "alpha",
    "hdr",
    "colorUnknown",
    "unsupportedPixelFormat",
    "unsupportedDimensions",
    "nonSquarePixels",
    "pixelAspectUnknown",
];

pub(crate) fn build_draft(
    mut source: DraftSource,
    settings: DraftSettings,
) -> Result<VideoPostDraft, String> {
    if source.name.trim().is_empty()
        || source.name.len() > 1024
        || matches!(source.name.as_str(), "." | "..")
        || source.name.contains(['/', '\\', ':'])
        || source.name.chars().any(char::is_control)
    {
        return Err("VIDEO_DRAFT_NAME: Use a nonempty basename of at most 1024 bytes without paths or controls.".into());
    }
    if !(1..=65536).contains(&source.width) || !(1..=65536).contains(&source.height) {
        return Err(
            "VIDEO_DRAFT_DIMENSIONS: Source dimensions must be integers from 1 through 65536."
                .into(),
        );
    }
    if source.fps_denominator == 0
        || u64::from(source.fps_numerator) > 1000 * u64::from(source.fps_denominator)
    {
        return Err("VIDEO_DRAFT_FPS: Use a nonnegative rational rate with a positive denominator, at most 1000 fps.".into());
    }
    if source.audio_streams > 256 || source.subtitle_streams > 256 {
        return Err("VIDEO_DRAFT_STREAMS: Stream counts must not exceed 256 each.".into());
    }
    if source.blockers.len() > SOURCE_BLOCKERS.len()
        || source
            .blockers
            .iter()
            .any(|code| !SOURCE_BLOCKERS.contains(&code.as_str()))
    {
        return Err(
            "VIDEO_DRAFT_BLOCKERS: Use at most 12 known source-inspection blocker codes.".into(),
        );
    }
    if !matches!(settings.scale, 1 | 2 | 4) {
        return Err("VIDEO_DRAFT_SCALE: Use an exact scale of 1, 2 or 4.".into());
    }
    let (mut a, mut b) = (source.fps_numerator, source.fps_denominator);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    source.fps_numerator /= a;
    source.fps_denominator /= a;
    let (filename, container, video_encoder, audio_encoder) = match settings.profile {
        DraftProfile::Mp4H264 => ("processed.mp4", "mp4", "libx264", "aac"),
        DraftProfile::MkvH264 => ("processed.mkv", "mkv", "libx264", "aac"),
        DraftProfile::WebmVp9 => ("processed.webm", "webm", "libvpx-vp9", "libopus"),
    };
    let output = DraftOutput {
        filename,
        width: source
            .width
            .checked_mul(settings.scale)
            .ok_or("VIDEO_DRAFT_DIMENSIONS: Target dimensions overflow.")?,
        height: source
            .height
            .checked_mul(settings.scale)
            .ok_or("VIDEO_DRAFT_DIMENSIONS: Target dimensions overflow.")?,
        fps_numerator: source.fps_numerator,
        fps_denominator: source.fps_denominator,
        container,
        video_encoder,
        pixel_format: "yuv420p",
        audio_encoder: (source.audio_streams > 0).then_some(audio_encoder),
        audio_bitrate: (source.audio_streams > 0).then_some(192000),
    };
    let mut blockers = source.blockers.clone();
    let mut block = |code: &str| {
        if !blockers.iter().any(|b| b == code) {
            blockers.push(code.into());
        }
    };
    if source.fps_numerator == 0 {
        block("cadenceUnknown");
    }
    let pixels = u64::from(output.width)
        .checked_mul(u64::from(output.height))
        .ok_or("VIDEO_DRAFT_DIMENSIONS: Target pixel count overflow.")?;
    if output.width > 8192
        || output.height > 8192
        || !output.width.is_multiple_of(2)
        || !output.height.is_multiple_of(2)
        || pixels > 33_177_600
    {
        block("outputDimensions");
    }
    if source.subtitle_streams > 0 {
        block("subtitlesUnsupported");
    }
    Ok(VideoPostDraft {
        kind: "deas-video-post-draft",
        version: 1,
        blockers,
        source,
        settings,
        output,
        processing_ready: false,
        timing_verified: false,
        encoder_verified: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn source() -> DraftSource {
        serde_json::from_value(json!({"name":"source ü.mp4","width":1920,"height":1080,
            "fpsNumerator":30000,"fpsDenominator":1001,"audioStreams":1,
            "subtitleStreams":0,"blockers":[]}))
        .unwrap()
    }
    fn settings(scale: u32, profile: DraftProfile) -> DraftSettings {
        DraftSettings { scale, profile }
    }
    #[test]
    fn exact_ntsc_double_scale_schema() {
        let result = build_draft(source(), settings(2, DraftProfile::Mp4H264)).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "kind":"deas-video-post-draft","version":1,
                "source":{"name":"source ü.mp4","width":1920,"height":1080,
                    "fpsNumerator":30000,"fpsDenominator":1001,"audioStreams":1,
                    "subtitleStreams":0,"blockers":[]},
                "settings":{"scale":2,"profile":"mp4-h264"},
                "output":{"filename":"processed.mp4","width":3840,"height":2160,
                    "fpsNumerator":30000,"fpsDenominator":1001,"container":"mp4",
                    "videoEncoder":"libx264","pixelFormat":"yuv420p",
                    "audioEncoder":"aac","audioBitrate":192000},
                "blockers":[],"processingReady":false,"timingVerified":false,"encoderVerified":false
            })
        );
    }

    #[test]
    fn normalizes_rationals_without_changing_cadence() {
        for (n, d, expected) in [
            (60000, 2002, (30000, 1001)),
            (0, u32::MAX, (0, 1)),
            (u32::MAX, u32::MAX, (1, 1)),
            (1000, 1, (1000, 1)),
        ] {
            let mut s = source();
            s.fps_numerator = n;
            s.fps_denominator = d;
            let draft = build_draft(s, settings(1, DraftProfile::Mp4H264)).unwrap();
            assert_eq!(
                (draft.source.fps_numerator, draft.source.fps_denominator),
                expected
            );
            assert_eq!(
                (draft.output.fps_numerator, draft.output.fps_denominator),
                expected
            );
            assert_eq!(draft.blockers.contains(&"cadenceUnknown".into()), n == 0);
        }
    }

    #[test]
    fn exact_dimensions_block_instead_of_rounding_or_capping() {
        for (w, h, scale, ow, oh, blocked) in [
            (1920, 1080, 4, 7680, 4320, false),
            (1921, 1080, 4, 7684, 4320, true),
            (8192, 4096, 1, 8192, 4096, true),
            (8192, 4000, 1, 8192, 4000, false),
            (8194, 16, 1, 8194, 16, true),
            (1921, 1081, 1, 1921, 1081, true),
            (1921, 1081, 2, 3842, 2162, false),
            (65536, 65536, 4, 262144, 262144, true),
        ] {
            let mut s = source();
            s.width = w;
            s.height = h;
            let draft = build_draft(s, settings(scale, DraftProfile::Mp4H264)).unwrap();
            assert_eq!((draft.output.width, draft.output.height), (ow, oh));
            assert_eq!(
                draft.blockers.contains(&"outputDimensions".into()),
                blocked,
                "{w}x{h} scale {scale}"
            );
        }
    }

    #[test]
    fn rejects_invalid_values_with_fixed_errors() {
        let base = serde_json::to_value(source()).unwrap();
        for (key, value) in [
            ("name", json!("")),
            ("name", json!(" ")),
            ("name", json!(".")),
            ("name", json!("..")),
            ("name", json!("/secret.mp4")),
            ("name", json!("sub/secret.mp4")),
            ("name", json!("C:\\secret.mp4")),
            ("name", json!("C:secret.mp4")),
            ("name", json!("private\nsecret")),
            ("name", json!("x".repeat(1025))),
            ("width", json!(0)),
            ("height", json!(65537)),
            ("fpsDenominator", json!(0)),
            ("fpsNumerator", json!(1001001)),
            ("audioStreams", json!(257)),
            ("subtitleStreams", json!(257)),
            ("blockers", json!(["secret"])),
            ("blockers", json!(vec!["hdr"; 13])),
        ] {
            let mut value_source = base.clone();
            value_source[key] = value;
            let result = build_draft(
                serde_json::from_value(value_source).unwrap(),
                settings(1, DraftProfile::Mp4H264),
            );
            let error = result.expect_err(key);
            assert!(error.starts_with("VIDEO_DRAFT_"));
            assert!(!error.contains("secret") && !error.contains("private"));
        }
        for scale in [0, 3, 5, u32::MAX] {
            assert!(build_draft(source(), settings(scale, DraftProfile::Mp4H264)).is_err());
        }
        let mut s = source();
        s.name = "ü".repeat(512);
        s.audio_streams = 256;
        s.subtitle_streams = 256;
        s.width = 65536;
        s.height = 1;
        assert!(build_draft(s, settings(4, DraftProfile::WebmVp9)).is_ok());
    }

    #[test]
    fn strict_ipc_shapes_reject_extra_fields_and_nonintegers() {
        let base = serde_json::to_value(source()).unwrap();
        for (key, value) in [
            ("path", json!("/secret")),
            ("width", json!(-1)),
            ("height", json!(1.5)),
            ("fpsNumerator", json!(4294967296u64)),
            ("fpsDenominator", json!(null)),
            ("audioStreams", json!("1")),
        ] {
            let mut s = base.clone();
            s[key] = value;
            assert!(serde_json::from_value::<DraftSource>(s).is_err());
        }
        for bad in [
            json!({"scale":1,"profile":"other"}),
            json!({"scale":1,"profile":"mp4-h264","path":"/secret"}),
            json!({"scale":1.5,"profile":"mp4-h264"}),
            json!({"scale":-1,"profile":"mp4-h264"}),
        ] {
            assert!(serde_json::from_value::<DraftSettings>(bad).is_err());
        }
    }

    #[test]
    fn codec_matrix_audio_omission_and_flags() {
        for (profile, extension, video, audio) in [
            ("mp4-h264", "mp4", "libx264", "aac"),
            ("mkv-h264", "mkv", "libx264", "aac"),
            ("webm-vp9", "webm", "libvpx-vp9", "libopus"),
        ] {
            for count in [0, 1, 256] {
                let mut s = source();
                s.audio_streams = count;
                let settings =
                    serde_json::from_value(json!({"scale":1,"profile":profile})).unwrap();
                let v = serde_json::to_value(build_draft(s, settings).unwrap()).unwrap();
                assert_eq!(v["output"]["filename"], format!("processed.{extension}"));
                assert_eq!(v["output"]["container"], extension);
                assert_eq!(v["output"]["videoEncoder"], video);
                assert_eq!(v["output"]["pixelFormat"], "yuv420p");
                if count == 0 {
                    assert!(v["output"].get("audioEncoder").is_none());
                    assert!(v["output"].get("audioBitrate").is_none());
                } else {
                    assert_eq!(v["output"]["audioEncoder"], audio);
                    assert_eq!(v["output"]["audioBitrate"], 192000);
                }
                for flag in ["processingReady", "timingVerified", "encoderVerified"] {
                    assert_eq!(v[flag], false);
                }
                assert!(v.get("planId").is_none());
            }
        }
    }

    #[test]
    fn preserves_all_inspector_blockers_and_adds_subtitle_blocker() {
        let codes = [
            "cadenceUnknown",
            "cadenceMismatch",
            "interlaced",
            "fieldOrderUnknown",
            "rotation",
            "alpha",
            "hdr",
            "colorUnknown",
            "unsupportedPixelFormat",
            "unsupportedDimensions",
            "nonSquarePixels",
            "pixelAspectUnknown",
        ];
        let mut s = source();
        s.blockers = codes.iter().map(|s| (*s).into()).collect();
        s.subtitle_streams = 1;
        s.fps_numerator = 0;
        s.width = 8194;
        let draft = build_draft(s, settings(1, DraftProfile::MkvH264)).unwrap();
        assert_eq!(draft.source.blockers, codes);
        let mut expected = codes.to_vec();
        expected.extend(["outputDimensions", "subtitlesUnsupported"]);
        assert_eq!(draft.blockers, expected);
        assert!(!draft.processing_ready && !draft.timing_verified && !draft.encoder_verified);
    }

    #[test]
    fn explicit_command_delivers_sanitized_info_and_error_once() {
        let start = crate::logs::native_logs(0).last().map_or(0, |e| e.seq);
        let mut s = source();
        s.name = "private-secret-token.mp4".into();
        native_video_post_draft(s, settings(2, DraftProfile::WebmVp9)).unwrap();
        let mut s = source();
        s.name = "/private/secret/token.mp4".into();
        let error = native_video_post_draft(s, settings(2, DraftProfile::Mp4H264)).unwrap_err();
        assert!(!error.contains("private") && !error.contains("secret"));
        let entries: Vec<_> = crate::logs::native_logs(start)
            .into_iter()
            .filter(|e| e.text.contains("video-post operation=draft "))
            .collect();
        assert_eq!(entries.len(), 2);
        let mut ids = Vec::new();
        for (entry, (severity, outcome)) in entries
            .iter()
            .zip([("INFO", "drafted"), ("ERROR", "failed")])
        {
            assert_eq!(entry.source, crate::logs::Source::Deas);
            let prefix = format!("{severity}: video-post operation=draft operationId=");
            let rest = entry.text.strip_prefix(&prefix).unwrap();
            let (id, suffix) = rest.split_once(' ').unwrap();
            assert_eq!(suffix, format!("outcome={outcome}"));
            assert_eq!(uuid::Uuid::parse_str(id).unwrap().get_version_num(), 4);
            ids.push(id);
            for sensitive in [
                "private", "secret", "token", "mp4", "width", "profile", "webm",
            ] {
                assert!(!entry.text.contains(sensitive));
            }
        }
        assert_ne!(ids[0], ids[1]);
        assert!(crate::logs::native_logs(entries[1].seq)
            .iter()
            .all(|e| !ids.iter().any(|id| e.text.contains(id))));
    }

    #[test]
    fn command_registration_and_existing_local_main_permission_match() {
        let main = include_str!("main.rs");
        let lib = include_str!("lib.rs");
        assert!(main.contains("deas::native_video_post_draft,"));
        assert!(lib.contains("pub mod video_post_draft;"));
        assert!(lib.contains("pub use video_post_draft::native_video_post_draft;"));
        let permission: toml::Value =
            toml::from_str(include_str!("../permissions/video_post.toml")).unwrap();
        let permission = &permission["permission"][0];
        assert_eq!(
            permission["identifier"].as_str(),
            Some("allow-native-video-post-inspect")
        );
        assert_eq!(
            permission["commands"]["allow"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "native_video_post_inspect",
                "native_video_post_draft",
                "native_video_post_prepare",
                "native_video_post_prepared_status",
                "native_video_post_capabilities"
            ]
        );
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["windows"], json!(["main"]));
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-native-video-post-inspect")));
        assert!(capability.get("remote").is_none());
    }
}
