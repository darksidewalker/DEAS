@echo off
REM Windows build: frontend + release binary + NSIS installer. Output: artifacts\deas-windows-x86_64.exe and the installer.
REM Needs: Node.js, Rust (MSVC toolchain), Visual Studio Build Tools, WebView2 runtime.
setlocal
cd /d "%~dp0"
if not exist node_modules call npm ci || exit /b 1
call npm run build || exit /b 1
cargo build --manifest-path src-tauri\Cargo.toml --locked --release || exit /b 1
if not exist artifacts mkdir artifacts
copy /y src-tauri\target\release\deas.exe artifacts\deas-windows-x86_64.exe >nul || exit /b 1
if "%~1"=="--bundle" (
  call npx tauri build --bundles nsis || exit /b 1
  copy /y src-tauri\target\release\bundle\nsis\*.exe artifacts\ >nul
)
echo built: artifacts\deas-windows-x86_64.exe
endlocal
