import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { bundledCatalog, I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { dialCurveConflictIds, isDialRows, type DialCurveConflict, type DialGate, type DialRow } from '../../lib/dials';
import { dialTimeline, type DialTimeline } from '../../lib/dialCurve';
import type { H3DialCurve } from '../../lib/videoIntent';
import { DialRackDialog } from './DialRackDialog';
import { DialStrip } from './DialStrip';
import { parseDialCatalog, type DialInfoMap, type DialPipeline } from '../../lib/dialInfo';
import { catalogFixture, impact, inkWash, measuredDial, motionDial } from '../../lib/dialInfo.fixture';

const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
const close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  vi.clearAllMocks();
  // jsdom has no native dialog lifecycle; preserve its open-state semantics here only.
  Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value: showModal }, close: { configurable: true, value: close } });
});
afterEach(() => {
  cleanup(); localStorage.clear();
  for (const method of ['showModal', 'close']) {
    if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard');
});

const motion = 'dials/h3_motion.safetensors', calm = 'dials/sub/h3_calm.safetensors';
const files = [motion, calm, 'dials/h3_day_night_hook.safetensors'];
const keys = (points: [number, number][], rest: Partial<H3DialCurve> = {}): H3DialCurve => ({ type: 'keys', points, unit: 'seconds', ...rest });
const rows = (): DialRow[] => [{ dial: motion, strength: 1.5, on: true }, { dial: calm, strength: 2, on: true, time: keys([[0, 0], [1.5, 1], [4, 0.5]]) }];
// A 5 s lane: 120 frames is not a real H3 clip length, but it makes one second 200 px of the mocked 1000 px plot.
const five: DialTimeline = { seconds: 5, frames: 120, edges: [], basis: 'clip' };
const text = (key: string, params: Record<string, string> = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), bundledCatalog.dictionaries.en[key]);
let last: DialRow[] = [];
const onClose = vi.fn();
function Host({ initial = rows(), gate = '', conflicts = [], timeline = five, steps = 25, info, pipeline }: { initial?: DialRow[]; gate?: DialGate; conflicts?: DialCurveConflict[]; timeline?: DialTimeline; steps?: number; info?: DialInfoMap; pipeline?: DialPipeline }) {
  const [value, setValue] = useState(initial);
  return <I18nProvider><DialRackDialog value={value} onChange={v => { last = v; setValue(v); }} files={files} listed={files} gate={gate} timeline={timeline} steps={steps} conflicts={conflicts} onClose={onClose} info={info} infoStatus={info ? 'ready' : undefined} pipeline={pipeline}/></I18nProvider>;
}
const dialog = () => screen.getByRole('dialog', { name: 'Dial rack (experimental)' }) as HTMLDialogElement;
const lane = (dial: string) => document.querySelector<HTMLElement>(`[data-dial-lane="${dial}"]`)!;
const tool = (name: string) => document.querySelector<HTMLButtonElement>(`[data-dial-tool="${name}"]`)!;
const points = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-dial-point]'));
const readout = () => document.querySelector('[data-dial-readout]')!.textContent;
const note = () => document.querySelector('[data-dial-rack-note]')!.textContent;
/** The selected lane's plot as a 1000 × 100 px box at the page origin: x = seconds × 200, y = (1 - level) × 100 for levels 0..1. */
function plot() {
  const el = lane(calm).querySelector<HTMLElement>('.dial-lane-plot')!;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0, toJSON() { return {}; } });
  return el;
}
const pointer = (el: Element, type: string, t: number, level: number, init: MouseEventInit = {}) => fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: t * 200, clientY: (1 - level) * 100, ...init }));
const select = (dial: string) => fireEvent.click(within(lane(dial)).getByRole('button', { pressed: false }));

test.each(['button', 'cancel'] as const)('opens as a modal, focuses Close, and closes natively before notifying the parent via %s', method => {
  const { unmount } = render(<StrictMode><Host/></StrictMode>);
  expect(showModal).toHaveBeenCalled();
  const opened = dialog();
  expect(opened.open).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  onClose.mockImplementation(() => { expect(opened.open).toBe(false); });
  if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  else {
    const cancel = new Event('cancel', { bubbles: false, cancelable: true });
    fireEvent(opened, cancel);
    expect(cancel.defaultPrevented).toBe(true);
  }
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();
  expect(onClose).toHaveBeenCalledTimes(1);
  onClose.mockReset();
});

test('the strip rows and one lane per row share the dialog; a constant row draws flat at level 1', () => {
  render(<Host/>);
  // The strip's own controls, not a copy: the same row markup and names.
  expect(within(dialog()).getByRole('group', { name: 'Dials (experimental)' })).toBeTruthy();
  expect(within(dialog()).getByRole('slider', { name: 'Strength of h3_motion' })).toHaveProperty('value', '1.5');
  expect(document.querySelector('[data-dial-rack-open]')).toBeNull();
  const lanes = within(screen.getByRole('list', { name: 'Lanes' })).getAllByRole('listitem');
  expect(lanes.map(l => [l.dataset.dialLane, l.dataset.selected, l.dataset.dialCurved])).toEqual([[motion, 'true', 'false'], [calm, 'false', 'true']]);
  expect(document.querySelector('[data-dial-timeline]')!.querySelector('h3')!.textContent).toBe('Timeline · 5 s');
  // Level 1 is the top of the 0..1 lane, across the whole width.
  expect(lane(motion).querySelector('[data-dial-lane-curve]')!.getAttribute('d')).toMatch(/^M0\.00 0\.00L5\.00 0\.00.*L1000\.00 0\.00$/);
  expect(readout()).toBe('Constant row: level 1 · strength 1.5');
  expect(points()).toHaveLength(0);
  expect(tool('addCurve').disabled).toBe(false);
  expect(tool('removeCurve')).toBeNull();
  // The dimmed lane shows its curve; selecting it shows its points and the per-latent-frame line.
  expect(lane(calm).querySelector('[data-dial-track]')!.getAttribute('data-dial-track')).toBe('dimmed');
  expect(lane(calm).querySelector('[data-dial-lane-curve]')!.getAttribute('d')).toContain('L300.00 0.00');
  expect(lane(calm).querySelector('[data-dial-frames]')).toBeNull();
  select(calm);
  expect(lane(calm).dataset.selected).toBe('true');
  expect(points().map(p => p.getAttribute('aria-label'))).toEqual(['Point 1 of 3: 0 s, level 0', 'Point 2 of 3: 1.5 s, level 1', 'Point 3 of 3: 4 s, level 0.5']);
  expect(points().map(p => [p.style.left, p.style.top])).toEqual([['0%', '100%'], ['30%', '0%'], ['80%', '50%']]);
  expect(lane(calm).querySelector('[data-dial-frames]')!.getAttribute('d')!.match(/M|L/g)).toHaveLength(36);
  // Latent-frame ticks (1, 4, 4, 4, 4 pixel frames) and whole seconds under the lanes.
  expect(document.querySelectorAll('[data-dial-tick]')).toHaveLength(37);
  expect(Array.from(document.querySelectorAll('[data-dial-second]')).map(b => b.textContent)).toEqual(['0', '1', '2', '3', '4', '5']);
  // Honest help: resolution, the scene-change warning and the designed range are always shown.
  expect(document.querySelector('[data-dial-help="resolution"]')!.textContent).toContain('one value per latent frame');
  expect(document.querySelector('[data-dial-help="resolution"]')!.textContent).toContain('1.5 s');
  expect(document.querySelector('[data-dial-help="scene"]')!.textContent).toContain('can change the whole scene');
  expect(document.querySelector('[data-dial-help="range"]')!.textContent).toContain('level × row strength');
});

test('add curve, presets and remove curve turn a constant row into a curve and back', () => {
  render(<Host/>);
  fireEvent.click(tool('addCurve'));
  expect(last[0]).toEqual({ dial: motion, strength: 1.5, on: true, time: keys([[0, 1], [5, 1]]) });
  expect(points()).toHaveLength(2);
  for (const [name, expected] of [['rampIn', [[0, 0], [1.5, 1]]], ['rampOut', [[3.5, 1], [5, 0]]], ['pulse', [[0, 0], [1.5, 1], [3.5, 1], [5, 0]]], ['dip', [[0, 1], [1.5, 0], [3.5, 0], [5, 1]]]] as const) {
    fireEvent.click(tool(`preset.${name}`));
    expect(last[0].time, name).toEqual(keys(expected as unknown as [number, number][], { interp: 'linear' }));
    expect(last[0].time!.points.every(q => q[1] >= 0 && q[1] <= 1)).toBe(true);
  }
  expect(isDialRows(last)).toBe(true);
  fireEvent.click(tool('removeCurve'));
  expect(last[0]).toEqual({ dial: motion, strength: 1.5, on: true });
  // A preset also starts a curve on a constant row.
  fireEvent.click(tool('preset.rampIn'));
  expect(last[0].time).toEqual(keys([[0, 0], [1.5, 1]], { interp: 'linear' }));
  expect(last[1]).toEqual(rows()[1]);
});

test('mouse editing on the selected lane: click adds, drag moves with snapping, a click on a point only selects, double-click deletes', () => {
  render(<Host/>);
  select(calm);
  const track = lane(calm).querySelector<HTMLElement>('[data-dial-track]')!;
  plot();
  // Click empty lane at 2.52 s, level 0.33: a point snapped to 0.1 s and 0.05, selected and focused.
  pointer(track, 'pointerdown', 2.52, 0.33);
  expect(last[1].time!.points).toEqual([[0, 0], [1.5, 1], [2.5, 0.35], [4, 0.5]]);
  expect(points()[2].getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(points()[2]);
  // Still held: dragging moves the new point, stopping one latent frame before its neighbour.
  pointer(track, 'pointermove', 3.04, 0.81);
  expect(last[1].time!.points[2]).toEqual([3, 0.8]);
  expect(readout()).toBe('3 s · level 0.8 · strength 1.6');
  pointer(track, 'pointermove', 4.4, 0.6);
  expect(last[1].time!.points[2]).toEqual([3.8333, 0.6]);
  pointer(track, 'pointermove', 3.26, 0.6, { altKey: true });
  expect(last[1].time!.points[2]).toEqual([3.26, 0.6]);
  pointer(track, 'pointerup', 3.26, 0.6);
  // Released: moving the mouse no longer drags.
  pointer(track, 'pointermove', 1, 0.2);
  expect(last[1].time!.points[2]).toEqual([3.26, 0.6]);
  expect(readout()).toBe('1 s · level 0.2 · strength 0.4');
  // A plain click on a point selects it without snapping it onto the grid; within one latent frame of a point no second point is added.
  pointer(points()[2], 'pointerdown', 3.26, 0.6); pointer(track, 'pointermove', 3.265, 0.6); pointer(track, 'pointerup', 3.265, 0.6);
  expect(last[1].time!.points[2]).toEqual([3.26, 0.6]);
  pointer(track, 'pointerdown', 1.6, 0.4); pointer(track, 'pointerup', 1.6, 0.4);
  expect(last[1].time!.points).toHaveLength(4);
  expect(points()[1].getAttribute('aria-pressed')).toBe('true');
  // The whole drag was one undo step, the add another.
  fireEvent.click(tool('undo'));
  expect(last[1].time!.points[2]).toEqual([2.5, 0.35]);
  fireEvent.click(tool('undo'));
  expect(last[1].time!.points).toEqual(rows()[1].time!.points);
  expect(tool('undo').disabled).toBe(true);
  fireEvent.click(tool('redo')); fireEvent.click(tool('redo'));
  expect(last[1].time!.points[2]).toEqual([3.26, 0.6]);
  expect(tool('redo').disabled).toBe(true);
  fireEvent.doubleClick(points()[2]);
  expect(last[1].time!.points).toEqual(rows()[1].time!.points);
  fireEvent.doubleClick(points()[1]);
  fireEvent.doubleClick(points()[0]);
  expect(last[1].time!.points).toEqual([[0, 0], [4, 0.5]]);
  expect(note()).toBe('A curve keeps at least two points.');
  // The other lane's track selects that lane instead of editing it.
  fireEvent.pointerDown(lane(motion).querySelector('[data-dial-track]')!);
  expect(lane(motion).dataset.selected).toBe('true');
  expect(last[0]).toEqual(rows()[0]);
});

test('keyboard and number fields: arrows nudge, Delete removes, Add point fills the widest gap, Ctrl+Z undoes', () => {
  render(<Host/>);
  select(calm);
  act(() => points()[1].focus());
  expect(points()[1].getAttribute('aria-pressed')).toBe('true');
  expect(readout()).toBe('1.5 s · level 1 · strength 2');
  fireEvent.keyDown(points()[1], { key: 'ArrowRight' });
  fireEvent.keyDown(points()[1], { key: 'ArrowDown' });
  expect(last[1].time!.points[1]).toEqual([1.6, 0.95]);
  fireEvent.keyDown(points()[1], { key: 'ArrowLeft', shiftKey: true });
  fireEvent.keyDown(points()[1], { key: 'ArrowDown', shiftKey: true });
  expect(last[1].time!.points[1]).toEqual([0.6, 0.45]);
  // Stops at the gap and at the level range.
  fireEvent.keyDown(points()[1], { key: 'ArrowLeft', shiftKey: true });
  fireEvent.keyDown(points()[1], { key: 'ArrowUp', shiftKey: true }); fireEvent.keyDown(points()[1], { key: 'ArrowUp', shiftKey: true });
  expect(last[1].time!.points[1]).toEqual([0.1667, 1]);
  const time = document.querySelector<HTMLInputElement>('[data-dial-point-time]')!, level = document.querySelector<HTMLInputElement>('[data-dial-point-level]')!;
  expect([time.value, level.value]).toEqual(['0.1667', '1']);
  fireEvent.change(time, { target: { value: '2.25' } });
  fireEvent.change(level, { target: { value: '0.' } });
  expect(last[1].time!.points[1]).toEqual([2.25, 1]);
  fireEvent.change(level, { target: { value: '0.42' } });
  expect(last[1].time!.points[1]).toEqual([2.25, 0.42]);
  // Typed values stay inside the lane and the level range.
  fireEvent.change(level, { target: { value: '7' } });
  fireEvent.change(time, { target: { value: '99' } });
  expect(last[1].time!.points[1]).toEqual([3.8333, 1]);
  fireEvent.blur(time);
  expect(time.value).toBe('3.8333');
  // The level range widens on purpose only; the compiler's ±20 is the hard limit.
  const hi = document.querySelector<HTMLInputElement>('[data-dial-range="hi"]')!, lo = document.querySelector<HTMLInputElement>('[data-dial-range="lo"]')!;
  expect([lo.value, hi.value, lo.min, hi.max]).toEqual(['0', '1', '-20', '20']);
  fireEvent.change(hi, { target: { value: '99' } }); fireEvent.blur(hi);
  expect(hi.value).toBe('20');
  fireEvent.change(hi, { target: { value: '2' } }); fireEvent.change(lo, { target: { value: '-1' } });
  fireEvent.change(level, { target: { value: '1.5' } });
  expect(last[1].time!.points[1]).toEqual([3.8333, 1.5]);
  expect(readout()).toBe('3.83 s · level 1.5 · outside 0 to 1: extrapolated (level × strength = 3)');
  // Delete moves the selection to the neighbour and keeps focus on a point.
  act(() => points()[1].focus());
  fireEvent.keyDown(points()[1], { key: 'Delete' });
  expect(last[1].time!.points).toEqual([[0, 0], [4, 0.5]]);
  expect(document.activeElement).toBe(points()[1]);
  fireEvent.keyDown(points()[1], { key: 'Delete' });
  expect(last[1].time!.points).toHaveLength(2);
  expect(note()).toBe('A curve keeps at least two points.');
  // Add point for keyboard users: the middle of the widest gap, on the curve.
  fireEvent.click(tool('addPoint'));
  expect(last[1].time!.points).toEqual([[0, 0], [2, 0.25], [4, 0.5]]);
  expect(document.activeElement).toBe(points()[1]);
  fireEvent.keyDown(points()[1], { key: 'z', ctrlKey: true });
  expect(last[1].time!.points).toEqual([[0, 0], [4, 0.5]]);
  fireEvent.keyDown(dialog(), { key: 'z', ctrlKey: true, shiftKey: true });
  expect(last[1].time!.points).toHaveLength(3);
  fireEvent.keyDown(dialog(), { key: 'z', ctrlKey: true }); fireEvent.keyDown(dialog(), { key: 'y', ctrlKey: true });
  expect(last[1].time!.points).toHaveLength(3);
  // In a number field Ctrl+Z belongs to the field.
  fireEvent.keyDown(time, { key: 'z', ctrlKey: true });
  expect(last[1].time!.points).toHaveLength(3);
  expect(isDialRows(last)).toBe(true);
});

test('interp, smoothing and blend steps edit the curve; the default blend steps are shown', () => {
  render(<Host steps={25}/>);
  select(calm);
  const steps = document.querySelector<HTMLInputElement>('[data-dial-steps]')!, hint = () => document.querySelector('[data-dial-steps-default]')!.textContent;
  expect([steps.value, steps.placeholder, steps.max]).toEqual(['', '8', '25']);
  expect(hint()).toBe('default: 8 of 25 steps (provisional)');
  expect(steps.closest('label')!.title).toContain('one extra model call');
  fireEvent.change(steps, { target: { value: '12' } });
  expect(last[1].time!.steps).toBe(12);
  expect(hint()).toBe('12 of 25 steps (default 8)');
  for (const bad of ['0', '2.5', '151']) { fireEvent.change(steps, { target: { value: bad } }); expect(last[1].time!.steps, bad).toBe(12); }
  fireEvent.change(steps, { target: { value: '' } });
  expect(last[1].time).toEqual(rows()[1].time);
  const smooth = document.querySelector<HTMLInputElement>('[data-dial-smooth]')!, interp = document.querySelector<HTMLSelectElement>('[data-dial-interp]')!;
  const before = lane(calm).querySelector('[data-dial-lane-curve]')!.getAttribute('d');
  fireEvent.change(smooth, { target: { value: '0.5' } });
  expect(last[1].time!.smooth).toBe(0.5);
  expect(lane(calm).querySelector('[data-dial-lane-curve]')!.getAttribute('d')).not.toBe(before);
  fireEvent.change(smooth, { target: { value: '0' } });
  expect(last[1].time).toEqual(rows()[1].time);
  expect(lane(calm).querySelector('[data-dial-lane-curve]')!.getAttribute('d')).toBe(before);
  fireEvent.change(interp, { target: { value: 'step' } });
  expect(last[1].time!.interp).toBe('step');
  expect(smooth.disabled).toBe(true);
  // A step curve holds each level until the next point: a vertical jump at 1.5 s.
  expect(lane(calm).querySelector('[data-dial-lane-curve]')!.getAttribute('d')).toContain('L300.00 100.00L300.00 0.00');
});

test('a curve copies and pastes between lanes through the clipboard, with an in-page copy when the clipboard is blocked', async () => {
  let held = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (v: string) => { held = v; }), readText: vi.fn(async () => held) } });
  render(<Host/>);
  select(calm);
  fireEvent.click(tool('copy'));
  await waitFor(() => expect(note()).toBe('Curve copied.'));
  expect(held).toBe('{"type":"keys","points":[[0,0],[1.5,1],[4,0.5]],"unit":"seconds"}');
  select(motion);
  expect(tool('copy').disabled).toBe(true);
  fireEvent.click(tool('paste'));
  await waitFor(() => expect(note()).toBe('Curve pasted.'));
  expect(last[0]).toEqual({ dial: motion, strength: 1.5, on: true, time: rows()[1].time });
  // The pack's editor copies clip fractions by default: converted with the lane length.
  held = '{"type":"keys","points":[[0,0],[0.5,1]],"interp":"linear","steps":2,"audio":"follow"}';
  fireEvent.click(tool('paste'));
  await waitFor(() => expect(last[0].time).toEqual(keys([[0, 0], [2.5, 1]], { interp: 'linear', steps: 2 })));
  held = 'not a curve';
  fireEvent.click(tool('paste'));
  await waitFor(() => expect(note()).toBe('Nothing to paste: the clipboard holds no time curve this version can send.'));
  expect(last[0].time!.points).toEqual([[0, 0], [2.5, 1]]);
  // Clipboard blocked: the in-page copy carries the curve to the other lane.
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('blocked'); }), readText: vi.fn(async () => { throw new Error('blocked'); }) } });
  fireEvent.click(tool('copy'));
  await waitFor(() => expect(note()).toContain('clipboard is blocked'));
  select(calm);
  fireEvent.click(tool('paste'));
  await waitFor(() => expect(last[1].time).toEqual(keys([[0, 0], [2.5, 1]], { interp: 'linear', steps: 2 })));
});

test('strip edits inside the dialog reach the rows and share the undo history', () => {
  render(<Host/>);
  const strip = within(dialog());
  // One drag: the slider reports values while it moves (input) and commits once at release (change).
  fireEvent.input(strip.getByRole('slider', { name: 'Strength of h3_motion' }), { target: { value: '2' } });
  fireEvent.input(strip.getByRole('slider', { name: 'Strength of h3_motion' }), { target: { value: '2.5' } });
  fireEvent.change(strip.getByRole('slider', { name: 'Strength of h3_motion' }), { target: { value: '2.5' } });
  expect(last[0].strength).toBe(2.5);
  expect(lane(motion).textContent).toContain('constant · strength 2.5');
  fireEvent.click(strip.getByRole('button', { name: 'Remove h3_motion' }));
  expect(last).toEqual([rows()[1]]);
  expect(document.querySelectorAll('[data-dial-lane]')).toHaveLength(1);
  expect(lane(calm).dataset.selected).toBe('true');
  fireEvent.click(tool('undo'));
  expect(last[0].strength).toBe(2.5);
  // The slider drag was one step.
  fireEvent.click(tool('undo'));
  expect(last).toEqual(rows());
  fireEvent.change(document.querySelector('[data-dial-add]')!, { target: { value: files[2] } });
  expect(last).toHaveLength(3);
  expect(document.querySelectorAll('[data-dial-lane]')).toHaveLength(3);
});

test('two separate strip edits of one row are two undo steps; a slider drag is one; a switch toggled back leaves no empty undo', () => {
  render(<Host/>);
  const strip = within(dialog());
  const slider = () => strip.getByRole('slider', { name: 'Strength of h3_motion' });
  const field = () => strip.getByRole('spinbutton', { name: 'Exact strength of h3_motion' });
  // A drag: the value changes several times, then the slider commits (the browser's change event at release).
  for (const value of ['1.8', '2.2', '2']) fireEvent.input(slider(), { target: { value } });
  fireEvent.change(slider(), { target: { value: '2' } });
  expect(last[0].strength).toBe(2);
  // Later, the number field of the same row: typed, then left.
  fireEvent.input(field(), { target: { value: '3' } });
  fireEvent.blur(field());
  expect(last[0].strength).toBe(3);
  fireEvent.click(tool('undo'));
  expect(last[0].strength).toBe(2);
  fireEvent.click(tool('undo'));
  expect(last[0].strength).toBe(1.5);
  expect(tool('undo').disabled).toBe(true);
  // A held arrow key repeats (each repeat commits in the browser): one step until the key is released; the next press is another.
  fireEvent.keyDown(slider(), { key: 'ArrowRight' });
  for (const value of ['1.55', '1.6', '1.65']) { fireEvent.input(slider(), { target: { value } }); fireEvent.change(slider(), { target: { value } }); }
  fireEvent.keyUp(slider(), { key: 'ArrowRight' });
  fireEvent.keyDown(slider(), { key: 'ArrowRight' });
  fireEvent.input(slider(), { target: { value: '1.7' } });
  fireEvent.keyUp(slider(), { key: 'ArrowRight' });
  fireEvent.click(tool('undo'));
  expect(last[0].strength).toBe(1.65);
  fireEvent.click(tool('undo'));
  expect(last[0].strength).toBe(1.5);
  expect(tool('undo').disabled).toBe(true);
  // Off, on, off: three steps, each of which changes the row.
  const box = () => strip.getByRole('checkbox', { name: 'Use h3_motion' });
  fireEvent.click(box()); fireEvent.click(box()); fireEvent.click(box());
  const seen: (boolean | undefined)[] = [last[0].on];
  while (!tool('undo').disabled) { fireEvent.click(tool('undo')); seen.push(last[0].on); }
  expect(seen).toEqual([false, true, false, true]);
});

test('without rows the timeline asks for a dial', () => {
  render(<Host initial={[]}/>);
  expect(document.querySelector('[data-dial-rack-empty]')!.textContent).toBe('Add a dial above to get a lane.');
  expect(document.querySelector('[data-dial-lane]')).toBeNull();
  fireEvent.change(document.querySelector('[data-dial-add]')!, { target: { value: motion } });
  expect(lane(motion).dataset.selected).toBe('true');
});

test.each(dialCurveConflictIds)('refusal %s shows its reason in the dialog and in the strip, and disables what cannot help', id => {
  const reason = text(`studio.dials.conflict.${id}`);
  expect(reason.length).toBeGreaterThan(20);
  const view = render(<Host conflicts={[id]}/>);
  const shown = document.querySelector(`[data-dial-rack] [data-dial-conflict="${id}"]`)!;
  expect(shown.textContent).toBe(reason);
  expect(within(dialog()).getByRole('list', { name: 'Why the time curves cannot run' })).toBeTruthy();
  select(calm);
  // Editing cannot resolve a refusal that depends on the job; changing the curve can resolve its own limits.
  const locked = id !== 'blendSteps' && id !== 'curveLimits';
  expect(!!document.querySelector('[data-dial-rack-locked]')).toBe(locked);
  if (locked) expect(document.querySelector('[data-dial-rack-locked]')!.textContent).toBe(`Curve editing is off here. ${reason}`);
  for (const name of ['preset.rampIn', 'preset.rampOut', 'preset.pulse', 'preset.dip', 'addPoint', 'paste']) {
    expect(tool(name).disabled, name).toBe(locked);
    expect(tool(name).title, name).toBe(locked ? reason : '');
  }
  expect(points().every(p => p.disabled === locked)).toBe(true);
  for (const field of ['[data-dial-interp]', '[data-dial-smooth]', '[data-dial-point-time]']) expect(document.querySelector<HTMLInputElement>(field)!.disabled || field === '[data-dial-point-time]', field).toBe(locked || field === '[data-dial-point-time]');
  // The lane does not take clicks while locked.
  plot();
  pointer(lane(calm).querySelector('[data-dial-track]')!, 'pointerdown', 2.5, 0.5);
  expect(document.querySelectorAll('[data-dial-point]')).toHaveLength(locked ? 3 : 4);
  // What resolves it stays usable: blend steps, the switch, and removing the curve.
  expect(document.querySelector<HTMLInputElement>('[data-dial-steps]')!.disabled).toBe(false);
  expect(within(dialog()).getByRole('checkbox', { name: 'Use h3_calm' })).toHaveProperty('disabled', false);
  expect(tool('removeCurve').disabled).toBe(false);
  fireEvent.click(tool('removeCurve'));
  expect(last[1]).toEqual({ dial: calm, strength: 2, on: true });
  expect(tool('addCurve').disabled).toBe(locked);
  view.unmount();
  // The dock strip shows the same reason from the same list.
  render(<I18nProvider><DialStrip value={rows()} onChange={() => {}} files={files} listed={files} gate="" seconds={5} conflicts={[id]}/></I18nProvider>);
  expect(document.querySelector(`[data-dials] [data-dial-conflict="${id}"]`)!.textContent).toBe(reason);
});

test('a closed gate locks the curve tools with the gate\'s reason', () => {
  render(<Host gate="nodeMissing"/>);
  select(calm);
  expect(document.querySelector('[data-dial-rack-locked]')!.textContent).toContain('Dial Rack nodes');
  expect(tool('preset.pulse').disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('[data-dial-steps]')!.disabled).toBe(true);
  expect(tool('removeCurve').disabled).toBe(false);
});

test('a Continuity piece is laid out with its segment ends, which points snap to; a plan on an existing clip says why it shows the clip', () => {
  const plan = dialTimeline(107, { steps: [{ seconds: 5 }, { seconds: 3 }] }, false);
  const view = render(<Host timeline={plan}/>);
  expect(document.querySelector('[data-dial-timeline]')!.getAttribute('data-dial-timeline')).toBe('plan');
  expect(document.querySelector('[data-dial-basis="plan"]')!.textContent).toContain('whole Continuity piece (8 s)');
  expect(document.querySelectorAll(`[data-dial-lane="${calm}"] [data-dial-edge]`)).toHaveLength(1);
  select(calm);
  // 124 frames = 5.1667 s is the first segment's end; frame ticks cover that segment, and no per-frame line is drawn for the piece.
  expect(document.querySelectorAll('[data-dial-tick]')).toHaveLength(38);
  expect(lane(calm).querySelector('[data-dial-frames]')).toBeNull();
  const el = lane(calm).querySelector<HTMLElement>('.dial-lane-plot')!;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON() { return {}; } });
  const track = lane(calm).querySelector('[data-dial-track]')!;
  fireEvent(track, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 518, clientY: 50 }));
  expect(last[1].time!.points[3]).toEqual([5.1667, 0.5]);
  view.unmount();
  render(<Host timeline={dialTimeline(107, { steps: [{ seconds: 5 }], source: { clipId: 'x' } }, false)}/>);
  expect(document.querySelector('[data-dial-basis="planSource"]')!.textContent).toContain('continues an existing clip');
  expect(document.querySelector('[data-dial-timeline]')!.querySelector('h3')!.textContent).toBe('Timeline · 4.458 s');
});

test('points authored for a longer piece stay visible past the lane\'s end', () => {
  render(<Host initial={[{ dial: calm, strength: 1, on: true, time: keys([[-1, 0], [10, 1]]) }]}/>);
  expect(lane(calm).querySelector('.dial-lane-beyond')).not.toBeNull();
  expect(points().map(p => p.style.left)).toEqual(['0%', '100%']);
  expect(Array.from(document.querySelectorAll('[data-dial-second]')).map(b => b.textContent)).toEqual(['-1', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  // Changing only the level leaves such a point where it was authored: the Level field and the up and down keys.
  fireEvent.focus(points()[1]);
  fireEvent.change(document.querySelector('[data-dial-point-level]')!, { target: { value: '0.4' } });
  expect(last[0].time!.points).toEqual([[-1, 0], [10, 0.4]]);
  fireEvent.keyDown(points()[1], { key: 'ArrowUp' });
  expect(last[0].time!.points).toEqual([[-1, 0], [10, 0.45]]);
  fireEvent.focus(points()[0]);
  fireEvent.keyDown(points()[0], { key: 'ArrowUp' });
  expect(last[0].time!.points).toEqual([[-1, 0.05], [10, 0.45]]);
  // A time change still brings it into the lane.
  fireEvent.keyDown(points()[1], { key: 'ArrowLeft' });
  expect(last[0].time!.points[1]).toEqual([5, 0.45]);
});

const infoMap = parseDialCatalog(catalogFixture)!;
const stepsField = () => document.querySelector<HTMLInputElement>('[data-dial-steps]')!;
const fileSteps = () => document.querySelector<HTMLElement>('[data-dial-steps-file]');
const useFile = () => document.querySelector<HTMLButtonElement>('[data-dial-steps-use]');

test('a new curve is authored with the blend steps the dial file records for the pipeline in use, never more than the job has', () => {
  // Text to video, 20 sampler steps: the file says 6 where DEAS's own default would be 7.
  const view = render(<Host info={infoMap} pipeline="t2v" steps={20} initial={[{ dial: measuredDial, strength: 2, on: true }, { dial: motion, strength: 1.5, on: true }]}/>);
  fireEvent.click(tool('addCurve'));
  expect(last[0].time).toEqual(keys([[0, 1], [5, 1]], { steps: 6 }));
  expect(stepsField().value).toBe('6');
  expect(document.querySelector('[data-dial-steps-default]')!.textContent).toBe('6 of 20 steps (default 7)');
  expect(fileSteps()!.textContent).toBe('The dial file records 6 blend steps for text to video.');
  expect(useFile()).toBeNull();
  // Clearing the field goes back to DEAS's default; the file's value stays visible and one click away.
  fireEvent.change(stepsField(), { target: { value: '' } });
  expect(last[0].time!.steps).toBeUndefined();
  expect(document.querySelector('[data-dial-steps-default]')!.textContent).toBe('default: 7 of 20 steps (provisional)');
  expect(useFile()!.textContent).toBe('Use 6');
  fireEvent.click(useFile()!);
  expect(last[0].time!.steps).toBe(6);
  // A preset on a constant row starts its curve the same way.
  fireEvent.click(tool('removeCurve'));
  fireEvent.click(tool('preset.pulse'));
  expect(last[0].time!.steps).toBe(6);
  expect(isDialRows(last)).toBe(true);
  // A dial the file says nothing about for curves keeps DEAS's default: no steps are authored.
  select(motion);
  fireEvent.click(tool('addCurve'));
  expect(last[1].time).toEqual(keys([[0, 1], [5, 1]]));
  expect(fileSteps()).toBeNull();
  view.unmount();

  // Reference pictures: the file says 40, this job has 20 steps, so 20 is authored and the field says why.
  render(<Host info={infoMap} pipeline="ref2v" steps={20} initial={[{ dial: measuredDial, strength: 2, on: true }]}/>);
  fireEvent.click(tool('addCurve'));
  expect(last[0].time!.steps).toBe(20);
  expect(fileSteps()!.textContent).toBe('The dial file records 40 blend steps for reference pictures; this job has 20 sampler steps, so 20 is the most.');
  expect(fileSteps()!.dataset.dialStepsFile).toBe('20');
});

test('without recorded blend steps DEAS keeps its default and shows the dial\'s own pipeline text and notes beside the field', () => {
  // First/last frame: the measurement has strengths and a note but no steps.
  const view = render(<Host info={infoMap} pipeline="fl2v" steps={6} initial={[{ dial: measuredDial, strength: 2, on: true }, { dial: inkWash, strength: 2, on: true }, { dial: motionDial, strength: 1, on: true }, { dial: calm, strength: 1, on: true }]}/>);
  fireEvent.click(tool('addCurve'));
  expect(last[0].time).toEqual(keys([[0, 1], [5, 1]]));
  expect(fileSteps()).toBeNull();
  const part = (name: string) => document.querySelector<HTMLElement>(`[data-dial-rack-info] [data-dial-rack-info-part="${name}"]`);
  expect(document.querySelector<HTMLElement>('[data-dial-rack-info]')!.dataset.dialRackInfo).toBe(measuredDial);
  expect(part('measured')!.textContent).toBe('For first/last frame: useful 3 · one seed · no curve measured');
  // The real ink wash file: "k = 6" is in its texts, which are shown as they are; nothing is read out of them.
  select(inkWash);
  expect(screen.getByRole('region', { name: 'From the dial file: h3_ink_wash' })).toBeTruthy();
  expect(part('pipeline')!.textContent).toBe('Measured with: Pika H3 Flex 6-step, time rows k = 6, audio: protect');
  expect(part('notes')!.textContent).toContain('On a seep in/out curve, 2 at k = 6 follows but re-composes the landscape (k = 2 smears the look over the clip).');
  expect(part('description')!.textContent).toContain('Ink wash: the scene becomes');
  expect(part('measured')).toBeNull();
  fireEvent.click(tool('addCurve'));
  expect(last[1].time).toEqual(keys([[0, 1], [5, 1]]));
  // A 6-step job blends on every step by default, which is what this file's notes ask for.
  expect(stepsField().placeholder).toBe('6');
  expect(document.querySelector('[data-dial-steps-default]')!.textContent).toBe('default: 6 of 6 steps (provisional)');
  expect(fileSteps()).toBeNull();
  // A file that says nothing says so; a dial the catalog does not know has no block.
  select(motionDial);
  expect(part('none')!.textContent).toBe('This dial file records no notes.');
  select(calm);
  expect(document.querySelector('[data-dial-rack-info]')).toBeNull();
  // The strip inside the dialog has the same labels and marks.
  expect(dialog().querySelector(`[data-dial-row="${inkWash}"] [data-dial-side="pos"]`)!.textContent).toBe('ink wash');
  expect(dialog().querySelector('[data-dial-help="findings"]')!.textContent).toContain('A dial\'s own notes are the best guide');
  view.unmount();
  // Without info the dialog is what it was.
  render(<Host/>);
  expect(document.querySelector('[data-dial-rack-info], [data-dial-steps-file], [data-dial-steps-use]')).toBeNull();
});

test('the audio mode of a curve is follow unless protect is chosen, and undo takes it back', () => {
  render(<Host info={infoMap} pipeline="t2v" steps={6} initial={[{ dial: impact, strength: 4.5, on: true, time: keys([[0, 0], [2, 0], [2.5, 1], [3, 0]], { interp: 'step' }) }, { dial: motion, strength: 1.5, on: true }]}/>);
  const audio = () => document.querySelector<HTMLSelectElement>('[data-dial-audio]')!;
  expect(audio().value).toBe('follow');
  expect(Array.from(audio().options).map(o => [o.value, o.textContent])).toEqual([['follow', 'Follows the curve'], ['protect', 'Protected']]);
  expect(audio().closest('label')!.title).toContain('this row leaves the soundtrack undialled');
  fireEvent.change(audio(), { target: { value: 'protect' } });
  expect(last[0].time).toEqual(keys([[0, 0], [2, 0], [2.5, 1], [3, 0]], { interp: 'step', audio: 'protect' }));
  expect(isDialRows(last)).toBe(true);
  expect(audio().value).toBe('protect');
  // Follow is the node's default: the key is removed, not written.
  fireEvent.change(audio(), { target: { value: 'follow' } });
  expect(last[0].time).toEqual(keys([[0, 0], [2, 0], [2.5, 1], [3, 0]], { interp: 'step' }));
  fireEvent.click(tool('undo'));
  expect(last[0].time!.audio).toBe('protect');
  // A constant row has no curve, so no audio mode.
  select(motion);
  expect(document.querySelector('[data-dial-audio]')).toBeNull();
});

test('a refusal that locks the curve tools locks the audio mode too; the blend steps and the file\'s value stay usable', () => {
  render(<Host info={infoMap} pipeline="t2v" steps={6} conflicts={['faceRefine']} initial={[{ dial: measuredDial, strength: 2, on: true, time: keys([[0, 0], [2, 1]]) }]}/>);
  expect(document.querySelector<HTMLSelectElement>('[data-dial-audio]')!.disabled).toBe(true);
  expect(stepsField().disabled).toBe(false);
  expect(useFile()!.disabled).toBe(false);
  fireEvent.click(useFile()!);
  expect(last[0].time!.steps).toBe(6);
});
