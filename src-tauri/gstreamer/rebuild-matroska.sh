#!/usr/bin/env bash
# Rebuild only the patched Matroska plugin, never a shadowing GStreamer runtime.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
engine=${CONTAINER_ENGINE:-podman}
image=docker.io/library/ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956
out=${1:?Usage: bash src-tauri/gstreamer/rebuild-matroska.sh ABSOLUTE_OUTPUT_DIRECTORY}
[[ "$out" = /* ]] || { printf 'Output directory must be absolute\n' >&2; exit 1; }
mkdir -p -- "$out"
[[ ! -e "$out/libgstmatroska.so" ]] || { printf 'Output plugin already exists; use a fresh directory\n' >&2; exit 1; }
"$engine" run --rm --network=bridge -v "$root:/repo:ro" -v "$out:/out" "$image" bash -euc '
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential meson ninja-build pkg-config patch python3 libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev zlib1g-dev libbz2-dev
mkdir -p /build
cd /build
curl --fail --location --retry 3 --output good.tar.xz https://gstreamer.freedesktop.org/src/gst-plugins-good/gst-plugins-good-1.20.3.tar.xz
printf "%s  good.tar.xz\n" f8f3c206bf5cdabc00953920b47b3575af0ef15e9f871c0b6966f6d0aa5868b7 | sha256sum --check
tar -xf good.tar.xz
cd gst-plugins-good-1.20.3
# Retain the exact Ubuntu security/backport series of the original bundled plugin.
curl --fail --location --retry 3 --output debian.tar.xz https://archive.ubuntu.com/ubuntu/pool/main/g/gst-plugins-good1.0/gst-plugins-good1.0_1.20.3-0ubuntu1.10.debian.tar.xz
printf "%s  debian.tar.xz\n" cc6f5c8e161bafbb86f7698d8480c5e3eb688ce93ab4be1e50d2877876d8d2ab | sha256sum --check
tar -xf debian.tar.xz
while IFS= read -r entry; do
  [[ -z "$entry" || "$entry" = \#* ]] && continue
  patch -p1 < "debian/patches/$entry"
done < debian/patches/series
patch -p1 < /repo/src-tauri/gstreamer/matroska-rescan.patch
python3 /repo/tools/test_matroska_rescan.py gst/matroska/matroska-demux.c
meson setup build --buildtype=release --wrap-mode=nodownload -Dauto_features=disabled -Dmatroska=enabled -Dbz2=enabled -Dtests=disabled -Dexamples=disabled -Ddoc=disabled -Dnls=disabled -Dpackage-name="DEAS Matroska rescan fix" -Dpackage-origin=https://github.com/darksidewalker/DEAS
ninja -C build gst/matroska/libgstmatroska.so
strip --strip-unneeded build/gst/matroska/libgstmatroska.so
# Never copy core libraries or their container dependency closure into the app.
cp build/gst/matroska/libgstmatroska.so /out/libgstmatroska.so
sha256sum /out/libgstmatroska.so
ldd /out/libgstmatroska.so
'
