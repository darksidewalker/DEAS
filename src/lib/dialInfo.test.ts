import { beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { dialCatalogPartial, dialInfoError, dialInfoOf, dialNoCurve, dialOtherFamily, isPickerDial, dialInfoSteps, dialMarks, dialOvercooked, dialPipelineOf, dialSliderRange, dialStartStrength, parseDialCatalog, readDialCatalog } from './dialInfo';
import { catalogFixture, dayNight, familyFixture, impact, inkWash, kreaDial, measuredDial, mossDial, motionDial, preDial, unlabelled } from './dialInfo.fixture';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
beforeEach(() => { vi.mocked(isTauri).mockReturnValue(true); vi.mocked(invoke).mockReset(); });
const map = parseDialCatalog(catalogFixture)!;
const info = (edit: Record<string, unknown> = {}) => dialInfoOf({ version: 2, ...edit })!;

test('the catalog answer becomes a map by dial name with exactly the fields the strip shows', () => {
  expect(Object.keys(map)).toEqual([dayNight, inkWash, impact, motionDial, measuredDial]);
  expect(map[dayNight]).toEqual({ description: 'Time of day: +1 dusk, +2 night with a blue cast. Measured on Pika H3 Flex, 1 seed.', negative: 'bright midday', positive: 'night', pipeline: 'Pika H3 Flex 6-step', notes: '',
    neg: { useful: 1.5, overcook: 3 }, pos: { useful: 1.5, overcook: 3 }, evidence: 'one-seed', family: 'MiniMax H3', mode: 'post' });
  expect(map[motionDial]).toEqual({ description: '', negative: '', positive: '', pipeline: '', notes: '', neg: { useful: null, overcook: null }, pos: { useful: null, overcook: null }, evidence: null, family: 'MiniMax H3', mode: 'post' });
  expect(map[measuredDial].pipelines).toEqual({ t2v: { useful: 2, overcook: 4, steps: 6, evidence: 'multi-seed', notes: 'follows at 6, smears at 2' }, ref2v: { useful: null, overcook: null, steps: 40, evidence: null, notes: '' }, fl2v: { useful: 3, overcook: null, evidence: 'one-seed', notes: 'no curve measured' } });
  expect(map[measuredDial].kind).toBe('look');
});

test('anything outside the pack\'s schema reads as unknown or is left out, never as a number to draw', () => {
  // Strengths: above 0, at most 20 (the compiler's row bound), finite numbers only; an overcook below the useful strength is unknown.
  for (const bad of [0, -1.5, 20.5, NaN, Infinity, '1.5', true, null, undefined, [1], {}]) expect(info({ pos: { useful: bad, overcook: bad } }).pos, String(bad)).toEqual({ useful: null, overcook: null });
  expect(info({ pos: { useful: 20, overcook: 20 } }).pos).toEqual({ useful: 20, overcook: 20 });
  expect(info({ neg: { useful: 2, overcook: 1 } }).neg).toEqual({ useful: 2, overcook: null });
  expect(info({ neg: 'x', pos: [1, 2] })).toMatchObject({ neg: { useful: null, overcook: null }, pos: { useful: null, overcook: null } });
  // Texts: text only, cut to the pack's limits.
  const long = info({ description: 'd'.repeat(2500), negative: 'n'.repeat(80), positive: 7, pipeline: 'p'.repeat(61), notes: 'x'.repeat(501) });
  expect([long.description.length, long.negative.length, long.positive, long.pipeline.length, long.notes.length]).toEqual([2000, 60, '', 60, 500]);
  expect(info({ evidence: 'hearsay' }).evidence).toBeNull();
  // Unknown keys and unknown pipelines are not carried; blend steps are whole numbers the compiler could send.
  const extra = info({ author: 'x', pipelines: { t2v: { steps: 0 }, ref2v: { steps: 151 }, fl2v: { steps: 2.5, gpu: 'x' }, v2v: { steps: 3 } } });
  expect(JSON.stringify(extra)).not.toMatch(/author|gpu|v2v/);
  expect(extra.pipelines).toEqual({ t2v: { useful: null, overcook: null, evidence: null, notes: '' }, ref2v: { useful: null, overcook: null, evidence: null, notes: '' }, fl2v: { useful: null, overcook: null, evidence: null, notes: '' } });
  expect(info({ pipelines: { t2v: 'six' } }).pipelines).toBeUndefined();
  for (const bad of [null, [], 'x', {}, { version: 1 }, { version: '2' }]) expect(dialInfoOf(bad)).toBeUndefined();
  // The map: entries that are not a dial file with info version 2 are skipped; the first of a name wins; separators are normalized.
  expect(parseDialCatalog({ dials: [{ dial: 'dials\\sub\\a.safetensors', info: { version: 2, positive: 'first' } }, { dial: 'dials/sub/a.safetensors', info: { version: 2, positive: 'second' } },
    { dial: 'loras/x.safetensors', info: { version: 2 } }, { dial: 'dials/../x.safetensors', info: { version: 2 } }, { dial: 'dials/old.safetensors', info: { version: 1 } }, { dial: 7, info: { version: 2 } }, 'x', null] }))
    .toEqual({ 'dials/sub/a.safetensors': { description: '', negative: '', positive: 'first', pipeline: '', notes: '', neg: { useful: null, overcook: null }, pos: { useful: null, overcook: null }, evidence: null } });
  for (const bad of [null, [], 'x', {}, { dials: {} }, { dials: 'x' }]) expect(parseDialCatalog(bad)).toBeNull();
});

test('the catalog keeps each dial\'s family and mode: another family is not for a MiniMax H3 job, a pre-refiner dial takes no time curve', () => {
  const families = parseDialCatalog(familyFixture)!;
  expect(Object.fromEntries(Object.entries(families).map(([dial, i]) => [dial, [i.family, i.mode]]))).toEqual({ [preDial]: ['MiniMax H3', 'pre'], [kreaDial]: ['Krea 2', 'post'], [mossDial]: ['MOSS-Image', 'post'], [unlabelled]: [undefined, undefined] });
  // Only the pack's two modes are carried.
  for (const mode of ['both', 'PRE', 7, null, undefined, '']) expect(parseDialCatalog({ dials: [{ dial: preDial, family: 'MiniMax H3', mode, info: { version: 2 } }] })![preDial].mode, String(mode)).toBeUndefined();
  // The node refuses a dial of another family (`core.check_family`); MiniMax H3 is the pack's name for the video and the image model.
  expect([preDial, kreaDial, mossDial, unlabelled].map(d => dialOtherFamily(families[d]))).toEqual([false, true, true, false]);
  expect([map[dayNight], map[motionDial], undefined].map(dialOtherFamily)).toEqual([false, false, false]);
  // The node runs time curves on post-refiner dials only (`timecurve.apply_rack`). Unknown stays allowed.
  expect([preDial, kreaDial, unlabelled].map(d => dialNoCurve(families[d]))).toEqual([true, false, false]);
  expect([map[motionDial], undefined].map(dialNoCurve)).toEqual([false, false]);
});

test('the LoRA browser leaves out dial files: by path while no catalog was read, by the catalog\'s list once it was', () => {
  const real = 'dials/real_lora.safetensors', probe = 'dials/_probes/x.safetensors', windows = 'dials\\h3_motion.safetensors';
  const names = [motionDial, windows, dayNight, real, probe, 'style.safetensors', 'dials/readme.txt', 'other/dials/x.safetensors'];
  // No catalog (not read yet, no pack, a failed read): today's path rule, every .safetensors inside dials/.
  expect(names.filter(n => isPickerDial(n))).toEqual([motionDial, windows, dayNight, real, probe]);
  // Catalog read: the files it lists. A file in dials/ that it does not list is not a dial file (the pack lists exactly the files that hold a
  // dial's single tensor), so a real LoRA kept there is a LoRA again. Folders starting with "_" are never listed: the path rule stays for them.
  expect(names.filter(n => isPickerDial(n, { map, partial: false }))).toEqual([motionDial, windows, dayNight, probe]);
  // A catalog that native cut at its limit or left entries out of cannot say what an unlisted file is: the path rule stays.
  expect(names.filter(n => isPickerDial(n, { map, partial: true }))).toEqual([motionDial, windows, dayNight, real, probe]);
  expect(isPickerDial(real, { map: {}, partial: false })).toBe(false);
  expect([catalogFixture, { ...catalogFixture, truncated: true }, { ...catalogFixture, dropped: 2 }, { dials: [] }, null].map(dialCatalogPartial)).toEqual([false, true, true, false, false]);
});

test('the slider reaches at least ±3 and as far as each side\'s overcook strength, or 1.5 × its useful strength', () => {
  expect(dialSliderRange(undefined)).toEqual({ min: -3, max: 3 });
  expect(dialSliderRange(map[motionDial])).toEqual({ min: -3, max: 3 });
  expect(dialSliderRange(map[dayNight])).toEqual({ min: -3, max: 3 });
  // No overcook recorded: 2 × 1.5 = 3. Overcook 8 on the positive side only.
  expect(dialSliderRange(map[inkWash])).toEqual({ min: -3, max: 3 });
  expect(dialSliderRange(map[impact])).toEqual({ min: -3, max: 8 });
  // 2.3 × 1.5 = 3.45; the reach lands on the slider's 0.05 grid and never passes the compiler's 20.
  expect(dialSliderRange(map[measuredDial])).toEqual({ min: -3, max: 3.45 });
  expect(dialSliderRange(info({ pos: { useful: 2.31 } }))).toEqual({ min: -3, max: 3.5 });
  expect(dialSliderRange(info({ neg: { useful: 4.5, overcook: 6 }, pos: { useful: 18 } }))).toEqual({ min: -6, max: 20 });
  expect(dialSliderRange(info({ pos: { useful: 1, overcook: 1.2 } }))).toEqual({ min: -3, max: 3 });
});

test('marks sit at the recorded useful and overcook strengths of each side, as fractions of the slider', () => {
  expect(dialMarks(undefined)).toEqual([]);
  expect(dialMarks(map[motionDial])).toEqual([]);
  expect(dialMarks(map[dayNight])).toEqual([
    { side: 'neg', kind: 'useful', value: 1.5, strength: -1.5, at: 0.25 }, { side: 'neg', kind: 'overcook', value: 3, strength: -3, at: 0 },
    { side: 'pos', kind: 'useful', value: 1.5, strength: 1.5, at: 0.75 }, { side: 'pos', kind: 'overcook', value: 3, strength: 3, at: 1 }]);
  // Range -3 .. 8: +4.5 is 7.5 / 11 along, +8 the right end.
  const marks = dialMarks(map[impact]);
  expect(marks.map(m => [m.side, m.kind, m.strength])).toEqual([['pos', 'useful', 4.5], ['pos', 'overcook', 8]]);
  expect(marks[0].at).toBeCloseTo(7.5 / 11, 12);
  expect(marks[1].at).toBe(1);
  expect(dialMarks(map[inkWash]).map(m => [m.kind, m.strength, +m.at.toFixed(4)])).toEqual([['useful', 2, 0.8333]]);
});

test('a strength above its side\'s overcook strength is flagged; without one nothing is', () => {
  expect(dialOvercooked(map[dayNight], 3)).toBeNull();
  expect(dialOvercooked(map[dayNight], 3.05)).toBe(3);
  expect(dialOvercooked(map[dayNight], -3.05)).toBe(3);
  expect(dialOvercooked(map[impact], 8.5)).toBe(8);
  // No negative overcook is recorded for the impact frame, none at all for ink wash and motion.
  expect(dialOvercooked(map[impact], -20)).toBeNull();
  expect(dialOvercooked(map[inkWash], 20)).toBeNull();
  expect(dialOvercooked(map[motionDial], 20)).toBeNull();
  expect(dialOvercooked(undefined, 20)).toBeNull();
});

test('a new row starts at the positive useful strength when the file records one, else at 1', () => {
  expect([dayNight, inkWash, impact, motionDial].map(d => dialStartStrength(map[d]))).toEqual([1.5, 2, 4.5, 1]);
  expect(dialStartStrength(undefined)).toBe(1);
  // The negative side's useful strength is not a starting point.
  expect(dialStartStrength(info({ neg: { useful: 2.5 } }))).toBe(1);
});

test('DEAS\'s H3 modes map to the pack\'s pipeline keys, and a new curve takes the file\'s blend steps for that pipeline, cut to the job', () => {
  expect(['T2VA', 'REF2VA', 'FL2VA', 'I2VA', 'L2VA'].map(dialPipelineOf)).toEqual(['t2v', 'ref2v', 'fl2v', 'fl2v', 'fl2v']);
  for (const other of ['', 't2v', 'Text to video', 'V2V']) expect(dialPipelineOf(other)).toBeUndefined();
  const measured = map[measuredDial];
  expect(dialInfoSteps(measured, 't2v', 6)).toBe(6);
  expect(dialInfoSteps(measured, 't2v', 25)).toBe(6);
  expect(dialInfoSteps(measured, 't2v', 4)).toBe(4);
  expect(dialInfoSteps(measured, 'ref2v', 25)).toBe(25);
  expect(dialInfoSteps(measured, 'ref2v', 200)).toBe(40);
  // No steps recorded for that pipeline, no pipeline in use, or no measurements at all: DEAS's default stays.
  expect(dialInfoSteps(measured, 'fl2v', 6)).toBeUndefined();
  expect(dialInfoSteps(measured, undefined, 6)).toBeUndefined();
  // "k = 6" in free text is not read: the real files record no per-pipeline steps.
  for (const dial of [inkWash, impact, dayNight, motionDial]) for (const key of ['t2v', 'ref2v', 'fl2v'] as const) expect(dialInfoSteps(map[dial], key, 6)).toBeUndefined();
  expect(dialInfoSteps(undefined, 't2v', 6)).toBeUndefined();
});

test('the native command is read once per call; a failure keeps its code, and a wrong shape or a browser without the app is unavailable', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(catalogFixture);
  expect(await readDialCatalog('http://127.0.0.1:8000/')).toEqual({ map, partial: false });
  // A catalog native cut or left entries out of says so.
  vi.mocked(invoke).mockResolvedValueOnce({ ...catalogFixture, truncated: true });
  expect((await readDialCatalog('x')).partial).toBe(true);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValueOnce(catalogFixture);
  await readDialCatalog('http://127.0.0.1:8000/');
  expect(vi.mocked(invoke).mock.calls).toEqual([['native_dial_catalog', { baseUrl: 'http://127.0.0.1:8000/' }]]);
  vi.mocked(invoke).mockRejectedValueOnce('DIAL_INFO_UNAVAILABLE: This backend has no dial catalog route.');
  expect(dialInfoError(await readDialCatalog('x').catch(e => e))).toBe('DIAL_INFO_UNAVAILABLE');
  vi.mocked(invoke).mockResolvedValueOnce({ path: '/x', entries: [] });
  expect(dialInfoError(await readDialCatalog('x').catch(e => e))).toBe('DIAL_INFO_MALFORMED');
  vi.mocked(isTauri).mockReturnValue(false);
  expect(dialInfoError(await readDialCatalog('x').catch(e => e))).toBe('DIAL_INFO_NATIVE');
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
  expect(dialInfoError(new Error('DIAL_INFO_TOO_LARGE: x'))).toBe('DIAL_INFO_TOO_LARGE');
  expect(dialInfoError({ message: 'DIAL_INFO_FAILED: The backend answered HTTP 500' })).toBe('DIAL_INFO_FAILED');
  expect(dialInfoError(new Error('DIAL_PRESETS_UNAVAILABLE: x'))).toBe('');
  expect(dialInfoError('boom')).toBe('');
});
