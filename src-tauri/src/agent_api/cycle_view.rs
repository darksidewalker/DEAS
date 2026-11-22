//! The read-only cycle state view (API-DESIGN §7.3): `/v1/cycle` is how a dropped
//! caller resumes, so its vocabulary ships with the spine even before the cycle
//! machine exists. With the M4 machine wired, the phase comes from the live cycle
//! cell, and a finished cycle's persisted terminal report rides along — the resume
//! answer a dropped socket reads back.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::guard;

/// Cycle phase words (API-DESIGN §3 state machine).
///
/// The full arm ships with the spine: `/v1/cycle` speaks the vocabulary before the
/// machine exists, so later legs cannot rename a wire word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CyclePhase {
    /// No cycle in flight; the fence is free.
    Idle,
    /// The unload command is running.
    Unloading,
    /// Spooled rows are draining serially.
    Draining,
    /// `/free` is proving the card back.
    Freeing,
    /// The restore command and health poll are running.
    Restoring,
    /// The watchdog sever arm is cancelling and clearing rows (§8.2): the card is
    /// held by the arm, not by a drain leg.
    Severing,
}

/// The live cycle posture read from the [`super::cycle::CycleCell`] by the view
/// readers: phase, minted id, and the persisted terminal report when the last
/// cycle has answered (the dropped-socket resume payload, §7.3).
pub(crate) struct LiveCycle {
    pub(crate) phase: CyclePhase,
    pub(crate) cycle_id: Option<String>,
    pub(crate) report: Option<Value>,
}

impl LiveCycle {
    /// The no-machine posture: idle, nothing minted, nothing persisted.
    #[cfg(test)]
    pub(crate) fn idle() -> Self {
        Self {
            phase: CyclePhase::Idle,
            cycle_id: None,
            report: None,
        }
    }
}

/// What `/v1/cycle` answers: guard posture plus the live phase (and the persisted
/// terminal report once a cycle has answered).
#[derive(Clone, Debug, Serialize)]
pub(crate) struct CycleView {
    /// True only when the guard file exists and validates.
    pub(crate) configured: bool,
    /// The cycle machine's phase; `idle` while no cycle owns the fence.
    pub(crate) phase: CyclePhase,
    /// The live cycle's id, or the last terminal cycle's id.
    #[serde(rename = "cycleId", skip_serializing_if = "Option::is_none")]
    pub(crate) cycle_id: Option<String>,
    /// The persisted terminal batch report of the last cycle (§7.3 resume answer);
    /// absent until a cycle has finished.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) report: Option<Value>,
}

impl CycleView {
    /// Reads the current truth: guard from app-data lazily, cycle posture from the
    /// live cell the plane shares.
    ///
    /// A malformed guard file reports `configured: false` and pushes the reason to the
    /// DEAS log — the plane never pretends the cycle is usable. That posture law lives
    /// in [`guard::posture`] (one home with `/v1/health`), not here.
    pub(crate) fn read(app_data: &Path, live: &LiveCycle) -> Self {
        Self {
            configured: guard::posture(app_data).configured,
            phase: live.phase,
            cycle_id: live.cycle_id.clone(),
            report: live.report.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_guard_reports_not_configured() {
        let dir = tempfile::tempdir().expect("tempdir");
        let view = CycleView::read(dir.path(), &LiveCycle::idle());
        assert!(!view.configured);
        assert_eq!(view.phase, CyclePhase::Idle);
    }

    #[test]
    fn valid_guard_reports_configured() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(guard::FILE),
            r#"{"unloadCommand":"u.bat","restoreCommand":"r.bat",
                "readyUrl":"http://127.0.0.1:18502/health"}"#,
        )
        .expect("test fixture writes guard");
        let view = CycleView::read(dir.path(), &LiveCycle::idle());
        assert!(view.configured);
        assert_eq!(view.phase, CyclePhase::Idle);
    }

    #[test]
    fn malformed_guard_reports_not_configured() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(guard::FILE), "{ not json")
            .expect("test fixture writes guard");
        assert!(!CycleView::read(dir.path(), &LiveCycle::idle()).configured);
    }

    #[test]
    fn live_posture_and_terminal_report_ride_the_view() {
        let dir = tempfile::tempdir().expect("tempdir");
        let live = LiveCycle {
            phase: CyclePhase::Draining,
            cycle_id: Some("cycle-9".to_owned()),
            report: Some(serde_json::json!({ "ok": true, "cycleId": "cycle-9" })),
        };
        let view = CycleView::read(dir.path(), &live);
        assert_eq!(view.phase, CyclePhase::Draining);
        let body = serde_json::to_value(&view).expect("serializable");
        assert_eq!(body["phase"], "draining");
        assert_eq!(body["cycleId"], "cycle-9");
        assert_eq!(body["report"]["cycleId"], "cycle-9");
        // The idle posture serializes neither field: the view stays cheap when empty.
        let empty = serde_json::to_value(CycleView::read(dir.path(), &LiveCycle::idle()))
            .expect("serializable");
        assert!(empty.get("cycleId").is_none());
        assert!(empty.get("report").is_none());
    }

    #[test]
    fn phase_words_serialize_lowercase() {
        let value = serde_json::to_value([
            CyclePhase::Idle,
            CyclePhase::Unloading,
            CyclePhase::Draining,
            CyclePhase::Freeing,
            CyclePhase::Restoring,
            CyclePhase::Severing,
        ])
        .expect("serializable");
        assert_eq!(
            value,
            serde_json::json!([
                "idle",
                "unloading",
                "draining",
                "freeing",
                "restoring",
                "severing"
            ])
        );
    }
}
