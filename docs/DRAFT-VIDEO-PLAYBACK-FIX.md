# DRAFT — Linux video playback fix (verified root cause, patch superseded by in-app fix)

Status: draft / superseded. DEAS ships its own fix as of 0.1.37+; this record preserves the
verified findings from the external dummy audit (2026-10-21) so the fix stays reproducible.
No repo code was changed by the audit; the patch and vendor build were deleted after DEAS
solved the issue in-app.

## Verified root cause

WebKitGTK plays video through GStreamer. DEAS's bundled GStreamer runtime (27 plugins +
full container dependency closure, ~218 libs) broke playback on Arch/CachyOS because the
runtime directory is on `LD_LIBRARY_PATH` app-wide and shadowed system libraries that
system GTK/WebKit/GIO link against:

- `libmount.so.1`, `libsystemd.so.0` → PyGObject/GIO crash (`must be an interface`), WebKit class load fails.
- `libnghttp2.so.14` → system `libsoup-3.0` fails (`undefined symbol: nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation`), WebView instantiation fails.
- `libbrotlidec.so.1` → system `libsoup-3.0` fails (`undefined symbol: BrotliDecoderAttachDictionary`).
- `libgstreamer-1.0.so.0` (1.24) → system GStreamer tools fail (`undefined symbol: gst_structure_filter_and_map_in_place_id_str`).

Any system-provided soname in the bundled runtime dir is contamination: it shadows the
newer system version for the whole app.

## Verified fix (11/11 playback, blob transport = app path)

Bundle = 27 GStreamer 1.24.12 plugins + the codec closure the plugins need that the system
does NOT provide — 42 libs (libavcodec.so.58/avformat/avfilter/avutil, dav1d, vpx, x264/x265,
theora, opus→system, vorbis→system, ogg→system …). Compute mechanically:
`ldd` each plugin under `LD_LIBRARY_PATH=<bundle>`; drop every soname listed by
`ldconfig -p` (system wins). Result: no shadowing, system core 1.28 loads the 1.24 plugins
(plugin version ≥ core requirement), WebKitGTK works.

Startup env (mirrored by the dummy, proven working):
`LD_LIBRARY_PATH=<rt>/lib`, `GST_PLUGIN_PATH=<rt>/plugins`, `GST_TYPE_PLUGIN_PATH=<rt>/plugins`,
`GST_REGISTRY_FLUSH=1`, `__NV_DISABLE_EXPLICIT_SYNC=1`, and on NVIDIA kernels
`WEBKIT_GST_DMABUF_SINK_DISABLED=1` (zero-copy DMABUF sink shows green frames on the nvidia driver).

Acceptance matrix (dummy, WebKit blob URL, play+seek mid-cluster+seek-EOF+reopen):
AV1/AAC MP4, AV1/Opus MKV, AV1 silent MP4, AV1/Opus WebM, HEVC/AAC MKV, VP9 WebM, VP8 WebM,
H.264 MP4, H.264 MKV, plus AV1 MP4/MKV re-encodes — 11/11 ALIVE, exit 0.

## Rebuild hint

Vendor plugins: gst 1.24.12 sources (core/base/good/bad/ugly/libav) built in a pinned
Debian-slim container with ffmpeg 5.x for the libav plugin; ship plugin .so files only,
never the container's system libs.
