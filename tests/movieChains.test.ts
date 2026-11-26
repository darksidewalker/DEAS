import test from 'node:test';
import assert from 'node:assert/strict';
import { addCast, newMovie, setBrief } from '../src/lib/movieManifest.ts';
import { applyPlan } from '../src/lib/movieStory.ts';
import { chainPlan, chainSession, chains, extensionFrames, firstTakeFrames, overlapFor } from '../src/lib/movieChains.ts';

const shot = (title: string, seconds: number, continuous: boolean) => ({ title, prompt: title + ' action', seconds, castIds: [], continuous, dialogue: [] });
const film = (shots: ReturnType<typeof shot>[]) => applyPlan(addCast(setBrief(newMovie('movie-ab12cd34', 'F'), { story: 's' }), 'actor', 'Anna'), { lore: 'l', segments: shots });

test('a cut starts a new chain; continued shots join the chain before them', () => {
  const m = film([shot('A', 5, false), shot('B', 5, true), shot('C', 5, true), shot('D', 5, false), shot('E', 5, true)]);
  assert.deepEqual(chains(m).map(c => c.ids), [['seg-1', 'seg-2', 'seg-3'], ['seg-4', 'seg-5']]);
  assert.deepEqual(chains(newMovie('x', 'x')), []);
  // A "continuous" first shot has nothing to continue and starts its own chain.
  assert.deepEqual(chains(film([shot('A', 5, true)])).map(c => c.ids), [['seg-1']]);
});

test('frame arithmetic follows the H3 grids', () => {
  assert.equal(firstTakeFrames(5), 124);
  assert.equal(firstTakeFrames(15), 362);
  assert.equal(firstTakeFrames(0.1), 5);
  assert.equal(extensionFrames(5), 119);
  assert.equal(extensionFrames(0.1), 17);
  assert.equal(overlapFor(22, 119, 300), 22);
  assert.equal(overlapFor(73, 340, 400), 22);
  assert.equal(overlapFor(73, 360, 400), undefined);
  assert.equal(overlapFor(73, 100, 30), 22);
});

test('a chain becomes a segment-mode continuity plan with the shot prompts as actions', () => {
  const m = film([shot('A', 5, false), shot('B', 4, true), shot('C', 6, true)]);
  const r = chainPlan(m, chains(m)[0], chainSession(m.id, 0));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.plan, { enabled: true, session: 'mm-movie-ab12cd34-c1', outputMode: 'segment', overlapFrames: 22, useReferences: true,
    steps: [{ id: 'seg-1', seconds: 5, action: 'A action' }, { id: 'seg-2', seconds: 4, action: 'B action' }, { id: 'seg-3', seconds: 6, action: 'C action' }] });
  assert.deepEqual(r.frames, [124, 102, 136]);
  assert.deepEqual(r.seconds, [124 / 24, 102 / 24, 136 / 24]);
});

test('what the family rules refuse is listed instead of being sent', () => {
  const m = film([shot('Long', 15.5, false), shot('B', 16, true)]);
  const r = chainPlan(m, chains(m)[0], chainSession(m.id, 0));
  assert.equal(r.problems.length, 5);
  assert.match(r.problems[0], /“Long” is 15\.\d+ s as a first take/);
  assert.match(r.problems[1], /“Long” must last more than 0 and at most 15/);
  assert.match(r.problems[2], /“B” adds 391 frames, which leaves no room/);
  assert.match(r.problems[3], /“B” must last more than 0 and at most 15/);
  assert.match(r.problems[4], /not a valid continuity plan/);
  // Even the longest allowed continued step (15 s = 357 frames) leaves 5 frames of overlap in the 362-frame window.
  assert.equal(chainPlan(film([shot('A', 5, false), shot('B', 15, true)]), { ids: ['seg-1', 'seg-2'] }, 'ok-1').problems.length, 0);
  assert.ok(chainPlan(m, { ids: ['nope'] }, 'bad id!').problems.some(p => /Unknown shot/.test(p)));
  assert.ok(chainPlan(m, chains(m)[0], '_imports').problems.some(p => /not a valid continuity plan/.test(p)));
  assert.equal(chainSession('movie-x/../y', 2), 'mm-movie-xy-c3');
});
