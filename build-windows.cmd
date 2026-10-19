@echo off
REM Windows build: frontend + release binary + NSIS installer. Output: artifacts\deas-windows-x86_64.exe and the installer.
REM --release stages a fresh Windows-only versioned release folder; Linux writes its own BUILD-MANIFEST.json.
REM Needs: Node.js, Rust (MSVC toolchain), Visual Studio Build Tools, WebView2 runtime.
setlocal
set S=
cd /d "%~dp0"
if "%~1"=="--release" (call :preflight || goto build_error)
if not exist node_modules (call npm ci || goto build_error)
call npm run build || goto build_error
cargo build --manifest-path src-tauri\Cargo.toml --locked --release || goto build_error
if not exist artifacts mkdir artifacts
copy /y src-tauri\target\release\deas.exe artifacts\deas-windows-x86_64.exe >nul || goto build_error
if "%~1"=="--bundle" (call :bundle || goto build_error)
if "%~1"=="--release" (
  call :bundle || goto build_error
  call :release || goto build_error
)
echo built: artifacts\deas-windows-x86_64.exe
endlocal
exit /b 0

:preflight
git rev-parse --is-inside-work-tree >nul 2>&1 || exit /b 1
for /f "delims=" %%f in ('git status --porcelain --untracked-files^=all') do (
  echo release requires a clean tracked and untracked source tree 1>&2
  exit /b 1
)
set V=
for /f %%v in ('node -p "require(\"./package.json\").version"') do set V=%%v
if "%V%"=="" (
  echo release: could not read version from package.json 1>&2
  exit /b 1
)
set D=artifacts\releases\v%V%
if exist "%D%" (
  echo release destination already exists: %D% 1>&2
  exit /b 1
)
set STAGING=%D%.staging-%RANDOM%-%RANDOM%
if exist "%STAGING%" exit /b 1
mkdir "%STAGING%" || exit /b 1
set S=%STAGING%
exit /b 0

:bundle
if defined S (
  set BUILD_START=
  for /f %%t in ('powershell -NoProfile -Command "[DateTime]::UtcNow.ToFileTimeUtc()"') do set BUILD_START=%%t
  if not defined BUILD_START exit /b 1
)
call npx tauri build --bundles nsis || exit /b 1
copy /y src-tauri\target\release\bundle\nsis\*.exe artifacts\ >nul || exit /b 1
exit /b 0

:release
copy /y src-tauri\target\release\deas.exe "%S%\deas.exe" >nul || exit /b 1
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $files=@(Get-ChildItem 'src-tauri\target\release\bundle\nsis\*_x64-setup.exe' -File | Where-Object { $_.LastWriteTimeUtc.ToFileTimeUtc() -ge %BUILD_START% }); if ($files.Count -ne 1) { throw 'release requires exactly one new Windows installer' }; Copy-Item -LiteralPath $files[0].FullName -Destination '%S%\DEAS_%V%_x64-setup.exe'" || exit /b 1
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Compress-Archive -Path '%S%\deas.exe' -DestinationPath '%S%\DEAS_%V%_windows_x64-portable.zip'" || exit /b 1
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $d='%S%\'; [IO.File]::WriteAllText($d+'SHA256SUMS', ((Get-ChildItem -File $d | %% { (Get-FileHash $_.FullName).Hash.ToLower()+'  '+$_.Name }) -join \"`n\")+\"`n\")" || exit /b 1
if exist "%D%" exit /b 1
REM Rename within the parent, never merge into an existing directory.
ren "%S%" "v%V%" || exit /b 1
set S=
echo release staged: %D%
exit /b 0

:build_error
if defined S rmdir /s /q "%S%"
endlocal
exit /b 1
