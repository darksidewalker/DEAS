use super::*;
use sha2::{Digest, Sha256};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPreview {
    job_id: String,
    index: usize,
    mime_type: &'static str,
    width: u32,
    height: u32,
    sha256: String,
    bytes: Vec<u8>,
}
pub(super) struct CachedOutput {
    job_id: String,
    index: usize,
    width: u32,
    height: u32,
    sha256: String,
    bytes: Vec<u8>,
}
impl CachedOutput {
    fn preview(&self) -> OutputPreview {
        OutputPreview {
            job_id: self.job_id.clone(),
            index: self.index,
            mime_type: "image/png",
            width: self.width,
            height: self.height,
            sha256: self.sha256.clone(),
            bytes: self.bytes.clone(),
        }
    }
}
impl Jobs {
    fn cached_output(
        &self,
        job_id: &str,
        index: usize,
    ) -> Result<std::sync::Arc<CachedOutput>, String> {
        self.selected_job(job_id, index)?;
        self.lock()?
            .output
            .as_ref()
            .filter(|c| c.job_id == job_id && c.index == index)
            .cloned()
            .ok_or("Load this native PNG before exporting".into())
    }

    fn export_to(
        &self,
        job_id: &str,
        index: usize,
        path: Option<&std::path::Path>,
    ) -> Result<Option<Value>, String> {
        let cached = self.cached_output(job_id, index)?;
        let Some(path) = path else {
            return Ok(None);
        };
        let session = self.lock()?;
        if !session
            .job
            .as_ref()
            .is_some_and(|j| j.id == job_id && j.state == "succeeded")
            || !session
                .output
                .as_ref()
                .is_some_and(|c| std::sync::Arc::ptr_eq(c, &cached))
        {
            return Err("Native job changed before export".into());
        }
        export_png(path, &cached.bytes)?;
        Ok(Some(
            json!({"path":path,"sha256":cached.sha256,"size":cached.bytes.len()}),
        ))
    }

    fn selected_job(&self, job_id: &str, index: usize) -> Result<Job, String> {
        let session = self.lock()?;
        let job = session
            .job
            .as_ref()
            .filter(|job| job.id == job_id)
            .ok_or("Unknown native job")?;
        if job.state != "succeeded" {
            return Err("Output requires a succeeded native job".into());
        }
        let image = job.outputs.get(index).ok_or("Unknown output index")?;
        outputs(&json!({"outputs":{"7":{"images":[image]}}}))?;
        Ok(job.clone())
    }

    async fn output(&self, job_id: String, index: usize) -> Result<OutputPreview, String> {
        let job = self.selected_job(&job_id, index)?;
        let _fetch = self
            .1
            .try_lock()
            .map_err(|_| "Another output fetch is in progress")?;
        if let Some(cached) = self.lock()?.output.as_ref() {
            if cached.job_id == job_id && cached.index == index {
                return Ok(cached.preview());
            }
        }
        let image = &job.outputs[index];
        let mut url = job
            .plan
            .base
            .join("view")
            .map_err(|_| "Invalid output endpoint")?;
        url.query_pairs_mut()
            .append_pair("filename", image["filename"].as_str().unwrap())
            .append_pair("subfolder", image["subfolder"].as_str().unwrap())
            .append_pair("type", "output");
        let mut response = client()?
            .get(url)
            .header(reqwest::header::ACCEPT, "image/png")
            .send()
            .await
            .map_err(|_| "Output request failed")?;
        if !response.status().is_success() {
            return Err("Output HTTP status refused; redirects forbidden".into());
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("image/png")
            })
        {
            return Err("Output must have image/png content type".into());
        }
        const LIMIT: usize = 16 * 1024 * 1024;
        if response.content_length().is_some_and(|n| n > LIMIT as u64) {
            return Err("PNG size limit exceeded".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "PNG response interrupted")?
        {
            if chunk.len() > LIMIT - bytes.len() {
                return Err("PNG size limit exceeded".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        validate_envelope(&bytes)?;
        let mut options = png::DecodeOptions::default();
        options.set_ignore_crc(false);
        options.set_ignore_adler32(false);
        options.set_skip_ancillary_crc_failures(false);
        options.set_ignore_text_chunk(true);
        options.set_ignore_iccp_chunk(true);
        let mut decoder = png::Decoder::new_with_options(std::io::Cursor::new(&bytes), options);
        decoder.set_limits(png::Limits {
            bytes: 32 * 1024 * 1024,
        });
        let mut reader = decoder.read_info().map_err(|_| "Invalid PNG header")?;
        let (width, height) = (reader.info().width, reader.info().height);
        if width == 0
            || height == 0
            || width > 2048
            || height > 2048
            || job.plan.intent["width"].as_u64() != Some(width as u64)
            || job.plan.intent["height"].as_u64() != Some(height as u64)
            || reader.info().animation_control.is_some()
            || reader.output_buffer_size() > 32 * 1024 * 1024
        {
            return Err("PNG dimensions or animation do not match diagnostic intent".into());
        }
        let mut frame = vec![0; reader.output_buffer_size()];
        reader
            .next_frame(&mut frame)
            .map_err(|_| "Invalid PNG frame")?;
        reader.finish().map_err(|_| "Invalid PNG end")?;
        let cached = std::sync::Arc::new(CachedOutput {
            job_id: job_id.clone(),
            index,
            width,
            height,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
        });
        let mut session = self.lock()?;
        if !session.job.as_ref().is_some_and(|current| {
            current.id == job_id
                && current.state == "succeeded"
                && current.outputs == job.outputs
                && current.plan.id == job.plan.id
        }) {
            return Err("Native job changed during output fetch".into());
        }
        let result = cached.preview();
        session.output = Some(cached);
        Ok(result)
    }
}
// The decoder stops at IEND; reject animation and anything hidden beyond it.
fn validate_envelope(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Invalid PNG signature".into());
    }
    let mut offset = 8;
    while bytes.len().saturating_sub(offset) >= 12 {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(length))
            .filter(|end| *end <= bytes.len())
            .ok_or("Truncated PNG chunk")?;
        let kind = &bytes[offset + 4..offset + 8];
        if [b"acTL", b"fcTL", b"fdAT"].contains(&kind.try_into().unwrap()) {
            return Err("Animated PNG is forbidden".into());
        }
        if kind == b"IEND" {
            return if length == 0 && end == bytes.len() {
                Ok(())
            } else {
                Err("Invalid PNG end or trailing bytes".into())
            };
        }
        offset = end;
    }
    Err("Missing PNG end".into())
}

#[cfg(any(target_os = "linux", windows))]
fn export_png(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use crate::downloads::fs::Anchor;
    use std::io::Write;
    if !path.is_absolute()
        || path.extension().and_then(|s| s.to_str()) != Some("png")
        || path.components().any(|p| {
            !matches!(
                p,
                std::path::Component::Prefix(_)
                    | std::path::Component::RootDir
                    | std::path::Component::Normal(_)
            )
        })
    {
        return Err("Select a new absolute .png file".into());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.chars().any(char::is_control))
        .ok_or("Invalid PNG filename")?;
    let parent = Anchor::open(path.parent().ok_or("Missing export parent")?)?;
    parent.validate_directory(false)?;
    parent.absent(name)?;
    let temp = format!(".deas-{}.partial", uuid::Uuid::new_v4());
    let mut file = parent.partial(&temp)?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|_| "Cannot write exported PNG")?;
        file.sync_all().map_err(|_| "Cannot sync exported PNG")?;
        parent.validate_directory(false)?;
        if !parent.owns_partial(&temp, &file) {
            return Err("Export temporary file changed".into());
        }
        parent.publish(&temp, name)
    })();
    if parent.owns_partial(&temp, &file) {
        parent.remove_partial(&temp);
    }
    result
}
#[cfg(not(any(target_os = "linux", windows)))]
fn export_png(_: &std::path::Path, _: &[u8]) -> Result<(), String> {
    Err("Safe PNG export currently requires Linux or Windows".into())
}

#[tauri::command]
pub async fn native_job_output(
    state: tauri::State<'_, Jobs>,
    job_id: String,
    index: usize,
) -> Result<OutputPreview, String> {
    state.output(job_id, index).await
}
#[tauri::command]
pub async fn native_job_export(
    state: tauri::State<'_, Jobs>,
    job_id: String,
    index: usize,
    title: String,
) -> Result<Option<Value>, String> {
    if title.chars().count() > 240 || title.chars().any(char::is_control) {
        return Err("Invalid PNG save dialog title".into());
    }
    state.cached_output(&job_id, index)?;
    let selected = rfd::AsyncFileDialog::new()
        .set_title(title)
        .add_filter("PNG", &["png"])
        .set_file_name("DEAS-output.png")
        .set_can_create_directories(false)
        .save_file()
        .await;
    state.export_to(&job_id, index, selected.as_ref().map(|file| file.path()))
}
#[cfg(test)]
#[path = "jobs_outputs_tests.rs"]
mod tests;
