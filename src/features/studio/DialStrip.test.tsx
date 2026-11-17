import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bundledCatalog, I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { matchEntries, searchIndex } from '../../lib/search';
import { isDialRows, type DialGate, type DialRow } from '../../lib/dials';
import { DialStrip } from './DialStrip';

beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); });
afterEach(() => { cleanup(); localStorage.clear(); });
const files = ['dials/h3_day_night_hook.safetensors', 'dials/h3_motion.safetensors', 'dials/sub/h3_calm.safetensors'];
const text = (key: string) => bundledCatalog.dictionaries.en[key];
let last: DialRow[] = [];
function Host({ rows = [], gate = '', listed = files, offered = files, rack }: { rows?: DialRow[]; gate?: DialGate; listed?: string[] | null; offered?: string[]; rack?: () => void }) {
  const [value, setValue] = useState(rows);
  return <I18nProvider><DialStrip value={value} onChange={v => { last = v; setValue(v); }} files={offered} listed={listed ?? undefined} gate={gate} seconds={4} onOpenRack={rack}/></I18nProvider>;
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
  expect(keys.length).toBe(82);
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const locale of ['de', 'fr', 'ja', 'tr', 'zh']) for (const key of keys) {
    const value = bundledCatalog.dictionaries[locale][key];
    expect(value, `${locale} ${key}`).toBeTruthy();
    expect(holes(value), `${locale} ${key}`).toBe(holes(text(key)));
    // A unit (`{seconds} s`) reads the same in the Latin-script locales.
    if (!['studio.dials.unavailable', 'studio.run.dock.dials', 'studio.dials.rack.length'].includes(key)) expect(value, `${locale} ${key}`).not.toBe(text(key));
  }
  const entry = searchIndex.find(e => e.label === 'studio.dials.add')!;
  expect(entry).toMatchObject({ dockTab: 'dials', target: '#studio-dock [data-dial-add]' });
  expect(matchEntries(searchIndex, 'dial rack', text)).toContain(entry);
});
