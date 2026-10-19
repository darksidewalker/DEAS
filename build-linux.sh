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
[ -d node_modules ] || npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --locked --release
mkdir -p artifacts
cp src-tauri/target/release/deas artifacts/.deas-linux-amd64.new
mv -f artifacts/.deas-linux-amd64.new artifacts/deas-linux-amd64   # atomic swap; a running app keeps its old inode
if [ "${1:-}" = "--bundle" ] || [ "${1:-}" = "--release" ]; then
  if [ "${1:-}" = "--release" ]; then touch "$S/.bundle-start"; fi
  npx tauri build --bundles deb,appimage
  cp -f src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage artifacts/ 2>/dev/null || true
fi
if [ "${1:-}" = "--release" ]; then
  cp artifacts/deas-linux-amd64 "$S/deas-linux-amd64"
  # Only files written by this bundle invocation belong to this release.
  for spec in 'deb/*.deb' 'appimage/*.AppImage'; do
    found=false
    while IFS= read -r -d '' file; do cp "$file" "$S/"; found=true; done < <(find src-tauri/target/release/bundle -path "*/$spec" -type f -newer "$S/.bundle-start" -print0)
    $found || { echo "release bundle missing: $spec" >&2; exit 1; }
  done
  if cargo xwin --version >/dev/null 2>&1; then
    cargo xwin build --manifest-path src-tauri/Cargo.toml --locked --release --target x86_64-pc-windows-msvc
    touch "$S/.bundle-start"
    npx tauri bundle --target x86_64-pc-windows-msvc --bundles nsis --ci --no-sign
    T="src-tauri/target/x86_64-pc-windows-msvc/release"
    cp "$T/deas.exe" "$S/deas.exe"
    mapfile -d '' installers < <(find "$T/bundle/nsis" -maxdepth 1 -name '*_x64-setup.exe' -type f -newer "$S/.bundle-start" -print0)
    [ "${#installers[@]}" = 1 ] || { echo "release requires exactly one new Windows installer" >&2; exit 1; }
    cp "${installers[0]}" "$S/DEAS_${V}_x64-setup.exe"
    (cd "$S" && 7z a -tzip "DEAS_${V}_windows_x64-portable.zip" deas.exe >/dev/null)
    TARGETS+=',x86_64-pc-windows-msvc'
  else
    echo "cargo xwin not installed: Windows artifacts skipped" >&2
  fi
  rm "$S/.bundle-start"
  node -e "
    const p=require('./package.json'),fs=require('fs'),cp=require('child_process'),s=c=>cp.execSync(c,{encoding:'utf8'}).trim();
    fs.writeFileSync(process.argv[1]+'/BUILD-MANIFEST.json',JSON.stringify({
      version:p.version,sourceCommit:s('git rev-parse HEAD'),sourceTree:s('git rev-parse HEAD^{tree}'),
      builtLocally:true,signed:false,
      toolchain:{rust:s('rustc --version'),node:process.version},
      targets:process.argv[2].split(','),
      linuxDirectGlibcMinimum:'2.39'},null,2)+'\n')" "$S" "$TARGETS"
  (cd "$S" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\0' | sort -z | xargs -0 sha256sum -- > SHA256SUMS)
  # Never merge a release into another invocation's destination.
  mv -T -n -- "$S" "$D"
  [ ! -e "$S" ] || { echo "release destination already exists: $D" >&2; exit 1; }
  echo "release staged: $D"
fi
echo "built: artifacts/deas-linux-amd64 ($(sha256sum artifacts/deas-linux-amd64 | cut -c1-16))"
