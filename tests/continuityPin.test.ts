import test from 'node:test';
import assert from 'node:assert/strict';
import { pinStep, resolveClip, type ContinuityPlan } from '../src/lib/continuity.ts';

const plan = (): ContinuityPlan => ({ session: 's1', outputMode: 'segment', steps: [{ id: 'a', seconds: 5, action: 'x' }, { id: 'b', seconds: 5, action: 'y' }] });

test('pinning records the clip and job on that step only and leaves the input untouched', () => {
  const p = plan();
  const next = pinStep(p, 1, 'clip9', 'job9');
  assert.deepEqual(next.steps, [{ id: 'a', seconds: 5, action: 'x' }, { id: 'b', seconds: 5, action: 'y', clipId: 'clip9', jobId: 'job9' }]);
  assert.equal(p.steps[1].clipId, undefined);
  assert.equal(next.session, 's1');
  assert.deepEqual(pinStep(p, 7, 'c', 'j').steps, p.steps);
});

test('the newest clip that continues the previous one is the pinned clip', () => {
  const clips = [{ clipId: 'root', parent: null, frames: 124, completed: 1, export: null }, { clipId: 'k1', parent: 'root', frames: 241, completed: 2, export: null }, { clipId: 'k2', parent: 'root', frames: 241, completed: 5, export: null }];
  assert.equal(resolveClip(clips as never, undefined), 'root');
  assert.equal(resolveClip(clips as never, 'root'), 'k2');
  assert.equal(resolveClip(clips as never, 'none'), undefined);
});
