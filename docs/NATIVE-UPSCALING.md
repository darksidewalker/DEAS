# Native Rust spatial upscaling prototype

[Documentation index](README.md) · [Video plan](VIDEO-PLAN.md#w8-streamed-video-post-processing-and-paired-products) · [Verification](VERIFICATION.md)

## Scope

`video-upscale` is a Cargo feature (default-on since 0.1.56 — every Linux and Windows build includes it) for standalone Rust spatial inference and a bounded short-video streaming core. The developer examples underpin the separately enabled managed TVE renderer; they are not a finished general enhancer or arbitrary-model loader. The native TVE path adds chooser-authorized IDs and an owned job lifecycle; direct CLI paths are not frontend authority. Rust owns RGB preprocessing, the native ONNX Runtime session, output validation and no-clobber PNG publication. No Python or Go worker is used. Native ONNX Runtime/CUDA libraries execute the kernels; “Rust pipeline” does not mean reimplementing those native libraries' neural-network math.

The normal DEAS build compiles the inference path in but never initializes it at startup. Opening Studio or inspecting a source video does not load a model, initialize CUDA or download anything; the engine only runs after the user's explicit opt-in settings with a trusted runtime/model binding. No native runtime or model is bundled or auto-downloaded. The existing ComfyUI image pipeline remains separate.

## Build the managed engine

From the repository root:

```fish
npm run build
env CARGO_TARGET_DIR="$PWD/src-tauri/target" cargo build --manifest-path src-tauri/Cargo.toml --locked --release --bin deas
```

The resulting `src-tauri/target/release/deas` includes the managed engine (it is in the default features since 0.1.56) and does not initialize it at startup. Use the [TVE guide](STUDIO.md#validate-and-render-with-the-optional-native-engine) for explicit source/output and SDK selection; no global `LD_PRELOAD` is needed when the optional dependency is selected for the owned worker.

## Dependencies and supported contract

The feature pins `ort = 2.0.0-rc.15`, with default features disabled and explicit `std`, `load-dynamic`, `half`, `cuda` and `api-29`. It requires Rust 1.92 or newer and a compatible native ONNX Runtime library exporting API 29, its CUDA execution provider, matching CUDA/cuDNN dependencies and NVIDIA device 0. Dynamic loading does not install or download a runtime. Missing or incompatible dependencies fail; there is no silent CPU fallback.

Supply an explicitly trusted local native library and trusted embedded-weight ONNX model. The initial acceptance target is the existing 2× NomosUni SPAN multijpg FP16 model, not every ONNX architecture. Exactly one FP16 NCHW input and output with batch one and three RGB channels are supported. RGB is normalized to `[0,1]`; RGB input is not swapped to BGR. Actual returned dimensions must establish the same integral scale in both axes (1–4×), with matching tensor length and finite values. The filename and repeated symbolic dimension names are not scale evidence.

Input PNGs are static 8-bit RGB or fully opaque RGBA, at most 512 pixels on each edge. Alpha, animation and other bit depths/formats are rejected rather than silently converted. Model input bytes are capped at 64 MiB; encoded PNGs and decoding allocations are bounded. Output is 8-bit RGB PNG. The PNG example does not preserve or validate ICC/color metadata, HDR precision, temporal consistency or video timing/audio. It has no tiler and does not advertise full-resolution video support.

**Trust limits:** these caps are not a sandbox for arbitrary ONNX graph allocations or native library execution. The runtime's first loaded native library is process-global; changing the path in a later session cannot switch that process to another runtime. Restart the developer example to select another library. Source/file checks are not protection against hostile same-user filesystem mutation. No inference IPC accepting browser-provided library/model paths is exposed.

## Run the explicit PNG example

From the repository root, set paths to your trusted installed runtime, existing model, input and a **new** output. Example fish syntax:

```fish
set -l ort /absolute/path/to/libonnxruntime.so
set -l model /absolute/path/to/embedded-fp16-model.onnx
set -l input /absolute/path/to/input.png
set -l output /absolute/path/to/new-output.png
cargo run --locked --manifest-path src-tauri/Cargo.toml --example upscale_png -- "$ort" "$model" "$input" "$output"
```

On Windows, supply a compatible local ONNX Runtime DLL and its native dependencies instead; Linux library discovery is not Windows deployment or execution evidence. Model/native library paths are developer-trusted execution inputs, not downloadable URLs. Do not make symlinks between incompatible TensorRT/ONNX Runtime ABI versions to bypass missing-library errors.

The example validates input and destination, reads the source, initializes the CUDA-only session, executes one frame and writes a verified PNG. It stages beside the destination, flushes/syncs and decodes the encoded PNG before publishing without replacing any existing entry. Existing files, including aliases of the source, are refused. A failed operation must not be mistaken for a published result. Native diagnostics are sanitized and bounded in central Logs; the example's terminal result does not establish a quality or performance benchmark.

## Run the bounded short-video example

`upscale_video` adds a Linux-only developer path using the same optional feature and real reusable `SpatialUpscaler` session. It does not expose a TVE Run command or accept browser-authorized source/model handles. Supply absolute trusted local paths and a **new** `.mp4` destination:

```fish
set -l ort /absolute/path/to/libonnxruntime.so
set -l model /absolute/path/to/embedded-fp16-model.onnx
set -l input /absolute/path/to/source.mp4
set -l output /absolute/path/to/new-processed.mp4
cargo run --locked --manifest-path src-tauri/Cargo.toml --example upscale_video -- "$ort" "$model" "$input" "$output"
```

This initial core is deliberately narrow: source/output files at most 256 MiB; input edges at most 512 pixels; output edges at most 2048 pixels; 2–600 frames, at most 10 seconds and 120 fps; one progressive opaque BT.709 SDR video, square pixels, known range, zero start, and at most one zero-start audio stream. Subtitle/data/attachment streams, unknown or changing per-frame properties, nonzero offsets, unsupported color and inexact/VFR timestamps are rejected. Every frame PTS and complete stream duration must agree exactly with the rational cadence; equal header rates alone are insufficient. Containers that omit exact stream durations are not accepted. There is no tiling, interpolation, HDR or unrestricted long-video support.

Rust streams one reusable RGB input and one processed frame through native FFmpeg pipes with backpressure. It explicitly converts the processed RGB into limited-range BT.709 `yuv420p`, encodes H.264, and maps optional audio to AAC 192 kbit/s while checking sample rate/channel count. Unlike the metadata-only TVE draft selector, this first executable core supports **MP4/H.264 only**. The source remains the imported Original; it is not rewritten or duplicated. Private same-filesystem staging, full frame/timing/color/audio checks, completed-file decode, source-identity and cancellation checks precede atomic hard-link no-replace publication. Filesystems that cannot provide this publication fail rather than overwriting a destination. The staged file is fsynced but the destination directory is not: publication is atomic/no-clobber, not guaranteed crash-durable.

Pipe/wait operations check cancellation and a five-minute cooperative deadline; retained stderr and probe JSON are bounded, encoded children have an OS file-size cap, and Linux process groups are owned, terminated and reaped. Ctrl+C/SIGTERM request cleanup. Initial source inspection has its own ten-second timeout and observes cancellation only after returning. **A synchronous native model call must return before cancellation/deadline handling can resume**; this is not a hard-deadline GPU worker. The core explicitly rejects Windows/other-platform execution until equivalent ownership/publication is verified. Trusted-path checks are not a hostile same-user filesystem sandbox, and no resource/performance improvement has been measured.

### Installed Linux cuDNN linkage prerequisite

On the verified host, the installed `libonnxruntime_providers_cuda.so` references `cudnnGetConvolutionBackwardDataAlgorithm_v7` without a cuDNN `DT_NEEDED` entry. Existing `/usr/lib/libcudnn.so.9` exports that symbol. An explicit **process-scoped** launch resolves this installed-library linkage issue:

```fish
env LD_PRELOAD=/usr/lib/libcudnn.so.9 cargo run --locked --manifest-path src-tauri/Cargo.toml --example upscale_png -- "$ort" "$model" /absolute/path/to/input.png /absolute/path/to/new-output.png
```

Use this only for matching trusted installed libraries; it is not a universal ORT/CUDA requirement or a runtime installer. DEAS does not silently preload libraries, alter system loader configuration or create ABI-version symlinks. The real two-frame PNG inference succeeded with this explicit prerequisite. Subsequent four-frame CUDA video and managed parent/application-worker publication also passed; see [native evidence and remaining GUI acceptance](VERIFICATION.md#native-preparation-and-real-ai-video-core-0154-development). Do not run competing GPU work when the device is occupied, and never stop foreign services to make room automatically.

Linux runtime library paths containing `$` are rejected at the common native-load boundary because glibc expands tokens even in `dlopen` filenames. Values are not repaired or escaped into another library; ordinary runtime/model spaces remain supported. Optional preload dependencies additionally reject colon and whitespace.

## Verification and remaining work

Pure conversion/shape/PNG/publication/log tests must not require installed runtime libraries. Real CUDA tests are explicit opt-in and use existing local weights; test fixtures do not download models. Record the exact model/runtime/device, actual output dimensions, source preservation and execution outcome in [Verification](VERIFICATION.md), distinguishing static checks from a real run.

The optional managed TVE path now binds retained source/model/output authority, starts the current executable as an isolated native worker, coordinates DEAS-managed Comfy submissions and supervises cancellation/final no-clobber publication. Use [Validate and render](STUDIO.md#validate-and-render-with-the-optional-native-engine); the normal build still keeps this engine off. Larger inputs need model-specific halo tiling and separate acceptance. OS-dialog/live-WebView and Windows-render acceptance, native video comparison, persistent history/library integration and quality/resource benchmarking remain separate. Direct examples do not grant browser execution authority.

## Attribution

`ort` is MIT OR Apache-2.0; ONNX Runtime is MIT. Philip Hofmann's [2xNomosUni_span_multijpg release](https://github.com/Phhofm/models/releases/tag/2xNomosUni_span_multijpg) specifies CC BY 4.0. No model or native runtime is bundled by this feature. CUDA/cuDNN and the selected codec/runtime distributions retain separate licenses and deployment conditions. See [Credits](CREDITS.md).
