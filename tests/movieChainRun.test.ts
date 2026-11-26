import test from 'node:test';
import assert from 'node:assert/strict';
import { addCast, newMovie, setBrief, setCastRefs } from '../src/lib/movieManifest.ts';
import { applyPlan } from '../src/lib/movieStory.ts';
import { chainHandoff, chainOf } from '../src/lib/movieChainRun.ts';

const model = { name: 'h3.safetensors', path: '/m/h3' };
const src = (p: string) => 'asset://' + p;
const shot = (title: string, seconds: number, continuous: boolean, castIds: string[] = []) => ({ title, prompt: title + ' action', seconds, castIds, continuous, dialogue: [] });
const film = (shots: ReturnType<typeof shot>[], refs = true) => {
  let m = setBrief(newMovie('movie-ab12cd34', 'F', 20, '16:9'), { story: 's' });
  m = addCast(m, 'actor', 'Anna', 'tall'); m = addCast(m, 'actor', 'Ben'); m = addCast(m, 'location', 'Street');
  if (refs) { m = setCastRefs(m, 'cast-1', ['/p/anna.png', '/p/x.mp4']); m = setCastRefs(m, 'cast-2', ['/p/ben.png']); m = setCastRefs(m, 'cast-3', ['/p/street.png', '/p/anna.png']); }
  return applyPlan(m, { lore: 'l', segments: shots });
};

test('a chain becomes one hand-over: first take prompt, the chain plan, and the cast pictures of every shot as references', () => {
  const m = film([shot('A', 5, false, ['cast-1', 'cast-3']), shot('B', 4, true, ['cast-2']), shot('C', 6, true, ['cast-1']), shot('D', 5, false)]);
  const found = chainOf(m, 'seg-2')!;
  assert.deepEqual([found.index, found.chain.ids], [0, ['seg-1', 'seg-2', 'seg-3']]);
  assert.deepEqual(chainOf(m, 'seg-4')!.chain.ids, ['seg-4']);
  assert.equal(chainOf(m, 'nope'), undefined);
  const r = chainHandoff(m, found.chain, found.index, model, true, src);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  const h = r.handoff;
  assert.deepEqual([h.wizard, h.strategy, h.pipeline, h.source, h.run, h.seconds, h.positive], ['movie', 'seg-1', 'ref2v', 'movie', true, 5, 'A action']);
  assert.deepEqual(h.references!.map(x => x.path), ['/p/anna.png', '/p/street.png', '/p/ben.png']); // first use order, no repeats, no video
  assert.deepEqual(h.labels, [undefined, 'place', undefined]);
  assert.equal(r.skipped, 1);
  assert.deepEqual(h.continuity!.shotIds, ['seg-1', 'seg-2', 'seg-3']);
  assert.deepEqual(h.continuity!.plan, { enabled: true, session: 'mm-movie-ab12cd34-c1', outputMode: 'segment', overlapFrames: 22, useReferences: true,
    steps: [{ id: 'seg-1', seconds: 5, action: 'A action' }, { id: 'seg-2', seconds: 4, action: 'B action' }, { id: 'seg-3', seconds: 6, action: 'C action' }] });
  assert.deepEqual(r.actualSeconds, [124 / 24, 102 / 24, 136 / 24]);
});

test('a later chain gets its own session; no pictures means text-to-video with the cast text in the first prompt', () => {
  const m = film([shot('A', 5, false), shot('B', 5, false, ['cast-1']), shot('C', 5, true)], false);
  const second = chainOf(m, 'seg-2')!;
  const r = chainHandoff(m, second.chain, second.index, model, false, src);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  assert.deepEqual([r.handoff.pipeline, r.handoff.references, r.handoff.run, r.handoff.continuity!.plan.session], ['t2v', undefined, false, 'mm-movie-ab12cd34-c2']);
  assert.match(r.handoff.positive, /^B action Cast: Anna — tall\.$/);
});

test('what the family rules refuse blocks the chain with the first reason', () => {
  const m = film([shot('Long', 16, false), shot('B', 5, true)]);
  const c = chainOf(m, 'seg-1')!;
  const r = chainHandoff(m, c.chain, c.index, model, true, src);
  assert.equal('blocked' in r && r.blocked, 'wizards.movie.shot.chainProblem');
  assert.match('detail' in r ? r.detail! : '', /“Long”/);
  const many = film([shot('A', 5, false, ['cast-1'])]);
  const withMany = setCastRefs(many, 'cast-1', Array.from({ length: 13 }, (_, i) => `/p/${i}.png`));
  const k = chainOf(withMany, 'seg-1')!;
  assert.deepEqual(chainHandoff(withMany, k.chain, k.index, model, true, src), { blocked: 'wizards.movie.shot.tooManyRefs' });
});
