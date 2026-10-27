use deas::video_upscale::{read_png, validate_png_paths, write_png_noclobber, SpatialUpscaler};
use std::path::Path;

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err("Usage: upscale_png ORT_LIBRARY MODEL INPUT_PNG OUTPUT_PNG".into());
    }
    let input = Path::new(&args[2]);
    let output = Path::new(&args[3]);
    validate_png_paths(input, output)?;
    let frame = read_png(input)?;
    let mut session = SpatialUpscaler::open(Path::new(&args[0]), Path::new(&args[1]))?;
    let result = session.upscale(&frame)?;
    write_png_noclobber(output, &result)?;
    println!("CUDA spatial inference (CPU fallback disabled): {}x{} -> {}x{}; PNG published without replacement", frame.width, frame.height, result.width, result.height);
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Video upscale: {error}");
        std::process::exit(1);
    }
}
