use super::*;

fn fixture(name: &str) -> Value {
    let text = match name {
        "t2m-full.intent" => include_str!("../../tests/fixtures/music/t2m-full.intent.json"),
        "t2m-full.graph" => include_str!("../../tests/fixtures/music/t2m-full.graph.json"),
        "t2m-off.intent" => include_str!("../../tests/fixtures/music/t2m-off.intent.json"),
        "cover.intent" => include_str!("../../tests/fixtures/music/cover.intent.json"),
        "cover.graph" => include_str!("../../tests/fixtures/music/cover.graph.json"),
        _ => unreachable!(),
    };
    serde_json::from_str(text).unwrap()
}

pub(crate) fn full() -> Value {
    fixture("t2m-full.intent")
}

fn cover() -> Value {
    fixture("cover.intent")
}

#[test]
fn music_full_matches_the_template_contract() {
    let g = compile(&full()).unwrap();
    assert_eq!(g["M"]["inputs"]["style"], "English, indie pop");
    assert_eq!(g["M"]["inputs"]["lyrics"], "[Verse]\nHello world");
    assert_eq!(g["M"]["inputs"]["abc"], json!(["A", 0]));
    assert_eq!(g["L"]["inputs"]["seconds"], json!(["M", 1]));
    assert_eq!(g["S"]["inputs"]["negative"], json!(["Z", 0]));
    assert_eq!(g["7"]["inputs"]["format"], "flac");
    assert!(!g.to_string().contains("CLIPTextEncode"));
    assert_eq!(g, fixture("t2m-full.graph"));
    assert_eq!(g, compile(&full()).unwrap());
}

#[test]
fn music_off_omits_planner_but_keeps_a_valid_public_mode() {
    let g = compile(&fixture("t2m-off.intent")).unwrap();
    assert!(g.get("A").is_none());
    assert_eq!(g["M"]["inputs"]["abc"], "");
    assert_eq!(g["M"]["inputs"]["mode"], "full");
    assert_eq!(g["M"]["inputs"]["cfg_scale"], 1.01);
}

#[test]
fn music_melody_uses_the_same_mode_in_both_generators() {
    let mut i = full();
    i["planning"] = json!("melody");
    let g = compile(&i).unwrap();
    assert_eq!(g["A"]["inputs"]["mode"], "melody");
    assert_eq!(g["M"]["inputs"]["mode"], "melody");
}

#[test]
fn music_cover_transcribes_source_audio_instead_of_generating_abc() {
    assert_eq!(compile(&cover()).unwrap(), fixture("cover.graph"));
    for source in ["deas-inputs/song.flac", "deas-input-video.mp4"] {
        let mut i = cover();
        i["sourceAudio"] = json!(source);
        let g = compile(&i).unwrap();
        assert!(g.get("A").is_none());
        assert_eq!(g["I"]["class_type"], "LoadAudio");
        assert_eq!(g["I"]["inputs"]["audio"], source);
        assert_eq!(g["C"]["class_type"], "SheetSage2AudioToABC");
        assert_eq!(g["C"]["inputs"]["audio"], json!(["I", 0]));
        assert_eq!(g["C"]["inputs"]["mode"], "melody");
        assert_eq!(g["M"]["inputs"]["abc"], json!(["C", 0]));
        assert_eq!(g["M"]["inputs"]["mode"], "melody");
        assert_eq!(g["M"]["inputs"]["max_duration"], 360.0);
        assert_eq!(g["7"]["inputs"]["filename_prefix"], "raw/YuE2_cover");
    }
    assert_eq!(
        requirements(&cover()),
        vec![
            ("checkpoints", vec!["yue2.safetensors"]),
            ("audioEncoders", vec!["sheetsage2_bf16.safetensors"])
        ]
    );
    assert_eq!(
        requirements(&full()),
        vec![("checkpoints", vec!["yue2.safetensors"])]
    );
}

#[test]
fn music_rejects_malformed_and_cross_recipe_fields() {
    let cases = [
        ("negativePrompt", json!("must never leak")),
        ("positivePrompt", json!("x")),
        ("width", json!(1024)),
        ("loras", json!([])),
        ("options", json!({})),
        ("seed", json!(9007199254740992_u64)),
        ("seed", json!(-1)),
        ("seed", json!(1.5)),
        ("maxDuration", json!(0)),
        ("maxDuration", json!(0.03)),
        ("maxDuration", json!(900.04)),
        ("maxDuration", json!(0.05)),
        ("maxDuration", json!("120")),
        ("maxDuration", json!(null)),
        ("style", json!("   ")),
        ("style", json!("")),
        ("style", json!("x".repeat(16385))),
        ("style", json!("\u{1F3B5}".repeat(16385))),
        ("lyrics", json!("a\u{0}b")),
        ("lyrics", json!(7)),
        ("checkpoint", json!("../escape.safetensors")),
        ("checkpoint", json!("C:\\models\\x.safetensors")),
        ("outputPrefix", json!("../escape")),
        ("steps", json!(0)),
        ("steps", json!(10001)),
        ("cfg", json!(100.5)),
        ("sampler", json!("dpm 2")),
        ("scheduler", json!("../x")),
        ("planning", json!("automatic")),
        ("mode", json!("cover")),
        ("version", json!(2)),
        ("family", json!("sdxl")),
        ("recipeId", json!("video-generation")),
        ("sourceAudio", json!("deas-input.flac")),
        ("audioEncoder", json!("sheetsage2_bf16.safetensors")),
    ];
    for (key, value) in cases {
        let mut bad = full();
        bad[key] = value;
        assert!(compile(&bad).is_err(), "accepted {key}: {bad}");
    }
    let mut i = full();
    i["lyrics"] = json!("");
    assert!(compile(&i).is_ok(), "instrumental intent");
    i["style"] = json!("日本語のシティポップ、夜のドライブ \u{1F3B5}");
    i["lyrics"] = json!("x".repeat(16384));
    assert!(compile(&i).is_ok(), "unicode texts within bounds");
    let numeric = [
        ("generation", "temperature", 0.0, 5.0),
        ("generation", "topP", 0.01, 1.0),
        ("generation", "topK", 1.0, 32768.0),
        ("generation", "repetitionPenalty", 0.01, 10.0),
        ("generation", "cfgScale", 0.0, 100.0),
        ("abc", "maxTokens", 1.0, 20000.0),
        ("abc", "temperature", 0.0, 5.0),
        ("abc", "topP", 0.01, 1.0),
        ("abc", "topK", 1.0, 32768.0),
        ("abc", "repetitionPenalty", 0.01, 10.0),
        ("abc", "penaltyWindow", 1.0, 20000.0),
    ];
    for (group, key, min, max) in numeric {
        let integer = matches!(key, "topK" | "maxTokens" | "penaltyWindow");
        for (value, ok) in [
            (min, true),
            (max, true),
            (min - 0.01, false),
            (max + 1.0, false),
        ] {
            let mut i = full();
            i[group][key] = if integer && ok {
                json!(value as u64)
            } else {
                json!(value)
            };
            assert_eq!(compile(&i).is_ok(), ok, "{group}.{key}={value}");
        }
        if integer {
            let mut i = full();
            i[group][key] = json!(1.5);
            assert!(compile(&i).is_err(), "fractional {group}.{key}");
        }
    }
    for group in ["generation", "abc"] {
        let mut i = full();
        i[group]["unknown"] = json!(true);
        assert!(compile(&i).is_err(), "unknown nested {group} key");
        i = full();
        i[group] = json!({});
        assert!(compile(&i).is_err(), "empty {group}");
    }
    // Conditional field combinations.
    let mut off = fixture("t2m-off.intent");
    off["abc"] = full()["abc"].clone();
    assert!(compile(&off).is_err(), "Off carrying abc");
    let mut i = full();
    i.as_object_mut().unwrap().remove("abc");
    assert!(compile(&i).is_err(), "Full missing abc");
    i = cover();
    i["abc"] = full()["abc"].clone();
    assert!(compile(&i).is_err(), "cover carrying abc");
    i = cover();
    i["planning"] = json!("full");
    assert!(compile(&i).is_err(), "cover must be melody");
    for key in ["sourceAudio", "audioEncoder"] {
        i = cover();
        i.as_object_mut().unwrap().remove(key);
        assert!(compile(&i).is_err(), "cover missing {key}");
    }
    for source in [
        "https://example.com/a.mp3",
        "/abs/song.flac",
        "C:\\song.flac",
        "../song.flac",
        "song.flac [output]",
        "",
    ] {
        i = cover();
        i["sourceAudio"] = json!(source);
        assert!(compile(&i).is_err(), "unsafe source {source}");
    }
    i = cover();
    i["audioEncoder"] = json!("../sheetsage.safetensors");
    assert!(compile(&i).is_err());
    assert!(compile(&json!([])).is_err());
    assert!(compile(&json!({"recipeId":"music-generation"})).is_err());
}
