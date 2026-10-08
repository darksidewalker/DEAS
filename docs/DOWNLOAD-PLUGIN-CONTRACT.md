# Download and authentication plugin contract

The current canonical IPC/data/acceptance contract is [DOWNLOAD-PLUGINS.md](DOWNLOAD-PLUGINS.md). It supersedes the earlier `native_download_list`, `native_auth_clear` and resource/status-envelope draft in this document.

Catalogs and language packs remain strict data-only extensions. Native adapters implement reviewed transport behavior; optional token management remains independent and exact-origin bound. Browsing, planning and separately confirmed streaming downloads never authorize installation, workflow execution, backend startup or an Ollama pull. Current bytes/file acceptance uses Linux scratch HTTP fixtures, not live authenticated provider or model-download tests.

See [the roadmap](PLUGIN-ROADMAP.md) for future managed placement, repeatable model packs, resumability and broader provider/backend integration, and [verification](VERIFICATION.md) for actual coverage.
