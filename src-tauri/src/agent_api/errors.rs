//! The closed `/v1` error taxonomy: every refusal is one typed word, one JSON shape.
//!
//! The body is `{ "error": "<CODE>", "reason": "<reasonWord>", "hint": "<optional>",
//! "retryAfterMs": <optional number> }` — the cadence field rides only the answers
//! that ask the caller to come back (the 409 `cycleInFlight` collisions, §10).
//! Reason words follow API-DESIGN §11 (`libraryScanRequired` … `maintenanceActive`) plus
//! the transport/auth words this spine owns. Handlers build an `ApiError` and return it;
//! the single `IntoResponse` path serializes it — no handler hand-rolls an error body.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

/// Every word in the closed `/v1` failure vocabulary.
///
/// The full §11 set is typed here once; later legs raise the domain words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ErrorKind {
    // Transport and auth walls (this leg).
    /// Origin failed the allowlist, or no Origin and no standing key to identify a caller.
    OriginDenied,
    /// Host header is not a loopback form (DNS-rebinding wall).
    HostDenied,
    /// A standing key is configured but the request presented none.
    KeyMissing,
    /// The presented key does not match the configured standing key.
    KeyInvalid,
    /// The lane for this route is at its concurrency cap.
    LaneFull,
    /// No route in the closed index matches method + path.
    RouteNotFound,
    /// The request body was not valid JSON for its route.
    BodyInvalid,
    // `wait` word refusals (API-DESIGN §7.3).
    /// `wait:"none"` / `wait:"no-wait"` are retired forever and refused by name.
    WaitRetired,
    /// `wait` carried a value outside the closed `{cycle, poll}` vocabulary.
    WaitUnsupported,
    // Domain refusals (API-DESIGN §11; wired by later legs, typed here once).
    /// The VRAM cycle commands are unset in the guard file.
    GuardUnconfigured,
    /// Another cycle owns the fence.
    CycleInFlight,
    /// DEAS maintenance (update/move/restart) is holding the plane.
    MaintenanceActive,
    /// The named model is not in the library index; a scan must run first.
    LibraryScanRequired,
    /// The model's family cannot be detected unambiguously.
    FamilyAmbiguous,
    /// The requested mode is ambiguous for this request shape.
    ModeAmbiguous,
    /// The family does not support the requested mode.
    ModeUnsupported,
    /// The turbo shorthand has no variant for this family.
    TurboUnsupported,
    /// A row was severed by the watchdog.
    JobWedged,
    /// A row's state could not be correlated; submits stay blocked.
    JobUnknown,
    /// Restore retries exhausted; operator recovery required.
    RestoreExhausted,
    /// The unload bat (the cycle's handoff leg) exited non-zero: the card never went
    /// down, so the fence released, the spool stayed intact and the retry is safe
    /// under key idempotency (§10 row `unload bat non-zero exit`; manager-ruled word).
    HandoffFailed,
    /// A stock prepare/prereq/allowlist refusal reached AFTER admission (LEG M12,
    /// manager-ruled word): the intent is compile-valid on our side, but the live
    /// backend's prepare leg will not run it. The word rides the terminal report's
    /// row error beside the stock string verbatim — the row itself stays failed and
    /// submit_failed, exactly as the free-form detail always did.
    PrepareRefused,
    /// The spool holds [`crate::agent_api::spool::CAP`] live rows; queue refused
    /// (LEG M12, red-team W5, owner-approved). The hint names the cap and both
    /// remedies: drain the batch or clear the queued rows.
    SpoolFull,
    /// A queue body named an input placement reference that is absent from the
    /// input plane on disk (LEG MEDIA-1, owner ruling E21 EXISTENCE LAW): no job
    /// enters the spool while any input reference it names is missing. The hint
    /// names every missing reference.
    InputMissing,
    /// A byte crossing the network (or leaving the process through a byte door)
    /// breached a configured cap from the guard file's `caps` block (LEG MEDIA-1,
    /// owner ruling E21: caps are NETWORK caps). The canonical status is 413 —
    /// the upload walls are the word's home; the on-disk byte doors answer 409
    /// through [`ApiError::with_status`], because there the payload is already
    /// on disk and the remedy is the guard-file cap, not a smaller request.
    CapExceeded,
}

/// All taxonomy members; keeps the enum closed and drives the errors surface.
pub(crate) const ALL_KINDS: [ErrorKind; 25] = [
    ErrorKind::OriginDenied,
    ErrorKind::HostDenied,
    ErrorKind::KeyMissing,
    ErrorKind::KeyInvalid,
    ErrorKind::LaneFull,
    ErrorKind::RouteNotFound,
    ErrorKind::BodyInvalid,
    ErrorKind::WaitRetired,
    ErrorKind::WaitUnsupported,
    ErrorKind::GuardUnconfigured,
    ErrorKind::CycleInFlight,
    ErrorKind::MaintenanceActive,
    ErrorKind::LibraryScanRequired,
    ErrorKind::FamilyAmbiguous,
    ErrorKind::ModeAmbiguous,
    ErrorKind::ModeUnsupported,
    ErrorKind::TurboUnsupported,
    ErrorKind::JobWedged,
    ErrorKind::JobUnknown,
    ErrorKind::RestoreExhausted,
    ErrorKind::HandoffFailed,
    ErrorKind::PrepareRefused,
    ErrorKind::SpoolFull,
    ErrorKind::InputMissing,
    ErrorKind::CapExceeded,
];

impl ErrorKind {
    /// The camelCase reason word carried in the JSON body.
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::OriginDenied => "originDenied",
            Self::HostDenied => "hostDenied",
            Self::KeyMissing => "keyMissing",
            Self::KeyInvalid => "keyInvalid",
            Self::LaneFull => "laneFull",
            Self::RouteNotFound => "routeNotFound",
            Self::BodyInvalid => "bodyInvalid",
            Self::WaitRetired => "waitRetired",
            Self::WaitUnsupported => "waitUnsupported",
            Self::GuardUnconfigured => "guardUnconfigured",
            Self::CycleInFlight => "cycleInFlight",
            Self::MaintenanceActive => "maintenanceActive",
            Self::LibraryScanRequired => "libraryScanRequired",
            Self::FamilyAmbiguous => "familyAmbiguous",
            Self::ModeAmbiguous => "modeAmbiguous",
            Self::ModeUnsupported => "modeUnsupported",
            Self::TurboUnsupported => "turboUnsupported",
            Self::JobWedged => "jobWedged",
            Self::JobUnknown => "jobUnknown",
            Self::RestoreExhausted => "restoreExhausted",
            Self::HandoffFailed => "handoffFailed",
            Self::PrepareRefused => "prepareRefused",
            Self::SpoolFull => "spoolFull",
            Self::InputMissing => "inputMissing",
            Self::CapExceeded => "capExceeded",
        }
    }

    /// The stable SCREAMING code paired with the reason word.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::OriginDenied => "ORIGIN_DENIED",
            Self::HostDenied => "HOST_DENIED",
            Self::KeyMissing => "KEY_MISSING",
            Self::KeyInvalid => "KEY_INVALID",
            Self::LaneFull => "LANE_FULL",
            Self::RouteNotFound => "ROUTE_NOT_FOUND",
            Self::BodyInvalid => "BODY_INVALID",
            Self::WaitRetired => "WAIT_RETIRED",
            Self::WaitUnsupported => "WAIT_UNSUPPORTED",
            Self::GuardUnconfigured => "GUARD_UNCONFIGURED",
            Self::CycleInFlight => "CYCLE_IN_FLIGHT",
            Self::MaintenanceActive => "MAINTENANCE_ACTIVE",
            Self::LibraryScanRequired => "LIBRARY_SCAN_REQUIRED",
            Self::FamilyAmbiguous => "FAMILY_AMBIGUOUS",
            Self::ModeAmbiguous => "MODE_AMBIGUOUS",
            Self::ModeUnsupported => "MODE_UNSUPPORTED",
            Self::TurboUnsupported => "TURBO_UNSUPPORTED",
            Self::JobWedged => "JOB_WEDGED",
            Self::JobUnknown => "JOB_UNKNOWN",
            Self::RestoreExhausted => "RESTORE_EXHAUSTED",
            Self::HandoffFailed => "HANDOFF_FAILED",
            Self::PrepareRefused => "PREPARE_REFUSED",
            Self::SpoolFull => "SPOOL_FULL",
            Self::InputMissing => "INPUT_MISSING",
            Self::CapExceeded => "CAP_EXCEEDED",
        }
    }

    /// HTTP status paired with the word, per API-DESIGN (§3 refusals 422, §7.2/§3 fence
    /// refusals 409, §8.4 exhaustion 503, §8.2 sever 500).
    pub(crate) fn status(self) -> StatusCode {
        match self {
            Self::OriginDenied => StatusCode::FORBIDDEN,
            Self::HostDenied => StatusCode::BAD_REQUEST,
            Self::KeyMissing | Self::KeyInvalid => StatusCode::UNAUTHORIZED,
            Self::LaneFull => StatusCode::TOO_MANY_REQUESTS,
            Self::RouteNotFound => StatusCode::NOT_FOUND,
            Self::BodyInvalid | Self::WaitRetired | Self::WaitUnsupported => {
                StatusCode::BAD_REQUEST
            }
            Self::GuardUnconfigured | Self::CycleInFlight | Self::HandoffFailed => {
                StatusCode::CONFLICT
            }
            Self::MaintenanceActive | Self::JobUnknown | Self::RestoreExhausted => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            Self::LibraryScanRequired
            | Self::FamilyAmbiguous
            | Self::ModeAmbiguous
            | Self::ModeUnsupported
            | Self::TurboUnsupported
            // A compile-valid intent the live backend refuses to run is the same
            // 422 intent-refusal class; it rides the report row, never a door body.
            | Self::PrepareRefused => StatusCode::UNPROCESSABLE_ENTITY,
            // The queue-cap refusal is a fence-class 409: the remedy is to take
            // rows OUT of the spool, not to change the request.
            Self::SpoolFull => StatusCode::CONFLICT,
            // An input reference the queue named is an intent-class 422: the
            // remedy lives in the request (place the file, or drop the reference).
            Self::InputMissing => StatusCode::UNPROCESSABLE_ENTITY,
            // The canonical home of the cap word is the upload wall: bytes that
            // arrived over the network past a configured cap. The byte doors
            // re-state it as 409 via `ApiError::with_status` (the payload is
            // already on disk; the remedy is the guard-file cap).
            Self::CapExceeded => StatusCode::PAYLOAD_TOO_LARGE,
            Self::JobWedged => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// One `/v1` refusal: a taxonomy word, an optional operator-actionable hint, and an
/// optional retry cadence (`retryAfterMs`) for the answers that invite a retry.
#[derive(Clone, Debug)]
pub(crate) struct ApiError {
    kind: ErrorKind,
    hint: Option<String>,
    retry_after_ms: Option<u64>,
    /// A per-answer status override for the words whose HTTP pairing depends on
    /// the door, not the taxonomy: `capExceeded` answers 413 at the upload walls
    /// (bytes arriving) and 409 at the byte doors (the payload is already on
    /// disk).
    status_override: Option<StatusCode>,
}

impl ApiError {
    /// Builds a refusal from the closed taxonomy.
    pub(crate) fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            hint: None,
            retry_after_ms: None,
            status_override: None,
        }
    }

    /// Re-states the answer under a different HTTP status while keeping the
    /// taxonomy word, code and body shape exactly. The ONE home for the door-
    /// dependent pairing (LEG MEDIA-1: `capExceeded` 409 at the on-disk byte
    /// doors vs the word's canonical 413); no handler hand-rolls a status.
    pub(crate) fn with_status(self, status: StatusCode) -> Self {
        Self {
            kind: self.kind,
            hint: self.hint,
            retry_after_ms: self.retry_after_ms,
            status_override: Some(status),
        }
    }

    /// Attaches the hint carried beside the word.
    pub(crate) fn with_hint(self, hint: impl Into<String>) -> Self {
        Self {
            kind: self.kind,
            hint: Some(hint.into()),
            retry_after_ms: self.retry_after_ms,
            status_override: self.status_override,
        }
    }

    /// Attaches the numeric `retryAfterMs` cadence: when the caller should come back.
    /// Only the `cycleInFlight` collision answers carry it (§10 double-generate row);
    /// no other answer grows the field.
    pub(crate) fn with_retry_after_ms(self, millis: u64) -> Self {
        Self {
            kind: self.kind,
            hint: self.hint,
            retry_after_ms: Some(millis),
            status_override: self.status_override,
        }
    }

    /// The taxonomy word this refusal carries. The bench doors read it to keep
    /// the wall/row boundary honest: a `bodyInvalid` from the shared
    /// containment wall hoists to the call, a `routeNotFound` becomes a row.
    #[must_use]
    pub(crate) const fn kind(&self) -> ErrorKind {
        self.kind
    }

    /// The JSON body for this refusal: `{ error, reason, hint?, retryAfterMs? }`.
    pub(crate) fn body_json(&self) -> Value {
        let mut body = json!({ "error": self.kind.code(), "reason": self.kind.reason() });
        if let Some(hint) = &self.hint {
            body["hint"] = Value::String(hint.clone());
        }
        if let Some(millis) = self.retry_after_ms {
            body["retryAfterMs"] = json!(millis);
        }
        body
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.kind.reason())
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status_override.unwrap_or_else(|| self.kind.status());
        (status, axum::Json(self.body_json())).into_response()
    }
}

/// `GET /v1/errors` — the closed taxonomy served from its single home.
///
/// Iterates [`ALL_KINDS`]; the response cannot drift from the enum because there is
/// no second word list anywhere in the plane.
pub(crate) async fn errors_surface() -> axum::Json<Value> {
    let mut kinds = Vec::with_capacity(ALL_KINDS.len());
    for kind in ALL_KINDS {
        kinds.push(json!({
            "reason": kind.reason(),
            "code": kind.code(),
            "status": kind.status().as_u16(),
        }));
    }
    axum::Json(json!({ "ok": true, "count": ALL_KINDS.len(), "kinds": kinds }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn reason_words_are_unique() {
        let words: HashSet<&str> = ALL_KINDS.iter().map(|kind| kind.reason()).collect();
        assert_eq!(words.len(), ALL_KINDS.len());
    }

    #[test]
    fn codes_are_unique() {
        let codes: HashSet<&str> = ALL_KINDS.iter().map(|kind| kind.code()).collect();
        assert_eq!(codes.len(), ALL_KINDS.len());
    }

    #[test]
    fn every_kind_maps_to_a_client_or_server_status() {
        for kind in ALL_KINDS {
            assert!(
                kind.status().is_client_error() || kind.status().is_server_error(),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn design_11_words_are_all_present() {
        for word in [
            "libraryScanRequired",
            "modeAmbiguous",
            "modeUnsupported",
            "familyAmbiguous",
            "guardUnconfigured",
            "turboUnsupported",
            "jobWedged",
            "jobUnknown",
            "restoreExhausted",
            "cycleInFlight",
            "maintenanceActive",
        ] {
            assert!(
                ALL_KINDS.iter().any(|kind| kind.reason() == word),
                "missing §11 word {word}"
            );
        }
    }

    #[test]
    fn the_leg_m12_words_land_in_the_closed_taxonomy() {
        // prepareRefused rides the report row's structured error; spoolFull is the
        // queue door's cap refusal. Both are enum members, so the surface and the
        // OpenAPI enums auto-ride — no second word list to update.
        assert_eq!(ErrorKind::PrepareRefused.reason(), "prepareRefused");
        assert_eq!(ErrorKind::PrepareRefused.code(), "PREPARE_REFUSED");
        assert_eq!(
            ErrorKind::PrepareRefused.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "the intent-refusal 422 class: compile-valid, backend-refused"
        );
        assert_eq!(ErrorKind::SpoolFull.reason(), "spoolFull");
        assert_eq!(ErrorKind::SpoolFull.code(), "SPOOL_FULL");
        assert_eq!(
            ErrorKind::SpoolFull.status(),
            StatusCode::CONFLICT,
            "the remedy lives outside the request: drain or clear"
        );
        for kind in [ErrorKind::PrepareRefused, ErrorKind::SpoolFull] {
            assert!(ALL_KINDS.contains(&kind), "{kind:?} is a member");
        }
    }

    #[test]
    fn the_leg_media_1_words_land_in_the_closed_taxonomy() {
        // EXISTENCE LAW + the configurable network caps (owner ruling E21). Both
        // words are enum members, so /v1/errors and the OpenAPI enums auto-ride.
        assert_eq!(ErrorKind::InputMissing.reason(), "inputMissing");
        assert_eq!(ErrorKind::InputMissing.code(), "INPUT_MISSING");
        assert_eq!(
            ErrorKind::InputMissing.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "the intent-class 422: the remedy lives in the request"
        );
        assert_eq!(ErrorKind::CapExceeded.reason(), "capExceeded");
        assert_eq!(ErrorKind::CapExceeded.code(), "CAP_EXCEEDED");
        assert_eq!(
            ErrorKind::CapExceeded.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "the upload wall (bytes arriving) is the word's canonical home"
        );
        for kind in [ErrorKind::InputMissing, ErrorKind::CapExceeded] {
            assert!(ALL_KINDS.contains(&kind), "{kind:?} is a member");
        }
        // The byte-door re-state: same word, same body, 409 under the override.
        let response = ApiError::new(ErrorKind::CapExceeded)
            .with_hint("the file is already on disk")
            .with_status(StatusCode::CONFLICT)
            .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn body_shape_without_hint_is_error_and_reason_only() {
        let body = ApiError::new(ErrorKind::RouteNotFound).body_json();
        assert_eq!(body["error"], "ROUTE_NOT_FOUND");
        assert_eq!(body["reason"], "routeNotFound");
        assert_eq!(body.as_object().expect("object").len(), 2);
    }

    #[test]
    fn body_shape_carries_hint_when_set() {
        let body = ApiError::new(ErrorKind::KeyMissing)
            .with_hint("send x-api-key")
            .body_json();
        assert_eq!(body["hint"], "send x-api-key");
    }

    #[test]
    fn retry_after_ms_rides_only_the_answers_that_set_it() {
        // The closed shape grows to {error, reason, hint?, retryAfterMs?}: the field
        // is numeric and appears ONLY on an answer built with the cadence setter.
        let body = ApiError::new(ErrorKind::CycleInFlight)
            .with_hint("poll GET /v1/cycle")
            .with_retry_after_ms(2_000)
            .body_json();
        assert!(
            body["retryAfterMs"].is_number(),
            "numeric, not a string: {body}"
        );
        assert_eq!(body["retryAfterMs"], 2_000);
        // Nothing else grows it: the same word without the setter, and every other
        // word, keep the {error, reason, hint?} shape exactly.
        let plain = ApiError::new(ErrorKind::CycleInFlight).body_json();
        assert!(plain.get("retryAfterMs").is_none(), "{plain}");
        let other = ApiError::new(ErrorKind::MaintenanceActive)
            .with_hint("operator attention")
            .body_json();
        assert!(other.get("retryAfterMs").is_none(), "{other}");
    }

    #[test]
    fn status_words_match_the_design_contract() {
        assert_eq!(ErrorKind::KeyMissing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(ErrorKind::OriginDenied.status(), StatusCode::FORBIDDEN);
        assert_eq!(ErrorKind::LaneFull.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(ErrorKind::CycleInFlight.status(), StatusCode::CONFLICT);
        assert_eq!(
            ErrorKind::RestoreExhausted.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            ErrorKind::JobWedged.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            ErrorKind::HandoffFailed.status(),
            StatusCode::CONFLICT,
            "the §10 unload-fault word rides the fence/refusal 409 class"
        );
    }
}
