# Download and authentication plugins

## Implementation contract

Data-only TOML catalogs declare optional resources and provider plugins. UX is generated from validated catalog data; adding an entry must not require a JSX edit. Catalog files contain no credentials, shell commands or executable hooks. A downloadable workflow/preset is data, not permission to execute it.

Provider families: Hugging Face model/dataset repository files and user repository listing; CivitAI creator/model resources; GitHub user repositories and repository files; generic HTTPS direct files and declarative JSON resource indexes; explicit Ollama endpoint model listing. Ollama installed models are backend resources, not downloadable files or an implicit pull authorization.

Anonymous access is the default, with provider-specific limitations. Token access is a separate native plugin, bound to provider and exact configured origin. Tokens are never read back to frontend, persisted in drafts/catalogs, added to query strings or logs. Default storage is current-session memory; optional OS credential-store persistence must fail closed without plaintext fallback. Token presence is not proof of login, license acceptance, faster downloads or entitlement.

Only explicit Browse actions contact sources. Pagination must expose continuation/limits rather than claiming completeness. Native transport validates endpoints, bounded JSON and redirect behavior. Authorization must never be forwarded to foreign download/CDN redirects. Arbitrary direct HTTPS sources may be anonymous; trusted credential origins cannot be overridden by untrusted catalog entries.

Downloads are separately planned, immutable, consented and non-executing. A selected existing parent plus explicit new subfolder forms the destination; reject existing targets, traversal, symlink components and overwrites. Store resource identities, source origins, optional checksums/licenses and limits in the plan before confirmation. Stream into exclusive partial files; validate reported size/checksum when available, atomically publish, expose actual status/progress/errors and only delete app-owned partials. No auto-install into external ComfyUI or automatic workflow execution. Optional download failure must not relabel core ComfyUI installation failure or readiness.

## IPC contract for this slice

Catalog/discovery native module:

- `native_download_import_catalog({text})` validates/adds session-only TOML providers/entries; duplicate IDs cannot override origins. The UI offers an explicit text import; reading/importing never contacts a source.
- `native_download_catalog()` returns `{version:1, providers:[{id,kind,label,origin,scopes,anonymousNotice}], entries:[{id,label,providerId,scope,locator,kind,target,license?,sha256?,preview?}]}`. `target` is the ComfyUI folder category the UI groups by; `preview` is an HTTPS image/video URL rendered by the webview (CSP allows `image.civitai.com`). The compiled catalog merges `default.toml` with the entry-only `darksidewalker.toml` (generated from the CivitAI models API).
- `native_download_browse({request:{providerId,scope:'user'|'repo'|'model'|'search'|'index'|'backend',locator,cursor?:string,authenticated:boolean}})` returns `{resources:[{id,label,kind,url?:string,size?:number,sha256?:string,downloadable:boolean,locator?:string,preview?:string,category?:string}],nextCursor:string|null,warnings:string[]}`. CivitAI `search` takes free text and returns browsable model identities (`kind:'repo'`, `locator` = model ID) with `preview` (first version image, may be `.mp4`) and `category` (ComfyUI folder derived from the model type); `model`/`user` file listings carry the same two fields.
- `native_download_plan({request:{providerId,resources:[resource],parentPath,folderName,authenticated:boolean}})` returns `{id,target,resources,totalKnownBytes,unknownSizeCount,warnings,canExecute}`. An empty `folderName` stages into the existing user-owned `parentPath` itself (used for `<env>/ComfyUI/models/<category>`); files are still created exclusively and no manifest is written. A non-empty name creates a new subfolder as before.
- `native_download_start({planId,confirmed:true})`, `native_download_status()`, `native_download_cancel()` return `{state:'idle'|'running'|'succeeded'|'failed'|'cancelled',completed,total,bytesDownloaded,error:string|null}`.

Authentication module:

- `native_auth_status()` returns `[{providerId,configured:boolean,persisted:boolean}]` (metadata only).
- `native_auth_restore({providerId,origin?:string})` explicitly loads an OS-store entry; no startup credential restoration. The current UI exposes the three official providers; custom accounts require explicit native origin registration/set/restore and are not yet exposed in the UI.
- `native_auth_set({providerId,token,persist:boolean,origin?:string})` and `native_auth_remove({providerId})` return metadata only.
- Native `AuthState` offers `credential(provider_id, exact_origin) -> Result<Option<String>,String>`. Provider origins: huggingface=https://huggingface.co, civitai=https://civitai.com, github=https://api.github.com. Custom HTTP/Ollama credentials must be explicitly origin-bound, not inferred from catalog metadata; unsupported origins fail closed.

The UI uses these exact commands and displays native result only. Browser preview identifies missing native transport and never fabricates resources/progress. Authentication and catalog modules are independent; download/provider adapters reuse only the scoped credential accessor. Runtime secrets must not appear in errors or status.

## Catalog extension example and current limits

Paste an entry-only extension into **Extend TOML catalog**. Replace the illustrative URL and IDs with actual resources before browsing; this example does not claim an existing downloadable file.

```toml
version = 1
providers = []

[[entries]]
id = "my-workflow"
label = "My API workflow data"
providerId = "http"
scope = "index"
locator = "direct:https://raw.githubusercontent.com/OWNER/REPO/main/workflow.json"
kind = "workflow"
target = "workflow-files"
# license = "License checked against upstream"
# sha256 = "Exact 64-character SHA-256 from a trusted source"
```

`target` is catalog guidance, not permission to write into that folder. The user selects an existing parent and new child separately. New HTTPS origins require their own declared `http` provider with a unique ID; they never inherit HF/CivitAI/GitHub credentials. `direct:` disambiguates a JSON file from `index:`. A JSON index uses `{version:1, resources:[resource]}` with the Resource IPC shape and validated same-origin download URLs.

HF locators use `models:OWNER`/`datasets:OWNER` at user scope, then `models:OWNER/REPO`/`datasets:OWNER/REPO` at repository scope. GitHub uses `OWNER` then `OWNER/REPO[/directory]`; CivitAI uses creator username or model ID. Ollama accepts only its declared explicit loopback origin and returns passive tags.

The parent must be effective-user-owned and not group/world writable; staging children have private permissions. Same-user adversarial mutation is not a sandbox guarantee. Current download writing is Linux-only and bounded to 16 files, 20 GiB total and one hour per job. HF resolves `main`; GitHub uses its default revision and at most 50 directory entries. No automatic recursive clone, Git LFS expansion, revision pinning, large-download resume or managed model placement. HTTP fixtures prove transport mechanics; upstream response-shape fixtures are not live API acceptance. Session imports and saved custom credential origin bindings are not automatically restored. Real vault operations have not been tested; vault failures have no plaintext fallback.

## Acceptance checklist

- [x] Validated extensible TOML catalog feeds UX without resource-specific rendering code.
- [x] Dynamic provider listing, pagination and anonymous limitations.
- [x] Separate authentication module with metadata-only reads and scoped native credentials.
- [x] Explicit immutable download plans and real bounded streaming with integrity/path protections.
- [x] UI explicit browse/auth/download consent, stale result invalidation and localization.
- [x] Scratch HTTP/file tests, frontend/native build gates, responsive browser fixtures and native initial-screen rendering; interactive native plugin UI-to-transport acceptance remains unverified.

Live authenticated provider, gated license acceptance, provider rate/speed entitlement, large-model resume, full install integration and other target OS verification must be distinguished from local HTTP/UI fixtures.
