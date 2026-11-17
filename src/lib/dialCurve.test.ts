import rust from '../../src-tauri/src/jobs_video.rs?raw';
import rustTests from '../../src-tauri/src/jobs_video_tests.rs?raw';
import { expect, test } from 'vitest';
import fixture from './dialCurve.fixture.json';
import { DIAL_GAP, addPoint, dialCurveText, dialFrameLevels, dialPresetPoints, dialPresets, dialTimeline, flatCurve, latentFrameStarts, movePoint, nearPoint, parseDialCurveText, rackReduce, rackState, removePoint, sampleDialCurve, widestGap, type CurveLimits, type RackAction, type RackState } from './dialCurve';
import { DIAL_BLEND_STEPS, dialBlendSteps, dialCurveConflictIds, dialCurveConflicts, dialHoldMapNode, dialIntentFacts, dialRackNode, isDialCurve, isDialRows, type DialCurveConflict, type DialCurveFacts, type DialRow } from './dials';
import { videoFrames, type H3DialCurve, type VideoIntentV1 } from './videoIntent';

const keys = (points: [number, number][], rest: Partial<H3DialCurve> = {}): H3DialCurve => ({ type: 'keys', points, unit: 'seconds', ...rest });
const lim: CurveLimits = { from: 0, to: 5, lo: 0, hi: 1 };
const motion = 'dials/h3_motion.safetensors', calm = 'dials/h3_calm.safetensors';
const rows = (): DialRow[] => [{ dial: motion, strength: 1.5, on: true }, { dial: calm, strength: 1, on: true, time: keys([[0, 0], [1.5, 1], [4, 0.5]]) }];
const run = (s: RackState, ...actions: RackAction[]) => actions.reduce(rackReduce, s);
const gaps = (p: readonly (readonly [number, number])[]) => p.slice(1).map((q, i) => q[0] - p[i][0]);

test('the sampler gives the values the Dial Rack pack computes (keyframes, step, rate smoothing)', () => {
  expect(fixture.source.commit).toBe('382f640');
  expect(fixture.source.workingTreeChangesToTheseFiles).toBe('none');
  expect(fixture.cases.length).toBe(48);
  let worst = 0, samples = 0;
  for (const c of fixture.cases) {
    const curve = { points: c.points as [number, number][], interp: c.interp as 'linear' | 'step', smooth: c.smooth };
    const got = sampleDialCurve(curve, c.times);
    got.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - c.levels[i])); samples++; });
    for (const [latent, clip] of Object.entries(c.frames)) {
      const frames = Math.round(clip.seconds * 24), levels = dialFrameLevels(curve, frames);
      // 17k + 5 pixel frames in 5k + 2 latent frames.
      expect(levels.length, `${c.name} ${latent}`).toBe(Number(latent));
      expect(levels.at(-1)!.end).toBeCloseTo(clip.seconds, 12);
      levels.forEach((f, i) => { worst = Math.max(worst, Math.abs(f.level - clip.levels[i])); samples++; });
    }
  }
  expect(samples).toBeGreaterThan(5000);
  expect(worst).toBeLessThan(1e-12);
});

test('latent frames cover 1, 4, 4, 4, 4 pixel frames', () => {
  expect(latentFrameStarts(22)).toEqual([0, 1, 5, 9, 13, 17, 18, 22]);
  expect(latentFrameStarts(videoFrames('minimax-h3', 4, 24)).at(-1)).toBe(107);
  expect(dialFrameLevels(keys([[0, 0], [1, 1]]), 5).map(f => [f.start, f.end])).toEqual([[0, 1 / 24], [1 / 24, 5 / 24]]);
});

test('lanes span the clip, or the whole Continuity piece when Studio can lay it out', () => {
  expect(dialTimeline(107)).toEqual({ seconds: 107 / 24, frames: 107, edges: [], basis: 'clip' });
  expect(dialTimeline(107, { steps: [] }).basis).toBe('clip');
  // Step 0 renders 17k + 5 frames; later steps add their seconds snapped to 17-frame steps (native continuation_extension).
  const plan = dialTimeline(107, { steps: [{ seconds: 5 }, { seconds: 3 }, { seconds: 0.2 }] });
  expect(plan).toEqual({ seconds: (124 + 68 + 17) / 24, frames: 209, edges: [124 / 24, 192 / 24], basis: 'plan' });
  // A plan that continues an existing clip starts at a frame count Studio does not hold.
  expect(dialTimeline(107, { steps: [{ seconds: 5 }], source: { clipId: 'x' } })).toEqual({ seconds: 107 / 24, frames: 107, edges: [], basis: 'planSource' });
});

test('points move between their neighbours with a one-latent-frame gap, snapped to 0.1 s and 0.05 levels', () => {
  const c = keys([[0, 0], [1.5, 1], [4, 0.5]]);
  expect(movePoint(c, 1, 2.34, 0.72, lim).points[1]).toEqual([2.3, 0.7]);
  expect(movePoint(c, 1, 2.34, 0.72, { ...lim, snap: 0 }).points[1]).toEqual([2.34, 0.72]);
  // Stops one latent frame before each neighbour, rounded inward.
  expect(movePoint(c, 1, -3, 0.5, lim).points[1]).toEqual([0.1667, 0.5]);
  expect(movePoint(c, 1, 9, 0.5, lim).points[1]).toEqual([3.8333, 0.5]);
  expect(0.1667 - 0).toBeGreaterThanOrEqual(DIAL_GAP);
  expect(4 - 3.8333).toBeGreaterThanOrEqual(DIAL_GAP);
  // End points stop at the lane's edges; levels at the range.
  expect(movePoint(c, 0, -2, -1, lim).points[0]).toEqual([0, 0]);
  expect(movePoint(c, 2, 99, 7, lim).points[2]).toEqual([5, 1]);
  expect(movePoint(c, 2, 4, -1.5, { ...lim, lo: -2, hi: 3 }).points[2]).toEqual([4, -1.5]);
  expect(movePoint(c, 2, 4, 99, { ...lim, lo: -99, hi: 99 }).points[2]).toEqual([4, 20]);
  // Snapping prefers a segment edge of the piece.
  expect(movePoint(c, 1, 2.02, 1, { ...lim, edges: [2.0417] }).points[1]).toEqual([2.0417, 1]);
  // No change keeps the same object; unknown indices too.
  expect(movePoint(c, 1, 1.5, 1, lim)).toBe(c);
  expect(movePoint(c, 7, 1, 1, lim)).toBe(c);
  // Points closer than two gaps cannot move in time, only in level.
  const tight = keys([[0, 0], [0.15, 1], [0.3, 0]]);
  expect(movePoint(tight, 1, 0.3, 0.5, lim).points[1]).toEqual([0.15, 0.5]);
  for (const t of [-1, 0.03, 0.2, 1.49, 2.6, 3.99, 4.2, 8]) for (const i of [0, 1, 2]) {
    const moved = movePoint(c, i, t, 0.5, lim);
    expect(isDialCurve(moved)).toBe(true);
    expect(Math.min(...gaps(moved.points))).toBeGreaterThanOrEqual(DIAL_GAP);
  }
});

test('points are added where there is room and a curve keeps at least two', () => {
  const c = keys([[0, 0], [1.5, 1], [4, 0.5]]);
  expect(addPoint(c, 2.52, 0.33, lim)).toEqual({ curve: keys([[0, 0], [1.5, 1], [2.5, 0.35], [4, 0.5]]), index: 2 });
  expect(addPoint(c, 4.6, 2, lim)).toEqual({ curve: keys([[0, 0], [1.5, 1], [4, 0.5], [4.6, 1]]), index: 3 });
  expect(addPoint(keys([[1, 0], [2, 1]]), 0.3, 0.5, lim)!.index).toBe(0);
  // Within one latent frame of a point there is no room: the dialog selects that point instead.
  expect(addPoint(c, 1.6, 0.5, lim)).toBeNull();
  expect(nearPoint(c, 1.6)).toBe(1);
  expect(nearPoint(c, 1.5 + DIAL_GAP)).toBe(-1);
  expect(nearPoint(keys([[0, 0], [0.2, 1]]), 0.12)).toBe(1);
  expect(addPoint(keys(Array.from({ length: 64 }, (_, n) => [n, 0])), 0.5, 0, { ...lim, to: 99 })).toBeNull();
  expect(removePoint(c, 1)).toEqual(keys([[0, 0], [4, 0.5]]));
  expect(removePoint(c, 0)).toEqual(keys([[1.5, 1], [4, 0.5]]));
  expect(removePoint(keys([[0, 0], [4, 0.5]]), 0)).toBeNull();
  expect(removePoint(c, 9)).toBeNull();
  expect(widestGap(c, lim)).toBe(2.75);
  expect(widestGap(keys([[0, 0], [0.2, 1]]), { ...lim, to: 0.3 })).toBeNull();
});

test('presets stay inside levels 0..1 with ramps of about 1.5 s on every lane length', () => {
  expect(dialPresetPoints('rampIn', 5)).toEqual([[0, 0], [1.5, 1]]);
  expect(dialPresetPoints('rampOut', 5)).toEqual([[3.5, 1], [5, 0]]);
  expect(dialPresetPoints('pulse', 5)).toEqual([[0, 0], [1.5, 1], [3.5, 1], [5, 0]]);
  expect(dialPresetPoints('dip', 5)).toEqual([[0, 1], [1.5, 0], [3.5, 0], [5, 1]]);
  // A real 4 s clip is 107 frames.
  expect(dialPresetPoints('rampOut', 107 / 24)).toEqual([[2.9583, 1], [4.4583, 0]]);
  expect(dialPresetPoints('pulse', 107 / 24)).toEqual([[0, 0], [1.5, 1], [2.9583, 1], [4.4583, 0]]);
  // Short lanes shorten the ramps instead of crowding the points.
  expect(dialPresetPoints('pulse', 2)).toEqual([[0, 0], [0.7, 1], [1.3, 1], [2, 0]]);
  expect(dialPresetPoints('dip', 0.5)).toEqual([[0, 1], [0.25, 0], [0.5, 1]]);
  expect(dialPresetPoints('rampIn', 0.5)).toEqual([[0, 0], [0.5, 1]]);
  const lengths = [...Array.from({ length: 30 }, (_, n) => (n + 1) * 0.5), ...[22, 39, 56, 107, 124, 209, 362].map(f => f / 24), 60];
  for (const name of dialPresets) for (const seconds of lengths) {
    const points = dialPresetPoints(name, seconds), label = `${name} ${seconds}`;
    expect(isDialCurve(keys(points)), label).toBe(true);
    expect(points.length, label).toBeGreaterThanOrEqual(2);
    expect(Math.min(...gaps(points)), label).toBeGreaterThanOrEqual(DIAL_GAP);
    expect(points.every(([t, m]) => t >= 0 && t <= seconds + 1e-4 && m >= 0 && m <= 1), label).toBe(true);
    if (seconds >= 4.5) expect(Math.max(...gaps(points).filter((_, i) => points[i][1] !== points[i + 1][1])), label).toBeCloseTo(1.5, 3);
  }
  expect(flatCurve(4)).toEqual(keys([[0, 1], [4, 1]]));
});

test('a curve copies as the rack row\'s time object and pastes from the pack\'s editor too', () => {
  const c = keys([[0, 0], [1.5, 1]], { interp: 'step', smooth: 0.25, steps: 8 });
  expect(dialCurveText(c)).toBe('{"type":"keys","points":[[0,0],[1.5,1]],"unit":"seconds","interp":"step","smooth":0.25,"steps":8}');
  expect(parseDialCurveText(dialCurveText(c), 4)).toEqual(c);
  // A bare list is seconds; the pack's default unit is clip fractions, converted with the lane length.
  expect(parseDialCurveText('[[0,0],[2,1]]', 4)).toEqual(keys([[0, 0], [2, 1]]));
  expect(parseDialCurveText('{"type":"keys","points":[[0,0],[0.4,1],[1,0.5]]}', 5)).toEqual(keys([[0, 0], [2, 1], [5, 0.5]]));
  expect(parseDialCurveText('{"type":"keys","points":[[0,0],[0.5,1]],"unit":"normalized","interp":"linear","smooth":0,"steps":2,"audio":"protect"}', 107 / 24)).toEqual(keys([[0, 0], [2.2292, 1]], { interp: 'linear', steps: 2, audio: 'protect' }));
  // `follow` is the node's default and is not written; a mode the node does not know is not pasted.
  expect(parseDialCurveText('{"type":"keys","points":[[0,0],[1,1]],"unit":"seconds","audio":"follow"}', 4)).toEqual(keys([[0, 0], [1, 1]]));
  expect(parseDialCurveText('{"type":"keys","points":[[0,0],[1,1]],"unit":"seconds","audio":"mute"}', 4)).toBeNull();
  expect(dialCurveText(keys([[0, 0], [1, 1]], { audio: 'protect' }))).toBe('{"type":"keys","points":[[0,0],[1,1]],"unit":"seconds","audio":"protect"}');
  for (const bad of ['', 'x', 'null', '5', '{}', '[]', '[[0,0],[0,1]]', '[[1,0],[0,1]]', '[[0,"1"]]', '[[0,0,0]]', '{"type":"audio","feature":"onset"}', '{"type":"keys","points":[[0,0],[1,1]],"unit":"frames"}',
    '{"type":"keys","points":[[0,0],[1,99]],"unit":"seconds"}', '{"type":"keys","points":[[0,0],[1,1]],"unit":"seconds","interp":"cubic"}', '{"type":"keys","points":[[0,0],[1,1]],"unit":"seconds","steps":0}',
    '{"type":"keys","points":[[0,0],[1,1]],"unit":"seconds","smooth":2}', JSON.stringify(Array.from({ length: 65 }, (_, n) => [n, 0]))]) expect(parseDialCurveText(bad, 4), bad).toBeNull();
});

test('the rack reducer edits the selected lane and undoes every step made in the open dialog', () => {
  let s = rackState(rows());
  expect([s.row, s.point]).toEqual([0, -1]);
  expect(rackState([]).row).toBe(-1);
  // A row without a curve: add starts flat at level 1, remove returns the constant row.
  s = run(s, { type: 'addCurve', seconds: 4 });
  expect(s.rows[0]).toEqual({ dial: motion, strength: 1.5, on: true, time: keys([[0, 1], [4, 1]]) });
  expect(run(s, { type: 'addCurve', seconds: 4 })).toBe(s);
  s = run(s, { type: 'removeCurve' });
  expect(s.rows[0]).toEqual({ dial: motion, strength: 1.5, on: true });
  expect(Object.keys(s.rows[0])).not.toContain('time');
  expect(run(s, { type: 'removeCurve' })).toBe(s);
  expect(s.past).toHaveLength(2);
  // Add, move, nudge and delete on the second lane.
  s = run(s, { type: 'select', row: 1 }, { type: 'add', t: 2.52, level: 0.33, lim });
  expect([s.row, s.point]).toEqual([1, 2]);
  expect(s.rows[1].time!.points).toEqual([[0, 0], [1.5, 1], [2.5, 0.35], [4, 0.5]]);
  expect(run(s, { type: 'add', t: 2.55, level: 0.5, lim })).toBe(s);
  s = run(s, { type: 'move', point: 2, t: 3.04, level: 0.8, lim, tag: 'drag:1' }, { type: 'move', point: 2, t: 3.31, level: 0.62, lim, tag: 'drag:1' });
  expect(s.rows[1].time!.points[2]).toEqual([3.3, 0.6]);
  // One drag is one undo step.
  expect(s.past).toHaveLength(4);
  s = run(s, { type: 'nudge', point: 2, dt: 0.1, dl: 0, lim }, { type: 'nudge', point: 2, dt: 0, dl: -0.05, lim });
  expect(s.rows[1].time!.points[2]).toEqual([3.4, 0.55]);
  expect(s.past).toHaveLength(6);
  // A nudge stops at the neighbour's gap and at the level range.
  s = run(s, { type: 'nudge', point: 2, dt: 1, dl: 9, lim });
  expect(s.rows[1].time!.points[2]).toEqual([3.8333, 1]);
  s = run(s, { type: 'remove', point: 2 });
  expect(s.rows[1].time!.points).toEqual([[0, 0], [1.5, 1], [4, 0.5]]);
  expect(s.point).toBe(-1);
  s = run(s, { type: 'remove', point: 1 });
  const two = s;
  expect(run(s, { type: 'remove', point: 0 })).toBe(two);
  expect(run(s, { type: 'move', point: 5, t: 1, level: 1, lim })).toBe(two);
  expect(run(s, { type: 'select', row: 9 })).toBe(two);
  // Curve settings; a slider gesture shares one step.
  s = run(s, { type: 'set', patch: { interp: 'step' } }, { type: 'set', patch: { smooth: 0.2 }, tag: 'smooth' }, { type: 'set', patch: { smooth: 0.6 }, tag: 'smooth' }, { type: 'set', patch: { steps: 8 } });
  expect(s.rows[1].time).toEqual(keys([[0, 0], [4, 0.5]], { interp: 'step', smooth: 0.6, steps: 8 }));
  expect(s.past).toHaveLength(two.past.length + 3);
  expect(run(s, { type: 'set', patch: { steps: 0 } })).toBe(s);
  expect(run(s, { type: 'set', patch: { steps: DIAL_BLEND_STEPS + 1 } })).toBe(s);
  s = run(s, { type: 'set', patch: { steps: null, smooth: 0 } });
  expect(s.rows[1].time).toEqual(keys([[0, 0], [4, 0.5]], { interp: 'step' }));
  // Presets and paste write points; a preset also gives a constant row its curve.
  s = run(s, { type: 'preset', name: 'pulse', seconds: 5 });
  expect(s.rows[1].time).toEqual(keys([[0, 0], [1.5, 1], [3.5, 1], [5, 0]], { interp: 'linear' }));
  s = run(s, { type: 'select', row: 0 }, { type: 'preset', name: 'rampIn', seconds: 5 });
  expect(s.rows[0].time).toEqual(keys([[0, 0], [1.5, 1]], { interp: 'linear' }));
  s = run(s, { type: 'paste', curve: keys([[1, 0.2], [2, 0.4]]) });
  expect(s.rows[0].time).toEqual(keys([[1, 0.2], [2, 0.4]]));
  expect(run(s, { type: 'paste', curve: keys([[2, 0], [1, 1]]) })).toBe(s);
  // Strip edits go through the same history: a strength drag is one step, a removed row another.
  const before = s.past.length;
  s = run(s, { type: 'rows', rows: s.rows.map((r, i) => i ? r : { ...r, strength: 2 }) }, { type: 'rows', rows: s.rows.map((r, i) => i ? r : { ...r, strength: 2.5 }) });
  expect(s.past).toHaveLength(before + 1);
  s = run(s, { type: 'select', row: 1, point: 1 }, { type: 'rows', rows: s.rows.slice(0, 1) });
  expect([s.rows.length, s.row, s.point]).toEqual([1, 0, -1]);
  expect(run(s, { type: 'rows', rows: s.rows })).toBe(s);
  // Everything stayed a row list the compiler accepts, and undo walks back to the opening rows; redo forward again.
  const end = s;
  for (const past of s.past) expect(isDialRows(past)).toBe(true);
  expect(isDialRows(s.rows)).toBe(true);
  while (s.past.length) s = run(s, { type: 'undo' });
  expect(s.rows).toEqual(rows());
  expect(run(s, { type: 'undo' })).toBe(s);
  while (s.future.length) s = run(s, { type: 'redo' });
  expect(s.rows).toEqual(end.rows);
  expect(run(s, { type: 'redo' })).toBe(s);
  // A new edit drops the redo list.
  s = run(s, { type: 'undo' }, { type: 'rows', rows: [] });
  expect([s.future.length, s.row]).toEqual([0, -1]);
});

test('the blend-step default follows native dial_blend_steps', () => {
  expect([1, 2, 3, 4, 6, 7, 8, 12, 20, 25, 30, 50, 150].map(dialBlendSteps)).toEqual([1, 2, 2, 2, 2, 2, 3, 4, 7, 8, 10, 17, 50]);
  expect(rust).toContain('((2 * steps + 3) / 6).max(2).min(steps.max(1))');
  expect(rust).toContain(`const DIAL_BLEND_STEPS: u64 = ${DIAL_BLEND_STEPS};`);
  // The native test's own table, so both sides are held to the same numbers.
  const table = [...rustTests.match(/for \(steps, expected\) in \[([\s\S]*?)\] \{/)![1].matchAll(/\((\d+), (\d+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
  expect(table.length).toBe(13);
  for (const [steps, expected] of table) expect(dialBlendSteps(steps), String(steps)).toBe(expected);
});

// Each refusal: the fact that triggers it and the wording native reports for it (jobs_video.rs unless noted).
const curved: DialRow = { dial: calm, strength: 1, on: true, time: keys([[0, 0], [1.5, 1]]) };
const refusals: Record<DialCurveConflict, { facts: Partial<DialCurveFacts>; native: string }> = {
  blendSteps: { facts: { rows: [{ ...curved, time: { ...curved.time!, steps: 7 } }] }, native: 'Invalid dials: time.steps (blend steps) cannot exceed the job\'s {steps} sampler steps' },
  transition: { facts: { transition: true }, native: 'Invalid dials: time curves cannot run on an h3.transition window' },
  faceRefine: { facts: { faceRefine: true }, native: 'Invalid dials: time curves cannot run with faceRefine (its sampler pass has its own clip clock); use rows without a time curve' },
  tiledUpscale: { facts: { tiledUpscale: true }, native: 'Invalid dials: time curves cannot run with the tiled latent upscale (it samples the generation model on chunks with their own clip clock); use rows without a time curve' },
  deropeContinued: { facts: { continued: true, derope: true }, native: 'Invalid dials: time curves cannot run with videoPost.derope on a continued segment (the second pass renders a different window than the first); use rows without a time curve' },
  importedVideo: { facts: { continued: true, importedVideo: true }, native: 'Invalid dials: time curves cannot run on a continuation of an imported video (its start in the piece is not known before the run)' },
  sourceFrames: { facts: { continued: true, windowStart: null }, native: 'Invalid dials: time curves on a continued segment need the pinned checkpoint clip\'s sourceFrames from the session list and a legal context window' },
  shift: { facts: { continued: true, windowStart: 1e17, rows: [{ ...curved, time: keys([[0, 0], [1, 1]]) }] }, native: 'Invalid dials: time points are too close together to shift onto the continued segment\'s window' },
  holdMapMissing: { facts: { derope: true, nodes: [dialRackNode] }, native: 'MAIDialHoldMap' },
  curveLimits: { facts: { rows: [{ ...curved, time: { ...curved.time!, smooth: 2 } }] }, native: 'Invalid dials: time is {type keys, points, unit seconds, interp? linear|step, smooth? 0..1, steps?, audio? follow|protect}' },
};
test.each(dialCurveConflictIds)('time-curve refusal %s is found before Run and matches the native validator', id => {
  const base: DialCurveFacts = { rows: [{ dial: motion, strength: 1.5 }, curved], steps: 6, nodes: [dialRackNode, dialHoldMapNode] };
  expect(dialCurveConflicts(base)).toEqual([]);
  const facts = { ...base, ...refusals[id].facts };
  expect(dialCurveConflicts(facts)).toEqual([id]);
  // The native source carries this exact refusal.
  expect(rust).toContain(refusals[id].native);
  // Rows without a time curve, switched off or at strength 0 are a plain model patch: nothing is refused.
  for (const inert of [facts.rows.map(r => ({ dial: r.dial, strength: r.strength })), facts.rows.map(r => ({ ...r, on: false })), facts.rows.map(r => ({ ...r, strength: 0 }))]) expect(dialCurveConflicts({ ...facts, rows: inert })).toEqual([]);
});

test('refusals are listed in the order native checks them, and facts are read from a built intent', () => {
  const all = dialCurveConflicts({ rows: [{ ...curved, time: { ...curved.time!, steps: 9 } }], steps: 6, transition: true, faceRefine: true, tiledUpscale: true, derope: true, continued: true, importedVideo: true, nodes: [] });
  expect(all).toEqual(['blendSteps', 'transition', 'faceRefine', 'tiledUpscale', 'deropeContinued', 'importedVideo', 'holdMapMissing']);
  const at = (id: DialCurveConflict) => rust.indexOf(refusals[id].native.split('{steps}')[0]);
  const native = ['blendSteps', 'transition', 'faceRefine', 'tiledUpscale', 'deropeContinued', 'importedVideo', 'sourceFrames', 'shift'] as const;
  native.forEach((id, i) => { if (i) expect(at(id), id).toBeGreaterThan(at(native[i - 1])); });
  // Blend steps at the job's own count are legal; the unknown window start (Studio before Run) is not reported.
  expect(dialCurveConflicts({ rows: [{ ...curved, time: { ...curved.time!, steps: 6 } }], steps: 6, continued: true })).toEqual([]);
  expect(dialCurveConflicts({ rows: [curved], steps: 6, continued: true, windowStart: 2 })).toEqual([]);
  expect(dialCurveConflicts({ rows: [curved], steps: 6, derope: true })).toEqual([]);
  expect(dialCurveConflicts({ rows: [curved], steps: 6, derope: true, importedVideo: true })).toEqual([]);
  const intent = { recipeId: 'video-generation', version: 1, family: 'minimax-h3', steps: 25, dials: [curved], faceRefine: {}, videoPost: { derope: { preset: 'balanced', inject: 0.48 } },
    latentUpscale: { model: 'u.safetensors', scale: 2, steps: 1, denoise: 0.2 }, h3: { mode: 'T2VA', references: [], transition: { files: [], contextFrames: 5, transitionFrames: 29 }, continuity: { session: 's', sourceId: 'clip', sourceKind: 'video', capture: true, action: '', outputMode: 'full' } } } as unknown as VideoIntentV1;
  expect(dialIntentFacts(intent, ['MAIDialRack'])).toEqual({ rows: [curved], steps: 25, transition: true, faceRefine: true, tiledUpscale: true, derope: true, continued: true, importedVideo: true, nodes: ['MAIDialRack'] });
  const plain = { recipeId: 'video-generation', version: 1, family: 'minimax-h3', steps: 6, latentUpscale: { model: 'm', regenerate: { lora: 'l', target: '2K' } }, h3: { mode: 'T2VA', references: [], continuity: { session: 's', sourceId: '', capture: true, action: '', outputMode: 'full' } } } as unknown as VideoIntentV1;
  expect(dialIntentFacts(plain)).toEqual({ rows: [], steps: 6, transition: false, faceRefine: false, tiledUpscale: false, derope: false, continued: false, importedVideo: false });
  expect(dialIntentFacts({ ...plain, family: 'ltx-2' } as unknown as VideoIntentV1).rows).toEqual([]);
});

test('a new curve is authored with the dial file\'s blend steps when given, and the audio mode is written only as protect', () => {
  const start = rackState([{ dial: 'dials/a.safetensors', strength: 2, on: true }, { dial: 'dials/b.safetensors', strength: 1, on: true }]);
  // Without the file's value the curve is what it was before: DEAS's default applies at compile time.
  expect(rackReduce(start, { type: 'addCurve', seconds: 4 }).rows[0].time).toEqual({ type: 'keys', points: [[0, 1], [4, 1]], unit: 'seconds' });
  const added = rackReduce(start, { type: 'addCurve', seconds: 4, steps: 6 });
  expect(added.rows[0].time).toEqual({ type: 'keys', points: [[0, 1], [4, 1]], unit: 'seconds', steps: 6 });
  // A preset on a constant row starts a curve the same way; on an existing curve it keeps what is authored.
  expect(rackReduce(start, { type: 'preset', name: 'rampIn', seconds: 4, steps: 6 }).rows[0].time).toEqual({ type: 'keys', points: [[0, 0], [1.5, 1]], unit: 'seconds', interp: 'linear', steps: 6 });
  const cleared = rackReduce(added, { type: 'set', patch: { steps: null } });
  expect(rackReduce(cleared, { type: 'preset', name: 'rampIn', seconds: 4, steps: 6 }).rows[0].time!.steps).toBeUndefined();
  expect(rackReduce(rackReduce(added, { type: 'set', patch: { steps: 3 } }), { type: 'preset', name: 'dip', seconds: 4, steps: 6 }).rows[0].time!.steps).toBe(3);

  const protectedCurve = rackReduce(added, { type: 'set', patch: { audio: 'protect' } });
  expect(protectedCurve.rows[0].time).toEqual({ type: 'keys', points: [[0, 1], [4, 1]], unit: 'seconds', steps: 6, audio: 'protect' });
  expect(protectedCurve.past).toHaveLength(2);
  // Follow is the node's default: the key goes away, so the row is byte for byte the one before the mode was set.
  const followed = rackReduce(protectedCurve, { type: 'set', patch: { audio: 'follow' } });
  expect(JSON.stringify(followed.rows)).toBe(JSON.stringify(added.rows));
  expect(rackReduce(added, { type: 'set', patch: { audio: 'follow' } })).toBe(added);
  expect(rackReduce(protectedCurve, { type: 'undo' }).rows).toEqual(added.rows);
  // A row without a curve has no audio mode to set.
  const other = rackReduce(start, { type: 'select', row: 1 });
  expect(rackReduce(other, { type: 'set', patch: { audio: 'protect' } })).toBe(other);
  expect(isDialRows(protectedCurve.rows)).toBe(true);
});
