/**
 * Movie Maker assembly (UX-22d6): joins the recorded shot clips, in plan order, into one film with the existing model-free Join clips
 * recipe (`h3-join`, kind `files`) — no second assembler and no new join semantics. Shots are cuts, so the join is a plain ordered
 * concatenation with the pack's own preflight; the result is recorded on the final item. Every backend/native step is injectable.
 */
import { completeItem, type MovieManifest } from './movieManifest.ts';
import type { H3JoinIntentV1 } from './videoIntent.ts';

const VIDEO = /\.(mp4|webm|mkv|mov)$/i;
export interface AssemblyClip { id: string; title: string; path: string; seconds?: number }
export type AssemblyPlan = { ok: true; clips: AssemblyClip[]; expectedSeconds: number | undefined } | { ok: false; missing: { id: string; title: string; why: 'none' | 'outdated' | 'failed' | 'not-a-clip' }[] };

/** The ordered clips to join, or which shots keep the film from being assembled (not made, outdated, failed, not a video file, continued). */
export function assemblyPlan(m: MovieManifest): AssemblyPlan {
  const shots = m.items.filter(i => i.kind === 'segment');
  const missing: { id: string; title: string; why: 'none' | 'outdated' | 'failed' | 'not-a-clip' }[] = [];
  const clips: AssemblyClip[] = [];
  shots.forEach(s => {
    const result = s.revisions.find(r => r.n === s.revision)?.result;
    const why = s.state === 'stale' ? 'outdated' : s.state === 'failed' ? 'failed' : s.state !== 'done' || !result ? 'none' : !VIDEO.test(result.outputId) ? 'not-a-clip' : undefined;
    if (why) missing.push({ id: s.id, title: s.title || s.id, why });
    else clips.push({ id: s.id, title: s.title, path: result!.outputId, ...(result!.seconds ? { seconds: result!.seconds } : {}) });
  });
  if (!shots.length) return { ok: false, missing: [] };
  if (missing.length) return { ok: false, missing };
  const known = clips.every(c => c.seconds !== undefined);
  return { ok: true, clips, expectedSeconds: known ? Math.round(clips.reduce((a, c) => a + c.seconds!, 0) * 1000) / 1000 : undefined };
}

export interface AssembleDeps {
  inspect: (path: string) => Promise<{ sourceId?: string; blockers: string[]; durationSeconds: number | null } | null>;
  upload: (sourceId: string) => Promise<string>;
  preflight: (filenames: string[]) => Promise<{ ok: boolean; issues: string[]; seconds: number }>;
  epoch: () => Promise<{ epoch: number; stopping: boolean }>;
  run: (intent: H3JoinIntentV1, epoch: number) => Promise<AssemblyJob>;
  wait: (job: AssemblyJob, active: () => boolean) => Promise<AssemblyJob>;
}
export interface AssemblyJob { id: string; state: string; outputRoot?: string | null; outputs: { filename: string; subfolder: string }[] }
export class AssemblyError extends Error {
  code: 'blocked' | 'failed' | 'cancelled';
  constructor(code: 'blocked' | 'failed' | 'cancelled', message: string) { super(message); this.code = code; }
}
const outputPath = (job: AssemblyJob): string | undefined => {
  const o = job.outputs.find(x => VIDEO.test(x.filename)), root = job.outputRoot;
  if (!o || !root) return undefined;
  const sep = root.includes('\\') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), ...o.subfolder.split(/[\\/]+/).filter(Boolean), o.filename].join(sep);
};
export interface AssemblyResult { job: AssemblyJob; path: string; seconds?: number; expectedSeconds?: number; mismatch: boolean }

/**
 * Copies each clip into the backend Input folder, asks the pack's own preflight, runs the join and returns the output path. Stops cleanly
 * between steps when `active()` turns false. Throws `AssemblyError` (blocked: nothing was run; failed; cancelled).
 */
export async function assembleMovie(m: MovieManifest, deps: AssembleDeps, active: () => boolean, onStep: (step: 'copy' | 'check' | 'join', n?: number, total?: number) => void = () => undefined): Promise<AssemblyResult> {
  const plan = assemblyPlan(m);
  if (!plan.ok) throw new AssemblyError('blocked', 'Some shots are not ready to be joined.');
  const names: string[] = [];
  const stop = () => { if (!active()) throw new AssemblyError('cancelled', 'Stopped.'); };
  for (const [n, clip] of plan.clips.entries()) {
    stop(); onStep('copy', n + 1, plan.clips.length);
    const seen = await deps.inspect(clip.path);
    if (!seen?.sourceId || seen.blockers.length) throw new AssemblyError('blocked', `The clip of “${clip.title || clip.id}” cannot be used (${seen?.blockers.join(', ') || 'missing'}).`);
    names.push(await deps.upload(seen.sourceId));
  }
  stop(); onStep('check');
  const check = await deps.preflight(names);
  if (!check.ok) throw new AssemblyError('blocked', check.issues.join('; ') || 'The join check refused these clips.');
  stop(); onStep('join');
  const { epoch, stopping } = await deps.epoch();
  if (stopping) throw new AssemblyError('cancelled', 'The backend is stopping.');
  const intent: H3JoinIntentV1 = { recipeId: 'h3-join', version: 1, h3: { join: { kind: 'files', files: names.map(filename => ({ filename })), smoothAudioSeams: true } } };
  const started = await deps.run(intent, epoch);
  const done = await deps.wait(started, active);
  if (!active()) throw new AssemblyError('cancelled', 'Stopped.');
  if (done.id !== started.id || done.state !== 'succeeded') throw new AssemblyError('failed', 'The join did not finish.');
  const path = outputPath(done);
  if (!path) throw new AssemblyError('failed', 'The joined film has no readable file.');
  const expected = plan.expectedSeconds;
  return { job: done, path, seconds: check.seconds, ...(expected !== undefined ? { expectedSeconds: expected } : {}), mismatch: expected !== undefined && Math.abs(check.seconds - expected) > 0.25 };
}
/** Records the joined film on the final item. */
export const recordFilm = (m: MovieManifest, r: AssemblyResult): MovieManifest => {
  const final = m.items.find(i => i.id === 'final');
  if (!final) throw new Error('This movie has no final item; plan the story first.');
  return completeItem(m, final.id, { outputId: r.path, jobId: r.job.id, ...(r.seconds ? { seconds: r.seconds } : {}) });
};
