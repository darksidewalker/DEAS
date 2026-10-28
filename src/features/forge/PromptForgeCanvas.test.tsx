import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { H3, type H3Result } from '../../lib/forge';
import { forgeAspectChoices, type ForgeCanvasContext } from '../../lib/forgeCanvas';
import { PromptForge } from './PromptForge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, convertFileSrc: (path: string) => path }));
const baseContext: ForgeCanvasContext = {
  key: 'studio-A', effective: { width: 1024, height: 1024 }, model: { width: 1024, height: 1024 },
  grid: 16, resolution: 'model', megapixels: 1, fixed: { width: 1024, height: 1024 },
};
const models = {
  models: [{ id: 'ollama:qwen', label: 'qwen' }, { id: 'ollama:other', label: 'other' }], errors: {},
  creativity: ['literal', 'precise', 'faithful', 'measured', 'balanced'], shot_counts: ['Auto', 1, 2], default_shots: 'Auto', durations: [5, 8],
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const h3Calls = () => vi.mocked(invoke).mock.calls.filter(([command, args]) => command === 'native_forge' && (args as { route?: string })?.route === 'h3').map(([, args]) => args as { body: Record<string, unknown>; baseUrl: string; root: string });
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;
const aspect = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Aspect ratio' });
const chooseAspect = (value: string) => fireEvent.change(aspect(), { target: { value } });
const view = (send: Parameters<typeof PromptForge>[0]['onSend'], context: ForgeCanvasContext | undefined = baseContext, extra: Partial<Parameters<typeof PromptForge>[0]> = {}) =>
  <I18nProvider><PromptForge endpoint="http://127.0.0.1:8188/first/" root="/env" canvasContext={context} onSend={send} {...extra}/></I18nProvider>;
const ready = async () => {
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'LLM model' }) as HTMLSelectElement).value).toBe('ollama:qwen'));
  await waitFor(() => expect(button('[data-forge-write]').disabled).toBe(false));
};
const write = async () => {
  fireEvent.click(button('[data-forge-write]'));
  await waitFor(() => expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe('H3 canvas result'));
};
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  localStorage.setItem('deas.pref.forge.target', JSON.stringify(H3));
  localStorage.setItem('deas.pref.forge.brief', JSON.stringify('a scene at dusk'));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_llm_read') return { provider: 'ollama', baseUrl: 'http://localhost:11434' };
    if (command === 'native_forge') {
      const route = (args as { route: string }).route;
      if (route === 'models') return models;
      if (route === 'h3') return { simple_prompt: 'H3 canvas result', warnings: [] };
      if (route === 'write') return { prompt: 'Legacy prompt result', saw_images: 0 };
    }
    if (command === 'native_media_list') return { path: (args as { path: string }).path, parent: null, entries: [], truncated: false };
    throw Error('Unexpected canvas-test IPC: ' + command);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('standalone H3 offers canonical Settings choices and sends only the consumed non-square canvas on explicit Send', async () => {
  const send = vi.fn(); render(view(send)); await ready();
  expect(Array.from(aspect().options, option => option.value)).toEqual(forgeAspectChoices);
  chooseAspect('3:2');
  expect(screen.getByText('Resolved canvas: 1216 × 832')).toBeTruthy();
  expect(send).not.toHaveBeenCalled(); expect(h3Calls()).toEqual([]);
  await write();
  expect(h3Calls()[0].body).toMatchObject({ output_canvas: { width: 1216, height: 832 }, mode: 'T2VA' });
  expect(screen.getByText('Written for: 1216 × 832')).toBeTruthy(); expect(send).not.toHaveBeenCalled();
  fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: 'Edited H3 text' } });
  fireEvent.click(button('[data-forge-send]'));
  expect(send).toHaveBeenCalledWith('Edited H3 text', '', { canvas: { width: 1216, height: 832 }, contextKey: 'studio-A' });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => /native_(workbench_run|job_prepare|job_submit|input_upload|mask_upload)/.test(command))).toBe(false);
});

it('H3 N/A keeps the old payload and two-argument prompt-only Send without Studio geometry', async () => {
  const send = vi.fn(); render(view(send, undefined, { canvasContext: undefined })); await ready(); await write();
  expect(h3Calls()[0].body).not.toHaveProperty('output_canvas');
  expect(document.querySelector('[data-forge-resolved-canvas]')).toBeNull();
  fireEvent.click(button('[data-forge-send]')); expect(send.mock.calls).toEqual([['H3 canvas result', '']]);
});

it('H3 cannot invent an Auto canvas when the current Studio context is unavailable', async () => {
  const send = vi.fn(); render(view(send, undefined, { canvasContext: undefined })); await ready(); chooseAspect('auto');
  expect(screen.getByText(/A valid Studio canvas context is required/)).toBeTruthy();
  expect(button('[data-forge-write]').disabled).toBe(true); expect(document.querySelector('[data-forge-resolved-canvas]')).toBeNull();
  expect(h3Calls()).toEqual([]); expect(send).not.toHaveBeenCalled();
  chooseAspect('N/A'); expect(button('[data-forge-write]').disabled).toBe(false);
});

it('H3 Auto uses actual effective geometry and Custom uses the same snapped Settings calculation', async () => {
  const send = vi.fn();
  render(view(send, { ...baseContext, effective: { width: 1408, height: 704 } })); await ready();
  chooseAspect('auto'); await write(); expect(h3Calls()[0].body.output_canvas).toEqual({ width: 1408, height: 704 });
  chooseAspect('custom');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Ratio width' }), { target: { value: '2' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Ratio height' }), { target: { value: '3' } });
  expect(screen.getByText('Resolved canvas: 832 × 1248')).toBeTruthy();
  fireEvent.click(button('[data-forge-write]'));
  await waitFor(() => expect(h3Calls()).toHaveLength(2));
  expect(h3Calls()[1].body.output_canvas).toEqual({ width: 832, height: 1248 });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Ratio width' }), { target: { value: '0' } });
  expect(button('[data-forge-write]').disabled).toBe(true); expect(button('[data-forge-send]').disabled).toBe(true);
  expect(screen.getByText(/This ratio or canvas is invalid/)).toBeTruthy();
});

it.each([
  ['2:3 Portrait', '2:3', 'Resolved canvas: 832 × 1216'],
  ['stale aspect', 'stale aspect', null],
])('H3 preserves the saved aspect %s and discloses unknown values instead of substituting N/A', async (saved, selected, label) => {
  localStorage.setItem('deas.pref.forge.h3.aspect', JSON.stringify(saved));
  render(view(vi.fn())); await waitFor(() => expect(aspect().value).toBe(selected));
  if (label) { await ready(); expect(screen.getByText(label)).toBeTruthy(); }
  else { expect(screen.getByText(/This saved ratio is unknown/)).toBeTruthy(); expect(button('[data-forge-write]').disabled).toBe(true); }
  expect(h3Calls()).toEqual([]);
});

it('legacy node-pack writers expose their unsupported canvas contract and keep their existing text-only fields', async () => {
  localStorage.setItem('deas.pref.forge.target', JSON.stringify('Wan 2.2'));
  const send = vi.fn(); render(view(send)); await ready();
  expect(document.querySelector('[data-forge-aspect]')).toBeNull();
  expect(screen.getByText(/This writer has no supported canvas contract/)).toBeTruthy();
  fireEvent.click(button('[data-forge-write]'));
  await waitFor(() => expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe('Legacy prompt result'));
  const call = vi.mocked(invoke).mock.calls.find(([command, args]) => command === 'native_forge' && (args as { route?: string })?.route === 'write');
  expect((call![1] as { body: unknown }).body).toEqual({ model: 'ollama:qwen', write_for: 'Wan 2.2', idea: 'a scene at dusk', detail: 5, creativity: 5, images: [] });
  fireEvent.click(button('[data-forge-send]')); expect(send.mock.calls).toEqual([['Legacy prompt result', '']]);
});

it('a completed H3 result loses canvas Send across A -> B -> A but explicitly edited text-only Send stays usable', async () => {
  const send = vi.fn(), renderView = render(view(send)); await ready(); chooseAspect('auto'); await write();
  renderView.rerender(view(send, { ...baseContext, key: 'studio-B', effective: { width: 704, height: 1408 } }));
  expect(button('[data-forge-send]').disabled).toBe(true); expect(document.querySelector('[data-forge-stale]')).not.toBeNull();
  fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: 'Retained edited text' } });
  fireEvent.click(button('[data-forge-send-text-only]')); expect(send.mock.calls).toEqual([['Retained edited text', '']]);
  renderView.rerender(view(send)); expect(button('[data-forge-send]').disabled).toBe(true);
  expect(screen.getByText('Written for: 1024 × 1024')).toBeTruthy();
  expect(h3Calls()).toHaveLength(1);
});

it.each([
  ['first Write', 'edit'], ['first Write', 'clear'],
  ['regeneration', 'edit'], ['regeneration', 'clear'],
] as const)('an H3 %s preserves a pending manual %s without publishing its late result or retaining request ownership', async (requestKind, change) => {
  const pending = deferred<H3Result>(), next = deferred<H3Result>(), send = vi.fn();
  const base = vi.mocked(invoke).getMockImplementation()!;
  render(view(send)); await ready(); chooseAspect('3:2');
  if (requestKind === 'regeneration') {
    await write();
    chooseAspect('9:16');
    expect(screen.getByText('Written for: 1216 × 832')).toBeTruthy();
  } else {
    fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: 'An unsent draft' } });
  }
  let pendingCalls = 0;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge' && (args as { route?: string })?.route === 'h3' ? (++pendingCalls === 1 ? pending.promise : next.promise) : base(command, args));
  fireEvent.click(button('[data-forge-write]'));
  expect(button('[data-forge-write]').disabled).toBe(true);
  const manualText = change === 'edit' ? 'Newer manual result text' : '';
  fireEvent.change(document.querySelector('[data-forge-result]')!, { target: { value: manualText } });
  expect(button('[data-forge-write]').disabled).toBe(true);
  await act(async () => { pending.resolve({ simple_prompt: 'Late model response', warnings: ['Late model warning'] }); });
  expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe(manualText);
  expect(screen.queryByText('Late model warning')).toBeNull();
  expect(button('[data-forge-write]').disabled).toBe(false);
  expect(button('[data-forge-send]').disabled).toBe(true);
  if (requestKind === 'regeneration') expect(screen.getByText('Written for: 1216 × 832')).toBeTruthy();
  else expect(document.querySelector('[data-forge-result-canvas]')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  if (change === 'edit') {
    fireEvent.click(button('[data-forge-send-text-only]'));
    expect(send.mock.calls).toEqual([[manualText, '']]);
  }
  // Owning cleanup must release both the rendered busy state and admission token.
  fireEvent.click(button('[data-forge-write]'));
  await waitFor(() => expect(pendingCalls).toBe(2));
  expect(button('[data-forge-write]').disabled).toBe(true);
  await act(async () => { next.resolve({ simple_prompt: 'Fresh replacement', warnings: [] }); });
  expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe('Fresh replacement');
  expect(button('[data-forge-write]').disabled).toBe(false);
  expect(button('[data-forge-send]').disabled).toBe(false);
});

it.each(['success', 'error'])('a stale H3 %s after changing context cannot replace a newer result or clear its pending Write', async outcome => {
  const a = deferred<H3Result>(), b = deferred<H3Result>(), send = vi.fn(); let calls = 0;
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge' && (args as { route?: string })?.route === 'h3' ? (++calls === 1 ? a.promise : b.promise) : base(command, args));
  const renderView = render(view(send)); await ready(); chooseAspect('auto'); fireEvent.click(button('[data-forge-write]'));
  renderView.rerender(view(send, { ...baseContext, key: 'studio-B', effective: { width: 704, height: 1408 } }));
  expect(button('[data-forge-write]').disabled).toBe(false); fireEvent.click(button('[data-forge-write]'));
  await act(async () => { if (outcome === 'success') a.resolve({ simple_prompt: 'Old A', warnings: ['old warning'] }); else a.reject(Error('Old A error')); });
  expect(button('[data-forge-write]').disabled).toBe(true);
  expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe(''); expect(screen.queryByText('old warning')).toBeNull(); expect(screen.queryByText('Old A error')).toBeNull();
  await act(async () => { b.resolve({ simple_prompt: 'Current B', warnings: [] }); });
  fireEvent.click(button('[data-forge-send]'));
  expect(send).toHaveBeenCalledWith('Current B', '', { canvas: { width: 704, height: 1408 }, contextKey: 'studio-B' });
});

it('a pending H3 A reply stays discarded after the context changes A -> B -> A', async () => {
  const pending = deferred<H3Result>(), send = vi.fn(), base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge' && (args as { route?: string })?.route === 'h3' ? pending.promise : base(command, args));
  const renderView = render(view(send)); await ready(); chooseAspect('auto'); fireEvent.click(button('[data-forge-write]'));
  renderView.rerender(view(send, { ...baseContext, key: 'studio-B' })); renderView.rerender(view(send));
  await act(async () => { pending.resolve({ simple_prompt: 'Obsolete A', warnings: [] }); });
  expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe('');
  expect(button('[data-forge-write]').disabled).toBe(false); expect(button('[data-forge-send]').disabled).toBe(true);
  expect(document.querySelector('[data-forge-discarded]')).not.toBeNull(); expect(send).not.toHaveBeenCalled();
});

it.each(['endpoint', 'root', 'model', 'mode', 'aspect'] as const)('a changed %s invalidates completed H3 canvas Send', async change => {
  const send = vi.fn(), renderView = render(view(send)); await ready(); chooseAspect('3:2'); await write();
  if (change === 'endpoint') renderView.rerender(view(send, baseContext, { endpoint: 'http://127.0.0.1:8188/other/' }));
  if (change === 'root') renderView.rerender(view(send, baseContext, { root: '/other-env' }));
  if (change === 'model') fireEvent.change(screen.getByRole('combobox', { name: 'LLM model' }), { target: { value: 'ollama:other' } });
  if (change === 'mode') fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'REF2VA' } });
  if (change === 'aspect') chooseAspect('9:16');
  expect(button('[data-forge-send]').disabled).toBe(true); fireEvent.click(button('[data-forge-send]')); expect(send).not.toHaveBeenCalled();
  expect(document.querySelector('[data-forge-send-text-only]')).not.toBeNull();
});

it('an incompatible current Studio mode blocks H3 canvas handoff while preserving explicit text-only Send', async () => {
  const send = vi.fn(); render(view(send, { ...baseContext, acceptsCanvas: () => false })); await ready(); chooseAspect('3:2'); await write();
  expect(button('[data-forge-send]').disabled).toBe(true); expect(document.querySelector('[data-forge-handoff-blocked]')).not.toBeNull();
  fireEvent.click(button('[data-forge-send-text-only]')); expect(send.mock.calls).toEqual([['H3 canvas result', '']]);
});

it('unmounting H3 invalidates its pending response and a later mount starts with a fresh result', async () => {
  const pending = deferred<H3Result>(), send = vi.fn(); const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge' && (args as { route?: string })?.route === 'h3' ? pending.promise : base(command, args));
  const renderView = render(view(send)); await ready(); fireEvent.click(button('[data-forge-write]')); renderView.unmount();
  await act(async () => { pending.resolve({ simple_prompt: 'Unmounted result', warnings: ['stale warning'] }); });
  render(view(send)); await ready();
  expect((document.querySelector('[data-forge-result]') as HTMLTextAreaElement).value).toBe(''); expect(screen.queryByText('stale warning')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
