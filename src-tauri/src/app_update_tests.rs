use super::*;
use std::io::Write;

#[cfg(target_os = "linux")]
#[test]
fn tauri_restart_reopens_a_scratch_probe_process() {
    const PHASE: &str = "DEAS_RESTART_TEST_PHASE";
    const MARKER: &str = "DEAS_RESTART_TEST_MARKER";
    match std::env::var(PHASE).as_deref() {
        Ok("restarted") => {
            std::fs::write(
                std::env::var_os(MARKER).unwrap(),
                std::process::id().to_string(),
            )
            .unwrap();
        }
        Ok("initial") => {
            let env = tauri::Env::default();
            tauri::process::current_binary(&env).unwrap();
            std::env::set_var(PHASE, "restarted");
            tauri::process::restart(&env);
        }
        _ => {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("restarted");
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "app_update::tests::tauri_restart_reopens_a_scratch_probe_process",
                ])
                .env(PHASE, "initial")
                .env(MARKER, &marker)
                .env_remove("APPIMAGE")
                .env_remove("APPDIR")
                .spawn()
                .unwrap();
            let first = child.id();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !marker.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            if !marker.exists() {
                let _ = child.kill();
            }
            assert!(child.wait().unwrap().success());
            let restarted: u32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
            assert_ne!(first, restarted);
        }
    }
}

fn binary() -> Vec<u8> {
    let mut bytes = vec![0u8; 128];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[16] = 3;
    bytes[18] = 62;
    bytes
}
fn asset(bytes: &[u8]) -> Asset {
    Asset {
        id: 1,
        url: "https://api.github.com/repos/darksidewalker/DEAS/releases/assets/1".into(),
        name: "deas-linux-amd64".into(),
        size: bytes.len() as u64,
        digest: Some(format!("sha256:{:x}", Sha256::digest(bytes))),
        browser_download_url:
            "https://github.com/darksidewalker/DEAS/releases/download/v999.0.0/deas-linux-amd64"
                .into(),
    }
}
fn release() -> Release {
    Release {
        tag_name: "v999.0.0".into(),
        draft: false,
        prerelease: false,
        assets: vec![asset(&binary())],
    }
}

#[test]
fn versions_are_exact_stable_triplets() {
    assert_eq!(version("v1.2.3"), Some((1, 2, 3)));
    assert_eq!(version("1.2.3"), Some((1, 2, 3)));
    for bad in [
        "vv1.2.3",
        "1.2",
        "1.2.3.4",
        "1.2.3-beta",
        "01.2.3",
        "+1.2.3",
        "1. 2.3",
        "../1.2.3",
    ] {
        assert_eq!(version(bad), None, "{bad}");
    }
    assert!(select(&release(), "999.0.0").unwrap().is_none());
    assert!(select(&release(), "1000.0.0").unwrap().is_none());
    assert!(select(&release(), "1.0.0").unwrap().is_some());
}

#[test]
fn release_selection_rejects_archives_urls_missing_integrity_and_duplicates() {
    let mut r = release();
    r.assets[0].name = "DEAS_linux.tar.zst".into();
    assert!(select(&r, "1.0.0").is_err());
    for url in [
        "http://github.com/darksidewalker/DEAS/releases/download/v999.0.0/deas-linux-amd64",
        "https://github.com/other/DEAS/releases/download/v999.0.0/deas-linux-amd64",
        "https://github.com/darksidewalker/DEAS/releases/download/v999.0.0/../deas-linux-amd64",
        "https://evil.example/deas-linux-amd64",
    ] {
        let mut r = release();
        r.assets[0].browser_download_url = url.into();
        assert!(select(&r, "1.0.0").is_err());
    }
    for digest in [
        None,
        Some("sha256:bad".into()),
        Some(format!("sha256:{}", "g".repeat(64))),
    ] {
        let mut r = release();
        r.assets[0].digest = digest;
        assert!(select(&r, "1.0.0").is_err());
    }
    for size in [0, 63, MAX_BINARY + 1] {
        let mut r = release();
        r.assets[0].size = size;
        assert!(select(&r, "1.0.0").is_err());
    }
    let mut r = release();
    r.assets[0].url = "https://api.github.com/repos/other/DEAS/releases/assets/1".into();
    assert!(select(&r, "1.0.0").is_err());
    let mut r = release();
    r.assets[0].id = 0;
    assert!(select(&r, "1.0.0").is_err());
    let mut r = release();
    r.assets.push(asset(&binary()));
    assert!(select(&r, "1.0.0").is_err());
    let mut r = release();
    r.prerelease = true;
    assert!(select(&r, "1.0.0").is_err());
    let mut r = release();
    r.draft = true;
    assert!(select(&r, "1.0.0").is_err());
}

#[test]
fn asset_redirects_are_https_fixed_hosts_without_credentials() {
    for good in [
        "https://github.com/a",
        "https://release-assets.githubusercontent.com/a?sig=secret",
        "https://objects.githubusercontent.com/a",
    ] {
        assert!(allowed_url(&Url::parse(good).unwrap()));
    }
    for bad in [
        "http://github.com/a",
        "https://github.com.evil.example/a",
        "https://user:secret@github.com/a",
        "https://github.com:444/a",
        "https://api.github.com/a",
        "https://127.0.0.1/a",
        "file:///a",
        "https://github.com/a#fragment",
    ] {
        assert!(!allowed_url(&Url::parse(bad).unwrap()), "{bad}");
    }
}

#[test]
fn bytes_require_size_digest_and_correct_elf() {
    let bytes = binary();
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(&bytes).unwrap();
    assert!(validate_binary(&mut file, bytes.len() as u64, &asset(&bytes)).is_ok());
    assert!(validate_binary(&mut file, 1, &asset(&bytes)).is_err());
    let mut corrupt = bytes.clone();
    corrupt[100] = 1;
    assert!(validate_binary(&mut file, bytes.len() as u64, &asset(&corrupt)).is_err());
    for i in [0, 4, 5, 16, 18] {
        let mut wrong = bytes.clone();
        wrong[i] = 99;
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&wrong).unwrap();
        assert!(validate_binary(&mut file, wrong.len() as u64, &asset(&wrong)).is_err());
    }
}

#[tokio::test]
async fn denied_consent_is_logged_without_execution() {
    let error = execute(false, &crate::auth::AuthState::default())
        .await
        .unwrap_err();
    assert!(error.contains("confirmation"));
    assert!(crate::logs::native_logs(0)
        .iter()
        .any(|entry| entry.text == format!("ERROR: app-update: {error}")
            && entry.source == crate::logs::Source::Deas));
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
#[tokio::test]
async fn unsupported_platform_is_explicit_before_execution() {
    assert!(execute(true, &crate::auth::AuthState::default())
        .await
        .unwrap_err()
        .contains("unsupported"));
}

#[tokio::test]
async fn streamed_transfer_checks_size_digest_status_and_redirects() {
    use std::{io::Read, net::TcpListener};
    async fn attempt(
        status: &str,
        body: Vec<u8>,
        expected: Vec<u8>,
        extra: &str,
    ) -> Result<(), String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        let extra = extra.to_string();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).unwrap() > 0);
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
                body.len()
            );
            let _ = socket.write_all(header.as_bytes());
            let _ = socket.write_all(&body);
        });
        let mut a = asset(&expected);
        a.url = format!("http://{address}/binary");
        let mut file = tempfile::tempfile().unwrap();
        let result = download(
            &client().unwrap(),
            &a,
            &mut file,
            &crate::auth::AuthState::default(),
        )
        .await;
        server.join().unwrap();
        result
    }
    let bytes = binary();
    assert!(attempt("200 OK", bytes.clone(), bytes.clone(), "")
        .await
        .is_ok());
    let mut corrupt = bytes.clone();
    corrupt[100] = 5;
    assert!(attempt("200 OK", corrupt, bytes.clone(), "")
        .await
        .unwrap_err()
        .contains("SHA-256"));
    assert!(attempt("200 OK", vec![0; 129], bytes.clone(), "")
        .await
        .is_err());
    assert!(attempt("200 OK", vec![0; 100], bytes.clone(), "")
        .await
        .is_err());
    assert!(attempt("403 Forbidden", vec![], bytes.clone(), "")
        .await
        .unwrap_err()
        .contains("403"));
    assert!(attempt(
        "302 Found",
        vec![],
        bytes.clone(),
        "Location: http://127.0.0.1:9/secret\r\n"
    )
    .await
    .is_err());
}

#[tokio::test]
async fn credentials_are_rejected_before_any_foreign_request() {
    let result = response(
        &client().unwrap(),
        "http://127.0.0.1:9/fixture",
        128,
        Some(reqwest::header::HeaderValue::from_static(
            "Bearer fixture-secret",
        )),
        true,
    )
    .await;
    let error = result.unwrap_err();
    assert!(error.contains("exact GitHub API origin"));
    assert!(!error.contains("fixture-secret"));
}

#[tokio::test]
#[ignore = "Downloads the actual public release executable into scratch; never installs it"]
async fn live_latest_release_binary_verifies_without_installing() {
    let client = client().unwrap();
    let auth = crate::auth::AuthState::default();
    if let Ok(token) = std::env::var("DEAS_LIVE_GITHUB_TOKEN") {
        auth.set("github", token, false).unwrap();
    }
    let release = latest(&client, &auth).await.unwrap();
    let asset = select(&release, "0.0.0").unwrap().unwrap();
    let mut file = tempfile::tempfile().unwrap();
    download(&client, asset, &mut file, &auth).await.unwrap();
    assert_eq!(file.metadata().unwrap().len(), asset.size);
    eprintln!(
        "Verified published {} / {} ({} bytes, {}) without replacement",
        release.tag_name,
        asset.name,
        asset.size,
        asset.digest.as_deref().unwrap()
    );
}
