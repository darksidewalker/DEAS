//! Explicit developer-only CUDA execution, never run at application startup.
use deas::{video_stream::upscale_video, video_upscale::SpatialUpscaler};
use std::{path::Path, sync::atomic::AtomicBool};

static CANCEL: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "linux")]
extern "C" fn interrupt(_: libc::c_int) {
    CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err("Usage: upscale_video ORT_LIBRARY MODEL INPUT_VIDEO OUTPUT_MP4".into());
    }
    if !cfg!(target_os = "linux") {
        return Err("VIDEO_STREAM_PLATFORM: streaming currently requires Linux".into());
    }
    #[cfg(target_os = "linux")]
    unsafe {
        // Keep cleanup in Rust; a running inference call observes cancellation when it returns.
        if libc::signal(libc::SIGINT, interrupt as *const () as libc::sighandler_t) == libc::SIG_ERR
            || libc::signal(libc::SIGTERM, interrupt as *const () as libc::sighandler_t)
                == libc::SIG_ERR
        {
            return Err("Cannot install CLI cancellation handlers".into());
        }
    }
    let mut session = SpatialUpscaler::open(Path::new(&args[0]), Path::new(&args[1]))?;
    let result = upscale_video(Path::new(&args[2]), Path::new(&args[3]), &CANCEL, |frame| {
        session.upscale(frame)
    })?;
    println!(
        "CUDA spatial inference: {} frames, {}x{}; verified MP4 published without replacement",
        result.frames, result.width, result.height
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Video stream: {error}");
        std::process::exit(1);
    }
}
