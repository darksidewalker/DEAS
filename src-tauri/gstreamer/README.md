# Vendored GStreamer plugins (Linux x86_64)

WebKitGTK plays `<video>` through the host GStreamer. Without `gst-plugins-good` it aborts the web process on every video (`autoaudiosink` missing) and cannot demux MP4 or WebM. DEAS embeds these four plugins and, at startup, extracts only those whose element the host GStreamer cannot create to `$XDG_CACHE_HOME/com.dasiwa.deas/gstreamer`, which it appends to `GST_PLUGIN_PATH`. Host plugins are never shadowed. Extraction replaces files by rename so an already-running app retains its mapped inode.

| File | Elements WebKit needs |
|---|---|
| `libgstautodetect.so` | `autoaudiosink` |
| `libgstisomp4.so` | `qtdemux` (MP4/MOV) |
| `libgstmatroska.so` | `matroskademux` (WebM/MKV), local rescan fix below |
| `libgstaudiofx.so` | `scaletempo` (playback rate) |

The three unchanged binaries come from Ubuntu 22.04 `gstreamer1.0-plugins-good_1.20.3-0ubuntu1.10_amd64.deb` (SHA-256 `9b543c3973169e37ecba092a9e4513ac12bf8cd0b9f6633f29200cd183421b2e`). GStreamer accepts plugins from its own or an older minor version. These remain 1.20 plugins, not a 1.24 runtime. They link against host GStreamer/core/plugins-base, GLib, liborc, zlib, bz2 and glibc; no core or container dependency closure is bundled or added to `LD_LIBRARY_PATH`.

## Matroska cluster rescan fix

The embedded Matroska plugin is rebuilt from the same 1.20.3 source **with the complete Ubuntu 1.10 patch series retained**, plus [`matroska-rescan.patch`](matroska-rescan.patch). A cluster byte-scan candidate that no longer parses as a cluster must continue scanning, not trigger `g_assert` and kill WebKit's web process. Backward rejection advances toward the beginning and stops at zero. This is a DEAS-local defensive patch, not an upstream-accepted change or proof that every malformed file is playable. The full 1.20 source line remains old; this fix is not a general security audit.

Rebuild from the repository root with the existing Podman engine (or `CONTAINER_ENGINE=docker`):

```sh
bash src-tauri/gstreamer/rebuild-matroska.sh /absolute/empty/output-directory
```

The script pins the Ubuntu base image digest and both source archive checksums, applies the Ubuntu patch series before the local patch, runs the scanner regression and builds only `libgstmatroska.so`. Host packages are untouched; build packages are installed only in the disposable container. Apt build-tool versions are not snapshot-pinned, so bit-for-bit reproducibility is not promised. Inspect/test the result before atomically replacing the tracked binary; the script does not modify it automatically.

- Upstream source: <https://gstreamer.freedesktop.org/src/gst-plugins-good/gst-plugins-good-1.20.3.tar.xz>, SHA-256 `f8f3c206bf5cdabc00953920b47b3575af0ef15e9f871c0b6966f6d0aa5868b7`.
- Ubuntu patches: <https://archive.ubuntu.com/ubuntu/pool/main/g/gst-plugins-good1.0/gst-plugins-good1.0_1.20.3-0ubuntu1.10.debian.tar.xz>, SHA-256 `cc6f5c8e161bafbb86f7698d8480c5e3eb688ce93ab4be1e50d2877876d8d2ab`.
- Patched binary SHA-256: `d6d2e64b2523364d16a83d64640f87d64ffc3bd95b94d620236dc05573fdd309`.
- `python tools/test_matroska_rescan.py PATH_TO_PATCHED_matroska-demux.c` extracts the actual scanner and exercises inconsistent seek reads, valid clusters and failed reads in both directions. It reproduces SIGABRT before the patch; this isolated-IO test is not full decoder acceptance.
- `/usr/bin/python tools/verify_video_playback.py MEDIA_DIR OUTPUT_DIR --generate` creates bounded CPU-encoded fixtures and checks real WebKitGTK blob playback, changing frame/pixel evidence, seeking, EOF, reopen and corrupt-input errors. Omit `--generate` to replay the same files; reports separate renderer/audio/platform limits. See [verification](../../docs/VERIFICATION.md#linux-matroska-playback-fix-0138-follow-up-shipped-in-0138).

On NVIDIA kernels DEAS defaults `WEBKIT_GST_DMABUF_SINK_DISABLED=1` before WebKit starts to avoid green video frames; this does not globally disable GPU rendering, and explicit user values, including empty values, win. Cache failures reach shared Logs without exposing filesystem paths. Windows keeps its existing WebView2 path; Linux probes do not establish Windows playback acceptance.

License: LGPL-2.1-or-later. Corresponding source is the upstream archive, Ubuntu patches and local patch linked above. Retain these source references, patch and license notices with binary redistribution; no codec pack or full GStreamer runtime is included.
