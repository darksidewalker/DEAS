use super::*;
use serde_json::json;

fn item(id: &str, kind: &str, deps: &[&str]) -> Value {
    json!({ "id": id, "kind": kind, "title": id, "deps": deps, "state": "planned", "text": "t", "revision": 1, "revisions": [{ "n": 1, "text": "t" }] })
}
fn movie(id: &str) -> Value {
    let mut seg = item("s1", "segment", &["brief"]);
    seg["seconds"] = json!(10.0);
    seg["continuous"] = json!(false);
    json!({ "version": 1, "id": id, "title": "Film", "targetSeconds": 30, "aspect": "16:9", "items": [item("brief", "brief", &[]), seg] })
}
fn private() -> tempfile::TempDir {
    let d = tempfile::tempdir_in(
        std::env::var_os("TMPDIR").map_or_else(std::env::temp_dir, Into::into),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    d
}

#[test]
fn saves_atomically_and_reopens_the_same_text() {
    let d = private();
    let text = movie("film1").to_string();
    assert_eq!(save(d.path(), &text).unwrap(), "film1");
    assert_eq!(open(d.path(), "film1").unwrap(), text);
    let again = movie("film1").to_string().replace("Film", "Film 2");
    save(d.path(), &again).unwrap();
    assert_eq!(open(d.path(), "film1").unwrap(), again);
    let leftovers: Vec<_> = std::fs::read_dir(d.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().into_string().unwrap())
        .collect();
    assert_eq!(
        leftovers,
        vec!["film1.movie.json"],
        "no temp file stays behind"
    );
}

#[test]
fn refuses_invalid_manifests_and_keeps_the_previous_file() {
    let d = private();
    save(d.path(), &movie("film1").to_string()).unwrap();
    let before = open(d.path(), "film1").unwrap();
    let mut bad = movie("film1");
    bad["items"][1]["deps"] = json!(["ghost"]);
    assert_eq!(
        save(d.path(), &bad.to_string()),
        Err("MOVIE_INVALID".into())
    );
    assert_eq!(open(d.path(), "film1").unwrap(), before);
    assert_eq!(save(d.path(), "{"), Err("MOVIE_MALFORMED".into()));
    let mut v2 = movie("film1");
    v2["version"] = json!(2);
    assert_eq!(problem(&v2), Some("unsupported manifest version"));
}

#[test]
fn validator_matches_the_typescript_rules() {
    let mut m = movie("a");
    assert_eq!(problem(&m), None);
    m["items"][0]["deps"] = json!(["s1"]);
    assert_eq!(problem(&m), Some("dependency cycle"));
    let mut m = movie("a");
    m["items"][0]["deps"] = json!(["brief"]);
    assert_eq!(problem(&m), Some("bad dependency"));
    let mut m = movie("a");
    m["items"][1]["seconds"] = json!(null);
    assert_eq!(problem(&m), Some("bad segment"));
    let mut m = movie("a");
    m["items"][0]["seconds"] = json!(3);
    assert_eq!(problem(&m), Some("seconds/continuity are segment-only"));
    let mut m = movie("a");
    m["items"][1]["id"] = json!("brief");
    assert_eq!(problem(&m), Some("duplicate item id"));
    let mut m = movie("a");
    m["items"][0]["kind"] = json!("nope");
    assert_eq!(problem(&m), Some("unknown item kind"));
    // Cast entries are gone: a scene holds its own inputs (frames, source, references with the Director options).
    let mut m = movie("a");
    m["items"][0]["kind"] = json!("cast");
    assert_eq!(problem(&m), Some("unknown item kind"));
    let mut m = movie("a");
    m["items"][0]["inputs"] = json!({});
    assert_eq!(problem(&m), Some("bad scene inputs (scenes only)"));
    m["items"][0].as_object_mut().unwrap().remove("inputs");
    m["items"][1]["inputs"] = json!({ "first": { "path": "/p/f.png", "media": "image" },
        "refs": [{ "path": "/p/a.png", "media": "image", "mediaMode": "video", "second": 0, "strength": 1, "label": "character-1",
                   "boxes": [{ "n": 1, "box": [0.1, 0.1, 0.5, 0.9] }], "who": [1], "whoAxis": "y", "description": "Anna" },
                 { "path": "/p/c.mp4", "media": "video", "mediaMode": "video_audio", "second": 0, "strength": 1, "trimStart": 1, "trimEnd": 4 }] });
    assert_eq!(problem(&m), None);
    for bad in [
        json!({ "first": { "path": "/p/f.png", "media": "pdf" } }),
        json!({ "first": { "path": "/p/f.png", "media": "image", "extra": 1 } }),
        json!({ "other": {} }),
        json!({ "refs": [{ "path": "/p/a.png", "media": "image", "mediaMode": "video", "second": 0, "strength": 99 }] }),
        json!({ "refs": [{ "path": "/p/a.png", "media": "image", "mediaMode": "video", "second": 0, "strength": 1, "secret": 1 }] }),
        json!({ "refs": [{ "path": "/p/a.png", "media": "image", "mediaMode": "video", "second": 0, "strength": 1, "boxes": [{ "n": 1, "box": [0, 0, 2, 1] }] }] }),
        json!({ "refs": (0..17).map(|i| json!({ "path": format!("/p/{i}.png"), "media": "image", "mediaMode": "video", "second": 0, "strength": 1 })).collect::<Vec<_>>() }),
    ] {
        m["items"][1]["inputs"] = bad.clone();
        assert_eq!(problem(&m), Some("bad scene inputs"), "{bad}");
    }
    let mut m = movie("bad/id");
    assert_eq!(problem(&m), Some("bad manifest header"));
    m["id"] = json!("ok");
    m["targetSeconds"] = json!(0);
    assert_eq!(problem(&m), Some("bad target length"));
}

#[test]
fn ids_cannot_escape_the_folder_and_missing_movies_are_reported() {
    let d = private();
    for id in ["../x", "a/b", "", "a.b"] {
        assert_eq!(open(d.path(), id), Err("MOVIE_ID".into()));
    }
    assert_eq!(open(d.path(), "nothing"), Err("MOVIE_NOT_FOUND".into()));
}

#[test]
fn list_skips_damaged_files_without_touching_them() {
    let d = private();
    save(d.path(), &movie("b").to_string()).unwrap();
    save(d.path(), &movie("a").to_string()).unwrap();
    std::fs::write(d.path().join("broken.movie.json"), "not json").unwrap();
    std::fs::write(d.path().join("notes.txt"), "x").unwrap();
    let l = list(d.path());
    assert_eq!(l["damaged"], 1);
    assert_eq!(
        l["movies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(l["movies"][0]["items"], 2);
    assert_eq!(
        std::fs::read_to_string(d.path().join("broken.movie.json")).unwrap(),
        "not json"
    );
    assert_eq!(
        list(&d.path().join("absent"))["movies"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn oversized_manifests_are_refused() {
    let d = private();
    let mut m = movie("big");
    m["title"] = json!("x".repeat(MAX_BYTES));
    assert_eq!(
        save(d.path(), &m.to_string()),
        Err("MOVIE_TOO_LARGE".into())
    );
}

#[test]
fn segment_dialogue_and_scene_state_follow_the_rules() {
    let mut m = movie("a");
    m["items"][1]["dialogue"] =
        json!([{ "speaker": "Anna", "line": "Stop!", "delivery": "shouted" }]);
    m["items"][1]["entry"] = json!("dusk");
    m["items"][1]["exit"] = json!("");
    assert_eq!(problem(&m), None);
    m["items"][1]["dialogue"] = json!([{ "speaker": "", "line": "x" }]);
    assert_eq!(problem(&m), Some("bad dialogue"));
    m["items"][1]["dialogue"] = json!([{ "speaker": "Anna", "line": "" }]);
    assert_eq!(problem(&m), Some("bad dialogue"));
    m["items"][1]["dialogue"] = json!([]);
    m["items"][1]["entry"] = json!(5);
    assert_eq!(problem(&m), Some("bad scene state"));
    m["items"][1]["entry"] = json!("ok");
    m["items"][0]["dialogue"] = json!([]);
    assert_eq!(problem(&m), Some("seconds/continuity are segment-only"));
}

#[test]
fn shot_model_and_loras_follow_the_rules() {
    let mut m = movie("a");
    m["items"][1]["model"] = json!("MiniMaxH3/h3.safetensors");
    m["items"][1]["loras"] = json!([{ "name": "MiniMaxH3/style.safetensors", "strength": 0.8 }, { "name": "other.safetensors", "strength": -1.5 }]);
    assert_eq!(problem(&m), None);
    m["items"][1]["loras"][1]["strength"] = json!(4.5);
    assert_eq!(problem(&m), Some("bad LoRAs (shots and the music only)"));
    m["items"][1]["loras"] =
        json!([{ "name": "a", "strength": 1 }, { "name": "a", "strength": 1 }]);
    assert_eq!(problem(&m), Some("bad LoRAs (shots and the music only)"));
    m["items"][1]["loras"] = json!((0..9)
        .map(|i| json!({ "name": format!("l{i}"), "strength": 1 }))
        .collect::<Vec<_>>());
    assert_eq!(problem(&m), Some("bad LoRAs (shots and the music only)"));
    m["items"][1]["loras"] = json!([]);
    m["items"][1]["model"] = json!("");
    assert_eq!(problem(&m), Some("bad shot model"));
    m["items"][1].as_object_mut().unwrap().remove("model");
    m["items"][0]["loras"] = json!([]);
    assert_eq!(problem(&m), Some("bad LoRAs (shots and the music only)"));
    m["items"][0].as_object_mut().unwrap().remove("loras");
    // The generated music bed's model takes LoRAs too, under the same rules.
    let mut music = item("music", "music", &["brief"]);
    music["loras"] = json!([{ "name": "ace/lofi.safetensors", "strength": 0.7 }]);
    m["items"].as_array_mut().unwrap().push(music);
    assert_eq!(problem(&m), None);
    m["items"][2]["loras"][0]["strength"] = json!(-4.5);
    assert_eq!(problem(&m), Some("bad LoRAs (shots and the music only)"));
}

#[test]
fn check_reports_missing_results_and_references_from_the_stored_manifest_only() {
    let d = private();
    let files = private();
    let (have, gone) = (files.path().join("clip.mp4"), files.path().join("gone.mp4"));
    let (pic, nopic) = (files.path().join("a.png"), files.path().join("b.png"));
    std::fs::write(&have, b"x").unwrap();
    std::fs::write(&pic, b"x").unwrap();
    let mut m = movie("film1");
    m["items"][1]["state"] = json!("done");
    m["items"][1]["revisions"] =
        json!([{ "n": 1, "text": "t", "result": { "outputId": have.to_str().unwrap() } }]);
    m["items"][1]["inputs"] = json!({ "first": { "path": pic.to_str().unwrap(), "media": "image" },
        "refs": [{ "path": nopic.to_str().unwrap(), "media": "image", "mediaMode": "video", "second": 0, "strength": 1 }] });
    let mut old = item("c2", "voice", &["brief"]);
    old["revision"] = json!(2);
    old["revisions"] = json!([{ "n": 1, "text": "t", "result": { "outputId": gone.to_str().unwrap() } }, { "n": 2, "text": "u" }]);
    m["items"].as_array_mut().unwrap().push(old);
    save(d.path(), &m.to_string()).unwrap();
    let r = check(d.path(), "film1").unwrap();
    assert_eq!(
        r["checked"], 3,
        "only the current revision's result plus the references are looked at"
    );
    assert_eq!(
        r["missing"],
        json!([{ "id": "s1", "kind": "reference", "path": nopic.to_str().unwrap() }])
    );
    std::fs::remove_file(&have).unwrap();
    std::fs::create_dir(&have).unwrap();
    let r = check(d.path(), "film1").unwrap();
    assert_eq!(
        r["missing"].as_array().unwrap().len(),
        2,
        "a directory is not a file"
    );
    let mut m2 = movie("film2");
    let mut music = item("mu", "music", &["brief"]);
    music["file"] = json!(files.path().join("no.wav").to_str().unwrap());
    m2["items"].as_array_mut().unwrap().push(music);
    save(d.path(), &m2.to_string()).unwrap();
    assert_eq!(
        check(d.path(), "film2").unwrap()["missing"][0]["kind"],
        "music"
    );
    assert_eq!(check(d.path(), "../x"), Err("MOVIE_ID".into()));
    assert_eq!(check(d.path(), "none"), Err("MOVIE_NOT_FOUND".into()));
}

#[test]
fn music_file_and_mix_settings_follow_the_rules() {
    let mut m = movie("a");
    let mut music = item("music", "music", &["brief"]);
    music["file"] = json!("/music/bed.wav");
    let mut score = item("score", "score", &["brief", "music"]);
    score["mix"] = json!({ "mode": "mix", "levelDb": -14, "duckDb": 12, "fadeSeconds": 2 });
    m["items"].as_array_mut().unwrap().extend([music, score]);
    assert_eq!(problem(&m), None);
    m["items"][3]["mix"]["duckDb"] = json!(31);
    assert_eq!(problem(&m), Some("bad mix settings"));
    m["items"][3]["mix"]["duckDb"] = json!(12);
    m["items"][3]["mix"]["mode"] = json!("loud");
    assert_eq!(problem(&m), Some("bad mix settings"));
    m["items"][3]["mix"]["mode"] = json!("h3-reference");
    assert_eq!(problem(&m), None);
    m["items"][0]["mix"] = m["items"][3]["mix"].clone();
    assert_eq!(problem(&m), Some("bad mix settings"));
    m["items"][0].as_object_mut().unwrap().remove("mix");
    m["items"][0]["file"] = json!("/x.wav");
    assert_eq!(problem(&m), Some("bad music file"));
    m["items"][0].as_object_mut().unwrap().remove("file");
    m["items"][2]["file"] = json!("");
    assert_eq!(problem(&m), Some("bad music file"));
}

#[test]
fn media_pool_is_typed_bounded_and_checked_on_reopen() {
    let mut m = movie("pool");
    m["media"] = json!([{ "path": "/p/a.png", "media": "image", "note": "Anna", "role": "first" }, { "path": "/p/b.wav", "media": "audio", "label": "character-1" }]);
    assert_eq!(problem(&m), None);
    for bad in [
        json!([{ "path": "/p/a.png", "media": "pdf" }]),
        json!([{ "path": "/p/a.png", "media": "image", "extra": 1 }]),
        json!([{ "path": "/p/a.png", "media": "image", "role": "hero" }]),
        json!([{ "path": "/p/a.png", "media": "image" }, { "path": "/p/a.png", "media": "image" }]),
        json!((0..33)
            .map(|i| json!({ "path": format!("/p/{i}.png"), "media": "image" }))
            .collect::<Vec<_>>()),
    ] {
        m["media"] = bad.clone();
        assert_eq!(problem(&m), Some("bad media pool"), "{bad}");
    }
    let d = private();
    let files = private();
    let have = files.path().join("a.png");
    std::fs::write(&have, b"x").unwrap();
    let gone = files.path().join("gone.png");
    m["media"] = json!([{ "path": have.to_str().unwrap(), "media": "image" }, { "path": gone.to_str().unwrap(), "media": "image" }]);
    save(d.path(), &m.to_string()).unwrap();
    let r = check(d.path(), "pool").unwrap();
    assert_eq!(
        r["missing"],
        json!([{ "id": "brief", "kind": "reference", "path": gone.to_str().unwrap() }])
    );
}

#[test]
fn render_settings_shot_sampling_and_music_settings_follow_the_rules() {
    let mut m = movie("a");
    m["render"] = json!({ "source": "movie", "model": "MiniMaxH3/h3_turbo.safetensors", "resolution": "720p", "steps": 8, "cfg": 1 });
    m["items"][1]["sampling"] = json!({ "steps": 30, "cfg": 3.5 });
    let mut music = item("music", "music", &["brief"]);
    music["lyrics"] = json!("[Verse]\nla la");
    music["bpm"] = json!(90);
    music["language"] = json!("en");
    music["preset"] = json!("cinematic-orchestral");
    music["vocals"] = json!(true);
    m["items"].as_array_mut().unwrap().push(music);
    assert_eq!(problem(&m), None);
    m["render"]["source"] = json!("studio");
    assert_eq!(problem(&m), Some("bad render settings"));
    m["render"] = json!({ "source": "generate", "steps": 151 });
    assert_eq!(problem(&m), Some("bad render settings"));
    m["render"] = json!({ "source": "movie", "extra": 1 });
    assert_eq!(problem(&m), Some("bad render settings"));
    m["render"] = json!({ "source": "generate" });
    m["items"][1]["sampling"] = json!({ "steps": 7.5 });
    assert_eq!(problem(&m), Some("bad shot sampling"));
    m["items"][1]["sampling"] = json!({ "cfg": 31 });
    assert_eq!(problem(&m), Some("bad shot sampling"));
    m["items"][1]["sampling"] = json!({ "sampler": "euler" });
    assert_eq!(problem(&m), Some("bad shot sampling"));
    m["items"][1].as_object_mut().unwrap().remove("sampling");
    m["items"][0]["sampling"] = json!({ "steps": 8 });
    assert_eq!(problem(&m), Some("bad shot sampling"));
    m["items"][0].as_object_mut().unwrap().remove("sampling");
    m["items"][2]["bpm"] = json!(301);
    assert_eq!(problem(&m), Some("bad music settings"));
    m["items"][2]["bpm"] = json!(90);
    m["items"][2]["language"] = json!("EN");
    assert_eq!(problem(&m), Some("bad music settings"));
    m["items"][2]["language"] = json!("de");
    m["items"][2]["preset"] = json!("../x");
    assert_eq!(problem(&m), Some("bad music settings"));
    m["items"][2]["preset"] = json!("lofi");
    m["items"][1]["lyrics"] = json!("not a music item");
    assert_eq!(problem(&m), Some("bad music settings"));
    m["items"][1].as_object_mut().unwrap().remove("lyrics");
    assert_eq!(problem(&m), None);
}
