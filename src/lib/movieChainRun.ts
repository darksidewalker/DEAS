/**
 * Movie Maker chains (UX-22d4b1): the hand-over of a chain of continued shots. Generate holds the chain's continuity plan apart from the
 * user's own, runs it with its own Run all (first take, then each shot continues the clip before it) and reports each shot's clip back.
 * This builds the hand-over only; nothing runs here.
 */
import { chainPlan, chains, chainSession, type Chain } from './movieChains.ts';
import { H3_REFERENCE_LIMIT, shotPictures, shotPrompt } from './movieSegments.ts';
import type { MovieManifest } from './movieManifest.ts';
import { wizardCanvas, type WizardHandoff, type WizardPicture } from './wizards.ts';

export type ChainHandoff = { handoff: Omit<WizardHandoff, 'n'>; skipped: number; actualSeconds: number[] } | { blocked: string; detail?: string };
/** The chain a shot belongs to, with its position among the movie's chains. */
export function chainOf(m: MovieManifest, shotId: string): { chain: Chain; index: number } | undefined {
  const all = chains(m), index = all.findIndex(c => c.ids.includes(shotId));
  return index < 0 ? undefined : { chain: all[index], index };
}
/**
 * The hand-over for a whole chain. Cast pictures of every shot in the chain are the REF2VA references of all its steps (the plan keeps
 * them for the continuations), so an actor who only appears in a later shot is still available; with no pictures the chain is text-to-video.
 * `blocked` is an i18n key; `detail` carries the first refusal of the family rules for display.
 */
export function chainHandoff(m: MovieManifest, chain: Chain, index: number, model: { name: string; path: string }, run: boolean, toSrc: (path: string) => string): ChainHandoff {
  const shots = chain.ids.map(id => m.items.find(i => i.id === id && i.kind === 'segment')!);
  if (shots.some(s => !s)) return { blocked: 'wizards.movie.shot.unknown' };
  const planned = chainPlan(m, chain, chainSession(m.id, index));
  if (planned.problems.length) return { blocked: 'wizards.movie.shot.chainProblem', detail: planned.problems[0] };
  const { picks, skipped } = shotPictures(m, shots);
  if (picks.length > H3_REFERENCE_LIMIT) return { blocked: 'wizards.movie.shot.tooManyRefs' };
  const [w, h] = m.aspect.split(':').map(Number);
  const size = w > 0 && h > 0 ? wizardCanvas('minimax-h3', { width: w * 100, height: h * 100 }) : undefined;
  const refs: WizardPicture[] = picks.map(p => ({ name: p.path.split(/[\\/]/).pop() ?? p.path, path: p.path, src: toSrc(p.path) }));
  const first = shots[0];
  return {
    skipped, actualSeconds: planned.seconds,
    handoff: {
      wizard: 'movie', strategy: first.id, pipeline: refs.length ? 'ref2v' : 't2v', source: 'movie', model,
      ...(refs.length ? { references: refs, labels: picks.map(p => p.label), notes: picks.map(p => p.note) } : {}),
      positive: shotPrompt(m, first, !refs.length), ...(size ? { size } : {}), seconds: first.seconds, run,
      continuity: { plan: planned.plan, shotIds: chain.ids },
    },
  };
}
