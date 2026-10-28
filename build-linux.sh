#!/usr/bin/env bash
# Linux build: frontend + release binary (+ optional bundles). Output: artifacts/deas-linux-amd64
# --release additionally stages a versioned release folder, cross-building Windows with cargo xwin when installed: artifacts/releases/v<version>/
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "--release" ]; then
  STATUS=$(git status --porcelain --untracked-files=all)
  [ -z "$STATUS" ] || { echo "release requires a clean tracked and untracked source tree" >&2; exit 1; }
  V=$(node -p "require('./package.json').version")
  D="artifacts/releases/v$V"
  [ ! -e "$D" ] || { echo "release destination already exists: $D" >&2; exit 1; }
  mkdir -p artifacts/releases
  S=$(mktemp -d artifacts/releases/.staging-XXXXXX)
  trap 'rm -rf -- "$S"' EXIT
  TARGETS='x86_64-unknown-linux-gnu'
fi
# Keep Cargo and Tauri outputs aligned, including a caller-selected target directory.
CARGO_TARGET_DIR="$(node -e 'console.log(require("path").resolve(process.env.CARGO_TARGET_DIR || "src-tauri/target"))')"
export CARGO_TARGET_DIR
[ -d node_modules ] || npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --locked --release
mkdir -p artifacts
cp "$CARGO_TARGET_DIR/release/deas" artifacts/.deas-linux-amd64.new
mv -f artifacts/.deas-linux-amd64.new artifacts/deas-linux-amd64   # atomic swap; a running app keeps its old inode
if { [ "${1:-}" = "--bundle" ] || [ "${1:-}" = "--release" ]; } && command -v patchelf >/dev/null 2>&1; then
  # shortcut: bundles need patchelf (deb/AppImage); skipped when absent.
  if [ "${1:-}" = "--release" ]; then DEST_COPY="$S"; else DEST_COPY="artifacts/releases"; mkdir -p "$DEST_COPY"; fi
  touch "$CARGO_TARGET_DIR/.bundle-start"
  npx tauri build --bundles deb,appimage
  # Only files written by this invocation are staged; stale bundles are excluded.
  while IFS= read -r -d '' file; do cp "$file" "$DEST_COPY/"; done < <(find "$CARGO_TARGET_DIR/release/bundle" \( -path '*/deb/*.deb' -o -path '*/appimage/*.AppImage' \) -type f -newer "$CARGO_TARGET_DIR/.bundle-start" -print0)
fi
if [ "${1:-}" = "--release" ]; then
  cp artifacts/deas-linux-amd64 "$S/deas-linux-amd64"
  # shortcut: deb/AppImage/NSIS/portable-zip bundles need Windows-only tools
  # (makensis) or patchelf; skipped here, upgrade on a native Windows runner.
  if cargo xwin --version >/dev/null 2>&1; then
    cargo xwin build --manifest-path src-tauri/Cargo.toml --locked --release --target x86_64-pc-windows-msvc
    cp "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/deas.exe" "$S/deas.exe"
    TARGETS+=',x86_64-pc-windows-msvc'
  else
    echo "cargo xwin not installed: Windows artifacts skipped" >&2
  fi
  # glibc floor straight from the binary (no nested quotes in the node line).
  GLIBC_FLOOR=$(objdump -T artifacts/deas-linux-amd64 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | sed 's/GLIBC_//' || true)
  [ -n "$GLIBC_FLOOR" ] || GLIBC_FLOOR='2.39'
  node -e "
    const p=require('./package.json'),fs=require('fs'),cp=require('child_process'),s=c=>cp.execSync(c,{encoding:'utf8'}).trim();
    fs.writeFileSync(process.argv[1]+'/BUILD-MANIFEST.json',JSON.stringify({
      version:p.version,sourceCommit:s('git rev-parse HEAD'),sourceTree:s('git rev-parse HEAD^{tree}'),
      builtLocally:true,signed:false,
      toolchain:{rust:s('rustc --version'),node:process.version},
      targets:process.argv[2].split(','),
      linuxDirectGlibcMinimum:process.argv[3]},null,2)+'\n')" "$S" "$TARGETS" "$GLIBC_FLOOR"
  (cd "$S" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\0' | sort -z | xargs -0 sha256sum -- > SHA256SUMS)
  # Never merge a release into another invocation's destination.
  mv -T -n -- "$S" "$D"
  [ ! -e "$S" ] || { echo "release destination already exists: $D" >&2; exit 1; }
  echo "release staged: $D"
fi
echo "built: artifacts/deas-linux-amd64 ($(sha256sum artifacts/deas-linux-amd64 | cut -c1-16))"
