import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bundledCatalog, I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { matchEntries, searchIndex } from '../../lib/search';
import { isDialRows, type DialGate, type DialRow } from '../../lib/dials';
import { DialStrip } from './DialStrip';
import { parseDialCatalog, type DialInfoMap, type DialInfoState } from '../../lib/dialInfo';
import { catalogFixture, dayNight, familyFixture, impact, inkWash, kreaDial, mossDial, motionDial, preDial, unlabelled } from '../../lib/dialInfo.fixture';

beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); });
afterEach(() => { cleanup(); localStorage.clear(); });
const files = ['dials/h3_day_night_hook.safetensors', 'dials/h3_motion.safetensors', 'dials/sub/h3_calm.safetensors'];
const text = (key: string) => bundledCatalog.dictionaries.en[key];
let last: DialRow[] = [];
function Host({ rows = [], gate = '', listed = files, offered = files, rack, info, infoStatus, refresh }: { rows?: DialRow[]; gate?: DialGate; listed?: string[] | null; offered?: string[]; rack?: () => void; info?: DialInfoMap; infoStatus?: DialInfoState['status']; refresh?: () => void }) {
  const [value, setValue] = useState(rows);
  return <I18nProvider><DialStrip value={value} onChange={v => { last = v; setValue(v); }} files={offered} listed={listed ?? undefined} gate={gate} seconds={4} onOpenRack={rack} info={info} infoStatus={infoStatus} onRefreshInfo={refresh}/></I18nProvider>;
}
const row = (dial: string) => document.querySelector<HTMLElement>(`[data-dial-row="${dial}"]`)!;
const add = () => document.querySelector<HTMLSelectElement>('[data-dial-add]')!;

test('adding from the list makes an on row at strength 1 and stops offering that dial', () => {
  render(<Host/>);
  expect(document.querySelector('[data-dials]')?.getAttribute('data-dials')).toBe('ready');
  expect(screen.getByRole('group', { name: 'Dials (experimental)' })).toBeTruthy();
  expect(Array.from(add().options).map(o => o.textContent)).toEqual(['Add a dial…', 'h3_day_night_hook', 'h3_motion', 'h3_calm']);
  expect(document.querySelector('.wb-dial-rows')).toBeNull();
  fireEvent.change(add(), { target: { value: 'dials/h3_motion.safetensors' } });
  expect(last).toEqual([{ dial: 'dials/h3_motion.safetensors', strength: 1, on: true }]);
  expect(isDialRows(last)).toBe(true);
  expect(add().value).toBe('');
  expect(Array.from(add().options).map(o => o.value)).toEqual(['', 'dials/h3_day_night_hook.safetensors', 'dials/sub/h3_calm.safetensors']);
  const line = within(row('dials/h3_motion.safetensors'));
  expect(line.getByRole('checkbox', { name: 'Use h3_motion' })).toHaveProperty('checked', true);
  expect(line.getByRole('slider', { name: 'Strength of h3_motion' })).toHaveProperty('value', '1');
  expect(line.getByRole('spinbutton', { name: 'Exact strength of h3_motion' })).toHaveProperty('value', '1');
  expect(line.getByRole('button', { name: 'Remove h3_motion' })).toBeTruthy();
  // Rows are plain list items; every control carries the dial's name itself.
  expect(within(screen.getByRole('list', { name: 'Dial rows' })).getAllByRole('listitem')).toHaveLength(1);
});

test('switch, slider, number field and remove edit one row and keep the others', () => {
  render(<Host rows={[{ dial: files[1], strength: 1, on: true }, { dial: files[2], strength: -0.5, on: true }]}/>);
  const motion = () => within(row(files[1]));
  fireEvent.click(motion().getByRole('checkbox'));
  expect(last).toEqual([{ dial: files[1], strength: 1, on: false }, { dial: files[2], strength: -0.5, on: true }]);
  expect(row(files[1]).dataset.dialState).toBe('off');
  fireEvent.change(motion().getByRole('slider'), { target: { value: '2.25' } });
  expect(last[0]).toEqual({ dial: files[1], strength: 2.25, on: false });
  expect(motion().getByRole('spinbutton')).toHaveProperty('value', '2.25');
  // The slider reaches ±3; the number field accepts the compiler's full range and clamps beyond it.
  const slider = motion().getByRole('slider') as HTMLInputElement;
  expect([slider.min, slider.max, slider.step]).toEqual(['-3', '3', '0.05']);
  const number = motion().getByRole('spinbutton') as HTMLInputElement;
  expect([number.min, number.max]).toEqual(['-20', '20']);
  fireEvent.change(number, { target: { value: '-12.5' } });
  expect(last[0].strength).toBe(-12.5);
  expect(slider.value).toBe('-3');
  fireEvent.change(number, { target: { value: '99' } });
  expect(last[0].strength).toBe(20);
  expect(number.value).toBe('99');
  fireEvent.blur(number);
  expect(number.value).toBe('20');
  // An unfinished number stays in the field and leaves the row alone.
  fireEvent.change(number, { target: { value: '' } });
  expect(last[0].strength).toBe(20);
  expect(number.value).toBe('');
  fireEvent.blur(number);
  expect(number.value).toBe('20');
  expect(isDialRows(last)).toBe(true);
  fireEvent.click(motion().getByRole('button', { name: 'Remove h3_motion' }));
  expect(last).toEqual([{ dial: files[2], strength: -0.5, on: true }]);
  expect(row(files[1])).toBeNull();
});

test('a row with a time curve keeps it through edits and shows a read-only thumbnail', () => {
  const time = { type: 'keys' as const, points: [[0, 0.5], [1.5, 1], [4, -2]] as [number, number][], unit: 'seconds' as const };
  render(<Host rows={[{ dial: files[2], strength: -0.5, on: true, time }, { dial: files[1], strength: 1 }]}/>);
  const thumb = within(row(files[2])).getByRole('img', { name: 'Time curve of h3_calm: 3 points' });
  expect(thumb.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(5);
  expect(row(files[1]).querySelector('[data-dial-curve]')).toBeNull();
  // Absent `on` reads as on.
  expect(within(row(files[1])).getByRole('checkbox')).toHaveProperty('checked', true);
  fireEvent.change(within(row(files[2])).getByRole('spinbutton'), { target: { value: '0.75' } });
  expect(last[0]).toEqual({ dial: files[2], strength: 0.75, on: true, time });
  expect(document.querySelector('[data-dial-row] canvas, [data-dial-curve] [tabindex]')).toBeNull();
});

test.each([
  ['h3VideoOnly', 'studio.dials.reason.h3VideoOnly'],
  ['nodeMissing', 'studio.dials.reason.nodeMissing'],
  ['gguf', 'studio.dials.reason.gguf'],
] as const)('gate %s shows its reason, blocks adding and strength edits, and leaves switch and remove usable', (gate, key) => {
  render(<Host gate={gate} rows={[{ dial: files[1], strength: 1.5, on: true }]}/>);
  expect(document.querySelector('[data-dials]')?.getAttribute('data-dials')).toBe(gate);
  expect(screen.getByRole('status').textContent).toBe(text(key));
  expect(add().disabled).toBe(true);
  expect(add().title).toBe(text(key));
  const line = within(row(files[1]));
  expect(line.getByRole('slider')).toHaveProperty('disabled', true);
  expect(line.getByRole('spinbutton')).toHaveProperty('disabled', true);
  fireEvent.click(line.getByRole('checkbox'));
  expect(last).toEqual([{ dial: files[1], strength: 1.5, on: false }]);
  fireEvent.click(line.getByRole('button', { name: 'Remove h3_motion' }));
  expect(last).toEqual([]);
});

test('a full rack, an empty folder, an unread list and a missing file each say so', () => {
  const eight = Array.from({ length: 8 }, (_, n) => ({ dial: `dials/d${n}.safetensors`, strength: 1, on: true }));
  const view = render(<Host rows={eight} listed={[...files, ...eight.map(r => r.dial)]}/>);
  expect(add().disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('A rack holds at most 8 dials.');
  expect(document.querySelectorAll('[data-dial-row]')).toHaveLength(8);
  view.unmount();
  const empty = render(<Host listed={['style.safetensors']} offered={[]}/>);
  expect(document.querySelector('[data-dials-empty]')?.textContent).toBe(text('studio.dials.none'));
  expect(add().disabled).toBe(true);
  empty.unmount();
  // Unread list: nothing is called missing and no "empty folder" claim is made.
  const unread = render(<Host listed={null} offered={[]} rows={[{ dial: files[1], strength: 1, on: true }]}/>);
  expect(document.querySelector('[data-dials-empty]')).toBeNull();
  expect(document.querySelector('[data-dial-missing]')).toBeNull();
  unread.unmount();
  render(<Host listed={['dials\\sub\\h3_calm.safetensors'.replace(/\\/g, '/')]} rows={[{ dial: files[1], strength: 1, on: true }, { dial: files[2], strength: 1, on: true }]}/>);
  expect(row(files[1]).dataset.dialState).toBe('missing');
  expect(within(row(files[1])).getByRole('alert').textContent).toBe('Not on the backend');
  expect(row(files[2]).dataset.dialState).toBe('on');
});

test('the rack button appears only when a rack dialog is wired', () => {
  const view = render(<Host/>);
  expect(document.querySelector('[data-dial-rack-open]')).toBeNull();
  view.unmount();
  let opened = 0;
  render(<Host rack={() => { opened++; }}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Open rack' }));
  expect(opened).toBe(1);
});

test('every dial string exists in all six locales with its placeholders, and global search finds the tab', () => {
  const keys = Object.keys(bundledCatalog.dictionaries.en).filter(k => k.startsWith('studio.dials.') || k === 'studio.run.dock.dials');
  expect(keys.length).toBe(170);
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const locale of ['de', 'fr', 'ja', 'tr', 'zh']) for (const key of keys) {
    const value = bundledCatalog.dictionaries[locale][key];
    expect(value, `${locale} ${key}`).toBeTruthy();
    expect(holes(value), `${locale} ${key}`).toBe(holes(text(key)));
    // A unit (`{seconds} s`) reads the same in the Latin-script locales, and "Audio" is the German and French word too.
    if (!['studio.dials.unavailable', 'studio.run.dock.dials', 'studio.dials.rack.length', 'studio.dials.rack.audio'].includes(key)) expect(value, `${locale} ${key}`).not.toBe(text(key));
  }
  const entry = searchIndex.find(e => e.label === 'studio.dials.add')!;
  expect(entry).toMatchObject({ dockTab: 'dials', target: '#studio-dock [data-dial-add]' });
  expect(matchEntries(searchIndex, 'dial rack', text)).toContain(entry);
});

const infoMap = parseDialCatalog(catalogFixture)!;
const infoFiles = [dayNight, inkWash, impact, motionDial];
const marksOf = (dial: string) => Array.from(row(dial).querySelectorAll<HTMLElement>('[data-dial-mark]')).map(m => [m.dataset.dialMark, m.dataset.dialMarkAt, +Number(m.style.getPropertyValue('--at')).toFixed(4)]);

test('with the dial file\'s info a row shows its two side labels, marks at the useful and overcook strengths, a reach that follows them and the evidence in words', () => {
  render(<Host info={infoMap} infoStatus="ready" offered={infoFiles} listed={infoFiles} rows={[{ dial: dayNight, strength: 1.5, on: true }, { dial: impact, strength: 4.5, on: true }, { dial: inkWash, strength: 2, on: true }, { dial: motionDial, strength: 1, on: true }]}/>);
  // Negative label under the left end, positive under the right, each named for assistive technology.
  const sides = (dial: string) => Array.from(row(dial).querySelectorAll<HTMLElement>('[data-dial-side]')).map(s => [s.dataset.dialSide, s.textContent, s.title]);
  expect(sides(dayNight)).toEqual([['neg', 'bright midday', 'Negative side: bright midday'], ['pos', 'night', 'Positive side: night']]);
  expect(sides(impact)).toEqual([['neg', 'normal shading', 'Negative side: normal shading'], ['pos', 'impact frame', 'Positive side: impact frame']]);
  expect(sides(motionDial)).toEqual([]);
  const slider = (dial: string) => row(dial).querySelector<HTMLInputElement>('[data-dial="slider"]')!;
  expect([dayNight, impact, inkWash, motionDial].map(d => [slider(d).min, slider(d).max, slider(d).value])).toEqual([['-3', '3', '1.5'], ['-3', '8', '4.5'], ['-3', '3', '2'], ['-3', '3', '1']]);
  expect(marksOf(dayNight)).toEqual([['neg-useful', '-1.5', 0.25], ['neg-overcook', '-3', 0], ['pos-useful', '1.5', 0.75], ['pos-overcook', '3', 1]]);
  expect(marksOf(impact)).toEqual([['pos-useful', '4.5', 0.6818], ['pos-overcook', '8', 1]]);
  expect(marksOf(inkWash)).toEqual([['pos-useful', '2', 0.8333]]);
  expect(marksOf(motionDial)).toEqual([]);
  expect(row(impact).querySelector<HTMLElement>('[data-dial-mark="pos-overcook"]')!.title).toBe('overcook 8 (8)');
  // The numbers and the evidence are text, and the slider is described by it.
  const facts = (dial: string) => row(dial).querySelector<HTMLElement>('[data-dial-facts]')!;
  expect(facts(dayNight).textContent).toBe('+ side: useful 1.5, overcook 3 · − side: useful 1.5, overcook 3 · one seed');
  expect(facts(impact).textContent).toBe('+ side: useful 4.5, overcook 8 · one seed');
  expect(facts(inkWash).textContent).toBe('+ side: useful 2 · one seed');
  expect(facts(motionDial).textContent).toBe('The dial file records no useful or overcook strength.');
  expect(slider(dayNight).getAttribute('aria-describedby')).toBe(facts(dayNight).id);
  expect(row(dayNight).dataset.dialInfo).toBe('known');
  // The number field keeps the compiler's full range whatever the slider reaches.
  const number = row(impact).querySelector<HTMLInputElement>('[data-dial="strength"]')!;
  expect([number.min, number.max]).toEqual(['-20', '20']);
});

test('a row above its overcook strength gets a quiet warning, and the slider stays at its end', () => {
  render(<Host info={infoMap} infoStatus="ready" offered={infoFiles} listed={infoFiles} rows={[{ dial: impact, strength: 8, on: true }, { dial: inkWash, strength: 12, on: true }]}/>);
  expect(row(impact).querySelector('[data-dial-over]')).toBeNull();
  fireEvent.change(row(impact).querySelector('[data-dial="strength"]')!, { target: { value: '9.5' } });
  expect(last[0].strength).toBe(9.5);
  expect(row(impact).querySelector('[data-dial-over]')!.textContent).toBe('Above this dial\'s overcook strength (8): the picture may break.');
  expect(row(impact).querySelector('[data-dial-over]')!.getAttribute('role')).toBe('status');
  expect(row(impact).querySelector<HTMLInputElement>('[data-dial="slider"]')!.value).toBe('8');
  // The negative side has no overcook strength on record; neither has ink wash at all.
  fireEvent.change(row(impact).querySelector('[data-dial="strength"]')!, { target: { value: '-15' } });
  expect(row(impact).querySelector('[data-dial-over]')).toBeNull();
  expect(row(impact).querySelector<HTMLInputElement>('[data-dial="slider"]')!.value).toBe('-3');
  expect(row(inkWash).querySelector('[data-dial-over]')).toBeNull();
  // Dragging the slider back inside clears it.
  fireEvent.change(row(impact).querySelector('[data-dial="slider"]')!, { target: { value: '6' } });
  expect(last[0].strength).toBe(6);
  expect(row(impact).querySelector('[data-dial-over]')).toBeNull();
});

test('the description, pipeline text and notes open as a note under the row; a dial without any has no button', () => {
  render(<Host info={infoMap} infoStatus="ready" offered={infoFiles} listed={infoFiles} rows={[{ dial: inkWash, strength: 2, on: true }, { dial: dayNight, strength: 1.5, on: true }, { dial: motionDial, strength: 1, on: true }]}/>);
  const about = within(row(inkWash)).getByRole('button', { name: 'About h3_ink_wash' });
  expect(about.getAttribute('aria-expanded')).toBe('false');
  expect(about.title).toContain('Ink wash: the scene becomes a flowing black ink-wash painting');
  expect(row(inkWash).querySelector('[data-dial-note]')).toBeNull();
  fireEvent.click(about);
  expect(about.getAttribute('aria-expanded')).toBe('true');
  const note = row(inkWash).querySelector<HTMLElement>('[data-dial-note]')!;
  expect(about.getAttribute('aria-controls')).toBe(note.id);
  expect(Array.from(note.querySelectorAll<HTMLElement>('[data-dial-note-part]')).map(p => p.dataset.dialNotePart)).toEqual(['description', 'pipeline', 'notes']);
  // The "k = 6" guidance is the file's own words, shown as they are.
  expect(note.querySelector('[data-dial-note-part="pipeline"]')!.textContent).toBe('Measured with: Pika H3 Flex 6-step, time rows k = 6, audio: protect');
  expect(note.querySelector('[data-dial-note-part="notes"]')!.textContent).toContain('2 at k = 6 follows but re-composes the landscape (k = 2 smears the look over the clip)');
  // Day/night has a description and pipeline text but no notes.
  fireEvent.click(within(row(dayNight)).getByRole('button', { name: 'About h3_day_night_hook' }));
  expect(Array.from(row(dayNight).querySelectorAll<HTMLElement>('[data-dial-note-part]')).map(p => p.dataset.dialNotePart)).toEqual(['description', 'pipeline']);
  expect(within(row(motionDial)).queryByRole('button', { name: 'About h3_motion' })).toBeNull();
  fireEvent.click(about);
  expect(row(inkWash).querySelector('[data-dial-note]')).toBeNull();
  expect(row(dayNight).querySelector('[data-dial-note]')).not.toBeNull();
});

test('a new row starts at the dial\'s positive useful strength when known, else at 1', () => {
  render(<Host info={infoMap} infoStatus="ready" offered={infoFiles} listed={infoFiles}/>);
  for (const dial of [impact, inkWash, dayNight, motionDial]) fireEvent.change(add(), { target: { value: dial } });
  expect(last).toEqual([{ dial: impact, strength: 4.5, on: true }, { dial: inkWash, strength: 2, on: true }, { dial: dayNight, strength: 1.5, on: true }, { dial: motionDial, strength: 1, on: true }]);
  expect(isDialRows(last)).toBe(true);
});

test('without dial info the strip keeps its fallbacks and only says so: nothing is disabled', () => {
  const refresh = vi.fn();
  const view = render(<Host infoStatus="unavailable" refresh={refresh} offered={infoFiles} listed={infoFiles} rows={[{ dial: impact, strength: 4.5, on: true }]}/>);
  const note = document.querySelector<HTMLElement>('[data-dial-info-state="unavailable"]')!;
  expect(note.textContent).toBe('Dial info unavailable: side labels and strength marks are not shown. The rows work as before.');
  expect(note.getAttribute('role')).toBe('status');
  expect(document.querySelector('[data-dials]')!.getAttribute('data-dials')).toBe('ready');
  // The fallbacks: file name, ±3, no labels, marks, facts or note, and a new row at 1.
  const slider = row(impact).querySelector<HTMLInputElement>('[data-dial="slider"]')!;
  expect([slider.min, slider.max, slider.value, slider.disabled, slider.getAttribute('aria-describedby')]).toEqual(['-3', '3', '3', false, null]);
  expect(row(impact).querySelector('[data-dial-sides], [data-dial-mark], [data-dial-facts], [data-dial="about"], [data-dial-over]')).toBeNull();
  expect(row(impact).dataset.dialInfo).toBeUndefined();
  expect(add().disabled).toBe(false);
  fireEvent.change(add(), { target: { value: inkWash } });
  expect(last[1]).toEqual({ dial: inkWash, strength: 1, on: true });
  fireEvent.change(row(impact).querySelector('[data-dial="strength"]')!, { target: { value: '9' } });
  expect(last[0].strength).toBe(9);
  // Reload is offered; while a read runs it is off.
  fireEvent.click(screen.getByRole('button', { name: 'Reload dial info' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(<Host infoStatus="loading" refresh={refresh} offered={infoFiles} listed={infoFiles}/>);
  expect(screen.getByRole('button', { name: 'Reload dial info' })).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-dial-info-state]')).toBeNull();
  // Before any read, and where no reload is wired, nothing about info is shown.
  view.unmount();
  render(<Host rows={[{ dial: impact, strength: 4.5, on: true }]}/>);
  expect(document.querySelector('[data-dial-info-state], [data-dial-info-refresh]')).toBeNull();
});

test('a dial the catalog does not know keeps the fallbacks beside rows that have info', () => {
  render(<Host info={infoMap} infoStatus="ready" rows={[{ dial: 'dials/sub/h3_calm.safetensors', strength: 5, on: true }, { dial: 'dials\\h3_impact_frame.safetensors', strength: 4.5, on: true }]}/>);
  const calm = row('dials/sub/h3_calm.safetensors');
  expect(calm.querySelector<HTMLInputElement>('[data-dial="slider"]')!.max).toBe('3');
  expect(calm.querySelector('[data-dial-facts], [data-dial-mark], [data-dial-sides]')).toBeNull();
  // A row stored with a Windows separator still finds its info.
  expect(document.querySelectorAll<HTMLElement>('[data-dial-row]')[1].querySelector<HTMLInputElement>('[data-dial="slider"]')!.max).toBe('8');
});

test('a row whose dial the catalog lists for another model family says so; H3 rows, unknown families and rows without info do not', () => {
  const map = { ...infoMap, ...parseDialCatalog(familyFixture)! };
  const rows: DialRow[] = [kreaDial, mossDial, preDial, unlabelled, motionDial, 'dials/not_in_catalog.safetensors'].map(dial => ({ dial, strength: 1, on: true }));
  const all = rows.map(r => r.dial);
  const view = render(<Host rows={rows} listed={all} offered={all} info={map} infoStatus="ready"/>);
  const flag = (dial: string) => row(dial).querySelector<HTMLElement>('[data-dial-other-family]');
  expect(flag(kreaDial)!.textContent).toBe('Made for Krea 2, not MiniMax H3: the Dial Rack node refuses it here');
  expect(flag(kreaDial)!.getAttribute('role')).toBe('alert');
  expect(row(kreaDial).dataset.dialFamily).toBe('other');
  expect(flag(mossDial)!.textContent).toContain('Made for MOSS-Image');
  for (const dial of [preDial, unlabelled, motionDial, 'dials/not_in_catalog.safetensors']) {
    expect(flag(dial), dial).toBeNull();
    expect(row(dial).dataset.dialFamily, dial).toBeUndefined();
  }
  // The row stays editable and removable: nothing is taken away.
  expect(row(kreaDial).querySelector<HTMLInputElement>('[data-dial="slider"]')!.disabled).toBe(false);
  expect(row(kreaDial).querySelector<HTMLInputElement>('[data-dial="on"]')!.disabled).toBe(false);
  view.unmount();
  // Without a catalog nothing is flagged.
  render(<Host rows={rows} listed={all} offered={all}/>);
  expect(document.querySelector('[data-dial-other-family]')).toBeNull();
});
