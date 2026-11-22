use super::*;

const MAX_IMAGE_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_VIDEO_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const MAX_PREVIEW_REDIRECTS: usize = 3;

pub(super) fn cdn_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid CivitAI preview URL")?;
    validate_cdn_url(url, false)
}

fn validate_cdn_url(url: Url, redirect: bool) -> Result<Url, String> {
    let trusted_host = matches!(
        url.host_str(),
        Some("image.civitai.com" | "images.civitai.com")
    ) || redirect && url.host_str() == Some("blobs-b2.civitai.com");
    if url.scheme() != "https"
        || !trusted_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("Invalid CivitAI preview host".into());
    }
    Ok(url)
}

fn redirect_url(current: &Url, location: &str) -> Result<Url, String> {
    let url = current
        .join(location)
        .map_err(|_| "Invalid CivitAI preview redirect")?;
    validate_cdn_url(url, true)
}

pub(super) struct Cover {
    extension: &'static str,
    bytes: Vec<u8>,
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.starts_with(b"GIF89a") || bytes.starts_with(b"GIF87a") {
        Some("gif")
    } else if matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis")) {
        Some("avif")
    } else {
        None
    }
}

fn is_mp4(bytes: &[u8]) -> bool {
    if bytes.get(4..8) != Some(b"ftyp") {
        return false;
    }
    let box_size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    let Some(header) = bytes
        .get(..box_size)
        .filter(|header| (16..=4096).contains(&header.len()))
    else {
        return false;
    };
    // The major format and compatible formats occupy consecutive four-byte fields,
    // with a minor-version number between them.
    header[8..12] != *b"M4A "
        && std::iter::once(&header[8..12])
            .chain(
                header[16..]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(<[u8; 4]>::as_slice),
            )
            .any(|brand| {
                matches!(
                    brand,
                    b"isom"
                        | b"iso2"
                        | b"iso4"
                        | b"iso5"
                        | b"iso6"
                        | b"mp41"
                        | b"mp42"
                        | b"avc1"
                        | b"M4V "
                        | b"dash"
                )
            })
}

fn cover_from_bytes(bytes: Vec<u8>) -> Result<Cover, String> {
    let extension = if is_mp4(&bytes) {
        (bytes.len() <= MAX_VIDEO_PREVIEW_BYTES).then_some("mp4")
    } else if bytes.len() <= MAX_IMAGE_PREVIEW_BYTES {
        image_extension(&bytes)
    } else {
        None
    }
    .ok_or("Unsupported or oversized CivitAI preview")?;
    Ok(Cover { extension, bytes })
}

pub(super) async fn download(url: &str) -> Result<Cover, String> {
    let mut url = cdn_url(url)?;
    let timeout = Duration::from_secs(30);
    let client = client_for(false, Some(timeout))?;
    tokio::time::timeout(timeout, async {
        for hop in 0..=MAX_PREVIEW_REDIRECTS {
            // CivitAI thumbnail URLs can redirect to their blob CDN. Use a fresh
            // unauthenticated request and validate each hop before following it.
            let response = client
                .get(url.clone())
                .send()
                .await
                .map_err(|_| network_error())?;
            if !response.status().is_redirection() {
                return read_cover(response).await;
            }
            if hop == MAX_PREVIEW_REDIRECTS {
                break;
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("CivitAI preview redirect has no valid location")?;
            url = redirect_url(&url, location)?;
        }
        Err("Too many CivitAI preview redirects".into())
    })
    .await
    .map_err(|_| "CivitAI preview download timed out")?
}

async fn read_cover(mut response: reqwest::Response) -> Result<Cover, String> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len > MAX_VIDEO_PREVIEW_BYTES as u64)
    {
        return Err("CivitAI preview is unavailable or too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        if chunk.len() > MAX_VIDEO_PREVIEW_BYTES - bytes.len() {
            return Err("CivitAI preview is too large".into());
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_IMAGE_PREVIEW_BYTES && !is_mp4(&bytes) {
            return Err("CivitAI image preview is too large".into());
        }
    }
    cover_from_bytes(bytes)
}

pub(super) fn publish(source: &Source, cover: Cover) -> Result<(), String> {
    let name = if cover.extension == "mp4" {
        let stem = Path::new(&source.name)
            .file_stem()
            .and_then(std::ffi::OsStr::to_str)
            .ok_or("Invalid model filename for MP4 preview")?;
        format!("{stem}.mp4")
    } else {
        format!("{}.preview.{}", source.name, cover.extension)
    };
    publish_bytes(source, &name, &cover.bytes, false)
}

pub(super) async fn fill_missing(
    path: PathBuf,
    expected: SourceFingerprint,
    url: String,
) -> Result<(), String> {
    let opened = tokio::task::spawn_blocking(move || {
        let source = Source::open(&path)?;
        if source.stamp != expected {
            return Err("Model changed before saving its preview".to_owned());
        }
        source.verify()?;
        Ok((!index::has_local_preview(&path)).then_some((path, source)))
    })
    .await
    .map_err(|_| "Preview lookup task failed")??;
    let Some((path, source)) = opened else {
        return Ok(());
    };
    let cover = download(&url).await?;
    tokio::task::spawn_blocking(move || {
        let _commit = CACHE_PUBLICATION
            .lock()
            .map_err(|_| "Cache lock poisoned")?;
        source.verify()?;
        if !index::has_local_preview(&path) {
            publish(&source, cover)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "Preview publication task failed")?
}

pub(super) const CUSTOM_COVER_SUFFIX: &str = ".deas-preview.png";

pub(super) fn replace_custom(source: &Source, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 5 * 1024 * 1024 || image_extension(bytes) != Some("png") {
        return Err("Preview must be a PNG up to 5 MiB".into());
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 8 * 1024 * 1024,
    });
    let mut reader = decoder.read_info().map_err(|_| "Invalid PNG preview")?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 1024
        || info.height > 1024
        || info.animation_control.is_some()
        || info.bit_depth != png::BitDepth::Eight
    {
        return Err("Preview must be an 8-bit still image up to 1024 pixels per side".into());
    }
    let size = reader.output_buffer_size();
    reader
        .next_frame(&mut vec![0; size])
        .map_err(|_| "Invalid PNG preview")?;
    let _commit = CACHE_PUBLICATION
        .lock()
        .map_err(|_| "Cache lock poisoned")?;
    let name = format!("{}{CUSTOM_COVER_SUFFIX}", source.name);
    let existing = source.dir.anchor.absent(&name).is_err();
    if existing {
        source.dir.regular(&name)?;
    }
    publish_bytes(source, &name, bytes, existing)
}

fn publish_bytes(source: &Source, name: &str, bytes: &[u8], existing: bool) -> Result<(), String> {
    let mut temp = OwnedTemp::create(&source.dir)?;
    temp.file.write_all(bytes).map_err(|e| e.to_string())?;
    temp.file.sync_all().map_err(|e| e.to_string())?;
    source.verify()?;
    temp.verify()?;
    source.dir.replace(&temp.name, name, existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_input_requires_the_cdn_and_recognizable_image_bytes() {
        assert!(cdn_url("https://image.civitai.com/example").is_ok());
        for url in [
            "http://image.civitai.com/x",
            "https://image.civitai.com.evil.test/x",
            "https://user@image.civitai.com/x",
            "https://image.civitai.com:444/x",
        ] {
            assert!(cdn_url(url).is_err());
        }
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n"), Some("png"));
        assert_eq!(image_extension(b"<svg></svg>"), None);
    }

    #[test]
    fn previews_can_follow_civitai_blob_redirects_only_over_trusted_https() {
        let initial = cdn_url("https://image.civitai.com/width=450/example.jpeg").unwrap();
        let blob = redirect_url(
            &initial,
            "https://blobs-b2.civitai.com/fixture/example.jpeg",
        )
        .unwrap();
        assert_eq!(blob.host_str(), Some("blobs-b2.civitai.com"));
        assert!(redirect_url(&blob, "/fixture/example-2.jpeg").is_ok());
        assert!(cdn_url(blob.as_str()).is_err());
        for target in [
            "https://blobs-b2.civitai.com.example.invalid/example.jpeg",
            "http://blobs-b2.civitai.com/example.jpeg",
            "https://blobs-b2.civitai.com:4430/example.jpeg",
            "https://user@blobs-b2.civitai.com/example.jpeg",
            "https://example.invalid/example.jpeg",
        ] {
            assert!(redirect_url(&initial, target).is_err());
        }
    }

    #[test]
    fn fetched_cover_is_discovered_and_never_overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.safetensors");
        std::fs::write(&path, b"model").unwrap();
        let source = Source::open(&path).unwrap();
        let bytes = include_bytes!("../test-data/preview/preview.jpg").to_vec();
        let cover = || Cover {
            extension: "jpg",
            bytes: bytes.clone(),
        };
        publish(&source, cover()).unwrap();
        let image = path.with_file_name("fixture.safetensors.preview.jpg");
        assert_eq!(index::find_local_preview(&path).as_deref(), image.to_str());
        assert!(publish(&source, cover()).is_err());
        assert_eq!(std::fs::read(image).unwrap(), bytes);
    }

    #[test]
    fn fetched_mp4_is_saved_with_its_media_extension_and_discovered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.safetensors");
        std::fs::write(&path, b"model").unwrap();
        let source = Source::open(&path).unwrap();
        let bytes = include_bytes!("../test-data/preview/preview.mp4");
        let cover = || cover_from_bytes(bytes.to_vec()).unwrap();
        assert!(cover_from_bytes(bytes[..12].to_vec()).is_err());
        assert!(cover_from_bytes(b"<html>not a video</html>".to_vec()).is_err());
        publish(&source, cover()).unwrap();
        let video = path.with_file_name("fixture.mp4");
        assert_eq!(index::find_local_preview(&path).as_deref(), video.to_str());
        assert!(publish(&source, cover()).is_err());
        assert_eq!(std::fs::read(&video).unwrap(), bytes);
        let legacy = path.with_file_name("fixture.safetensors.preview.mp4");
        std::fs::rename(video, &legacy).unwrap();
        assert_eq!(index::find_local_preview(&path).as_deref(), legacy.to_str());
    }
}
