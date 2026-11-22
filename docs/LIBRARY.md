# Library, downloads and provider authorization

[Documentation index](README.md) · [Plan](PLAN.md)

## Library, downloads and provider authorization

Library is a main tab and Provider authorization is a pane in **Backend**'s left menu; optional downloads are also reachable from the studio plugin area, independently of baseline installation. A strict native TOML catalog feeds the UI; add resources/providers in `src-tauri/downloads/default.toml` or explicitly import an additive catalog for the current session. Browse HF users/model/dataset repositories, CivitAI creators/models, GitHub accounts/repository files, configured HTTPS direct/index sources or an explicitly configured loopback Ollama tags endpoint. Repository listings lead to explicit repository browsing; Ollama tags never imply a pull or downloadable file.

Provider tokens are optional and origin-bound. The UI defaults to the OS credential store with an explicit session-only opt-out; persistence/restoration never falls back to plaintext. Ticked files from any card collect in a **Selected for download** overview; **Download all** builds one immutable native plan per provider and folder and hands them to a native **download queue** that runs in the background. Files go to their managed ComfyUI folder, or to a chosen parent with an optional new subfolder. Staged files are inert data, not installed models or executed workflows. Linux scratch HTTP transfers and UI/IPC fixtures are tested; Windows write paths exist in code but are not runtime-verified. Live authenticated providers and real OS-store operation remain unverified; large-download resume is implemented and fixture-verified (kept partials continue with HTTP Range only when the source pins size and SHA-256), while live-provider resume acceptance stays open. See [catalog examples, contracts and limits](DOWNLOAD-PLUGINS.md).

## Background download queue

**Download all** starts a native queue (one job per provider/destination folder, at most 16 files each) that runs on its own worker: leaving Library, switching workspace tabs or closing and restarting DEAS never aborts started transfers, and the queue is persisted. The **Queue** tab (also opened automatically when a download starts or Library reopens with a queue) lists every file on its own line: file name, state (Succeeded, Running, Queued, or where a job stopped: Failed/Cancelled/Interrupted), destination folder and job, provider, its own progress bar and percentage, its bytes placed of its size (B/KB/MB/GB) and, for the file being transferred, a live rate. A job's files download in order, so a stopped job shows its error and **Resume** on the file where it stopped; later files stay Queued. **Cancel** stops the running job and keeps every kept partial; **Resume** (per job or all) re-queues interrupted, cancelled or failed entries and continues after the files already placed, and a **Clear finished** action trims the list. The Library workspace tab shows a live percentage while a download runs. Queue progress and failures are also written to [Logs](LOGS.md). A new folder destination carries a small `deas-download-job.json` marker while its job is unfinished; the marker proves a later resume may reuse that folder and is replaced by the usual `deas-download-manifest.json` on success.

Catalog cards use the same category bar, provider/family tree, filters, sorting,
60-card batches and grid/list views as Installed. Name, known publication date,
known size, base model and shuffle sorting apply to the loaded catalog snapshot;
usage and version-count sorts are not offered without that evidence. Undated or
size-unknown cards stay last. File/version rows retain newest-first ordering.
Bundled dates are a catalog snapshot; live CivitAI user/search requests ask for
newest results. Sorting covers loaded results, not unseen provider pages. The
18+ badge reflects the provider's model classification, not the preview image
rating. Opening a CivitAI model lists individual files across its versions (up to
50); quantizations are selected explicitly, never downloaded together automatically.
Conflicting destination filenames block the plan instead of overwriting files.

## Catalog and Installed views

Catalog parity is implemented in the 0.2.40 development source; published 0.2.39
does not contain it. Browser-fixture evidence and outstanding native/live-provider
acceptance are recorded in [verification](VERIFICATION.md) and [PLAN](PLAN.md).

**Installed** is the left tab and **Catalog** the right tab. Catalog source,
Search catalog & CivitAI and Download all share the top action line; the category
bar sits beneath it, with folders/filters beside the gallery. Reordering the tabs
does not itself start a local scan or provider request. Creator and CivitAI search
results use the same gallery; opening one model's files retains its sibling cards.

Catalog stars, tags and personal notes are saved separately from installed-file
organization. Their identity uses the exact provider, browsing scope and locator,
not the card label or a pretend filesystem path. Use a card's Details control to
edit notes/tags without contacting its provider, or click the card to browse its
files explicitly. Search includes saved notes/tags. Favorites include hidden
provider/family groups; returning to a group restores normal visibility rules.
The Catalog's Metadata filter describes supplied catalog fields, not a safetensors
inspection or execution proof. No local Scan Files, family-sidecar editing or file
move/delete action is offered for online entries.

Catalog offers source selection, provider browsing/search, category/base-model filters, sorting, file/version/quantization selection and Selected for download. Installed scans the configured models folder; opening a file shows path/size/hash, a **File check** row when a safetensors header covers payload the file does not hold (**Incomplete safetensors: … Download it again**), and an explicit CivitAI metadata fetch/cache action. Listing a file is not compatibility proof; a truncated safetensors is excluded from the Studio's automatic component selection, so a broken encoder is never picked silently.

### Favorites and family organization

**Favorites** is an entry in the left sidebar of Installed and the Studio Models/
LoRAs browsers. It opens the shared saved favorites for that category, including
cards in folders whose eye is off. It leaves folder visibility preferences intact;
click a folder or its root to resume normal browsing. Star a Library card, or
right-click a Studio card and choose **Add to favorites** / **Remove from favorites**.
Favorites are local preferences and do not change the selected LoRAs or weights.

Bulk family editing is available beside Search in Studio's Models and LoRAs dock.
See [Studio](STUDIO.md#bulk-family-editing). Family edits update Library cards too.

Explicit **Refresh models**, a successful per-file metadata fetch, and completed
**Fetch** / **Scan Files** tasks update an already-open Studio from the same inventory.
Completed jobs with per-file errors still publish the available results. Studio
does not start a second folder walk for that update. Local cover URLs are refreshed
so replaced previews can be retried. Simply returning to the app still uses the
saved browsing snapshot; external file changes require an explicit refresh.

### How files are matched on CivitAI

Fetch and Scan Files first ask CivitAI for the file's full SHA-256. When CivitAI does
not know that hash, DEAS tries these fallbacks in order and takes the first match:

1. **Local CivitAI sidecars** next to the model — `<name>.civitai.info` (Civitai
   Helper) and `<name>.api_info.json` (CivitAI Browser for Forge/Forge Neo). A record is
   used only when one of its files lists this file's SHA-256 (or AutoV3, below). DEAS then
   asks CivitAI for that version's current data and keeps the sidecar's data when
   CivitAI no longer has it.
2. **AutoV3 tensor hash** for `.safetensors`: the SHA-256 of the weights after the
   safetensors header, as CivitAI computes it. It still matches when a tool rewrote the
   file's embedded metadata (renamed it, added training notes), which changes the full
   SHA-256. The answer is accepted only when the returned version lists that AutoV3. It
   is computed once and cached in `.deas.json`.
3. **Forge/A1111 `<name>.json`** with a `modelId` (or `modelVersionId`), as written by
   CivitAI Browser: DEAS loads that model and picks the version whose files list this
   file's hash. A `.json` that names a different `sha256` belongs to an older file and is
   ignored.

The detail panel shows how a record was matched: nothing extra for the full hash,
*Matched by tensor hash*, *Matched through a local WebUI sidecar file* or *Linked
manually*. Foreign sidecars are only read, never written, moved or deleted. When DEAS
has no trigger words for a file yet, the `activation text` of a Forge `.json` becomes its
trigger words (split at commas; edit them under **Trigger words**).

A file CivitAI does not know shows **Not found on CivitAI · last checked** with the
date. Such files are **always looked up again**: **Only missing metadata or previews**
skips only files that already have a CivitAI record, because new uploads are indexed
later and the fallbacks above can match now. Files whose bytes differ from every upload
(merged, converted, quantized or re-saved weights, or a mirror's copy) cannot be matched
by any hash. For those, paste the model or version page into **CivitAI link** and choose
**Link**. Page links (`https://civitai.com/models/<id>`, with or without
`?modelVersionId=`), download links and civitai.red links work. Only the IDs are taken
from the link; the request goes to the configured CivitAI provider. A model link picks
the version that lists this file's hash, otherwise the newest version. A link is saved
as your choice: later lookups that find nothing keep it, and a real hash match replaces
it.

### Scan Files (Installed)

Choose **All**, **Models** (all non-LoRA folders, including VAEs/encoders) or **LoRAs**, then **Scan Files**. This explicitly starts one native background task for the configured models root. A full scan can take a long time: model files are hashed and CivitAI is queried sequentially using the existing per-file metadata path. Hashing reads each file in 8 MiB slices, which measured 2,253 MiB/s here (a 24.4 GB model hashed in 10.32 s, digest identical to the one already cached); the ignored `hash_throughput_reference` test re-measures that rate against the largest model under the fixed path `F:\models` and skips itself when that drive is not mounted. A configured CivitAI token is used; otherwise lookup is anonymous. Valid cached hashes are reused, and metadata is safely written beside each model as `<file>.deas.json`; model contents are never modified.

Changing Library categories, switching to Catalog or another main tab, and reopening Library **do not stop the scan**. Installed reconnects to the native task and shows its current filename, processed/total count, remaining count and failures. Only one batch scan can run app-wide; duplicate starts are rejected natively. Starting while downloads are running is blocked. Per-file errors are counted and logged, and remaining files continue; a batch with any errors ends as failed rather than claiming full success. Cached cards reload on return and at completion.

Progress also goes to the central **Logs → DEAS** stream and the launching terminal (stderr), including `Library operation=scan`, job ID, file, `completed`, `total`, `remaining` and `failed`. Provider response bodies/tokens are not logged. See [Logs](LOGS.md). The task and status live for the current DEAS process, not across app exits; closing DEAS stops it. There is no cancel/resume control or automatic restart. Existing listing limits apply (5,000 files, eight subfolder levels); Linux native loopback fixtures and UI lifecycle tests verify the background behavior, not live CivitAI or Windows runtime execution.

### MatlowAI Dials

Open **Library → Catalog → Dials → MiniMax H3 Dials (MatlowAI)**. Select the dial
files you want, then use **Download all**. With a configured models folder, the
default destination is `loras/dials/`. Reopen **Dials** in Studio settings to refresh
the backend’s file list. Downloading does not apply a dial or install its node pack.
See [Dials](DIALS.md#what-you-need) for the backend requirements.

## Reusing existing model folders

Under **Backend → Settings**, select the models **root containing category subfolders**, for example `H:\Swarmui\models`, not its `Krea2`, `checkpoints` or `Lora` subfolder. Additional model roots use the same structure. DEAS scans standard ComfyUI categories and also recognizes SwarmUI’s `Stable-Diffusion` as `checkpoints` and `Lora` as `loras`. The owned backend receives the same mappings on its next start; this does not edit SwarmUI’s configuration. Folder names do not establish the model’s loading form: diffusion-only files still belong under `diffusion_models` or `unet`, rather than the checkpoint category.

Existing directory junctions on Windows and directory symlinks on Linux can point category folders or their subfolders to an existing model collection. Family detection and **Edit meta…** use the resolved directory while retaining the selected alias for model names. Saving or resetting an explicit family writes only the source-bound `<model>.deas.json` sidecar beside the actual file; rescanning reads it back. Aliases to the same canonical file under the same category and backend-relative name produce one row. Distinct backend names, such as `a/model.safetensors` and `b/model.safetensors`, remain available even when their directories link to the same target. The model itself and unrelated sidecars are not changed, and DEAS does not create links or move/copy files for this integration.

For backend loading, category-level directory links are registered through their resolved target in DEAS’s generated model-path configuration; no Windows trust setting is changed. A nested link that Windows itself refuses to traverse (error 448) is still a backend limitation: ComfyUI’s recursive directory-mtime lookup may fail the entire category listing, not just omit the linked model. Native metadata may be readable, but the backend must list and open the exact relative model name before Run can succeed. DEAS does not flatten/rename nested identifiers or patch ComfyUI to hide that limitation.

Link replacement/retargeting during an operation, replaced models, unsafe or linked sidecars and unwritable targets remain errors, not successful saves. Resolve the reported error before retrying; assigning a family does not prove that the file’s format, loader, components or pipeline can run. Files that genuinely need a different loading form are not made runnable by changing a label.

## Authorization and failures

Choose a provider, save with the selected persistence policy and inspect identity status. A saved token is not verified; Refresh retries unavailable checks. Public browsing can stay anonymous; gated resources may require provider-side licenses. Keep tokens out of screenshots/reports/catalogs. See [auth](AUTH-PLUGIN.md) and [download contract](DOWNLOAD-PLUGINS.md).

Unavailable files/providers, conflicts and permission/license failures stay visible. Browsing/selection is not download/execution consent. Failed or cancelled queue entries keep their files selected and can be resumed; kept partial files continue where they stopped. Use [Logs](LOGS.md) before retrying and preserve existing environments.
