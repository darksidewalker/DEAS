import test from 'node:test';
import assert from 'node:assert/strict';
import { newMovie, setBrief, setSceneInputs, type MovieManifest, type SceneRef } from '../src/lib/movieManifest.ts';
import { applyPlan } from '../src/lib/movieStory.ts';
import { chainHandoff, chainOf } from '../src/lib/movieChainRun.ts';

const model = { name: 'h3.safetensors', path: '/m/h3' };
const src = (p: string) => 'asset://' + p;
const ref = (path: string, extra: Partial<SceneRef> = {}): SceneRef => ({ path, media: 'image', mediaMode: 'video', second: 0, strength: 1, ...extra });
const shot = (title: string, seconds: number, continuous: boolean) => ({ title, prompt: title + ' action', seconds, continuous, dialogue: [] });
const film = (shots: ReturnType<typeof shot>[]) => applyPlan(setBrief(newMovie('movie-ab12cd34', 'F', 20, '16:9'), { story: 's' }), { lore: 'l', segments: shots });
const withRefs = (m: MovieManifest) => {
  m = setSceneInputs(m, 'seg-1', { refs: [ref('/p/anna.png', { label: 'character-1' }), ref('/p/street.png', { label: 'place' })] });
  return setSceneInputs(m, 'seg-2', { refs: [ref('/p/ben.png'), ref('/p/anna.png', { label: 'character-1' })] });
};

test('a chain becomes one hand-over: first take prompt, the chain plan, and the references of every scene in it', () => {
  const m = withRefs(film([shot('A', 5, false), shot('B', 4, true), shot('C', 6, true), shot('D', 5, false)]));
  const found = chainOf(m, 'seg-2')!;
  assert.deepEqual([found.index, found.chain.ids], [0, ['seg-1', 'seg-2', 'seg-3']]);
  assert.deepEqual(chainOf(m, 'seg-4')!.chain.ids, ['seg-4']);
  assert.equal(chainOf(m, 'nope'), undefined);
  const r = chainHandoff(m, found.chain, found.index, model, true, src);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  const h = r.handoff;
  assert.deepEqual([h.wizard, h.strategy, h.pipeline, h.source, h.run, h.seconds, h.positive], ['movie', 'seg-1', 'ref2v', 'movie', true, 5, 'A action']);
  assert.deepEqual(h.videoRefs!.map(x => [x.path, x.label]), [['/p/anna.png', 'character-1'], ['/p/street.png', 'place'], ['/p/ben.png', undefined]]); // scene order, no repeats
  assert.deepEqual(h.continuity!.shotIds, ['seg-1', 'seg-2', 'seg-3']);
  assert.deepEqual(h.continuity!.plan, { enabled: true, session: 'mm-movie-ab12cd34-c1', outputMode: 'segment', overlapFrames: 22, useReferences: true,
    steps: [{ id: 'seg-1', seconds: 5, action: 'A action' }, { id: 'seg-2', seconds: 4, action: 'B action' }, { id: 'seg-3', seconds: 6, action: 'C action' }] });
  assert.deepEqual(r.actualSeconds, [124 / 24, 102 / 24, 136 / 24]);
});

test('a later chain gets its own session; no inputs means text-to-video; the first scene\'s frames start the take', () => {
  const m = film([shot('A', 5, false), shot('B', 5, false), shot('C', 5, true)]);
  const second = chainOf(m, 'seg-2')!;
  const r = chainHandoff(m, second.chain, second.index, model, false, src);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  assert.deepEqual([r.handoff.pipeline, r.handoff.videoRefs, r.handoff.run, r.handoff.continuity!.plan.session, r.handoff.positive], ['t2v', undefined, false, 'mm-movie-ab12cd34-c2', 'B action']);
  const framed = setSceneInputs(m, 'seg-2', { first: { path: '/p/f.png', media: 'image' } });
  const f = chainHandoff(framed, second.chain, second.index, model, false, src);
  assert.ok('handoff' in f && f.handoff.pipeline === 'i2v' && f.handoff.frames?.first?.path === '/p/f.png');
  // H3 cannot mix: frames on the first scene and references on a later one block the chain.
  const mixed = setSceneInputs(framed, 'seg-3', { refs: [ref('/p/x.png')] });
  assert.deepEqual(chainHandoff(mixed, second.chain, second.index, model, false, src), { blocked: 'wizards.movie.shot.mixedInputs' });
});

test('what the family rules refuse blocks the chain with the first reason', () => {
  const m = film([shot('Long', 16, false), shot('B', 5, true)]);
  const c = chainOf(m, 'seg-1')!;
  const r = chainHandoff(m, c.chain, c.index, model, true, src);
  assert.equal('blocked' in r && r.blocked, 'wizards.movie.shot.chainProblem');
  assert.match('detail' in r ? r.detail! : '', /“Long”/);
  const many = setSceneInputs(film([shot('A', 5, false)]), 'seg-1', { refs: Array.from({ length: 13 }, (_, i) => ref(`/p/${i}.png`)) });
  const k = chainOf(many, 'seg-1')!;
  assert.deepEqual(chainHandoff(many, k.chain, k.index, model, true, src), { blocked: 'wizards.movie.shot.tooManyRefs' });
});
