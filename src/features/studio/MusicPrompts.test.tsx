import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { MusicPrompts, musicDialects } from './MusicPrompts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), convertFileSrc: (p: string) => p }));
vi.mock('../../lib/promptTools', () => ({ usePromptTools: () => ({ spellcheck: false, language: 'en-US', autocomplete: false }), DICTIONARY_EVENT: 'deas:spellcheck-dictionary', spellcheckWords: vi.fn(async () => []), spellcheckSuggest: vi.fn(async () => []) }));
const models = { models: [{ id: 'ollama:qwen', label: 'qwen' }], errors: {}, creativity: ['balanced'], shot_counts: ['Auto'], default_shots: 'Auto', durations: [5] };
const writes = () => vi.mocked(invoke).mock.calls.filter(([c, a]) => c === 'native_forge' && (a as { route: string }).route === 'write').map(([, a]) => (a as { body: Record<string, unknown> }).body);
let resolveWrite: ((v: { prompt: string; saw_images: number }) => void) | null = null;
beforeEach(() => {
  localStorage.setItem('deas.locale.v1', 'en');
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { route } = (args ?? {}) as { route?: string };
    if (command === 'native_llm_read') return { provider: 'ollama', baseUrl: 'http://localhost:11434' };
    if (command === 'native_llm_models') return { models: [{ provider: 'ollama', id: 'qwen', name: 'qwen' }], warnings: [] };
    if (command === 'native_forge' && route === 'models') return models;
    if (command === 'native_forge' && route === 'write') return new Promise(resolve => { resolveWrite = resolve; });
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); resolveWrite = null; });

function Harness({ onStyle, onLyrics }: { onStyle?: (v: string) => void; onLyrics?: (v: string) => void }) {
  const [style, setStyle] = useState('indie pop');
  const [lyrics, setLyrics] = useState('[Verse]\nhello');
  return <I18nProvider><MusicPrompts endpoint="http://127.0.0.1:8188" root="/env" style={style} lyrics={lyrics}
    onStyle={v => { setStyle(v); onStyle?.(v); }} onLyrics={v => { setLyrics(v); onLyrics?.(v); }}
    actions={(field, value, set) => <button type="button" data-clear={field} disabled={!value} onClick={() => set('')}>clear {field}</button>}/>
    <output data-style>{style}</output><output data-lyrics>{lyrics}</output></I18nProvider>;
}
const field = (name: 'Style' | 'Lyrics') => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;

it('renders two independent editors without a negative prompt', () => {
  const onStyle = vi.fn(); const onLyrics = vi.fn();
  render(<Harness onStyle={onStyle} onLyrics={onLyrics}/>);
  expect(field('Style').value).toBe('indie pop');
  expect(field('Lyrics').value).toBe('[Verse]\nhello');
  expect(screen.queryByRole('textbox', { name: /negative/i })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Prompt Forge' })).toHaveLength(2);
  fireEvent.change(field('Lyrics'), { target: { value: '[Chorus]\nla la' } });
  expect(onLyrics).toHaveBeenCalledWith('[Chorus]\nla la');
  expect(onStyle).not.toHaveBeenCalled();
  expect(field('Style').value).toBe('indie pop');
  fireEvent.click(screen.getByRole('button', { name: 'clear style' }));
  expect(onStyle).toHaveBeenCalledWith('');
  expect(document.querySelector('[data-lyrics]')!.textContent).toBe('[Chorus]\nla la');
});

it('expands either field in the overlay with the matching title and field-specific writer', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: 'Expand Lyrics into a floating editor' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.getAttribute('aria-label')).toBe('Lyrics');
  expect(within(dialog).getByRole('button', { name: 'Prompt Forge' })).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'edited in overlay' } });
  expect(document.querySelector('[data-lyrics]')!.textContent).toBe('edited in overlay');
  expect(document.querySelector('[data-style]')!.textContent).toBe('indie pop');
});

it('each hammer writes with its exact YuE2 dialect and applies only to its own field', async () => {
  render(<Harness/>);
  expect(musicDialects).toEqual({ style: 'YuE2 Song Style', lyrics: 'YuE2 Lyrics' });
  const lyricsField = document.querySelector('[data-music-field="lyrics"]')!;
  fireEvent.click(within(lyricsField as HTMLElement).getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await act(async () => { await Promise.resolve(); });
  expect(writes()).toEqual([expect.objectContaining({ write_for: 'YuE2 Lyrics', idea: '[Verse]\nhello', images: [] })]);
  await act(async () => { resolveWrite!({ prompt: '[Verse]\nwritten lyrics', saw_images: 0 }); });
  fireEvent.click(await screen.findByRole('button', { name: 'Use new prompt' }));
  expect(document.querySelector('[data-lyrics]')!.textContent).toBe('[Verse]\nwritten lyrics');
  expect(document.querySelector('[data-style]')!.textContent).toBe('indie pop');
});

it('a pending write cannot reach the fields after the music editors unmount', async () => {
  const onLyrics = vi.fn();
  const view = render(<Harness onLyrics={onLyrics}/>);
  const lyricsField = document.querySelector('[data-music-field="lyrics"]')!;
  fireEvent.click(within(lyricsField as HTMLElement).getByRole('button', { name: 'Prompt Forge' }));
  await screen.findByRole('option', { name: 'qwen' });
  fireEvent.click(screen.getByRole('button', { name: 'Write' }));
  await act(async () => { await Promise.resolve(); });
  expect(writes()).toHaveLength(1);
  view.unmount(); // pipeline switched away: the writer panel and its result are gone
  await act(async () => { resolveWrite!({ prompt: 'stale', saw_images: 0 }); });
  expect(onLyrics).not.toHaveBeenCalled();
  expect(document.querySelector('[data-forge-apply]')).toBeNull();
});
