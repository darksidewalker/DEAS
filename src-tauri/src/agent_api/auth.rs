//! The auth wall, in fixed order: Origin allowlist → loopback Host → standing key.
//!
//! Each wall answers its own taxonomy word so an agent can tell which door refused.
//! The key comparison is constant-time over the presented bytes; there is exactly one
//! comparison path and it is this module's.

use axum::http::header::{HOST, ORIGIN};
use axum::http::HeaderMap;

use super::errors::{ApiError, ErrorKind};

/// Header carrying the standing key directly.
pub(crate) const KEY_HEADER: &str = "x-api-key";
/// Alternative: `Authorization: Bearer <key>`.
pub(crate) const AUTH_HEADER: &str = "authorization";

/// Wall 1 — Origin.
///
/// A present Origin must appear verbatim in the allowlist (absent allowlist denies all
/// cross-origin). A missing Origin is tolerated only when a standing key is configured,
/// identifying the caller as a non-browser that must then pass wall 3.
pub(crate) fn check_origin(
    headers: &HeaderMap,
    allowlist: &[String],
    key_configured: bool,
) -> Result<(), ApiError> {
    match headers.get(ORIGIN).and_then(|value| value.to_str().ok()) {
        Some(origin) if allowlist.iter().any(|allowed| allowed == origin) => Ok(()),
        Some(origin) => Err(ApiError::new(ErrorKind::OriginDenied).with_hint(format!(
            "origin '{origin}' is not in the agent settings originAllowlist"
        ))),
        None if key_configured => Ok(()),
        None => Err(ApiError::new(ErrorKind::OriginDenied).with_hint(
            "a request without an Origin header is only accepted when a standingKey is configured",
        )),
    }
}

/// Wall 2 — Host must be a loopback form.
///
/// Structural DNS-rebinding defense: only `127.0.0.1`, `localhost` and `[::1]` (port
/// suffix allowed). The bind is loopback-only regardless; this stops a public hostname
/// resolving at this machine from reaching the plane.
pub(crate) fn check_host(headers: &HeaderMap) -> Result<(), ApiError> {
    let value = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let host = strip_port(value);
    // AF2-M18b WORD-RULE-3: the Host token is case-insensitive (RFC 4343), so the three
    // loopback forms match case-insensitively. The wall stays fail-closed: nothing that
    // is not exactly one of those forms, in any case, gets through.
    let loopback_form = ["127.0.0.1", "localhost", "::1"]
        .iter()
        .any(|form| host.eq_ignore_ascii_case(form));
    if loopback_form {
        Ok(())
    } else {
        Err(ApiError::new(ErrorKind::HostDenied).with_hint(format!(
            "host '{host}' is not a loopback form (127.0.0.1, localhost or [::1])"
        )))
    }
}

/// Splits the host from an optional `:port`, keeping bracketed IPv6 literals intact.
fn strip_port(value: &str) -> &str {
    if let Some(rest) = value.strip_prefix('[') {
        // Bracket form: the literal is between the brackets, the port follows `]`.
        let end = rest.find(']').unwrap_or(rest.len());
        return &rest[..end];
    }
    value.split(':').next().unwrap_or(value)
}

/// Wall 3 — standing key, when configured.
///
/// Accepts `x-api-key: <key>` or `Authorization: Bearer <key>`; compared with
/// [`constant_time_eq`] and nothing else.
pub(crate) fn check_key(headers: &HeaderMap, standing_key: Option<&str>) -> Result<(), ApiError> {
    let Some(expected) = standing_key else {
        return Ok(());
    };
    match presented_key(headers) {
        None => Err(ApiError::new(ErrorKind::KeyMissing).with_hint(
            "send the standing key in the x-api-key header or as an Authorization Bearer token",
        )),
        Some(presented) if constant_time_eq(presented.as_bytes(), expected.as_bytes()) => Ok(()),
        Some(_) => Err(ApiError::new(ErrorKind::KeyInvalid)),
    }
}

/// Extracts the presented key bytes from the accepted header spellings.
fn presented_key(headers: &HeaderMap) -> Option<&str> {
    if let Some(value) = headers
        .get(KEY_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        return Some(value.trim());
    }
    let auth = headers
        .get(AUTH_HEADER)
        .and_then(|value| value.to_str().ok())?;
    let scheme = auth.get(..7)?;
    if !scheme.eq_ignore_ascii_case("bearer ") {
        return None;
    }
    Some(auth.get(7..).unwrap_or("").trim())
}

/// Length- and content-constant key comparison; the only place keys are compared.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut difference = a.len() ^ b.len();
    for index in 0..a.len().max(b.len()) {
        let left = *a.get(index).unwrap_or(&0);
        let right = *b.get(index).unwrap_or(&0);
        difference |= (left ^ right) as usize;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).expect("test header"));
        }
        map
    }

    #[test]
    fn allowlisted_origin_passes() {
        let map = headers(&[("origin", "http://localhost:1420")]);
        let allowlist = ["http://localhost:1420".to_owned()];
        check_origin(&map, &allowlist, false).expect("allowlisted");
    }

    #[test]
    fn foreign_origin_is_denied() {
        let map = headers(&[("origin", "http://evil.example")]);
        let allowlist = ["http://localhost:1420".to_owned()];
        let error = check_origin(&map, &allowlist, false).expect_err("denied");
        assert_eq!(error.body_json()["reason"], "originDenied");
    }

    #[test]
    fn any_origin_is_denied_without_an_allowlist() {
        let map = headers(&[("origin", "http://localhost:1420")]);
        assert!(check_origin(&map, &[], false).is_err());
        assert!(check_origin(&map, &[], true).is_err());
    }

    #[test]
    fn missing_origin_needs_a_configured_key() {
        let map = headers(&[("host", "127.0.0.1:8790")]);
        check_origin(&map, &[], true).expect("non-browser with a key is tolerated");
        let error = check_origin(&map, &[], false).expect_err("anonymous browser refused");
        assert_eq!(error.body_json()["reason"], "originDenied");
    }

    #[test]
    fn loopback_hosts_are_accepted() {
        for host in [
            "127.0.0.1:8790",
            "127.0.0.1",
            "localhost:8790",
            "localhost",
            "[::1]:8790",
        ] {
            let map = headers(&[("host", host)]);
            check_host(&map).unwrap_or_else(|error| panic!("host {host} must pass: {error}"));
        }
    }

    #[test]
    fn the_host_wall_folds_case_because_the_host_token_is_case_insensitive() {
        // AF2-M18b WORD-RULE-3: RFC 4343 case-insensitivity, fail-closed still.
        for host in ["LOCALHOST:8790", "Localhost", "127.0.0.1"] {
            let map = headers(&[("host", host)]);
            check_host(&map).unwrap_or_else(|error| panic!("host {host} must pass: {error}"));
        }
        for host in ["EVIL.EXAMPLE.COM", "LOCALHOST.EVIL", ""] {
            let map = headers(&[("host", host)]);
            let error = check_host(&map).expect_err("host must be denied");
            assert_eq!(error.body_json()["reason"], "hostDenied", "host {host}");
        }
    }

    #[test]
    fn rebinding_and_suffix_hosts_are_denied() {
        for host in [
            "evil.example.com",
            "evil.localhost",
            "127.0.0.1.example.com",
            "",
        ] {
            let map = headers(&[("host", host)]);
            let error = check_host(&map).expect_err("host {host} must be denied");
            assert_eq!(error.body_json()["reason"], "hostDenied", "host {host}");
        }
    }

    #[test]
    fn missing_host_header_is_denied() {
        let map = headers(&[("origin", "http://x")]);
        assert!(check_host(&map).is_err());
    }

    #[test]
    fn no_standing_key_means_the_wall_is_open() {
        let map = headers(&[("host", "127.0.0.1:8790")]);
        check_key(&map, None).expect("unconfigured key wall passes through");
    }

    #[test]
    fn missing_key_is_a_distinct_word() {
        let map = headers(&[("host", "127.0.0.1:8790")]);
        let error = check_key(&map, Some("s3cret")).expect_err("missing");
        assert_eq!(error.body_json()["reason"], "keyMissing");
    }

    #[test]
    fn wrong_key_is_a_distinct_word() {
        let map = headers(&[("host", "127.0.0.1:8790"), ("x-api-key", "wrong")]);
        let error = check_key(&map, Some("s3cret")).expect_err("invalid");
        assert_eq!(error.body_json()["reason"], "keyInvalid");
    }

    #[test]
    fn correct_key_passes_via_x_api_key_and_bearer() {
        let direct = headers(&[("host", "127.0.0.1:8790"), ("x-api-key", "s3cret")]);
        check_key(&direct, Some("s3cret")).expect("x-api-key");
        let bearer = headers(&[
            ("host", "127.0.0.1:8790"),
            ("authorization", "Bearer s3cret"),
        ]);
        check_key(&bearer, Some("s3cret")).expect("bearer");
        let case_bearer = headers(&[
            ("host", "127.0.0.1:8790"),
            ("authorization", "BEARER s3cret"),
        ]);
        check_key(&case_bearer, Some("s3cret")).expect("bearer scheme is case-insensitive");
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"s3cret", b"s3cret"));
        assert!(!constant_time_eq(b"s3creu", b"s3cret"));
        assert!(!constant_time_eq(b"s3cret", b"s3cret9"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }
}
