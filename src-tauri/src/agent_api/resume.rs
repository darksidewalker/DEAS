//! The restore-watch posture for `GET /v1/resume` (API-DESIGN §7.4, §8.4).
//!
//! Seven-state OPERATOR vocabulary, closed by serde so the wire cannot be renamed
//! later: `notWatched | probing | settling | ready | failed | unconfigured |
//! debtOutstanding`. For the AGENT contract the release fact still rides the
//! generate answer itself (`modelRestored:true`); this door is the posture an
//! operator (or a resuming harness) reads before any further call, per the
//! dropped-socket law (§7.3).
//!
//! The derivation is a pure function over facts the route collects: the guard's
//! readiness URL, the live cell phase, the last persisted terminal report, and (for
//! the restore legs only) one health probe. The probe runs through the SAME shipped
//! [`super::cycle::HealthProbe`] seam the cycle machine uses — the plane never
//! invents a second prober — and the watch gates it to at most one probe per
//! [`super::cycle::HEALTH_PROBE_GAP_MS`], reusing the fresh fact inside the window.
//!
//! The settle window ships at zero (E5's dial): `ready` answers the moment the
//! healthy fact lands. `settling` is unreachable at a zero window but the word
//! ships now so the vocabulary is final on the wire; if E5 ever dials the window
//! up, a healthy fact younger than it answers `settling` without any rename.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use super::cycle::{HealthProbe, HEALTH_PROBE_GAP_MS};
use super::cycle_view::CyclePhase;
use super::spool::now_ms;

/// E5's dial, shipped at 0: a healthy fact lands `ready` immediately. Raising the
/// window makes healthy-but-young facts answer `settling` (the word ships with the
/// zero window so the seven-state vocabulary can never be renamed later).
pub(crate) const READY_SETTLE_MS: u64 = 0;

/// The seven-state operator posture vocabulary (§7.4). Serde-closed: the wire
/// words are the enum, pinned by test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ResumeState {
    /// No cycle has ever run here: no persisted report and the cell has never
    /// claimed (watch stands down until the first cycle).
    NotWatched,
    /// A restore (or the pre-restore legs) is in flight and the watch has no
    /// healthy fact yet; the caller polls again at the cadence.
    Probing,
    /// A healthy fact landed but is younger than the settle window (unreachable
    /// at [`READY_SETTLE_MS`] = 0; the word ships for the E5 dial).
    Settling,
    /// The model is up: a fresh healthy probe, or the last terminal report's
    /// `modelRestored:true` while the cell is idle (last-known-fact, watch stands
    /// down between watches — the af-01 D5 law).
    Ready,
    /// Automatic restore STOPPED (§8.4 exhaustion): the last report's fault is
    /// `restoreExhausted`. Recovery is operator-side; the next batch's cycle
    /// re-arms the debt.
    Failed,
    /// No readiness URL to watch (guard absent, invalid, or `readyUrl` empty):
    /// there is no target, so there is no posture to hold.
    Unconfigured,
    /// A restore is owed: the last terminal report says `modelRestored:false`
    /// without exhaustion; the next cycle re-arms restore.
    DebtOutstanding,
}

/// One probe reading the route hands the derivation: the health answer plus how
/// old the fact is (a cached fact inside the cadence window rides its age).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ProbeFact {
    pub(crate) healthy: bool,
    pub(crate) age_ms: u64,
}

/// The pure derivation (§7.4 + §8.4), over fake seams in tests:
///
/// 1. empty readiness URL — `unconfigured` (no target exists to probe);
/// 2. live restore legs (`freeing`/`restoring`) — the probe answer: healthy lands
///    `ready` (or `settling` inside the window), unhealthy/absent is `probing`;
/// 3. any other live phase (`unloading`/`draining`/`severing`) — `probing`: the
///    watch has not reached the restore leg, the model is down by design, and the
///    probe budget stays untouched for the leg that can honestly answer;
/// 4. idle cell with a persisted report — the fault-first order: `restoreExhausted`
///    is `failed`, else `modelRestored:false` is `debtOutstanding`, else
///    `modelRestored:true` is `ready` (last-known fact, no probe), and a report
///    that proves neither keeps the honest debt posture;
/// 5. idle cell with no report and no cycle identity — `notWatched` (never a
///    restore since boot: the cell mints its identity on the first claim and boots
///    with the persisted report when one exists, so this trio is exactly the
///    three-way conjunction §7.4 names).
#[must_use]
pub(crate) fn posture(
    ready_url: &str,
    phase: CyclePhase,
    report: Option<&Value>,
    probe: Option<ProbeFact>,
    settle_ms: u64,
) -> ResumeState {
    if ready_url.trim().is_empty() {
        return ResumeState::Unconfigured;
    }
    match phase {
        CyclePhase::Freeing | CyclePhase::Restoring => match probe {
            Some(fact) if fact.healthy => {
                if fact.age_ms < settle_ms {
                    ResumeState::Settling
                } else {
                    ResumeState::Ready
                }
            }
            _ => ResumeState::Probing,
        },
        CyclePhase::Unloading | CyclePhase::Draining | CyclePhase::Severing => ResumeState::Probing,
        CyclePhase::Idle => match report {
            Some(report) => {
                // §8.4: exhaustion first — automatic restore stopped, the debt
                // stays visible but the word that rules the posture is the fault.
                if report.pointer("/fault/reason").and_then(Value::as_str)
                    == Some(super::cycle::FAULT_RESTORE)
                {
                    return ResumeState::Failed;
                }
                match report.get("modelRestored").and_then(Value::as_bool) {
                    Some(true) => ResumeState::Ready,
                    // An owed restore — and a persisted report that never proves
                    // the restore landed — both keep the debt posture.
                    _ => ResumeState::DebtOutstanding,
                }
            }
            None => ResumeState::NotWatched,
        },
    }
}

/// The `retryAfterMs` promise per posture: the watching postures carry the shipped
/// poll cadence ([`super::cycle::CYCLE_RETRY_AFTER_MS`], same home the 409
/// collision answers cite — one cadence const, §7.3's 1–2 s promise).
#[must_use]
pub(crate) fn retry_after_ms(state: ResumeState) -> Option<u64> {
    match state {
        ResumeState::Probing | ResumeState::DebtOutstanding | ResumeState::Failed => {
            Some(super::cycle::CYCLE_RETRY_AFTER_MS)
        }
        _ => None,
    }
}

/// The operator-facing hint per posture (optional wire field).
#[must_use]
pub(crate) fn hint(state: ResumeState) -> Option<&'static str> {
    match state {
        ResumeState::Unconfigured => Some(
            "no readiness target: write deas-agent-guard.json with a readyUrl (the watch has nothing to probe)",
        ),
        ResumeState::Failed => Some(
            "automatic restore stopped after exhaustion (8.4): fix the restore command or the engine state, restore from the panel, or let the next batch's cycle re-arm the debt",
        ),
        ResumeState::DebtOutstanding => Some(
            "a model restore is owed from the last cycle; the next cycle re-arms restore",
        ),
        ResumeState::NotWatched => Some(
            "no cycle has run since boot: GET /v1/generate starts the first, and the watch picks it up",
        ),
        ResumeState::Probing => Some("a cycle holds the card; the restore watch has no healthy fact yet"),
        ResumeState::Settling => Some("the readiness target answered; the settle window is still open"),
        ResumeState::Ready => None,
    }
}

/// The plane's restore watch: the shared health seam plus the ≤1-per-cadence gate.
/// One instance per plane ([`super::PlaneState`]); the gate is an async mutex so
/// concurrent resume reads serialize on the probe instead of stacking probes
/// (strictly ≤1 per [`HEALTH_PROBE_GAP_MS`], and a waiting read reuses the fact
/// the in-flight probe just cached).
pub(crate) struct ResumeWatch {
    health: Arc<dyn HealthProbe>,
    gate: tokio::sync::Mutex<Option<(u64, bool)>>,
}

impl ResumeWatch {
    /// Points the watch at the plane's one shipped prober.
    pub(crate) fn new(health: Arc<dyn HealthProbe>) -> Self {
        Self {
            health,
            gate: tokio::sync::Mutex::new(None),
        }
    }

    /// The cadence-gated probe: a fact fresher than the gap is reused with its
    /// age; otherwise exactly one probe runs and is cached with its stamp.
    pub(crate) async fn probe(&self, url: &str) -> ProbeFact {
        let mut gate = self.gate.lock().await;
        let now = now_ms();
        if let Some((at_ms, healthy)) = gate.as_ref() {
            if now.saturating_sub(*at_ms) < HEALTH_PROBE_GAP_MS {
                return ProbeFact {
                    healthy: *healthy,
                    age_ms: now.saturating_sub(*at_ms),
                };
            }
        }
        let healthy = self.health.probe(url).await;
        let stamped_at = now_ms();
        *gate = Some((stamped_at, healthy));
        ProbeFact { healthy, age_ms: 0 }
    }
}

/// A counting scripted prober for the cadence laws and the plane-level tests
/// (test-only; mirrors the cycle module's fake-seam style, records every probe).
#[cfg(test)]
pub(crate) struct ScriptProbe {
    postures: std::sync::Mutex<std::collections::VecDeque<bool>>,
    fallback: bool,
    calls: std::sync::atomic::AtomicU32,
}

#[cfg(test)]
impl ScriptProbe {
    pub(crate) fn always(healthy: bool) -> Self {
        Self {
            postures: std::sync::Mutex::new(std::collections::VecDeque::new()),
            fallback: healthy,
            calls: std::sync::atomic::AtomicU32::new(0),
        }
    }

    pub(crate) fn scripted(postures: Vec<bool>, fallback: bool) -> Self {
        Self {
            postures: std::sync::Mutex::new(postures.into()),
            fallback,
            calls: std::sync::atomic::AtomicU32::new(0),
        }
    }

    pub(crate) fn probes(&self) -> u32 {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
impl HealthProbe for ScriptProbe {
    fn probe(&self, _url: &str) -> futures_util::future::BoxFuture<'static, bool> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let answer = self
            .postures
            .lock()
            .expect("probe script")
            .pop_front()
            .unwrap_or(self.fallback);
        Box::pin(async move { answer })
    }
}

#[cfg(test)]
impl ResumeWatch {
    /// Test-only kit: the watch over a scripted prober (the plane wires the
    /// shipped cycle seam; tests name the posture they need).
    pub(crate) fn scripted_for_tests(health: Arc<dyn HealthProbe>) -> Self {
        Self {
            health,
            gate: tokio::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const URL: &str = "http://127.0.0.1:18502/health";

    fn report(model_restored: bool, fault: Option<&str>) -> Value {
        let mut body = json!({
            "ok": !fault.is_some(),
            "cycleId": "cycle-seed",
            "modelRestored": model_restored,
            "rows": [],
        });
        if let Some(reason) = fault {
            body["fault"] = json!({ "reason": reason, "detail": "test fixture" });
        }
        body
    }

    #[test]
    fn the_seven_state_vocabulary_is_closed_on_the_wire() {
        let words = serde_json::to_value([
            ResumeState::NotWatched,
            ResumeState::Probing,
            ResumeState::Settling,
            ResumeState::Ready,
            ResumeState::Failed,
            ResumeState::Unconfigured,
            ResumeState::DebtOutstanding,
        ])
        .expect("serializable");
        assert_eq!(
            words,
            json!([
                "notWatched",
                "probing",
                "settling",
                "ready",
                "failed",
                "unconfigured",
                "debtOutstanding"
            ]),
            "the seven operator words, pinned (§7.4)"
        );
    }

    #[test]
    fn empty_ready_url_answers_unconfigured_before_anything_else() {
        // Even a failed posture under an exhausted restore cannot name a target
        // that does not exist: the config wall runs first.
        let derived = posture(
            "  ",
            CyclePhase::Idle,
            Some(&report(false, Some(super::super::cycle::FAULT_RESTORE))),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(derived, ResumeState::Unconfigured);
    }

    #[test]
    fn exhausted_restore_report_answers_failed() {
        // §8.4: automatic restore stopped, the debt stays owed underneath.
        let derived = posture(
            URL,
            CyclePhase::Idle,
            Some(&report(false, Some(super::super::cycle::FAULT_RESTORE))),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(derived, ResumeState::Failed);
    }

    #[test]
    fn owed_restore_answers_debt_outstanding() {
        let derived = posture(
            URL,
            CyclePhase::Idle,
            Some(&report(false, None)),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(derived, ResumeState::DebtOutstanding);
        // A fault that is not exhaustion (an ordinary cycle fault) with the model
        // still down keeps the debt posture, never `failed`.
        let with_cycle_fault = posture(
            URL,
            CyclePhase::Idle,
            Some(&report(false, Some(super::super::cycle::FAULT_CYCLE))),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(with_cycle_fault, ResumeState::DebtOutstanding);
    }

    #[test]
    fn a_cause_skipped_restore_report_stays_in_debt() {
        // W3-2 (LEG AF2-M21a), the resume half of the cause-aware end legs: a
        // queue-live idle-proof fault persists exactly this shape — an ordinary
        // cycle fault (NOT exhaustion) with modelRestored:false and the cardAtRisk
        // flag. The debt law is unchanged and this names it: debtOutstanding,
        // never ready (the model is down), never failed (restore did not
        // exhaust — it was correctly skipped beside a live queue).
        let queue_live = json!({
            "ok": false,
            "cycleId": "cycle-queue-live",
            "modelRestored": false,
            "cardAtRisk": true,
            "fault": {
                "reason": super::super::cycle::FAULT_CYCLE,
                "detail": "backend idle proof failed after the drain while the backend was still answering (queueLive: scripted)"
            },
        });
        let derived = posture(
            URL,
            CyclePhase::Idle,
            Some(&queue_live),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(derived, ResumeState::DebtOutstanding);
    }

    #[test]
    fn restored_last_fact_answers_ready_without_a_probe() {
        // The af-01 D5 law: watch stands down between watches — the last terminal
        // report's healthy fact is enough while the cell is idle.
        let derived = posture(
            URL,
            CyclePhase::Idle,
            Some(&report(true, None)),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(derived, ResumeState::Ready);
    }

    #[test]
    fn a_report_that_never_proves_the_restore_keeps_the_debt() {
        let malformed = json!({ "ok": true, "cycleId": "cycle-seed" });
        let derived = posture(
            URL,
            CyclePhase::Idle,
            Some(&malformed),
            None,
            READY_SETTLE_MS,
        );
        assert_eq!(derived, ResumeState::DebtOutstanding);
    }

    #[test]
    fn no_report_and_never_a_cycle_answers_not_watched() {
        let derived = posture(URL, CyclePhase::Idle, None, None, READY_SETTLE_MS);
        assert_eq!(derived, ResumeState::NotWatched);
    }

    #[test]
    fn restore_legs_answer_on_the_probe_fact() {
        for phase in [CyclePhase::Freeing, CyclePhase::Restoring] {
            let healthy = posture(
                URL,
                phase,
                Some(&report(true, None)),
                Some(ProbeFact {
                    healthy: true,
                    age_ms: 0,
                }),
                READY_SETTLE_MS,
            );
            assert_eq!(
                healthy,
                ResumeState::Ready,
                "{phase:?} with a healthy probe"
            );
            let down = posture(
                URL,
                phase,
                Some(&report(true, None)),
                Some(ProbeFact {
                    healthy: false,
                    age_ms: 0,
                }),
                READY_SETTLE_MS,
            );
            assert_eq!(
                down,
                ResumeState::Probing,
                "{phase:?} with an unhealthy probe"
            );
            let no_probe = posture(URL, phase, Some(&report(true, None)), None, READY_SETTLE_MS);
            assert_eq!(no_probe, ResumeState::Probing, "{phase:?} with no fact yet");
        }
    }

    #[test]
    fn pre_restore_legs_answer_probing_without_a_probe() {
        // Unloading/Draining/Severing: the model is down by design and the probe
        // budget waits for the leg that can honestly answer.
        for phase in [
            CyclePhase::Unloading,
            CyclePhase::Draining,
            CyclePhase::Severing,
        ] {
            let derived = posture(URL, phase, Some(&report(true, None)), None, READY_SETTLE_MS);
            assert_eq!(derived, ResumeState::Probing, "{phase:?}");
        }
    }

    #[test]
    fn settling_ships_behind_the_zero_e5_window() {
        // The const ships at 0 — so `settling` is unreachable on the wire today —
        // but the word and the derivation branch exist so a dialed window never
        // needs a rename. The pure fn takes the window as a fact for exactly this.
        assert_eq!(READY_SETTLE_MS, 0, "E5's dial, shipped at zero");
        let at_zero = posture(
            URL,
            CyclePhase::Restoring,
            None,
            Some(ProbeFact {
                healthy: true,
                age_ms: 0,
            }),
            READY_SETTLE_MS,
        );
        assert_eq!(
            at_zero,
            ResumeState::Ready,
            "zero window: healthy lands ready"
        );
        let dialed = posture(
            URL,
            CyclePhase::Restoring,
            None,
            Some(ProbeFact {
                healthy: true,
                age_ms: 999,
            }),
            5_000,
        );
        assert_eq!(
            dialed,
            ResumeState::Settling,
            "dialed window: young fact settles"
        );
    }

    #[test]
    fn watching_postures_carry_the_cadence_const() {
        for state in [
            ResumeState::Probing,
            ResumeState::DebtOutstanding,
            ResumeState::Failed,
        ] {
            assert_eq!(
                retry_after_ms(state),
                Some(super::super::cycle::CYCLE_RETRY_AFTER_MS),
                "{state:?} carries the 2 000 ms promise"
            );
        }
        for state in [
            ResumeState::Ready,
            ResumeState::Settling,
            ResumeState::NotWatched,
            ResumeState::Unconfigured,
        ] {
            assert_eq!(
                retry_after_ms(state),
                None,
                "{state:?} makes no retry promise"
            );
        }
    }

    /// Cadence law over the shared scripted prober.
    #[tokio::test]
    async fn the_watch_probes_at_most_once_per_cadence_window() {
        let prober = Arc::new(ScriptProbe::scripted(vec![true], false));
        let watch = ResumeWatch::new(Arc::clone(&prober) as Arc<dyn HealthProbe>);
        let first = watch.probe(URL).await;
        assert!(first.healthy, "the scripted fact lands");
        assert_eq!(first.age_ms, 0, "a fresh fact is zero-aged");
        // Two immediate re-reads ride the cached fact: still ONE probe on the seam.
        let second = watch.probe(URL).await;
        let third = watch.probe(URL).await;
        assert!(second.healthy && third.healthy, "the fact is reused");
        assert_eq!(
            prober.probes(),
            1,
            "≤1 probe per HEALTH_PROBE_GAP_MS window"
        );
    }

    #[tokio::test]
    async fn concurrent_reads_share_one_probe_never_stack_them() {
        let prober = Arc::new(ScriptProbe::scripted(vec![false], false));
        let watch = Arc::new(ResumeWatch::new(Arc::clone(&prober) as Arc<dyn HealthProbe>));
        let a = Arc::clone(&watch);
        let b = Arc::clone(&watch);
        let (fa, fb) = tokio::join!(a.probe(URL), b.probe(URL));
        assert!(!fa.healthy && !fb.healthy);
        assert_eq!(
            prober.probes(),
            1,
            "the second read waited and reused, it did not stack a probe"
        );
    }
}
