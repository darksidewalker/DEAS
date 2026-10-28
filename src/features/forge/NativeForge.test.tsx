import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { aspects } from '../../lib/resolution';
import type { ForgeCanvasContext } from '../../lib/forgeCanvas';
import type { NativeResult, NativeWrite } from '../../lib/forge';
import { NativeForge } from './NativeForge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), convertFileSrc: (path: string) => path }));
const context: ForgeCanvasContext = { key: 'studio-a', effective: { width: 1280, height: 768 }, model: { width: 1024, height: 1024 }, grid: 16, resolution: 'model', megapixels: 1, fixed: { width: 1024, height: 1024 } };
const targets = { source: {}, creativity: [], targets: ['illustrious', 'anima', 'krea2', 'moss'].map(key => ({ key, label: key, modes: key === 'moss' ? ['Natural language', 'Layout JSON'] : [], defaultMode: null, optional: ['Negative prompt'], qualityPresets: [], styles: [], aspectRatios: ['N/A', '2:3 Portrait'], hasNegative: key !== 'krea2', tools: false, guidance: [], secondPass: true, ...(key === 'moss' ? { layoutCanvas: { 'N/A': [1024, 1024] } } : {}) })) };
const result: NativeResult = { segments: [{ label: 'Positive prompt', body: 'written city' }], prompt: 'written city', negative: 'blur', refused: false, characters: [], tools: [], rounds: 0, warnings: [], fixes: [] };
const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'native_forge_write').map(([, args]) => (args as { request: NativeWrite }).request);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function view({ target = 'illustrious', endpoint = 'http://127.0.0.1:8188', root = '/env', model = 'openai:qwen', brief = 'a city', detail = 5, canvasContext = context, onSend = vi.fn<Parameters<typeof NativeForge>[0]['onSend']>() }: { target?: string; endpoint?: string; root?: string; model?: string; brief?: string; detail?: number; canvasContext?: ForgeCanvasContext; onSend?: Parameters<typeof NativeForge>[0]['onSend'] } = {}) {
  const forge = { model, usable: [{ id: model, label: model }], setModel: vi.fn(), list: null, error: '', load: vi.fn(), rev: 0 };
  return <I18nProvider><NativeForge root={root} endpoint={endpoint} canvasContext={canvasContext} target={target} forge={forge} brief={brief} setBrief={vi.fn()} detail={detail} setDetail={vi.fn()} creativity={5} setCreativity={vi.fn()} onSend={onSend}/></I18nProvider>;
}
const tile = (choice: string) => document.querySelector(`[data-forge-tile="aspect:${choice}"]`)!;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'native_forge_targets') return targets;
    if (command === 'native_forge_write' || command === 'native_forge_revise') return result;
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each(['illustrious', 'anima', 'krea2', 'moss'])('%s offers every Settings ratio and sends the resolved non-square canvas without changing Studio', async target => {
  const onSend = vi.fn(); render(view({ target, onSend }));
  await screen.findByRole('button', { name: 'Open all' });
  expect([...document.querySelectorAll('[data-forge-tile^="aspect:"]')].map(node => node.getAttribute('data-forge-tile')!.slice(7))).toEqual(['N/A', ...aspects]);
  fireEvent.click(tile('16:9'));
  expect(writes()).toHaveLength(0); expect(onSend).not.toHaveBeenCalled();
  expect(document.querySelector('[data-forge-canvas]')!.textContent).toContain('1344 × 768');
  fireEvent.click(document.querySelector('[data-forge-write]')!);
  await screen.findByDisplayValue('written city');
  expect(writes()[0]).toMatchObject({ target, controls: { aspectRatio: '16:9', canvas: { width: 1344, height: 768 } } });
  fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: 'my edited city' } });
  fireEvent.click(document.querySelector('[data-forge-send]')!);
  expect(onSend).toHaveBeenCalledExactlyOnceWith('my edited city', '', { canvas: { width: 1344, height: 768 }, contextKey: 'studio-a' });
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['native_forge_targets', 'native_forge_write']);
});

it('Auto consumes the effective source canvas; Custom validates values and N/A keeps the prompt-only callback', async () => {
  const onSend = vi.fn(); render(view({ onSend })); await screen.findByRole('button', { name: 'Open all' });
  fireEvent.click(tile('auto')); fireEvent.click(document.querySelector('[data-forge-write]')!);
  await screen.findByDisplayValue('written city');
  expect(writes()[0].controls).toMatchObject({ aspectRatio: 'auto', canvas: context.effective });
  fireEvent.click(tile('custom'));
  fireEvent.change(document.querySelector('[data-forge-custom-width]')!, { target: { value: '0' } });
  expect((document.querySelector('[data-forge-write]') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('[data-forge-canvas]')!.textContent).toContain('invalid');
  fireEvent.change(document.querySelector('[data-forge-custom-width]')!, { target: { value: '1' } });
  fireEvent.click(document.querySelector('[data-forge-write]')!);
  await waitFor(() => expect(writes()).toHaveLength(2));
  await waitFor(() => expect((document.querySelector('[data-forge-send]') as HTMLButtonElement).disabled).toBe(false));
  expect(writes()[1].controls).toMatchObject({ aspectRatio: 'custom', canvas: { width: 1024, height: 1024 } });
  fireEvent.click(tile('N/A')); fireEvent.click(document.querySelector('[data-forge-write]')!);
  await waitFor(() => expect(writes()).toHaveLength(3));
  await waitFor(() => expect((document.querySelector('[data-forge-send]') as HTMLButtonElement).disabled).toBe(false));
  expect(writes()[2].controls?.canvas).toBeUndefined();
  fireEvent.click(document.querySelector('[data-forge-send]')!);
  expect(onSend).toHaveBeenCalledExactlyOnceWith('written city', '');
});

it.each(['2:3 Portrait', 'unknown-preset'])('preserves saved %s visibly and resolves only a recognized legacy choice', async choice => {
  localStorage.setItem('deas.pref.forge.native.illustrious.aspect', JSON.stringify(choice));
  render(view()); await screen.findByRole('button', { name: 'Open all' });
  if (choice === 'unknown-preset') {
    expect(document.querySelector('[data-forge-canvas]')!.textContent).toContain(choice);
    expect(tile('N/A').getAttribute('aria-pressed')).toBe('false');
    expect((document.querySelector('[data-forge-write]') as HTMLButtonElement).disabled).toBe(true);
  } else {
    expect(tile('2:3').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(document.querySelector('[data-forge-write]')!); await screen.findByDisplayValue('written city');
    expect(writes()[0].controls).toMatchObject({ aspectRatio: '2:3', canvas: { width: 832, height: 1216 } });
  }
  expect(JSON.parse(localStorage.getItem('deas.pref.forge.native.illustrious.aspect')!)).toBe(choice);
});

it('unavailable Auto is disclosed and cannot write; N/A remains usable without Studio context', async () => {
  render(view({ canvasContext: { ...context, effective: null } })); await screen.findByRole('button', { name: 'Open all' });
  fireEvent.click(tile('auto'));
  expect(document.querySelector('[data-forge-canvas]')!.textContent).toContain('required');
  expect((document.querySelector('[data-forge-write]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(tile('N/A')); fireEvent.click(document.querySelector('[data-forge-write]')!);
  await screen.findByDisplayValue('written city'); expect(writes()[0].controls?.canvas).toBeUndefined();
});

it.each(['root', 'endpoint', 'model', 'canvas', 'aspect', 'brief', 'detail'])('discards a late reply after %s changes, including a return to the original context', async change => {
  const pending = deferred<NativeResult>(); const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge_write' ? pending.promise : base(command, args));
  const ui = render(view()); await screen.findByRole('button', { name: 'Open all' });
  fireEvent.click(tile('16:9')); fireEvent.click(document.querySelector('[data-forge-write]')!);
  if (change === 'aspect') { fireEvent.click(tile('9:16')); fireEvent.click(tile('16:9')); }
  else { ui.rerender(view(change === 'canvas' ? { canvasContext: { ...context, key: 'studio-b' } } : change === 'brief' ? { brief: 'a forest' } : change === 'detail' ? { detail: 9 } : { [change]: change === 'root' ? '/other' : change === 'endpoint' ? 'http://127.0.0.1:9999' : 'openai:other' })); ui.rerender(view()); }
  expect(writes()[0]).toMatchObject({ brief: 'a city', model: 'qwen', controls: { detail: 5, canvas: { width: 1344, height: 768 } } });
  await act(async () => pending.resolve(result));
  expect(document.querySelector('[data-forge-result]')).toBeNull();
  expect(screen.getByText('The context changed while writing. The old reply was discarded.')).toBeTruthy();
});

it('keeps edited result text and its consumed canvas, blocks stale Send and permits explicit text-only Send', async () => {
  const onSend = vi.fn(); const ui = render(view({ onSend })); await screen.findByRole('button', { name: 'Open all' });
  fireEvent.click(tile('16:9')); fireEvent.click(document.querySelector('[data-forge-write]')!); await screen.findByDisplayValue('written city');
  fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: 'edited result' } });
  ui.rerender(view({ onSend, canvasContext: { ...context, key: 'studio-b', effective: { width: 768, height: 1280 } } }));
  expect(document.querySelector('[data-forge-result-canvas]')!.textContent).toContain('1344 × 768');
  expect((document.querySelector('[data-forge-send]') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('[data-forge-stale]')).not.toBeNull();
  fireEvent.click(document.querySelector('[data-forge-send-text-only]')!);
  expect(onSend).toHaveBeenCalledExactlyOnceWith('edited result', 'blur');
  expect(writes()).toHaveLength(1);
});

it('discloses a source-processing handoff refusal and leaves deliberate text-only Send available', async () => {
  const onSend = vi.fn(); render(view({ onSend, canvasContext: { ...context, acceptsCanvas: () => false } })); await screen.findByRole('button', { name: 'Open all' });
  fireEvent.click(tile('16:9')); fireEvent.click(document.querySelector('[data-forge-write]')!); await screen.findByDisplayValue('written city');
  expect(document.querySelector('[data-forge-handoff-blocked]')).not.toBeNull();
  expect((document.querySelector('[data-forge-send]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(document.querySelector('[data-forge-send-text-only]')!); expect(onSend).toHaveBeenCalledExactlyOnceWith('written city', 'blur');
});

it('a pending MOSS write cannot publish after switching modes and returning to the original mode', async () => {
  const pending = deferred<NativeResult>(); const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge_write' ? pending.promise : base(command, args));
  render(view({ target: 'moss' })); await screen.findByRole('button', { name: 'Layout JSON' });
  fireEvent.click(tile('16:9')); fireEvent.click(document.querySelector('[data-forge-write]')!);
  fireEvent.click(document.querySelector('[data-forge-mode="Layout JSON"]')!);
  fireEvent.click(document.querySelector('[data-forge-mode="Natural language"]')!);
  await act(async () => pending.resolve(result));
  expect(document.querySelector('[data-forge-result]')).toBeNull();
  expect(screen.getByText('The context changed while writing. The old reply was discarded.')).toBeTruthy();
});

it.each(['edit', 'clear'])('a late revision preserves the user’s newer %s and never restores obsolete text', async change => {
  const pending = deferred<NativeResult>(); const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge_revise' ? pending.promise : base(command, args));
  const onSend = vi.fn(); render(view({ onSend })); await screen.findByRole('button', { name: 'Open all' });
  fireEvent.click(tile('16:9')); fireEvent.click(document.querySelector('[data-forge-write]')!); await screen.findByDisplayValue('written city');
  fireEvent.change(document.querySelector('[data-forge-refine]')!, { target: { value: 'tighter wording' } });
  fireEvent.click(document.querySelector('[data-forge-refine-run]')!);
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'native_forge_revise')).toBe(true));
  if (change === 'edit') fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: 'newer manual text' } });
  else fireEvent.click(document.querySelector('[data-forge-clear]')!);
  await act(async () => pending.resolve({ ...result, prompt: 'obsolete revised text' }));
  expect(screen.queryByDisplayValue('obsolete revised text')).toBeNull();
  if (change === 'edit') {
    expect(screen.getByDisplayValue('newer manual text')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-forge-send]')!);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('newer manual text', '', { canvas: { width: 1344, height: 768 }, contextKey: 'studio-a' });
  } else expect(document.querySelector('[data-forge-result]')).toBeNull();
});
