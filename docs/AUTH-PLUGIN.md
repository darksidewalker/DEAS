# Native authentication plugin

The canonical current contract is [Download and authentication plugins](DOWNLOAD-PLUGINS.md). This document replaces an earlier session-only API draft; `native_auth_clear` and the old `AuthStatus.providers` envelope are not supported commands.

`src-tauri/src/auth.rs` owns exact-origin credentials independently of catalogs and network transports. Current commands are `native_auth_status`, `native_auth_set`, `native_auth_remove` and explicit `native_auth_restore`. Status returns an array; set/remove/restore return one metadata object with `providerId`, `configured` and `persisted`. No token is read back. Presence is not verified login, entitlement or license acceptance.

Session memory is default. Optional OS credential-store persistence and restoration are explicit, with no plaintext fallback and sanitized vault failures. Official origins are fixed: HF `https://huggingface.co`, CivitAI `https://civitai.com`, GitHub `https://api.github.com`. Native-only custom accounts require explicit `custom-…` identities and exact approved origins; catalogs never register credential scopes automatically. The current UI supports official providers only.

Native consumers use `AuthState::credential(provider_id, exact_origin)` or the scoped `authorization` helper. Download redirects disable automatic following and permanently strip authorization after an origin change. Credentials do not enter catalog/project data, URLs or logs. Best-effort owned-buffer clearing is not a cryptographic zeroization or malicious-frontend sandbox guarantee.

Tests in `src-tauri/src/auth_tests.rs` exercise session and injected-vault semantics without touching the user's real keyring. Permission wiring lives in `src-tauri/permissions/downloads.toml` and the local main capability. See [verified scope and remaining gaps](VERIFICATION.md).
