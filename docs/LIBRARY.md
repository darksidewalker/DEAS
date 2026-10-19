# Library, downloads and provider authorization

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md)

## Library, downloads and provider authorization

Provider authorization is a header action and Library is a main tab; optional downloads are also reachable from the studio plugin area, independently of baseline installation. A strict native TOML catalog feeds the UI; add resources/providers in `src-tauri/downloads/default.toml` or explicitly import an additive catalog for the current session. Browse HF users/model/dataset repositories, CivitAI creators/models, GitHub accounts/repository files, configured HTTPS direct/index sources or an explicitly configured loopback Ollama tags endpoint. Repository listings lead to explicit repository browsing; Ollama tags never imply a pull or downloadable file.

Provider tokens are optional and origin-bound. The UI defaults to the OS credential store with an explicit session-only opt-out; persistence/restoration never falls back to plaintext. Ticked files from any card collect in a **Selected for download** overview; **Download all** builds one immutable native plan per provider and folder and runs them in sequence. Files go to their managed ComfyUI folder, or to a chosen parent with an optional new subfolder. Staged files are inert data, not installed models or executed workflows. Linux scratch HTTP transfers and UI/IPC fixtures are tested; live authenticated providers, real OS-store operation, large-download resume and Windows writes remain unverified/unsupported. See [catalog examples, contracts and limits](DOWNLOAD-PLUGINS.md).

![Provider authorization tab — browser fixture](../assets/deas-downloads-fixture-1440.png)

The Library sorts catalog cards and loaded file rows by version publication date (newest first), or by name (A–Z). Undated entries come last. Bundled dates are a catalog snapshot; live CivitAI user/search requests ask for newest results. Name sorting covers loaded results, not unseen pages. All entries are always listed, and a base-model filter narrows model lists. The 18+ badge reflects the provider's model classification, not the preview image rating. Opening a CivitAI model lists individual files across its versions (up to 50); quantizations are selected explicitly, never downloaded together automatically. Conflicting destination filenames block the plan instead of overwriting files.


## Catalog and Installed views

Catalog offers source selection, provider browsing/search, category/base-model filters, sorting, file/version/quantization selection and Selected for download. Installed scans the configured models folder; opening a file shows path/size/hash and an explicit CivitAI metadata fetch/cache action. Listing a file is not compatibility proof.

## Authorization and failures

Choose a provider, save with the selected persistence policy and inspect identity status. A saved token is not verified; Refresh retries unavailable checks. Public browsing can stay anonymous; gated resources may require provider-side licenses. Keep tokens out of screenshots/reports/catalogs. See [auth](AUTH-PLUGIN.md) and [download contract](DOWNLOAD-PLUGIN-CONTRACT.md).

Unavailable files/providers, conflicts and permission/license failures stay visible. Browsing/selection is not download/execution consent. Failed/cancelled batches retain remaining selection; large-transfer resume remains separate work. Use [Logs](LOGS.md) before retrying and preserve existing environments.
