import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bundledCatalog, I18nProvider } from '../../i18n/I18nProvider';
import { ForgeButton, type H3Context } from './ForgeButton';
import { PromptForge } from './PromptForge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), convertFileSrc: (p: string) => p }));
const models = { models: [{ id: 'ollama:qwen', label: 'qwen' }], errors: {}, creativity: ['literal', 'precise', 'faithful', 'measured', 'balanced', 'loose', 'inventive', 'creative', 'daring', 'wild'], shot_counts: ['Auto', 1, 2], default_shots: 'Auto', durations: [5, 8] };
const forgeCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'native_forge').map(([, a]) => a as { route: string; body: Record<string, unknown> });
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_llm_read') return { provider: 'ollama', baseUrl: 'http://localhost:11434' };
    if (command === 'native_media_star_status') return { starred: false, unavailable: null };
    const { route } = args as { route: string };
    if (command === 'native_forge' && route === 'models') return models;
    if (command === 'native_forge' && route === 'write') return { prompt: '1girl, rain', saw_images: 0 };
    if (command === 'native_forge' && route === 'h3') return { simple_prompt: 'H3 structured prompt', warnings: ['check cut'] };
    if (command === 'native_media_list') return { path: '/env/input', parent: null, truncated: false, entries: [{ name: 'a.png', path: '/env/input/a.png', kind: 'file', symlink: false, media: 'image', size: 1, modified: 1 }] };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const continuityRun: H3Context & { continuity: NonNullable<H3Context['continuity']> } = {
  mode: 'T2VA', duration: 5, canvas: { width: 1024, height: 576 }, references: [], easy: false,
  continuity: { source_kind: 'checkpoint' as const, session: 'session-a', clip_id: 'clip-a', overlap_frames: 22 as const, current_prompt: 'previous action', use_references: false as const },
};

it.each(['endpoint', 'root', 'source', 'session', 'overlap', 'current_prompt', 'duration', 'canvas', 'model'])('checkpoint Forge draft/history become stale after changing %s', async change => {
  const view = (run = continuityRun, endpoint = 'http://127.0.0.1:8188', root = '/env') => <I18nProvider><ForgeButton endpoint={endpoint} root={root} dialect="MiniMax H3" value="turn left" onApply={vi.fn()} h3={run}/></I18nProvider>;
  const { rerender } = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await screen.findByRole('textbox', { name: 'Result' });
  const run = { ...continuityRun, continuity: { ...continuityRun.continuity } };
  if (change === 'source') run.continuity.clip_id = 'clip-b';
  if (change === 'session') run.continuity.session = 'session-b';
  if (change === 'overlap') run.continuity.overlap_frames = 39;
  if (change === 'current_prompt') run.continuity.current_prompt = 'edited action';
  if (change === 'duration') run.duration = 8;
  if (change === 'canvas') run.canvas = { width: 576, height: 1024 };
  if (change === 'model') {
    const base = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((c, a) => c === 'native_forge' && (a as { route: string }).route === 'models' ? Promise.resolve({ ...models, models: [{ id: 'other', label: 'other' }] }) : base(c, a));
    act(() => window.dispatchEvent(new Event('deas:llm-changed')));
    await screen.findByRole('option', { name: 'other' });
  } else {
    rerender(view(run, change === 'endpoint' ? 'http://127.0.0.1:8288' : undefined, change === 'root' ? '/other' : undefined));
    await screen.findByRole('option', { name: 'qwen' });
  }
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Draft 1 ⚠' }));
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['h3', 'write'])('Forge %s reports only actual busy transitions despite callback rerenders', async route => {
  let resolve!: (value: unknown) => void;
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c, a) => c === 'native_forge' && (a as { route: string }).route === route ? new Promise(r => { resolve = r; }) as ReturnType<typeof invoke> : base(c, a));
  const changes = vi.fn();
  const view = () => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="turn left" onApply={vi.fn()} h3={route === 'h3' ? continuityRun : undefined} onBusyChange={busy => changes(busy)}/></I18nProvider>;
  const { rerender, unmount } = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  expect(changes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  expect(changes.mock.calls).toEqual([[true]]);
  rerender(view());
  fireEvent.change(document.querySelector('[data-forge-brief]')!, { target: { value: 'more action' } });
  expect(changes.mock.calls).toEqual([[true]]);
  await act(async () => resolve(route === 'h3' ? { simple_prompt: 'draft', warnings: [] } : { prompt: 'draft', saw_images: 0 }));
  expect(changes.mock.calls).toEqual([[true], [false]]);
  unmount();
  expect(changes.mock.calls).toEqual([[true], [false]]);
  expect(forgeCalls().filter(c => c.route === 'cancel')).toHaveLength(0);
});

it.each(['cancel', 'unmount', 'failure'])('checkpoint Forge ends busy on %s and ignores late owned results', async outcome => {
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c, a) => {
    const route = (a as { route: string }).route;
    if (c === 'native_forge' && route === 'h3') return new Promise((yes, no) => { resolve = yes; reject = no; }) as ReturnType<typeof invoke>;
    if (c === 'native_forge' && route === 'cancel') return Promise.resolve({ cancelled: true });
    return base(c, a);
  });
  const changes = vi.fn(), apply = vi.fn();
  const view = (endpoint = 'http://127.0.0.1:8188', root = '/env') => <I18nProvider><ForgeButton endpoint={endpoint} root={root} dialect="MiniMax H3" value="turn left" onApply={apply} h3={continuityRun} onBusyChange={changes}/></I18nProvider>;
  const { unmount, rerender } = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  const request_id = forgeCalls().find(c => c.route === 'h3')!.body.request_id;
  if (outcome === 'unmount') { rerender(view('http://127.0.0.1:8288', '/other')); unmount(); }
  else if (outcome === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  else await act(async () => reject(new Error('write failed')));
  expect(changes.mock.calls).toEqual([[true], [false]]);
  if (outcome !== 'failure') {
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_forge', { baseUrl: 'http://127.0.0.1:8188', root: '/env', route: 'cancel', body: { request_id } });
    await act(async () => resolve({ simple_prompt: 'late', warnings: [] }));
    expect(screen.queryByRole('textbox', { name: 'Result' })).toBeNull();
  }
  expect(changes.mock.calls).toEqual([[true], [false]]);
  expect(apply).not.toHaveBeenCalled();
  unmount();
  expect(forgeCalls().filter(c => c.route === 'cancel')).toHaveLength(outcome === 'failure' ? 0 : 1);
});

it('continuity uses the next-action locale label and consumes Escape inside its open popover', async () => {
  const outerEscape = vi.fn();
  const catalog = { ...bundledCatalog, dictionaries: { ...bundledCatalog.dictionaries, en: { ...bundledCatalog.dictionaries.en, 'forge.nextAction': 'Next action fixture' } } };
  render(<I18nProvider catalog={catalog}><div onKeyDown={outerEscape}><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="turn left" onApply={vi.fn()} h3={continuityRun}/></div></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  const brief = screen.getByRole('textbox', { name: 'Next action fixture' });
  expect(fireEvent.keyDown(brief, { key: 'Escape', cancelable: true })).toBe(false);
  expect(outerEscape).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('checkpoint Forge displays bounded source-evidence warnings and clears them on a new Write', async () => {
  const base = vi.mocked(invoke).getMockImplementation()!;
  let writes = 0;
  vi.mocked(invoke).mockImplementation((c, a) => c === 'native_forge' && (a as { route: string }).route === 'h3'
    ? ++writes === 1 ? Promise.resolve({ simple_prompt: 'draft', warnings: [null, 17, 'Tail frames unavailable; source history is text-only', 'x'.repeat(3000), ...Array.from({ length: 10 }, (_, i) => `warning-${i}`)] }) : new Promise(() => {}) as ReturnType<typeof invoke>
    : base(c, a));
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="turn left" onApply={vi.fn()} h3={continuityRun}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await screen.findByRole('textbox', { name: 'Result' });
  expect(screen.getByText('Tail frames unavailable; source history is text-only').className).toBe('forge-warning');
  const warnings = document.querySelectorAll('p.forge-warning');
  expect(warnings).toHaveLength(8);
  expect(warnings[1].textContent).toHaveLength(2048);
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  expect(document.querySelectorAll('p.forge-warning')).toHaveLength(0);
});

it('checkpoint Forge forwards continuity through h3 and only applies on explicit review', async () => {
  const apply = vi.fn();
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="turn left" onApply={apply} h3={continuityRun}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await screen.findByRole('textbox', { name: 'Result' });
  expect(forgeCalls().find(c => c.route === 'h3')!.body).toMatchObject({ continuity: continuityRun.continuity, references: [], easy: false, see_pictures: false, brief: 'turn left' });
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply).toHaveBeenCalledExactlyOnceWith('H3 structured prompt');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(apply).toHaveBeenLastCalledWith('turn left');
});

it('hammer enhances the prompt in the model dialect, applies after review and undoes', async () => {
  const apply = vi.fn();
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="Anima" value="girl in rain" onApply={apply}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  expect((screen.getByRole('textbox', { name: 'Idea or prompt to enhance' }) as HTMLTextAreaElement).value).toBe('girl in rain');
  await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Result' })).toBeTruthy());
  expect(forgeCalls()[1]).toMatchObject({ route: 'write', body: { model: 'ollama:qwen', write_for: 'Anima', idea: 'girl in rain' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply).toHaveBeenLastCalledWith('1girl, rain');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(apply).toHaveBeenLastCalledWith('girl in rain');
});

it('hammer joins the resolved wildcard picks to the idea', async () => {
  const rules = { style: 'Booru', seed: 7, reroll: 3, token_budget: 200, auto_reroll: false, selection_state: { 'Art/Light/wildcards': { enabled: true, weight: 1.2 } } } as const;
  const build = vi.fn(async (_: unknown) => ({ positive: '(red light:1.2)', negative: '' }));
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c, a) => c === 'native_wildcard_build' ? build(a) : base(c, a));
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="Anima" value="girl in rain" onApply={vi.fn()} onWildcards={vi.fn()} wildcard={rules}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  fireEvent.click(screen.getByRole('button', { name: 'LLM · Prompt Forge' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Idea or prompt to enhance' }) as HTMLTextAreaElement).value).toBe('girl in rain, (red light:1.2)'));
  expect(build).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:8188', rules });
});

it('hammer sends the image-to-image source and says when the model could not see it', async () => {
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="Krea2" value="" image="DEAS_00001_.png [output]" onApply={vi.fn()}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await screen.findByText('This model cannot see pictures; it wrote from the text only.');
  expect(forgeCalls().at(-1)).toMatchObject({ route: 'write', body: { write_for: 'Krea2', idea: '', images: ['DEAS_00001_.png [output]'] } });
});

it('hammer is disabled for a model without a prompt dialect', () => {
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" value="" onApply={vi.fn()}/></I18nProvider>);
  expect((screen.getByRole('button', { name: 'Prompt Forge' }) as HTMLButtonElement).disabled).toBe(true);
  expect(forgeCalls()).toEqual([]);
});

it.each([
  ['http://127.0.0.1:8288', '/env'],
  ['http://127.0.0.1:8188', '/other'],
])('forge reloads models after switching endpoint/root to %s %s', async (endpoint, root) => {
  const view = (endpoint: string, root: string) => <I18nProvider><PromptForge endpoint={endpoint} root={root} onSend={vi.fn()}/></I18nProvider>;
  const { rerender } = render(view('http://127.0.0.1:8188', '/env'));
  await screen.findByRole('option', { name: 'qwen' });
  // Command-specific: a late media thumbnail call must not consume the new model list.
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'native_forge' ? { ...models, models: [{ id: 'ollama:new', label: 'new backend' }] } : base(command, args));
  rerender(view(endpoint, root));
  await screen.findByRole('option', { name: 'new backend' });
  expect(forgeCalls()).toHaveLength(2);
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'native_forge').at(-1)).toEqual(['native_forge', expect.objectContaining({ baseUrl: endpoint, root, route: 'models' })]);
  expect((screen.getByRole('combobox', { name: 'LLM model' }) as HTMLSelectElement).value).toBe('ollama:new');
});

it('forge and hammer reload models after the LLM backend setting changes', async () => {
  render(<I18nProvider><PromptForge endpoint="http://127.0.0.1:8188" root="/env" onSend={vi.fn()}/><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="Anima" value="" onApply={vi.fn()}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await waitFor(() => expect(screen.getAllByRole('option', { name: 'qwen' })).toHaveLength(2));
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'native_forge' ? { ...models, models: [{ id: 'openai:new', label: 'new server' }] } : base(command, args));
  act(() => { window.dispatchEvent(new Event('deas:llm-changed')); });
  await waitFor(() => expect(screen.getAllByRole('option', { name: 'new server' })).toHaveLength(2));
  expect(forgeCalls()).toHaveLength(4);
});

it('reloads models when the backend changes with the hammer open', async () => {
  const view = (endpoint: string) => <I18nProvider><ForgeButton endpoint={endpoint} root="/env" dialect="Anima" value="idea" onApply={vi.fn()}/></I18nProvider>;
  const { rerender } = render(view('http://127.0.0.1:8188'));
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  rerender(view('http://127.0.0.1:8288'));
  await screen.findByRole('option', { name: 'qwen' });
  expect(forgeCalls()).toHaveLength(2);
});

it.each([
  ['success', 'http://127.0.0.1:8288', '/env'],
  ['error', 'http://127.0.0.1:8288', '/env'],
  ['success', 'http://127.0.0.1:8188', '/other'],
  ['error', 'http://127.0.0.1:8188', '/other'],
])('ignores a late model %s after switching to %s %s', async (outcome, endpoint, root) => {
  let resolve!: (value: typeof models) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<typeof models>((yes, no) => { resolve = yes; reject = no; });
  const original = vi.mocked(invoke).getMockImplementation()!;
  let first = true;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (first && command === 'native_forge' && (args as { route: string }).route === 'models') {
      first = false;
      return pending as ReturnType<typeof invoke>;
    }
    return original(command, args);
  });
  const view = (endpoint: string, root: string) => <I18nProvider><PromptForge endpoint={endpoint} root={root} onSend={vi.fn()}/></I18nProvider>;
  const { rerender } = render(view('http://127.0.0.1:8188', '/env'));
  await waitFor(() => expect(first).toBe(false));
  rerender(view(endpoint, root));
  await screen.findByRole('option', { name: 'qwen' });
  await act(async () => {
    if (outcome === 'success') resolve({ ...models, models: [{ id: 'ollama:old', label: 'old backend' }] });
    else reject(new Error('old backend failed'));
  });
  expect(screen.queryByRole('option', { name: 'old backend' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('combobox', { name: 'LLM model' }) as HTMLSelectElement).value).toBe('ollama:qwen');
  expect(forgeCalls()).toHaveLength(2);
});

it('forge tab writes H3 REF2VA from labelled input pictures and sends the result to Generate', async () => {
  const send = vi.fn();
  render(<I18nProvider><PromptForge endpoint="http://127.0.0.1:8188" root="/env" inputDir="/env/input" onSend={send}/></I18nProvider>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Write for' }), { target: { value: 'MiniMax H3' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'REF2VA' } });
  fireEvent.click(await screen.findByText('a.png'));
  fireEvent.change(screen.getByRole('combobox', { name: 'a.png' }), { target: { value: 'place' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Idea or prompt to enhance' }), { target: { value: 'Character 1 walks in' } });
  await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await screen.findByText('check cut');
  expect(forgeCalls().at(-1)).toMatchObject({ route: 'h3', body: { mode: 'REF2VA', creativity: 'balanced', easy: true, references: [{ kind: 'image', role: 'subject', path: 'a.png', easy_role: 'place' }] } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Generate' }));
  expect(send).toHaveBeenCalledWith('H3 structured prompt', '');
});

it('maps a missing node-pack route (404, or 405 from ComfyUI static) to the upgrade hint', async () => {
  const { forgeError } = await import('../../lib/forge');
  expect(forgeError(new Error('405'))).toBe('forge.outdated');
  expect(forgeError('404 Not Found')).toBe('forge.outdated');
  expect(forgeError('4050 x')).toBe('4050 x');
  expect(forgeError('500 boom')).toBe('500 boom');
});

it('H3 hammer is the Director Forge for the run: context, shots, detail/creativity, cancel, drafts that go stale with the run', async () => {
  const apply = vi.fn();
  const run = { mode: 'REF2VA', duration: 5, canvas: { width: 1024, height: 576 }, references: [{ kind: 'image' as const, path: 'a.png', role: 'subject', subject_group: '' }, { kind: 'video' as const, role: 'motion', stream: 'both' as const }], easy: false };
  const base = vi.mocked(invoke).getMockImplementation()!;
  let release: (v: unknown) => void = () => {};
  let hold = false;
  vi.mocked(invoke).mockImplementation((c, a) => {
    const { route } = a as { route: string };
    if (c === 'native_forge' && route === 'cancel') return Promise.resolve({ cancelled: true });
    if (c === 'native_forge' && route === 'h3' && hold) return new Promise(r => { release = r; });
    return base(c, a);
  });
  const view = (h3: typeof run) => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a duel" onApply={apply} h3={h3}/></I18nProvider>;
  const { rerender } = render(view(run));
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
  expect(document.querySelector('[data-forge-run]')!.textContent).toBe('REF2VA · 5 s · 1024×576 · 2 references');
  fireEvent.change(document.querySelector('[data-forge-shots]')!, { target: { value: '2' } });
  fireEvent.change(document.querySelector('[data-forge-shot="2"]')!, { target: { value: 'close-up' } });
  fireEvent.change(screen.getByRole('slider', { name: 'Creativity 5' }), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Result' })).toBeTruthy());
  const body = forgeCalls().find(c => c.route === 'h3')!.body;
  expect(body).toMatchObject({ model: 'ollama:qwen', mode: 'REF2VA', brief: 'a duel', duration: 5, shots: 2, shot_briefs: ['', 'close-up'], detail: 5, creativity: 'daring', references: run.references, easy: false, output_canvas: { width: 1024, height: 576 } });
  expect(body).not.toHaveProperty('continuity');
  expect(typeof body.request_id).toBe('string');
  // Another canvas: the draft no longer fits, Apply waits for a new draft; the history marks it.
  rerender(view({ ...run, canvas: { width: 576, height: 1024 } }));
  expect(screen.getByRole('status').textContent).toContain('written for other settings');
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Draft 1 ⚠' })).toBeTruthy();
  // Regenerate while the LLM runs can be cancelled with the same request id.
  hold = true;
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  const pending = forgeCalls().filter(c => c.route === 'h3').at(-1)!.body.request_id;
  expect(forgeCalls().at(-1)).toMatchObject({ route: 'cancel', body: { request_id: pending } });
  await act(async () => { release({ simple_prompt: 'late', warnings: [] }); });
  expect((screen.getByRole('textbox', { name: 'Result' }) as HTMLTextAreaElement).value).toBe('H3 structured prompt'); // a cancelled answer is dropped
  hold = false;
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Draft \d/ }).length).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply).toHaveBeenLastCalledWith('H3 structured prompt');
});

it('H3 hammer offers "see the pictures" only for labelled pictures and sends easy/see_pictures', async () => {
  const run = { mode: 'REF2VA', duration: 5, canvas: { width: 1024, height: 576 }, references: [{ kind: 'image' as const, path: 'a.png', role: 'subject', subject_group: 'A', easy_role: 'character-1' }], easy: true };
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a walk" onApply={vi.fn()} h3={run}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Let the model see the pictures (needs a vision model)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Result' })).toBeTruthy());
  expect(forgeCalls().find(c => c.route === 'h3')!.body).toMatchObject({ easy: true, see_pictures: true, references: run.references });
  cleanup();
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="" onApply={vi.fn()} h3={{ ...run, easy: false }}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it.each(['success', 'error', 'cancel error'])('cancelled H3 request A cannot disturb pending B after late A %s', async outcome => {
  const pending = () => {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const a = pending(), b = pending(), cancellation = pending();
  const base = vi.mocked(invoke).getMockImplementation()!;
  let writes = 0;
  vi.mocked(invoke).mockImplementation((c, args) => {
    const route = (args as { route: string }).route;
    if (c === 'native_forge' && route === 'h3') return (++writes === 1 ? a : b).promise as ReturnType<typeof invoke>;
    if (c === 'native_forge' && route === 'cancel') return cancellation.promise as ReturnType<typeof invoke>;
    return base(c, args);
  });
  const run = { mode: 'T2VA', duration: 5, canvas: { width: 64, height: 64 }, references: [], easy: false };
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a walk" onApply={vi.fn()} h3={run}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));

  await act(async () => {
    if (outcome === 'success') a.resolve({ simple_prompt: 'stale A', warnings: [] });
    else if (outcome === 'error') a.reject(new Error('stale A error'));
    else cancellation.reject(new Error('stale cancel error'));
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Result' })).toBeNull();
  await act(async () => { b.resolve({ simple_prompt: 'current B', warnings: [] }); });
  expect((screen.getByRole('textbox', { name: 'Result' }) as HTMLTextAreaElement).value).toBe('current B');
  expect(screen.getAllByRole('button', { name: /^Draft \d/ })).toHaveLength(1);
  // A's cancel failure must also stay stale after B has finished.
  await act(async () => { cancellation.reject(new Error('late cancel error')); });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reports a cancellation failure while the cancelled request still owns the UI', async () => {
  const base = vi.mocked(invoke).getMockImplementation()!;
  let reject!: (error: Error) => void;
  const cancellation = new Promise((_, no) => { reject = no; });
  vi.mocked(invoke).mockImplementation((c, args) => {
    const route = (args as { route: string }).route;
    if (c === 'native_forge' && route === 'h3') return new Promise(() => {}) as ReturnType<typeof invoke>;
    if (c === 'native_forge' && route === 'cancel') return cancellation as ReturnType<typeof invoke>;
    return base(c, args);
  });
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a walk" onApply={vi.fn()} h3={{ mode: 'T2VA', duration: 5, canvas: { width: 64, height: 64 }, references: [], easy: false }}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { reject(new Error('cancel failed')); });
  expect(screen.getByRole('alert').textContent).toBe('cancel failed');
  expect((screen.getByRole('button', { name: 'Write' }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(['REF2VA', 'I2VA', 'FL2VA', 'L2VA'].flatMap(mode => ['replace', 'reorder'].map(change => [mode, change])))('discards a %s Cast read after reference %s, including stale errors and cleanup during a new read', async (mode, change) => {
  const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c, args) => c === 'native_forge' && (args as { route: string }).route === 'cast'
    ? new Promise((resolve, reject) => { pending.push({ resolve, reject }); }) as ReturnType<typeof invoke> : base(c, args));
  const refs = [{ kind: 'image' as const, path: 'a.png', easy_role: 'character-1', who:[1] }, { kind: 'image' as const, path: 'b.png', easy_role: 'character-2', who:[2] }];
  const run = { mode, duration: 5, canvas: { width: 64, height: 64 }, references: refs, easy: mode === 'REF2VA' };
  const view = (references: typeof refs) => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a walk" onApply={vi.fn()} h3={{ ...run, references }}/></I18nProvider>;
  const { rerender } = render(view(refs));
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  const read = () => document.querySelector('[data-forge-read="1"]') as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText('Card of Character 1'), { target: { value: 'manual card' } });
  fireEvent.click(read());
  const changed = change === 'replace' ? [{ ...refs[0], path: 'new.png' }, refs[1]] : [...refs].reverse();
  rerender(view(changed));
  expect(read().disabled).toBe(false);
  fireEvent.click(read());
  await act(async () => { pending[0].resolve({ text: 'stale card' }); });
  expect((screen.getByLabelText('Card of Character 1') as HTMLTextAreaElement).value).toBe('manual card');
  expect(read().disabled).toBe(true); // the new read still owns the busy state
  rerender(view(refs));
  fireEvent.click(read());
  await act(async () => { pending[1].reject(new Error('stale read error')); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(read().disabled).toBe(true);
  await act(async () => { pending[2].resolve({ text: 'current card' }); });
  expect((screen.getByLabelText('Card of Character 1') as HTMLTextAreaElement).value).toBe('current card');
  expect(read().disabled).toBe(false);
});

it('H3 group cards deduplicate characters without changing reference order, support Read and exclude removed characters from Write', async () => {
 const refs = [{ kind: 'image' as const, path: 'pair.png', easy_role: 'group-21' }, { kind: 'image' as const, path: 'trio.png', easy_role: 'group-123' }];
 const base = vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation((c, a) => c === 'native_forge' && (a as { route: string }).route === 'cast' ? Promise.resolve({ text: 'adult woman, red coat' }) : base(c, a));
 const view = (references: typeof refs) => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a meeting" onApply={vi.fn()} h3={{ mode:'REF2VA', duration:5, canvas:{width:64,height:64}, references, easy:true }}/></I18nProvider>;
 const { rerender } = render(view(refs));
 fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
 await screen.findByRole('option', { name: 'qwen' });
 expect([...document.querySelectorAll('[data-forge-read]')].map(b => b.getAttribute('data-forge-read'))).toEqual(['1', '2', '3']);
 fireEvent.click(document.querySelector('[data-forge-read="2"]')!);
 await waitFor(() => expect((screen.getByLabelText('Card of Character 2') as HTMLTextAreaElement).value).toBe('adult woman, red coat'));
 expect(forgeCalls().find(c => c.route === 'cast')!.body).toMatchObject({ character:2, references:refs });
 fireEvent.change(screen.getByLabelText('Card of Character 3'), { target:{value:'no longer present'} });
 rerender(view([refs[0]]));
 expect(screen.queryByLabelText('Card of Character 3')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name:'Write' }));
 await screen.findByRole('textbox', { name:'Result' });
 expect(forgeCalls().find(c => c.route === 'h3')!.body.references).toEqual([refs[0]]);
 expect(forgeCalls().find(c => c.route === 'h3')!.body.cast).toEqual({2:'adult woman, red coat'});
});

it.each(['who','boxes'])('H3 explicit %s overrides the legacy label when choosing Cast cards',async source=>{
 render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="adults meet" onApply={vi.fn()} h3={{mode:'REF2VA',duration:5,canvas:{width:64,height:64},easy:true,references:[{kind:'image',easy_role:'character-1',...(source==='boxes'?{boxes:[{n:4,box:[0.1,0.1,0.4,0.8] as [number,number,number,number]},{n:2,box:[0.6,0.1,0.9,0.8] as [number,number,number,number]}]}:{picture_kinds:['character'],who:[4,2],who_axis:'z' as const})}]}}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 await screen.findByRole('option',{name:'qwen'});
 expect([...document.querySelectorAll('[data-forge-read]')].map(b=>b.getAttribute('data-forge-read'))).toEqual(['2','4']);
});

it.each(['I2VA', 'FL2VA', 'L2VA'])('H3 %s frame Cast uses explicit identities for Read/edit/Write without changing references', async mode => {
  const refs = [
    { kind:'image' as const, path:'first.png', role:'first', who:[9], who_axis:'z' as const, boxes:[{n:4,box:[0.1,0.1,0.4,0.8] as [number,number,number,number]}, {n:2,box:[0.6,0.1,0.9,0.8] as [number,number,number,number]}] },
    { kind:'image' as const, path:'last.png', role:'last', who:[3,2], boxes:[], who_axis:'y' as const },
    { kind:'image' as const, path:'unlabelled.png', easy_role:'character-1' },
    { kind:'image' as const, who:[5] },
    { kind:'image' as const, path:'', who:[6] },
    { kind:'video' as const, path:'motion.mp4', who:[7] },
    { kind:'audio' as const, path:'voice.wav', who:[8] },
    ...['place','style','pose'].map(easy_role => ({kind:'image' as const,path:`${easy_role}.png`,easy_role})),
  ];
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c,a) => c === 'native_forge' && (a as {route:string}).route === 'cast' ? Promise.resolve({text:'adult in a red coat'}) : base(c,a));
  const view = (easy=false, references=refs) => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="walk" onApply={vi.fn()} h3={{mode,duration:5,canvas:{width:64,height:64},references,easy}}/></I18nProvider>;
  const {rerender} = render(view());
  fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
  await screen.findByRole('option',{name:'qwen'});
  const keys = () => [...document.querySelectorAll('[data-forge-read]')].map(b => b.getAttribute('data-forge-read'));
  expect(keys()).toEqual(['2','3','4']);
  fireEvent.click(document.querySelector('[data-forge-read="2"]')!);
  await waitFor(() => expect((screen.getByLabelText('Card of Character 2') as HTMLTextAreaElement).value).toBe('adult in a red coat'));
  expect(forgeCalls().find(c => c.route === 'cast')!.body).toMatchObject({mode,character:2,references:refs,redo:false});
  fireEvent.change(screen.getByLabelText('Card of Character 4'),{target:{value:'  edited adult  '}});
  fireEvent.click(screen.getByRole('button',{name:'Write'}));
  await screen.findByRole('textbox',{name:'Result'});
  expect(forgeCalls().filter(c => c.route === 'h3').at(-1)!.body).toMatchObject({mode,references:refs,easy:false,cast:{2:'adult in a red coat',4:'edited adult'}});
  rerender(view(true));
  expect(keys()).toEqual(['2','3','4']);
  rerender(view(false,[refs[1]]));
  expect(keys()).toEqual(['2','3']);
  expect((screen.getByRole('button',{name:'Apply'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Regenerate'}));
  await waitFor(() => expect(forgeCalls().filter(c => c.route === 'h3')).toHaveLength(2));
  expect(forgeCalls().filter(c => c.route === 'h3').at(-1)!.body.cast).toEqual({2:'adult in a red coat'});
  rerender(view(false,refs.slice(2)));
  expect(document.querySelector('[data-forge-cast]')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Regenerate'}));
  await waitFor(() => expect(forgeCalls().filter(c => c.route === 'h3')).toHaveLength(3));
  expect(forgeCalls().filter(c => c.route === 'h3').at(-1)!.body).not.toHaveProperty('cast');
});

it('H3 REF2VA excludes pose takers and custom identities from numeric Cast while retaining scene and pose cards', async () => {
  const refs = [
    {kind:'image' as const,path:'person.png',easy_role:'character-2'},
    {kind:'image' as const,path:'pose.png',easy_role:'pose',picture_kinds:['pose','character'],who:[5],boxes:[{n:6,box:[0.1,0.1,0.9,0.9] as [number,number,number,number]}]},
    {kind:'image' as const,path:'custom.png',easy_role:'custom',picture_kinds:['character'],who:[7],boxes:[{n:8,box:[0.1,0.1,0.9,0.9] as [number,number,number,number]}]},
    {kind:'image' as const,path:'pose-kind.png',picture_kinds:['pose','character'],who:[9]},
    {kind:'image' as const,path:'custom-kind.png',picture_kinds:['custom','character'],who:[10]},
    {kind:'image' as const,path:'place.png',easy_role:'place'},
    {kind:'image' as const,path:'style.png',easy_role:'style'},
  ];
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="dance" onApply={vi.fn()} h3={{mode:'REF2VA',duration:5,canvas:{width:64,height:64},references:refs,easy:true}}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
  await screen.findByRole('option',{name:'qwen'});
  expect([...document.querySelectorAll('[data-forge-read]')].map(b => b.getAttribute('data-forge-read'))).toEqual(['2','place','style','pose:pose.png']);
});

it('H3 pose cards follow their picture across reorder and send its current picture number', async () => {
  const refs = [{ kind:'image' as const, path:'person.png', easy_role:'character-1' }, { kind:'image' as const, path:'pose.png', easy_role:'pose' }];
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c, a) => c === 'native_forge' && (a as {route:string}).route === 'cast' ? Promise.resolve({text:'arms raised'}) : base(c, a));
  const view = (references: typeof refs) => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a dance" onApply={vi.fn()} h3={{mode:'REF2VA',duration:5,canvas:{width:64,height:64},references,easy:true}}/></I18nProvider>;
  const { rerender } = render(view(refs));
  fireEvent.click(screen.getByRole('button', {name:'Prompt Forge'}));
  await screen.findByRole('option', {name:'qwen'});
  const card = await screen.findByRole('textbox', {name:'Card of Pose · Picture 2'});
  fireEvent.click(card.closest('label')!.querySelector('button')!);
  await waitFor(() => expect((card as HTMLTextAreaElement).value).toBe('arms raised'));
  expect(forgeCalls().find(c => c.route === 'cast')!.body).toMatchObject({subject:'pose@2',mode:'REF2VA',redo:false,references:refs});
  rerender(view([...refs].reverse()));
  expect((screen.getByRole('textbox', {name:'Card of Pose · Picture 1'}) as HTMLTextAreaElement).value).toBe('arms raised');
  fireEvent.click(screen.getByRole('button', {name:'Write'}));
  await screen.findByRole('textbox', {name:'Result'});
  expect(forgeCalls().filter(c => c.route === 'h3').at(-1)!.body.cast).toEqual({'pose@1':'arms raised'});
  rerender(view([refs[0]]));
  expect(screen.queryByRole('textbox', {name:/Card of Pose/})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'Regenerate'}));
  await waitFor(() => expect(forgeCalls().filter(c => c.route === 'h3')).toHaveLength(2));
  expect(forgeCalls().filter(c => c.route === 'h3').at(-1)!.body).not.toHaveProperty('cast');
});

it('H3 pose cards omit unreadable pictures and reject stale reads after reference changes', async () => {
  const refs = [{kind:'image' as const,path:'one.png',easy_role:'pose'}, {kind:'image' as const,easy_role:'pose'}, {kind:'image' as const,path:'two.png',easy_role:'pose'}];
  let resolve!: (value: unknown) => void;
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c,a) => c === 'native_forge' && (a as {route:string}).route === 'cast' ? new Promise(r => {resolve=r;}) as ReturnType<typeof invoke> : base(c,a));
  const view = (references: typeof refs, easy=true) => <I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="dance" onApply={vi.fn()} h3={{mode:'REF2VA',duration:5,canvas:{width:64,height:64},references,easy}}/></I18nProvider>;
  const {rerender} = render(view(refs));
  fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
  await screen.findByRole('option',{name:'qwen'});
  expect(screen.queryByRole('textbox',{name:'Card of Pose · Picture 2'})).toBeNull();
  const card = screen.getByRole('textbox',{name:'Card of Pose · Picture 3'});
  fireEvent.click(card.closest('label')!.querySelector('button')!);
  rerender(view([refs[2],refs[0]]));
  await act(async () => resolve({text:'stale stance'}));
  expect((screen.getByRole('textbox',{name:'Card of Pose · Picture 1'}) as HTMLTextAreaElement).value).toBe('');
  rerender(view(refs,false));
  expect(document.querySelector('[data-forge-cast]')).toBeNull();
});

it('H3 cast cards: one per labelled Character / place, Read fills a card, filled cards travel as cast', async () => {
  const refs = [{ kind: 'image' as const, path: 'b.png', role: 'subject', subject_group: 'B', easy_role: 'character-2' }, { kind: 'image' as const, path: 'a.png', role: 'subject', subject_group: 'A', easy_role: 'character-1' }, { kind: 'image' as const, path: 'p.png', role: 'subject', subject_group: '', easy_role: 'place' }];
  const run = { mode: 'REF2VA', duration: 5, canvas: { width: 64, height: 64 }, references: refs, easy: true };
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((c, a) => c === 'native_forge' && (a as { route: string }).route === 'cast' ? Promise.resolve({ text: 'tall woman, red coat' }) : base(c, a));
  render(<I18nProvider><ForgeButton endpoint="http://127.0.0.1:8188" root="/env" dialect="MiniMax H3" value="a duel" onApply={vi.fn()} h3={run}/></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Forge' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'qwen' })).toBeTruthy());
  expect([...document.querySelectorAll('[data-forge-read]')].map(b => b.getAttribute('data-forge-read'))).toEqual(['1', '2', 'place']);
  fireEvent.click(document.querySelector('[data-forge-read="1"]')!);
  await waitFor(() => expect((screen.getByLabelText('Card of Character 1') as HTMLTextAreaElement).value).toBe('tall woman, red coat'));
  expect(forgeCalls().find(c => c.route === 'cast')!.body).toMatchObject({ model: 'ollama:qwen', mode: 'REF2VA', character: 1, references: refs, brief: 'a duel', redo: false });
  fireEvent.change(screen.getByLabelText('Card of Place'), { target: { value: '  old  harbour ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Result' })).toBeTruthy());
  expect(forgeCalls().find(c => c.route === 'h3')!.body.cast).toEqual({ 1: 'tall woman, red coat', place: 'old  harbour' });
  expect([...document.querySelectorAll('[data-forge-read]')].map(b => b.textContent)).toEqual(['Read again', 'Read', 'Read again']); // filled cards are read again (`redo`)
});
