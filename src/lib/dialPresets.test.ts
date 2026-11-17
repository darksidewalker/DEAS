import { expect, test } from 'vitest';
import { isDialRows, type DialRow } from './dials';
import { rackReduce, rackState } from './dialCurve';
import { dialPresetError, fromPresetRows, isDialPresetName, toPresetRows } from './dialPresets';

const sha = 'a'.repeat(64);
const motion = 'dials/h3_motion.safetensors', cold = 'dials/h3_evil_cold.safetensors';
const pack = (row: Record<string, unknown>) => ({ sha256: sha, on: true, solo: false, ...row });

test('preset names follow the pack: letters, digits, _ and -, 1 to 80', () => {
  for (const ok of ['a', 'calm_then-wild_2', 'A'.repeat(80)]) expect(isDialPresetName(ok), ok).toBe(true);
  for (const bad of ['', 'a b', 'ä', '../x', 'a.json', 'a/b', 'A'.repeat(81)]) expect(isDialPresetName(bad), bad).toBe(false);
});

test('a plain pack preset loads unchanged and without notes; curves in seconds stay as authored', () => {
  const c = fromPresetRows([
    pack({ dial: motion, strength: 1.5 }),
    pack({ dial: cold, strength: -0.5, on: false, hold: false }),
    pack({ dial: 'dials\\sub\\x.safetensors', strength: 1.2, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds', interp: 'step', smooth: 0.25, steps: 3, audio: 'follow' } }),
  ], 4.4583);
  expect(c.rows).toEqual([
    { dial: motion, strength: 1.5, on: true },
    { dial: cold, strength: -0.5, on: false },
    { dial: 'dials/sub/x.safetensors', strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds', interp: 'step', smooth: 0.25, steps: 3 } },
  ]);
  expect(isDialRows(c.rows)).toBe(true);
  expect(c.report.map(r => [r.leftOut, r.changed, r.warnings])).toEqual([[[], [], []], [[], [], []], [[], [], []]]);
  expect(c.report[2]).toMatchObject({ index: 2, dial: 'dials/sub/x.safetensors', strength: 1.2, on: true, curve: true });
});

test('clip fractions become whole-piece seconds with the lane length and are reported', () => {
  for (const unit of [undefined, 'normalized']) {
    const time = { type: 'keys', points: [[0, 0], [0.4, 0], [0.65, 1], [1, 1]], ...(unit ? { unit } : {}) };
    const c = fromPresetRows([pack({ dial: motion, strength: 1.2, time })], 4);
    expect(c.rows[0].time).toEqual({ type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds' });
    expect(c.report[0].changed).toEqual(['fractions']);
  }
  // The real clip length (107 frames at 24 fps), rounded to 0.1 ms like a pasted curve.
  const c = fromPresetRows([pack({ dial: motion, strength: 1, time: { type: 'keys', points: [[0.25, 0], [1, 1]] } })], 107 / 24);
  expect(c.rows[0].time!.points).toEqual([[1.1146, 0], [4.4583, 1]]);
  // The same preset on another lane length gives other seconds: fractions follow the lane.
  expect(fromPresetRows([pack({ dial: motion, strength: 1, time: { type: 'keys', points: [[0.25, 0], [1, 1]] } })], 10).rows[0].time!.points).toEqual([[2.5, 0], [10, 1]]);
});

test('every row kind this version does not send is left out and named, never loaded changed', () => {
  const curve = { type: 'keys', points: [[0, 0], [1, 1]], unit: 'seconds' };
  const cases: [Record<string, unknown>, string[]][] = [
    [{ input: 0, strength: 1 }, ['wired']],
    [pack({ dial: motion, strength: 1, hold: true }), ['hold']],
    [pack({ dial: motion, strength: 1, envelope: { type: 'ramp' } }), ['envelope']],
    [pack({ dial: motion, strength: 1, blocks: [1, 0.5] }), ['blocks']],
    [pack({ dial: motion, strength: 1, time: { type: 'audio', feature: 'onset' } }), ['audioCurve']],
    [pack({ dial: 'dials/a.pt', strength: 1 }), ['dial']],
    [pack({ dial: 'loras/a.safetensors', strength: 1 }), ['dial']],
    [pack({ dial: motion, strength: 20.5 }), ['strength']],
    [pack({ dial: motion, strength: 'much' }), ['strength']],
    [pack({ dial: motion, strength: 1, time: { ...curve, points: [[0, 0], [1, 25]] } }), ['curve']],
    [pack({ dial: motion, strength: 1, time: { ...curve, unit: 'frames' } }), ['curve']],
    [pack({ dial: motion, strength: 1, time: { ...curve, steps: 151 } }), ['curve']],
    [pack({ dial: motion, strength: 1, time: { ...curve, points: Array.from({ length: 65 }, (_, i) => [i, 0]) } }), ['curve']],
    [pack({ dial: motion, strength: 1, time: null }), ['curve']],
    [pack({ dial: motion, strength: 30, hold: true, blocks: [1], envelope: {} }), ['hold', 'envelope', 'blocks', 'strength']],
  ];
  for (const [row, leftOut] of cases) {
    const c = fromPresetRows([row, pack({ dial: cold, strength: 1 })], 4);
    expect(c.report[0].leftOut, JSON.stringify(row)).toEqual(leftOut);
    expect(c.report[0].changed).toEqual([]);
    // The supported neighbour still loads.
    expect(c.rows, JSON.stringify(row)).toEqual([{ dial: cold, strength: 1, on: true }]);
  }
  // Not an object at all.
  expect(fromPresetRows(['x', null, 3], 4)).toMatchObject({ rows: [], report: [{ leftOut: ['dial', 'strength'] }, { leftOut: ['dial', 'strength'] }, { leftOut: ['dial', 'strength'] }] });
});

test('a ninth row is left out with the reason; rows left out earlier do not use up the eight', () => {
  const rows = [pack({ dial: motion, strength: 1, hold: true }), ...Array.from({ length: 9 }, (_, i) => pack({ dial: `dials/d${i}.safetensors`, strength: 1 }))];
  const c = fromPresetRows(rows, 4);
  expect(c.rows.map(r => r.dial)).toEqual(Array.from({ length: 8 }, (_, i) => `dials/d${i}.safetensors`));
  expect(c.report.map(r => r.leftOut.join())).toEqual(['hold', '', '', '', '', '', '', '', '', 'tooMany']);
});

test('solo becomes switching the other rows off, as the pack runs only the solo rows', () => {
  const c = fromPresetRows([pack({ dial: motion, strength: 1, solo: true }), pack({ dial: cold, strength: 1.5 }), pack({ dial: 'dials/off.safetensors', strength: 1, on: false })], 4);
  expect(c.rows).toEqual([{ dial: motion, strength: 1, on: true }, { dial: cold, strength: 1.5, on: false }, { dial: 'dials/off.safetensors', strength: 1, on: false }]);
  expect(c.report.map(r => r.changed)).toEqual([['solo'], ['soloOff'], []]);
  // A solo row that is off or has strength 0 mutes nothing in the pack, so nothing changes here.
  for (const idle of [{ on: false }, { strength: 0 }]) {
    const quiet = fromPresetRows([pack({ dial: motion, strength: 1, solo: true, ...idle }), pack({ dial: cold, strength: 1.5 })], 4);
    expect(quiet.rows[1].on).toBe(true);
    expect(quiet.report.map(r => r.changed)).toEqual([[], []]);
  }
  // A solo hold row cannot be loaded, and still mutes the others as it would in the pack.
  const held = fromPresetRows([pack({ dial: motion, strength: 0, hold: true, solo: true }), pack({ dial: cold, strength: 1.5 })], 4);
  expect(held.rows).toEqual([{ dial: cold, strength: 1.5, on: false }]);
  expect(held.report.map(r => [r.leftOut, r.changed])).toEqual([[['hold'], []], [[], ['soloOff']]]);
});

test('the audio mode of a keys curve is kept through load and save: protect as it is, follow as no key', () => {
  const time = { type: 'keys', points: [[0, 0], [1, 1]], unit: 'seconds', audio: 'protect' };
  const c = fromPresetRows([pack({ dial: motion, strength: 1, time }), pack({ dial: cold, strength: 1, time: { ...time, audio: 'follow' } }),
    pack({ dial: 'dials/fractions.safetensors', strength: 1, time: { type: 'keys', points: [[0, 0], [0.5, 1]], audio: 'protect' } })], 4);
  expect(c.rows.map(r => r.time)).toEqual([{ type: 'keys', points: [[0, 0], [1, 1]], unit: 'seconds', audio: 'protect' }, { type: 'keys', points: [[0, 0], [1, 1]], unit: 'seconds' },
    { type: 'keys', points: [[0, 0], [2, 1]], unit: 'seconds', audio: 'protect' }]);
  // Nothing was changed, so nothing is noted (the fraction conversion aside).
  expect(c.report.map(r => [r.leftOut, r.changed])).toEqual([[[], []], [[], []], [[], ['fractions']]]);
  expect(isDialRows(c.rows)).toBe(true);
  // What is saved is the row as it runs: the mode goes back to the pack.
  expect(toPresetRows(c.rows).map(r => r.time?.audio)).toEqual(['protect', undefined, 'protect']);
  // A mode the node does not know is not loaded as something else.
  const bad = fromPresetRows([pack({ dial: motion, strength: 1, time: { ...time, audio: 'mute' } })], 4);
  expect(bad.rows).toEqual([]);
  expect(bad.report[0].leftOut).toEqual(['curve']);
});

test('the pack\'s warnings stay on their rows', () => {
  const c = fromPresetRows([pack({ dial: motion, strength: 1 }), pack({ dial: cold, strength: 1 })], 4, [{ row: 1, reason: 'missing' }, { row: 0, reason: 'changed' }]);
  expect(c.report.map(r => r.warnings)).toEqual([['changed'], ['missing']]);
  expect(c.rows).toHaveLength(2);
});

test('saving writes only what DEAS sends: dial, strength, on and curves in seconds, no hash and no solo', () => {
  const rows: DialRow[] = [
    { dial: motion, strength: 1.2, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds', interp: 'linear', steps: 3 } },
    { dial: 'dials\\win\\x.safetensors', strength: -0.5, on: false },
  ];
  const sent = toPresetRows(rows);
  expect(sent).toEqual([
    { dial: motion, strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds', interp: 'linear', steps: 3 } },
    { dial: 'dials/win/x.safetensors', strength: -0.5, on: false },
  ]);
  for (const row of sent) expect(Object.keys(row).every(k => ['dial', 'strength', 'on', 'time'].includes(k))).toBe(true);
  expect(isDialRows(sent)).toBe(true);
});

test('round trip: what DEAS saves comes back as the same rack, with the hashes and defaults the pack adds', () => {
  const rack: DialRow[] = [
    { dial: motion, strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds', smooth: 0.5, steps: 2 } },
    { dial: cold, strength: 1.5, on: false },
  ];
  // What `presets.py::preset_rows` stores for these rows.
  const stored = toPresetRows(rack).map(r => ({ dial: r.dial, sha256: sha, strength: r.strength, on: r.on, solo: false, ...(r.time ? { time: r.time } : {}) }));
  const back = fromPresetRows(stored, 4.4583);
  expect(back.rows).toEqual(rack);
  expect(back.report.every(r => !r.leftOut.length && !r.changed.length)).toBe(true);
  // Seconds do not depend on the lane a preset is loaded into.
  expect(fromPresetRows(stored, 12).rows).toEqual(rack);
});

test('loading into the rack is one undo step of its own, also right after a slider drag', () => {
  let s = rackState([{ dial: motion, strength: 1, on: true }]);
  s = rackReduce(s, { type: 'rows', rows: [{ dial: motion, strength: 2, on: true }] });
  s = rackReduce(s, { type: 'rows', rows: [{ dial: motion, strength: 3, on: true }] });
  expect(s.past).toHaveLength(1);
  const preset: DialRow[] = [{ dial: motion, strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [1, 1]], unit: 'seconds' } }];
  s = rackReduce({ ...s, point: 2 }, { type: 'load', rows: preset });
  expect(s).toMatchObject({ rows: preset, row: 0, point: -1 });
  expect(s.past).toHaveLength(2);
  expect(rackReduce(s, { type: 'undo' }).rows).toEqual([{ dial: motion, strength: 3, on: true }]);
  // Loading the same rows again adds no step; rows the validator rejects are not loaded.
  expect(rackReduce(s, { type: 'load', rows: preset }).past).toHaveLength(2);
  expect(rackReduce(s, { type: 'load', rows: [{ dial: 'x', strength: 1 }] })).toBe(s);
  const empty = rackReduce(s, { type: 'load', rows: [] });
  expect(empty).toMatchObject({ rows: [], row: -1 });
});

test('native failure text splits into its code and the backend\'s own reason', () => {
  expect(dialPresetError(new Error('DIAL_PRESET_EXISTS: Preset already exists. Choose a new name.'))).toEqual({ code: 'DIAL_PRESET_EXISTS', detail: 'Preset already exists. Choose a new name.' });
  expect(dialPresetError('DIAL_PRESETS_UNAVAILABLE: no route: really')).toEqual({ code: 'DIAL_PRESETS_UNAVAILABLE', detail: 'no route: really' });
  // An oversize answer has its own code: it is not an unreachable backend.
  expect(dialPresetError(new Error("DIAL_PRESETS_TOO_LARGE: The backend's rack preset answer is larger than 1 MiB and was not read")).code).toBe('DIAL_PRESETS_TOO_LARGE');
  expect(dialPresetError(new Error('something else: x'))).toEqual({ code: '', detail: 'something else: x' });
});
