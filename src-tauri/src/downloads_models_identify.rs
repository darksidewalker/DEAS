//! Fallback CivitAI identification for files whose full-file SHA-256 is unknown to CivitAI:
//! the AutoV3 tensor hash (immune to rewritten safetensors metadata headers), hash-bound
//! Forge/A1111 extension sidecars, and explicit user links. Every automatic match is bound to
//! the local file by a hash listed in the version's `files[].hashes`; a pasted link is recorded
//! as user-supplied. Sidecars are only read, never written or moved.
use super::*;
use std::io::Seek;

/// Advisory third-party JSON (Civitai Helper `.civitai.info`, CivitAI Browser `.api_info.json`,
/// A1111/Forge `.json`). Full model records with many versions stay well below this bound.
const MAX_FOREIGN_SIDECAR: u64 = 4 * 1024 * 1024;
// Bound the version list taken from a model record or sidecar.
const MAX_VERSIONS: usize = 200;
// Bound the safetensors header so a corrupt length cannot request a huge seek target.
const MAX_SAFETENSORS_HEADER: u64 = 100 * 1024 * 1024;

/// How a cached CivitAI record was tied to the local file. Absent means the full-file SHA-256.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CivitaiMatch {
    Sha256,
    Autov3,
    Sidecar,
    Manual,
}

/// Local third-party metadata found beside a model before any provider request.
#[derive(Debug, Default)]
pub(super) struct ForeignSidecars {
    /// Version-shaped records from `.civitai.info` / `.api_info.json`, unbound until hashes match.
    pub versions: Vec<Value>,
    /// A1111/Forge user metadata (`<stem>.json`), when it does not name a different file hash.
    pub forge: Option<Value>,
}

pub(super) fn valid_autov3(value: &str) -> bool {
    value.len() == 12
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

fn is_safetensors(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".safetensors") || lower.ends_with(".sft")
}

/// CivitAI AutoV3: SHA-256 of the safetensors tensor bytes after the JSON header, first 12
/// hex digits upper-case. `None` for other formats or an implausible header.
pub(super) fn autov3(source: &mut Source) -> Result<Option<String>, String> {
    if !is_safetensors(&source.name) || source.stamp.size < 8 {
        return Ok(None);
    }
    source.verify()?;
    source.file.rewind().map_err(|e| e.to_string())?;
    let mut length = [0u8; 8];
    source
        .file
        .read_exact(&mut length)
        .map_err(|e| e.to_string())?;
    let header = u64::from_le_bytes(length);
    let start = match header.checked_add(8) {
        Some(start)
            if header > 0 && header <= MAX_SAFETENSORS_HEADER && start <= source.stamp.size =>
        {
            start
        }
        _ => return Ok(None),
    };
    source
        .file
        .seek(std::io::SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    #[cfg(test)]
    HASH_READS.with(|n| n.set(n.get() + 1));
    let expected = source.stamp.size - start;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; MODEL_HASH_CHUNK];
    let mut copied = 0u64;
    // Read one byte past the expected end so a file that grew mid-hash is rejected.
    let limit = expected.saturating_add(1);
    while copied < limit {
        let want = MODEL_HASH_CHUNK.min(usize::try_from(limit - copied).unwrap_or(usize::MAX));
        let n = source
            .file
            .read(&mut buffer[..want])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        copied += n as u64;
    }
    source.verify()?;
    if copied != expected {
        return Err("Model size changed while hashing".into());
    }
    let digest = format!("{:X}", hasher.finalize());
    Ok(Some(digest[..12].to_owned()))
}

fn read_foreign(source: &Source, name: &str) -> Option<Value> {
    let file = source.dir.regular(name).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 || size > MAX_FOREIGN_SIDECAR {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FOREIGN_SIDECAR + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_FOREIGN_SIDECAR {
        return None;
    }
    // Windows editors often prepend a UTF-8 byte-order mark.
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice::<Value>(body)
        .ok()
        .filter(Value::is_object)
}

/// Version-shaped candidates (`model`, `modelId`, `files`) from a by-hash/version record or a
/// full model record (`modelVersions`).
pub(super) fn candidates(value: &Value) -> Vec<Value> {
    if let Some(versions) = value.get("modelVersions").and_then(Value::as_array) {
        let Some(id) = value.get("id").filter(|id| id.is_u64()) else {
            return vec![];
        };
        let summary = serde_json::json!({
            "name": value.get("name"),
            "type": value.get("type"),
            "nsfw": value.get("nsfw"),
            "poi": value.get("poi"),
        });
        return versions
            .iter()
            .take(MAX_VERSIONS)
            .filter_map(|version| {
                let mut version = version.clone();
                let object = version.as_object_mut()?;
                object.entry("modelId").or_insert_with(|| id.clone());
                object.entry("model").or_insert_with(|| summary.clone());
                if let Some(creator) = value.get("creator") {
                    object.entry("creator").or_insert_with(|| creator.clone());
                }
                Some(version)
            })
            .collect();
    }
    if value.get("model").is_some_and(Value::is_object) && value.get("modelId").is_some() {
        return vec![value.clone()];
    }
    vec![]
}

/// True when a file of this version carries the local SHA-256 or AutoV3 hash.
pub(super) fn version_matches(version: &Value, sha256: &str, autov3: Option<&str>) -> bool {
    version
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(64)
        .filter_map(|file| file.get("hashes"))
        .any(|hashes| {
            let equal = |key: &str, local: &str| {
                hashes
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|remote| remote.eq_ignore_ascii_case(local))
            };
            equal("SHA256", sha256) || autov3.is_some_and(|a| equal("AutoV3", a))
        })
}

pub(super) fn first_match(versions: &[Value], sha256: &str, autov3: Option<&str>) -> Option<Value> {
    versions
        .iter()
        .find(|v| version_matches(v, sha256, autov3))
        .cloned()
}

/// Reads the sidecars other WebUI tools leave beside `<stem>.<ext>`. A Forge `.json` that names
/// a different SHA-256 describes an older file and is ignored entirely.
pub(super) fn foreign_sidecars(source: &Source, sha256: &str) -> ForeignSidecars {
    let stem = Path::new(&source.name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&source.name)
        .to_owned();
    let mut found = ForeignSidecars::default();
    for suffix in [".civitai.info", ".api_info.json"] {
        if let Some(value) = read_foreign(source, &format!("{stem}{suffix}")) {
            found.versions.extend(candidates(&value));
        }
    }
    found.forge = read_foreign(source, &format!("{stem}.json")).filter(|forge| {
        forge
            .get("sha256")
            .and_then(Value::as_str)
            .is_none_or(|hash| hash.is_empty() || hash.eq_ignore_ascii_case(sha256))
    });
    found
}

fn positive_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|id| *id > 0)
}

/// `(modelId, modelVersionId)` recorded by CivitAI Browser in the Forge `.json`.
pub(super) fn forge_ids(forge: &Value) -> (Option<u64>, Option<u64>) {
    (
        positive_id(forge.get("modelId")),
        positive_id(forge.get("modelVersionId")),
    )
}

/// Forge/A1111 "activation text" as DEAS trigger words (comma-separated phrases).
pub(super) fn forge_trigger_words(forge: &Value) -> Option<Vec<String>> {
    let text = forge.get("activation text")?.as_str()?;
    let mut words: Vec<String> = vec![];
    for part in text.split(',') {
        let clean: String = part.chars().filter(|c| !c.is_control()).collect();
        let clean = clean.trim();
        if clean.is_empty() {
            continue;
        }
        let mut word = String::new();
        for c in clean.chars() {
            if word.len() + c.len_utf8() > 200 {
                break;
            }
            word.push(c);
        }
        let word = word.trim().to_owned();
        if !word.is_empty() && !words.contains(&word) {
            words.push(word);
        }
        if words.len() == 50 {
            break;
        }
    }
    (!words.is_empty()).then_some(words)
}

/// Model/version IDs from a pasted CivitAI page, download or API link. Only the IDs are used;
/// requests go to the configured provider origin, never to the pasted host.
pub(super) fn parse_link(link: &str) -> Result<(Option<u64>, Option<u64>), String> {
    const HELP: &str = "Paste a CivitAI model or version link";
    let link = link.trim();
    if link.is_empty() || link.len() > 2048 || link.chars().any(char::is_control) {
        return Err(HELP.into());
    }
    let url = Url::parse(link).map_err(|_| HELP)?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !matches!(
            host.strip_prefix("www.").unwrap_or(host),
            "civitai.com" | "civitai.red"
        )
    {
        return Err(HELP.into());
    }
    let id = |s: &str| s.parse::<u64>().ok().filter(|id| *id > 0);
    let parts: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    let query_version = url
        .query_pairs()
        .find(|(k, _)| k == "modelVersionId")
        .and_then(|(_, v)| id(&v));
    let ids = match parts.as_slice() {
        ["models", model, ..] => (id(model), query_version),
        ["model-versions", version, ..]
        | ["api", "download", "models", version, ..]
        | ["api", "v1", "model-versions", version, ..] => (None, id(version)),
        ["api", "v1", "models", model, ..] => (id(model), query_version),
        _ => (None, None),
    };
    if ids == (None, None) {
        return Err(HELP.into());
    }
    if parts.first() == Some(&"models") && ids.0.is_none() {
        return Err(HELP.into());
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn safetensors(dir: &Path, name: &str, metadata: &str) -> PathBuf {
        let header = format!(
            r#"{{"__metadata__":{{"note":"{metadata}"}},"w":{{"dtype":"F32","shape":[2],"data_offsets":[0,8]}}}}"#
        );
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn autov3_hashes_tensor_bytes_only_and_ignores_other_formats() {
        let dir = tempfile::tempdir().unwrap();
        let a = safetensors(dir.path(), "a.safetensors", "first");
        let b = safetensors(dir.path(), "b.safetensors", "rewritten header");
        let expected = format!("{:X}", Sha256::digest([1u8, 2, 3, 4, 5, 6, 7, 8]))[..12].to_owned();
        let first = autov3(&mut Source::open(&a).unwrap()).unwrap().unwrap();
        assert_eq!(first, expected);
        assert!(valid_autov3(&first));
        assert_eq!(
            autov3(&mut Source::open(&b).unwrap()).unwrap().unwrap(),
            first,
            "metadata-only rewrites keep AutoV3"
        );
        assert_ne!(sha256_file(&a).unwrap(), sha256_file(&b).unwrap());
        let pt = dir.path().join("c.pt");
        std::fs::write(&pt, b"pickle").unwrap();
        assert_eq!(autov3(&mut Source::open(&pt).unwrap()).unwrap(), None);
        let bad = dir.path().join("d.safetensors");
        std::fs::write(&bad, u64::MAX.to_le_bytes()).unwrap();
        assert_eq!(autov3(&mut Source::open(&bad).unwrap()).unwrap(), None);
    }

    #[test]
    fn model_records_become_bound_version_candidates() {
        let model = serde_json::json!({
            "id": 7, "name": "Model", "type": "LORA", "nsfw": false,
            "creator": {"username": "maker"},
            "modelVersions": [
                {"id": 1, "name": "v1", "files": [{"hashes": {"SHA256": "AA", "AutoV3": "111111111111"}}]},
                {"id": 2, "name": "v2", "files": [{"hashes": {"SHA256": "BB", "AutoV3": "222222222222"}}]}
            ]
        });
        let versions = candidates(&model);
        assert_eq!(versions.len(), 2);
        let hit = first_match(&versions, "bb", None).unwrap();
        assert_eq!(hit["id"], 2);
        assert_eq!(hit["modelId"], 7);
        assert_eq!(hit["model"]["name"], "Model");
        assert_eq!(hit["creator"]["username"], "maker");
        assert!(civitai_info(&hit).is_ok());
        assert_eq!(
            first_match(&versions, "cc", Some("111111111111")).unwrap()["id"],
            1
        );
        assert!(first_match(&versions, "cc", Some("333333333333")).is_none());
        assert!(first_match(&versions, "cc", None).is_none());
        let version = serde_json::json!({"id": 3, "modelId": 7, "name": "v3", "model": {"name": "M", "type": "LORA"}});
        assert_eq!(candidates(&version).len(), 1);
        assert!(candidates(&serde_json::json!({"activation text": "x"})).is_empty());
    }

    #[test]
    fn foreign_sidecars_are_read_and_stale_forge_json_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lora.safetensors");
        std::fs::write(&path, b"weights").unwrap();
        std::fs::write(
            dir.path().join("lora.civitai.info"),
            br#"{"id":1,"modelId":2,"name":"v1","model":{"name":"M","type":"LORA"},"files":[]}"#,
        )
        .unwrap();
        let mut api = b"\xEF\xBB\xBF".to_vec();
        api.extend_from_slice(
            br#"{"id":2,"name":"M","type":"LORA","modelVersions":[{"id":5,"name":"v5"}]}"#,
        );
        std::fs::write(dir.path().join("lora.api_info.json"), api).unwrap();
        std::fs::write(
            dir.path().join("lora.json"),
            br#"{"activation text":"one, two ,, one","modelId":"2","sha256":"ABC"}"#,
        )
        .unwrap();
        let source = Source::open(&path).unwrap();
        let found = foreign_sidecars(&source, "abc");
        assert_eq!(found.versions.len(), 2);
        let forge = found.forge.unwrap();
        assert_eq!(forge_ids(&forge), (Some(2), None));
        assert_eq!(
            forge_trigger_words(&forge).unwrap(),
            vec!["one".to_owned(), "two".to_owned()]
        );
        assert!(foreign_sidecars(&source, "def").forge.is_none());
        let long = format!(r#"{{"activation text":"{}"}}"#, "é".repeat(150));
        std::fs::write(dir.path().join("lora.json"), long).unwrap();
        let words = forge_trigger_words(&foreign_sidecars(&source, "abc").forge.unwrap()).unwrap();
        assert!(words[0].len() <= 200 && bounded_text(&words[0], 200).is_ok());
    }

    #[test]
    fn links_yield_ids_for_known_civitai_hosts_only() {
        assert_eq!(
            parse_link("https://civitai.com/models/123/some-name?modelVersionId=456").unwrap(),
            (Some(123), Some(456))
        );
        assert_eq!(
            parse_link(" https://www.civitai.red/models/123 ").unwrap(),
            (Some(123), None)
        );
        assert_eq!(
            parse_link("https://civitai.com/api/download/models/456").unwrap(),
            (None, Some(456))
        );
        assert_eq!(
            parse_link("https://civitai.com/model-versions/456").unwrap(),
            (None, Some(456))
        );
        for bad in [
            "",
            "123",
            "http://civitai.com/models/1",
            "https://civitai.com.evil.test/models/1",
            "https://example.com/models/1",
            "https://civitai.com/user/someone",
            "https://civitai.com/models/0",
            "https://civitai.com/models/abc?modelVersionId=4",
        ] {
            assert!(parse_link(bad).is_err(), "{bad}");
        }
    }
}
