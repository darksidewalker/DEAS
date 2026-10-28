import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { PromptForge } from './PromptForge';
import { applyGenerated, blankProject, boxName, exportLayout, forPrompt, resizeProject, type LayoutProject } from './LayoutStudio';

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

it('names a written box by its subject, not its first four words', () => {
  expect(boxName('Frieren, an elf with long white hair, sits on the bench')).toBe('Frieren');
  expect(boxName('A small flock of birds flies past against the bright sky')).toBe('A small flock of birds');
  expect(boxName('A weathered wooden bench in a quiet park')).toBe('A weathered wooden bench');
  expect(boxName('the tall ancient oak tree casting long morning shadows')).toBe('the tall ancient oak tree');
});

it('a new canvas size scales the boxes with it', () => {
  const r = resizeProject(project, 512, 384);
  expect(r.items[0]).toMatchObject({ x: 6, y: 42, w: 200, h: 250 });
  expect(resizeProject(project, 1024, 768)).toBe(project);
});

const nativeTargets = { source: {}, creativity: ['balanced'], targets: [{ key: 'moss', label: 'MOSS', modes: ['Natural language', 'Layout JSON'], defaultMode: 'Natural language', optional: ['What changed', 'Negative prompt'], qualityPresets: [], styles: [], aspectRatios: ['N/A', '16:9 Wide'], hasNegative: true, tools: false, guidance: [], layoutCanvas: { 'N/A': [1024, 1024], '16:9 Wide': [1536, 864] }, layoutRewrite: true }] };
const canvasContext = { key: 'studio', effective: { width: 1024, height: 1024 }, model: { width: 1024, height: 1024 }, grid: 16, resolution: 'model', megapixels: 1, fixed: { width: 1024, height: 1024 } };
const writes = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'native_forge_write').map(([, a]) => (a as { request: Record<string, unknown> }).request);
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en'); localStorage.setItem('deas.pref.forge.target', JSON.stringify('MOSS'));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_llm_read') return { provider: 'openai', baseUrl: 'http://127.0.0.1:8080' };
    if (command === 'native_llm_models') return { models: [{ provider: 'openai', id: 'qwen', name: 'qwen' }], warnings: [] };
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
  render(<I18nProvider><PromptForge endpoint="http://127.0.0.1:8188" root="/env" onSend={vi.fn()} canvasContext={canvasContext}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open all' }));
  fireEvent.click(document.querySelector('[data-forge-tile="aspect:16:9"]')!);
  await waitFor(() => expect(document.querySelector('[data-layout-canvas]')!.getAttribute('viewBox')).toBe('0 0 1344 768'));
  // The studio makes the pictures, tags and kept-verbatim sections redundant.
  expect(document.querySelector('[data-forge-fold="verbatim"]')).toBeNull();
  fireEvent.change(document.querySelector('[data-forge-brief]')!, { target: { value: 'frieren by a campfire' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate prompt' }));
  await waitFor(() => expect((document.querySelector('[data-layout-caption]') as HTMLTextAreaElement).value).toBe('Frieren by a campfire at night.'));
  expect(writes()[0]).toMatchObject({ mode: 'Natural language', brief: 'frieren by a campfire' });
  expect((writes()[0].controls as Record<string, unknown>).layout).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Generate JSON' }));
  await waitFor(() => expect(document.querySelectorAll('[data-layout-item]')).toHaveLength(1));
  expect(writes()[1]).toMatchObject({ mode: 'Layout JSON', brief: 'Frieren by a campfire at night.', controls: expect.objectContaining({ canvas: { width: 1344, height: 768 }, layout: { width: 1344, height: 768, items: [] } }) });
  expect((document.querySelector('[data-layout-caption]') as HTMLTextAreaElement).value).toBe('Frieren by a campfire at night.');
  expect((screen.getByRole('textbox', { name: 'Negative prompt' }) as HTMLTextAreaElement).value).toBe('lowres');
  // A box's caption rewritten on its own, undoable.
  fireEvent.click(document.querySelector('[data-layout-item]')!);
  fireEvent.click(screen.getByRole('button', { name: '✧ Rewrite' }));
  await waitFor(() => expect((document.querySelector('[data-layout-item-caption]') as HTMLTextAreaElement).value).toBe('a tighter fire'));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('native_forge_layout_rewrite', expect.objectContaining({ model: 'qwen', request: expect.objectContaining({ task: 'item', description: 'a campfire', width: 1344, height: 768 }) }));
  fireEvent.click(document.querySelector('[data-layout-undo]')!);
  expect((document.querySelector('[data-layout-item-caption]') as HTMLTextAreaElement).value).toBe('a campfire');
  // Drawn boxes go with the next Generate JSON.
  fireEvent.click(screen.getByRole('button', { name: 'Generate JSON' }));
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect((writes()[2].controls as { layout: { items: unknown[] } }).layout.items).toEqual([{ name: 'a campfire', label: 'object', caption: 'a campfire', bbox: [-100, -100, 100, 100] }]);
  expect(blankProject().items).toEqual([]);
});

const storedProject = () => JSON.parse(localStorage.getItem('deas.pref.forge.layout.project')!) as LayoutProject;
const layoutView = (context = canvasContext, onSend = vi.fn()) => <I18nProvider><PromptForge endpoint="http://127.0.0.1:8188" root="/env" canvasContext={context} onSend={onSend}/></I18nProvider>;

it('N/A retains the current non-square project; canonical resizing preserves identities, text, metadata and undo/redo', async () => {
  localStorage.setItem('deas.pref.forge.layout.project', JSON.stringify(project));
  render(layoutView()); fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  expect(document.querySelector('[data-layout-canvas]')!.getAttribute('viewBox')).toBe('0 0 1024 768');
  expect(storedProject()).toEqual(project);
  fireEvent.click(document.querySelector('[data-forge-tile="aspect:16:9"]')!);
  await waitFor(() => expect(storedProject().w).toBe(1344));
  const scaled = storedProject();
  expect(scaled.items.map(({ id, name, label, caption, text, color }) => ({ id, name, label, caption, text, color }))).toEqual(project.items.map(({ id, name, label, caption, text, color }) => ({ id, name, label, caption, text, color })));
  expect([scaled.caption, scaled.meta, scaled.h]).toEqual([project.caption, project.meta, 768]);
  expect(scaled.items[0]).toMatchObject({ x: 16, y: 84, w: 525, h: 500 });
  fireEvent.click(document.querySelector('[data-layout-undo]')!);
  expect(storedProject()).toEqual(project);
  fireEvent.click(document.querySelector('[data-forge-tile="aspect:N/A"]')!);
  expect(storedProject()).toEqual(project);
  fireEvent.click(document.querySelector('[data-layout-redo]')!);
  expect(storedProject()).toEqual(scaled);
  expect(writes()).toHaveLength(0);
});

it.each(['prompt', 'json'])('a pending Generate %s cannot overwrite an edited layout even after undo restores its old content', async which => {
  localStorage.setItem('deas.pref.forge.layout.project', JSON.stringify(project));
  let complete!: (result: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge_write' ? pending : base(command, args));
  render(layoutView()); fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.change(document.querySelector('[data-forge-brief]')!, { target: { value: 'a forest camp' } });
  fireEvent.click(document.querySelector(`[data-forge-generate-${which}]`)!);
  await waitFor(() => expect(writes()).toHaveLength(1));
  fireEvent.change(document.querySelector('[data-layout-caption]')!, { target: { value: 'newer words' } });
  fireEvent.click(document.querySelector('[data-layout-undo]')!);
  expect(storedProject()).toEqual(project);
  await act(async () => complete({ segments: [{ label: 'Layout JSON', body: JSON.stringify({ items: [] }) }], refused: false, prompt: '', negative: null, characters: [], tools: [], rounds: 0, warnings: [], fixes: [] }));
  expect(storedProject()).toEqual(project);
  expect(screen.getByText('The context changed while writing. The old reply was discarded.')).toBeTruthy();
  expect(document.querySelector('[data-forge-send-layout]')).toBeNull();
});

it('layout Rewrite is bound to the request context and cannot update a newer Studio context', async () => {
  localStorage.setItem('deas.pref.forge.layout.project', JSON.stringify(project));
  let complete!: (text: string) => void;
  const pending = new Promise<string>(resolve => { complete = resolve; });
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === 'native_forge_layout_rewrite' ? pending : base(command, args));
  const ui = render(layoutView()); fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.click(document.querySelector('[data-layout-rewrite-scene]')!);
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'native_forge_layout_rewrite')).toBe(true));
  ui.rerender(layoutView({ ...canvasContext, key: 'new-studio-context' }));
  await act(async () => complete('old rewritten scene'));
  expect(storedProject()).toEqual(project);
  expect(screen.getByText('The context changed while writing. The old reply was discarded.')).toBeTruthy();
});

it('MOSS request, layout preview and explicit Send share the consumed canvas; later layout edits block stale Send', async () => {
  localStorage.setItem('deas.pref.forge.layout.project', JSON.stringify(project));
  const onSend = vi.fn(); render(layoutView(canvasContext, onSend));
  fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.click(document.querySelector('[data-forge-tile="aspect:16:9"]')!);
  await waitFor(() => expect(storedProject().w).toBe(1344));
  fireEvent.click(document.querySelector('[data-forge-generate-json]')!);
  await waitFor(() => expect(document.querySelector('[data-forge-send-layout]')).not.toBeNull());
  expect(writes()[0]).toMatchObject({ controls: { canvas: { width: 1344, height: 768 }, layout: { width: 1344, height: 768 } } });
  expect(document.querySelector('[data-layout-canvas]')!.getAttribute('viewBox')).toBe('0 0 1344 768');
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector('[data-forge-send-layout]')!);
  expect(onSend).toHaveBeenCalledExactlyOnceWith(JSON.stringify(exportLayout(storedProject()), null, 2), 'lowres', { canvas: { width: 1344, height: 768 }, contextKey: 'studio' });
  fireEvent.change(document.querySelector('[data-layout-caption]')!, { target: { value: 'manual newer scene' } });
  expect((document.querySelector('[data-forge-send-layout]') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector('[data-forge-stale]')).not.toBeNull();
  expect(storedProject().caption).toBe('manual newer scene');
});

it('N/A MOSS JSON uses the existing non-square layout and explicitly sends prompt-only without resetting Studio', async () => {
  localStorage.setItem('deas.pref.forge.layout.project', JSON.stringify(project));
  const onSend = vi.fn(); render(layoutView(canvasContext, onSend));
  fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.click(document.querySelector('[data-forge-generate-json]')!);
  await waitFor(() => expect(document.querySelector('[data-forge-send-layout]')).not.toBeNull());
  expect(writes()[0]).toMatchObject({ controls: { aspectRatio: 'N/A', layout: { width: 1024, height: 768 } } });
  expect((writes()[0].controls as { canvas?: unknown }).canvas).toBeUndefined();
  expect(document.querySelector('[data-layout-canvas]')!.getAttribute('viewBox')).toBe('0 0 1024 768');
  fireEvent.click(document.querySelector('[data-forge-send-layout]')!);
  expect(onSend).toHaveBeenCalledExactlyOnceWith(JSON.stringify(exportLayout(storedProject()), null, 2), 'lowres');
});

it('a canvas resize is an undo boundary between grouped caption edits', async () => {
  localStorage.setItem('deas.pref.forge.layout.project', JSON.stringify(project));
  render(layoutView()); fireEvent.click(await screen.findByRole('button', { name: 'Layout JSON' }));
  fireEvent.change(document.querySelector('[data-layout-caption]')!, { target: { value: 'before resize' } });
  fireEvent.click(document.querySelector('[data-forge-tile="aspect:16:9"]')!);
  await waitFor(() => expect(storedProject().w).toBe(1344));
  fireEvent.change(document.querySelector('[data-layout-caption]')!, { target: { value: 'after resize' } });
  fireEvent.click(document.querySelector('[data-layout-undo]')!);
  expect(storedProject()).toMatchObject({ w: 1344, h: 768, caption: 'before resize' });
  fireEvent.click(document.querySelector('[data-layout-undo]')!);
  expect(storedProject()).toEqual({ ...project, caption: 'before resize' });
});
