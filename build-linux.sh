#!/usr/bin/env bash
# Linux build: frontend + release binary (+ optional bundles). Output: artifacts/deas-linux-amd64
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --locked --release
mkdir -p artifacts
cp src-tauri/target/release/deas artifacts/.deas-linux-amd64.new
mv -f artifacts/.deas-linux-amd64.new artifacts/deas-linux-amd64   # atomic swap; a running app keeps its old inode
if [ "${1:-}" = "--bundle" ]; then
  npx tauri build --bundles deb,appimage
  cp -f src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage artifacts/ 2>/dev/null || true
fi
echo "built: artifacts/deas-linux-amd64 ($(sha256sum artifacts/deas-linux-amd64 | cut -c1-16))"
