//! Permit lanes: bounded concurrency split between render traffic and control traffic.
//!
//! Two manual permit lanes (tokio semaphores, no tower layers): render admits
//! [`RENDER_LANE_MAX`] concurrent requests, control admits [`CONTROL_LANE_MAX`]. At the
//! cap the gate refuses immediately with the `laneFull` word — requests are never queued
//! behind a full lane.

use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::errors::{ApiError, ErrorKind};

/// Concurrent render-lane requests allowed at once.
pub(crate) const RENDER_LANE_MAX: usize = 4;
/// Concurrent control-lane requests allowed at once.
pub(crate) const CONTROL_LANE_MAX: usize = 2;

/// Which lane a route runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    /// Generation-facing routes (queue, generate, jobs).
    Render,
    /// Plane-facing routes (health, status, cycle, discovery).
    Control,
}

/// The two semaphore lanes, shared by the plane via `Arc`.
#[derive(Debug)]
pub(crate) struct Lanes {
    render: Arc<Semaphore>,
    control: Arc<Semaphore>,
}

impl Default for Lanes {
    fn default() -> Self {
        Self::new()
    }
}

impl Lanes {
    /// Builds both lanes at their fixed caps.
    pub(crate) fn new() -> Self {
        Self {
            render: Arc::new(Semaphore::new(RENDER_LANE_MAX)),
            control: Arc::new(Semaphore::new(CONTROL_LANE_MAX)),
        }
    }

    /// Takes one permit in the named lane or refuses with `laneFull`.
    ///
    /// The returned permit is the token: keep it alive for the request's duration and
    /// the lane frees when it drops.
    pub(crate) fn permit(&self, lane: Lane) -> Result<OwnedSemaphorePermit, ApiError> {
        let semaphore = match lane {
            Lane::Render => Arc::clone(&self.render),
            Lane::Control => Arc::clone(&self.control),
        };
        semaphore.try_acquire_owned().map_err(|_| {
            ApiError::new(ErrorKind::LaneFull).with_hint(format!(
                "{} lane is at its concurrency cap; retry after in-flight requests finish",
                lane_word(lane)
            ))
        })
    }

    /// The configured cap of a lane.
    pub(crate) fn max(lane: Lane) -> usize {
        match lane {
            Lane::Render => RENDER_LANE_MAX,
            Lane::Control => CONTROL_LANE_MAX,
        }
    }
}

/// The lane name surfaced in hints and status bodies.
pub(crate) fn lane_word(lane: Lane) -> &'static str {
    match lane {
        Lane::Render => "render",
        Lane::Control => "control",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_lane_admits_four_then_refuses_the_fifth() {
        let lanes = Lanes::new();
        let held: Vec<_> = (0..RENDER_LANE_MAX)
            .map(|_| lanes.permit(Lane::Render).expect("under cap"))
            .collect();
        let error = lanes.permit(Lane::Render).expect_err("fifth refused");
        assert_eq!(error.body_json()["reason"], "laneFull");
        assert_eq!(error.body_json()["error"], "LANE_FULL");
        drop(held);
        let refilled = lanes
            .permit(Lane::Render)
            .expect("permit returns after drop");
        drop(refilled);
    }

    #[test]
    fn control_lane_admits_two_then_refuses_the_third() {
        let lanes = Lanes::new();
        let held: Vec<_> = (0..CONTROL_LANE_MAX)
            .map(|_| lanes.permit(Lane::Control).expect("under cap"))
            .collect();
        assert!(lanes.permit(Lane::Control).is_err());
        drop(held);
        assert!(lanes.permit(Lane::Control).is_ok());
    }

    #[test]
    fn lanes_are_independent_budgets() {
        let lanes = Lanes::new();
        let render: Vec<_> = (0..RENDER_LANE_MAX)
            .map(|_| lanes.permit(Lane::Render).expect("render under cap"))
            .collect();
        let spare = lanes
            .permit(Lane::Control)
            .expect("control still open while render is full");
        drop(spare);
        drop(render);
    }

    #[test]
    fn caps_match_the_design_numbers() {
        assert_eq!(Lanes::max(Lane::Render), 4);
        assert_eq!(Lanes::max(Lane::Control), 2);
    }
}
