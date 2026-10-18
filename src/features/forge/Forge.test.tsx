import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ForgeButton } from './ForgeButton';
import { PromptForge } from './PromptForge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), convertFileSrc: (p: string) => p }));
const models = { models: [{ id: 'ollama:qwen', label: 'qwen' }], errors: {}, creativity: ['literal', 'precise', 'faithful', 'measured', 'balanced', 'loose', 'inventive', 'creative', 'daring', 'wild'], shot_counts: ['Auto', 1, 2], default_shots: 'Auto', durations: [5, 8] };
const forgeCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'native_forge').map(([, a]) => a as { route: string; body: Record<string, unknown> });
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { route } = args as { route: string };
    if (command === 'native_forge' && route === 'models') return models;
    if (command === 'native_forge' && route === 'write') return { prompt: '1girl, rain', saw_images: 0 };
    if (command === 'native_forge' && route === 'h3') return { simple_prompt: 'H3 structured prompt', warnings: ['check cut'] };
    if (command === 'native_media_list') return { path: '/env/input', parent: null, truncated: false, entries: [{ name: 'a.png', path: '/env/input/a.png', kind: 'file', symlink: false, media: 'image', size: 1, modified: 1 }] };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

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
  vi.mocked(invoke).mockResolvedValueOnce({ ...models, models: [{ id: 'ollama:new', label: 'new backend' }] });
  rerender(view(endpoint, root));
  await screen.findByRole('option', { name: 'new backend' });
  expect(forgeCalls()).toHaveLength(2);
  expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(['native_forge', expect.objectContaining({ baseUrl: endpoint, root, route: 'models' })]);
  expect((screen.getByRole('combobox', { name: 'LLM model' }) as HTMLSelectElement).value).toBe('ollama:new');
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
