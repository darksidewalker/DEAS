/**
 * Movie Maker chains (UX-22d4b1): the hand-over of a chain of continued shots. Generate holds the chain's continuity plan apart from the
 * user's own, runs it with its own Run all (first take, then each shot continues the clip before it) and reports each shot's clip back.
 * This builds the hand-over only; nothing runs here.
 */
import { chainPlan, chains, chainSession, type Chain } from './movieChains.ts';
import { SHOT_FAMILY, movieCanvas, sceneParts, shotPrompt, shotSettings, type ShotEnv } from './movieSegments.ts';
import { renderSampling } from './movieRender.ts';
import type { MovieManifest } from './movieManifest.ts';
import type { WizardHandoff } from './wizards.ts';

export type ChainHandoff = { handoff: Omit<WizardHandoff, 'n'>; skipped: number; actualSeconds: number[] } | { blocked: string; detail?: string };
/** The chain a shot belongs to, with its position among the movie's chains. */
export function chainOf(m: MovieManifest, shotId: string): { chain: Chain; index: number } | undefined {
  const all = chains(m), index = all.findIndex(c => c.ids.includes(shotId));
  return index < 0 ? undefined : { chain: all[index], index };
}
/**
 * The hand-over for a whole chain. The references of every scene in the chain are the REF2VA references of all its steps (the plan keeps
 * them for the continuations), so a person who only appears in a later scene is still available; the first scene's frames start the take.
 * `blocked` is an i18n key; `detail` carries the first refusal of the family rules for display.
 */
export function chainHandoff(m: MovieManifest, chain: Chain, index: number, defaultModel: { name: string; path: string }, run: boolean, toSrc: (path: string) => string, env?: ShotEnv, referenceMode = false): ChainHandoff {
  if (referenceMode && chain.ids.length > 1) return { blocked: 'wizards.movie.shot.audioNoChain' };
  const shots = chain.ids.map(id => m.items.find(i => i.id === id && i.kind === 'segment')!);
  if (shots.some(s => !s)) return { blocked: 'wizards.movie.shot.unknown' };
  // The continuity plan carries one model and one LoRA set for the whole chain: the first shot's (continued shots inherit them).
  const settings = shotSettings(shots[0], defaultModel, env);
  if ('blocked' in settings) return settings;
  const { model, loras } = settings;
  const planned = chainPlan(m, chain, chainSession(m.id, index));
  if (planned.problems.length) return { blocked: 'wizards.movie.shot.chainProblem', detail: planned.problems[0] };
  const parts = sceneParts(shots, toSrc);
  if ('blocked' in parts) return parts;
  if (parts.pipeline === 'v2v') return { blocked: 'wizards.movie.shot.chainSource' };
  const canvas = movieCanvas(m);
  const first = shots[0];
  return {
    skipped: 0, actualSeconds: planned.seconds,
    handoff: {
      wizard: 'movie', strategy: first.id, pipeline: parts.pipeline, source: 'movie', model,
      ...(parts.frames ? { frames: parts.frames } : {}), ...(parts.videoRefs ? { videoRefs: parts.videoRefs } : {}),
      positive: shotPrompt(m, first), ...canvas, ...renderSampling(m, first, SHOT_FAMILY, model.name, defaultModel.name), seconds: first.seconds, run, ...(loras.length ? { loras } : {}),
      continuity: { plan: planned.plan, shotIds: chain.ids },
    },
  };
}
