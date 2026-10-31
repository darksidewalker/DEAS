# Library, downloads and provider authorization

[Documentation index](README.md) · [Plan](PLAN.md)

## Library, downloads and provider authorization

Library is a main tab and Provider authorization is a pane in **Backend**'s left menu; optional downloads are also reachable from the studio plugin area, independently of baseline installation. A strict native TOML catalog feeds the UI; add resources/providers in `src-tauri/downloads/default.toml` or explicitly import an additive catalog for the current session. Browse HF users/model/dataset repositories, CivitAI creators/models, GitHub accounts/repository files, configured HTTPS direct/index sources or an explicitly configured loopback Ollama tags endpoint. Repository listings lead to explicit repository browsing; Ollama tags never imply a pull or downloadable file.

Provider tokens are optional and origin-bound. The UI defaults to the OS credential store with an explicit session-only opt-out; persistence/restoration never falls back to plaintext. Ticked files from any card collect in a **Selected for download** overview; **Download all** builds one immutable native plan per provider and folder and runs them in sequence. Files go to their managed ComfyUI folder, or to a chosen parent with an optional new subfolder. Staged files are inert data, not installed models or executed workflows. Linux scratch HTTP transfers and UI/IPC fixtures are tested; Windows write paths exist in code but are not runtime-verified. Live authenticated providers, real OS-store operation and large-download resume remain unverified/unsupported. See [catalog examples, contracts and limits](DOWNLOAD-PLUGINS.md).

The Library sorts catalog cards and loaded file rows by version publication date (newest first), or by name (A–Z). Undated entries come last. Bundled dates are a catalog snapshot; live CivitAI user/search requests ask for newest results. Name sorting covers loaded results, not unseen pages. All entries are always listed, and a base-model filter narrows model lists. The 18+ badge reflects the provider's model classification, not the preview image rating. Opening a CivitAI model lists individual files across its versions (up to 50); quantizations are selected explicitly, never downloaded together automatically. Conflicting destination filenames block the plan instead of overwriting files.

## Catalog and Installed views

Catalog offers source selection, provider browsing/search, category/base-model filters, sorting, file/version/quantization selection and Selected for download. Installed scans the configured models folder; opening a file shows path/size/hash, a **File check** row when a safetensors header covers payload the file does not hold (**Incomplete safetensors: … Download it again**), and an explicit CivitAI metadata fetch/cache action. Listing a file is not compatibility proof; a truncated safetensors is excluded from the Studio's automatic component selection, so a broken encoder is never picked silently.

### Scan Files (Installed)

Choose **All**, **Models** (all non-LoRA folders, including VAEs/encoders) or **LoRAs**, then **Scan Files**. This explicitly starts one native background task for the configured models root. A full scan can take a long time: model files are hashed and CivitAI is queried sequentially using the existing per-file metadata path. A configured CivitAI token is used; otherwise lookup is anonymous. Valid cached hashes are reused, and metadata is safely written beside each model as `<file>.deas.json`; model contents are never modified.

Changing Library categories, switching to Catalog or another main tab, and unmounting/reopening Library **do not stop the scan**. Installed reconnects to the native task and shows its current filename, processed/total count, remaining count and failures. Only one batch scan can run app-wide; duplicate starts are rejected natively. Starting while downloads are running is blocked. Per-file errors are counted and logged, and remaining files continue; a batch with any errors ends as failed rather than claiming full success. Cached cards reload on return and at completion.

Progress also goes to the central **Logs → DEAS** stream and the launching terminal (stderr), including `Library operation=scan`, job ID, file, `completed`, `total`, `remaining` and `failed`. Provider response bodies/tokens are not logged. See [Logs](LOGS.md). The task and status live for the current DEAS process, not across app exits; closing DEAS stops it. There is no cancel/resume control or automatic restart. Existing listing limits apply (5,000 files, eight subfolder levels); Linux native loopback fixtures and UI lifecycle tests verify the background behavior, not live CivitAI or Windows runtime execution.

## Authorization and failures

Choose a provider, save with the selected persistence policy and inspect identity status. A saved token is not verified; Refresh retries unavailable checks. Public browsing can stay anonymous; gated resources may require provider-side licenses. Keep tokens out of screenshots/reports/catalogs. See [auth](AUTH-PLUGIN.md) and [download contract](DOWNLOAD-PLUGINS.md).

Unavailable files/providers, conflicts and permission/license failures stay visible. Browsing/selection is not download/execution consent. Failed/cancelled batches retain remaining selection; large-transfer resume remains separate work. Use [Logs](LOGS.md) before retrying and preserve existing environments.
