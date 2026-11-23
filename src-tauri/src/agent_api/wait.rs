//! The `wait` word validator — shared by every leg that accepts `wait` (generate now,
//! anything later that blocks). Vocabulary is the closed set `{cycle, poll}`.
//!
//! `wait:"none"` (and its alias `"no-wait"`) are retired forever: a pushed row has no
//! status driver and stays `running` unconditionally, which wedged the restore gate. The
//! refusal is by name with its own taxonomy word so a retrying harness cannot mistake it
//! for a value it might rephrase.

use super::errors::{ApiError, ErrorKind};

/// The accepted `wait` modes (API-DESIGN §7.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wait {
    /// Held until the cycle answers — the default.
    Cycle,
    /// 202 immediately with a cycle id; the caller polls.
    Poll,
}

/// Retired forever, refused by name before any other check.
const RETIRED_WORDS: [&str; 2] = ["none", "no-wait"];

/// Parses one `wait` value; absent means [`Wait::Cycle`].
///
/// # Errors
///
/// Refuses the retired names with [`ErrorKind::WaitRetired`] and anything outside the
/// closed vocabulary with [`ErrorKind::WaitUnsupported`].
pub(crate) fn parse_wait(value: Option<&str>) -> Result<Wait, ApiError> {
    let Some(value) = value else {
        return Ok(Wait::Cycle);
    };
    if RETIRED_WORDS.contains(&value) {
        return Err(ApiError::new(ErrorKind::WaitRetired).with_hint(
            "wait:\"none\" is retired forever (pushed rows sit running with no status driver); use \"cycle\" or \"poll\"",
        ));
    }
    match value {
        "cycle" => Ok(Wait::Cycle),
        "poll" => Ok(Wait::Poll),
        other => Err(ApiError::new(ErrorKind::WaitUnsupported).with_hint(format!(
            "wait must be \"cycle\" or \"poll\", got \"{other}\""
        ))),
    }
}

impl Wait {
    /// The wire word for this mode.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Cycle => "cycle",
            Self::Poll => "poll",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_wait_defaults_to_cycle() {
        assert_eq!(parse_wait(None).expect("default"), Wait::Cycle);
    }

    #[test]
    fn closed_vocabulary_is_accepted() {
        assert_eq!(parse_wait(Some("cycle")).expect("cycle"), Wait::Cycle);
        assert_eq!(parse_wait(Some("poll")).expect("poll"), Wait::Poll);
    }

    #[test]
    fn retired_none_is_refused_by_name() {
        let error = parse_wait(Some("none")).expect_err("none is refused");
        assert_eq!(error.body_json()["reason"], "waitRetired");
        assert_eq!(error.body_json()["error"], "WAIT_RETIRED");
    }

    #[test]
    fn retired_no_wait_alias_is_refused_by_name() {
        let error = parse_wait(Some("no-wait")).expect_err("no-wait is refused");
        assert_eq!(error.body_json()["reason"], "waitRetired");
    }

    #[test]
    fn anything_else_is_a_distinct_refusal() {
        for value in ["", "NONE", "wait", "blocking", " true"] {
            let error = parse_wait(Some(value)).expect_err("unknown value refused");
            assert_eq!(
                error.body_json()["reason"],
                "waitUnsupported",
                "value {value:?}"
            );
        }
    }

    #[test]
    fn wire_words_round_trip() {
        assert_eq!(Wait::Cycle.word(), "cycle");
        assert_eq!(Wait::Poll.word(), "poll");
    }
}
