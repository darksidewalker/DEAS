use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![127; width as usize * height as usize * 4])
            .unwrap();
    }
    bytes
}

fn completed(base: &str) -> Jobs {
    let jobs = Jobs::default();
    let intent = super::super::tests::intent();
    jobs.lock().unwrap().job = Some(Job {
        id: "job-a".into(),
        plan: Plan {
            id: "plan".into(),
            base: reqwest::Url::parse(base).unwrap(),
            graph: compile(&intent).unwrap(),
            intent,
            consumed: true,
        },
        client_id: "client".into(),
        prompt_id: None,
        state: "succeeded",
        outputs: vec![json!({"filename":"image.png","subfolder":"DEAS/run-1","type":"output"})],
        error: None,
        submitting: false,
        polling: false,
    });
    jobs
}

async fn binary_server(
    body: Vec<u8>,
    status: u16,
    headers: &str,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/prefix/comfy/", listener.local_addr().unwrap());
    let headers = headers.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if bytes.windows(4).any(|b| b == b"\r\n\r\n") {
                break;
            }
        }
        let head = format!("HTTP/1.1 {status} Fixture\r\n{headers}\r\nConnection: close\r\n\r\n");
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(&body).await;
        String::from_utf8(bytes).unwrap()
    });
    (base, task)
}

#[tokio::test]
async fn refuses_non_png_transport_and_invalid_complete_images_without_caching() {
    let good = png_bytes(512, 768);
    let mut crc = good.clone();
    crc[29] ^= 1;
    let mut trailing = good.clone();
    trailing.extend_from_slice(b"<script>unsafe</script>");
    for (name, body, status, headers) in [
        (
            "mime",
            good.clone(),
            200,
            "Content-Type: image/svg+xml".to_owned(),
        ),
        ("missing_mime", good.clone(), 200, String::new()),
        (
            "redirect",
            good.clone(),
            302,
            "Content-Type: image/png\r\nLocation: http://127.0.0.1:9/forbidden".into(),
        ),
        (
            "http_error",
            good.clone(),
            500,
            "Content-Type: image/png".into(),
        ),
        (
            "html",
            b"<html>error</html>".to_vec(),
            200,
            "Content-Type: image/png".into(),
        ),
        (
            "svg",
            b"<svg/>".to_vec(),
            200,
            "Content-Type: image/png".into(),
        ),
        (
            "truncated",
            good[..good.len() - 1].to_vec(),
            200,
            "Content-Type: image/png".into(),
        ),
        ("crc", crc, 200, "Content-Type: image/png".into()),
        (
            "dimensions",
            png_bytes(64, 64),
            200,
            "Content-Type: image/png".into(),
        ),
        ("trailing", trailing, 200, "Content-Type: image/png".into()),
        (
            "advertised_size",
            good,
            200,
            format!(
                "Content-Type: image/png\r\nContent-Length: {}",
                16 * 1024 * 1024 + 1
            ),
        ),
        (
            "actual_size",
            vec![0; 16 * 1024 * 1024 + 1],
            200,
            "Content-Type: image/png".into(),
        ),
        (
            "chunked_size",
            format!(
                "1000001\r\n{}\r\n0\r\n\r\n",
                "x".repeat(16 * 1024 * 1024 + 1)
            )
            .into_bytes(),
            200,
            "Content-Type: image/png\r\nTransfer-Encoding: chunked".into(),
        ),
    ] {
        let (base, server) = binary_server(body, status, &headers).await;
        let jobs = completed(&base);
        assert!(
            jobs.output("job-a".into(), 0).await.is_err(),
            "accepted {name}"
        );
        assert!(jobs.lock().unwrap().output.is_none(), "cached {name}");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn rejects_wrong_job_state_index_and_metadata_before_network() {
    let jobs = completed("http://127.0.0.1:9/");
    for state in ["queued", "running", "unknown", "failed"] {
        jobs.lock().unwrap().job.as_mut().unwrap().state = state;
        let error = jobs.output("job-a".into(), 0).await.err().unwrap();
        assert!(error.contains("succeeded"), "{error}");
    }
    jobs.lock().unwrap().job.as_mut().unwrap().state = "succeeded";
    assert!(jobs
        .output("other".into(), 0)
        .await
        .err()
        .unwrap()
        .contains("Unknown"));
    assert!(jobs
        .output("job-a".into(), 1)
        .await
        .err()
        .unwrap()
        .contains("index"));
    jobs.lock().unwrap().job.as_mut().unwrap().outputs[0]["filename"] = json!("../secret.png");
    assert!(jobs
        .output("job-a".into(), 0)
        .await
        .err()
        .unwrap()
        .contains("Unsafe"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn exports_only_cached_original_to_explicit_new_private_png() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    let dir = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let bytes = png_bytes(512, 768);
    let (base, server) = binary_server(bytes.clone(), 200, "Content-Type: image/png").await;
    let jobs = completed(&base);
    let path = dir.path().join("new.png");
    assert!(jobs.export_to("job-a", 0, Some(&path)).is_err());
    assert!(!path.exists());
    jobs.output("job-a".into(), 0).await.unwrap();
    server.await.unwrap(); // Export must work with its HTTP server gone.
    assert_eq!(jobs.export_to("job-a", 0, None).unwrap(), None);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let result = jobs.export_to("job-a", 0, Some(&path)).unwrap().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(result["size"], bytes.len());
    assert_eq!(result["sha256"], format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    for bad in [
        path.clone(),
        dir.path().join("bad.jpg"),
        std::path::PathBuf::from("relative.png"),
        dir.path().join("missing/new.png"),
    ] {
        assert!(jobs.export_to("job-a", 0, Some(&bad)).is_err());
    }
    let link = dir.path().join("link.png");
    symlink(&path, &link).unwrap();
    assert!(jobs.export_to("job-a", 0, Some(&link)).is_err());
    assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o640);
    let bad_parent = dir.path().join("writable");
    std::fs::create_dir(&bad_parent).unwrap();
    std::fs::set_permissions(&bad_parent, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(jobs
        .export_to("job-a", 0, Some(&bad_parent.join("x.png")))
        .is_err());
    let parent_link = dir.path().join("linked");
    symlink(dir.path(), &parent_link).unwrap();
    assert!(jobs
        .export_to("job-a", 0, Some(&parent_link.join("x.png")))
        .is_err());
    assert!(jobs
        .export_to("other", 0, Some(&dir.path().join("x.png")))
        .is_err());
    assert!(jobs
        .export_to("job-a", 1, Some(&dir.path().join("x.png")))
        .is_err());
    assert!(!dir.path().join("x.png").exists());
    assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".deas-")));
}

#[tokio::test]
async fn rejects_animation_and_crc_errors_in_image_end_and_ignored_metadata() {
    let good = png_bytes(512, 768);
    let mut variants = vec![png_bytes(2056, 64)];
    let mut offset = 8;
    while offset < good.len() {
        let length = u32::from_be_bytes(good[offset..offset + 4].try_into().unwrap()) as usize;
        if [&b"IDAT"[..], &b"IEND"[..]].contains(&&good[offset + 4..offset + 8]) {
            let mut bad = good.clone();
            bad[offset + 8 + length] ^= 1;
            variants.push(bad);
        }
        offset += length + 12;
    }
    let mut metadata = vec![];
    {
        let encoder = png::Encoder::new(&mut metadata, 512, 768);
        let mut writer = encoder.write_header().unwrap();
        writer.write_chunk(png::chunk::tEXt, b"key\0value").unwrap();
        writer.write_image_data(&vec![0; 512 * 768]).unwrap();
    }
    let text = metadata.windows(4).position(|b| b == b"tEXt").unwrap();
    metadata[text + 4 + 9] ^= 1;
    variants.push(metadata);
    let mut animated = vec![];
    {
        let mut encoder = png::Encoder::new(&mut animated, 512, 768);
        encoder.set_animated(1, 0).unwrap();
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![0; 512 * 768])
            .unwrap();
    }
    variants.push(animated);
    for (i, body) in variants.into_iter().enumerate() {
        let (base, server) = binary_server(body, 200, "Content-Type: image/png").await;
        let jobs = completed(&base);
        assert!(
            jobs.output("job-a".into(), 0).await.is_err(),
            "accepted corrupt/animated fixture {i}"
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn output_timeout_is_total_and_does_not_cache_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let jobs = completed(&format!("http://{}/", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(12)).await;
    });
    let start = std::time::Instant::now();
    assert!(jobs.output("job-a".into(), 0).await.is_err());
    assert!(start.elapsed() >= Duration::from_secs(9));
    assert!(start.elapsed() < Duration::from_secs(11));
    assert!(jobs.lock().unwrap().output.is_none());
    server.abort();
}

#[tokio::test]
async fn fetch_is_exclusive_and_replaced_jobs_cannot_publish_results() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let jobs = completed(&format!("http://{}/", listener.local_addr().unwrap()));
    let (received, ready) = tokio::sync::oneshot::channel();
    let (release, go) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        received.send(()).unwrap();
        go.await.unwrap();
        let body = png_bytes(512, 768);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
    });
    let fetch = jobs.output("job-a".into(), 0);
    let steer = async {
        ready.await.unwrap();
        let error =
            tokio::time::timeout(Duration::from_millis(200), jobs.output("job-a".into(), 0))
                .await
                .expect("duplicate fetch must fail immediately")
                .err()
                .unwrap();
        assert!(error.contains("progress"));
        jobs.lock().unwrap().job.as_mut().unwrap().id = "replacement".into();
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(fetch, steer);
    assert!(result.err().unwrap().contains("changed"));
    assert!(jobs.lock().unwrap().output.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn original_png_is_fetched_from_stored_metadata_and_cached() {
    let bytes = png_bytes(512, 768);
    let (base, server) = binary_server(
        bytes.clone(),
        200,
        &format!(
            "Content-Type: image/png; charset=binary\r\nContent-Length: {}",
            bytes.len()
        ),
    )
    .await;
    let jobs = completed(&base);
    let result = jobs.output("job-a".into(), 0).await.unwrap();
    assert_eq!(result.bytes, bytes);
    assert_eq!(result.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!((result.width, result.height), (512, 768));
    let request = server.await.unwrap();
    assert_eq!(
        request.lines().next().unwrap(),
        "GET /prefix/comfy/view?filename=image.png&subfolder=DEAS%2Frun-1&type=output HTTP/1.1"
    );
    assert_eq!(jobs.output("job-a".into(), 0).await.unwrap().bytes, bytes);
    assert!(jobs.current().unwrap().get("bytes").is_none());
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["mimeType"], "image/png");
    assert_eq!(value["jobId"], "job-a");
}
