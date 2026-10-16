//! Opens a provider's own token page in the system browser so the user can copy an API key.
//! URLs are a fixed allowlist; nothing from the UI reaches the shell.
use std::process::Command;

fn token_page(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "huggingface" => Some("https://huggingface.co/settings/tokens"),
        "civitai" => Some("https://civitai.com/user/account"),
        "github" => Some("https://github.com/settings/tokens"),
        _ => None,
    }
}

#[tauri::command]
pub fn native_open_token_page(provider_id: String) -> Result<(), String> {
    let url = token_page(&provider_id).ok_or("Unknown provider")?;
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_allowlisted_providers_have_pages() {
        assert_eq!(
            token_page("civitai"),
            Some("https://civitai.com/user/account")
        );
        assert!(token_page("https://evil.example").is_none());
        assert!(native_open_token_page("nope".into()).is_err());
    }
}
