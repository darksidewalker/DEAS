//! Integration-test anchor for the package (API-DESIGN §13, M8's acceptance home).
//!
//! Two duties:
//!
//! * The smoke assertions keep the crate's identity honest: this target is the
//!   cheapest end-to-end proof that the package builds, links and runs a test
//!   binary at all, with no manifest flags of its own.
//! * The loader law it documents. The lib's unit-test executables call the
//!   Common-Controls v6 shell surface (task dialogs), so they die at load with
//!   `STATUS_ENTRYPOINT_NOT_FOUND` (`TaskDialogIndirect`) unless the v6
//!   Common-Controls manifest is embedded in the exe. That embedding is NOT
//!   automatic at this tip: `build.rs` is stock (`tauri_build::build()`) and
//!   cargo 1.99 does not apply `cargo::rustc-link-arg-tests` to lib test
//!   executables. The shipped rule is therefore explicit link-args on the lib
//!   test run only:
//!
//!   ```text
//!   RUSTFLAGS="-C link-arg=/MANIFEST:EMBED -C link-arg=/MANIFESTINPUT:<agent-test-manifest.manifest>" \
//!     cargo test --lib -- --test-threads=1
//!   ```
//!
//!   An integration target like this one needs neither the manifest nor the
//!   flag, which is why `cargo test --test agent_api_smoke` runs bare — and why
//!   a bare `cargo test`/`--tests` is the forbidden idiom: it links the lib test
//!   exe without the manifest and dies at load (LNK1123/entrypoint class).

#[test]
fn crate_version_matches_manifest() {
    // The version the settings plane and the stock scan detector stamp into logs.
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.3.14");
}

#[test]
fn package_identity_is_deas() {
    // The exe name, the log source and the cache homes all key off this name.
    assert_eq!(env!("CARGO_PKG_NAME"), "deas");
}
