//! The native settings bridge (M7a): the Tauri command surface the future operator
//! panel (M7b) uses to read and edit the three agent-plane operator files —
//! `deas-agent-settings.json`, `deas-agent-guard.json` and
//! `deas-agent-defaults.json` — without going through the `/v1` HTTP plane it is
//! configuring. These are NATIVE commands: their refusals are stock human-readable
//! strings, never the API error taxonomy.
//!
//! The laws this seam keeps:
//!
//! * Three-state merge on every write: a present key with a value sets, a present
//!   `null` restores the shipped default, an absent key keeps the current value —
//!   the same law as the defaults sheet's dial patch ([`defaults::apply_patch`]).
//! * Confirm wall: `confirm` not literally `true` answers the before/after diff
//!   preview and writes NOTHING; the caller confirms against the preview it was shown.
//! * Boot-law mirror at write time: the candidate is validated with the same homes
//!   startup uses ([`config::validate_enabled`], [`guard::validate_value`]), so a
//!   panel can never park bytes on disk that startup would refuse — an
//!   `autoCycleVram: true` guard file with empty commands is refused at the write
//!   wall, never armed into `guardUnconfigured`.
//! * Mid-cycle guard law: a guard or defaults write is REFUSED while the live cycle
//!   cell's phase is not idle — the same fact `GET /v1/cycle` answers and the same
//!   wall `POST /v1/defaults` runs first.
//! * Plane-off honesty: the panel configures BEFORE enabling. With no bound plane
//!   there is no cell and no cycle can run, so the file-level commands work; only a
//!   live cell ever refuses a write.
//! * Atomic writes: staging file plus rename (the defaults sheet's idiom). A
//!   corrupt existing file fails closed: merging into bytes we cannot parse is
//!   forbidden, and nothing rewrites the file behind the operator's back.
//! * Key etiquette: the standing key round-trips verbatim through read and preview
//!   (it is the operator's own file; masking is the panel's job). This module never
//!   calls `logs::push`, and its refusal strings name keys and shape but never echo
//!   a standingKey value.

use std::path::Path;

use serde_json::{json, Map, Value};

use super::cycle_view::CyclePhase;
use super::{config, cycle, defaults, guard};

/// The closed writable vocabulary of `deas-agent-settings.json`.
const SETTINGS_KEYS: [&str; 4] = ["enabled", "port", "standingKey", "originAllowlist"];

/// The closed writable vocabulary of `deas-agent-guard.json` (the watchdog and
/// caps blocks stay raw: a malformed block costs the watchdog its defaults plus
/// one honest log line at read time, exactly as at boot — it never refuses the
/// cycle file — while an out-of-bounds cap number is refused at WRITE time by
/// the boot laws naming its key, the bat-cap honesty idiom).
const GUARD_KEYS: [&str; 7] = [
    "unloadCommand",
    "restoreCommand",
    "readyUrl",
    "autoCycleVram",
    "freeOnQueueEnd",
    "watchdog",
    "caps",
];

/* ------------------------------ command surface ------------------------------ */

/// The panel's full settings snapshot: every `AgentSettings` field verbatim plus
/// `exists`, `sourcePath` and (when the file is corrupt) a fail-closed refusal.
#[tauri::command]
pub fn native_agent_settings_read(app: tauri::AppHandle) -> Result<Value, String> {
    settings_read(&app_data(&app)?)
}

/// Confirm-gated three-state patch of `deas-agent-settings.json`. `confirm` not
/// literally `true` answers the diff preview and writes nothing.
#[tauri::command]
pub fn native_agent_settings_write(
    app: tauri::AppHandle,
    patch: Map<String, Value>,
    confirm: Option<bool>,
) -> Result<Value, String> {
    settings_write(&app_data(&app)?, &patch, confirm)
}

/// The guard file snapshot: raw commands, cycle words and watchdog block, plus
/// `configured`, `exists` and `sourcePath`. A corrupt file answers honestly with
/// `configured: false` and the refusal problem — the read never pretends.
#[tauri::command]
pub fn native_agent_guard_read(app: tauri::AppHandle) -> Result<Value, String> {
    guard_read(&app_data(&app)?)
}

/// Confirm-gated three-state patch of `deas-agent-guard.json`. REFUSED while the
/// live cycle cell is mid-cycle; the candidate faces the boot laws at write time.
#[tauri::command]
pub fn native_agent_guard_write(
    app: tauri::AppHandle,
    patch: Map<String, Value>,
    confirm: Option<bool>,
) -> Result<Value, String> {
    guard_write(&app_data(&app)?, live_cell(), &patch, confirm)
}

/// The defaults sheet snapshot: the whole sheet verbatim plus `configured`
/// (a file exists) and `sourcePath`. A corrupt sheet fails closed.
#[tauri::command]
pub fn native_agent_defaults_read(app: tauri::AppHandle) -> Result<Value, String> {
    defaults_read(&app_data(&app)?)
}

/// Confirm-gated set/merge of one `family:mode` combo entry — the same shape,
/// walls and sheet as `POST /v1/defaults`, over the same [`defaults`] engine.
/// REFUSED while the live cycle cell is mid-cycle (the drain reads the sheet).
#[tauri::command]
pub fn native_agent_defaults_write(
    app: tauri::AppHandle,
    key: String,
    dials: Map<String, Value>,
    confirm: Option<bool>,
) -> Result<Value, String> {
    defaults_write(&app_data(&app)?, live_cell(), &key, &dials, confirm)
}

/* ------------------------------ state plumbing ------------------------------ */

/// The app-data directory the operator files live in. Mirrors the startup path
/// [`super::start_if_enabled`] is handed, so panel and plane can never disagree.
fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_data_dir()
        .map_err(|error| format!("app data directory unavailable: {error}"))
}

/// The live plane's cycle cell when a `/v1` plane has bound; `None` when the plane
/// never started — then no cycle can be in flight and the file walls stand alone.
fn live_cell() -> Option<&'static cycle::CycleCell> {
    super::live_plane().map(|plane| plane.cycle_cell())
}

/// The mid-cycle wall as a stock-shaped refusal string: names the phase and cycle
/// id, never the HTTP taxonomy. When THIS process has no live plane (`None`), the
/// wall does not simply vanish — it runs the W3-8 cross-process check below.
fn mid_cycle_refusal(
    app_data: &Path,
    cell: Option<&cycle::CycleCell>,
    what: &str,
) -> Result<(), String> {
    let Some(cell) = cell else {
        return foreign_cycle_wall(app_data, what);
    };
    let live = cell.live();
    if live.phase != CyclePhase::Idle {
        return Err(format!(
            "a VRAM cycle is live (phase '{}', cycle '{}'); {what} are refused until the cycle answers idle",
            cycle::phase_word(live.phase),
            live.cycle_id.clone().unwrap_or_default(),
        ));
    }
    Ok(())
}

/* W3-8 (LEG AF2-M21b): the cross-process plane wall. --------------------------------

OPERATOR CONTRACT, ruled not implemented: ONE DEAS instance per API box. Stock v0.3.14
ships no single-instance plugin and this leg deliberately does NOT build one — the
tcp bind is the arbiter (a second enabled instance loses the port and logs the bind
failure), so the loser never serves `/v1`; what it CAN still do is run its native
panel bridge. A panel write from that plane-less process lands on the SAME app-data
files the winner's live cycle reads (the guard hot-reloads mid-cycle, the drain reads
the defaults sheet), and the loser's own `live_cell()` is `None`, so the same-process
wall sees nothing. This wall is the best-effort belt: the durable spool is the one
fact both processes share, and a `draining` row in it IS the winner's cycle. It is
best-effort honestly: between this read and the rename the winner can still start a
cycle — the CONTRACT (one instance per box) is the law, this wall shrinks the window
for the accident the contract does not prevent.
----------------------------------------------------------------------------------- */

/// The cross-process half of the mid-cycle wall: with no live cell in THIS process,
/// read the durable spool and refuse plane-file writes while ANY row sits `draining`
/// (a driver owns it — a cycle is running SOMEWHERE). Fail-closed on an unreadable
/// spool: a panel that cannot see the plane's cycle must not write the plane's files.
fn foreign_cycle_wall(app_data: &Path, what: &str) -> Result<(), String> {
    let rows = crate::agent_api::spool::Spool::new(app_data).snapshot().map_err(|problem| {
        format!(
            "maintenanceActive: the queue spool on disk is unreadable ({problem}), so the panel cannot rule out a cycle another DEAS instance is running; {what} are refused until the spool reads clean"
        )
    })?;
    if let Some(row) = rows
        .iter()
        .find(|row| row.status == crate::agent_api::spool::RowStatus::Draining)
    {
        return Err(format!(
            "maintenanceActive: another DEAS instance owns the plane (the durable spool holds draining row '{}'); {what} are refused until that instance's cycle answers idle — one DEAS instance per API box is the operator contract",
            row.id
        ));
    }
    Ok(())
}

/* ------------------------------ shared file helpers ------------------------------ */

/// Reads an operator file as a raw JSON object; `Ok(None)` when absent. A corrupt
/// file fails closed — merging into bytes we cannot parse is forbidden.
fn read_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    match value {
        Value::Object(object) => Ok(Some(object)),
        _ => Err(format!("parse {}: expected a JSON object", path.display())),
    }
}

/// Writes bytes atomically: staging file beside the target, then rename (the
/// defaults sheet's idiom). On failure the target keeps its previous bytes and
/// the staging file is cleaned up best-effort.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("deas-agent-file");
    let staging = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    let result = std::fs::write(&staging, bytes)
        .map_err(|error| format!("write {}: {error}", staging.display()))
        .and_then(|()| {
            std::fs::rename(&staging, path)
                .map_err(|error| format!("rename onto {}: {error}", path.display()))
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

/// Three-state merge onto a raw object over a closed vocabulary: present sets,
/// present `null` restores the shipped default from `defaults`, absent keeps.
/// A key outside the vocabulary is refused naming it and the closed set.
fn merge_three_state(
    target: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    vocabulary: &[&str],
    file_defaults: &Map<String, Value>,
) -> Result<(), String> {
    for key in patch.keys() {
        if !vocabulary.contains(&key.as_str()) {
            return Err(format!(
                "'{key}' is not a writable key; the closed set is {}",
                vocabulary.join(", ")
            ));
        }
    }
    for (key, value) in patch {
        match value {
            Value::Null => match file_defaults.get(key) {
                Some(default) => {
                    target.insert(key.clone(), default.clone());
                }
                None => {
                    target.remove(key);
                }
            },
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    Ok(())
}

/// The keys whose values differ between a `before` and an `after` snapshot: the
/// diff preview the caller confirms against.
fn changed_keys(before: &Value, after: &Value) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if let (Some(before), Some(after)) = (before.as_object(), after.as_object()) {
        for (key, value) in after {
            if before.get(key) != Some(value) {
                keys.push(key.clone());
            }
        }
    }
    keys.sort();
    keys
}

/// The honest confirm answer: `applied: false`, the before/after snapshots, and
/// the changed-key list — nothing touched the filesystem.
fn preview(source_path: &Path, before: Value, after: Value) -> Value {
    json!({
        "applied": false,
        "sourcePath": source_path.display().to_string(),
        "changes": changed_keys(&before, &after),
        "before": before,
        "after": after,
    })
}

/* ------------------------------ settings plane ------------------------------ */

/// The settings snapshot core. Absent file answers the shipped defaults with
/// `exists: false`; a corrupt file fails closed naming the path.
pub(crate) fn settings_read(app_data: &Path) -> Result<Value, String> {
    let path = app_data.join(config::FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let settings = match &bytes {
        Some(bytes) => serde_json::from_slice::<config::AgentSettings>(bytes)
            .map_err(|error| format!("parse {}: {error}", path.display()))?,
        None => config::AgentSettings::default(),
    };
    let mut snapshot = serde_json::to_value(&settings)
        .map_err(|error| format!("serialize settings snapshot: {error}"))?;
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| "settings snapshot is not an object".to_owned())?;
    object.insert("exists".to_owned(), json!(bytes.is_some()));
    object.insert("sourcePath".to_owned(), json!(path.display().to_string()));
    Ok(snapshot)
}

/// The settings write core: three-state merge over the closed vocabulary, the
/// boot-law mirror at write time ([`config::validate_enabled`] behind the same
/// `enabled` gate startup applies), confirm wall, atomic write.
pub(crate) fn settings_write(
    app_data: &Path,
    patch: &Map<String, Value>,
    confirm: Option<bool>,
) -> Result<Value, String> {
    // W3-8: the settings file is read only at boot, so THIS process' own cycle has
    // never needed a wall here (the law stands: no settings wall while the plane is
    // live in this process). A plane-less process, however, must not write any plane
    // file while another instance's cycle is live on disk — same race, same belt.
    if super::live_plane().is_none() {
        foreign_cycle_wall(app_data, "settings writes")?;
    }
    let path = app_data.join(config::FILE);
    let current = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<config::AgentSettings>(&bytes).map_err(|error| {
            format!("cannot merge into the existing {}: {error}", path.display())
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            config::AgentSettings::default()
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut candidate = serde_json::to_value(&current)
        .map_err(|error| format!("serialize settings candidate: {error}"))?;
    let object = candidate
        .as_object_mut()
        .ok_or_else(|| "settings candidate is not an object".to_owned())?;
    let file_defaults = serde_json::to_value(config::AgentSettings::default())
        .map_err(|error| format!("serialize settings defaults: {error}"))?;
    merge_three_state(
        object,
        patch,
        &SETTINGS_KEYS,
        file_defaults
            .as_object()
            .ok_or_else(|| "settings defaults are an object".to_owned())?,
    )?;
    let candidate: config::AgentSettings =
        serde_json::from_value(candidate).map_err(|error| format!("refuse write: {error}"))?;
    if candidate.enabled {
        // The boot-law mirror: startup refuses these bytes, so the panel cannot
        // park them (a zero port or an empty standing key never lands enabled).
        config::validate_enabled(&candidate)
            .map_err(|problem| format!("refuse write: {problem}"))?;
    }
    let before = serde_json::to_value(&current)
        .map_err(|error| format!("serialize settings snapshot: {error}"))?;
    let after = serde_json::to_value(&candidate)
        .map_err(|error| format!("serialize settings snapshot: {error}"))?;
    if confirm != Some(true) {
        return Ok(preview(&path, before, after));
    }
    let bytes = serde_json::to_vec_pretty(&candidate)
        .map_err(|error| format!("serialize {}: {error}", path.display()))?;
    atomic_write(&path, &bytes).map_err(|problem| {
        format!("settings write failed; operator attention required: {problem}")
    })?;
    Ok(json!({
        "applied": true,
        "sourcePath": path.display().to_string(),
        "changes": changed_keys(&before, &after),
        "settings": after,
    }))
}

/* ------------------------------ guard plane ------------------------------ */

/// The guard snapshot core: raw file object verbatim when present, the shipped
/// missing-field law (the [`guard`] file defaults) when absent, plus the honest
/// `configured` posture — a corrupt file answers `configured: false` with the
/// refusal problem, exactly like the cycle view reads it.
pub(crate) fn guard_read(app_data: &Path) -> Result<Value, String> {
    let path = app_data.join(guard::FILE);
    // Structural corruption is surfaced honestly as `configured: false` plus the
    // problem (the cycle view's law for a malformed guard), never as a crashed
    // read: the panel repairing a broken guard file needs this read to answer.
    // A write over the same bytes stays fail-closed in [`guard_write`].
    let (raw, structural) = match read_object(&path) {
        Ok(raw) => (raw, None),
        Err(problem) => (None, Some(problem)),
    };
    let exists = structural.is_some() || raw.is_some();
    let (configured, problem) = match (&raw, &structural) {
        (Some(object), None) => match guard::validate_value(&Value::Object(object.clone())) {
            Ok(_) => (true, None),
            Err(problem) => (false, Some(problem)),
        },
        (_, Some(problem)) => (false, Some(problem.clone())),
        (None, None) => (false, None),
    };
    // Absent answers the shipped missing-field law: what the boot laws make an
    // absent field mean (empty commands, both cycle words true, watchdog defaults).
    let mut snapshot = raw.map(Value::Object).unwrap_or_else(|| {
        json!({
            "unloadCommand": "",
            "restoreCommand": "",
            "readyUrl": "",
            "autoCycleVram": true,
            "freeOnQueueEnd": true,
            "watchdog": null,
        })
    });
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| "guard snapshot is not an object".to_owned())?;
    object.insert("configured".to_owned(), json!(configured));
    object.insert("exists".to_owned(), json!(exists));
    if let Some(problem) = problem {
        object.insert("problem".to_owned(), json!(problem));
    }
    object.insert("sourcePath".to_owned(), json!(path.display().to_string()));
    Ok(snapshot)
}

/// The guard write core: mid-cycle wall first (live cell only), three-state merge
/// over the closed vocabulary, then the boot laws at WRITE time via
/// [`guard::validate_value`] — the `autoCycleVram: true`-with-empty-commands
/// posture the plane would surface as `guardUnconfigured` is refused here — then
/// the confirm wall and the atomic write.
pub(crate) fn guard_write(
    app_data: &Path,
    cell: Option<&cycle::CycleCell>,
    patch: &Map<String, Value>,
    confirm: Option<bool>,
) -> Result<Value, String> {
    mid_cycle_refusal(app_data, cell, "guard writes")?;
    let path = app_data.join(guard::FILE);
    let mut candidate = read_object(&path)?.unwrap_or_default();
    // The shipped missing-field law as the clear-to-default table.
    let file_defaults = json!({
        "unloadCommand": "",
        "restoreCommand": "",
        "readyUrl": "",
        "autoCycleVram": true,
        "freeOnQueueEnd": true,
        "watchdog": null,
        "caps": null,
    });
    let before = Value::Object(candidate.clone());
    merge_three_state(
        &mut candidate,
        patch,
        &GUARD_KEYS,
        file_defaults
            .as_object()
            .ok_or_else(|| "guard defaults literal is an object".to_owned())?,
    )?;
    let candidate_value = Value::Object(candidate);
    guard::validate_value(&candidate_value)
        .map_err(|problem| format!("refuse write: {problem}"))?;
    if confirm != Some(true) {
        return Ok(preview(&path, before, candidate_value));
    }
    let bytes = serde_json::to_vec_pretty(&candidate_value)
        .map_err(|error| format!("serialize {}: {error}", path.display()))?;
    atomic_write(&path, &bytes)
        .map_err(|problem| format!("guard write failed; operator attention required: {problem}"))?;
    Ok(json!({
        "applied": true,
        "sourcePath": path.display().to_string(),
        "changes": changed_keys(&before, &candidate_value),
        "guard": candidate_value,
    }))
}

/* ------------------------------ defaults plane ------------------------------ */

/// The defaults sheet snapshot core: the whole sheet verbatim (empty sheet with
/// `configured: false` when absent). A corrupt sheet fails closed naming the key —
/// the same posture `POST /v1/defaults` takes when it cannot merge.
pub(crate) fn defaults_read(app_data: &Path) -> Result<Value, String> {
    let path = app_data.join(defaults::FILE);
    let sheet = defaults::load(app_data)?;
    let configured = sheet.is_some();
    let sheet = sheet.unwrap_or_default();
    Ok(json!({
        "configured": configured,
        "sourcePath": path.display().to_string(),
        "sheet": serde_json::to_value(&sheet)
            .map_err(|error| format!("serialize defaults sheet: {error}"))?,
    }))
}

/// The defaults write core: a thin wrapper OVER the [`defaults`] engine — the
/// same combo-key walls, the same three-state [`defaults::apply_patch`], the same
/// validation and the same atomic write that `POST /v1/defaults`
/// runs, so there is one logic home for the sheet. Since LEG AF2-M18b B2 that home is
/// the SERIALIZED one: the bridge runs its load-merge-write through
/// [`defaults::merge_write`] (or [`defaults::merge_preview`] when `confirm` is not
/// literally true), so a native UI write and an API write share [`defaults::WRITE_GATE`]
/// and can neither lose each other's merge nor race one staging path. The refusal strings
/// are stock, not the API taxonomy. Mid-cycle refusal mirrors the route's first wall.
pub(crate) fn defaults_write(
    app_data: &Path,
    cell: Option<&cycle::CycleCell>,
    key: &str,
    dials: &Map<String, Value>,
    confirm: Option<bool>,
) -> Result<Value, String> {
    mid_cycle_refusal(app_data, cell, "defaults writes")?;
    let (family, mode) =
        defaults::parse_combo_key(key).map_err(|problem| format!("refuse write: {problem}"))?;
    if !defaults::is_known_family(family) {
        return Err(format!(
            "refuse write: combo key '{key}': family '{family}' is not a known family id"
        ));
    }
    if !defaults::MODES.contains(&mode) {
        return Err(format!(
            "refuse write: combo key '{key}': mode '{mode}' is outside the closed vocabulary {}",
            defaults::MODES.join("|")
        ));
    }
    // Fail closed on a corrupt existing sheet: merging into bytes we cannot parse
    // is forbidden, and the refusal names what the operator must fix. The read, the
    // merge and (on the confirm path) the write form ONE gated critical section — this
    // bridge and `POST /v1/defaults` share [`defaults::WRITE_GATE`] (LEG AF2-M18b B2).
    let merge = |sheet: &mut defaults::DefaultsSheet| -> Result<(), String> {
        let entry = sheet.combos.entry(key.to_owned()).or_default();
        defaults::apply_patch(dials, entry)?;
        defaults::validate_dials(&format!("combos.{key}"), entry)
    };
    let outcome = if confirm == Some(true) {
        defaults::merge_write(app_data, merge)
    } else {
        defaults::merge_preview(app_data, merge)
    }
    .map_err(|problem| match problem {
        defaults::SheetProblem::Load(problem) => format!(
            "cannot merge into the existing {}: {problem}",
            defaults::FILE
        ),
        defaults::SheetProblem::Merge(problem) => format!("refuse write: {problem}"),
        defaults::SheetProblem::Write(problem) => {
            format!("defaults sheet write failed; operator attention required: {problem}")
        }
    })?;
    let before_entry =
        serde_json::to_value(outcome.before.combos.get(key).cloned().unwrap_or_default())
            .map_err(|error| format!("serialize defaults snapshot: {error}"))?;
    let after_entry =
        serde_json::to_value(outcome.after.combos.get(key).cloned().unwrap_or_default())
            .map_err(|error| format!("serialize defaults snapshot: {error}"))?;
    let configurable = serde_json::to_value(&outcome.after)
        .map_err(|error| format!("serialize defaults sheet: {error}"))?;
    let path = app_data.join(defaults::FILE);
    if confirm != Some(true) {
        return Ok(json!({
            "applied": false,
            "sourcePath": path.display().to_string(),
            "key": key,
            "changes": changed_keys(&before_entry, &after_entry),
            "before": before_entry,
            "after": after_entry,
            "configurable": configurable,
        }));
    }
    Ok(json!({
        "applied": true,
        "sourcePath": path.display().to_string(),
        "key": key,
        "changes": changed_keys(&before_entry, &after_entry),
        "after": after_entry,
        "configurable": configurable,
    }))
}

/* ---------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(text: &str) -> Map<String, Value> {
        serde_json::from_str(text).expect("test patch object parses")
    }

    /* -------- settings: three-state arms, confirm wall, boot mirror, atomicity -------- */

    #[test]
    fn settings_three_state_merge_sets_present_clears_null_and_keeps_absent() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(config::FILE),
            r#"{"enabled": true, "port": 9111, "standingKey": "keepme",
                "originAllowlist": ["http://localhost:1420"]}"#,
        )
        .expect("fixture writes settings");
        let answer = settings_write(
            dir.path(),
            &patch(r#"{ "port": 9222, "standingKey": null }"#),
            Some(true),
        )
        .expect("well-formed patch applies");
        assert_eq!(answer["applied"], json!(true));
        let after = settings_read(dir.path()).expect("read after");
        assert_eq!(after["port"], json!(9222), "present value sets");
        assert_eq!(
            after["standingKey"],
            Value::Null,
            "explicit null clears to default"
        );
        assert_eq!(
            after["originAllowlist"],
            json!(["http://localhost:1420"]),
            "absent key keeps"
        );
        assert_eq!(after["enabled"], json!(true), "absent enabled keeps");
    }

    #[test]
    fn settings_confirm_false_writes_nothing_and_answers_the_preview() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(config::FILE), r#"{"enabled": false}"#)
            .expect("fixture writes settings");
        let before_bytes = std::fs::read(dir.path().join(config::FILE)).expect("fixture bytes");
        let answer = settings_write(
            dir.path(),
            &patch(r#"{ "enabled": true, "standingKey": "abc123" }"#),
            Some(false),
        )
        .expect("confirm-false answers the preview, not an error");
        assert_eq!(answer["applied"], json!(false));
        assert_eq!(answer["before"]["enabled"], json!(false));
        assert_eq!(answer["after"]["enabled"], json!(true));
        assert_eq!(
            answer["changes"],
            json!(["enabled", "standingKey"]),
            "the preview names what would change"
        );
        let on_disk = std::fs::read(dir.path().join(config::FILE)).expect("still there");
        assert_eq!(on_disk, before_bytes, "confirm-false wrote NOTHING");
    }

    #[test]
    fn settings_write_refuses_enabled_zero_port_at_the_write_wall() {
        let _gate = crate::resources::fence_test_gate();
        // The boot-law mirror: a panel cannot park bytes startup would refuse.
        let dir = tempfile::tempdir().expect("tempdir");
        let problem = settings_write(
            dir.path(),
            &patch(r#"{ "enabled": true, "port": 0 }"#),
            Some(true),
        )
        .expect_err("zero port enabled is refused at write time");
        assert!(problem.contains("port"), "problem names port: {problem}");
        assert!(
            !dir.path().join(config::FILE).exists(),
            "nothing was written for a refused candidate"
        );
    }

    #[test]
    fn settings_write_refuses_empty_standing_key_at_the_write_wall() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        let problem = settings_write(
            dir.path(),
            &patch(r#"{ "enabled": true, "standingKey": "" }"#),
            Some(true),
        )
        .expect_err("empty standing key is refused at write time");
        assert!(
            problem.contains("standingKey"),
            "problem names it: {problem}"
        );
    }

    #[test]
    fn settings_write_refuses_an_unknown_patch_key_naming_it() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        let problem = settings_write(dir.path(), &patch(r#"{ "pot": 9999 }"#), Some(true))
            .expect_err("unknown key refused");
        assert!(problem.contains("pot"), "problem names the key: {problem}");
    }

    #[test]
    fn settings_atomic_write_survives_a_reopen() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        settings_write(
            dir.path(),
            &patch(r#"{ "enabled": true, "port": 9111 }"#),
            Some(true),
        )
        .expect("write applies");
        let after = settings_read(dir.path()).expect("reopen reads the new bytes");
        assert_eq!(after["enabled"], json!(true));
        assert_eq!(after["port"], json!(9111));
        assert_eq!(after["exists"], json!(true));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("readable")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "staging cleaned up");
    }

    #[test]
    fn settings_key_round_trips_verbatim_and_refusals_never_echo_key_bytes() {
        let _gate = crate::resources::fence_test_gate();
        // Key etiquette: the operator's own file round-trips verbatim through the
        // snapshot; the refusal strings name keys and shape but never echo bytes,
        // and this module contains no log call at all.
        let dir = tempfile::tempdir().expect("tempdir");
        settings_write(
            dir.path(),
            &patch(r#"{ "enabled": true, "standingKey": "s3cret-rotate" }"#),
            Some(true),
        )
        .expect("key write applies");
        let after = settings_read(dir.path()).expect("read after");
        assert_eq!(
            after["standingKey"],
            json!("s3cret-rotate"),
            "verbatim round trip"
        );
        let problem = settings_write(
            dir.path(),
            &patch(r#"{ "enabled": true, "port": 0, "standingKey": "leakcheck-9f2a" }"#),
            Some(true),
        )
        .expect_err("zero port refused");
        assert!(
            !problem.contains("leakcheck-9f2a"),
            "refusal names the field, never the key bytes: {problem}"
        );
    }

    #[test]
    fn settings_read_answers_defaults_when_the_file_is_absent_and_names_the_source() {
        let _gate = crate::resources::fence_test_gate();
        // Plane-off file access: the panel configures BEFORE enabling; the core
        // never consults the live plane.
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = settings_read(dir.path()).expect("absent answers defaults");
        assert_eq!(snapshot["exists"], json!(false));
        assert_eq!(snapshot["enabled"], json!(false));
        assert_eq!(snapshot["port"], json!(u64::from(config::DEFAULT_PORT)));
        assert!(
            snapshot["sourcePath"]
                .as_str()
                .is_some_and(|path| path.contains(config::FILE)),
            "honest source path: {snapshot}"
        );
    }

    #[test]
    fn settings_write_fails_closed_on_a_corrupt_existing_file() {
        let _gate = crate::resources::fence_test_gate();
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(config::FILE), "{ not json")
            .expect("fixture writes corrupt bytes");
        let problem = settings_write(dir.path(), &patch(r#"{ "port": 9111 }"#), Some(true))
            .expect_err("merging into unparseable bytes is forbidden");
        assert!(
            problem.contains(config::FILE),
            "problem names the file: {problem}"
        );
        let on_disk = std::fs::read_to_string(dir.path().join(config::FILE)).expect("still there");
        assert_eq!(on_disk, "{ not json", "never rewritten behind the operator");
    }

    /* -------- guard: mid-cycle law, boot mirror, three-state, confirm wall -------- */

    #[test]
    fn guard_mid_cycle_write_is_refused_while_the_cell_is_claimed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = cycle::CycleCell::new(dir.path());
        let cycle_id = cell.claim(CyclePhase::Draining).expect("test claim");
        let problem = guard_write(
            dir.path(),
            Some(&cell),
            &patch(r#"{ "autoCycleVram": false }"#),
            Some(true),
        )
        .expect_err("a live cycle refuses guard writes");
        assert!(
            problem.contains("draining"),
            "refusal names the phase: {problem}"
        );
        assert!(
            problem.contains(&cycle_id),
            "refusal names the cycle: {problem}"
        );
        assert!(
            !dir.path().join(guard::FILE).exists(),
            "mid-cycle refusal wrote nothing"
        );
        cell.finish(json!({ "ok": true, "cycleId": cycle_id }));
    }

    /// W3-8 (LEG AF2-M21b): a SECOND DEAS instance lost the bind but its panel
    /// bridge still runs; its `live_cell()` is `None`, so the same-process wall sees
    /// nothing. The durable spool is the shared fact: a `draining` row IS the winner's
    /// cycle, and every native plane-file write — guard, defaults, settings — refuses
    /// with the maintenanceActive word naming the owning instance, writing nothing.
    #[test]
    fn a_foreign_draining_row_walls_every_native_plane_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_spool_with_row(dir.path(), "draining");
        let problem = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "autoCycleVram": false }"#),
            Some(true),
        )
        .expect_err("a draining row on disk walls the plane-less bridge");
        assert!(
            problem.contains("another DEAS instance owns the plane"),
            "{problem}"
        );
        assert!(
            problem.contains("foreign-row"),
            "the refusal names the row: {problem}"
        );
        assert!(
            !dir.path().join(guard::FILE).exists(),
            "the refusal wrote nothing"
        );
        let problem = defaults_write(
            dir.path(),
            None,
            "anima:t2i",
            &patch(r#"{ "steps": 20 }"#),
            Some(true),
        )
        .expect_err("the same wall covers defaults writes");
        assert!(
            problem.contains("another DEAS instance owns the plane"),
            "{problem}"
        );
        assert!(
            !dir.path().join(defaults::FILE).exists(),
            "the refusal wrote nothing"
        );
        let problem = settings_write(dir.path(), &patch(r#"{ "port": 8791 }"#), Some(true))
            .expect_err("the same wall covers settings writes");
        assert!(
            problem.contains("another DEAS instance owns the plane"),
            "{problem}"
        );
        assert!(
            !dir.path().join(config::FILE).exists(),
            "the refusal wrote nothing"
        );
    }

    /// The wall's other half, pinned as a differential over the SAME fixture: no
    /// draining row (here: no spool at all, plus a queued-only row next door) leaves
    /// every native write open exactly as before the wall existed.
    #[test]
    fn no_draining_row_leaves_the_native_plane_writes_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_spool_with_row(dir.path(), "queued");
        guard_write(
            dir.path(),
            None,
            &patch(r#"{ "autoCycleVram": false }"#),
            Some(true),
        )
        .expect("a queued row is not a cycle");
        assert!(dir.path().join(guard::FILE).exists(), "the write landed");
        settings_write(dir.path(), &patch(r#"{ "port": 8791 }"#), Some(true))
            .expect("settings write proceeds");
    }

    /// Fail-closed honesty: an unreadable spool cannot rule out a live cycle, so the
    /// plane-less bridge refuses rather than guesses.
    #[test]
    fn an_unreadable_spool_fails_the_plane_less_bridge_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(crate::agent_api::spool::FILE),
            b"not json at all",
        )
        .expect("corrupt spool");
        let problem = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "autoCycleVram": false }"#),
            Some(true),
        )
        .expect_err("an unreadable spool is not an empty one");
        assert!(problem.contains("unreadable"), "{problem}");
        assert!(
            !dir.path().join(guard::FILE).exists(),
            "the refusal wrote nothing"
        );
    }

    /// One hand-written spool file (the bridge reads the DURABLE bytes — that is the
    /// whole cross-process point), carrying one row in `status`.
    fn write_spool_with_row(app_data: &Path, status: &str) {
        std::fs::write(
            app_data.join(crate::agent_api::spool::FILE),
            format!(
                r#"{{"version":{},"rows":[{{"id":"foreign-row","createdAt":1,"status":"{status}","envelope":{{"recipe":{{"recipeId":"checkpoint-text-to-image-diagnostic","version":1}},"family":"anima","fields":[],"seed":{{"mode":"fixed","value":7}}}},"slots":{{}},"extras":{{}}}}]}}"#,
                crate::agent_api::spool::QUEUE_VERSION
            ),
        )
        .expect("foreign spool lands");
    }

    #[test]
    fn guard_write_is_accepted_when_the_cell_is_idle_and_when_no_plane_ever_bound() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = cycle::CycleCell::new(dir.path());
        guard_write(
            dir.path(),
            Some(&cell),
            &patch(
                r#"{ "unloadCommand": "u.bat", "restoreCommand": "r.bat",
                    "readyUrl": "http://127.0.0.1:18502/health" }"#,
            ),
            Some(true),
        )
        .expect("idle cell accepts the write");
        // Plane-off honesty: no cell at all, the file wall stands alone.
        let dir2 = tempfile::tempdir().expect("tempdir");
        guard_write(
            dir2.path(),
            None,
            &patch(r#"{ "autoCycleVram": false }"#),
            Some(true),
        )
        .expect("no plane means no cycle can run; the write proceeds");
        let snapshot = guard_read(dir2.path()).expect("read after");
        assert_eq!(snapshot["configured"], json!(true));
        assert_eq!(snapshot["autoCycleVram"], json!(false));
    }

    #[test]
    fn guard_write_refuses_auto_cycle_vram_with_empty_commands_at_write_time() {
        // The boot-law mirror: the panel can never arm the machine into
        // guardUnconfigured — the same posture startup refuses is refused here.
        let dir = tempfile::tempdir().expect("tempdir");
        let problem = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "autoCycleVram": true }"#),
            Some(true),
        )
        .expect_err("cycle-true with no commands is refused at write time");
        assert!(
            problem.contains("unloadCommand"),
            "problem names it: {problem}"
        );
        assert!(
            problem.contains("restoreCommand"),
            "problem names it: {problem}"
        );
        assert!(problem.contains("readyUrl"), "problem names it: {problem}");
        assert!(
            !dir.path().join(guard::FILE).exists(),
            "nothing was written for a refused candidate"
        );
    }

    #[test]
    fn guard_three_state_merge_sets_present_clears_null_and_keeps_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(guard::FILE),
            r#"{"unloadCommand": "u.bat", "restoreCommand": "r.bat",
                "readyUrl": "http://127.0.0.1:18502/health",
                "autoCycleVram": false, "freeOnQueueEnd": false}"#,
        )
        .expect("fixture writes guard");
        guard_write(
            dir.path(),
            None,
            &patch(r#"{ "unloadCommand": "u2.bat", "readyUrl": null, "freeOnQueueEnd": true }"#),
            Some(true),
        )
        .expect("patch applies");
        let snapshot = guard_read(dir.path()).expect("read after");
        assert_eq!(snapshot["unloadCommand"], json!("u2.bat"), "present sets");
        assert_eq!(
            snapshot["readyUrl"],
            json!(""),
            "null clears to the shipped default"
        );
        assert_eq!(snapshot["restoreCommand"], json!("r.bat"), "absent keeps");
        assert_eq!(snapshot["autoCycleVram"], json!(false), "absent word keeps");
        assert_eq!(snapshot["freeOnQueueEnd"], json!(true));
        assert_eq!(
            snapshot["configured"],
            json!(true),
            "cycle-off tolerates the empty URL"
        );
    }

    #[test]
    fn guard_confirm_false_writes_nothing_and_answers_the_preview() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(guard::FILE), r#"{"autoCycleVram": false}"#)
            .expect("fixture writes guard");
        let before_bytes = std::fs::read(dir.path().join(guard::FILE)).expect("fixture bytes");
        let answer = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "unloadCommand": "u.bat", "restoreCommand": "r.bat", "readyUrl": "http://x/health" }"#),
            Some(false),
        )
        .expect("confirm-false answers the preview");
        assert_eq!(answer["applied"], json!(false));
        assert_eq!(answer["after"]["unloadCommand"], json!("u.bat"));
        let on_disk = std::fs::read(dir.path().join(guard::FILE)).expect("still there");
        assert_eq!(on_disk, before_bytes, "confirm-false wrote NOTHING");
    }

    #[test]
    fn guard_absent_file_snapshot_is_the_missing_field_law() {
        // The snapshot's defaults are the boot law for absent fields: writing the
        // snapshot's words back produces a validating file with the same words.
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = guard_read(dir.path()).expect("absent answers the shipped law");
        assert_eq!(snapshot["exists"], json!(false));
        assert_eq!(snapshot["configured"], json!(false));
        assert_eq!(snapshot["autoCycleVram"], json!(true));
        assert_eq!(snapshot["freeOnQueueEnd"], json!(true));
        let words = json!({
            "unloadCommand": "u.bat",
            "restoreCommand": "r.bat",
            "readyUrl": snapshot["readyUrl"],
            "autoCycleVram": snapshot["autoCycleVram"],
            "freeOnQueueEnd": snapshot["freeOnQueueEnd"],
        });
        let error = guard::validate_value(&words).expect_err("empty readyUrl stays unconfigured");
        assert!(
            error.contains("readyUrl"),
            "law holds through the snapshot: {error}"
        );
        let valid = json!({
            "unloadCommand": "u.bat",
            "restoreCommand": "r.bat",
            "readyUrl": "http://127.0.0.1:1/health",
            "autoCycleVram": snapshot["autoCycleVram"],
            "freeOnQueueEnd": snapshot["freeOnQueueEnd"],
        });
        let config = guard::validate_value(&valid).expect("the snapshot words validate");
        assert!(config.auto_cycle_vram);
        assert!(config.free_on_queue_end);
    }

    #[test]
    fn guard_read_answers_configured_false_and_the_problem_for_a_corrupt_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(guard::FILE), "[]").expect("fixture writes an array");
        let snapshot = guard_read(dir.path()).expect("the read stays honest, it does not panic");
        assert_eq!(snapshot["configured"], json!(false));
        assert!(
            snapshot["problem"].is_string(),
            "the problem is surfaced: {snapshot}"
        );
        // And a write over unparseable bytes fails closed.
        let problem = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "autoCycleVram": false }"#),
            Some(true),
        )
        .expect_err("merging into unparseable bytes is forbidden");
        assert!(
            problem.contains(guard::FILE),
            "problem names the file: {problem}"
        );
    }

    #[test]
    fn guard_atomic_write_survives_a_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        guard_write(
            dir.path(),
            None,
            &patch(
                r#"{ "unloadCommand": "u.bat", "restoreCommand": "r.bat",
                    "readyUrl": "http://127.0.0.1:18502/health",
                    "watchdog": { "faultThreshold": 3 } }"#,
            ),
            Some(true),
        )
        .expect("write applies");
        let snapshot = guard_read(dir.path()).expect("reopen reads the new bytes");
        assert_eq!(snapshot["configured"], json!(true));
        assert_eq!(
            snapshot["watchdog"]["faultThreshold"],
            json!(3),
            "raw block rides verbatim"
        );
        // The boot reader accepts the same bytes.
        let config = guard::load(dir.path())
            .expect("boot validates")
            .expect("present");
        assert_eq!(config.ready_url, "http://127.0.0.1:18502/health");
    }

    /// M16 FIX-B native home: the panel's three cap fields ride the same
    /// confirm wall as the watchdog block. The block is raw and optional (one
    /// whole-block patch like watchdog); an out-of-bounds number is refused at
    /// WRITE time by the boot laws naming its key, and the null arm clears the
    /// block back to the shipped defaults.
    #[test]
    fn guard_write_carries_the_caps_block_three_state_and_refuses_out_of_range_naming_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        guard_write(
            dir.path(),
            None,
            &patch(
                r#"{ "autoCycleVram": false,
                    "caps": { "uploadSingleMiB": 75, "downloadSingleMiB": 2000 } }"#,
            ),
            Some(true),
        )
        .expect("caps ride the guard write");
        let snapshot = guard_read(dir.path()).expect("read after");
        assert_eq!(snapshot["caps"]["uploadSingleMiB"], json!(75));
        assert_eq!(snapshot["caps"]["downloadSingleMiB"], json!(2000));
        // Out of bounds refuses the write naming the key (no clamp, never a
        // default past a value the plane cannot trust), and the file keeps its
        // previous bytes.
        let problem = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "caps": { "jobUploadMiB": 8193 } }"#),
            Some(true),
        )
        .expect_err("an untrusted cap is refused");
        assert!(problem.contains("caps.jobUploadMiB"), "{problem}");
        let problem = guard_write(
            dir.path(),
            None,
            &patch(r#"{ "caps": { "uploadSingleMiB": 0 } }"#),
            Some(true),
        )
        .expect_err("a zero cap is refused");
        assert!(problem.contains("caps.uploadSingleMiB"), "{problem}");
        let snapshot = guard_read(dir.path()).expect("the refusals wrote nothing");
        assert_eq!(snapshot["caps"]["uploadSingleMiB"], json!(75));
        // The three-state null arm clears the block to the shipped law, and
        // the boot reader then resolves the defaults.
        guard_write(dir.path(), None, &patch(r#"{ "caps": null }"#), Some(true))
            .expect("clearing to default is legal");
        let snapshot = guard_read(dir.path()).expect("read after the clear");
        assert_eq!(
            snapshot["caps"],
            json!(null),
            "cleared to the shipped default"
        );
        let config = guard::load(dir.path())
            .expect("boot validates")
            .expect("present");
        assert_eq!(config.caps, super::super::caps::Caps::default());
    }

    /* -------- defaults: same sheet, same engine, same walls -------- */

    #[test]
    fn defaults_bridge_write_hits_the_same_sheet_bytes_as_defaults_write() {
        // Byte parity: the bridge writes THROUGH defaults::write — one logic home,
        // one sheet file, no parallel serialization.
        let bridge_dir = tempfile::tempdir().expect("tempdir");
        let engine_dir = tempfile::tempdir().expect("tempdir");
        defaults_write(
            bridge_dir.path(),
            None,
            "anima:t2i",
            &patch(r#"{ "steps": 35, "sampler": "er_sde" }"#),
            Some(true),
        )
        .expect("defaults write applies");
        let sheet = defaults::load(bridge_dir.path())
            .expect("valid")
            .expect("present");
        defaults::write(engine_dir.path(), &sheet).expect("engine write");
        let bridge_bytes =
            std::fs::read(bridge_dir.path().join(defaults::FILE)).expect("bridge bytes");
        let engine_bytes =
            std::fs::read(engine_dir.path().join(defaults::FILE)).expect("engine bytes");
        assert_eq!(
            bridge_bytes, engine_bytes,
            "byte parity with the defaults engine"
        );
    }

    #[test]
    fn defaults_bridge_patch_uses_the_engine_three_state_merge() {
        let dir = tempfile::tempdir().expect("tempdir");
        defaults_write(
            dir.path(),
            None,
            "anima:t2i",
            &patch(r#"{ "steps": 35, "cfg": 4 }"#),
            Some(true),
        )
        .expect("first write");
        defaults_write(
            dir.path(),
            None,
            "anima:t2i",
            &patch(r#"{ "cfg": null }"#),
            Some(true),
        )
        .expect("second write");
        let sheet = defaults::load(dir.path()).expect("valid").expect("present");
        let entry = &sheet.combos["anima:t2i"];
        assert_eq!(entry.steps, Some(35), "absent key keeps");
        assert_eq!(entry.cfg, None, "explicit null clears to fall-through");
    }

    #[test]
    fn defaults_confirm_false_writes_nothing_and_answers_the_preview() {
        let dir = tempfile::tempdir().expect("tempdir");
        let answer = defaults_write(
            dir.path(),
            None,
            "anima:t2i",
            &patch(r#"{ "steps": 35 }"#),
            Some(false),
        )
        .expect("confirm-false answers the preview");
        assert_eq!(answer["applied"], json!(false));
        assert_eq!(answer["after"]["steps"], json!(35));
        assert_eq!(answer["changes"], json!(["steps"]));
        assert!(
            !dir.path().join(defaults::FILE).exists(),
            "confirm-false wrote NOTHING"
        );
    }

    #[test]
    fn defaults_mid_cycle_write_is_refused_while_the_cell_is_claimed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cell = cycle::CycleCell::new(dir.path());
        let cycle_id = cell.claim(CyclePhase::Unloading).expect("test claim");
        let problem = defaults_write(
            dir.path(),
            Some(&cell),
            "anima:t2i",
            &patch(r#"{ "steps": 35 }"#),
            Some(true),
        )
        .expect_err("a live cycle refuses defaults writes (the drain reads the sheet)");
        assert!(
            problem.contains("unloading"),
            "refusal names the phase: {problem}"
        );
        assert!(
            problem.contains(&cycle_id),
            "refusal names the cycle: {problem}"
        );
        assert!(
            !dir.path().join(defaults::FILE).exists(),
            "mid-cycle refusal wrote nothing"
        );
        cell.finish(json!({ "ok": true, "cycleId": cycle_id }));
    }

    #[test]
    fn defaults_refusals_name_the_offending_key_and_unknown_family_closes() {
        let dir = tempfile::tempdir().expect("tempdir");
        for (key, wanted) in [
            ("anima", "anima"),
            ("anima:t2o", "t2o"),
            ("nope:t2i", "nope"),
        ] {
            let problem = defaults_write(dir.path(), None, key, &patch("{}"), Some(true))
                .expect_err("refused key");
            assert!(problem.contains(wanted), "problem names it: {problem}");
        }
    }

    #[test]
    fn defaults_read_answers_the_empty_sheet_when_absent_and_names_the_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = defaults_read(dir.path()).expect("absent answers the empty sheet");
        assert_eq!(snapshot["configured"], json!(false));
        assert_eq!(
            snapshot["sheet"]["version"],
            json!(u64::from(defaults::SHEET_VERSION))
        );
        assert!(
            snapshot["sourcePath"]
                .as_str()
                .is_some_and(|path| path.contains(defaults::FILE)),
            "honest source path: {snapshot}"
        );
    }

    #[test]
    fn defaults_read_fails_closed_on_a_corrupt_sheet() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(defaults::FILE), "{ not json")
            .expect("fixture writes corrupt bytes");
        let problem = defaults_read(dir.path()).expect_err("corrupt fails closed");
        assert!(
            problem.contains(defaults::FILE),
            "problem names the file: {problem}"
        );
    }
}
