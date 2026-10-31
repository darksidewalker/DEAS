//! Native spellchecking configuration; dictionaries remain a system/runtime prerequisite.
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Accept the bounded BCP47 subset language[-Script][-REGION], not POSIX locales/extensions.
fn valid_language(language: &str) -> bool {
    fn letters(value: &str, min: usize, max: usize) -> bool {
        (min..=max).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphabetic())
    }
    if language.len() > 12 {
        return false;
    }
    let mut parts = language.split('-');
    if !parts.next().is_some_and(|part| letters(part, 2, 3)) {
        return false;
    }
    let mut next = parts.next();
    if next.is_some_and(|part| letters(part, 4, 4)) {
        next = parts.next();
    }
    if let Some(region) = next {
        if !letters(region, 2, 2)
            && !(region.len() == 3 && region.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return false;
        }
    }
    parts.next().is_none()
}

/// An unsupported platform/runtime is a known, UI-explained limit (e.g. WebView2 keeps the
/// OS spelling language), logged on every launch there; only real configuration failures are errors.
fn severity(code: &str) -> &'static str {
    if code == "SPELLCHECK_UNSUPPORTED" || code == "SPELLCHECK_DICTIONARY_UNAVAILABLE" {
        "WARN"
    } else {
        "ERROR"
    }
}

fn failure(code: &str) -> String {
    let message = match code {
        "SPELLCHECK_DICTIONARY_MISSING" => {
            "Install an Enchant-compatible dictionary for the selected language, then restart DEAS"
        }
        "SPELLCHECK_DICTIONARY_UNAVAILABLE" => {
            "No Hunspell dictionary is published for this language"
        }
        "SPELLCHECK_DICTIONARY_FAILED" => "Could not download or install the spellcheck dictionary",
        "SPELLCHECK_INVALID_LANGUAGE" => "Invalid spellchecking language tag",
        "SPELLCHECK_UNSUPPORTED" => {
            "Native spellchecking configuration is unsupported by this platform or runtime"
        }
        _ => "Could not configure native spellchecking",
    };
    let level = severity(code);
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|error| error.into_inner());
    if last.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!("{level}: PromptSpellcheck operation=spellcheck: {code}: {message} (repeats limited to once per minute)"),
        );
        *last = Some(Instant::now());
    }
    code.to_owned()
}

#[tauri::command]
pub fn native_prompt_spellcheck(
    window: tauri::WebviewWindow,
    enabled: bool,
    language: String,
) -> Result<(), String> {
    if !valid_language(&language) {
        return Err(failure("SPELLCHECK_INVALID_LANGUAGE"));
    }
    configure(window, enabled, language).map_err(|message| failure(&message))
}

/// A bundled Hunspell pair for the spellcheck languages that have a real dictionary (de/en/fr/tr).
struct Dictionary {
    language: &'static str,
    /// (sha256, size)
    dic: (&'static str, u64),
    aff: (&'static str, u64),
    license: &'static str,
}

// Pinned commit: the same files the sizes/hashes below were verified against.
const DICTIONARY_COMMIT: &str = "8cfea406b505e4d7df52d5a19bce525df98c54ab";
const MAX_DICTIONARY_BYTES: u64 = 12 * 1024 * 1024;
const DICTIONARIES: [Dictionary; 4] = [
    Dictionary {
        language: "de",
        dic: (
            "b5c781a0cf6f285fb6b9b8ab02fbea104b987104a1efdda8a835837e89e3ec77",
            1_118_194,
        ),
        aff: (
            "57fdd1b16aac2131003c91e0cf2a488becb970382a402a9ce089307301cb3ef0",
            19_199,
        ),
        license: "igerman98 · GPL-2.0/3",
    },
    Dictionary {
        language: "en",
        dic: (
            "f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647",
            551_762,
        ),
        aff: (
            "8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b",
            3_086,
        ),
        license: "SCOWL · public domain",
    },
    Dictionary {
        language: "fr",
        dic: (
            "984e933237bc1224a48f42828233be9b03228260ef67aa8e2bdddcd03a26230d",
            1_229_133,
        ),
        aff: (
            "05a735d34c912e4e381ff08ee7c747923ccf5cf9dca81d8467982fa1ca51c2b7",
            199_870,
        ),
        license: "Dictionnaires français · MPL",
    },
    Dictionary {
        language: "tr",
        dic: (
            "dc1d8f7724f4aefd117274678de431e4ea1765f2e02e6983b6ca48cbf5a7fc7c",
            9_117_192,
        ),
        aff: (
            "6a390c79b054ad427cf9a6bf6de43463953cc1918e7f727e9dd4ebd4f9702f42",
            240_814,
        ),
        license: "MIT",
    },
];

/// The dictionary for a BCP47 tag's base language; ja/zh have no Hunspell dictionary upstream.
fn dictionary(language: &str) -> Option<&'static Dictionary> {
    let base = language
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    DICTIONARIES.iter().find(|entry| entry.language == base)
}

/// Enchant 2's user dictionary path, verified with `enchant-lsmod-2 -list-dicts` on Enchant 2.8:
/// `$XDG_CONFIG_HOME/enchant/hunspell` (no root, no system package).
fn dictionary_dir() -> Result<std::path::PathBuf, String> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        });
    base.map(|path| path.join("enchant").join("hunspell"))
        .ok_or_else(|| "SPELLCHECK_DICTIONARY_FAILED".to_owned())
}

async fn fetch_dictionary(
    client: &reqwest::Client,
    url: &str,
    size: u64,
    sha256: &str,
    target: &std::path::Path,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "SPELLCHECK_DICTIONARY_FAILED".to_owned())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("SPELLCHECK_DICTIONARY_FAILED".to_owned());
    }
    if response
        .content_length()
        .is_some_and(|length| length != size || length > MAX_DICTIONARY_BYTES)
    {
        return Err("SPELLCHECK_DICTIONARY_FAILED".to_owned());
    }
    let partial = target.with_extension("partial");
    let mut file =
        std::fs::File::create(&partial).map_err(|_| "SPELLCHECK_DICTIONARY_FAILED".to_owned())?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "SPELLCHECK_DICTIONARY_FAILED".to_owned())?
    {
        count += chunk.len() as u64;
        if count > size || count > MAX_DICTIONARY_BYTES {
            let _ = std::fs::remove_file(&partial);
            return Err("SPELLCHECK_DICTIONARY_FAILED".to_owned());
        }
        digest.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|_| "SPELLCHECK_DICTIONARY_FAILED".to_owned())?;
    }
    if count != size || format!("{:x}", digest.finalize()) != sha256 {
        let _ = std::fs::remove_file(&partial);
        return Err("SPELLCHECK_DICTIONARY_FAILED".to_owned());
    }
    file.sync_all()
        .map_err(|_| "SPELLCHECK_DICTIONARY_FAILED".to_owned())?;
    drop(file);
    std::fs::rename(&partial, target).map_err(|_| "SPELLCHECK_DICTIONARY_FAILED".to_owned())
}

#[derive(serde::Serialize)]
pub struct SpellcheckDictionaryInfo {
    available: bool,
    license: Option<String>,
    bytes: Option<u64>,
}

/// Read-only: which pinned pair exists for a language; no network, no writes.
#[tauri::command]
pub fn native_spellcheck_dictionary_info(
    language: String,
) -> Result<SpellcheckDictionaryInfo, String> {
    if !valid_language(&language) {
        return Err("SPELLCHECK_INVALID_LANGUAGE".to_owned());
    }
    Ok(match dictionary(&language) {
        Some(entry) => SpellcheckDictionaryInfo {
            available: true,
            license: Some(entry.license.to_owned()),
            bytes: Some(entry.dic.1 + entry.aff.1),
        },
        None => SpellcheckDictionaryInfo {
            available: false,
            license: None,
            bytes: None,
        },
    })
}

#[derive(serde::Serialize)]
pub struct SpellcheckDictionary {
    /// Absolute path of the installed `.dic` file.
    path: String,
    license: String,
    /// False means Enchant needs an app restart before it lists the new dictionary.
    loaded: bool,
}

/// Explicit install of the bundled Hunspell pair; nothing is downloaded by reading settings.
#[tauri::command]
pub fn native_spellcheck_dictionary_install(
    window: tauri::WebviewWindow,
    language: String,
    enabled: bool,
) -> Result<SpellcheckDictionary, String> {
    if !valid_language(&language) {
        return Err(failure("SPELLCHECK_INVALID_LANGUAGE"));
    }
    let entry =
        dictionary(&language).ok_or_else(|| failure("SPELLCHECK_DICTIONARY_UNAVAILABLE"))?;
    let dir = dictionary_dir().map_err(|_| failure("SPELLCHECK_DICTIONARY_FAILED"))?;
    std::fs::create_dir_all(&dir).map_err(|_| failure("SPELLCHECK_DICTIONARY_FAILED"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| failure("SPELLCHECK_DICTIONARY_FAILED"))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| failure("SPELLCHECK_DICTIONARY_FAILED"))?;
    let base = format!(
        "https://raw.githubusercontent.com/wooorm/dictionaries/{DICTIONARY_COMMIT}/dictionaries/{}/index",
        entry.language
    );
    let dic = dir.join(format!("{}.dic", entry.language));
    let aff = dir.join(format!("{}.aff", entry.language));
    runtime.block_on(async {
        fetch_dictionary(
            &client,
            &format!("{base}.dic"),
            entry.dic.1,
            entry.dic.0,
            &dic,
        )
        .await?;
        fetch_dictionary(
            &client,
            &format!("{base}.aff"),
            entry.aff.1,
            entry.aff.0,
            &aff,
        )
        .await
    })?;
    let loaded = configure(window, enabled, language).is_ok();
    Ok(SpellcheckDictionary {
        path: dic.display().to_string(),
        license: entry.license.to_owned(),
        loaded,
    })
}

#[cfg(target_os = "linux")]
fn configure(window: tauri::WebviewWindow, enabled: bool, language: String) -> Result<(), String> {
    use webkit2gtk::{WebContextExt, WebViewExt};

    // WebKit uses Enchant-style lang_COUNTRY identifiers, not HTML language hints.
    let language = language.replace('-', "_");
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |platform| {
            let result = platform
                .inner()
                .context()
                .ok_or_else(|| "SPELLCHECK_UNSUPPORTED".to_owned())
                .and_then(|context| {
                    // This context can be shared with other webviews in the same application.
                    context.set_spell_checking_languages(&[&language]);
                    context.set_spell_checking_enabled(enabled);
                    if context.is_spell_checking_enabled() != enabled {
                        return Err("SPELLCHECK_UNSUPPORTED".to_owned());
                    }
                    if !enabled {
                        return Ok(());
                    }
                    // WebKit's getter describes loaded Enchant dictionaries, not requested tags.
                    let mut loaded = context.spell_checking_languages();
                    if loaded.is_empty() && !language.contains('_') {
                        if let Some(regional) = regional_dictionary(&language)? {
                            context.set_spell_checking_languages(&[&regional]);
                            loaded = context.spell_checking_languages();
                        }
                    }
                    check_loaded_language(&language, loaded.iter().map(|tag| tag.as_str()))
                });
            let _ = send.send(result);
        })
        .map_err(|_| "SPELLCHECK_CONFIGURE_FAILED".to_owned())?;
    // Tauri executes inline on its UI thread; off-thread callers wait for the real result.
    receive
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "SPELLCHECK_CONFIGURE_FAILED".to_owned())?
}

#[cfg(any(target_os = "linux", test))]
fn check_loaded_language<'a>(
    language: &str,
    loaded: impl Iterator<Item = &'a str>,
) -> Result<(), String> {
    let language = language.replace('-', "_").to_ascii_lowercase();
    if loaded.into_iter().any(|tag| {
        let tag = tag.replace('-', "_").to_ascii_lowercase();
        tag == language
            || (!language.contains('_') && tag.starts_with(&format!("{language}_")))
            || (!tag.contains('_') && language.starts_with(&format!("{tag}_")))
    }) {
        Ok(())
    } else {
        Err("SPELLCHECK_DICTIONARY_MISSING".to_owned())
    }
}

#[cfg(target_os = "linux")]
fn regional_dictionary(language: &str) -> Result<Option<String>, String> {
    use std::ffi::{c_char, c_void, CStr};
    type Describe = unsafe extern "C" fn(
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        *mut c_void,
    );
    unsafe extern "C" fn collect(
        tag: *const c_char,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
        data: *mut c_void,
    ) {
        if !tag.is_null() {
            if let Ok(tag) = CStr::from_ptr(tag).to_str() {
                (*(data as *mut Vec<String>)).push(tag.to_owned());
            }
        }
    }
    // Only enumerate for base-language fallback; WebKit still verifies the selected dictionary loads.
    unsafe {
        let unsupported = |_| "SPELLCHECK_UNSUPPORTED".to_owned();
        // Enchant 2.8 registers GTypes: unloading/reloading it can abort on duplicate types.
        static LIBRARY: std::sync::OnceLock<Result<libloading::Library, libloading::Error>> =
            std::sync::OnceLock::new();
        let library = LIBRARY
            .get_or_init(|| libloading::Library::new("libenchant-2.so.2"))
            .as_ref()
            .map_err(|_| "SPELLCHECK_UNSUPPORTED".to_owned())?;
        let init = library
            .get::<unsafe extern "C" fn() -> *mut c_void>(b"enchant_broker_init\0")
            .map_err(unsupported)?;
        let free = library
            .get::<unsafe extern "C" fn(*mut c_void)>(b"enchant_broker_free\0")
            .map_err(unsupported)?;
        let list = library
            .get::<unsafe extern "C" fn(*mut c_void, Describe, *mut c_void)>(
                b"enchant_broker_list_dicts\0",
            )
            .map_err(unsupported)?;
        let broker = init();
        if broker.is_null() {
            return Err("SPELLCHECK_UNSUPPORTED".to_owned());
        }
        let mut tags = Vec::<String>::new();
        list(broker, collect, &mut tags as *mut _ as *mut c_void);
        free(broker);
        tags.sort();
        Ok(tags
            .into_iter()
            .find(|tag| check_loaded_language(language, std::iter::once(tag.as_str())).is_ok()))
    }
}

#[cfg(not(target_os = "linux"))]
fn configure(
    _window: tauri::WebviewWindow,
    _enabled: bool,
    _language: String,
) -> Result<(), String> {
    // shortcut: installed WebView2 bindings expose no spellchecking profile API; upgrade when available.
    Err("SPELLCHECK_UNSUPPORTED".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bundled_languages_and_safe_system_language_tags() {
        for language in [
            "en",
            "de",
            "fr",
            "ja",
            "tr",
            "zh",
            "en-US",
            "de-DE",
            "zh-Hans",
            "zh-Hant-TW",
            "es-419",
            "fil-PH",
            "EN-us",
        ] {
            assert!(valid_language(language), "{language}");
        }
    }

    #[test]
    fn rejects_unsafe_malformed_and_out_of_subset_tags() {
        for language in [
            "",
            "e",
            "english",
            "en_US",
            "en-US.UTF-8",
            " en",
            "en ",
            "en\0",
            "en\n",
            "éé",
            "en/US",
            "en--US",
            "en-",
            "en-US-",
            "en-Latn-US-extra",
            "en-US-Latn",
            "en-u-ca",
            "x-private",
            "en-1234",
            "en-1A",
            "en-ABCDE",
            "en-<script>",
        ] {
            assert!(!valid_language(language), "{language:?}");
        }
    }

    #[test]
    fn failure_is_shared_logged_without_untrusted_input_and_rate_limited() {
        let message = "SPELLCHECK_DICTIONARY_MISSING";
        assert_eq!(failure(message), message);
        assert_eq!(failure(message), message);
        let matching: Vec<_> = crate::logs::native_logs(0)
            .into_iter()
            .filter(|entry| {
                entry
                    .text
                    .contains("PromptSpellcheck operation=spellcheck:")
            })
            .collect();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].source, crate::logs::Source::Deas);
        assert!(matching[0].text.contains(message));
        assert!(matching[0]
            .text
            .contains("Install an Enchant-compatible dictionary"));
        assert!(!matching[0].text.contains("<script>"));
        assert!(matching[0].text.starts_with("ERROR: "));
    }

    #[test]
    fn unsupported_platform_is_a_warning_not_an_error() {
        assert_eq!(severity("SPELLCHECK_UNSUPPORTED"), "WARN");
        for code in [
            "SPELLCHECK_DICTIONARY_MISSING",
            "SPELLCHECK_INVALID_LANGUAGE",
            "OTHER",
        ] {
            assert_eq!(severity(code), "ERROR");
        }
    }

    #[test]
    fn requires_a_loaded_dictionary_for_the_selected_language() {
        for (language, loaded) in [("en", "en_US"), ("EN-us", "en_US"), ("de-DE", "de")] {
            assert_eq!(
                check_loaded_language(language, [loaded].into_iter()),
                Ok(())
            );
        }
        for loaded in [vec![], vec!["fr_FR"], vec!["english"], vec!["en_GB"]] {
            assert_eq!(
                check_loaded_language("en_US", loaded.into_iter()),
                Err("SPELLCHECK_DICTIONARY_MISSING".to_owned())
            );
        }
    }

    #[test]
    fn dictionary_pairs_are_pinned_for_published_languages_only() {
        for (language, base) in [
            ("de", "de"),
            ("de-DE", "de"),
            ("EN-us", "en"),
            ("fr", "fr"),
            ("tr_TR", "tr"),
        ] {
            let entry = dictionary(language).unwrap_or_else(|| panic!("{language}"));
            assert_eq!(entry.language, base);
            assert_eq!(entry.dic.0.len(), 64);
            assert!(entry.dic.0.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(entry.dic.1 > 0 && entry.dic.1 <= MAX_DICTIONARY_BYTES);
            assert_eq!(entry.aff.0.len(), 64);
            assert!(entry.aff.1 > 0 && entry.aff.1 <= MAX_DICTIONARY_BYTES);
        }
        for language in ["ja", "zh", "zh-Hans", "es", "ko"] {
            assert!(dictionary(language).is_none(), "{language}");
        }
        assert_eq!(
            severity("SPELLCHECK_DICTIONARY_UNAVAILABLE"),
            "WARN",
            "a language without a published dictionary is a known limit"
        );
        assert_eq!(severity("SPELLCHECK_DICTIONARY_FAILED"), "ERROR");
    }

    #[test]
    #[ignore = "network: verifies the pinned Hunspell URLs, sizes and digests"]
    fn downloads_pinned_dictionary_pairs() {
        let dir = std::env::temp_dir().join(format!("deas-dict-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for language in ["de", "en", "fr", "tr"] {
            let entry = dictionary(language).unwrap();
            let base = format!(
                "https://raw.githubusercontent.com/wooorm/dictionaries/{DICTIONARY_COMMIT}/dictionaries/{language}/index"
            );
            let dic = dir.join(format!("{language}.dic"));
            let aff = dir.join(format!("{language}.aff"));
            runtime.block_on(async {
                fetch_dictionary(
                    &client,
                    &format!("{base}.dic"),
                    entry.dic.1,
                    entry.dic.0,
                    &dic,
                )
                .await
                .unwrap();
                fetch_dictionary(
                    &client,
                    &format!("{base}.aff"),
                    entry.aff.1,
                    entry.aff.0,
                    &aff,
                )
                .await
                .unwrap();
            });
            assert_eq!(std::fs::metadata(&dic).unwrap().len(), entry.dic.1);
            assert_eq!(std::fs::metadata(&aff).unwrap().len(), entry.aff.1);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires the host Enchant 2 runtime; run explicitly for native dictionary availability"]
    fn probes_installed_enchant_without_a_display() {
        for language in ["en", "de"] {
            let dictionary =
                regional_dictionary(language).expect("host Enchant 2 must be available");
            eprintln!("Enchant {language}: {dictionary:?}");
            if let Some(tag) = dictionary {
                assert_eq!(
                    check_loaded_language(language, [tag.as_str()].into_iter()),
                    Ok(())
                );
            }
        }
    }
}
