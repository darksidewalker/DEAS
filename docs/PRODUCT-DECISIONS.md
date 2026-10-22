# DEAS product and architecture decisions

[Documentation index](README.md) · [Current implementation status](IMPLEMENTATION-STATUS.md) · [Project rules](PROJECT-RULES.md)

## Authority and status

**Accepted target contract, not an implementation or runtime-acceptance claim.** The owner approved the decisions below in the product/architecture interview (Q2–Q26) and explicitly authorized recording them in repository documentation. Q1 selected whole-product/architecture review rather than only the next video slice.

This document governs product scope, architecture boundaries and the first acceptance milestone. [PROJECT-RULES.md](PROJECT-RULES.md) governs engineering/safety requirements; [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) remains the single delivery/status index. This decision set supersedes older conflicting delivery priorities, not recorded evidence or already implemented features. Broader AiO work remains a long-term direction, not parallel first-milestone scope. Changing these decisions requires explicit owner approval.

This documentation approval does not authorize implementation, model downloads, external-service changes, commits, publication or releases. No version bump accompanies it.

## Owner scope correction — lightweight global history

The owner subsequently reduced the next scope: executed settings are useful as one **global history/backlog of the last 10 executed jobs**, not a per-project or per-render project archive. A single bounded local JSON file is the proposed smallest storage choice; record effective settings, status and references to existing output files, without copying media, model weights or credentials. Restoring settings is explicit and never starts computation. Missing files are shown as missing. Evicting an old history entry removes metadata only, never its output files.

Managed generated PNG adoption, immutable i2i revision lineage and the full persistent SDXL project/recovery/acceptance milestone are **deferred as excessive for the current workflow**, not prerequisites for this history. Preserve existing project-draft/import/export features and their files; do not remove or expand them silently. Keep ordinary correctness, error, source-preservation and platform checks for changed behavior; deferring the large project milestone does not waive testing or permit automatic resubmission. Further integrations require their own explicit priority rather than inheriting the old image-milestone gate.

This correction supersedes conflicting project-first priorities and acceptance requirements in the interview/exit list below; those remain historical target detail, not the next implementation backlog. The history is planned, not delivered by this documentation correction.

## Product and execution boundary

- **Q2 — Primary audience:** experienced local AI users first. Beginner convenience follows; workflow developers and beginners are not simultaneous equal-priority audiences.
- **Q3 — Core value:** turn creative intent into a controllable, repeatable media workflow. Setup, Library, downloads and Forge support that workflow; collecting tools in tabs is not the product goal.
- **Q4 — Unit of work:** a persistent project owns inputs, authored settings, model/workflow references, executed jobs and results. Repeatability must survive application restart. Large model files need not be copied into projects; missing or changed dependencies must be visible.
- **Q5 — Executor:** ComfyUI remains the generation executor for the foreseeable product phase. DEAS owns intent, validation, job control and results. Do not introduce a universal backend abstraction for hypothetical future consumers; other tools may execute specific supported tasks.
- **Q6 — Studio completeness:** a supported Studio workflow must work without graph repair in the Comfy editor. Offer a bounded, clearly declared supported surface rather than promise arbitrary graph compatibility.
- **Q7 — Repeatability:** retain the exact effective submitted settings, seed, input identities, model identities and recipe/backend versions. Missing dependencies block reruns; never silently substitute them. This is traceable re-execution, not a promise of pixel-identical output across hardware/runtime changes.
- **Q10 — Expert editor:** the separate Comfy editor is outside the Studio project contract. No automatic bidirectional mapping between arbitrary graphs and Studio settings. A future explicit import may accept a declared supported subset. Protect Studio jobs from editor operations with global backend effects, or disable those operations where isolation cannot be established.

## Projects, assets and revisions

- **Q8 — Managed media:** projects manage the inputs they use and the completed results they adopt, so deleting an upload source or cleaning backend outputs does not break a saved project. Preserve source originals. Models remain external identified dependencies; account for the additional media storage cost.
- **Q11 — Immutable revisions:** executed stages retain their original inputs/settings. Edits create revisions and mark only downstream dependents stale. Preserve old results and immutable running submissions; do not automatically delete or recompute stale dependents. This does not require a free-form graph editor.
- **Q20 — Initial storage format:** a normal user-selected project folder with a versioned manifest, managed media and job records; relative internal references, atomic writes and initially one writer per project. No proprietary archive format or central project database is required. A closed project folder can be copied/backed up; it excludes model weights and credentials.
- **Q21 — Save versus execute:** automatically persist committed edits, but explicitly authorize computation, installation, paid-service access and external transfers. A settings change does not start a job. A rerun is a new job. Display saved state only after a successful durable write.
- **Q24 — Retention:** keep inputs, completed results and their job records until explicit deletion. Automatic cleanup is limited to clearly owned, no-longer-needed temporary data. Distinguish removing an item from a view from deleting its file; show affected revisions/dependencies before deletion. Insufficient disk space blocks new work instead of sacrificing old results.

## Jobs, resources and lifecycle

- **Q9 — Recovery:** reconcile persisted jobs with their backend after restart. Never automatically resubmit an uncertain request; show an explicit unknown outcome rather than risk duplicate GPU work. Recovery reconstructs state, not computation.
- **Q12 — Resource ownership:** default to serial execution of DEAS-controlled GPU-intensive generation, local LLM/vision, enhancement and future training. Enable concurrency only for measured compatible combinations. Separate processes/environments do not isolate VRAM; safely release owned model allocations where needed before the next workload. Never stop external services or assume their memory is free.
- **Q23 — View and application lifetime:** project/view changes may leave jobs running under their original project. When application exit would terminate owned computation, require an explicit decision. Do not introduce a hidden background service initially. Never stop an external service; reconcile any possibly continuing external job on reopen without resubmitting it.
- **Q26 — Partial completion:** preserve and expose valid completed products when a later stage fails or is cancelled. Do not call the whole workflow successful. A retry runs only the explicitly selected failed stage with documented inputs, not a hidden full rerun. This complements the existing paired baseline/processed-output contract.

## Extensions, updates and privacy

- **Q13 — Bounded extensions:** initially use reviewed DEAS modules and validated data packs. No marketplace, arbitrary downloaded executable plugins, dynamic loader or general plugin SDK before a concrete need justifies its cost and trust boundary. Reuse existing small module contracts.
- **Q14 — Explicit updates:** explicitly initiate runtime/recipe updates, validate before switching and keep project dependency identities. Require visible confirmation for necessary migrations. Never silently select latest versions on open. Report an unavailable old environment as missing; offer rollback only when the retained old version is actually usable.
- **Q25 — Local-first:** the creative workflow works without a cloud account. Prompts/media leave the local system only through explicitly configured external services or deliberate transfers; make remote Forge/vision destinations apparent before sending. No cloud fallback for local failures or insufficient VRAM. Keep credentials outside projects. Project folders contain sensitive prompts/media; a future sharing export must separately expose sensitive content/metadata choices rather than imply folders are automatically safe to share.

## First acceptance milestone

- **Q15 — Image first:** finish one persistent image workflow before requiring a complete video workflow. Keep existing video work, but its outstanding acceptance does not block image acceptance. The recorded native playback crash remains a separate unresolved defect, not an accepted permanent limitation; its existing deferred-fix status is not permission to repair it now.
- **Q16 — Hold expansion:** defer new training, enhancement, assembly and additional model-family integrations until the first workflow, failure paths and restart behavior work. Preserve existing features and fix necessary defects without opening new large integrations.
- **Q17 — Platform evidence:** Linux may pass reference acceptance first. Maintain Windows architecture/build support, but describe Windows artifacts as experimental until their own native runtime acceptance. Cross-compilation alone is insufficient; do not create Linux-only architectural dead ends.
- **Q18 — Real acceptance:** require actual model computation, native interaction, verified export, reopen with media/job records intact, understandable failure/cancellation states and measured resources. Fixtures/screenshots supplement rather than replace this evidence. Verification applies to the named hardware/model/runtime combination only.
- **Q19 — Reference workflow:** one fixed SDXL configuration: text → image → use the result as a new image-to-image revision → compare before/after → export PNG → close and reopen the project. Inspect the concrete checkpoint and suitability before executing. Forge, LoRAs, inpainting and upscaling are not prerequisites for this first acceptance; do not remove existing implementations.
- **Q22 — Initial interaction model:** one guided workspace for inputs/settings, a readable run plan, results and revisions. No freely wired second graph editor. Reuse current UI components; this decision is not a wholesale redesign authorization.

### Exit evidence to collect (all pending under this contract)

- [ ] Inspect/reuse existing project, asset, job, image recipe and UI code; map callers, migrations and tests before changing it. Do not assume a rewrite is needed.
- [ ] Select and record the exact compatible SDXL checkpoint/runtime, input fixture, effective recipe/settings and test hardware; obtain separate execution/download authorization where required.
- [ ] Execute the reference workflow in native Linux DEAS and verify decoded result/export files, revision lineage and immutable job records.
- [ ] Reopen the project with its managed inputs/results intact and no accidental submission. Distinguish saved drafts from executed effective settings.
- [ ] Exercise failed/cancelled stages, partial-result retention, uncertain submission/reconnect, app-exit decisions, disk/write failures, safe deletion and single-writer protection; preserve external services.
- [ ] Record reproducible workload conditions, latency/throughput, peak RAM/VRAM, idle resources and UI responsiveness. Set explicit workload-specific performance limits from evidence before declaring acceptance; no numeric performance threshold was agreed in the interview.
- [ ] Repeat native acceptance on Windows before claiming equivalent Windows runtime support. Keep builds, fixtures, native interaction and real computation as separate evidence.

Concrete checkpoint/version identities, low-level schema/migration design and measured performance limits are implementation-discovery work, not silently settled by the interview. Existing drafts/data must be inspected and preserved or explicitly migrated under the rules above. Record actual outcomes in [VERIFICATION.md](VERIFICATION.md) and summarize delivery state in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); do not check these gates off based on this document.
