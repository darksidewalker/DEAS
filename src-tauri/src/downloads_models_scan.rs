//! App-owned background metadata scans (4 files at a time); dropping the invoking webview does not cancel work.
use super::*;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanScope {
    All,
    Models,
    Loras,
}
impl ScanScope {
    fn includes(self, model: &LocalModel) -> bool {
        match self {
            Self::All => true,
            Self::Models => model.category != "loras",
            Self::Loras => model.category == "loras",
        }
    }
}

#[derive(Default)]
struct FetchSelection {
    paths: Option<Vec<String>>,
    missing_only: bool,
    save_preview: bool,
    index_directory: Option<PathBuf>,
}

#[derive(Debug, PartialEq)]
enum Work {
    Metadata,
    Cover {
        url: String,
        source: SourceFingerprint,
    },
}

fn selected_paths(
    root: &Path,
    paths: Vec<String>,
    missing_only: bool,
    save_preview: bool,
) -> Result<Vec<(String, Work)>, String> {
    if paths.len() > MAX_LISTING {
        return Err("Too many files in Fetch selection".into());
    }
    let (root, _) = resolve_directory(root)?;
    let mut seen = std::collections::HashSet::new();
    let mut selected = vec![];
    let mut preview_folders = index::PreviewFolders::new();
    for path in paths {
        if path.len() > 32768
            || path.chars().any(char::is_control)
            || !Path::new(&path).is_absolute()
            || !is_model(Path::new(&path))
        {
            return Err("Invalid Fetch model path".into());
        }
        let source = Source::open(Path::new(&path))?;
        let resolved = source.dir.path.join(&source.name);
        if !resolved.starts_with(&root) {
            return Err("Fetch file is outside the models folder".into());
        }
        model_category(Path::new(&path))?;
        if !seen.insert(resolved) {
            continue;
        }
        if missing_only {
            // Only a found record counts as complete: a cached provider miss is always
            // looked up again, since CivitAI indexes new uploads and fallbacks can now match.
            if let Some(civitai) = read_info_from_source(&source).and_then(|info| info.civitai) {
                if save_preview {
                    let cached_url = civitai.preview.filter(|url| preview::cdn_url(url).is_ok());
                    // A legacy response without a cover may have dropped video URLs.
                    let check_legacy = cached_url.is_none() && civitai.preview_kind.is_none();
                    if (cached_url.is_some() || check_legacy)
                        && !index::has_indexed_local_preview(Path::new(&path), &mut preview_folders)
                    {
                        let work = cached_url.map_or(Work::Metadata, |url| Work::Cover {
                            url,
                            source: source.stamp.clone(),
                        });
                        selected.push((path, work));
                    }
                }
                continue;
            }
        }
        selected.push((path, Work::Metadata));
    }
    Ok(selected)
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelScanStatus {
    pub id: String,
    pub root: String,
    pub state: String,
    pub file: Option<String>,
    pub completed: usize,
    pub total: usize,
    pub remaining: usize,
    pub failed: usize,
}

#[derive(Clone)]
pub struct ModelScanEngine(Arc<Mutex<ModelScanStatus>>);
impl Default for ModelScanEngine {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ModelScanStatus {
            state: "idle".into(),
            ..Default::default()
        })))
    }
}
impl ModelScanEngine {
    pub fn status(&self) -> ModelScanStatus {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn update(&self, change: impl FnOnce(&mut ModelScanStatus)) -> ModelScanStatus {
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut status);
        status.remaining = status.total.saturating_sub(status.completed);
        status.clone()
    }

    fn reserve(&self, root: String) -> Result<ModelScanStatus, String> {
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if status.state == "running" {
            return Err("A Library file scan is already running".into());
        }
        *status = ModelScanStatus {
            id: uuid::Uuid::new_v4().to_string(),
            root,
            state: "running".into(),
            ..Default::default()
        };
        Ok(status.clone())
    }

    #[cfg(test)]
    fn start(
        &self,
        root: String,
        scope: ScanScope,
        provider: Provider,
        header: Option<HeaderValue>,
    ) -> Result<ModelScanStatus, String> {
        self.start_selected(root, scope, provider, header, FetchSelection::default())
    }

    fn start_selected(
        &self,
        root: String,
        scope: ScanScope,
        provider: Provider,
        header: Option<HeaderValue>,
        selection: FetchSelection,
    ) -> Result<ModelScanStatus, String> {
        if !Path::new(&root).is_absolute()
            || root.len() > 32768
            || root.chars().any(char::is_control)
        {
            return Err("Models folder must be an absolute path without control characters".into());
        }
        let initial = self.reserve(root.clone())?;
        report(&initial, "INFO", "started");
        let worker = self.clone();
        let task =
            tokio::spawn(async move { worker.run(root, scope, provider, header, selection).await });
        let owner = self.clone();
        tokio::spawn(async move {
            let outcome = task.await;
            let failed = !matches!(outcome, Ok(Ok(())));
            let status = owner.update(|s| {
                s.state = if failed || s.failed > 0 {
                    "failed"
                } else {
                    "succeeded"
                }
                .into();
            });
            report(
                &status,
                if status.state == "failed" {
                    "ERROR"
                } else {
                    "INFO"
                },
                if failed {
                    "scan failed; check models folder access"
                } else {
                    "finished"
                },
            );
        });
        Ok(initial)
    }

    async fn run(
        &self,
        root: String,
        scope: ScanScope,
        provider: Provider,
        header: Option<HeaderValue>,
        selection: FetchSelection,
    ) -> Result<(), String> {
        let directory = selection.index_directory;
        let save_preview = selection.save_preview;
        let paths = tokio::task::spawn_blocking(move || {
            if let Some(paths) = selection.paths {
                selected_paths(
                    Path::new(&root),
                    paths,
                    selection.missing_only,
                    save_preview,
                )
            } else {
                scan(Path::new(&root)).map(|models| {
                    models
                        .into_iter()
                        .filter(|m| scope.includes(m))
                        .map(|m| (m.path, Work::Metadata))
                        .collect()
                })
            }
        })
        .await
        .map_err(|_| "Model listing task failed")??;
        let models = paths;
        let mut updated = vec![];
        let status = self.update(|s| s.total = models.len());
        report(&status, "INFO", "listed");
        // shortcut: fixed 4 concurrent files (SHA-NI + one CivitAI lookup each); raise only
        // together with the provider's rate limit.
        const POOL: usize = 4;
        let mut tasks = tokio::task::JoinSet::new();
        for (model, work) in models {
            while tasks.len() >= POOL {
                if let Some(result) = tasks.join_next().await {
                    if let Some(path) = self.finish(result) {
                        updated.push(path);
                    }
                }
            }
            let provider = provider.clone();
            let header = header.clone();
            let path = model.clone();
            let status = self.update(|s| s.file = Some(model));
            report(&status, "INFO", "processing");
            // Each fetch carries its own file handle and provider request; nothing is shared.
            tasks.spawn(async move {
                let failed = match work {
                    Work::Metadata => fetch(&provider, path.clone().into(), header, save_preview)
                        .await
                        .is_err(),
                    Work::Cover { url, source } => {
                        preview::fill_missing(path.clone().into(), source, url)
                            .await
                            .is_err()
                    }
                };
                (path, failed)
            });
        }
        while let Some(result) = tasks.join_next().await {
            if let Some(path) = self.finish(result) {
                updated.push(path);
            }
        }
        if let Some(directory) = directory.filter(|_| !updated.is_empty()) {
            let result =
                tokio::task::spawn_blocking(move || index::update_many(&directory, &updated)).await;
            if !matches!(result, Ok(Ok(()))) {
                report(
                    &self.status(),
                    "WARN",
                    "index update failed; explicit Refresh can recover metadata",
                );
            }
        }
        Ok(())
    }

    /// One join: names the finished file itself (the shared `file` field follows spawn order)
    /// and a task panic counts as that file's failure; counters stay the existing ones.
    fn finish(&self, result: Result<(String, bool), tokio::task::JoinError>) -> Option<PathBuf> {
        let (path, failed) = match result {
            Ok(pair) => pair,
            Err(_) => (String::new(), true),
        };
        let status = self.update(|s| {
            if !path.is_empty() {
                s.file = Some(path.clone());
            }
            s.completed += 1;
            s.failed += usize::from(failed);
        });
        // Do not log provider response bodies: they can contain credentials or arbitrary data.
        report(
            &status,
            if failed { "ERROR" } else { "INFO" },
            if failed {
                "metadata or preview fetch failed; check file access and CivitAI availability"
            } else {
                "processed"
            },
        );
        (!failed && !path.is_empty()).then(|| PathBuf::from(path))
    }
}

fn report(status: &ModelScanStatus, level: &str, operation: &str) {
    let text = format!(
        "{level}: Library operation=scan job={} {operation} file={:?} completed={} total={} remaining={} failed={}",
        status.id,
        status.file.as_deref().unwrap_or(""),
        status.completed,
        status.total,
        status.remaining,
        status.failed
    );
    eprintln!("{text}");
    crate::logs::push(crate::logs::Source::Deas, &text);
}

#[tauri::command]
pub fn native_model_scan_status(scans: tauri::State<'_, ModelScanEngine>) -> ModelScanStatus {
    scans.status()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Preserve flat IPC fields; AppHandle and states are injected by Tauri.
pub async fn native_model_scan_start(
    app: tauri::AppHandle,
    scans: tauri::State<'_, ModelScanEngine>,
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    root: String,
    scope: ScanScope,
    authenticated: bool,
    paths: Option<Vec<String>>,
    missing_only: Option<bool>,
    save_preview: Option<bool>,
) -> Result<ModelScanStatus, String> {
    let result = (|| {
        if engine.status()?.state == "running" {
            return Err("Wait for downloads to finish before scanning files".into());
        }
        let catalog = engine.catalog()?;
        let provider = catalog
            .providers
            .iter()
            .find(|p| p.kind == "civitai")
            .ok_or("No CivitAI provider in catalog")?
            .clone();
        let header = credential(&auth, &provider, authenticated)?;
        scans.start_selected(
            root,
            scope,
            provider,
            header,
            FetchSelection {
                paths,
                missing_only: missing_only.unwrap_or(false),
                save_preview: save_preview.unwrap_or(false),
                index_directory: Some(index::directory(&app)?),
            },
        )
    })();
    if result.is_err() {
        report(
            &scans.status(),
            "ERROR",
            "start rejected; check running jobs, models path and provider authorization",
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_selection_is_bounded_deduplicated_root_bound_skips_found_and_retries_misses() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        let folder = root.join("loras");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("a.pt");
        std::fs::write(&path, b"fixture").unwrap();
        let file = path.to_string_lossy().into_owned();
        assert_eq!(
            selected_paths(&root, vec![file.clone(), file.clone()], false, false).unwrap(),
            vec![(file.clone(), Work::Metadata)]
        );
        assert_eq!(
            selected_paths(&root, vec![file.clone()], true, false)
                .unwrap()
                .len(),
            1
        );
        let source = Source::open(&path).unwrap();
        let info = ModelInfo { sha256:"a".repeat(64), size:7, fetched_at:1, source:Some(source.stamp.clone()), civitai:Some(serde_json::from_value(serde_json::json!({"modelId":1,"versionId":2,"name":"Fixture","version":"v1","modelType":"LORA","category":"loras","nsfw":false,"trainedWords":[],"preview":"https://image.civitai.com/fixture.mp4","previewKind":"video"})).unwrap()) };
        publish_info(&source, &None, &info, || {}).unwrap();
        assert!(selected_paths(&root, vec![file.clone()], true, false)
            .unwrap()
            .is_empty());
        assert_eq!(
            selected_paths(&root, vec![file.clone()], false, false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            selected_paths(&root, vec![file.clone()], true, true).unwrap(),
            vec![(
                file.clone(),
                Work::Cover {
                    url: "https://image.civitai.com/fixture.mp4".into(),
                    source: source.stamp.clone(),
                }
            )]
        );
        std::fs::write(folder.join("a.preview.png"), b"local preview").unwrap();
        assert!(selected_paths(&root, vec![file.clone()], true, true)
            .unwrap()
            .is_empty());
        let expected = source
            .dir
            .cache(&format!("{}{SIDECAR}", source.name))
            .unwrap()
            .map(|(stamp, _)| stamp);
        publish_info(
            &source,
            &expected,
            &ModelInfo {
                civitai: None,
                ..info
            },
            || {},
        )
        .unwrap();
        // A cached miss is never complete: "only missing" retries it.
        assert_eq!(
            selected_paths(&root, vec![file.clone()], true, true).unwrap(),
            vec![(file.clone(), Work::Metadata)]
        );
        assert_eq!(
            selected_paths(&root, vec![file.clone()], true, false).unwrap(),
            vec![(file.clone(), Work::Metadata)]
        );
        assert_eq!(
            selected_paths(&root, vec![file.clone()], false, true).unwrap(),
            vec![(file.clone(), Work::Metadata)]
        );
        std::fs::write(&path, b"changed fixture").unwrap();
        assert_eq!(
            selected_paths(&root, vec![file.clone()], true, false)
                .unwrap()
                .len(),
            1
        );
        let outside = dir.path().join("outside.pt");
        std::fs::write(&outside, b"fixture").unwrap();
        assert!(selected_paths(
            &root,
            vec![outside.to_string_lossy().into_owned()],
            false,
            false
        )
        .is_err());
        assert!(selected_paths(&root, vec!["relative.pt".into()], false, false).is_err());
        assert!(selected_paths(&root, vec![file; MAX_LISTING + 1], false, false).is_err());
    }

    #[test]
    fn background_scan_scopes_keep_non_loras_in_models() {
        let root = tempfile::tempdir().unwrap();
        for folder in ["loras", "checkpoints", "diffusion_models", "vae"] {
            std::fs::create_dir(root.path().join(folder)).unwrap();
            std::fs::write(root.path().join(folder).join("a.pt"), b"model").unwrap();
        }
        let models = scan(root.path()).unwrap();
        assert_eq!(
            models.iter().filter(|m| ScanScope::All.includes(m)).count(),
            4
        );
        assert_eq!(
            models
                .iter()
                .filter(|m| ScanScope::Models.includes(m))
                .count(),
            3
        );
        assert_eq!(
            models
                .iter()
                .filter(|m| ScanScope::Loras.includes(m))
                .count(),
            1
        );
        assert!(serde_json::from_str::<ScanScope>("\"other\"").is_err());
    }

    #[tokio::test]
    async fn background_scan_is_detached_pooled_and_logs_failures_and_counts() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("loras");
        std::fs::create_dir(&dir).unwrap();
        for (name, content) in [("a.pt", "model-a"), ("b.pt", "model-b")] {
            std::fs::write(dir.join(name), content).unwrap();
        }
        // Pool order is arbitrary, so the fixture answers by content hash: a fails (500), b finds nothing (404).
        let hash_a = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(b"model-a"))
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (release, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let deadline = Instant::now() + Duration::from_secs(10);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(s) => break s,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = vec![];
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                wait.recv_timeout(Duration::from_secs(10)).unwrap();
                let code = if std::str::from_utf8(&request)
                    .unwrap_or_default()
                    .contains(&hash_a)
                {
                    500
                } else {
                    404
                };
                write!(
                    stream,
                    "HTTP/1.1 {code} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        let provider = Provider {
            id: "fixture".into(),
            kind: "civitai".into(),
            label: "Fixture".into(),
            origin,
            scopes: vec!["model".into()],
            anonymous_notice: String::new(),
        };
        let engine = ModelScanEngine::default();
        assert_eq!(engine.status().state, "idle");
        let monitor = engine.clone();
        let initial = engine
            .start(
                root.path().to_string_lossy().into_owned(),
                ScanScope::All,
                provider.clone(),
                Some(HeaderValue::from_static("Bearer scan-test-secret")),
            )
            .unwrap();
        drop(engine);
        tokio::time::timeout(Duration::from_secs(10), async {
            while monitor.status().file.is_none() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let active = monitor.status();
        assert_eq!(
            (active.completed, active.total, active.remaining),
            (0, 2, 2)
        );
        let file = active.file.unwrap();
        assert!(file.ends_with("a.pt") || file.ends_with("b.pt"));
        assert!(monitor
            .start(
                root.path().to_string_lossy().into_owned(),
                ScanScope::All,
                provider,
                None
            )
            .is_err());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while monitor.status().completed == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            (monitor.status().completed, monitor.status().remaining),
            (1, 1)
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while monitor.status().state == "running" {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap();
        let status = monitor.status();
        assert_eq!(status.state, "failed");
        assert_eq!(
            (
                status.completed,
                status.total,
                status.remaining,
                status.failed
            ),
            (2, 2, 0, 1)
        );
        assert!(dir.join("b.pt.deas.json").is_file());
        assert_eq!(std::fs::read(dir.join("a.pt")).unwrap(), b"model-a");
        let logs = crate::logs::native_logs(0);
        let entries: Vec<_> = logs
            .iter()
            .filter(|e| e.text.contains(&initial.id))
            .collect();
        assert!(
            entries
                .iter()
                .all(|e| e.source == crate::logs::Source::Deas
                    && !e.text.contains("scan-test-secret"))
        );
        // Pool completion order is arbitrary: pin the failing file's name, not its intermediate counts.
        assert!(entries
            .iter()
            .any(|e| e.text.contains("ERROR: Library") && e.text.contains("a.pt")));
        assert!(entries.iter().any(|e| e.text.contains("finished")
            && e.text.contains("completed=2 total=2 remaining=0 failed=1")));
    }

    #[tokio::test]
    async fn background_scan_listing_failure_releases_the_running_lock() {
        let engine = ModelScanEngine::default();
        let provider = Provider {
            id: "fixture".into(),
            kind: "civitai".into(),
            label: "Fixture".into(),
            origin: "http://127.0.0.1:1".into(),
            scopes: vec!["model".into()],
            anonymous_notice: String::new(),
        };
        assert!(engine
            .start("relative".into(), ScanScope::All, provider.clone(), None)
            .is_err());
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing").to_string_lossy().into_owned();
        engine
            .start(missing.clone(), ScanScope::All, provider.clone(), None)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while engine.status().state == "running" {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(engine.status().state, "failed");
        assert!(engine
            .start(
                root.path().to_string_lossy().into_owned(),
                ScanScope::All,
                provider,
                None
            )
            .is_ok());
        tokio::time::timeout(Duration::from_secs(5), async {
            while engine.status().state == "running" {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(engine.status().state, "succeeded");
        assert_eq!(
            (
                engine.status().completed,
                engine.status().total,
                engine.status().remaining
            ),
            (0, 0, 0)
        );
    }
}
