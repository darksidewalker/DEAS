//! Opt-in spatial inference only; no video scheduling or startup initialization.
//! Trusted-model developer primitive, not an untrusted ONNX sandbox: byte/frame caps do not
//! bound arbitrary internal model allocations. Native libraries execute with process privileges.
use crate::logs::{self, Source};
use half::f16;
use ort::{
    session::Session,
    value::{Tensor, TensorElementType, ValueType},
};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};

pub const MAX_INPUT_EDGE: u32 = 512;
const MAX_MODEL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PNG_BYTES: u64 = 16 * 1024 * 1024;

fn error(message: &'static str) -> String {
    logs::push(Source::Deas, &format!("ERROR: Video upscale: {message}"));
    message.to_owned()
}
fn checked<T, E>(result: Result<T, E>, message: &'static str) -> Result<T, String> {
    result.map_err(|_| error(message))
}

fn open_regular(path: &Path) -> Result<File, String> {
    if !checked(
        std::fs::symlink_metadata(path),
        "cannot inspect local input",
    )?
    .is_file()
    {
        return Err(error(
            "input must be a local regular file, not a symlink or special file",
        ));
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        checked(
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path),
            "cannot open local input",
        )?
    };
    #[cfg(windows)]
    let file = checked(crate::win::open_no_follow(path), "cannot open local input")?;
    #[cfg(not(any(unix, windows)))]
    let file = checked(File::open(path), "cannot open local input")?;
    if !checked(file.metadata(), "cannot inspect opened input")?.is_file() {
        return Err(error("opened input must be a regular file"));
    }
    Ok(file)
}

fn native_logger(operation: Arc<AtomicU8>) -> ort::logging::LoggerFunction {
    let seen = AtomicU8::new(0);
    // At most one fixed message per native severity per session, never native content.
    Arc::new(move |level, _, _, _, _| {
        use ort::logging::LogLevel;
        let (bit, severity) = match level {
            LogLevel::Warning => (1, "WARNING"),
            LogLevel::Error => (2, "ERROR"),
            LogLevel::Fatal => (4, "FATAL"),
            _ => return,
        };
        if seen.fetch_or(bit, Ordering::Relaxed) & bit == 0 {
            let op = if operation.load(Ordering::Relaxed) == 0 {
                "session initialization"
            } else {
                "frame inference"
            };
            logs::push(Source::Deas, &format!("{severity}: Video upscale {op}: native diagnostic; private details and repeats suppressed"));
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct RgbFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}
impl RgbFrame {
    fn validate(&self, max_edge: u32) -> Result<usize, String> {
        if self.width == 0 || self.height == 0 || self.width > max_edge || self.height > max_edge {
            return Err(error("frame dimensions exceed the supported bound"));
        }
        let plane = self.width as usize * self.height as usize;
        if self.pixels.len() != plane * 3 {
            return Err(error("RGB frame length does not match dimensions"));
        }
        Ok(plane)
    }
    fn nchw(&self) -> Result<Vec<f16>, String> {
        let plane = self.validate(MAX_INPUT_EDGE)?;
        let mut tensor = vec![f16::ZERO; plane * 3];
        for (i, rgb) in self.pixels.chunks_exact(3).enumerate() {
            for c in 0..3 {
                tensor[c * plane + i] = f16::from_f32(rgb[c] as f32 / 255.0);
            }
        }
        Ok(tensor)
    }
}

fn validate_type(dtype: &ValueType) -> Result<(), String> {
    match dtype {
        ValueType::Tensor {
            ty: TensorElementType::Float16,
            shape,
            ..
        } if shape.len() == 4
            && matches!(shape[0], -1 | 1)
            && shape[1] == 3
            && shape[2..].iter().all(|&n| n == -1 || n > 0) =>
        {
            Ok(())
        }
        _ => Err(error(
            "model must expose FP16 NCHW tensors with batch one and three RGB channels",
        )),
    }
}
fn output_frame(input: &RgbFrame, shape: &[i64], data: &[f16]) -> Result<RgbFrame, String> {
    if shape.len() != 4 || shape[0] != 1 || shape[1] != 3 || shape[2] <= 0 || shape[3] <= 0 {
        return Err(error("invalid output tensor shape"));
    }
    let h = shape[2];
    let w = shape[3];
    let ih = i64::from(input.height);
    let iw = i64::from(input.width);
    if ih == 0
        || iw == 0
        || h % ih != 0
        || w % iw != 0
        || h / ih != w / iw
        || !(1..=4).contains(&(h / ih))
    {
        return Err(error(
            "output must have a uniform integral spatial scale from one to four",
        ));
    }
    let plane = (w * h) as usize;
    if data.len() != plane * 3 || data.iter().any(|v| !v.is_finite()) {
        return Err(error(
            "output tensor length or finite-value validation failed",
        ));
    }
    let mut pixels = vec![0; plane * 3];
    for i in 0..plane {
        for c in 0..3 {
            pixels[i * 3 + c] =
                (data[c * plane + i].to_f32().clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    Ok(RgbFrame {
        width: w as u32,
        height: h as u32,
        pixels,
    })
}

pub struct SpatialUpscaler {
    session: Session,
    operation: Arc<AtomicU8>,
}
impl SpatialUpscaler {
    /// Both paths are explicitly trusted local files. ORT is process-global: the first library wins.
    /// No CPU fallback is allowed, including shape nodes; unsupported graphs fail at creation.
    pub fn open(ort_library: &Path, model: &Path) -> Result<Self, String> {
        let library = checked(
            ort_library.canonicalize(),
            "cannot resolve trusted ORT library",
        )?;
        if !library.is_file() {
            return Err(error("ORT library must be a local file"));
        }
        let mut file = open_regular(model)?;
        let mut bytes = Vec::new();
        checked(
            (&mut file)
                .take(MAX_MODEL_BYTES + 1)
                .read_to_end(&mut bytes),
            "cannot read model",
        )?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_MODEL_BYTES {
            return Err(error("model exceeds the nonempty 64 MiB limit"));
        }
        let operation = Arc::new(AtomicU8::new(0));
        let logger = native_logger(operation.clone());
        let env = checked(
            checked(ort::init_from(&library), "cannot load trusted ORT library")?
                .with_telemetry(false)
                .with_logger(logger.clone())
                .build(),
            "cannot initialize ORT environment",
        )?;
        let mut builder = checked(Session::builder(&env), "cannot create inference session")?;
        builder = checked(
            builder.with_logger(logger),
            "cannot attach private-safe session logger",
        )?;
        builder = checked(
            builder.with_log_level(ort::logging::LogLevel::Warning),
            "cannot configure native diagnostic severity",
        )?;
        builder = checked(
            builder.with_execution_providers([ort::ep::CUDA::default()
                .with_device_id(0)
                .build()
                .error_on_failure()]),
            "CUDA device zero initialization failed",
        )?;
        builder = checked(
            builder.with_config_entry("session.disable_cpu_ep_fallback", "1"),
            "cannot disable CPU fallback",
        )?;
        // CreateSessionFromArray supplies no model-directory context for external weights.
        let session = checked(
            builder.commit_from_memory(&bytes),
            "cannot load embedded-weight model on CUDA without CPU fallback",
        )?;
        if session.inputs().len() != 1 || session.outputs().len() != 1 {
            return Err(error("model must have exactly one input and one output"));
        }
        validate_type(session.inputs()[0].dtype())?;
        validate_type(session.outputs()[0].dtype())?;
        logs::push(
            Source::Deas,
            "Video upscale: CUDA device zero session ready; CPU fallback disabled",
        );
        Ok(Self { session, operation })
    }
    /// Reuses this session for consecutive bounded RGB frames; no tiling or temporal processing.
    pub fn upscale(&mut self, input: &RgbFrame) -> Result<RgbFrame, String> {
        let data = input.nchw()?;
        let tensor = checked(
            Tensor::from_array((
                [1, 3, input.height as usize, input.width as usize],
                data.into_boxed_slice(),
            )),
            "cannot construct FP16 input",
        )?;
        self.operation.store(1, Ordering::Relaxed);
        let outputs = checked(
            self.session.run(ort::inputs![tensor]),
            "CUDA inference failed",
        )?;
        let (shape, data) = checked(
            outputs[0].try_extract_tensor::<f16>(),
            "cannot read FP16 output",
        )?;
        let frame = output_frame(input, shape, data)?;
        logs::push(
            Source::Deas,
            "Video upscale: bounded spatial frame completed on CUDA (CPU fallback disabled)",
        );
        Ok(frame)
    }
}

pub fn read_png(path: &Path) -> Result<RgbFrame, String> {
    read_png_bound(path, MAX_INPUT_EDGE)
}
fn read_png_bound(path: &Path, max_edge: u32) -> Result<RgbFrame, String> {
    let file = open_regular(path)?;
    if checked(file.metadata(), "cannot inspect PNG")?.len() > MAX_PNG_BYTES {
        return Err(error("PNG exceeds encoded size limit"));
    }
    let mut decoder = png::Decoder::new(file.take(MAX_PNG_BYTES + 1));
    decoder.set_limits(png::Limits {
        bytes: 32 * 1024 * 1024,
    });
    let mut reader = checked(decoder.read_info(), "invalid PNG header")?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > max_edge
        || info.height > max_edge
        || info.bit_depth != png::BitDepth::Eight
        || !matches!(info.color_type, png::ColorType::Rgb | png::ColorType::Rgba)
        || info.animation_control.is_some()
        || info.trns.is_some()
    {
        return Err(error("PNG must be bounded static 8-bit RGB or opaque RGBA"));
    }
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = checked(reader.next_frame(&mut buf), "cannot decode PNG pixels")?;
    checked(reader.finish(), "invalid PNG end")?;
    buf.truncate(info.buffer_size());
    let pixels = if info.color_type == png::ColorType::Rgba {
        if buf.chunks_exact(4).any(|p| p[3] != 255) {
            return Err(error("PNG alpha must be opaque"));
        }
        buf.chunks_exact(4)
            .flat_map(|p| p[..3].iter().copied())
            .collect()
    } else {
        buf
    };
    Ok(RgbFrame {
        width: info.width,
        height: info.height,
        pixels,
    })
}

/// Stages and decodes the result before publishing without replacing any existing entry.
/// Interruption before publication leaves the source and destination untouched (no streaming).
pub fn write_png_noclobber(output: &Path, frame: &RgbFrame) -> Result<(), String> {
    frame.validate(MAX_INPUT_EDGE * 4)?;
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut stage = checked(
        tempfile::NamedTempFile::new_in(parent),
        "cannot stage output PNG",
    )?;
    {
        let mut encoder = png::Encoder::new(stage.as_file_mut(), frame.width, frame.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = checked(encoder.write_header(), "cannot encode PNG header")?;
        checked(
            writer.write_image_data(&frame.pixels),
            "cannot encode PNG pixels",
        )?;
        checked(writer.finish(), "cannot finish PNG")?;
    }
    checked(stage.flush(), "cannot flush PNG")?;
    checked(stage.as_file().sync_all(), "cannot sync PNG")?;
    if read_png_bound(stage.path(), MAX_INPUT_EDGE * 4)? != *frame {
        return Err(error("staged PNG verification failed"));
    }
    checked(
        stage.persist_noclobber(output),
        "cannot publish PNG without replacing an existing entry",
    )?;
    Ok(())
}

/// Existing entries (including hardlinks and symlinks) are never eligible output targets.
pub fn validate_png_paths(input: &Path, output: &Path) -> Result<(), String> {
    checked(input.canonicalize(), "cannot resolve input PNG")?;
    match std::fs::symlink_metadata(output) {
        Ok(_) => Err(error("output already exists or aliases an existing file")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(error("cannot inspect output PNG")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_diagnostics_are_bounded_and_private_safe() {
        let before = logs::native_logs(0).last().map_or(0, |e| e.seq);
        let operation = Arc::new(AtomicU8::new(0));
        let logger = native_logger(operation.clone());
        for _ in 0..1000 {
            logger(
                ort::logging::LogLevel::Warning,
                "/private/category",
                "secret-id",
                "/private/code",
                "/private/model.onnx token=secret",
            );
        }
        operation.store(1, Ordering::Relaxed);
        for _ in 0..1000 {
            logger(
                ort::logging::LogLevel::Error,
                "secret",
                "secret",
                "secret",
                "secret",
            );
            logger(
                ort::logging::LogLevel::Fatal,
                "secret",
                "secret",
                "secret",
                "secret",
            );
        }
        let returned = checked::<(), _>(
            Err("/private/model.onnx token=secret"),
            "test inference failure",
        )
        .unwrap_err();
        assert_eq!(returned, "test inference failure");
        let entries = logs::native_logs(before);
        let native: Vec<_> = entries
            .iter()
            .filter(|e| {
                e.text
                    .contains("native diagnostic; private details and repeats suppressed")
            })
            .collect();
        assert_eq!(native.len(), 3);
        assert!(native.iter().any(|e| e
            .text
            .starts_with("WARNING: Video upscale session initialization:")));
        assert!(native
            .iter()
            .any(|e| e.text.starts_with("ERROR: Video upscale frame inference:")));
        assert!(entries
            .iter()
            .any(|e| e.text == "ERROR: Video upscale: test inference failure"));
        assert!(entries
            .iter()
            .all(|e| !e.text.contains("/private/") && !e.text.contains("token=secret")));
    }
    #[test]
    fn rejects_model_tensor_contract_without_runtime() {
        use ort::value::{Shape, SymbolicDimensions};
        let dtype = |ty, dims| ValueType::Tensor {
            ty,
            shape: Shape::new(dims),
            dimension_symbols: SymbolicDimensions::new([
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ]),
        };
        assert!(validate_type(&dtype(TensorElementType::Float16, [1, 3, -1, -1])).is_ok());
        for dims in [[2, 3, -1, -1], [1, 4, 8, 8], [1, 3, 0, 8]] {
            assert!(validate_type(&dtype(TensorElementType::Float16, dims)).is_err());
        }
        assert!(validate_type(&dtype(TensorElementType::Float32, [1, 3, 8, 8])).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_fifo_and_symlink_without_opening_runtime() {
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::symlink},
        };
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(open_regular(&fifo).is_err());
        assert!(read_png(&fifo).is_err());
        let target = dir.path().join("target");
        std::fs::write(&target, b"not a model").unwrap();
        let alias = dir.path().join("alias");
        symlink(&target, &alias).unwrap();
        assert!(open_regular(&alias).is_err());
        assert!(SpatialUpscaler::open(&target, &fifo).is_err());
    }
    #[test]
    fn rgb_nchw_and_roundtrip() {
        let frame = RgbFrame {
            width: 2,
            height: 1,
            pixels: vec![255, 0, 128, 0, 255, 64],
        };
        let tensor = frame.nchw().unwrap();
        assert_eq!(
            tensor.iter().map(|v| v.to_f32()).collect::<Vec<_>>(),
            vec![
                1.0,
                0.0,
                0.0,
                1.0,
                f16::from_f32(128.0 / 255.0).to_f32(),
                f16::from_f32(64.0 / 255.0).to_f32()
            ]
        );
        assert_eq!(output_frame(&frame, &[1, 3, 1, 2], &tensor).unwrap(), frame);
    }
    #[test]
    fn rejects_bad_frames_shapes_and_nonfinite() {
        assert!(RgbFrame {
            width: 513,
            height: 1,
            pixels: vec![]
        }
        .nchw()
        .is_err());
        assert!(RgbFrame {
            width: 1,
            height: 1,
            pixels: vec![0]
        }
        .nchw()
        .is_err());
        let frame = RgbFrame {
            width: 1,
            height: 1,
            pixels: vec![0; 3],
        };
        for shape in [
            vec![1, 3, 1],
            vec![2, 3, 1, 1],
            vec![1, 4, 1, 1],
            vec![1, 3, 2, 3],
            vec![1, 3, 5, 5],
            vec![1, 3, -1, 1],
        ] {
            assert!(output_frame(&frame, &shape, &[]).is_err());
        }
        for v in [f16::NAN, f16::INFINITY, f16::NEG_INFINITY] {
            assert!(output_frame(&frame, &[1, 3, 1, 1], &[v; 3]).is_err());
        }
    }
    #[test]
    fn png_roundtrip_bounds_and_noclobber() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frame.png");
        let frame = RgbFrame {
            width: 1,
            height: 1,
            pixels: vec![1, 2, 3],
        };
        write_png_noclobber(&path, &frame).unwrap();
        assert_eq!(read_png(&path).unwrap(), frame);
        assert!(write_png_noclobber(
            &path,
            &RgbFrame {
                width: 1,
                height: 1,
                pixels: vec![9; 3]
            }
        )
        .is_err());
        assert_eq!(read_png(&path).unwrap(), frame);
        assert!(validate_png_paths(&path, &path).is_err());
        let alias = dir.path().join("alias.png");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(validate_png_paths(&path, &alias).is_err());
        assert!(read_png_bound(&path, 0).is_err());
    }
    #[test]
    fn png_rejects_nonopaque_alpha_oversize_and_bad_headers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.png");
        for (width, color, pixels, accepted) in [
            (1, png::ColorType::Rgba, vec![1, 2, 3, 255], true),
            (1, png::ColorType::Rgba, vec![1, 2, 3, 254], false),
            (513, png::ColorType::Rgb, vec![0; 513 * 3], false),
        ] {
            let mut encoder = png::Encoder::new(File::create(&path).unwrap(), width, 1);
            encoder.set_color(color);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
            writer.finish().unwrap();
            assert_eq!(read_png(&path).is_ok(), accepted);
        }
        std::fs::write(&path, b"not PNG").unwrap();
        assert!(read_png(&path).is_err());
        File::create(&path)
            .unwrap()
            .set_len(MAX_PNG_BYTES + 1)
            .unwrap();
        assert!(read_png(&path).is_err());
    }
    #[test]
    #[ignore = "requires explicit trusted ORT_LIBRARY and UPSCALE_MODEL paths and CUDA device zero"]
    fn real_cuda_reuses_session() {
        let library = std::env::var_os("ORT_LIBRARY").expect("ORT_LIBRARY");
        let model = std::env::var_os("UPSCALE_MODEL").expect("UPSCALE_MODEL");
        let mut session = SpatialUpscaler::open(Path::new(&library), Path::new(&model)).unwrap();
        let frame = RgbFrame {
            width: 8,
            height: 8,
            pixels: (0..8 * 8 * 3).map(|i| (i % 256) as u8).collect(),
        };
        let first = session.upscale(&frame).unwrap();
        let second = session.upscale(&frame).unwrap();
        assert_eq!(first, second);
        assert!(first.width >= frame.width && first.width <= frame.width * 4);
        eprintln!(
            "CUDA with CPU fallback disabled: consecutive {}x{} -> {}x{} frames",
            frame.width, frame.height, first.width, first.height
        );
        if let Some(path) = std::env::var_os("UPSCALE_TEST_INPUT") {
            write_png_noclobber(Path::new(&path), &frame).unwrap();
        }
    }
}
