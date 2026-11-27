/**
 * Movie Maker continued shots (UX-22d4b0, model only — nothing runs): groups the shots into chains (a cut starts a new chain), and turns a
 * chain into the DEAS-owned MiniMax H3 continuity plan Studio already runs (`continuity.ts`): step 0 captures a first take, later steps
 * extend the clip the previous step produced, with `outputMode: 'segment'` so each step yields only its newly visible footage. The frame
 * arithmetic mirrors `jobs_video.rs::continuation_extension` / `continuation_window_start` and `videoIntent.ts::videoFrames`.
 */
import { isContinuityPlan, type ContinuityPlan, type ContinuityStep } from './continuity.ts';
import { shotPrompt } from './movieSegments.ts';
import type { MovieManifest } from './movieManifest.ts';

export const H3_FPS = 24;
/** Largest sampled window of a continuation: overlap + newly visible frames (`jobs_video.rs`: `362 - extension`). */
export const H3_WINDOW_FRAMES = 362;
export const H3_OVERLAPS = [73, 56, 39, 22, 5] as const;
export const DEFAULT_OVERLAP = 22;

export interface Chain { ids: string[] }
/** Shots in plan order, grouped so that every `continuous` shot (except the very first) joins the chain of the shot before it. */
export function chains(m: MovieManifest): Chain[] {
  const out: Chain[] = [];
  m.items.filter(i => i.kind === 'segment').forEach((s, n) => {
    if (n > 0 && s.continuous && out.length) out[out.length - 1].ids.push(s.id); else out.push({ ids: [s.id] });
  });
  return out;
}
/** Newly visible frames of a continued step for a requested length: whole 17-frame steps, at least one. */
export const extensionFrames = (seconds: number) => Math.max(1, Math.floor(seconds * H3_FPS / 17 + 0.5)) * 17;
/** Frames of a first take for a requested length (17k+5, snapped up). */
export const firstTakeFrames = (seconds: number) => { const n = Math.max(5, Math.round(seconds * H3_FPS)); return n + (((5 - (n % 17)) % 17) + 17) % 17; };
/** The hidden overlap the pack uses for a continued step: the largest of 73/56/39/22/5 that fits the requested context, the window and the source. */
export function overlapFor(requested: number, extension: number, sourceFrames: number): number | undefined {
  const available = Math.min(requested, H3_WINDOW_FRAMES - extension, sourceFrames);
  return H3_OVERLAPS.find(n => n <= available);
}
export interface ChainPlan { plan: ContinuityPlan; frames: number[]; seconds: number[]; problems: string[] }
/**
 * The continuity plan of one chain. `problems` lists what the family rules refuse (a first take over 362 frames, a continued step whose
 * window cannot fit, an unusable session id); an empty list means Studio can run the plan as it is. `session` must be a valid continuity id.
 */
export function chainPlan(m: MovieManifest, chain: Chain, session: string, overlap: number = DEFAULT_OVERLAP): ChainPlan {
  const problems: string[] = [];
  const shots = chain.ids.map(id => m.items.find(i => i.id === id && i.kind === 'segment'));
  const steps: ContinuityStep[] = [], frames: number[] = [];
  shots.forEach((s, n) => {
    if (!s) { problems.push(`Unknown shot ${chain.ids[n]}.`); return; }
    const seconds = s.seconds ?? 0, label = s.title || s.id;
    const f = n === 0 ? firstTakeFrames(seconds) : extensionFrames(seconds);
    if (n === 0 && f > H3_WINDOW_FRAMES) problems.push(`“${label}” is ${(f / H3_FPS).toFixed(2)} s as a first take; a take holds at most ${H3_WINDOW_FRAMES} frames.`);
    if (n > 0 && overlapFor(overlap, f, Number.MAX_SAFE_INTEGER) === undefined) problems.push(`“${label}” adds ${f} frames, which leaves no room for the overlap in a ${H3_WINDOW_FRAMES}-frame window.`);
    if (!(seconds > 0) || seconds > 15) problems.push(`“${label}” must last more than 0 and at most 15 seconds.`);
    frames.push(f);
    steps.push({ id: s.id, seconds, action: shotPrompt(m, s) });
  });
  const plan: ContinuityPlan = { enabled: true, session, outputMode: 'segment', overlapFrames: overlap as ContinuityPlan['overlapFrames'], useReferences: true, steps };
  if (!isContinuityPlan(plan)) problems.push('The chain is not a valid continuity plan (session id, 1–50 steps, step lengths).');
  return { plan, frames, seconds: frames.map(f => f / H3_FPS), problems };
}
/** Continuity session id of a chain: stable per movie and chain, valid for the pack (`[A-Za-z0-9_-]{1,80}`, never `_imports`). */
export const chainSession = (movieId: string, index: number) => `mm-${movieId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}-c${index + 1}`;
