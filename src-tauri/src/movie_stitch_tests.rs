use super::*;

fn ffmpeg() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok()
}
/// A test clip (colour bars and a tone unless `silent`), made with FFmpeg into a private folder.
fn clip(dir: &Path, name: &str, seconds: f64, silent: bool) -> PathBuf {
    let path = dir.join(name);
    let mut c = Command::new("ffmpeg");
    c.args([
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        &format!("testsrc=size=320x176:rate=24:duration={seconds}"),
    ]);
    if !silent {
        c.args([
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:sample_rate=48000:duration={seconds}"),
        ]);
    }
    c.args(["-pix_fmt", "yuv420p", "-c:v", "libx264"]);
    if !silent {
        c.args(["-c:a", "aac"]);
    }
    let o = c.arg(&path).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    path
}
fn duration(p: &Path) -> f64 {
    let o = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(p)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).trim().parse().unwrap()
}

#[test]
fn blends_shorten_the_film_and_are_bounded_by_the_clips() {
    assert_eq!(film_seconds(&[5.0, 4.0, 6.0], &[Some(1.0), None]), 14.0);
    assert!(check_blends(&[5.0, 4.0], &[Some(2.0)]).is_ok());
    assert_eq!(
        check_blends(&[5.0, 4.0], &[Some(2.5)]),
        Err("MOVIE_STITCH_BLEND".into())
    ); // more than half of the 4 s clip
    assert_eq!(
        check_blends(&[5.0, 4.0], &[Some(0.1)]),
        Err("MOVIE_STITCH_BLEND".into())
    );
    assert_eq!(
        check_blends(&[5.0, 4.0], &[Some(f64::NAN)]),
        Err("MOVIE_STITCH_BLEND".into())
    );
    assert_eq!(check_blends(&[5.0], &[]), Err("MOVIE_STITCH_PLAN".into()));
    assert_eq!(
        check_blends(&[5.0, 4.0], &[None, None]),
        Err("MOVIE_STITCH_PLAN".into())
    );
}

#[test]
fn the_graph_crossfades_blends_concats_cuts_and_fills_silence() {
    let p = Plan {
        clips: vec![
            Clip {
                path: "/a.mp4".into(),
                seconds: 5.0,
                has_audio: true,
            },
            Clip {
                path: "/b.mp4".into(),
                seconds: 4.0,
                has_audio: false,
            },
            Clip {
                path: "/c.mp4".into(),
                seconds: 6.0,
                has_audio: true,
            },
        ],
        blends: vec![Some(1.0), None],
        width: 1216,
        height: 672,
        seconds: 14.0,
    };
    let g = graph(&p);
    assert!(g.contains("[0:v:0]scale=1216:672:force_original_aspect_ratio=decrease,pad=1216:672"));
    assert!(g.contains("aevalsrc=0|0:c=stereo:s=48000:d=4.000"), "{g}");
    assert!(
        g.contains("[v0][v1]xfade=transition=fade:duration=1.000:offset=4.000[vx1]"),
        "{g}"
    );
    assert!(g.contains("[a0][a1]acrossfade=d=1.000[ax1]"), "{g}");
    assert!(
        g.contains("[vx1][ax1][v2][a2]concat=n=2:v=1:a=1[vx2][ax2]"),
        "{g}"
    );
    assert!(g.ends_with("[vx2]null[vout];[ax2]anull[aout]"), "{g}");
    let a: Vec<String> = args(&p, Path::new("/out/film.mp4"))
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    assert_eq!(a.iter().filter(|x| *x == "-i").count(), 3);
    assert!(a.windows(2).any(|w| w == ["-protocol_whitelist", "file"]));
    assert!(a.contains(&"-n".to_owned()), "never overwrite");
}

#[test]
fn requests_are_checked_before_anything_runs() {
    let bad = |clips: Vec<&str>, blends: Vec<Option<f64>>| {
        plan(&StitchRequest {
            clips: clips.into_iter().map(String::from).collect(),
            blends,
        })
    };
    assert_eq!(bad(vec!["/a.mp4"], vec![]), Err("MOVIE_STITCH_PLAN".into()));
    assert_eq!(
        bad(vec!["/a.mp4", "/b.mp4"], vec![]),
        Err("MOVIE_STITCH_PLAN".into())
    );
    assert_eq!(
        bad(vec!["relative.mp4", "/b.mp4"], vec![None]),
        Err("MOVIE_STITCH_CLIP".into())
    );
    assert_eq!(
        bad(vec!["/nope/a.mp4", "/nope/b.mp4"], vec![None]),
        Err("MOVIE_STITCH_CLIP".into())
    );
}

/// Real FFmpeg: two clips (one without sound) crossfaded by 1 s, then a cut — the film is 5 + 4 − 1 + 3 s and has sound throughout.
#[test]
fn a_real_stitch_crossfades_and_cuts_and_never_overwrites() {
    if !ffmpeg() {
        eprintln!("ffmpeg not found; skipped");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = (
        clip(dir.path(), "a.mp4", 5.0, false),
        clip(dir.path(), "b.mp4", 4.0, true),
        clip(dir.path(), "c.mp4", 3.0, false),
    );
    let req = StitchRequest {
        clips: [&a, &b, &c]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        blends: vec![Some(1.0), None],
    };
    let r = stitch(&req, &AtomicBool::new(false)).unwrap();
    assert!(r.path.ends_with("film.mp4"));
    assert_eq!(r.seconds, 11.0);
    let got = duration(Path::new(&r.path));
    assert!((got - 11.0).abs() < 0.15, "film is {got} s");
    let audio = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(&r.path)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&audio.stdout).contains("audio"));
    let again = stitch(&req, &AtomicBool::new(false)).unwrap();
    assert!(again.path.ends_with("film-2.mp4"), "{}", again.path);
    assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("partial")));
}
