# DEAS product and architecture decisions

[Documentation index](README.md) · [Plan](PLAN.md) · [Project rules](PROJECT-RULES.md)

## Authority and status

**Accepted target contract, not an implementation or runtime-acceptance claim.** The owner approved these decisions in the product/architecture interview and authorized recording them here. This document governs product scope and architecture boundaries; [PROJECT-RULES.md](PROJECT-RULES.md) governs engineering/safety requirements and [PLAN.md](PLAN.md) is the single status and open-work list. Changing a decision requires explicit owner approval. Approving documentation does not authorize implementation, model downloads, external-service changes, commits, publication or releases.

The interview's first-milestone block (an image-first persistent SDXL project workflow that held back other integrations, Q15–Q19) was withdrawn by the owner and is no longer part of this contract; it is in Git history.

## Current scope

- **Global recent-job history instead of project archives.** Executed settings are kept as one global history of the last 10 executed jobs in one bounded local JSON file: effective settings, status and references to existing outputs, without media copies, model weights or credentials. Restoring settings is explicit and never starts computation; missing files show as missing; evicting an entry removes metadata only. Delivered in 0.1.55.
- **Deferred:** managed generated-PNG adoption, immutable i2i revision lineage and full persistent-project recovery. Existing project drafts and their files stay supported; do not remove or silently expand them. The project decisions below remain the target if that work is resumed.
- **Integrations need explicit owner priority.** New model families, enhancement, assembly, training and other large integrations are started only when the owner prioritizes them (as was done for MOSS, image references, TVE, learned latent upscale, GGUF and YuE2). Deferring the project milestone does not waive testing, safe writes or platform evidence for changed behavior.
- **Platform evidence:** Linux may pass reference acceptance first; Windows architecture/build support is maintained, and Windows artifacts stay experimental until their own native runtime acceptance (see [project rules §4](PROJECT-RULES.md#4-linux-and-windows-are-required-targets)).

## Product and execution boundary

- **Q2 — Primary audience:** experienced local AI users first. Beginner convenience follows; workflow developers and beginners are not simultaneous equal-priority audiences.
- **Q3 — Core value:** turn creative intent into a controllable, repeatable media workflow. Setup, Library, downloads and Forge support that workflow; collecting tools in tabs is not the product goal.
- **Q4 — Unit of work:** a persistent project owns inputs, authored settings, model/workflow references, executed jobs and results. Repeatability must survive application restart. Large model files need not be copied into projects; missing or changed dependencies must be visible.
- **Q5 — Executor:** ComfyUI remains the generation executor for the foreseeable product phase. DEAS owns intent, validation, job control and results. Do not introduce a universal backend abstraction for hypothetical future consumers; other tools may execute specific supported tasks.
- **Q6 — Studio completeness:** a supported Studio workflow must work without graph repair in the Comfy editor. Offer a bounded, clearly declared supported surface rather than promise arbitrary graph compatibility.
- **Q7 — Repeatability:** retain the exact effective submitted settings, seed, input identities, model identities and recipe/backend versions. Missing dependencies block reruns; never silently substitute them. This is traceable re-execution, not a promise of pixel-identical output across hardware/runtime changes.
- **Q22 — Initial interaction model:** one guided workspace for inputs/settings, a readable run plan, results and revisions. No freely wired second graph editor. Reuse current UI components; this decision is not a wholesale redesign authorization.
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
