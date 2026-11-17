import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { bundledCatalog, I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import type { DialRow } from '../../lib/dials';
import { dialPresetErrorCodes, type DialPreset, type DialPresetStore } from '../../lib/dialPresets';
import type { DialTimeline } from '../../lib/dialCurve';
import { DialPresetsDialog } from './DialPresetsDialog';
import { DialRackDialog } from './DialRackDialog';
import { DialStrip } from './DialStrip';

const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  // jsdom has no native dialog lifecycle; preserve its open-state semantics here only.
  Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } }, close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } } });
});
afterEach(() => {
  cleanup(); localStorage.clear();
  for (const method of ['showModal', 'close']) {
    if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
});

const motion = 'dials/h3_motion.safetensors', cold = 'dials/h3_evil_cold.safetensors', gone = 'dials/gone.safetensors';
const sha = 'a'.repeat(64);
const text = (key: string, params: Record<string, string> = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), bundledCatalog.dictionaries.en[key]);
const rack = (): DialRow[] => [{ dial: motion, strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds' } }, { dial: cold, strength: 1.5, on: false }];
/** A stand-in for the pack's routes: presets by name, saving refuses an existing name like the pack's 409. */
function fixtureStore(initial: Record<string, DialPreset> = {}) {
  const presets: Record<string, DialPreset> = { ...initial };
  const store: DialPresetStore = {
    list: vi.fn(async () => Object.keys(presets).sort()),
    load: vi.fn(async (_base: string, name: string) => { if (!presets[name]) throw new Error('DIAL_PRESET_NOT_FOUND: Preset not found.'); return presets[name]; }),
    save: vi.fn(async (_base: string, name: string, rows: readonly DialRow[]) => {
      if (presets[name]) throw new Error('DIAL_PRESET_EXISTS: Preset already exists. Choose a new name.');
      presets[name] = { rows: rows.map(r => ({ ...r, sha256: r.dial === gone ? null : sha, solo: false })), warnings: rows.flatMap((r, row) => r.dial === gone ? [{ row, reason: 'missing' as const }] : []) };
      return presets[name];
    }),
  };
  return { store, presets };
}
const mixed: DialPreset = {
  rows: [
    { dial: motion, sha256: sha, strength: 1.2, on: true, solo: false, time: { type: 'keys', points: [[0, 0], [0.5, 1]] } },
    { dial: cold, sha256: sha, strength: 1.5, on: true, solo: false, hold: true },
    { dial: gone, sha256: sha, strength: -2, on: true, solo: false },
    { dial: 'dials/blocks.safetensors', sha256: sha, strength: 1, on: true, solo: false, blocks: [1, 0] },
  ],
  warnings: [{ row: 2, reason: 'missing' }, { row: 0, reason: 'changed' }],
};
let last: DialRow[] | null = null;
function Host({ store, initial = rack(), seconds = 4 }: { store: DialPresetStore; initial?: DialRow[]; seconds?: number }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState(true);
  return <I18nProvider><button type="button" onClick={() => setOpen(true)}>opener</button>
    {open && <DialPresetsDialog endpoint="http://127.0.0.1:8188" rows={rows} seconds={seconds} store={store} onLoad={next => { last = next; setRows(next); }} onClose={() => setOpen(false)}/>}</I18nProvider>;
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const choose = async (name: string) => { fireEvent.change(q('[data-dial-preset-select]'), { target: { value: name } }); await waitFor(() => expect(q('[data-dial-preset-rows]')?.getAttribute('data-dial-preset-rows')).toBe(name)); };
const ready = () => waitFor(() => expect(q<HTMLSelectElement>('[data-dial-preset-select]').disabled).toBe(false));

test('lists the backend presets, shows every row of the chosen one with its notes, and loads only what DEAS sends', async () => {
  const { store } = fixtureStore({ mixed, plain: { rows: [{ dial: motion, sha256: sha, strength: 1.5, on: true, solo: false }], warnings: [] } });
  last = null;
  render(<Host store={store}/>);
  const dialog = screen.getByRole('dialog', { name: 'Rack presets (experimental)' });
  expect(dialog.classList.contains('lora-sets-dialog')).toBe(true);
  await ready();
  expect(store.list).toHaveBeenCalledWith('http://127.0.0.1:8188');
  expect(within(dialog).getAllByRole('option').map(o => o.textContent)).toEqual(['Select a preset', 'mixed', 'plain']);
  // The current rack is listed on the left, off rows marked.
  expect(Array.from(document.querySelectorAll('[data-dial-preset-current]')).map(e => e.textContent)).toEqual(['h3_motionstrength 1.2 · time curve', 'h3_evil_coldstrength 1.5 · constant · off']);
  expect(q<HTMLButtonElement>('[data-dial-preset-load]').disabled).toBe(true);

  await choose('mixed');
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-dial-preset-row]'));
  expect(rows.map(r => r.dataset.dialPresetState)).toEqual(['warning', 'left-out', 'warning', 'left-out']);
  expect(rows[0].textContent).toContain(text('studio.dials.presets.changed.fractions', { seconds: '4' }));
  expect(rows[0].textContent).toContain('The dial file changed since the preset was saved.');
  expect(rows[1].textContent).toContain('Not loaded: hold rows are not sent by this version.');
  expect(rows[2].textContent).toContain('The backend does not have this dial file.');
  expect(rows[3].textContent).toContain('Not loaded: block strengths are not sent by this version.');
  expect(last).toBeNull();

  fireEvent.click(q('[data-dial-preset-load]'));
  expect(last).toEqual([
    { dial: motion, strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [2, 1]], unit: 'seconds' } },
    { dial: gone, strength: -2, on: true },
  ]);
  expect(q('[data-dial-preset-status]').textContent).toBe('Loaded 2 of 4 rows into the rack.');
  // The left panel now shows the loaded rack; nothing was saved.
  expect(document.querySelectorAll('[data-dial-preset-current]')).toHaveLength(2);
  expect(store.save).not.toHaveBeenCalled();
});

test('saves the current rack under a new name with only DEAS rows, then shows the saved preset with the pack\'s warnings', async () => {
  const { store, presets } = fixtureStore();
  render(<Host store={store} initial={[...rack(), { dial: gone, strength: 1, on: true }]}/>);
  await ready();
  expect(within(q('[data-dial-preset-select]')).getAllByRole('option').map(o => o.textContent)).toEqual(['No presets yet']);
  const save = q<HTMLButtonElement>('[data-dial-preset-save]'), name = q<HTMLInputElement>('[data-dial-preset-name]');
  expect(save.disabled).toBe(true);
  for (const bad of ['two words', 'ä', 'a/b', 'x.json']) {
    fireEvent.change(name, { target: { value: bad } });
    expect(save.disabled, bad).toBe(true);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(q('[data-dial-preset-name-help]').classList.contains('error-message')).toBe(true);
  }
  fireEvent.change(name, { target: { value: 'dance_ramp-1' } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(q('[data-dial-preset-status]').textContent).toBe('Saved as dance_ramp-1.'));
  expect(store.save).toHaveBeenCalledWith('http://127.0.0.1:8188', 'dance_ramp-1', [
    { dial: motion, strength: 1.2, on: true, time: { type: 'keys', points: [[0, 0], [1.6, 0], [2.6, 1], [4, 1]], unit: 'seconds' } },
    { dial: cold, strength: 1.5, on: false },
    { dial: gone, strength: 1, on: true },
  ]);
  expect(Object.keys(presets)).toEqual(['dance_ramp-1']);
  // The saved preset is selected and read back: the missing dial is named on its row.
  expect(q<HTMLSelectElement>('[data-dial-preset-select]').value).toBe('dance_ramp-1');
  expect(Array.from(document.querySelectorAll<HTMLElement>('[data-dial-preset-row]')).map(r => r.dataset.dialPresetState)).toEqual(['ok', 'ok', 'warning']);
  expect(q('[data-dial-preset-warning="missing"]').textContent).toBe('The backend does not have this dial file.');
});

test('never overwrites: an existing name shows the pack\'s answer and leaves the preset as it was', async () => {
  const { store, presets } = fixtureStore({ taken: { rows: [{ dial: cold, sha256: sha, strength: 3, on: true, solo: false }], warnings: [] } });
  const before = JSON.stringify(presets.taken);
  render(<Host store={store}/>);
  await ready();
  fireEvent.change(q('[data-dial-preset-name]'), { target: { value: 'taken' } });
  fireEvent.click(q('[data-dial-preset-save]'));
  const alert = await screen.findByRole('alert');
  expect(alert.getAttribute('data-dial-preset-error')).toBe('DIAL_PRESET_EXISTS');
  expect(alert.textContent).toBe('A preset with this name already exists. Nothing was overwritten; choose a new name. Preset already exists. Choose a new name.');
  expect(JSON.stringify(presets.taken)).toBe(before);
  expect(q('[data-dial-preset-status]').textContent).toBe('');
  // Typing a new name clears the answer.
  fireEvent.change(q('[data-dial-preset-name]'), { target: { value: 'taken2' } });
  expect(screen.queryByRole('alert')).toBeNull();
});

test('fails closed without the pack: the reason is shown and nothing can be loaded or saved', async () => {
  const missing = 'DIAL_PRESETS_UNAVAILABLE: This backend has no rack preset route. It comes with the Dial Rack nodes (ComfyUI-Dials or ComfyUI-MAINodes), which DEAS does not install yet';
  const store: DialPresetStore = { list: vi.fn(async () => { throw new Error(missing); }), load: vi.fn(), save: vi.fn() };
  render(<Host store={store}/>);
  const alert = await screen.findByRole('alert');
  expect(alert.getAttribute('data-dial-preset-error')).toBe('DIAL_PRESETS_UNAVAILABLE');
  expect(alert.textContent).toBe(text('studio.dials.presets.error.DIAL_PRESETS_UNAVAILABLE'));
  fireEvent.change(q('[data-dial-preset-name]'), { target: { value: 'anything' } });
  // Typing clears the message of a failed save, not the missing store: the reason and the disabled controls stay.
  expect(q<HTMLButtonElement>('[data-dial-preset-save]').disabled).toBe(true);
  expect(screen.getByRole('alert').getAttribute('data-dial-preset-error')).toBe('DIAL_PRESETS_UNAVAILABLE');
  expect(q<HTMLButtonElement>('[data-dial-preset-load]').disabled).toBe(true);
  expect(q<HTMLSelectElement>('[data-dial-preset-select]').options).toHaveLength(1);
  expect(store.load).not.toHaveBeenCalled();
  // Refresh asks again and shows the reason again.
  fireEvent.click(q('[data-dial-preset-refresh]'));
  await waitFor(() => expect(store.list).toHaveBeenCalledTimes(2));
  expect((await screen.findByRole('alert')).getAttribute('data-dial-preset-error')).toBe('DIAL_PRESETS_UNAVAILABLE');
  expect(q<HTMLButtonElement>('[data-dial-preset-save]').disabled).toBe(true);
  expect(store.save).not.toHaveBeenCalled();
});

test('a preset that vanished or that the pack refuses shows the reason and loads nothing', async () => {
  const { store } = fixtureStore({ here: { rows: [{ dial: motion, strength: 1 }], warnings: [] } });
  vi.mocked(store.load).mockRejectedValueOnce(new Error('DIAL_PRESET_REFUSED: unsupported rack preset format or version (expected MAIDialRack preset v1)'));
  last = null;
  render(<Host store={store}/>);
  await ready();
  fireEvent.change(q('[data-dial-preset-select]'), { target: { value: 'here' } });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('The node pack refused the preset. unsupported rack preset format or version (expected MAIDialRack preset v1)');
  expect(document.querySelector('[data-dial-preset-rows]')).toBeNull();
  expect(q<HTMLButtonElement>('[data-dial-preset-load]').disabled).toBe(true);
  expect(last).toBeNull();
});

test('an empty rack cannot be saved, and a preset with nothing DEAS sends cannot be loaded', async () => {
  const { store } = fixtureStore({ holds: { rows: [{ dial: motion, strength: 0, on: true, hold: true }], warnings: [] } });
  render(<Host store={store} initial={[]}/>);
  await ready();
  expect(q('[data-dial-presets-empty]').textContent).toBe('No dials in the rack. Add one to save a preset.');
  fireEvent.change(q('[data-dial-preset-name]'), { target: { value: 'empty' } });
  expect(q<HTMLButtonElement>('[data-dial-preset-save]').disabled).toBe(true);
  await choose('holds');
  expect(q('[data-dial-preset-left="hold"]')).toBeTruthy();
  expect(q<HTMLButtonElement>('[data-dial-preset-load]').disabled).toBe(true);
});

test('closes on its button and on cancel, and returns focus to what opened it', async () => {
  const { store } = fixtureStore();
  render(<Host store={store}/>);
  await ready();
  fireEvent.click(q('[data-dial-presets-close]'));
  expect(screen.queryByRole('dialog')).toBeNull();
  const opener = screen.getByRole('button', { name: 'opener' });
  opener.focus();
  fireEvent.click(opener);
  await ready();
  const cancel = new Event('cancel', { bubbles: false, cancelable: true });
  fireEvent(screen.getByRole('dialog'), cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test('the strip offers Presets only with a handler; in the rack dialog a loaded preset is one undo step', async () => {
  const { store } = fixtureStore({ plain: { rows: [{ dial: cold, sha256: sha, strength: 1.5, on: true, solo: false }], warnings: [] } });
  const open = vi.fn();
  const strip = render(<I18nProvider><DialStrip value={rack()} onChange={() => {}} files={[motion, cold]} listed={[motion, cold]} gate="" seconds={4}/></I18nProvider>);
  expect(document.querySelector('[data-dial-presets-open]')).toBeNull();
  strip.rerender(<I18nProvider><DialStrip value={rack()} onChange={() => {}} files={[motion, cold]} listed={[motion, cold]} gate="" seconds={4} onOpenPresets={open}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Presets…' }));
  expect(open).toHaveBeenCalledTimes(1);
  strip.unmount();

  const timeline: DialTimeline = { seconds: 4, frames: 96, edges: [], basis: 'clip' };
  let value = rack();
  const rackClosed = vi.fn();
  function Rack() {
    const [rows, setRows] = useState(value);
    return <I18nProvider><DialRackDialog value={rows} onChange={v => { value = v; setRows(v); }} files={[motion, cold]} listed={[motion, cold]} gate="" timeline={timeline} steps={6} conflicts={[]} onClose={rackClosed} endpoint="http://127.0.0.1:8188" presetStore={store}/></I18nProvider>;
  }
  render(<Rack/>);
  const rackDialog = screen.getByRole('dialog', { name: 'Dial rack (experimental)' });
  // A strength edit first, so the load is not merged into an open gesture.
  fireEvent.change(within(rackDialog).getByRole('slider', { name: 'Strength of h3_motion' }), { target: { value: '2' } });
  fireEvent.click(within(rackDialog).getByRole('button', { name: 'Presets…' }));
  await ready();
  await choose('plain');
  await act(async () => { fireEvent.click(q('[data-dial-preset-load]')); });
  expect(value).toEqual([{ dial: cold, strength: 1.5, on: true }]);
  expect(document.querySelectorAll('[data-dial-lane]')).toHaveLength(1);
  // Esc and Ctrl+Z in the presets dialog stay there: the rack neither closes nor undoes.
  fireEvent.keyDown(q('[data-dial-preset-load]'), { key: 'z', ctrlKey: true });
  expect(value).toEqual([{ dial: cold, strength: 1.5, on: true }]);
  fireEvent(q('dialog[data-dial-presets]'), new Event('cancel', { bubbles: false, cancelable: true }));
  expect(document.querySelector('dialog[data-dial-presets]')).toBeNull();
  expect(rackClosed).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Dial rack (experimental)' })).toBeTruthy();
  fireEvent.click(q('[data-dial-tool="undo"]'));
  expect(value).toEqual([{ ...rack()[0], strength: 2 }, rack()[1]]);
  fireEvent.click(q('[data-dial-tool="redo"]'));
  expect(value).toEqual([{ dial: cold, strength: 1.5, on: true }]);
});

test('every native failure code has a sentence in all six locales', () => {
  for (const locale of ['en', 'de', 'fr', 'ja', 'tr', 'zh']) for (const code of [...dialPresetErrorCodes, 'other']) expect(bundledCatalog.dictionaries[locale][`studio.dials.presets.error.${code}`], `${locale} ${code}`).toBeTruthy();
});
