import test from 'node:test';
import assert from 'node:assert/strict';
import { growAlpha } from '../src/lib/maskMorph.ts';

const grid = (w: number, h: number, on: (x: number, y: number) => boolean) => { const a = new Uint8ClampedArray(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = on(x, y) ? 255 : 0; return a; };
const at = (a: Uint8ClampedArray, w: number, x: number, y: number) => a[y * w + x];

test('a single seed grows into an approximately round disc of the requested radius', () => {
  const w = 101, h = 101, out = growAlpha(grid(w, h, (x, y) => x === 50 && y === 50), w, h, 32);
  assert.equal(at(out, w, 50 + 32, 50), 255); assert.equal(at(out, w, 50, 50 - 32), 255);
  assert.equal(at(out, w, 50 + 33, 50), 0);
  // Diagonal: Euclidean 32 ≈ 22.6 px per axis; chamfer 3-4 stays within ~8 %.
  assert.equal(at(out, w, 50 + 22, 50 + 22), 255);
  assert.equal(at(out, w, 50 + 26, 50 + 26), 0);
  const covered = out.reduce((n, v) => n + (v ? 1 : 0), 0), disc = Math.PI * 32 * 32;
  assert.ok(Math.abs(covered - disc) / disc < 0.1, `area ${covered} vs ${disc.toFixed(0)}`);
});

test('a rectangle grows by the radius on every side; soft values inside stay, nothing changes without a radius', () => {
  const w = 120, h = 80, src = grid(w, h, (x, y) => x >= 40 && x < 80 && y >= 30 && y < 50); src[35 * w + 60] = 200;
  const out = growAlpha(src, w, h, 10);
  assert.equal(at(out, w, 30, 40), 255); assert.equal(at(out, w, 29, 40), 0);
  assert.equal(at(out, w, 89, 40), 255); assert.equal(at(out, w, 90, 40), 0);
  assert.equal(at(out, w, 60, 20), 255); assert.equal(at(out, w, 60, 19), 0);
  assert.equal(at(out, w, 60, 35), 200);
  assert.deepEqual(growAlpha(src, w, h, 0), src);
  assert.deepEqual(growAlpha(new Uint8ClampedArray(w * h), w, h, 32), new Uint8ClampedArray(w * h)); // empty stays empty
});
