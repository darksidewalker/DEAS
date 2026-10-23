import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { Chat } from './Chat';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  convertFileSrc: (p: string) => p,
  Channel: class { onmessage: (e: unknown) => void = () => {}; },
}));

const ID = 'a0000000-0000-4000-8000-000000000001';
const old = { id: ID, title: 'how does LTX prompting work?', model: 'qwen', created: 1, updated: 2, messages: [
  { role: 'user', content: 'how does LTX prompting work?', pictures: 0, prompts: [], citations: [], tools: [], at: 1 },
  { role: 'assistant', content: 'One **flowing paragraph**:\n\n1. Shot\n2. Scene', pictures: 0, prompts: [], citations: [], tools: ['read_guide: ltx'], at: 2 },
] };
let settings = { search: 'off', searxngUrl: '' };
const sends = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'native_chat_send').map(([, a]) => (a as { request: Record<string, unknown> }).request);

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  settings = { search: 'off', searxngUrl: '' };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_llm_read') return { provider: 'openai', baseUrl: 'http://127.0.0.1:8099' };
    if (command === 'native_forge') return { models: [{ id: 'openai:qwen', label: 'qwen' }], errors: {}, creativity: [], shot_counts: ['Auto'], default_shots: 'Auto' };
    if (command === 'native_chat_list') return [{ id: ID, title: old.title, updated: 2, count: 2 }];
    if (command === 'native_chat_get') return old;
    if (command === 'native_chat_settings') return settings;
    if (command === 'native_chat_settings_write') { settings = a.settings; return settings; }
    if (command === 'native_chat_delete' || command === 'native_chat_rename') return undefined;
    if (command === 'native_chat_send') {
      const emit = (e: unknown) => a.onEvent.onmessage(e);
      const prompt = { target: 'illustrious', label: 'Illustrious XL', prompt: 'frieren, reading, under tree', negative: null };
      emit({ event: 'chat', id: ID, title: 't' });
      emit({ event: 'status', state: 'writing_prompt', detail: 'Illustrious XL' });
      emit({ event: 'prompt', prompt });
      emit({ event: 'text', text: 'Here it is.' });
      return { role: 'assistant', content: 'Here it is.\n\nIllustrious XL prompt, written by the Illustrious XL prompt writer:\n\nfrieren, reading, under tree', pictures: 0, prompts: [prompt], citations: [], tools: ['write_prompt: illustrious'], at: 3 };
    }
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('opens a saved conversation, streams a reply with a prompt card and sends that prompt to Generate', async () => {
  const onSend = vi.fn();
  localStorage.setItem('deas.pref.studio.run.positive', JSON.stringify('1girl, rain'));
  localStorage.setItem('deas.pref.studio.run.checkpoint', JSON.stringify('waiIllustrious.safetensors'));
  render(<I18nProvider><Chat endpoint="http://127.0.0.1:8188" root="/env" onSend={onSend}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: old.title }));
  await screen.findByText('flowing paragraph');
  expect(screen.getByText('read_guide: ltx')).toBeTruthy();
  // Search stays hidden while it is switched off.
  expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole('checkbox', { name: "Include what I'm working on" }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'write me an illustrious prompt: frieren reading' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
  await screen.findByText('Here it is.');
  expect(sends()[0]).toMatchObject({ id: ID, message: 'write me an illustrious prompt: frieren reading', model: 'qwen', pictures: [], search: false });
  expect(sends()[0].context).toContain('Studio positive prompt:\n1girl, rain');
  expect(sends()[0].context).toContain('Model / checkpoint: waiIllustrious.safetensors');
  // The prompt shows once, as a card, not again in the reply text.
  expect(screen.getAllByText('frieren, reading, under tree')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Send to Generate' }));
  expect(onSend).toHaveBeenCalledWith('frieren, reading, under tree', '');
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
});

it('web search is chosen in settings, then offered as a toggle; deleting asks once more', async () => {
  render(<I18nProvider><Chat endpoint="http://127.0.0.1:8188" root="/env" onSend={vi.fn()}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Web search' }));
  fireEvent.click(screen.getByRole('radio', { name: 'DuckDuckGo (nothing to install)' }));
  expect(screen.getByText(/the query leaves this PC/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_chat_settings_write', { root: '/env', settings: { search: 'duckduckgo', searxngUrl: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'latest illustrious checkpoints?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(sends()[0]).toMatchObject({ search: true, message: 'latest illustrious checkpoints?' }));
  expect(sends()[0].id).toBeUndefined();
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'native_chat_delete')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Delete?' }));
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_chat_delete', { root: '/env', id: ID }));
});
