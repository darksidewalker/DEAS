//! Independent origin-bound credential plugin. No catalog/network authority.
//! Session memory is the default. Vault reuse requires explicit `native_auth_restore`.
//! Native consumers must disable redirects and never log returned credential strings.
use reqwest::{header::HeaderValue, Url};
use serde::Serialize;
use std::{collections::BTreeMap, sync::Mutex};

const UNKNOWN: &str = "Unknown authentication provider";
const INVALID_ORIGIN: &str = "Authentication origin is not permitted";
const UNAVAILABLE: &str = "Authentication state is unavailable";
const VAULT_ERROR: &str = "OS credential store is unavailable; no credential change was committed";
const PROVIDERS: [(&str, &str); 3] = [
    ("huggingface", "https://huggingface.co"),
    ("civitai", "https://civitai.com"),
    ("github", "https://api.github.com"),
];

// Neither credentials nor the state implement Debug/Serialize/Clone.
struct Token(Vec<u8>);
impl Token {
    fn new(value: String) -> Result<Self, String> {
        let token = Self(value.into_bytes());
        if token.0.is_empty()
            || token.0.len() > 8192
            || !token.0.iter().all(|b| matches!(b, 0x21..=0x7e))
        {
            return Err("Token must contain 1–8192 visible ASCII characters without spaces".into());
        }
        Ok(token)
    }
    fn text(&self) -> &str {
        // Token::new has validated ASCII; this cannot fail.
        std::str::from_utf8(&self.0).unwrap_or("")
    }
}
impl Drop for Token {
    fn drop(&mut self) {
        // Best effort, not a guarantee against allocator/IPC/header copies.
        self.0.fill(0);
    }
}

/// Internal injected backend. Implementations must never expose OS errors or secrets.
trait CredentialStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>, ()>;
    fn write(&self, account: &str, token: &str) -> Result<(), ()>;
    fn delete(&self, account: &str) -> Result<(), ()>;
}
struct OsCredentialStore;
impl OsCredentialStore {
    fn entry(account: &str) -> Result<keyring::Entry, ()> {
        keyring::Entry::new("DEAS.origin-bound-auth.v1", account).map_err(|_| ())
    }
}
impl CredentialStore for OsCredentialStore {
    fn read(&self, account: &str) -> Result<Option<String>, ()> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }
    fn write(&self, account: &str, token: &str) -> Result<(), ()> {
        Self::entry(account)?.set_password(token).map_err(|_| ())
    }
    fn delete(&self, account: &str) -> Result<(), ()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}
struct Provider {
    origin: String,
    token: Option<Token>,
    persisted: bool,
}
pub struct AuthState {
    providers: Mutex<BTreeMap<String, Provider>>,
    store: Box<dyn CredentialStore>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProviderStatus {
    pub provider_id: String,
    /// Presence only; never proof of account verification, license or entitlement.
    pub configured: bool,
    pub persisted: bool,
}
impl Default for AuthState {
    fn default() -> Self {
        Self::with_store(Box::new(OsCredentialStore))
    }
}
fn account(id: &str, origin: &str) -> String {
    format!("{id}|{origin}")
}
fn metadata(id: &str, provider: &Provider) -> AuthProviderStatus {
    AuthProviderStatus {
        provider_id: id.into(),
        configured: provider.token.is_some(),
        persisted: provider.persisted,
    }
}
fn validate_custom(id: &str, exact_origin: &str) -> Result<(), String> {
    if !id.starts_with("custom-")
        || id.len() <= 7
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Custom provider ids must use custom- plus lowercase letters, digits or hyphens (64 characters maximum)".into());
    }
    let url = Url::parse(exact_origin).map_err(|_| INVALID_ORIGIN.to_string())?;
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if exact_origin.len() > 2048
        || exact_origin != url.origin().ascii_serialization()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
    {
        return Err(INVALID_ORIGIN.into());
    }
    Ok(())
}
impl AuthState {
    fn with_store(store: Box<dyn CredentialStore>) -> Self {
        Self {
            providers: Mutex::new(
                PROVIDERS
                    .into_iter()
                    .map(|(id, origin)| {
                        (
                            id.into(),
                            Provider {
                                origin: origin.into(),
                                token: None,
                                persisted: false,
                            },
                        )
                    })
                    .collect(),
            ),
            store,
        }
    }
    pub fn status(&self) -> Result<Vec<AuthProviderStatus>, String> {
        let providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
        Ok(providers.iter().map(|(id, p)| metadata(id, p)).collect())
    }
    /// Native trusted local/user approval only. Never call from catalog registration.
    /// Registration is session-only and cannot rebind an existing id.
    pub fn register_generic_provider(&self, id: &str, exact_origin: &str) -> Result<(), String> {
        validate_custom(id, exact_origin)?;
        let mut providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
        if let Some(p) = providers.get(id) {
            return if p.origin == exact_origin {
                Ok(())
            } else {
                Err(INVALID_ORIGIN.into())
            };
        }
        if providers.len() >= 64 {
            return Err("Authentication provider limit reached".into());
        }
        providers.insert(
            id.into(),
            Provider {
                origin: exact_origin.into(),
                token: None,
                persisted: false,
            },
        );
        Ok(())
    }
    /// Set a credential for an already trusted registration.
    pub fn set(
        &self,
        id: &str,
        token: String,
        persist: bool,
    ) -> Result<AuthProviderStatus, String> {
        let token = Token::new(token)?;
        let mut providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let p = providers.get_mut(id).ok_or_else(|| UNKNOWN.to_string())?;
        let key = account(id, &p.origin);
        if persist {
            self.store
                .write(&key, token.text())
                .map_err(|_| VAULT_ERROR.to_string())?;
        } else if p.persisted {
            // Explicit downgrade removes the known saved value before replacing memory.
            self.store
                .delete(&key)
                .map_err(|_| VAULT_ERROR.to_string())?;
        }
        p.token = Some(token);
        p.persisted = persist;
        Ok(metadata(id, p))
    }
    /// Explicit restore: default/status/credential never consult the OS vault.
    pub fn restore(&self, id: &str) -> Result<AuthProviderStatus, String> {
        let mut providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let p = providers.get_mut(id).ok_or_else(|| UNKNOWN.to_string())?;
        if let Some(value) = self
            .store
            .read(&account(id, &p.origin))
            .map_err(|_| VAULT_ERROR.to_string())?
        {
            let token =
                Token::new(value).map_err(|_| "Stored credential is invalid".to_string())?;
            p.token = Some(token);
            p.persisted = true;
        } else {
            p.token = None;
            p.persisted = false;
        }
        Ok(metadata(id, p))
    }
    /// Removes session-only credentials without OS access. Persisted credentials,
    /// or explicit deletion when no session credential exists, also delete the vault.
    /// A session override does not discover/delete a prior un-restored saved value;
    /// call remove again after clearing the session override to explicitly purge it.
    /// Vault failure retains current metadata for retry.
    pub fn remove(&self, id: &str) -> Result<AuthProviderStatus, String> {
        let mut providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let p = providers.get_mut(id).ok_or_else(|| UNKNOWN.to_string())?;
        if p.persisted || p.token.is_none() {
            self.store
                .delete(&account(id, &p.origin))
                .map_err(|_| VAULT_ERROR.to_string())?;
        }
        p.token = None;
        p.persisted = false;
        Ok(metadata(id, p))
    }
    pub fn credential(
        &self,
        provider_id: &str,
        exact_origin: &str,
    ) -> Result<Option<String>, String> {
        let providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
        let p = providers
            .get(provider_id)
            .ok_or_else(|| UNKNOWN.to_string())?;
        if p.origin != exact_origin {
            return Err(INVALID_ORIGIN.into());
        }
        Ok(p.token.as_ref().map(|token| token.text().to_owned()))
    }
    /// Compatibility helper for native transports. Foreign targets remain anonymous.
    pub fn authorization(
        &self,
        provider_id: &str,
        url: &Url,
    ) -> Result<Option<HeaderValue>, String> {
        if !url.username().is_empty() || url.password().is_some() {
            return Ok(None);
        }
        let expected = {
            let providers = self.providers.lock().map_err(|_| UNAVAILABLE.to_string())?;
            providers
                .get(provider_id)
                .ok_or_else(|| UNKNOWN.to_string())?
                .origin
                .clone()
        };
        if url.origin().ascii_serialization() != expected {
            return Ok(None);
        }
        let Some(value) = self.credential(provider_id, &expected)? else {
            return Ok(None);
        };
        let token = Token(value.into_bytes());
        let mut bytes = b"Bearer ".to_vec();
        bytes.extend_from_slice(&token.0);
        let result = HeaderValue::from_bytes(&bytes);
        bytes.fill(0);
        let mut header = result.map_err(|_| "Invalid authentication header".to_string())?;
        header.set_sensitive(true);
        Ok(Some(header))
    }
}
#[tauri::command]
pub fn native_auth_status(
    state: tauri::State<'_, AuthState>,
) -> Result<Vec<AuthProviderStatus>, String> {
    state.status()
}
#[tauri::command]
pub fn native_auth_set(
    state: tauri::State<'_, AuthState>,
    provider_id: String,
    token: String,
    persist: bool,
    origin: Option<String>,
) -> Result<AuthProviderStatus, String> {
    // Custom binding is explicit user input through this command, never catalog-derived.
    // Validate secret first so rejected input cannot create registrations.
    let token = Token::new(token)?;
    if let Some(origin) = origin {
        if PROVIDERS
            .iter()
            .any(|(id, trusted)| *id == provider_id && *trusted == origin)
        {
            // Exact built-in origin is accepted but cannot be changed.
        } else {
            state.register_generic_provider(&provider_id, &origin)?;
        }
    }
    state.set(&provider_id, token.text().to_owned(), persist)
}
#[tauri::command]
pub fn native_auth_remove(
    state: tauri::State<'_, AuthState>,
    provider_id: String,
) -> Result<AuthProviderStatus, String> {
    state.remove(&provider_id)
}
#[tauri::command]
pub fn native_auth_restore(
    state: tauri::State<'_, AuthState>,
    provider_id: String,
    origin: Option<String>,
) -> Result<AuthProviderStatus, String> {
    if let Some(origin) = origin {
        if !PROVIDERS
            .iter()
            .any(|(id, trusted)| *id == provider_id && *trusted == origin)
        {
            state.register_generic_provider(&provider_id, &origin)?;
        }
    }
    state.restore(&provider_id)
}
#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
