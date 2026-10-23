import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { PromptForge } from './PromptForge';
import { applyGenerated, blankProject, exportLayout, forPrompt, resizeProject, type LayoutProject } from './LayoutStudio';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), convertFileSrc: (p: string) => p }));

const project: LayoutProject = { w: 1024, h: 768, caption: 'a camp', meta: 'illustration, anime', items: [
  { id: 'a', name: 'Frieren', label: 'object', caption: 'frieren sitting', text: '', color: '#52e0c4', x: 12, y: 84, w: 400, h: 500 },
  { id: 'b', name: 'Sign', label: 'text', caption: '', text: 'CAMP', color: '#bb9aff', x: 600, y: 0, w: 300, h: 100 },
] };

it('writes MOSS Layout JSON: centred yxyx boxes, the medium as a list, text only on text boxes', () => {
  expect(exportLayout(project)).toEqual({
    summary: { meta: ['illustration', 'anime'], canvas: 'single', caption: 'a camp' },
    items: [
      { label: 'object', caption: 'frieren sitting', bbox: [-300, -500, 200, -100] },
      { label: 'text', caption: '', bbox: [-384, 88, -284, 388], text: 'CAMP' },
    ],
    bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
  });
  expect(forPrompt(project).items[0]).toMatchObject({ name: 'Frieren', bbox: [-300, -500, 200, -100] });
});

it('a written layout with the same boxes changes only the words; different boxes replace them', () => {
  const same = JSON.stringify({ summary: { meta: ['poster'], caption: 'night' }, items: [
    { label: 'object', caption: 'Frieren by the fire', bbox: [-300, -500, 200, -100] },
    { label: 'text', caption: 'a wooden sign', text: 'CAMP', bbox: [-384, 88, -284, 388] },
  ] });
  const kept = applyGenerated(project, same);
  expect(kept.items.map(i => [i.id, i.name, i.caption])).toEqual([['a', 'Frieren', 'Frieren by the fire'], ['b', 'Sign', 'a wooden sign']]);
  expect([kept.caption, kept.meta]).toEqual(['night', 'poster']);
  const other = applyGenerated(project, JSON.stringify({ items: [{ label: 'object', caption: 'a small campfire burning', bbox: [0, 0, 100, 100] }] }));
  expect(other.items).toHaveLength(1);
  expect(other.items[0]).toMatchObject({ name: 'a small campfire burning', x: 512, y: 384, w: 100, h: 100 });
  expect(() => applyGenerated(project, 'not json')).toThrow();
});

it('a new canvas size scales the boxes with it', () => {
  const r = resizeProject(project, 512, 384);
  expect(r.items[0]).toMatchObject({ x: 6, y: 42, w: 200, h: 250 });
  expect(resizeProject(project, 1024, 768)).toBe(project);
});

const nativeTargets = { source: {}, creativity: ['balanced'], targets: [{ key: 'moss', label: 'MOSS', modes: ['Natural language', 'Layout JSON'], defaultMode: 'Natural language', optional: ['What changed', 'Negative prompt'], qualityPresets: [], styles: [], aspectRatios: ['N/A', '16:9 Wide'], hasNegative: true, tools: false, guidance: [], layoutCanvas: { 'N/A': [1024, 1024], '16:9 Wide': [1536, 864] }, layoutRewrite: true }] };
const writes = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'native_forge_write').map(([, a]) => (a as { request: Record<string, unknown> }).request);
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en'); localStorage.setItem('deas.pref.forge.target', JSON.stringify('MOSS'));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_llm_read') return { provider: 'openai', baseUrl: 'http://127.0.0.1:8099' };
    if (command === 'native_forge') return { models: [{ id: 'openai:qwen', label: 'qwen' }], errors: {}, creativity: ['balanced'], shot_counts: ['Auto'], default_shots: 'Auto', durations: [5] };
    if (command === 'native_forge_targets') return nativeTargets;
    if (command === 'native_forge_layout_rewrite') return 'a tighter fire';
    if (command === 'native_forge_write') {
      const r = (args as { request: { mode: string } }).request;
      return r.mode === 'Layout JSON'
        ? { segments: [{ label: 'Layout JSON', body: JSON.stringify({ summary: { meta: ['illustration'], caption: 'model summary' }, items: [{ label: 'object', caption: 'a campfire', bbox: [-100, -100, 100, 100] }] }) }, { label: 'Negative prompt', body: 'lowres' }], refused: false, prompt: '', negative: 'lowres', characters: [], tools: [], rounds: 0, warnings: [], fixes: [] }
        : { segments: [{ label: 'Enhanced prompt', body: 'Frieren by a campfire at night.' }], refused: false, prompt: 'Frieren by a campfire at night.', negative: null, characters: [], tools: [], rounds: 0, warnings: [], fixes: [] };
    }
    if (command === 'native_media_list') return { path: '', parent: null, entries: [], truncated: false };
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('MOSS Layout JSON: Generate prompt fills the Global prompt, Generate JSON lays out the boxes on the aspect canvas and keeps the Global prompt', async () => {
  render(<I18nProvider><PromptForge endpoint="http://127.0.0.1:8188" root="/env" onSend={vi.fn()}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open all' }));
  fireEvent.click(document.querySelector('[data-forge-tile="aspect:16:9 Wide"]')!);
  await waitFor(() => expect(screen.getByText(/1536 × 864/)).toBeTruthy());
  // The studio makes the pictures, tags and kept-verbatim sections redundant.
  expect(document.querySelector('[data-forge-fold="verbatim"]')).toBeNull();
  fireEvent.change(document.querySelector('[data-forge-brief]')!, { target: { value: 'frieren by a campfire' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate prompt' }));
  await waitFor(() => expect((document.querySelector('[data-layout-caption]') as HTMLTextAreaElement).value).toBe('Frieren by a campfire at night.'));
  expect(writes()[0]).toMatchObject({ mode: 'Natural language', brief: 'frieren by a campfire' });
  expect((writes()[0].controls as Record<string, unknown>).layout).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Generate JSON' }));
  await waitFor(() => expect(document.querySelectorAll('[data-layout-item]')).toHaveLength(1));
  expect(writes()[1]).toMatchObject({ mode: 'Layout JSON', brief: 'Frieren by a campfire at night.', controls: expect.objectContaining({ layout: { width: 1536, height: 864, items: [] } }) });
  expect((document.querySelector('[data-layout-caption]') as HTMLTextAreaElement).value).toBe('Frieren by a campfire at night.');
  expect((screen.getByRole('textbox', { name: 'Negative prompt' }) as HTMLTextAreaElement).value).toBe('lowres');
  // A box's caption rewritten on its own, undoable.
  fireEvent.click(document.querySelector('[data-layout-item]')!);
  fireEvent.click(screen.getByRole('button', { name: '✧ Rewrite' }));
  await waitFor(() => expect((document.querySelector('[data-layout-item-caption]') as HTMLTextAreaElement).value).toBe('a tighter fire'));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_forge_layout_rewrite', expect.objectContaining({ model: 'qwen', request: expect.objectContaining({ task: 'item', description: 'a campfire', width: 1536, height: 864 }) }));
  fireEvent.click(document.querySelector('[data-layout-undo]')!);
  expect((document.querySelector('[data-layout-item-caption]') as HTMLTextAreaElement).value).toBe('a campfire');
  // Drawn boxes go with the next Generate JSON.
  fireEvent.click(screen.getByRole('button', { name: 'Generate JSON' }));
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect((writes()[2].controls as { layout: { items: unknown[] } }).layout.items).toEqual([{ name: 'a campfire', label: 'object', caption: 'a campfire', bbox: [-100, -100, 100, 100] }]);
  expect(blankProject().items).toEqual([]);
});
