import { readCurrentWorkbench, runWorkbenchJob, stopWorkbenchJob, waitForWorkbenchJob, type JobStatus } from './jobs';
import { inspectVideoPostPath, uploadVideoPostSource } from './videoPost';
import type { AssembleDeps, AssemblyJob } from './movieAssemble';

/** The real backend/native steps of the assembly: the same inspect → upload → pack preflight → `h3-join` job as Continuity's Join clips. */
export function realAssembleDeps(endpoint: string, onJob: (job: JobStatus) => void): AssembleDeps {
  return {
    inspect: async path => { const v = await inspectVideoPostPath(path); return v ? { sourceId: v.sourceId, blockers: v.blockers, durationSeconds: v.durationSeconds } : null; },
    upload: sourceId => uploadVideoPostSource(endpoint, sourceId),
    preflight: async names => {
      const reply = await fetch(`${endpoint}/df_h3_continuity/assembly/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, rows: names.map(filename => ({ kind: 'media', filename, trim_start: 0, trim_end: null })), repair_transitions: false, audio_policy: 'smooth-seams', copy_video: false }) });
      const value = await reply.json();
      return { ok: value.ok === true, issues: Array.isArray(value.issues) ? value.issues.map(String) : [], seconds: Number(value.seconds) };
    },
    epoch: async () => { const s = await readCurrentWorkbench(); return { epoch: s.admissionEpoch, stopping: s.stopping }; },
    run: async (intent, epoch) => { const job = await runWorkbenchJob(endpoint, intent, epoch); onJob(job); return job as AssemblyJob; },
    wait: async (job, active) => { const full = job as JobStatus; const done = await waitForWorkbenchJob(full, active); onJob(done); return done as AssemblyJob; },
  };
}
export const stopAssemblyJob = (job: JobStatus) => stopWorkbenchJob(job);
