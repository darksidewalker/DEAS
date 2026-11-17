import rust from '../../src-tauri/src/jobs_video.rs?raw';
import rustTests from '../../src-tauri/src/jobs_video_tests.rs?raw';
import { expect, test } from 'vitest';
import fixture from './dialCurve.fixture.json';
import { DIAL_GAP, addPoint, continuationFrames, continuationWindowStart, dialCurveText, dialFrameLevels, dialPresetPoints, dialPresets, dialTimeline, dialWindowLevels, flatCurve, shiftDialCurve, latentFrameStarts, movePoint, nearPoint, parseDialCurveText, rackReduce, rackState, removePoint, sampleDialCurve, widestGap, type CurveLimits, type RackAction, type RackState } from './dialCurve';
import { DIAL_BLEND_ALL, DIAL_BLEND_STEPS, dialBlendSteps, dialCurveConflictIds, dialCurveConflicts, dialHoldMapNode, dialIntentFacts, dialRackNode, isDialCurve, isDialRows, withDialSourceFrames, withDials, type DialCurveConflict, type DialCurveFacts, type DialRow } from './dials';
import { isContinuityPlan } from './continuity';
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
  expect(dialTimeline(107, null, false)).toEqual({ seconds: 107 / 24, frames: 107, edges: [], basis: 'clip' });
  expect(dialTimeline(107, { steps: [] }, false).basis).toBe('clip');
  // Step 0 renders 17k + 5 frames; later steps add what native continuation_extension gives for the mode.
  const plan = dialTimeline(107, { steps: [{ seconds: 5 }, { seconds: 3 }, { seconds: 0.2 }] }, false);
  expect(plan).toEqual({ seconds: (124 + 68 + 17) / 24, frames: 209, edges: [124 / 24, 192 / 24], basis: 'plan' });
  // A 1 s step: its 39-frame clip (17k + 5) snaps to 34 new frames where the Director gets frames / 24 (T2VA, I2VA, L2VA, FL2VA),
  // and to 17 where the intent carries durationSeconds (REF2VA).
  expect(dialTimeline(124, { steps: [{ seconds: 5 }, { seconds: 1 }] }, false)).toEqual({ seconds: 158 / 24, frames: 158, edges: [124 / 24], basis: 'plan' });
  expect(dialTimeline(124, { steps: [{ seconds: 5 }, { seconds: 1 }] }, true)).toEqual({ seconds: 141 / 24, frames: 141, edges: [124 / 24], basis: 'plan' });
  // A plan that continues an existing clip starts at a frame count Studio does not hold.
  expect(dialTimeline(107, { steps: [{ seconds: 5 }], source: { clipId: 'x' } }, false)).toEqual({ seconds: 107 / 24, frames: 107, edges: [], basis: 'planSource' });
});

test('a continued step adds the frames native continuation_extension gives, by duration or by frames', () => {
  // Native's two branches, as written there.
  expect(rust).toContain('Some(s) => s * 24.0 / 17.0,');
  expect(rust).toContain('None => i["frames"].as_f64()? / 17.0,');
  expect(rust).toContain('Some(((steps + 0.5).floor().max(1.0) as u64) * 17)');
  // The native test's own table (0.5 to 15 s in 0.5 s steps), so both sides are held to the same numbers.
  const body = rustTests.match(/for \(seconds, frames, by_duration, by_frames\) in \[([\s\S]*?)\] \{/)![1];
  const table = [...body.matchAll(/\(([\d.]+), (\d+), (\d+), (\d+)\)/g)].map(m => m.slice(1).map(Number));
  expect(table.map(r => r[0])).toEqual(Array.from({ length: 30 }, (_, n) => (n + 1) / 2));
  for (const [seconds, frames, byDuration, byFrames] of table) {
    expect(videoFrames('minimax-h3', seconds, 24), `${seconds} s`).toBe(frames);
    expect(continuationFrames(seconds, true), `${seconds} s by duration`).toBe(byDuration);
    expect(continuationFrames(seconds, false), `${seconds} s by frames`).toBe(byFrames);
    // The lane of a two-step plan ends where the compiler ends the piece.
    expect(dialTimeline(124, { steps: [{ seconds: 5 }, { seconds }] }, true).frames).toBe(124 + byDuration);
    expect(dialTimeline(124, { steps: [{ seconds: 5 }, { seconds }] }, false).frames).toBe(124 + byFrames);
  }
  // The two rules differ on some lengths, which is why the mode matters.
  expect(table.filter(r => r[2] !== r[3]).map(r => r[0])).toEqual([1, 4.5, 6, 9.5, 13, 14.5]);
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

test('a level-only edit never moves a point in time: points outside the lane and pasted close points stay where they are', () => {
  // Whole-piece curves, a clip shortened after authoring, a preset in seconds from a longer clip: the ends may lie outside the lane.
  const wide = keys([[-2, 0], [1, 1], [8, 0.5]]);
  expect(movePoint(wide, 0, -2, 0.7, lim).points).toEqual([[-2, 0.7], [1, 1], [8, 0.5]]);
  expect(movePoint(wide, 2, 8, 0.2, lim).points).toEqual([[-2, 0], [1, 1], [8, 0.2]]);
  // A pasted point closer than one latent frame to its neighbour keeps its time on a level change, on the grid or off it.
  const close = keys([[1, 0], [1.05, 1], [3, 0]]);
  expect(movePoint(close, 1, 1.05, 0.5, lim).points[1]).toEqual([1.05, 0.5]);
  expect(movePoint(close, 0, 1, 0.5, { ...lim, snap: 0 }).points[0]).toEqual([1, 0.5]);
  // An off-grid time is not snapped by a level change either.
  expect(movePoint(keys([[0.123, 0], [2, 1]]), 0, 0.123, 0.4, lim).points[0]).toEqual([0.123, 0.4]);
  // The same through the reducer: the Level field, and the up/down keys.
  const start = rackState([{ dial: calm, strength: 1, on: true, time: wide }]);
  expect(rackReduce(start, { type: 'move', point: 0, t: -2, level: 0.35, lim: { ...lim, snap: 0 }, tag: 'typed:level:0:0' }).rows[0].time!.points[0]).toEqual([-2, 0.35]);
  expect(rackReduce(start, { type: 'nudge', point: 2, dt: 0, dl: 0.05, lim }).rows[0].time!.points[2]).toEqual([8, 0.55]);
  expect(rackReduce(rackState([{ dial: calm, strength: 1, on: true, time: close }]), { type: 'nudge', point: 1, dt: 0, dl: -0.05, lim }).rows[0].time!.points[1]).toEqual([1.05, 0.95]);
  // A time change still brings the point into the lane and one latent frame from its neighbour.
  expect(movePoint(wide, 0, -1.9, 0, lim).points[0].map(v => v + 0)).toEqual([0, 0]);
  expect(movePoint(wide, 2, 7.9, 0.5, lim).points[2]).toEqual([5, 0.5]);
  expect(movePoint(close, 1, 1.06, 1, { ...lim, snap: 0 }).points[1]).toEqual([1.1667, 1]);
  expect(rackReduce(start, { type: 'nudge', point: 0, dt: 0.1, dl: 0, lim }).rows[0].time!.points[0].map(v => v + 0)).toEqual([0, 0]);
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

test('separate strip gestures are separate undo steps; one drag stays one', () => {
  const strength = (s: RackState, v: number): RackAction => ({ type: 'rows', rows: s.rows.map((r, i) => i ? r : { ...r, strength: v }) });
  const on = (s: RackState, v: boolean): RackAction => ({ type: 'rows', rows: s.rows.map((r, i) => i ? r : { ...r, on: v }) });
  const end: RackAction = { type: 'gesture' };
  let s = rackState(rows());
  // One slider drag: many changes, then the gesture ends (pointer up, blur or the field's change commit).
  for (const v of [1.6, 1.8, 2]) s = rackReduce(s, strength(s, v));
  s = rackReduce(s, end);
  expect(s.past).toHaveLength(1);
  // A later edit of the same row and field is its own step.
  for (const v of [2.5, 3]) s = rackReduce(s, strength(s, v));
  s = rackReduce(s, end);
  expect(s.past).toHaveLength(2);
  s = rackReduce(s, { type: 'undo' });
  expect(s.rows[0].strength).toBe(2);
  s = rackReduce(s, { type: 'undo' });
  expect(s.rows[0].strength).toBe(1.5);
  expect(s.past).toHaveLength(0);
  // A switch is never a drag: on, off, on are three steps and every undo changes something.
  s = rackState(rows());
  for (const v of [false, true, false]) s = rackReduce(s, on(s, v));
  expect(s.past).toHaveLength(3);
  const seen = [s.rows[0].on];
  while (s.past.length) { s = rackReduce(s, { type: 'undo' }); seen.push(s.rows[0].on); }
  expect(seen).toEqual([false, true, false, true]);
  // Ending a gesture changes nothing else and is free when none is open.
  const idle = rackState(rows());
  expect(rackReduce(idle, end)).toBe(idle);
  const mid = rackReduce(idle, strength(idle, 2)), ended = rackReduce(mid, end);
  expect([ended.rows, ended.past, ended.row, ended.point]).toEqual([mid.rows, mid.past, mid.row, mid.point]);
});

test('the blend-step default follows native dial_blend_steps', () => {
  expect([1, 2, 3, 4, 6, 7, 8, 9, 12, 20, 25, 30, 50, 150].map(dialBlendSteps)).toEqual([1, 2, 3, 4, 6, 7, 8, 3, 4, 7, 8, 10, 17, 50]);
  expect(rust).toContain('((2 * steps + 3) / 6).max(2)');
  expect(rust).toContain(`const DIAL_BLEND_ALL: u64 = ${DIAL_BLEND_ALL};`);
  expect(rust).toContain(`const DIAL_BLEND_STEPS: u64 = ${DIAL_BLEND_STEPS};`);
  // The native test's own table, so both sides are held to the same numbers.
  const table = [...rustTests.match(/for \(steps, expected\) in \[([\s\S]*?)\] \{/)![1].matchAll(/\((\d+), (\d+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
  expect(table.length).toBe(14);
  for (const [steps, expected] of table) expect(dialBlendSteps(steps), String(steps)).toBe(expected);
});

// Each refusal: the fact that triggers it and the wording native reports for it (jobs_video.rs unless noted).
const curved: DialRow = { dial: calm, strength: 1, on: true, time: keys([[0, 0], [1.5, 1]]) };
// `native` is the wording in jobs_video.rs; a refusal of the node itself has none there and names the node's own message instead.
const refusals: Record<DialCurveConflict, { facts: Partial<DialCurveFacts>; native?: string; node?: string }> = {
  blendSteps: { facts: { rows: [{ ...curved, time: { ...curved.time!, steps: 7 } }] }, native: 'Invalid dials: time.steps (blend steps) cannot exceed the job\'s {steps} sampler steps' },
  transition: { facts: { transition: true }, native: 'Invalid dials: time curves cannot run on an h3.transition window' },
  faceRefine: { facts: { faceRefine: true }, native: 'Invalid dials: time curves cannot run with faceRefine (its sampler pass has its own clip clock); use rows without a time curve' },
  tiledUpscale: { facts: { tiledUpscale: true }, native: 'Invalid dials: time curves cannot run with the tiled latent upscale (it samples the generation model on chunks with their own clip clock); use rows without a time curve' },
  deropeContinued: { facts: { continued: true, derope: true }, native: 'Invalid dials: time curves cannot run with videoPost.derope on a continued segment (the second pass renders a different window than the first); use rows without a time curve' },
  importedVideo: { facts: { continued: true, importedVideo: true }, native: 'Invalid dials: time curves cannot run on a continuation of an imported video (its start in the piece is not known before the run)' },
  sourceFrames: { facts: { continued: true, windowStart: null }, native: 'Invalid dials: time curves on a continued segment need the pinned checkpoint clip\'s sourceFrames from the session list and a legal context window' },
  shift: { facts: { continued: true, windowStart: 1e17, rows: [{ ...curved, time: keys([[0, 0], [1, 1]]) }] }, native: 'Invalid dials: time points are too close together to shift onto the continued segment\'s window' },
  // Studio's own refusal: native compiles this job and moves the points by the window's start; Studio cannot draw where they land.
  pieceStart: { facts: { pieceStartUnknown: true }, native: 'continuation_window_start(i).expect("validated with dials") as f64 / 24.0' },
  // The node's own refusal (ComfyUI-MAINodes 382f640, dials/timecurve.py::apply_rack); native does not know a dial's mode.
  preDial: { facts: { noCurve: [calm] }, node: 'time curves support post-refiner dials only; pre-refiner rows cannot vary over time' },
  holdMapMissing: { facts: { derope: true, nodes: [dialRackNode] }, native: 'MAIDialHoldMap' },
  curveLimits: { facts: { rows: [{ ...curved, time: { ...curved.time!, smooth: 2 } }] }, native: 'Invalid dials: time is {type keys, points, unit seconds, interp? linear|step, smooth? 0..1, steps?, audio? follow|protect}' },
};
test.each(dialCurveConflictIds)('time-curve refusal %s is found before Run and matches the native validator', id => {
  const base: DialCurveFacts = { rows: [{ dial: motion, strength: 1.5 }, curved], steps: 6, nodes: [dialRackNode, dialHoldMapNode] };
  expect(dialCurveConflicts(base)).toEqual([]);
  const facts = { ...base, ...refusals[id].facts };
  expect(dialCurveConflicts(facts)).toEqual([id]);
  // The native source carries this exact refusal; a refusal of the node itself is not in it.
  if (refusals[id].native !== undefined) expect(rust).toContain(refusals[id].native);
  else expect(refusals[id].node!.length).toBeGreaterThan(20);
  // Rows without a time curve, switched off or at strength 0 are a plain model patch: nothing is refused.
  for (const inert of [facts.rows.map(r => ({ dial: r.dial, strength: r.strength })), facts.rows.map(r => ({ ...r, on: false })), facts.rows.map(r => ({ ...r, strength: 0 }))]) expect(dialCurveConflicts({ ...facts, rows: inert })).toEqual([]);
});

test('refusals are listed in the order native checks them, and facts are read from a built intent', () => {
  const all = dialCurveConflicts({ rows: [{ ...curved, time: { ...curved.time!, steps: 9 } }], steps: 6, transition: true, faceRefine: true, tiledUpscale: true, derope: true, continued: true, importedVideo: true, pieceStartUnknown: true, noCurve: [calm], nodes: [] });
  expect(all).toEqual(['blendSteps', 'transition', 'faceRefine', 'tiledUpscale', 'deropeContinued', 'importedVideo', 'pieceStart', 'preDial', 'holdMapMissing']);
  // A pre-refiner dial without a curve, or one that is not in the rack, is no refusal; separators are compared normalized.
  expect(dialCurveConflicts({ rows: [{ dial: motion, strength: 1.5 }, curved], steps: 6, noCurve: [motion, 'dials/other.safetensors'] })).toEqual([]);
  expect(dialCurveConflicts({ rows: [{ ...curved, dial: 'dials\\sub\\a.safetensors' }], steps: 6, noCurve: ['dials/sub/a.safetensors'] })).toEqual(['preDial']);
  expect(dialCurveConflictIds).toEqual(['blendSteps', 'transition', 'faceRefine', 'tiledUpscale', 'deropeContinued', 'importedVideo', 'sourceFrames', 'shift', 'pieceStart', 'preDial', 'holdMapMissing', 'curveLimits']);
  const at = (id: DialCurveConflict) => rust.indexOf(refusals[id].native!.split('{steps}')[0]);
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

test('the window of a continued step starts where native continuation_window_start puts it', () => {
  // Native's resolution, as written there.
  expect(rust).toContain('None => 22,');
  expect(rust).toContain('.min(362u64.checked_sub(continuation_extension(i)?)?)');
  expect(rust).toContain('let overlap = [73, 56, 39, 22, 5].into_iter().find(|n| *n <= available)?;');
  expect(rust).toContain('Some(source - overlap)');
  // The native test's own table: (sourceFrames, overlapFrames, durationSeconds) -> window start in piece frames. Its intent has 124 frames
  // (a 5 s step), so a row without durationSeconds is snapped by frames.
  const body = rustTests.match(/for \(source, overlap, seconds, start\) in \[([\s\S]*?)\] \{/)![1];
  const table = [...body.matchAll(/\((\d+), (None|Some\((\d+)\)), (None|Some\(([\d.]+)\)), (\d+)\)/g)].map(m => ({ source: Number(m[1]), overlap: m[3] === undefined ? undefined : Number(m[3]), seconds: m[5] === undefined ? undefined : Number(m[5]), start: Number(m[6]) }));
  expect(table.length).toBe(13);
  expect(table.filter(r => r.overlap === undefined).length).toBeGreaterThan(2);
  for (const r of table) {
    const extension = r.seconds === undefined ? continuationFrames(5, false) : continuationFrames(r.seconds, true);
    expect(continuationWindowStart(r.source, r.overlap, extension), JSON.stringify(r)).toBe(r.start);
    // The lanes of a one-step plan on that clip put the next clip's window at the same frame.
    const lanes = dialTimeline(124, { steps: [{ seconds: r.seconds ?? 5 }], source: { clipId: 'x', frames: r.source }, overlapFrames: r.overlap }, r.seconds !== undefined);
    if ((r.source - 5) % 17 === 0) expect(lanes.window, JSON.stringify(r)).toEqual({ start: r.start / 24, frames: r.source - r.start + extension });
  }
  // No legal context: a source shorter than 5 frames, or an extension that leaves no room (cannot occur for 15 s or less).
  expect(continuationWindowStart(4, undefined, 119)).toBeNull();
  expect(continuationWindowStart(243, 22, 363)).toBeNull();
});

test('a plan that continues a clip whose frame count Studio holds is laid out as the whole piece from 0 s', () => {
  const plan = { source: { clipId: 'pinned', endpoint: 'http://x', frames: 243 }, steps: [{ seconds: 5 }, { seconds: 3 }] };
  // 243 frames exist; the 5 s step adds 119 and the 3 s step 68 (text to video). The next step samples 22 context frames and its 119 new ones.
  expect(dialTimeline(107, plan, false)).toEqual({ seconds: 430 / 24, frames: 430, edges: [243 / 24, 362 / 24], basis: 'planContinued', rendered: 243 / 24, window: { start: 221 / 24, frames: 141 } });
  // More context moves the window start back, as in the compiler.
  expect(dialTimeline(107, { ...plan, overlapFrames: 73 }, false).window).toEqual({ start: 170 / 24, frames: 192 });
  // A finished first step is rendered too; the window is the second step's, counted from the frames before it.
  const second = dialTimeline(107, { ...plan, steps: [{ seconds: 5, clipId: 'made' }, { seconds: 3 }] }, false);
  expect(second).toMatchObject({ frames: 430, basis: 'planContinued', rendered: 362 / 24, window: { start: 340 / 24, frames: 90 } });
  // Every step done: all of it is rendered and there is no next window.
  const done = dialTimeline(107, { ...plan, steps: [{ seconds: 5, clipId: 'a' }, { seconds: 3, clipId: 'b' }] }, false);
  expect(done.rendered).toBe(430 / 24);
  expect(done.window).toBeUndefined();
  // REF2VA snaps the step's seconds: 4.5 s adds 102 frames there and 119 by frames.
  expect(dialTimeline(107, { ...plan, steps: [{ seconds: 4.5 }] }, true).frames).toBe(243 + 102);
  expect(dialTimeline(107, { ...plan, steps: [{ seconds: 4.5 }] }, false).frames).toBe(243 + 119);
  // Without a usable count the lanes stay on the clip and the curves are held: no count, an illegal one, an imported video.
  for (const source of [{ clipId: 'pinned' }, { clipId: 'pinned', frames: 240 }, { clipId: 'pinned', frames: 4 }, { clipId: 'a'.repeat(64), kind: 'video', frames: 243 }])
    expect(dialTimeline(107, { ...plan, source }, false), JSON.stringify(source)).toEqual({ seconds: 107 / 24, frames: 107, edges: [], basis: 'planSource' });
});

test('the per-frame line of a continued window is the shifted curve the compiler sends, drawn back at piece seconds', () => {
  // The native test: 73 source frames and 22 context frames start the window at frame 51 = 2.125 s, and these points are emitted.
  expect(rustTests).toContain('i["dials"] = timed(json!([[2.125, 0], [4.125, 1], [9, -2]]));');
  expect(rustTests).toContain('"points":[[0.0,0],[2.0,1],[6.875,-2]]');
  const curve = keys([[2.125, 0], [4.125, 1], [9, -2]]), start = continuationWindowStart(73, undefined, 119)! / 24;
  expect(start).toBe(2.125);
  expect(shiftDialCurve(curve, start).points).toEqual([[0, 0], [2, 1], [6.875, -2]]);
  // 22 + 119 = 141 frames: 17k + 5, so 5k + 2 = 42 latent frames, the first one frame long, placed from the window start on.
  const window = { start, frames: 141 }, levels = dialWindowLevels(curve, window);
  expect(levels).toHaveLength(42);
  expect(levels[0].start).toBe(start);
  expect(levels[0].end).toBeCloseTo(start + 1 / 24, 12);
  expect(levels.at(-1)!.end).toBeCloseTo(start + 141 / 24, 12);
  // Each value is the authored curve's mean over that latent frame's pixel frames, at piece seconds.
  const own = dialFrameLevels(shiftDialCurve(curve, start), 141);
  levels.forEach((f, k) => {
    const frames = Math.round((f.end - f.start) * 24), at = Array.from({ length: frames }, (_, j) => f.start + j / 24);
    expect(f.level, `frame ${k}`).toBeCloseTo(sampleDialCurve(curve, at).reduce((a, b) => a + b, 0) / frames, 10);
    expect(f.level).toBe(own[k].level);
  });
  // The hidden context frames lie before the clip's end (3.0417 s) and still get the curve's values there.
  expect(levels.filter(f => f.start < 73 / 24 - 1e-9).length).toBeGreaterThan(4);
});

test('a new curve and the presets start after the rendered part of a continued piece', () => {
  const rendered = 243 / 24, end = 362 / 24;
  expect(flatCurve(end, rendered).points).toEqual([[10.125, 1], [15.0833, 1]]);
  expect(flatCurve(end).points).toEqual([[0, 1], [15.0833, 1]]);
  expect(dialPresetPoints('rampIn', end, rendered)).toEqual([[10.125, 0], [11.625, 1]]);
  expect(dialPresetPoints('rampOut', end, rendered)).toEqual([[13.5833, 1], [15.0833, 0]]);
  expect(dialPresetPoints('pulse', end, rendered)).toEqual([[10.125, 0], [11.625, 1], [13.5833, 1], [15.0833, 0]]);
  for (const name of dialPresets) {
    const p = dialPresetPoints(name, end, rendered);
    expect(isDialCurve(keys(p)), name).toBe(true);
    expect(p[0][0]).toBeGreaterThanOrEqual(rendered);
    expect(p.at(-1)![0]).toBeLessThanOrEqual(end);
    // Without a rendered part nothing changes.
    expect(dialPresetPoints(name, end, 0)).toEqual(dialPresetPoints(name, end));
  }
  const s = run(rackState([{ dial: motion, strength: 1, on: true }]), { type: 'addCurve', seconds: end, from: rendered });
  expect(s.rows[0].time!.points).toEqual([[10.125, 1], [15.0833, 1]]);
  expect(run(s, { type: 'preset', name: 'rampIn', seconds: end, from: rendered }).rows[0].time!.points).toEqual([[10.125, 0], [11.625, 1]]);
});

test('a Continuity plan keeps the picked clip\'s frame count; plans saved without it stay valid and the intent carries it only with a time curve', () => {
  const plan = { session: 'deas-ab12cd34', outputMode: 'full', steps: [{ id: 'a', seconds: 5, action: '' }], source: { clipId: 'pinned', endpoint: 'http://127.0.0.1:8188' } };
  expect(isContinuityPlan(plan)).toBe(true);
  expect(isContinuityPlan({ ...plan, source: { ...plan.source, frames: 243 } })).toBe(true);
  // Native accepts 17k + 5 only; an imported video has no checkpoint count.
  for (const frames of [240, 4, 243.5, -12, '243', null])
    expect(isContinuityPlan({ ...plan, source: { ...plan.source, frames } }), String(frames)).toBe(false);
  expect(isContinuityPlan({ ...plan, source: { clipId: 'a'.repeat(64), endpoint: 'http://x', kind: 'video' } })).toBe(true);
  expect(isContinuityPlan({ ...plan, source: { clipId: 'a'.repeat(64), endpoint: 'http://x', kind: 'video', frames: 243 } })).toBe(false);

  const continuity = { session: 'deas-ab12cd34', sourceId: 'pinned', capture: true, action: '', outputMode: 'full' as const };
  const intent = (c: object, dials: DialRow[]) => withDials({ recipeId: 'video-generation', family: 'minimax-h3', steps: 6, h3: { mode: 'T2VA', continuity: c } } as unknown as VideoIntentV1, dials);
  const curved = intent(continuity, rows());
  const sent = withDialSourceFrames(curved, 243) as unknown as { h3: { continuity: Record<string, unknown> } };
  expect(sent.h3.continuity).toEqual({ ...continuity, sourceFrames: 243 });
  // Native accepts the key on the continuity block and checks its shape.
  expect(rust).toContain('"sourceFrames",');
  expect(rust).toContain('.is_none_or(|n| n.as_u64().is_some_and(|n| n >= 5 && (n - 5) % 17 == 0))');
  // Unchanged (the same object) without a count, without an active curve, on a new take and on an imported video.
  expect(withDialSourceFrames(curved, undefined)).toBe(curved);
  const constant = intent(continuity, [rows()[0]]);
  expect(withDialSourceFrames(constant, 243)).toBe(constant);
  const off = intent(continuity, [rows()[0], { ...rows()[1], on: false }]);
  expect(withDialSourceFrames(off, 243)).toBe(off);
  const take = intent({ ...continuity, sourceId: '' }, rows());
  expect(withDialSourceFrames(take, 243)).toBe(take);
  const video = intent({ ...continuity, sourceKind: 'video' }, rows());
  expect(withDialSourceFrames(video, 243)).toBe(video);
});

test('with the window start known, points that the shift would merge are reported before Run and the hold is not', () => {
  const facts: DialCurveFacts = { rows: rows(), steps: 6, continued: true, windowStart: 221 / 24 };
  expect(dialCurveConflicts(facts)).toEqual([]);
  expect(dialCurveConflicts({ ...facts, windowStart: null })).toEqual(['sourceFrames']);
  expect(dialCurveConflicts({ ...facts, rows: [{ dial: calm, strength: 1, time: keys([[0, 0], [1e-17, 1]]) }] })).toEqual(['shift']);
});

test('a gesture end closes the merge tag of any control, so the next edit with the same tag is its own undo step', () => {
  const start = { ...rackState(rows()), row: 1 };
  const smooth = (v: number): RackAction => ({ type: 'set', patch: { smooth: v }, tag: 'smooth:1' });
  // One gesture: three values, one step.
  const dragged = run(start, smooth(0.2), smooth(0.4), smooth(0.3));
  expect(dragged.past).toHaveLength(1);
  // Without an end the next gesture would merge into it (the defect); with it, it is a second step.
  expect(run(dragged, smooth(0.8)).past).toHaveLength(1);
  const again = run(dragged, { type: 'gesture' }, smooth(0.8));
  expect(again.past).toHaveLength(2);
  expect(run(again, { type: 'undo' }).rows[1].time!.smooth).toBe(0.3);
  // The same for a typed point field and the blend steps.
  const typed = (level: number): RackAction => ({ type: 'move', point: 1, t: 1.5, level, lim: { ...lim, snap: 0 }, tag: 'typed:level:1:1' });
  expect(run(start, typed(0.2), typed(0.25), { type: 'gesture' }, typed(0.6)).past).toHaveLength(2);
  const steps = (n: number): RackAction => ({ type: 'set', patch: { steps: n }, tag: 'steps:1' });
  expect(run(start, steps(1), steps(12), { type: 'gesture' }, steps(9)).past).toHaveLength(2);
  // An end with no gesture open changes nothing.
  expect(rackReduce(start, { type: 'gesture' })).toBe(start);
});

test('a point moved to the start of the lane gets 0 s, not -0', () => {
  const curve = keys([[0.5, 0], [2, 1]]);
  // Dragged, typed and nudged past the left edge of a lane that starts at 0 s.
  for (const moved of [movePoint(curve, 0, -1, 0, lim), movePoint(curve, 0, -0.3, 0, { ...lim, snap: 0 }), movePoint(curve, 0, 0, 0, lim)]) {
    expect(Object.is(moved.points[0][0], 0), String(1 / moved.points[0][0])).toBe(true);
    expect(JSON.stringify(moved.points)).toBe('[[0,0],[2,1]]');
  }
  const nudged = run({ ...rackState([{ dial: calm, strength: 1, on: true, time: curve }]), row: 0 }, { type: 'nudge', point: 0, dt: -1, dl: 0, lim });
  expect(Object.is(nudged.rows[0].time!.points[0][0], 0)).toBe(true);
  // The same at a lane that starts later (the rendered part of a continued piece): the bound itself.
  expect(movePoint(keys([[11, 0], [12, 1]]), 0, 3, 0, { ...lim, from: 10.125, to: 15 }).points[0][0]).toBe(10.125);
});
