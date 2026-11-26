use super::*;

fn ffmpeg() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok()
        && Command::new("ffprobe").arg("-version").output().is_ok()
}
fn private() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::var_os("TMPDIR").map_or_else(std::env::temp_dir, Into::into))
        .unwrap()
}
fn run(args: &[&str]) {
    let o = Command::new("ffmpeg")
        .args(["-v", "error", "-nostdin", "-y"])
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
/// A 3 s film with a 440 Hz "voice" (or no sound), and a 1 s 220 Hz music file that must be looped.
fn fixture(dir: &Path, sound: bool) -> (PathBuf, PathBuf) {
    let film = dir.join("film one.mp4");
    let f = film.to_str().unwrap();
    if sound {
        run(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=64x64:d=3:r=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-shortest",
            f,
        ]);
    } else {
        run(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=64x64:d=3:r=10",
            "-c:v",
            "mpeg4",
            f,
        ]);
    }
    let music = dir.join("bed.wav");
    run(&[
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=1",
        music.to_str().unwrap(),
    ]);
    (film, music)
}
fn request(film: &Path, music: &Path, level: f64, duck: f64, fade: f64) -> MixRequest {
    MixRequest {
        film: film.to_string_lossy().into_owned(),
        music: music.to_string_lossy().into_owned(),
        level_db: level,
        duck_db: duck,
        fade_seconds: fade,
    }
}
fn mean_volume(file: &str) -> f64 {
    let o = Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-i",
            file,
            "-af",
            "volumedetect",
            "-vn",
            "-f",
            "null",
            "-",
        ])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&o.stderr).into_owned();
    let at = text.find("mean_volume:").expect("volumedetect output") + "mean_volume:".len();
    text[at..]
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}
fn probe(file: &str, what: &str) -> String {
    let o = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", what, "-of", "csv=p=0", file])
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

#[test]
fn validates_settings_and_files_before_anything_runs() {
    let d = private();
    let nofile = d.path().join("nothing.mp4");
    let ok = request(&nofile, &nofile, -14.0, 12.0, 2.0);
    assert_eq!(plan(&ok), Err("MOVIE_MIX_FILM".into()));
    for (level, duck, fade) in [
        (-41.0, 0.0, 0.0),
        (7.0, 0.0, 0.0),
        (0.0, -1.0, 0.0),
        (0.0, 31.0, 0.0),
        (0.0, 0.0, 11.0),
        (f64::NAN, 0.0, 0.0),
        (0.0, f64::INFINITY, 0.0),
    ] {
        assert_eq!(
            plan(&request(&nofile, &nofile, level, duck, fade)),
            Err("MOVIE_MIX_SETTINGS".into())
        );
    }
    let text = d.path().join("a.txt");
    std::fs::write(&text, b"x").unwrap();
    assert_eq!(
        plan(&request(&text, &text, 0.0, 0.0, 0.0)),
        Err("MOVIE_MIX_FILM".into())
    );
    let rel = request(Path::new("relative.mp4"), Path::new("b.wav"), 0.0, 0.0, 0.0);
    assert_eq!(plan(&rel), Err("MOVIE_MIX_FILM".into()));
}

#[test]
fn the_graph_ducks_only_when_the_film_has_sound() {
    let p = |has_audio, duck| Plan {
        film: "/f.mp4".into(),
        music: "/m.wav".into(),
        seconds: 10.0,
        has_audio,
        level_db: -14.0,
        duck_db: duck,
        fade: 2.0,
    };
    assert_eq!(
        graph(&p(false, 12.0)),
        "[1:a:0]volume=-14.00dB,afade=t=out:st=8.000:d=2.000[aout]"
    );
    assert!(
        graph(&p(true, 0.0)).contains("amix=inputs=2:duration=first:normalize=0")
            && !graph(&p(true, 0.0)).contains("sidechaincompress")
    );
    let g = graph(&p(true, 12.0));
    assert!(
        g.contains("sidechaincompress=threshold=0.03:ratio=7.0")
            && g.contains("[orig][duck]amix")
            && g.ends_with("[aout]")
    );
    assert!(!graph(&Plan {
        fade: 0.0,
        ..p(false, 0.0)
    })
    .contains("afade"));
    let a = args(&p(true, 12.0), Path::new("/o.mp4"))
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(
        a.windows(2).any(|w| w == ["-c:v", "copy"])
            && a.windows(2).any(|w| w == ["-t", "10.000"])
            && a.contains(&"-n".to_string())
            && a.windows(3).any(|w| w == ["-stream_loop", "-1", "-i"])
    );
}

#[test]
fn mixes_a_looped_bed_under_the_film_keeps_the_video_and_never_overwrites() {
    if !ffmpeg() {
        return;
    }
    let d = private();
    let (film, music) = fixture(d.path(), true);
    let before = std::fs::read(&film).unwrap();
    let first = mix(
        &request(&film, &music, -6.0, 12.0, 1.0),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        first.path,
        d.path().join("film one-scored.mp4").to_string_lossy()
    );
    assert!(first.ducked);
    assert!((first.seconds - 3.0).abs() < 0.2);
    let out = &first.path;
    assert!(
        (probe(out, "format=duration").parse::<f64>().unwrap() - 3.0).abs() < 0.3,
        "the 1 s bed was looped to the film's length"
    );
    assert_eq!(
        probe(out, "stream=codec_name"),
        "mpeg4\naac",
        "video copied, audio re-encoded"
    );
    assert_eq!(
        std::fs::read(&film).unwrap(),
        before,
        "the original film is untouched"
    );
    let second = mix(
        &request(&film, &music, -6.0, 12.0, 1.0),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(second.path.ends_with("film one-scored-2.mp4"));
    let leftovers: Vec<_> = std::fs::read_dir(d.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("partial"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn ducking_lowers_the_music_under_the_film_sound() {
    if !ffmpeg() {
        return;
    }
    let d = private();
    let (film, music) = fixture(d.path(), true);
    let plain = mix(
        &request(&film, &music, 0.0, 0.0, 0.0),
        &AtomicBool::new(false),
    )
    .unwrap();
    let ducked = mix(
        &request(&film, &music, 0.0, 24.0, 0.0),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(!plain.ducked && ducked.ducked);
    assert!(
        mean_volume(&ducked.path) < mean_volume(&plain.path) - 0.5,
        "{} vs {}",
        mean_volume(&ducked.path),
        mean_volume(&plain.path)
    );
}

#[test]
fn a_silent_film_just_gets_the_bed() {
    if !ffmpeg() {
        return;
    }
    let d = private();
    let (film, music) = fixture(d.path(), false);
    let r = mix(
        &request(&film, &music, -10.0, 12.0, 0.5),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(!r.ducked);
    assert!(probe(&r.path, "stream=codec_type").contains("audio"));
    assert!(mean_volume(&r.path) < -5.0);
}

#[test]
fn a_file_without_audio_is_refused_as_music() {
    if !ffmpeg() {
        return;
    }
    let d = private();
    let (film, _) = fixture(d.path(), true);
    let fake = d.path().join("fake.wav");
    std::fs::write(&fake, b"not audio").unwrap();
    assert_eq!(
        plan(&request(&film, &fake, 0.0, 0.0, 0.0)),
        Err("MOVIE_MIX_MUSIC".into())
    );
}
