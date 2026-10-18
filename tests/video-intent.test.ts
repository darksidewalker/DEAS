import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkCount, videoFrames } from '../src/lib/videoIntent.ts';
import { nextStep, resolveClip, type ContinuityPlan } from '../src/lib/continuity.ts';

test('frame counts follow the owner workflows: 8k+1 for LTX/Wan, 17k+5 at 24 fps for MiniMax H3', () => {
  assert.equal(videoFrames('wan', 5, 16), 81);
  assert.equal(videoFrames('ltx-2', 5, 24), 121);
  assert.equal(videoFrames('ltx-2', 2, 24), 49);
  assert.equal(videoFrames('minimax-h3', 5, 24), 124);
  assert.equal(videoFrames('minimax-h3', 2, 24), 56);
  assert.equal(videoFrames('minimax-h3', 0.1, 24), 5);
});

test('chunk count is the FastFidelity formula max(1, round((frames·w·h/120e6)^1.3·0.5·headroom)); 1 means no chunking node', () => {
  assert.equal(chunkCount(81, 528, 768, 1), undefined);
  assert.equal(chunkCount(121, 1920, 1088, 4), Math.round(((121 * 1920 * 1088) / 120_000_000) ** 1.3 * 0.5 * 4));
  assert.equal(chunkCount(121, 1920, 1088, 4), 5);
});

test('continuity plan runs steps in order and pins the newest child clip of the previous step', () => {
  const plan: ContinuityPlan = { session: 'deas-ab12', outputMode: 'full', steps: [{ id: 'a', seconds: 5, action: '' }, { id: 'b', seconds: 3, action: 'she turns' }, { id: 'c', seconds: 2, action: 'cut' }] };
  assert.deepEqual(nextStep(plan), { index: 0, continuity: { session: 'deas-ab12', sourceId: '', capture: true, action: '', outputMode: 'full' } });
  const clips = [{ clipId: 'r1', parent: null, frames: 124, completed: 1, export: null }, { clipId: 'r2', parent: null, frames: 124, completed: 2, export: null }, { clipId: 'k1', parent: 'r2', frames: 200, completed: 3, export: null }];
  assert.equal(resolveClip(clips, undefined), 'r2');
  plan.steps[0].clipId = 'r2';
  assert.equal(nextStep(plan)?.continuity.sourceId, 'r2');
  assert.equal(nextStep(plan)?.continuity.action, 'she turns');
  assert.equal(resolveClip(clips, 'r2'), 'k1');
  assert.equal(resolveClip(clips, 'nope'), undefined);
  plan.steps[1].clipId = undefined; plan.steps[2].clipId = 'k9';
  assert.equal(nextStep(plan)?.index, 1);
  plan.steps[1].clipId = 'k1';
  assert.equal(nextStep(plan), null);
});
