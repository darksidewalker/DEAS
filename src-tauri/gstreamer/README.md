# Vendored GStreamer plugins (Linux x86_64)

WebKitGTK plays `<video>` through the host GStreamer. Without `gst-plugins-good` it aborts the web process on every video (`autoaudiosink` missing) and cannot demux MP4 or WebM. DEAS embeds these four plugins and, at startup, extracts only those whose element the host GStreamer cannot create to `$XDG_CACHE_HOME/com.dasiwa.deas/gstreamer`, which it appends to `GST_PLUGIN_PATH`. Host plugins are never shadowed.

| File | Elements WebKit needs |
|---|---|
| `libgstautodetect.so` | `autoaudiosink` |
| `libgstisomp4.so` | `qtdemux` (MP4/MOV) |
| `libgstmatroska.so` | `matroskademux` (WebM/MKV) |
| `libgstaudiofx.so` | `scaletempo` (playback rate) |

Source: Ubuntu 22.04 `gstreamer1.0-plugins-good_1.20.3-0ubuntu1.10_amd64.deb` (sha256 `9b543c3973169e37ecba092a9e4513ac12bf8cd0b9f6633f29200cd183421b2e`), unmodified. GStreamer only loads plugins built for its own or an older minor version, and 1.20 is the oldest GStreamer on any distribution with the WebKitGTK 4.1 that Tauri 2 requires. They link only against GStreamer core/plugins-base, GLib, liborc, zlib, bz2 and glibc ≥ 2.14, all present wherever WebKitGTK runs.

License: LGPL-2.1-or-later. Corresponding source: <https://gstreamer.freedesktop.org/src/gst-plugins-good/gst-plugins-good-1.20.3.tar.xz> plus the Ubuntu patches in <http://archive.ubuntu.com/ubuntu/pool/main/g/gst-plugins-good1.0/>.
