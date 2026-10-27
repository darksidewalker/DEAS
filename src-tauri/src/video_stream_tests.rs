use super::*;

#[test]
fn rational_timestamps_reject_header_only_cfr() {
    assert!(check_ticks(&[0, 512, 1024, 1536], 1, 12800, 25, 1).is_ok());
    assert!(check_ticks(&[0, 512, 1025, 1536], 1, 12800, 25, 1).is_err());
    assert!(check_ticks(&[0, 512, 512], 1, 12800, 25, 1).is_err());
    assert!(check_ticks(&[0], 1, 12800, 25, 1).is_err());
    assert!(check_ticks(&[0, 1001, 2002], 1, 30000, 30000, 1001).is_ok());
    assert!(check_ticks(&[1, 513], 1, 12800, 25, 1).is_err());
    assert!(check_ticks(&[0, 1], 1, 1000, 1000, 1).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn rejects_cancel_special_source_and_symlink_destination_before_codec() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("output.mp4");
    let err = upscale_video(&source, &output, &AtomicBool::new(true), |_| {
        panic!("early cancel")
    })
    .unwrap_err();
    assert!(err.contains("CANCELLED"));
    std::os::unix::fs::symlink(&source, &output).unwrap();
    let err = upscale_video(&source, &output, &AtomicBool::new(false), |_| {
        panic!("symlink output")
    })
    .unwrap_err();
    assert!(err.contains("EXISTS"));
    std::fs::remove_file(&output).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(source.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let err = upscale_video(&source, &output, &AtomicBool::new(false), |_| {
        panic!("FIFO input")
    })
    .unwrap_err();
    assert!(err.contains("SOURCE"));
    assert!(!output.exists());
}

#[cfg(target_os = "linux")]
mod codec {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{fs, process::Command};
    fn fixture(audio: bool) -> (tempfile::TempDir, std::path::PathBuf) {
        fixture_rate(audio, "25")
    }
    fn fixture_rate(audio: bool, rate: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source ü space.mp4");
        let mut c = Command::new("ffmpeg");
        c.args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size=16x16:rate={rate}:duration=0.16"),
        ]);
        if audio {
            c.args([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=0.16",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]);
        }
        c.args([
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "setsar=1",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-x264-params",
            "colorprim=bt709:transfer=bt709:colormatrix=bt709",
        ])
        .arg(&source);
        assert!(c
            .status()
            .expect("install ffmpeg to run ignored codec tests")
            .success());
        (dir, source)
    }
    // Pure CPU nearest-neighbor mock. This is NOT AI inference or GPU proof.
    fn nearest(f: &RgbFrame) -> Result<RgbFrame, String> {
        let w = f.width * 2;
        let h = f.height * 2;
        let mut pixels = vec![0; w as usize * h as usize * 3];
        for y in 0..h {
            for x in 0..w {
                let a = ((y / 2 * f.width + x / 2) * 3) as usize;
                let b = ((y * w + x) * 3) as usize;
                pixels[b..b + 3].copy_from_slice(&f.pixels[a..a + 3]);
            }
        }
        Ok(RgbFrame {
            width: w,
            height: h,
            pixels,
        })
    }
    fn hash(p: &Path) -> Vec<u8> {
        Sha256::digest(fs::read(p).unwrap()).to_vec()
    }
    fn no_stage(dir: &Path) {
        assert!(fs::read_dir(dir).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".deas-video-")));
    }
    #[test]
    #[ignore = "real native ffmpeg/ffprobe/libx264 smoke; CPU mock, no AI"]
    fn real_ffmpeg_cpu_mock_audio_dimensions_count_source_nooverwrite() {
        for (audio, rate) in [(false, "25"), (true, "25"), (false, "24000/1001")] {
            let (dir, source) = fixture_rate(audio, rate);
            let before = hash(&source);
            let output = dir.path().join("processed ü space.mp4");
            let result = upscale_video(&source, &output, &AtomicBool::new(false), nearest).unwrap();
            assert_eq!((result.frames, result.width, result.height), (4, 32, 32));
            assert_eq!(hash(&source), before);
            let out_before = hash(&output);
            let err = upscale_video(&source, &output, &AtomicBool::new(false), |_| {
                panic!("existing output must reject before callback")
            })
            .unwrap_err();
            assert!(err.contains("EXISTS"), "{err}");
            assert_eq!(hash(&output), out_before);
            no_stage(dir.path());
        }
    }
    #[test]
    #[ignore = "real native ffmpeg cleanup/cancellation; CPU callbacks, no AI"]
    fn real_ffmpeg_cpu_mock_errors_cancel_cleanup() {
        let (dir, source) = fixture(false);
        let children_before = fs::read_to_string("/proc/thread-self/children").unwrap();
        let before = hash(&source);
        let output = dir.path().join("result.mp4");
        let err = upscale_video(&source, &output, &AtomicBool::new(true), |_| {
            panic!("early cancel must not call processor")
        })
        .unwrap_err();
        assert!(err.contains("CANCELLED"));
        assert!(!output.exists());
        no_stage(dir.path());
        let mut frames = 0;
        let err = upscale_video(&source, &output, &AtomicBool::new(false), |f| {
            frames += 1;
            if frames == 2 {
                Err("injected processor failure".into())
            } else {
                nearest(f)
            }
        })
        .unwrap_err();
        assert_eq!(err, "injected processor failure");
        assert_eq!(frames, 2);
        assert!(!output.exists());
        no_stage(dir.path());
        let cancel = AtomicBool::new(false);
        let mut frames = 0;
        let err = upscale_video(&source, &output, &cancel, |f| {
            frames += 1;
            if frames == 2 {
                cancel.store(true, Ordering::Relaxed);
            }
            nearest(f)
        })
        .unwrap_err();
        assert!(err.contains("CANCELLED"));
        assert_eq!(frames, 2);
        assert!(!output.exists());
        no_stage(dir.path());
        assert_eq!(hash(&source), before);
        assert_eq!(
            fs::read_to_string("/proc/thread-self/children").unwrap(),
            children_before
        );
    }

    #[test]
    #[ignore = "real ffmpeg source-identity/final no-clobber checks; CPU mock"]
    fn real_ffmpeg_cpu_mock_publication_races_fail_closed() {
        let (dir, source) = fixture(false);
        let output = dir.path().join("result.mp4");
        let before = hash(&source);
        let mut count = 0;
        let err = upscale_video(&source, &output, &AtomicBool::new(false), |f| {
            count += 1;
            if count == 4 {
                fs::write(&output, b"existing destination").unwrap();
            }
            nearest(f)
        })
        .unwrap_err();
        assert!(err.contains("IO"), "{err}");
        assert_eq!(fs::read(&output).unwrap(), b"existing destination");
        assert_eq!(hash(&source), before);
        no_stage(dir.path());
        fs::remove_file(&output).unwrap();
        let mut count = 0;
        let err = upscale_video(&source, &output, &AtomicBool::new(false), |f| {
            count += 1;
            if count == 4 {
                fs::File::open(&source)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
                    .unwrap();
            }
            nearest(f)
        })
        .unwrap_err();
        assert!(err.contains("CHANGED"), "{err}");
        assert!(!output.exists());
        assert_eq!(hash(&source), before);
        no_stage(dir.path());
    }
}
