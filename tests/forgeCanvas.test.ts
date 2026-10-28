import test from 'node:test';
import assert from 'node:assert/strict';
import { aspects } from '../src/lib/resolution.ts';
import { canonicalForgeAspect, forgeAspectChoices, resolveForgeCanvas, type ForgeCanvasContext } from '../src/lib/forgeCanvas.ts';

const square = { width: 1024, height: 1024 };
const context: ForgeCanvasContext = {
  key: 'studio-context', effective: square, model: square, grid: 16,
  resolution: 'model', megapixels: 1, fixed: square,
};

test('Forge derives the complete ordered Settings ratio list and recognizes bounded legacy labels', () => {
  assert.deepEqual(forgeAspectChoices, ['N/A', ...aspects]);
  for (const choice of forgeAspectChoices) assert.equal(canonicalForgeAspect(choice), choice);
  assert.equal(canonicalForgeAspect(''), 'N/A');
  assert.equal(canonicalForgeAspect('2:3 Portrait'), '2:3');
  assert.equal(canonicalForgeAspect('2:2 Square'), '1:1');
  assert.equal(canonicalForgeAspect('2:2Square'), '1:1');
  assert.equal(canonicalForgeAspect('32:18 Wide'), '16:9');
  assert.equal(canonicalForgeAspect('6:4'), '3:2');
  for (const unknown of ['Auto', 'Square', '11:7 Wide', '0:1', '1:0', '-2:3', '1.5:1', '1:1 extra 2:3', '9007199254740992:1']) {
    assert.equal(canonicalForgeAspect(unknown), null, unknown);
  }
});

test('N/A is prompt-only and unresolved or unknown selections never become a square', () => {
  assert.deepEqual(resolveForgeCanvas('N/A', { width: NaN, height: Infinity }), { choice: 'N/A' });
  assert.deepEqual(resolveForgeCanvas('', square), { choice: 'N/A' });
  assert.deepEqual(resolveForgeCanvas('16:9', square), { choice: '16:9', error: 'forge.canvas.unresolved' });
  assert.deepEqual(resolveForgeCanvas('auto', square, { ...context, effective: null }), { choice: 'auto', error: 'forge.canvas.unresolved' });
  assert.deepEqual(resolveForgeCanvas('unknown saved choice', square, context), { choice: 'unknown saved choice', error: 'forge.canvas.unknown' });
});

test('Auto preserves the effective source canvas and ratios show the shared bucket dimensions', () => {
  const effective = { width: 1536, height: 640 };
  const auto = resolveForgeCanvas('auto', square, { ...context, effective });
  assert.deepEqual(auto, { choice: 'auto', canvas: effective });
  assert.notEqual(auto.canvas, effective);
  assert.deepEqual(resolveForgeCanvas('16:9', square, context), { choice: '16:9', canvas: { width: 1344, height: 768 } });
  assert.deepEqual(resolveForgeCanvas('2:3 Portrait', square, context), { choice: '2:3', canvas: { width: 832, height: 1216 } });
  assert.deepEqual(resolveForgeCanvas('3:2', square, { ...context, grid: 64 }), { choice: '3:2', canvas: { width: 1216, height: 832 } });
  assert.deepEqual(resolveForgeCanvas('custom', { width: 3, height: 2 }, context), { choice: 'custom', canvas: { width: 1248, height: 832 } });
  // Exact fixed dimensions remain legal when the family's bucket grid is only preferred.
  const exact = { width: 1000, height: 1000 };
  assert.deepEqual(resolveForgeCanvas('auto', square, { ...context, grid: 64, requiredGrid: 8, effective: exact }), {
    choice: 'auto', canvas: exact,
  });
});

test('fixed Settings dimensions supply the current effective pixel budget for a newly selected ratio', () => {
  const fixed = { width: 1024, height: 512 };
  assert.deepEqual(resolveForgeCanvas('16:9', square, { ...context, resolution: 'fixed', fixed, effective: fixed }), {
    choice: '16:9', canvas: { width: 944, height: 544 },
  });
  // Effective source geometry takes precedence over an unused fixed preference.
  assert.deepEqual(resolveForgeCanvas('1:1', square, { ...context, resolution: 'fixed', fixed, effective: square }), {
    choice: '1:1', canvas: square,
  });
});

test('Custom rejects nonfinite and out-of-range Settings ratios and validates final caps and grid', () => {
  for (const custom of [
    { width: 0, height: 1 }, { width: .9, height: 2 }, { width: 101, height: 2 },
    { width: 1, height: NaN }, { width: Infinity, height: 1 },
  ]) assert.equal(resolveForgeCanvas('custom', custom, context).error, 'forge.canvas.invalid');
  assert.deepEqual(resolveForgeCanvas('custom', { width: 1, height: 1.5 }, context), {
    choice: 'custom', canvas: { width: 832, height: 1248 },
  });
  assert.deepEqual(resolveForgeCanvas('custom', { width: 100, height: 100 }, context).canvas, square);
  for (const invalid of [
    { ...context, grid: 0 }, { ...context, grid: 12 },
    { ...context, requiredGrid: 12 },
    { ...context, model: { width: NaN, height: 1024 } },
    { ...context, effective: { width: 8192, height: 8192 } },
    { ...context, resolution: 'unknown' },
    { ...context, resolution: 'custom', megapixels: 20 },
  ]) assert.equal(resolveForgeCanvas('1:1', square, invalid).error, 'forge.canvas.invalid');
  assert.equal(resolveForgeCanvas('custom', { width: 100, height: 1 }, context).error, 'forge.canvas.invalid');
  assert.equal(resolveForgeCanvas('auto', square, { ...context, effective: { width: 1000, height: 1000 } }).error, 'forge.canvas.invalid');
  // This callback belongs to the handoff boundary, not authoring resolution.
  assert.ok(resolveForgeCanvas('1:1', square, { ...context, acceptsCanvas: () => false }).canvas);
});

test('MOSS layout additionally requires 128-pixel minimum edges and 16-pixel alignment', () => {
  const small = { ...context, grid: 8, effective: { width: 64, height: 64 } };
  assert.deepEqual(resolveForgeCanvas('auto', square, small).canvas, { width: 64, height: 64 });
  assert.equal(resolveForgeCanvas('auto', square, small, 'layout').error, 'forge.canvas.invalid');
  const eightOnly = { ...context, grid: 8, effective: { width: 1000, height: 1000 } };
  assert.ok(resolveForgeCanvas('auto', square, eightOnly).canvas);
  assert.equal(resolveForgeCanvas('auto', square, eightOnly, 'layout').error, 'forge.canvas.invalid');
  assert.deepEqual(resolveForgeCanvas('16:9', square, context, 'layout').canvas, { width: 1344, height: 768 });
  assert.deepEqual(resolveForgeCanvas('N/A', square, undefined, 'layout'), { choice: 'N/A' });
});
