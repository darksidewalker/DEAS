# Native Rust spatial upscaling prototype

[Documentation index](README.md) · [Video plan](VIDEO-PLAN.md#w8-streamed-video-post-processing-and-paired-products) · [Verification](VERIFICATION.md)

## Scope

`video-upscale` is an optional, default-off Cargo feature for the first standalone Rust inference primitive. It is a developer example, not a Studio video Render action, a finished enhancer or an arbitrary-model loader. Rust owns RGB preprocessing, the native ONNX Runtime session, output validation and no-clobber PNG publication. No Python or Go worker is used. Native ONNX Runtime/CUDA libraries execute the kernels; “Rust pipeline” does not mean reimplementing those native libraries' neural-network math.

The normal DEAS build does not include or initialize this optional inference path. Opening Studio or inspecting a source video does not load a model, initialize CUDA or download anything. The existing ComfyUI image pipeline remains separate.

## Dependencies and supported contract

The feature pins `ort = 2.0.0-rc.15`, with default features disabled and explicit `std`, `load-dynamic`, `half`, `cuda` and `api-29`. It requires Rust 1.92 or newer and a compatible native ONNX Runtime library exporting API 29, its CUDA execution provider, matching CUDA/cuDNN dependencies and NVIDIA device 0. Dynamic loading does not install or download a runtime. Missing or incompatible dependencies fail; there is no silent CPU fallback.

Supply an explicitly trusted local native library and trusted embedded-weight ONNX model. The initial acceptance target is the existing 2× NomosUni SPAN multijpg FP16 model, not every ONNX architecture. Exactly one FP16 NCHW input and output with batch one and three RGB channels are supported. RGB is normalized to `[0,1]`; RGB input is not swapped to BGR. Actual returned dimensions must establish the same integral scale in both axes (1–4×), with matching tensor length and finite values. The filename and repeated symbolic dimension names are not scale evidence.

Input PNGs are static 8-bit RGB or fully opaque RGBA, at most 512 pixels on each edge. Alpha, animation and other bit depths/formats are rejected rather than silently converted. Model input bytes are capped at 64 MiB; encoded PNGs and decoding allocations are bounded. Output is 8-bit RGB PNG. This prototype does not preserve or validate ICC/color metadata, HDR precision, temporal consistency or full video timing/audio. It has no tiler and does not advertise full-resolution video support.

**Trust limits:** these caps are not a sandbox for arbitrary ONNX graph allocations or native library execution. The runtime's first loaded native library is process-global; changing the path in a later session cannot switch that process to another runtime. Restart the developer example to select another library. Source/file checks are not protection against hostile same-user filesystem mutation. No inference IPC accepting browser-provided library/model paths is exposed.

## Run the explicit PNG example

From the repository root, set paths to your trusted installed runtime, existing model, input and a **new** output. Example fish syntax:

```fish
set -l ort /absolute/path/to/libonnxruntime.so
set -l model /absolute/path/to/embedded-fp16-model.onnx
set -l input /absolute/path/to/input.png
set -l output /absolute/path/to/new-output.png
cargo run --locked --manifest-path src-tauri/Cargo.toml --features video-upscale --example upscale_png -- "$ort" "$model" "$input" "$output"
```

On Windows, supply a compatible local ONNX Runtime DLL and its native dependencies instead; Linux library discovery is not Windows deployment or execution evidence. Model/native library paths are developer-trusted execution inputs, not downloadable URLs. Do not make symlinks between incompatible TensorRT/ONNX Runtime ABI versions to bypass missing-library errors.

The example validates input and destination, reads the source, initializes the CUDA-only session, executes one frame and writes a verified PNG. It stages beside the destination, flushes/syncs and decodes the encoded PNG before publishing without replacing any existing entry. Existing files, including aliases of the source, are refused. A failed operation must not be mistaken for a published result. Native diagnostics are sanitized and bounded in central Logs; the example's terminal result does not establish a quality or performance benchmark.

## Verification and remaining work

Pure conversion/shape/PNG/publication/log tests must not require installed runtime libraries. Real CUDA tests are explicit opt-in and use existing local weights; test fixtures do not download models. Record the exact model/runtime/device, actual output dimensions, source preservation and execution outcome in [Verification](VERIFICATION.md), distinguishing static checks from a real run.

Before Studio video execution: retain a validated source/output plan, reuse the verified session across bounded decode/process/encode, implement model-specific halo tiling, cancellation and GPU coordination, preserve rational cadence/audio/color, decode/read back the completed output and publish it atomically without clobbering originals. No video execution is enabled by this example.

## Attribution

`ort` is MIT OR Apache-2.0; ONNX Runtime is MIT. Philip Hofmann's [2xNomosUni_span_multijpg release](https://github.com/Phhofm/models/releases/tag/2xNomosUni_span_multijpg) specifies CC BY 4.0. No model or native runtime is bundled by this feature. CUDA/cuDNN and the selected codec/runtime distributions retain separate licenses and deployment conditions. See [Credits](CREDITS.md).
