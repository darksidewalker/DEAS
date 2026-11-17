import { expect, test } from 'vitest';
import { DIAL_LEVEL, DIAL_ROWS, activeDials, dialCatalog, dialCurveOutline, dialGate, dialLabel, dialName, dialStrength, fromDials, isDialCurve, isDialFile, isDialRow, isDialRows, withDials, type DialRow } from './dials';
import type { H3DialCurve, VideoIntentV1 } from './videoIntent';

// The fixtures of the native suite (`jobs_video_tests.rs`: dial_row, dial_curve, timed_dial).
const dialRow = (strength: number): DialRow => ({ dial: 'dials/h3_motion.safetensors', strength });
const dialCurve: H3DialCurve = { type: 'keys', points: [[0, 0.5], [1.5, 1], [4, -2]], unit: 'seconds' };
const timedDial: DialRow = { dial: 'dials/sub/h3_calm.safetensors', strength: -0.5, time: dialCurve };
const h3 = { recipeId: 'video-generation', version: 1, family: 'minimax-h3', model: 'h3.safetensors', h3: { mode: 'T2VA', references: [] } } as unknown as VideoIntentV1;

test('dial file names follow native dial_file: inside dials/, .safetensors, portable segments', () => {
  for (const ok of ['dials/h3_motion.safetensors', 'dials/sub/h3_calm.safetensors', 'dials/Day Night.SAFETENSORS', `dials/${'a'.repeat(236)}.safetensors`]) expect(isDialFile(ok), ok).toBe(true);
  for (const bad of ['h3_motion.safetensors', 'dials/', 'dials/.safetensors/', 'dials/../x.safetensors', 'dials/./x.safetensors', 'dials//x.safetensors', 'dials\\x.safetensors', 'dials/x.pt', 'dials/x.gguf',
    'dials/c:x.safetensors', 'dials/x%20.safetensors', 'dials/ x.safetensors', 'dials/x\n.safetensors', '/dials/x.safetensors', 'Dials/x.safetensors', `dials/${'a'.repeat(250)}.safetensors`, 5, null, undefined]) expect(isDialFile(bad), String(bad)).toBe(false);
});

test('rows and curves accept exactly what native validate_dial_row accepts', () => {
  for (const ok of [dialRow(1.5), dialRow(0), dialRow(-DIAL_LEVEL), dialRow(DIAL_LEVEL), { ...dialRow(1), on: false }, { ...dialRow(1), on: true }, timedDial,
    { ...dialRow(1), time: { type: 'keys', points: [[3, 1]], unit: 'seconds' } },
    { ...dialRow(1), time: { type: 'keys', points: [[-1, 0], [2.5, 1.25]], unit: 'seconds', interp: 'step', smooth: 0.25 } },
    { ...dialRow(1), time: { ...dialCurve, steps: 1 } }, { ...dialRow(1), time: { ...dialCurve, steps: 150 } },
    // The curve's audio mode: the node's two values.
    { ...dialRow(1), time: { ...dialCurve, audio: 'protect' } }, { ...dialRow(1), time: { ...dialCurve, audio: 'follow' } },
    { ...dialRow(20), time: { type: 'keys', points: Array.from({ length: 64 }, (_, n) => [n, 20]), unit: 'seconds', smooth: 1 } }]) expect(isDialRow(ok), JSON.stringify(ok)).toBe(true);
  const time = (edit: Record<string, unknown>) => ({ ...dialRow(1), time: { ...dialCurve, ...edit } });
  for (const bad of [null, [], 'dials/a.safetensors', {}, { dial: 'a.safetensors', strength: 1 }, { dial: 'dials/a.safetensors' }, { ...dialRow(1), strength: '1' }, dialRow(20.5), dialRow(-21), dialRow(NaN), dialRow(Infinity),
    { ...dialRow(1), on: 'yes' }, { ...dialRow(1), on: null },
    // Row kinds the first version refuses.
    { ...dialRow(1), input: 1 }, { ...dialRow(1), hold: true }, { ...dialRow(1), envelope: [] }, { ...dialRow(1), blocks: {} }, { ...dialRow(1), solo: true },
    { ...dialRow(1), time: null }, { ...dialRow(1), time: [] }, time({ type: 'audio' }), time({ unit: 'frames' }), time({ unit: undefined }), time({ interp: 'cubic' }), time({ smooth: 1.5 }), time({ smooth: -0.1 }), time({ steps: 0 }), time({ steps: 2.5 }), time({ steps: 151 }), time({ steps: '2' }), time({ steps: null }), time({ audio: 'mute' }), time({ audio: 'Protect' }), time({ audio: null }), time({ audio: true }), time({ audio: '' }), { ...dialRow(1), audio: 'protect' },
    time({ points: [] }), time({ points: Array.from({ length: 65 }, (_, n) => [n, 0]) }), time({ points: [[0, 0], [0, 1]] }), time({ points: [[1, 0], [0, 1]] }), time({ points: [[0, 21]] }), time({ points: [[86401, 0]] }), time({ points: [[0]] }), time({ points: [[0, 0, 0]] }), time({ points: [['0', 0]] }), time({ points: 'x' })]) expect(isDialRow(bad), JSON.stringify(bad)).toBe(false);
  expect(isDialCurve(dialCurve)).toBe(true);
  expect(isDialRows([])).toBe(true);
  expect(isDialRows(Array.from({ length: DIAL_ROWS }, () => dialRow(1)))).toBe(true);
  expect(isDialRows(Array.from({ length: DIAL_ROWS + 1 }, () => dialRow(1)))).toBe(false);
  expect(isDialRows([dialRow(1), { dial: 'x' }])).toBe(false);
  expect(isDialRows({ 0: dialRow(1) })).toBe(false);
});

test('only active rows enter a plain MiniMax H3 intent; without one the intent is the same object', () => {
  expect(withDials(h3, [])).toBe(h3);
  expect(withDials(h3, [{ ...dialRow(1.5), on: false }])).toBe(h3);
  expect(withDials(h3, [dialRow(0), { dial: 'dials/b.safetensors', strength: 0, on: true }])).toBe(h3);
  expect(withDials(h3, [{ dial: 'dials/b.safetensors', strength: 1, on: false, time: dialCurve }])).toBe(h3);
  // The compiler refuses the field itself on every other family.
  for (const family of ['minimax-h3-hyperflow', 'ltx-2', 'wan']) { const other = { ...h3, family } as unknown as VideoIntentV1; expect(withDials(other, [dialRow(1)])).toBe(other); }
  const rows: DialRow[] = [{ dial: 'dials/off.safetensors', strength: 2, on: false }, { dial: 'dials/zero.safetensors', strength: 0 }, { ...dialRow(1.5), on: true }, timedDial];
  const intent = withDials(h3, rows);
  // Exactly the native fixture `json!([dial_row(1.5), timed_dial()])`: no `on`, the curve untouched.
  expect(JSON.stringify((intent as { dials?: unknown }).dials)).toBe('[{"dial":"dials/h3_motion.safetensors","strength":1.5},{"dial":"dials/sub/h3_calm.safetensors","strength":-0.5,"time":{"type":"keys","points":[[0,0.5],[1.5,1],[4,-2]],"unit":"seconds"}}]');
  expect(isDialRows((intent as { dials?: unknown }).dials)).toBe(true);
  expect({ ...intent, dials: undefined }).toEqual({ ...h3, dials: undefined });
  expect(activeDials(rows).map(r => r.dial)).toEqual(['dials/h3_motion.safetensors', 'dials/sub/h3_calm.safetensors']);
});

test('a restored intent brings its rows back switched on; invalid rows restore as none', () => {
  expect(fromDials(undefined)).toEqual([]);
  expect(fromDials([dialRow(1.5), timedDial])).toEqual([{ ...dialRow(1.5), on: true }, { ...timedDial, on: true }]);
  expect(fromDials([{ ...dialRow(1), on: false }])).toEqual([{ ...dialRow(1), on: false }]);
  expect(fromDials([{ ...dialRow(1), hold: true }])).toEqual([]);
  expect(fromDials('dials/a.safetensors')).toEqual([]);
});

test('the gate names the first reason rows cannot run', () => {
  const nodes = ['MAIDialRack', 'MAIDialHoldMap'];
  expect(dialGate({ h3Video: true, nodes, gguf: false })).toBe('');
  expect(dialGate({ h3Video: true, nodes: ['MAIDialRack'], gguf: false })).toBe('');
  // An unread backend is not a missing node.
  expect(dialGate({ h3Video: true, nodes: undefined, gguf: false })).toBe('');
  expect(dialGate({ h3Video: false, nodes, gguf: true })).toBe('h3VideoOnly');
  expect(dialGate({ h3Video: true, nodes: ['MAIDialHoldMap'], gguf: true })).toBe('nodeMissing');
  expect(dialGate({ h3Video: true, nodes, gguf: true })).toBe('gguf');
});

test('the catalog lists dial files from LoRA names like the pack does', () => {
  expect(dialCatalog(['style.safetensors', 'dials/h3_motion.safetensors', 'dials\\sub\\h3_calm.safetensors', 'dials/_probes/x.safetensors', 'dials/sub/_old/y.safetensors', 'dials/notes.txt', 'dials/h3_motion.safetensors', 'dials/_leading.safetensors', 'MiniMaxH3/dials/z.safetensors']))
    .toEqual(['dials/_leading.safetensors', 'dials/h3_motion.safetensors', 'dials/sub/h3_calm.safetensors']);
  expect(dialName('dials\\a\\b.safetensors')).toBe('dials/a/b.safetensors');
  expect(dialLabel('dials/sub/h3_day_night_hook.safetensors')).toBe('h3_day_night_hook');
  expect(dialLabel('dials\\Day Night.SAFETENSORS')).toBe('Day Night');
});

test('typed strengths clamp to the compiler range and unfinished numbers change nothing', () => {
  expect(dialStrength('1.5')).toBe(1.5);
  expect(dialStrength('-0')).toBe(-0);
  expect(dialStrength('25')).toBe(DIAL_LEVEL);
  expect(dialStrength('-99')).toBe(-DIAL_LEVEL);
  for (const text of ['', ' ', '-', '1e', 'abc', 'Infinity']) expect(dialStrength(text), text).toBeUndefined();
});

test('the thumbnail outline holds the end levels to the clip edges and steps when asked', () => {
  const linear = dialCurveOutline({ type: 'keys', points: [[1, 0], [3, 1]], unit: 'seconds' }, 4);
  expect(linear.points).toEqual([[0, 1], [0.25, 1], [0.75, 0], [1, 0]]);
  expect(linear.zero).toBe(1);
  const step = dialCurveOutline({ type: 'keys', points: [[0, -1], [2, 1]], unit: 'seconds', interp: 'step' }, 4);
  expect(step.points).toEqual([[0, 1], [0, 1], [0.5, 1], [0.5, 0], [1, 0]]);
  expect(step.zero).toBe(0.5);
  // Points outside the clip widen the span; one point is a flat line; a zero-length clip still draws.
  expect(dialCurveOutline({ type: 'keys', points: [[-2, 1], [6, 1]], unit: 'seconds' }, 4).points).toEqual([[0, 0], [0, 0], [1, 0], [1, 0]]);
  expect(dialCurveOutline({ type: 'keys', points: [[3, 0]], unit: 'seconds' }, 0).points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
});
