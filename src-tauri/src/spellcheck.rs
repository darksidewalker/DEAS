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
    if code == "SPELLCHECK_UNSUPPORTED" {
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
            &format!("{level}: PromptSpellcheck operation=configure: {code}: {message} (repeats limited to once per minute)"),
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
            .filter(|entry| entry.text.contains("PromptSpellcheck operation=configure:"))
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
