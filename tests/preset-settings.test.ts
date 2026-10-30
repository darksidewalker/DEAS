import test from 'node:test';
import assert from 'node:assert/strict';
import { changedCount, diff, merge, overrides, resolve } from '../src/lib/presetSettings.ts';

test('presets keep only nested differences from the defaults', () => {
  const defaults = { 'studio.run.steps': 20, 'studio.run.video': { seconds: 5, fps: 24, extra: { a: 1 } }, 'studio.run.loras': [] };
  const captured = { 'studio.run.steps': 20, 'studio.run.video': { seconds: 8, fps: 24, extra: { a: 1 } }, 'studio.run.loras': [{ name: 'x', strength: 1 }] };
  const over = overrides(captured, defaults);
  assert.deepEqual(over, { 'studio.run.video': { seconds: 8 }, 'studio.run.loras': [{ name: 'x', strength: 1 }] });
  assert.equal(changedCount(over), 2);
  assert.equal(diff({ a: [1, 2] }, { a: [1, 2] }), undefined);
});

test('a changed default reaches every field the preset left alone', () => {
  const over = { 'studio.run.video': { seconds: 8 } };
  const later = { 'studio.run.steps': 30, 'studio.run.video': { seconds: 5, fps: 30, added: true } };
  assert.deepEqual(resolve(over, later), { 'studio.run.steps': 30, 'studio.run.video': { seconds: 8, fps: 30, added: true } });
  // The same override is still the only highlight against the new defaults.
  assert.deepEqual(overrides(resolve(over, later), later), over);
});

test('unknown keys survive normalization so applying fails closed', () => {
  assert.deepEqual(overrides({ 'studio.run.gone': 1 }, {}), { 'studio.run.gone': 1 });
  assert.deepEqual(resolve({ 'studio.run.gone': 1 }, { 'studio.run.steps': 20 }), { 'studio.run.steps': 20, 'studio.run.gone': 1 });
  assert.deepEqual(merge({ a: 1 }, null), null);
});
