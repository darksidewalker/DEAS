//! The DEAS GitHub repository: open it, read its star count, star it with the saved GitHub token.
//! The repository is compiled in; nothing from the UI selects a URL.
use crate::auth::AuthState;
use reqwest::{header, Method, StatusCode, Url};
use serde::Serialize;

const PAGE: &str = "https://github.com/darksidewalker/DEAS";
const API: &str = "https://api.github.com";
const REPO: &str = "darksidewalker/DEAS";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStars {
    count: u64,
    /// `None` without a saved GitHub token.
    starred: Option<bool>,
}

#[tauri::command]
pub fn native_open_repo() -> Result<(), String> {
    crate::token_page::open_url(PAGE)
}

async fn call(
    state: &AuthState,
    method: Method,
    path: &str,
) -> Result<(reqwest::Response, bool), String> {
    let url = Url::parse(&format!("{API}{path}")).map_err(|e| e.to_string())?;
    let auth = state.authorization("github", &url)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("DEAS")
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .request(method, url)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::CONTENT_LENGTH, "0");
    let authed = auth.is_some();
    if let Some(auth) = auth {
        request = request.header(header::AUTHORIZATION, auth);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "GitHub is unreachable".to_string())?;
    Ok((response, authed))
}

async fn stars(state: &AuthState) -> Result<RepoStars, String> {
    let (response, authed) = call(state, Method::GET, &format!("/repos/{REPO}")).await?;
    if response.status() != StatusCode::OK
        || response.content_length().is_some_and(|n| n > 256 * 1024)
    {
        return Err(format!("GitHub answered {}", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Unexpected GitHub response".to_string())?;
    let count = value["stargazers_count"]
        .as_u64()
        .ok_or("Unexpected GitHub response")?;
    let starred = if authed {
        let (r, _) = call(state, Method::GET, &format!("/user/starred/{REPO}")).await?;
        match r.status() {
            StatusCode::NO_CONTENT => Some(true),
            StatusCode::NOT_FOUND => Some(false),
            _ => None,
        }
    } else {
        None
    };
    Ok(RepoStars { count, starred })
}

#[tauri::command]
pub async fn native_repo_stars(state: tauri::State<'_, AuthState>) -> Result<RepoStars, String> {
    stars(&state).await
}

#[tauri::command]
pub async fn native_repo_star(state: tauri::State<'_, AuthState>) -> Result<RepoStars, String> {
    if state.credential("github", API)?.is_none() {
        return Err("A GitHub token is needed to star".into());
    }
    let (response, _) = call(&state, Method::PUT, &format!("/user/starred/{REPO}")).await?;
    if response.status() != StatusCode::NO_CONTENT {
        return Err(format!("GitHub refused the star ({})", response.status()));
    }
    stars(&state).await
}
