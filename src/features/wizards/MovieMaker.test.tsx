import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { MovieMaker } from './MovieMaker';
import { addMedia, completeItem, newMovie, setBrief, setMix, setMusicFile, setSceneInputs } from '../../lib/movieManifest';
import { setMusicPrompt } from '../../lib/movieMusic';
import { applyPlan } from '../../lib/movieStory';
import * as assembleRun from '../../lib/movieAssembleRun';

vi.mock('../../lib/movieAssembleRun', () => ({ realAssembleDeps: vi.fn(), stopAssemblyJob: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, convertFileSrc: (p: string) => `asset://${p}`, Channel: class { onmessage: (e: unknown) => void = () => undefined; } }));

let stored: Record<string, string>;
let picks: string[];
let checkReply: { id: string; kind: string; path: string }[] = [];
const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === name).map(([, a]) => a as Record<string, unknown>);
const view = () => render(<I18nProvider><MovieMaker/></I18nProvider>);
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
/** Selects a scene card on the timeline; its editor then shows below the cards. */
const pick = (id: string) => fireEvent.click(q(`[data-movie-scene-card="${id}"]`));
/** An element of a scene's editor (selecting that scene first). */
const inScene = (id: string, sel: string) => { pick(id); return document.querySelector(`[data-movie-segment="${id}"] ${sel}`) as HTMLButtonElement; };
/** Opens the music or film card's settings panel. */
const openCard = (kind: 'music' | 'film') => fireEvent.click(q(`[data-movie-${kind}-card]`));
const stateOf = (id: string) => document.querySelector(`[data-movie-scene-card="${id}"] [data-movie-scene-state]`)!.textContent;

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en'); stored = {}; picks = []; checkReply = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const m = JSON.parse(text); return { id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_save') { const m = JSON.parse(a.manifest); stored[m.id] = a.manifest; return m.id; }
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: checkReply, checked: 1, truncated: false };
    if (command === 'native_analysis_pick') return picks.shift() ?? null;
    throw new Error('unexpected ' + String(command));
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('edits the brief and the scenes timeline (+, −, lengths), saves, and reopens without starting anything', async () => {
  view();
  await waitFor(() => expect(q('[data-movie-none]')).toBeTruthy());
  fireEvent.change(q('[data-movie-title]'), { target: { value: 'Chase' } });
  expect(q('[data-movie-seconds]')).toBeNull(); // no total-length input: the length is the sum of the scenes
  // The aspect list is Generate's (Settings → resolution), with auto and without custom.
  const choices = [...q('[data-movie-aspect]').querySelectorAll('option')].map(o => (o as HTMLOptionElement).value);
  expect(choices).toContain('21:9'); expect(choices).toContain('auto'); expect(choices).not.toContain('custom');
  fireEvent.change(q('[data-movie-aspect]'), { target: { value: 'auto' } });
  expect(q('[data-movie-aspect-auto]')).toBeTruthy();
  fireEvent.change(q('[data-movie-aspect]'), { target: { value: '9:16' } });
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  expect(q('[data-movie-scenes-empty]')).toBeTruthy();
  expect(q('[data-movie-scene-remove]')).toBeNull(); // no − button: each card has its own ×
  fireEvent.click(q('[data-movie-scene-add]'));
  fireEvent.click(q('[data-movie-scene-add]'));
  expect([...document.querySelectorAll('[data-movie-scene-card]')].map(c => c.getAttribute('data-movie-scene-card'))).toEqual(['seg-1', 'seg-2']);
  expect(q('[data-movie-scene-card="seg-2"]').getAttribute('aria-pressed')).toBe('true'); // the new scene is selected
  expect(q('[data-movie-length]').textContent).toContain('Length 10 s');
  fireEvent.change(inScene('seg-2', '[data-movie-seg-seconds]'), { target: { value: '7' } });
  fireEvent.change(inScene('seg-2', '[data-movie-seg-prompt]'), { target: { value: 'Anna in a red coat runs' } });
  expect(q('[data-movie-length]').textContent).toContain('Length 12 s');
  expect(q('[data-movie-scene-card="seg-1"] [data-scene-no-inputs]')).toBeTruthy();
  // + inserts after the selected scene; the × on a card removes that card (the open panel moves to its neighbour).
  pick('seg-1'); fireEvent.click(q('[data-movie-scene-add]'));
  expect([...document.querySelectorAll('[data-movie-scene-card]')].map(c => c.getAttribute('data-movie-scene-card'))).toEqual(['seg-1', 'seg-3', 'seg-2']);
  expect(document.querySelectorAll('[data-movie-scene-remove]')).toHaveLength(3);
  expect(q('[data-movie-scene-remove="seg-3"]').getAttribute('aria-label')).toBe('Remove Scene 2');
  fireEvent.click(q('[data-movie-scene-remove="seg-3"]'));
  expect(q('[data-movie-scene-card="seg-2"]').getAttribute('aria-pressed')).toBe('true');
  expect([...document.querySelectorAll('[data-movie-scene-card]')].map(c => c.getAttribute('data-movie-scene-card'))).toEqual(['seg-1', 'seg-2']);
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(calls('native_movie_save')).toHaveLength(1));
  const saved = JSON.parse(calls('native_movie_save')[0].manifest as string);
  expect([saved.title, saved.targetSeconds, saved.aspect, saved.items[0].text]).toEqual(['Chase', 12, '9:16', 'Anna runs.']);
  expect(saved.items.filter((i: any) => i.kind === 'segment').map((i: any) => [i.id, i.seconds, i.text])).toEqual([['seg-1', 5, ''], ['seg-2', 7, 'Anna in a red coat runs']]);
  await waitFor(() => expect(q('[data-movie-note]')).toBeTruthy());
  // Fresh movie, then reopen the saved one: only list/open/save/check commands ran, no job command.
  fireEvent.click(q('[data-movie-new]'));
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('');
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${saved.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Chase'));
  expect(document.querySelectorAll('[data-movie-scene-card]')).toHaveLength(2);
  const used = new Set(vi.mocked(invoke).mock.calls.map(([c]) => c));
  expect([...used].sort()).toEqual(['native_movie_check', 'native_movie_list', 'native_movie_open', 'native_movie_save']);
});

it('there is no lock switch and no continue checkbox: the transition into a scene is chosen on the chip between two cards', async () => {
  view();
  fireEvent.click(q('[data-movie-scene-add]')); fireEvent.click(q('[data-movie-scene-add]'));
  pick('seg-1');
  expect(q('[data-movie-seg-lock]')).toBeNull();
  expect(q('[data-movie-seg-continuous]')).toBeNull();
  expect(q('[data-movie-transition="seg-1"]')).toBeNull(); // the first scene has no transition
  const chip = q('[data-movie-transition="seg-2"]') as HTMLSelectElement;
  expect([chip.value, [...chip.options].map(o => o.value)]).toEqual(['cut', ['seamless', 'cut', 'blend:0.5', 'blend:1', 'blend:2']]);
  fireEvent.change(chip, { target: { value: 'blend:1' } });
  expect(q('[data-movie-boundary="seg-2"]').className).toContain('is-blend');
  fireEvent.change(chip, { target: { value: 'seamless' } });
  expect(q('[data-movie-boundary="seg-2"]').className).toContain('is-seamless');
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(calls('native_movie_save')).toHaveLength(1));
  const saved = JSON.parse(calls('native_movie_save')[0].manifest as string);
  expect(saved.items.find((i: any) => i.id === 'seg-2')).toMatchObject({ continuous: true });
  expect(saved.items.find((i: any) => i.id === 'seg-2').blend).toBeUndefined();
});

it('scene inputs come from Generate\'s own media panel and role bar, limited by the H3 capabilities, each marked by kind', async () => {
  const entries = [{ name: 'anna.png', path: '/in/anna.png', kind: 'file', media: 'image', symlink: false, size: 1, modified: 2 },
    { name: 'song.wav', path: '/in/song.wav', kind: 'file', media: 'audio', symlink: false, size: 1, modified: 1 }];
  const previous = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'native_media_list' ? { path: '/in', parent: '/', entries, truncated: false }
    : command === 'native_media_thumbnail' ? (args as any).path : previous(command, args));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  render(<I18nProvider><MovieMaker mediaRoots={{ input: '/in', output: '/out' }}/></I18nProvider>);
  fireEvent.click(q('[data-movie-scene-add]'));
  fireEvent.click(inScene('seg-1', '[data-movie-scene-inputs-open]'));
  const dialog = await waitFor(() => { const d = document.querySelector('dialog[open]') as HTMLElement; expect(d).toBeTruthy(); return d; });
  fireEvent.click(await waitFor(() => { const b = dialog.querySelector('[title="anna.png"], [aria-label="anna.png"]') ?? [...dialog.querySelectorAll('button')].find(x => x.textContent?.includes('anna.png')); expect(b).toBeTruthy(); return b as HTMLElement; }));
  // H3: a picture can be a reference or a frame; assign it as a reference.
  const role = dialog.querySelector('[data-video-roles] select') as HTMLSelectElement;
  expect([...role.options].map(o => o.value)).toEqual(['first', 'last', 'both', 'reference']);
  fireEvent.change(role, { target: { value: 'reference' } });
  fireEvent.click(dialog.querySelector('[data-video-role="reference"]')!);
  // H3 does not mix frames with references (family.video.mixReferences): with a reference set, a frame role is refused with the reason.
  fireEvent.change(role, { target: { value: 'first' } });
  expect((dialog.querySelector('[data-video-role="first"]') as HTMLButtonElement).disabled).toBe(true);
  // A sound file can only be a reference on H3.
  fireEvent.click(await waitFor(() => { const b = [...dialog.querySelectorAll('button')].find(x => x.textContent?.includes('song.wav') || x.getAttribute('title') === 'song.wav' || x.getAttribute('aria-label') === 'song.wav'); expect(b).toBeTruthy(); return b as HTMLElement; }));
  const role2 = dialog.querySelector('[data-video-roles] select') as HTMLSelectElement;
  expect([...role2.options].map(o => o.value)).toEqual(['reference']);
  fireEvent.click(dialog.querySelector('[data-video-role="reference"]')!);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(q('[data-movie-scene-card="seg-1"] [data-scene-mark="image"]')).toBeTruthy();
  expect(q('[data-movie-scene-card="seg-1"] [data-scene-mark="audio"]')).toBeTruthy();
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(calls('native_movie_save')).toHaveLength(1));
  const saved = JSON.parse(calls('native_movie_save')[0].manifest as string);
  expect(saved.items.find((i: any) => i.id === 'seg-1').inputs).toEqual({ refs: [{ path: '/in/anna.png', media: 'image', mediaMode: 'video', second: 0, strength: 1 }, { path: '/in/song.wav', media: 'audio', mediaMode: 'video', second: 0, strength: 1 }] });
});

it('a damaged or newer movie file is reported and the current movie stays', async () => {
  const bad = JSON.stringify({ ...newMovie('movie-x', 'Old'), version: 2 });
  stored['movie-x'] = bad;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_movie_list') return { movies: [{ id: 'movie-x', title: 'Old', items: 1, targetSeconds: 30, updated: 1 }], damaged: 2 };
    if (command === 'native_movie_open') return stored[(args as any).id];
    return null;
  });
  view();
  fireEvent.change(q('[data-movie-title]'), { target: { value: 'Keep' } });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await waitFor(() => expect(q('[data-movie-damaged]')).toBeTruthy());
  fireEvent.click(q('[data-movie-open="movie-x"]'));
  await waitFor(() => expect(q('[data-movie-error]')).toBeTruthy());
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Keep');
});

const answer = JSON.stringify({ lore: 'A chase at dusk.', segments: [
  { title: 'Start', prompt: 'Wide shot, Anna runs', seconds: 10, continuous: false, dialogue: [{ speaker: 'Anna', line: 'Stop!' }] },
  { title: 'Catch', prompt: 'Close up of Anna', seconds: 5, continuous: true },
] });
let llmReply: string, llmBase: string, generated: Record<string, any>[];
const planMock = (models: unknown[]) => vi.mocked(invoke).mockImplementation(async (command, args) => {
  const a = args as Record<string, any>;
  if (command === 'native_movie_list') return { movies: [], damaged: 0 };
  // Prompt Forge's LLM configuration lives under the environment root, never the models folder.
  if (command.startsWith('native_llm_') && a.root !== '/env') throw new Error(`LLM asked under ${a.root}`);
  if (command === 'native_llm_models') return { models, warnings: [] };
  if (command === 'native_llm_read') return { provider: 'ollama', baseUrl: llmBase };
  if (command === 'native_llm_generate') { generated.push(a); return { text: llmReply, backend: a.request.model.provider }; }
  if (command === 'native_logs_movie_notice') return null;
  throw new Error('unexpected ' + String(command));
});
const prepare = async () => {
  render(<I18nProvider><MovieMaker root="/env"/></I18nProvider>);
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
};

it('plans locally, shows the diff, applies it and shows the real H3 durations without any confirmation', async () => {
  llmReply = 'Sure!\n```json\n' + answer + '\n```'; llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'qwen.gguf', provider: 'local', name: 'qwen' }]);
  await prepare();
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-diff]')).toBeTruthy());
  expect(q('[data-movie-remote]')).toBeNull();
  expect(generated).toHaveLength(1);
  expect(generated[0].request.model).toEqual({ id: 'qwen.gguf', provider: 'local' });
  expect(generated[0].request.prompt).toContain('Story:\nAnna runs.');
  expect(generated[0].request.system).toContain('which persons are in it');
  expect(q('[data-movie-plan-diff]').textContent).toContain('2 new');
  fireEvent.click(q('[data-movie-plan-apply]'));
  expect(document.querySelectorAll('[data-movie-scene-card]')).toHaveLength(2);
  expect(inScene('seg-1', '[data-movie-seg-line]').textContent).toBe('Anna: Stop!');
  expect(q('[data-movie-lore]')).toBeTruthy();
  // 10 s new take → 243 frames = 10.13 s; 5 s continued → 119 frames = 4.96 s; the length is the sum of the scenes.
  expect(inScene('seg-1', '[data-movie-seg-actual]').textContent).toContain('10.13');
  expect(q('[data-movie-length]').textContent).toContain('Length 15 s');
  expect(q('[data-movie-transition="seg-1"]')).toBeNull();
  expect((q('[data-movie-transition="seg-2"]') as HTMLSelectElement).value).toBe('seamless');
  fireEvent.change(inScene('seg-2', '[data-movie-seg-seconds]'), { target: { value: '4' } });
  expect(q('[data-movie-length]').textContent).toContain('Length 14 s');
});

it('writes my own scenes: keeps their number, lengths and inputs and only fills the text', async () => {
  llmReply = JSON.stringify({ lore: 'Dusk.', segments: [{ title: 'Run', prompt: 'Anna in a red coat runs' }, { title: 'Hide', prompt: 'Ben hides', dialogue: [{ speaker: 'Ben', line: 'Here!' }] }] });
  llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'qwen.gguf', provider: 'local', name: 'qwen' }]);
  await prepare();
  expect((q('[data-movie-plan-write]') as HTMLButtonElement).disabled).toBe(true); // needs scenes
  fireEvent.click(q('[data-movie-scene-add]')); fireEvent.click(q('[data-movie-scene-add]'));
  fireEvent.change(inScene('seg-1', '[data-movie-seg-seconds]'), { target: { value: '6' } });
  fireEvent.click(q('[data-movie-plan-write]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  expect(generated[0].request.system).toContain('exactly 2 segments');
  expect(generated[0].request.prompt).toContain('1. 6s');
  fireEvent.click(q('[data-movie-plan-apply]'));
  expect([...document.querySelectorAll('[data-movie-scene-card]')].map(c => c.getAttribute('data-movie-scene-card'))).toEqual(['seg-1', 'seg-2']);
  expect((inScene('seg-1', '[data-movie-seg-seconds]') as unknown as HTMLInputElement).value).toBe('6');
  expect((inScene('seg-1', '[data-movie-seg-prompt]') as unknown as HTMLTextAreaElement).value).toBe('Anna in a red coat runs');
  expect(inScene('seg-2', '[data-movie-seg-line]').textContent).toBe('Ben: Here!');
});

it('an external server only gets the brief after the destination is confirmed; cancel sends nothing', async () => {
  llmReply = answer; llmBase = 'https://llm.example.org:8443/v1'; generated = [];
  planMock([{ id: 'gpt', provider: 'openai', name: 'gpt' }]);
  await prepare();
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-remote]')).toBeTruthy());
  expect(q('[data-movie-remote]').textContent).toContain('llm.example.org:8443');
  expect(q('[data-movie-remote]').textContent).toContain('Your input files are not sent');
  expect(generated).toHaveLength(0);
  fireEvent.click(q('[data-movie-remote-cancel]'));
  expect(q('[data-movie-remote]')).toBeNull();
  expect(generated).toHaveLength(0);
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-remote-send]')).toBeTruthy());
  fireEvent.click(q('[data-movie-remote-send]'));
  await waitFor(() => expect(q('[data-movie-plan-diff]')).toBeTruthy());
  expect(generated).toHaveLength(1);
  expect(calls('native_logs_movie_notice').map(c => c.operation)).toContain('plan-remote');
});

it('a loopback endpoint of an external provider needs no confirmation, and an unusable answer changes nothing', async () => {
  llmReply = 'I cannot do that.'; llmBase = 'http://localhost:11434'; generated = [];
  planMock([{ id: 'llama', provider: 'ollama', name: 'llama' }]);
  await prepare();
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-invalid]')).toBeTruthy());
  expect(q('[data-movie-remote]')).toBeNull();
  expect(q('[data-movie-story-stage]')).toBeNull();
  expect(calls('native_logs_movie_notice').map(c => c.operation)).toContain('plan-invalid');
});

it('planning is blocked with a reason when there is no model, no story or the brief is too long', async () => {
  llmReply = ''; llmBase = ''; generated = [];
  planMock([]);
  render(<I18nProvider><MovieMaker root="/env"/></I18nProvider>);
  await waitFor(() => expect(q('[data-movie-no-model]')).toBeTruthy());
  expect((q('[data-movie-plan-run]') as HTMLButtonElement).disabled).toBe(true);
  cleanup(); planMock([{ id: 'x', provider: 'local', name: 'x' }]);
  render(<I18nProvider><MovieMaker root="/env"/></I18nProvider>);
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  expect(q('[data-movie-plan-blocked]').textContent).toContain('Write the story first');
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'x'.repeat(7000) } });
  expect(q('[data-movie-plan-blocked]').textContent).toContain('longer than the planner can read');
  expect(generated).toHaveLength(0);
});

const h3 = { category: 'diffusion_models', name: 'h3_turbo.safetensors', path: '/m/h3_turbo', size: 1, info: null, family: 'minimax-h3' };
const h3Base = { ...h3, name: 'h3_base.safetensors', path: '/m/h3_base' };
it('makes a cut shot through Generate, records the finished video, and blocks continued shots', async () => {
  llmReply = JSON.stringify({ lore: 'L', segments: [
    { title: 'Start', prompt: 'Anna runs', seconds: 10, continuous: false },
    { title: 'Catch', prompt: 'Close up', seconds: 4, continuous: true },
  ] }); llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" models={[h3Base, h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-apply]'));
  expect([inScene('seg-1', '[data-movie-shot-make]').disabled, inScene('seg-2', '[data-movie-shot-make]').disabled]).toEqual([false, true]);
  expect((q('[data-movie-shot-model]') as HTMLSelectElement).value).toBe('h3_turbo.safetensors'); // the Turbo file is the default
  fireEvent.click(inScene('seg-1', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  // The movie's own settings: the exact 16:9 H3 canvas Generate computes at the model's resolution, and the Turbo file's starting sampling.
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', run: true, seconds: 10, model: { path: '/m/h3_turbo' },
    size: { width: 1152, height: 672 }, sampling: { steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' } });
  // Generate reports the run: first running, then the finished video becomes the shot's result.
  view.rerender(ui({ n: 1, run: { state: 'running', job: { id: 'j1' } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('making …'));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j1' }, picture: { path: '/out/seg1.mp4', video: true, width: 1, height: 1, seed: 1, checkpoint: 'h3' } } }, 1));
  await waitFor(() => expect(document.querySelector('[data-movie-shot-video]')).toBeTruthy());
  expect(stateOf('seg-1')).toBe('made');
  expect(q('[data-movie-dirty]')).toBeTruthy();
  // A failed run marks the shot failed and shows the reason.
  fireEvent.click(inScene('seg-1', '[data-movie-shot-make]'));
  view.rerender(ui({ n: 2, run: { state: 'failed', error: 'out of memory' } }, 2));
  await waitFor(() => expect(q('[data-movie-shot-error]').textContent).toBe('out of memory'));
  expect(stateOf('seg-1')).toBe('failed');
});

it('without an H3 model the shot buttons are disabled with the reason', async () => {
  llmReply = ''; llmBase = ''; generated = [];
  planMock([]);
  const { container } = render(<I18nProvider><MovieMaker root="/env" models={[]} onPrepare={vi.fn()}/></I18nProvider>);
  expect(container.querySelector('[data-movie-shot-nomodel]')).toBeNull(); // no shots yet, so nothing to explain
});

const filmMovie = (done: boolean) => {
  let m = setBrief(newMovie('movie-f', 'Film'), { story: 's' });
  m = applyPlan(m, { lore: 'l', segments: [
    { title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] },
    { title: 'B', prompt: 'b', seconds: 5, continuous: false, dialogue: [] },
  ] });
  return done ? ['seg-1', 'seg-2'].reduce((x, id) => completeItem(x, id, { outputId: `/out/${id}.mp4`, jobId: id, seconds: 5 }), m) : m;
};
const openFilm = async (m: ReturnType<typeof filmMovie>, endpoint = 'http://backend') => {
  stored[m.id] = JSON.stringify(m);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[(args as any).id];
    if (command === 'native_movie_check') return { missing: checkReply, checked: 2, truncated: false };
    if (command === 'native_logs_movie_notice') return null;
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    return null;
  });
  render(<I18nProvider><MovieMaker root="/env" endpoint={endpoint} models={[]} onPrepare={vi.fn()}/></I18nProvider>);
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-film-card]')).toBeTruthy());
  openCard('film');
  await waitFor(() => expect(q('[data-movie-film]')).toBeTruthy());
};

it('names the shots that keep the film from being joined and disables the join', async () => {
  await openFilm(filmMovie(false));
  expect((q('[data-movie-film-run]') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelectorAll('[data-movie-film-missing] li')).toHaveLength(2);
  expect(q('[data-movie-film-missing]').textContent).toContain('A: not made yet');
  expect(q('[data-movie-film-blocked]').textContent).toBe('Make every shot first.');
});

it('joins the finished shots through the Join recipe deps, records and plays the film, and logs it', async () => {
  const steps: string[] = [];
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => { steps.push('inspect ' + p); return { sourceId: 'id', blockers: [], durationSeconds: 5 }; },
    upload: async () => 'in.mp4', preflight: async () => ({ ok: true, issues: [], seconds: 9 }),
    epoch: async () => ({ epoch: 1, stopping: false }),
    run: async () => ({ id: 'jf', state: 'running', outputs: [] }),
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film.mp4', subfolder: 'video' }] }), stitch: async () => { throw new Error('no blend'); },
  });
  await openFilm(filmMovie(true));
  expect((q('[data-movie-film-run]') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(q('[data-movie-film-run]'));
  await waitFor(() => expect(q('[data-movie-film-video]')).toBeTruthy());
  expect(steps).toEqual(['inspect /out/seg-1.mp4', 'inspect /out/seg-2.mp4']);
  expect(q('[data-movie-film-video] video').getAttribute('src')).toBe('asset:///out/video/film.mp4'); // Generate's preview player (HTML off Linux)
  expect(q('[data-movie-film-mismatch]').textContent).toContain('9 s but the shots add up to 10 s');
  expect(q('[data-movie-dirty]')).toBeTruthy();
  expect(calls('native_logs_movie_notice').map(c => c.operation)).toContain('join-done');
  expect(vi.mocked(assembleRun.realAssembleDeps).mock.calls[0][0]).toBe('http://backend');
});

it('a refused join shows the reason, logs it, and records nothing', async () => {
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async () => ({ sourceId: 'id', blockers: [], durationSeconds: 5 }), upload: async () => 'in.mp4',
    preflight: async () => ({ ok: false, issues: ['audio rate differs'], seconds: 0 }),
    epoch: async () => ({ epoch: 1, stopping: false }), run: async () => { throw new Error('must not run'); }, wait: async j => j, stitch: async () => { throw new Error('no blend'); },
  });
  await openFilm(filmMovie(true));
  fireEvent.click(q('[data-movie-film-run]'));
  await waitFor(() => expect(q('[data-movie-error]').textContent).toBe('audio rate differs'));
  expect(q('[data-movie-film-video]')).toBeNull();
  expect(calls('native_logs_movie_notice').map(c => c.operation)).toContain('join-blocked');
});

it('reopening reports the clips and pictures that are gone and can mark the missing clips as not made', async () => {
  checkReply = [{ id: 'seg-1', kind: 'result', path: '/out/seg-1.mp4' }, { id: 'seg-2', kind: 'reference', path: '/pics/anna.png' }];
  await openFilm(filmMovie(true));
  await waitFor(() => expect(q('[data-movie-gone]')).toBeTruthy());
  const items = [...document.querySelectorAll('[data-movie-gone] li')].map(x => x.textContent);
  expect(items).toEqual(['A: the made clip “seg-1.mp4” is missing', 'B: the reference picture “anna.png” is missing']);
  expect(q('[data-movie-film-missing]')).toBeNull(); // both shots still look made until the user decides
  fireEvent.click(q('[data-movie-gone-mark]'));
  expect(q('[data-movie-film-missing]').textContent).toContain('A: not made yet');
  expect(q('[data-movie-gone-mark]')).toBeNull();
  expect(q('[data-movie-dirty]')).toBeTruthy();
  fireEvent.click(q('[data-movie-gone-dismiss]'));
  expect(q('[data-movie-gone]')).toBeNull();
});

it('nothing is reported when every referenced file is there', async () => {
  await openFilm(filmMovie(true));
  expect(q('[data-movie-gone]')).toBeNull();
});

const chainReply = JSON.stringify({ lore: 'L', segments: [
  { title: 'Start', prompt: 'Anna runs', seconds: 5, continuous: false },
  { title: 'Alley', prompt: 'Ben hides', seconds: 4, continuous: true },
  { title: 'Cut', prompt: 'Street', seconds: 5, continuous: false },
] });
const chainUi = async () => {
  llmReply = chainReply; llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" models={[h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-apply]'));
  return { onPrepare, ui, view };
};
const vid = (path: string) => ({ path, video: true, width: 1, height: 1, seed: 1, checkpoint: 'h3' });

it('a chain is made from its first shot: one hand-over with the plan, each shot recorded as it finishes, busy until the last one', async () => {
  const { onPrepare, ui, view } = await chainUi();
  const make = (id: string) => inScene(id, '[data-movie-shot-make]');
  expect(['seg-1', 'seg-2', 'seg-3'].map(id => [make(id).textContent, make(id).disabled])).toEqual([['Make the chain (2 shots)', false], ['Make this shot', true], ['Make this shot', false]]);
  expect(make('seg-2').title).toBe('Made together with the first shot of its chain.');
  fireEvent.click(make('seg-1'));
  const h = onPrepare.mock.calls[0][0];
  expect(h).toMatchObject({ wizard: 'movie', strategy: 'seg-1', run: true, continuity: { shotIds: ['seg-1', 'seg-2'], plan: { outputMode: 'segment', steps: [{ id: 'seg-1' }, { id: 'seg-2' }] } } });
  view.rerender(ui({ n: 1, run: { state: 'running', step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('making …'));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j1' }, picture: vid('/out/s1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  expect(stateOf('seg-2')).toBe('not made');
  expect(['seg-1', 'seg-2', 'seg-3'].every(id => make(id).disabled)).toBe(true); // still busy between the steps
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j2' }, picture: vid('/out/s2.mp4'), step: { index: 1, shotId: 'seg-2', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('made'));
  expect(make('seg-1').disabled).toBe(false);
  expect(['seg-1', 'seg-2'].map(id => { pick(id); return !!q('[data-movie-shot-video]'); })).toEqual([true, true]);
  expect(['seg-1', 'seg-2', 'seg-3'].map(id => inScene(id, '[data-movie-seg-actual]').textContent)).toEqual(['Will be made as 5.17 s', 'Will be made as 4.25 s', 'Will be made as 5.17 s']);
});

it('a failing step marks that shot failed, leaves the rest of the chain not made, and frees the buttons', async () => {
  const { ui, view } = await chainUi();
  fireEvent.click(inScene('seg-1', '[data-movie-shot-make]'));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', picture: vid('/out/s1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  view.rerender(ui({ n: 1, run: { state: 'failed', error: 'out of memory', step: { index: 1, shotId: 'seg-2', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('failed'));
  expect(inScene('seg-2', '[data-movie-shot-error]').textContent).toBe('out of memory');
  expect(inScene('seg-1', '[data-movie-shot-make]').disabled).toBe(false);
  expect(stateOf('seg-3')).toBe('not made');
});

const scoredMovie = (filmDone: boolean) => {
  const m = filmMovie(true);
  return filmDone ? completeItem(m, 'final', { outputId: '/out/video/film.mp4', seconds: 10 }) : m;
};
let pickedMusic: string | null, mixed: Record<string, any>[], mixFail: boolean;
const openScored = async (m: ReturnType<typeof scoredMovie>) => {
  pickedMusic = '/music/bed.wav'; mixed = []; mixFail = false;
  stored[m.id] = JSON.stringify(m);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_movie_pick_music') return pickedMusic;
    if (command === 'native_movie_mix') { mixed.push(a.request); if (mixFail) throw new Error('MOVIE_MIX_FFMPEG'); return { path: '/out/video/film-scored.mp4', seconds: 10, ducked: true }; }
    return null;
  });
  render(<I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[]} onPrepare={vi.fn()}/></I18nProvider>);
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-music-card]')).toBeTruthy());
  openCard('music');
  await waitFor(() => expect(q('[data-movie-music]')).toBeTruthy());
};

it('music bed: choose a track, adjust the mix, mix it onto the film, play the scored film', async () => {
  await openScored(scoredMovie(true));
  expect((q('[data-movie-music-run]') as HTMLButtonElement).disabled).toBe(true);
  expect(q('[data-movie-music-blocked]').textContent).toBe('Choose a music file first.');
  expect(q('[data-movie-mix="levelDb"]')).toBeNull(); // no settings before a track exists
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(q('[data-movie-music-file]').textContent).toBe('bed.wav'));
  expect((q('[data-movie-mix="duckDb"]') as HTMLInputElement).value).toBe('12');
  fireEvent.change(q('[data-movie-mix="levelDb"]'), { target: { value: '-20' } });
  fireEvent.change(q('[data-movie-mix="duckDb"]'), { target: { value: '99' } });
  expect((q('[data-movie-mix="duckDb"]') as HTMLInputElement).value).toBe('30'); // clamped to the limit
  expect((q('[data-movie-music-run]') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(q('[data-movie-music-run]'));
  await waitFor(() => expect(q('[data-movie-scored-video]')).toBeTruthy());
  expect(mixed).toEqual([{ film: '/out/video/film.mp4', music: '/music/bed.wav', levelDb: -20, duckDb: 30, fadeSeconds: 2 }]);
  expect(q('[data-movie-scored-video] video').getAttribute('src')).toBe('asset:///out/video/film-scored.mp4');
  expect(q('[data-movie-dirty]')).toBeTruthy();
  // Changing the level afterwards makes the scored film outdated and hides nothing silently.
  fireEvent.change(q('[data-movie-mix="levelDb"]'), { target: { value: '-18' } });
  expect(q('[data-movie-music-stale]')).toBeTruthy();
  expect(q('[data-movie-scored-video]')).toBeNull();
  fireEvent.click(q('[data-movie-music-clear]'));
  expect(q('[data-movie-music-file]')).toBeNull();
});

it('cancelling the chooser changes nothing; the mix says what is missing when the film is not joined yet', async () => {
  await openScored(scoredMovie(false));
  pickedMusic = null;
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(calls('native_movie_pick_music')).toHaveLength(1));
  expect(q('[data-movie-music-file]')).toBeNull();
  pickedMusic = '/music/bed.wav';
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(q('[data-movie-music-file]')).toBeTruthy());
  expect(q('[data-movie-music-blocked]').textContent).toBe('Join the shots into one film first.');
  expect((q('[data-movie-music-run]') as HTMLButtonElement).disabled).toBe(true);
});

it('a failed mix shows the error and records nothing', async () => {
  await openScored(scoredMovie(true));
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(q('[data-movie-music-file]')).toBeTruthy());
  mixFail = true;
  fireEvent.click(q('[data-movie-music-run]'));
  await waitFor(() => expect(q('[data-movie-error]').textContent).toBe('MOVIE_MIX_FFMPEG'));
  expect(q('[data-movie-scored-video]')).toBeNull();
});

const ace = { category: 'checkpoints', name: 'ace-step-1-5-turbo.safetensors', path: '/m/ace_turbo', size: 1, info: null, family: 'ace-step-1-5-turbo' };
const yue = { category: 'checkpoints', name: 'yue2_3b.safetensors', path: '/m/yue2', size: 1, info: null, family: 'yue2' };
const openMusic = async (models: unknown[]) => {
  const m = scoredMovie(true);
  stored[m.id] = JSON.stringify(m);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[(args as any).id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    return null;
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={models as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-music-card]')).toBeTruthy());
  openCard('music');
  await waitFor(() => expect(q('[data-movie-music]')).toBeTruthy());
  return { onPrepare, ui, view };
};

it('music bed generation: needs a prompt, hands an instrumental ACE-Step draft of the film\'s length to Generate, and keeps the finished track as the music file', async () => {
  const { onPrepare, ui, view } = await openMusic([ace, yue]);
  expect(q('[data-movie-music-licence]')).toBeNull(); // ACE-Step first: no restriction note
  fireEvent.click(q('[data-movie-music-generate]'));
  expect(q('[data-movie-error]').textContent).toBe('Describe the music first.');
  expect(onPrepare).not.toHaveBeenCalled();
  fireEvent.change(q('[data-movie-music-prompt]'), { target: { value: 'calm piano' } });
  fireEvent.click(q('[data-movie-music-generate]'));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ wizard: 'movie', pipeline: 't2m', run: true, model: { path: '/m/ace_turbo' }, music: { style: 'calm piano', lyrics: '', seconds: 10 } });
  expect(q('[data-movie-music-generate]').textContent).toBe('Generating …');
  view.rerender(ui({ n: 1, run: { state: 'running' } }, 1));
  expect((q('[data-movie-music-generate]') as HTMLButtonElement).disabled).toBe(true);
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'jm' }, picture: { path: '/out/audio/bed.flac', audio: true, width: 0, height: 0, seed: 1, checkpoint: 'ace' } } }, 1));
  await waitFor(() => expect(q('[data-movie-music-file]').textContent).toBe('bed.flac'));
  expect((q('[data-movie-music-generate]') as HTMLButtonElement).disabled).toBe(false);
  expect(q('[data-movie-dirty]')).toBeTruthy();
  // The choose button still works and replaces the generated track.
  fireEvent.click(q('[data-movie-music-prepare]'));
  expect(onPrepare.mock.calls[1][0]).toMatchObject({ run: false });
});

it('a failed generation shows the reason; YuE2 comes with its licence note; no music model says so', async () => {
  const { ui, view } = await openMusic([yue]);
  expect(q('[data-movie-music-licence]').textContent).toContain('CC-BY-NC');
  fireEvent.change(q('[data-movie-music-prompt]'), { target: { value: 'x' } });
  fireEvent.click(q('[data-movie-music-generate]'));
  view.rerender(ui({ n: 1, run: { state: 'failed', error: 'out of memory' } }, 1));
  await waitFor(() => expect(q('[data-movie-music-error]').textContent).toBe('out of memory'));
  expect(q('[data-movie-music-file]')).toBeNull();
  cleanup();
  await openMusic([]);
  expect(q('[data-movie-music-nomodel]').textContent).toBe('No ACE-Step or YuE2 music model is installed.');
  expect((q('[data-movie-music-generate]') as HTMLButtonElement).disabled).toBe(true);
});

it('the music bed has its own LoRAs: only the chosen ACE-Step model\'s LoRA family is offered, they ride the hand-over, and YuE2 offers none', async () => {
  const lofi = { category: 'loras', name: 'ace/lofi.safetensors', path: '/m/loras/lofi', size: 1, info: null, family: 'ace-step-1-5' };
  const xlOnly = { category: 'loras', name: 'ace/xl.safetensors', path: '/m/loras/xl', size: 1, info: null, family: 'ace-step-1-5-xl' };
  const picture = { category: 'loras', name: 'sdxl/other.safetensors', path: '/m/loras/o', size: 1, info: null, family: 'sdxl' };
  const { onPrepare } = await openMusic([ace, yue, lofi, xlOnly, picture]);
  fireEvent.click(q('[data-movie-music-lora-add]'));
  expect(q('[data-movie-music-lora]').getAttribute('data-movie-music-lora')).toBe('ace/lofi.safetensors');
  expect([...q('[data-movie-music-lora-name]').querySelectorAll('option')].map(o => o.value)).toEqual(['ace/lofi.safetensors']); // not the XL or picture LoRA
  expect((q('[data-movie-music-lora-add]') as HTMLButtonElement).disabled).toBe(true); // nothing else of that family
  fireEvent.change(q('[data-movie-music-lora-strength]'), { target: { value: '0.6' } });
  fireEvent.change(q('[data-movie-music-prompt]'), { target: { value: 'lofi' } });
  // YuE2 has no LoRA path: the picked LoRA stays visible but the run is refused with the reason.
  fireEvent.change(q('[data-movie-music-model]'), { target: { value: '/m/yue2' } });
  expect(q('[data-movie-music-lora-add]')).toBeTruthy();
  fireEvent.click(q('[data-movie-music-generate]'));
  expect(q('[data-movie-error]').textContent).toBe('YuE2 cannot use LoRAs. Remove the music LoRAs or choose an ACE-Step model.');
  expect(onPrepare).not.toHaveBeenCalled();
  fireEvent.change(q('[data-movie-music-model]'), { target: { value: '/m/ace_turbo' } });
  fireEvent.click(q('[data-movie-music-generate]'));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ pipeline: 't2m', loras: [{ name: 'ace/lofi.safetensors', strength: 0.6 }] });
});

it('removing the last music LoRA on YuE2 hides the LoRA list again', async () => {
  const lofi = { category: 'loras', name: 'ace/lofi.safetensors', path: '/m/loras/lofi', size: 1, info: null, family: 'ace-step-1-5' };
  await openMusic([ace, yue, lofi]);
  fireEvent.click(q('[data-movie-music-lora-add]'));
  fireEvent.change(q('[data-movie-music-model]'), { target: { value: '/m/yue2' } });
  fireEvent.click(q('[data-movie-music-lora-remove]'));
  expect(q('[data-movie-music-loras]')).toBeNull();
});

const h3b = { ...h3, name: 'h3_other.safetensors', path: '/m/h3_other' };
const loraA = { category: 'loras', name: 'MiniMaxH3/style-a.safetensors', path: '/m/loras/a', size: 1, info: null, family: 'minimax-h3' };
const loraB = { category: 'loras', name: 'MiniMaxH3/style-b.safetensors', path: '/m/loras/b', size: 1, info: null, family: 'minimax-h3' };
const loraOther = { category: 'loras', name: 'sdxl/other.safetensors', path: '/m/loras/o', size: 1, info: null, family: 'sdxl' };

it('every shot can have its own model and LoRAs; continued shots inherit; the hand-over carries them', async () => {
  llmReply = chainReply; llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  const onPrepare = vi.fn();
  render(<I18nProvider><MovieMaker root="/env" models={[h3, h3b, loraA, loraB, loraOther] as any} onPrepare={onPrepare}/></I18nProvider>);
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-apply]'));
  const box = (id: string) => { if (!document.querySelector(`[data-movie-shot-settings="${id}"]`)) pick(id); return document.querySelector(`[data-movie-shot-settings="${id}"]`)!; };
  expect(box('seg-2').querySelector('[data-movie-shot-inherits]')).toBeTruthy(); // continued: no controls of its own
  expect(box('seg-2').querySelector('[data-movie-shot-own-model]')).toBeNull();
  const own = box('seg-3').querySelector('[data-movie-shot-own-model]') as HTMLSelectElement;
  expect([...own.options].map(o => o.textContent)).toEqual(['Default (h3_turbo.safetensors)', 'h3_turbo.safetensors', 'h3_other.safetensors']);
  fireEvent.change(own, { target: { value: 'h3_other.safetensors' } });
  fireEvent.click(box('seg-3').querySelector('[data-movie-lora-add]')!);
  const row = () => box('seg-3').querySelector('[data-movie-lora]')!;
  expect(row().getAttribute('data-movie-lora')).toBe('MiniMaxH3/style-a.safetensors'); // only LoRAs of this model's family are offered
  const names = [...(row().querySelector('[data-movie-lora-name]') as HTMLSelectElement).options].map(o => o.value);
  expect(names).toEqual(['MiniMaxH3/style-a.safetensors', 'MiniMaxH3/style-b.safetensors']);
  fireEvent.change(row().querySelector('[data-movie-lora-strength]')!, { target: { value: '0.6' } });
  fireEvent.change(row().querySelector('[data-movie-lora-name]')!, { target: { value: 'MiniMaxH3/style-b.safetensors' } });
  expect(box('seg-3').querySelector('summary')!.textContent).toBe('Model and LoRAs (1 LoRAs)');
  // The third shot is a single cut shot: its hand-over carries its own model and LoRA.
  fireEvent.click(inScene('seg-3', '[data-movie-shot-prepare]'));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'seg-3', model: { name: 'h3_other.safetensors', path: '/m/h3_other' }, loras: [{ name: 'MiniMaxH3/style-b.safetensors', strength: 0.6 }] });
  // The chain's first shot defines its chain; a shot without settings uses the default model and no LoRAs.
  fireEvent.click(inScene('seg-1', '[data-movie-shot-prepare]'));
  expect(onPrepare.mock.calls[1][0].model.name).toBe('h3_turbo.safetensors');
  expect(onPrepare.mock.calls[1][0].loras).toBeUndefined();
  pick('seg-3'); fireEvent.click(box('seg-3').querySelector('[data-movie-lora-remove]')!);
  expect(box('seg-3').querySelector('[data-movie-lora]')).toBeNull();
});

it('a LoRA or model that is no longer installed blocks that shot with its name', async () => {
  llmReply = chainReply; llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  const onPrepare = vi.fn();
  const ui = (models: unknown[]) => <I18nProvider><MovieMaker root="/env" models={models as any} onPrepare={onPrepare}/></I18nProvider>;
  const view = render(ui([h3, loraA]));
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-apply]'));
  fireEvent.click(inScene('seg-3', '[data-movie-lora-add]'));
  view.rerender(ui([h3]));
  fireEvent.click(inScene('seg-3', '[data-movie-shot-make]'));
  expect(q('[data-movie-error]').textContent).toBe('A LoRA chosen for this shot is not installed: MiniMaxH3/style-a.safetensors');
  expect(document.querySelector('[data-movie-shot-settings="seg-3"] [data-movie-lora-name] option')!.textContent).toContain('not installed');
  expect(onPrepare).not.toHaveBeenCalled();
});

it('reference mode: the music goes to H3 as each cut shot\'s slice of the track (no mix), chains are refused, the mix says why it is off', async () => {
  let m = applyPlan(setBrief(newMovie('movie-r', 'Film'), { story: 's' }), { lore: 'L', segments: JSON.parse(chainReply).segments.map((x: any) => ({ ...x, dialogue: [] })) });
  m = setSceneInputs(m, 'seg-3', { refs: [{ path: '/pics/anna.png', media: 'image', mediaMode: 'video', second: 0, strength: 1 }] });
  stored[m.id] = JSON.stringify(m);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_movie_pick_music') return '/music/bed.flac';
    if (command === 'native_movie_music_info') return { seconds: 40 };
    return null;
  });
  const onPrepare = vi.fn();
  render(<I18nProvider><MovieMaker root="/env" models={[h3] as any} onPrepare={onPrepare}/></I18nProvider>);
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-music-card]')).toBeTruthy());
  openCard('music');
  await waitFor(() => expect(q('[data-movie-music]')).toBeTruthy());
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(q('[data-movie-music-file]').textContent).toBe('bed.flac'));
  fireEvent.change(q('[data-movie-mix-mode]'), { target: { value: 'h3-reference' } });
  expect(q('[data-movie-mix="levelDb"]')).toBeNull(); // mix settings do not apply in this mode
  expect(q('[data-movie-music-hint]').textContent).toContain('audio reference');
  expect(q('[data-movie-music-blocked]').textContent).toBe('This movie uses the H3-reference mode, which does not mix.');
  await waitFor(() => expect(calls('native_movie_music_info')).toHaveLength(1));
  // The chain of seg-1 + seg-2 cannot take the music as a reference.
  fireEvent.click(inScene('seg-1', '[data-movie-shot-prepare]'));
  expect(q('[data-movie-error]').textContent).toContain('Chains of continued shots cannot take the music');
  expect(onPrepare).not.toHaveBeenCalled();
  // The cut scene seg-3 gets its slice: it starts where the chain ends (124 + 102 frames = 9.417 s).
  fireEvent.click(inScene('seg-3', '[data-movie-shot-prepare]'));
  const h = onPrepare.mock.calls[0][0];
  expect(h).toMatchObject({ strategy: 'seg-3', pipeline: 'ref2v', videoRefs: [{ path: '/pics/anna.png' }], audioRef: { name: 'bed.flac', path: '/music/bed.flac', trimStart: 9.417, trimEnd: 14.417 } });
  // Back to the mix: normal hand-over without an audio reference.
  openCard('music');
  fireEvent.change(q('[data-movie-mix-mode]'), { target: { value: 'mix' } });
  fireEvent.click(inScene('seg-3', '[data-movie-shot-prepare]'));
  expect(onPrepare.mock.calls[1][0].audioRef).toBeUndefined();
});

it('the low-effort path: throw media in, have pictures described, and the suggested plan places them on the scene cards', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' }))));
  const entries = [{ name: 'anna.png', path: '/in/anna.png', kind: 'file', media: 'image', symlink: false, size: 1, modified: 2 }];
  const described: Record<string, any>[] = [];
  llmBase = 'http://127.0.0.1:11434'; generated = [];
  llmReply = JSON.stringify({ lore: 'L', segments: [
    { title: 'Arrival', prompt: 'Anna in a red coat arrives', seconds: 5, continuous: false, inputs: [{ media: 'm1', role: 'reference' }] },
    { title: 'Door', prompt: 'The door closes behind Anna', seconds: 4, continuous: true },
  ] });
  planMock([{ id: 'qwen-vl', provider: 'ollama', name: 'qwen-vl' }]);
  const previous = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_media_list') return { path: '/in', parent: '/', entries, truncated: false };
    if (command === 'native_media_thumbnail') return (args as any).path;
    if (command === 'native_analysis_describe') { described.push(args as any); return { text: 'x', description: 'A woman in a red coat', characters: [], suggested: [], unknown: [], doubtful: '', cast: [], stopped: false }; }
    return previous(command, args);
  });
  render(<I18nProvider><MovieMaker root="/env" mediaRoots={{ input: '/in', output: '/out' }} models={[h3] as any} onPrepare={vi.fn()}/></I18nProvider>);
  // The order of steps is visible; nothing is done yet.
  expect([...document.querySelectorAll('[data-movie-step]')].map(x => [x.getAttribute('data-movie-step'), x.className])).toEqual([['idea', 'is-next'], ['plan', ''], ['scenes', ''], ['film', '']]);
  expect(q('[data-movie-next]').textContent).toBe('Next: write your idea in a few words, or add media.');
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna comes home.' } });
  expect(q('[data-movie-step="idea"]').className).toBe('is-done');
  expect(q('[data-movie-step="plan"]').className).toBe('is-next');
  // Throw a picture in through Generate's media panel.
  fireEvent.click(q('[data-movie-media-add]'));
  const dialog = await waitFor(() => { const d = document.querySelector('dialog[open]') as HTMLElement; expect(d).toBeTruthy(); return d; });
  fireEvent.click(await waitFor(() => { const b = [...dialog.querySelectorAll('button')].find(x => x.textContent?.includes('anna.png') || x.getAttribute('title') === 'anna.png' || x.getAttribute('aria-label') === 'anna.png'); expect(b).toBeTruthy(); return b as HTMLElement; }));
  fireEvent.click(dialog.querySelector('[data-video-role="movie"]')!);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(q('[data-movie-media-item="/in/anna.png"]')).toBeTruthy();
  // No note written: the chosen model describes the picture (Media Analysis' describe command); only the text is kept.
  await waitFor(() => expect(q('[data-movie-media-describe]')).toBeTruthy());
  fireEvent.click(q('[data-movie-media-describe]'));
  await waitFor(() => expect(q('[data-movie-media-note-preview]').textContent).toBe('A woman in a red coat'));
  expect([described[0].root, described[0].model]).toEqual(['/env', 'qwen-vl']);
  // Suggest the plan: the request carries the description, never the file; applying places the picture on scene 1.
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  expect(generated[0].request.prompt).toContain('m1. picture — A woman in a red coat');
  expect(generated[0].request.prompt).not.toContain('anna.png');
  fireEvent.click(q('[data-movie-plan-apply]'));
  expect(q('[data-movie-scene-card="seg-1"] [data-scene-mark="image"]')).toBeTruthy();
  expect((q('[data-movie-transition="seg-2"]') as HTMLSelectElement).value).toBe('seamless');
  expect(q('[data-movie-scene-card="seg-1"] [data-movie-scene-name]').textContent).toBe('Arrival');
  // Rename on the card with a short field.
  fireEvent.click(q('[data-movie-scene-rename="seg-1"]'));
  const field = q('[data-movie-scene-rename-field]') as HTMLInputElement;
  expect(field.maxLength).toBe(40);
  fireEvent.change(field, { target: { value: 'Coming home' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(q('[data-movie-scene-card="seg-1"] [data-movie-scene-name]').textContent).toBe('Coming home');
  // A card opens its settings in a non-blocking panel: the page stays editable, Escape closes it.
  pick('seg-1');
  expect(q('[data-movie-panel="scene"]').getAttribute('aria-modal')).toBe('false');
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna comes home late.' } });
  expect((q('[data-movie-story]') as HTMLTextAreaElement).value).toBe('Anna comes home late.');
  fireEvent.change(inScene('seg-1', '[data-movie-seg-seconds]'), { target: { value: '6' } });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(q('[data-movie-panel]')).toBeNull();
  // Music is its own lane and card, distinct from the scenes.
  expect(q('[data-movie-lane="music"] [data-movie-music-card]')).toBeTruthy();
  vi.unstubAllGlobals();
});

it('Make the movie runs every scene one after another, stitches the film, and a scene remade later is stitched in again by itself', async () => {
  let m = applyPlan(setBrief(newMovie('movie-run', 'Film'), { story: 's' }), { lore: 'L', segments: [
    { title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] }, { title: 'B', prompt: 'b', seconds: 4, continuous: false, dialogue: [] }] });
  stored[m.id] = JSON.stringify(m);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[(args as any).id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    return null;
  });
  const joins: string[][] = [];
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 9 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async intent => { joins.push((intent.h3.join as any).files.map((f: any) => f.filename)); return { id: `j${joins.length}`, state: 'running', outputs: [] }; },
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: `film${joins.length}.mp4`, subfolder: 'video' }] }),
    stitch: async () => { throw new Error('no blend'); },
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-run]')).toBeTruthy());
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'seg-1', run: true });
  expect(q('[data-movie-run-step]').textContent).toContain('A');
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j1' }, picture: vid('/out/a.mp4') } }, 1));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2)); // the next scene starts by itself
  expect(onPrepare.mock.calls[1][0]).toMatchObject({ strategy: 'seg-2', run: true });
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'j2' }, picture: vid('/out/b.mp4') } }, 2));
  await waitFor(() => expect(joins).toEqual([['/out/a.mp4', '/out/b.mp4']])); // then the film
  await waitFor(() => expect(q('[data-movie-note]')?.textContent).toBe('The movie is made.'));
  expect(stateOf('seg-1')).toBe('made');
  expect(q('[data-movie-film-card]').textContent).toContain('made');
  // Remake one scene on its own: the film is stitched again without asking.
  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  view.rerender(ui({ n: 3, run: { state: 'succeeded', job: { id: 'j3' }, picture: vid('/out/b2.mp4') } }, 3));
  await waitFor(() => expect(joins).toEqual([['/out/a.mp4', '/out/b.mp4'], ['/out/a.mp4', '/out/b2.mp4']]));
  expect(onPrepare).toHaveBeenCalledTimes(3);
});

it('a medium has its own movable panel: shown whole, full note, used in several scenes with a role and label, binding, and can be dragged onto a scene card', async () => {
  // jsdom has no PointerEvent; the WebViews do. Without it a pointer event carries no coordinates.
  if (!('PointerEvent' in window)) vi.stubGlobal('PointerEvent', class extends MouseEvent { isPrimary = true; });
  let m = applyPlan(setBrief(newMovie('movie-med', 'Film'), { story: 's' }), { lore: 'L', segments: [
    { title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] }, { title: 'B', prompt: 'b', seconds: 5, continuous: false, dialogue: [] }, { title: 'C', prompt: 'c', seconds: 5, continuous: false, dialogue: [] }] });
  m = { ...m, media: [{ path: '/in/anna.png', media: 'image' }, { path: '/in/door.png', media: 'image' }] };
  m = setSceneInputs(m, 'seg-3', { first: { path: '/in/door.png', media: 'image' } });
  stored[m.id] = JSON.stringify(m);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[(args as any).id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    return null;
  });
  render(<I18nProvider><MovieMaker root="/env" models={[h3] as any} onPrepare={vi.fn()}/></I18nProvider>);
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-media-item="/in/anna.png"]')).toBeTruthy());
  expect(q('[data-movie-media-item="/in/anna.png"] [data-movie-media-used]').textContent).toBe('Auto — the plan places it');
  expect(q('[data-movie-media-item="/in/door.png"] [data-movie-media-used]').textContent).toBe('In C · First frame');
  fireEvent.click(q('[data-movie-media-open="/in/anna.png"]'));
  const panel = q('[data-movie-panel="media"]');
  expect(panel.getAttribute('aria-modal')).toBe('false');
  expect(panel.getAttribute('style')).toBeNull(); // opens where the shared overlay style centers it
  // Shown whole in the preview player; clicking it opens the full-window viewer.
  fireEvent.click(panel.querySelector('[data-movie-media-player] .movie-player-picture')!);
  expect(document.querySelector('.wb-viewer')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  // A full note field.
  fireEvent.change(panel.querySelector('[data-movie-media-note]')!, { target: { value: 'Anna, red coat, short dark hair' } });
  expect(q('[data-movie-media-item="/in/anna.png"] [data-movie-media-note-preview]').textContent).toBe('Anna, red coat, short dark hair');
  // Use in several scenes, as a reference with a Director label.
  const role = () => q('[data-movie-media-role]') as HTMLSelectElement;
  expect([...role().options].map(o => o.value)).toEqual(['reference', 'first', 'last']);
  fireEvent.click(q('[data-movie-media-scene="seg-1"]'));
  fireEvent.click(q('[data-movie-media-scene="seg-2"]'));
  fireEvent.change(q('[data-movie-media-label]'), { target: { value: 'character-1' } });
  expect(q('[data-movie-scene-card="seg-1"] [data-scene-mark="image"]')).toBeTruthy();
  expect(q('[data-movie-scene-card="seg-2"] [data-scene-mark="image"]')).toBeTruthy();
  expect(q('[data-movie-media-item="/in/anna.png"] [data-movie-media-used]').textContent).toBe('In A, B · Reference');
  expect((q('[data-movie-media-auto]') as HTMLInputElement).checked).toBe(false);
  // H3 does not mix: scene C holds a first frame, so a reference is refused there with the reason.
  fireEvent.click(q('[data-movie-media-scene="seg-3"]'));
  expect(q('[data-movie-media-refused]').textContent).toContain('Not used in C');
  expect((q('[data-movie-media-scene="seg-3"]') as HTMLInputElement).checked).toBe(false);
  // The panel moves by its title bar.
  const bar = q('[data-movie-panel-bar]');
  fireEvent.pointerDown(bar, { button: 0, clientX: 100, clientY: 100 });
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 140 }));
  window.dispatchEvent(new MouseEvent('pointerup'));
  await waitFor(() => expect(q('[data-movie-panel="media"]').getAttribute('style')).toContain('left'));
  // Back to Auto takes it out of every scene.
  fireEvent.click(q('[data-movie-media-auto]'));
  expect(q('[data-movie-scene-card="seg-1"] [data-scene-no-inputs]')).toBeTruthy();
  // Drag the medium onto scene B's card.
  const target = q('[data-movie-scene-card="seg-2"]');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target }); // jsdom has no hit testing
  fireEvent.pointerDown(q('[data-movie-media-open="/in/anna.png"]'), { button: 0, clientX: 10, clientY: 10, isPrimary: true });
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300 }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 300, clientY: 300 }));
  await waitFor(() => expect(q('[data-movie-media-item="/in/anna.png"] [data-movie-media-used]').textContent).toBe('In B · Reference'));
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(calls('native_movie_save')).toHaveLength(1));
  const saved = JSON.parse(calls('native_movie_save')[0].manifest as string);
  expect(saved.items.find((i: any) => i.id === 'seg-2').inputs.refs[0]).toMatchObject({ path: '/in/anna.png', label: 'character-1', description: 'Anna, red coat, short dark hair' });
  expect(saved.media[0]).toMatchObject({ path: '/in/anna.png', label: 'character-1', note: 'Anna, red coat, short dark hair' });
  vi.unstubAllGlobals();
});

it('the proposal shows every planned scene in full — text, length, lines, start/end, status — and the story bible, before anything changes', async () => {
  llmReply = JSON.stringify({ lore: 'A chase at dusk.', segments: [
    { title: 'Start', prompt: 'Wide shot, Anna runs', seconds: 10, continuous: false, entry: 'dusk street', exit: 'alley mouth', dialogue: [{ speaker: 'Anna', line: 'Stop!', delivery: 'shouted' }] },
    { title: 'Catch', prompt: 'Close up of Anna', seconds: 5, continuous: true },
  ] }); llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  await prepare();
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-preview]')).toBeTruthy());
  expect(document.querySelectorAll('[data-movie-scene-card]')).toHaveLength(0); // nothing applied yet
  expect(q('[data-movie-plan-bible]').textContent).toContain('A chase at dusk.');
  const one = q('[data-movie-plan-scene="1"]');
  expect(one.getAttribute('data-movie-plan-status')).toBe('new');
  expect(one.textContent).toContain('Start');
  expect(one.querySelector('[data-movie-plan-prompt]')!.textContent).toBe('Wide shot, Anna runs');
  expect(one.textContent).toContain('10 s (H3 makes 10.13 s)');
  expect(one.textContent).toContain('At the start: dusk street');
  expect(one.textContent).toContain('At the end: alley mouth');
  expect(one.querySelector('[data-movie-plan-lines]')!.textContent).toBe('Anna: “Stop!” (shouted)');
  expect(q('[data-movie-plan-scene="2"]').textContent).toContain('Seamless');
  expect(q('[data-movie-plan-preview]').textContent).toContain('2 scenes · the film will be 15.08 s');
  fireEvent.click(q('[data-movie-plan-apply]'));
  expect(document.querySelectorAll('[data-movie-scene-card]')).toHaveLength(2);
  // Planning again: a changed scene says what it was.
  llmReply = JSON.stringify({ lore: 'A chase at dusk.', segments: [{ title: 'Start', prompt: 'Aerial shot, Anna runs', seconds: 10, continuous: false }, { title: 'Catch', prompt: 'Close up of Anna', seconds: 5, continuous: true }] });
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-scene="1"]')?.getAttribute('data-movie-plan-status')).toBe('changed'));
  expect(q('[data-movie-plan-scene="1"] [data-movie-plan-before]').textContent).toContain('Wide shot, Anna runs');
  expect(q('[data-movie-plan-scene="2"]').getAttribute('data-movie-plan-status')).toBe('same');
});

it('generation settings sit beside the aspect: the movie\'s resolution, Steps and CFG at the model\'s starting values, or Generate\'s own', async () => {
  const onPrepare = vi.fn();
  render(<I18nProvider><MovieMaker root="/env" models={[h3Base, h3] as any} onPrepare={onPrepare}/></I18nProvider>);
  expect((q('[data-movie-render-source]') as HTMLSelectElement).value).toBe('movie');
  const res = [...q('[data-movie-render-resolution]').querySelectorAll('option')].map(o => (o as HTMLOptionElement).value);
  expect(res.slice(0, 3)).toEqual(['model', '144p', '240p']); expect(res).toContain('720p'); expect(res).not.toContain('fixed'); expect(res).not.toContain('custom');
  // The Turbo file is the default model: its starting values, said so, at the exact 16:9 H3 canvas.
  expect([(q('[data-movie-render-steps]') as HTMLInputElement).value, (q('[data-movie-render-cfg]') as HTMLInputElement).value]).toEqual(['8', '1']);
  expect(q('[data-movie-render-note]').textContent).toBe('Each shot: 1152×672 · 8 steps · CFG 1 · res_multistep / simple — default model: h3_turbo.safetensors. Starting values for a turbo model (recognised from the file name); a scene with another model uses that model\'s values.');
  fireEvent.change(q('[data-movie-render-resolution]'), { target: { value: '720p' } });
  fireEvent.change(q('[data-movie-render-steps]'), { target: { value: '12' } });
  expect(q('[data-movie-render-note]').textContent).toContain('1248×736 · 12 steps · CFG 1');
  fireEvent.click(q('[data-movie-render-reset]'));
  expect((q('[data-movie-render-steps]') as HTMLInputElement).value).toBe('8');
  expect(q('[data-movie-render-reset]')).toBeNull();
  // Another default model brings its own starting values.
  fireEvent.click(q('[data-movie-scene-add]'));
  fireEvent.change(q('[data-movie-shot-model]'), { target: { value: 'h3_base.safetensors' } });
  expect([(q('[data-movie-render-steps]') as HTMLInputElement).value, (q('[data-movie-render-cfg]') as HTMLInputElement).value]).toEqual(['30', '3']);
  // A scene with its own model shows that model's values as what an empty field means, and can set its own.
  fireEvent.change(inScene('seg-1', '[data-movie-shot-own-model]'), { target: { value: 'h3_turbo.safetensors' } });
  expect((inScene('seg-1', '[data-movie-shot-steps]') as unknown as HTMLInputElement).placeholder).toBe('8');
  fireEvent.change(inScene('seg-1', '[data-movie-shot-steps]'), { target: { value: '6' } });
  fireEvent.click(inScene('seg-1', '[data-movie-shot-prepare]'));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ model: { path: '/m/h3_turbo' }, size: { width: 1248, height: 736 }, sampling: { steps: 6, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' } });
  // Generate's own settings: only the aspect goes over, and the row says so.
  fireEvent.change(q('[data-movie-render-source]'), { target: { value: 'generate' } });
  expect(q('[data-movie-render-steps]')).toBeNull();
  expect(q('[data-movie-render-note]').textContent).toContain('Only the aspect ratio comes from the movie.');
  fireEvent.click(inScene('seg-1', '[data-movie-shot-prepare]'));
  const h = onPrepare.mock.calls[1][0];
  expect([h.aspect, h.size, h.sampling, h.resolution]).toEqual(['16:9', undefined, undefined, undefined]);
});

it('music in step 1: instrumental presets in the model\'s dialect with their tempo, own lyrics, and the planner can write the music', async () => {
  llmReply = JSON.stringify({ music: { style: 'synthwave, female vocal, English', bpm: 110, lyrics: '[Verse]\nNeon rain' } }); llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  render(<I18nProvider><MovieMaker root="/env" models={[yue] as any}/></I18nProvider>);
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs through neon rain.' } });
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  const names = [...q('[data-movie-music-preset]').querySelectorAll('option')].map(o => o.textContent);
  expect(names).toContain('Cinematic orchestral'); expect(names[0]).toBe('— own description —');
  fireEvent.change(q('[data-movie-music-preset]'), { target: { value: 'noir-jazz' } });
  // Only YuE2 is installed: the preset reads as a YuE2 Style line; YuE2 has no tempo control.
  expect((q('[data-movie-music-prompt]') as HTMLTextAreaElement).value).toBe('Instrumental, noir jazz, 85 BPM, smoky muted trumpet, upright bass, brushed drums, late night, moody, no vocals');
  expect(q('[data-movie-music-bpm]')).toBeNull();
  // Editing the text leaves the preset ("own description").
  fireEvent.change(q('[data-movie-music-prompt]'), { target: { value: 'noir jazz, slower' } });
  expect((q('[data-movie-music-preset]') as HTMLSelectElement).value).toBe('');
  fireEvent.change(q('[data-movie-music-prompt]'), { target: { value: '' } });
  fireEvent.click(q('[data-movie-music-vocals]'));
  fireEvent.click(q('[data-movie-music-write]'));
  await waitFor(() => expect(q('[data-movie-music-proposal]')).toBeTruthy());
  expect(generated[0].request.system).toContain('"lyrics": string');
  expect(generated[0].request.prompt).toContain('Anna runs through neon rain.');
  expect(q('[data-movie-music-proposal]').textContent).toContain('synthwave, female vocal, English');
  expect(q('[data-movie-music-proposal]').textContent).toContain('Neon rain');
  fireEvent.click(q('[data-movie-music-apply]'));
  expect((q('[data-movie-music-prompt]') as HTMLTextAreaElement).value).toBe('synthwave, female vocal, English');
  expect((q('[data-movie-music-lyrics]') as HTMLTextAreaElement).value).toBe('[Verse]\nNeon rain');
  expect(q('[data-movie-music-proposal]')).toBeNull();
});

it('ACE-Step music shows tempo and, for lyrics, the lyrics language; a preset sets its tempo', async () => {
  render(<I18nProvider><MovieMaker root="/env" models={[ace] as any}/></I18nProvider>);
  fireEvent.change(q('[data-movie-music-preset]'), { target: { value: 'ambient' } });
  expect((q('[data-movie-music-prompt]') as HTMLTextAreaElement).value).toBe('ambient, instrumental, warm synth pads, soft evolving textures, slow, calm, spacious reverb');
  expect((q('[data-movie-music-bpm]') as HTMLInputElement).value).toBe('70');
  expect(q('[data-movie-music-language]')).toBeNull();
  fireEvent.change(q('[data-movie-music-lyrics]'), { target: { value: '[Verse] la' } });
  fireEvent.change(q('[data-movie-music-language]'), { target: { value: 'de' } });
  expect((q('[data-movie-music-language]') as HTMLSelectElement).value).toBe('de');
});

it('the movie survives leaving the tab or restarting: the working draft is restored, and New clears it', async () => {
  const first = render(<I18nProvider><MovieMaker/></I18nProvider>);
  fireEvent.change(q('[data-movie-title]'), { target: { value: 'Keep me' } });
  fireEvent.click(q('[data-movie-scene-add]'));
  first.unmount();
  render(<I18nProvider><MovieMaker/></I18nProvider>);
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Keep me');
  expect(document.querySelectorAll('[data-movie-scene-card]')).toHaveLength(1);
  expect(q('[data-movie-note]').textContent).toBe('Your unsaved movie was restored.');
  expect(q('[data-movie-dirty]')).toBeTruthy();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(q('[data-movie-new]'));
  cleanup();
  render(<I18nProvider><MovieMaker/></I18nProvider>);
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('');
});

it('removing a made scene asks first; cancelling keeps it, an unmade one goes without a question', async () => {
  let m = applyPlan(setBrief(newMovie('mm', 'F'), { story: 's' }), { lore: 'l', segments: [{ title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] }, { title: 'B', prompt: 'b', seconds: 5, continuous: false, dialogue: [] }] });
  m = completeItem(m, 'seg-1', { outputId: '/out/a.mp4' });
  localStorage.setItem('deas.pref.wizards.movie.draft', JSON.stringify({ movie: m, dirty: true }));
  view();
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(q('[data-movie-scene-remove="seg-1"]'));
  expect(ask).toHaveBeenCalledWith('A is already made. Remove it from the movie? Its clip file stays on disk.');
  expect(document.querySelectorAll('[data-movie-scene-card]')).toHaveLength(2);
  ask.mockClear();
  fireEvent.click(q('[data-movie-scene-remove="seg-2"]'));
  expect(ask).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('[data-movie-scene-card]')].map(c => c.getAttribute('data-movie-scene-card'))).toEqual(['seg-1']);
  ask.mockReturnValue(true);
  fireEvent.click(q('[data-movie-scene-remove="seg-1"]'));
  expect(q('[data-movie-scenes-empty]')).toBeTruthy();
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

it('shares one generation slot across scene, chain and music handoffs, defers New/Open while a stage is active, and keeps stitch Stop reachable', async () => {
  let mA = applyPlan(setBrief(newMovie('movie-a', 'Movie A'), { story: 's' }), { lore: 'l', segments: [
    { title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] },
    { title: 'B', prompt: 'b', seconds: 5, continuous: false, dialogue: [] },
  ] });
  mA = setMusicPrompt(completeItem(mA, 'seg-1', { outputId: '/out/a.mp4', seconds: 5 }), 'calm piano');
  const mB = applyPlan(setBrief(newMovie('movie-b', 'Movie B'), { story: 's' }), { lore: 'l', segments: [
    { title: 'One', prompt: 'one', seconds: 5, continuous: false, dialogue: [] },
  ] });
  stored[mA.id] = JSON.stringify(mA); stored[mB.id] = JSON.stringify(mB);
  const joinWait = deferred<void>();
  vi.mocked(assembleRun.realAssembleDeps).mockImplementation((_ep, onJob) => ({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 10 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async () => { const job = { id: 'job-join', state: 'running', outputs: [] } as any; onJob(job); return job; },
    wait: async j => { await joinWait.promise; return { ...j, state: 'cancelled', outputs: [] }; },
    stitch: async () => { throw new Error('no blend'); },
  }));
  vi.mocked(assembleRun.stopAssemblyJob).mockResolvedValue(undefined as any);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const x = JSON.parse(text); return { id, title: x.title, items: x.items.length, targetSeconds: x.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    throw new Error('unexpected ' + String(command));
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3, ace] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-open="movie-a"]'); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Movie A'));

  // 1. Scene generation in flight blocks music Prepare/Generate, other scene Prepare/Make, and New/Open, while navigation stays usable.
  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  openCard('music');
  expect((q('[data-movie-music-prepare]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-music-generate]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(q('[data-movie-music-generate]'));
  expect((inScene('seg-1', '[data-movie-shot-prepare]') as HTMLButtonElement).disabled).toBe(true);
  expect((inScene('seg-1', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-open="movie-b"]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(q('[data-movie-new]'));
  fireEvent.click(q('[data-movie-open="movie-b"]'));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Movie A');
  view.rerender(ui({ n: 1, run: { state: 'failed', error: 'stopped' } }, 1));
  await waitFor(() => expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(false));

  // 2. Music generation in flight likewise blocks scene Prepare/Make and New/Open until the music run settles.
  openCard('music');
  fireEvent.click(q('[data-movie-music-generate]'));
  expect(onPrepare).toHaveBeenCalledTimes(2);
  expect((inScene('seg-1', '[data-movie-shot-prepare]') as HTMLButtonElement).disabled).toBe(true);
  expect((inScene('seg-1', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(inScene('seg-1', '[data-movie-shot-prepare]'));
  expect(onPrepare).toHaveBeenCalledTimes(2);
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'jm' }, picture: { path: '/out/bed.flac', audio: true, width: 0, height: 0, seed: 1, checkpoint: 'ace' } } }, 2));
  await waitFor(() => expect((inScene('seg-2', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(false));

  // 3. Active stitch keeps its handle and Stop button reachable, defers New/Open until settled, then releases cleanly.
  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  view.rerender(ui({ n: 3, run: { state: 'succeeded', job: { id: 'j2' }, picture: vid('/out/b.mp4') } }, 3));
  openCard('film');
  await waitFor(() => expect(q('[data-movie-film-stop]')).toBeTruthy());
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-open="movie-b"]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(q('[data-movie-new]'));
  pick('seg-1'); openCard('film'); // navigation remains available and Stop stays reachable
  expect(q('[data-movie-film-stop]')).toBeTruthy();
  fireEvent.click(q('[data-movie-film-stop]'));
  expect(assembleRun.stopAssemblyJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-join' }));
  await act(async () => { joinWait.resolve(); await joinWait.promise; });
  await waitFor(() => expect((q('[data-movie-open="movie-b"]') as HTMLButtonElement).disabled).toBe(false));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(q('[data-movie-open="movie-b"]'));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Movie B'));
  expect(onPrepare).toHaveBeenCalledTimes(3);
});

it('deferred scene and chain completions reject revised/replaced scenes, changed later-scene chain references and changed H3 audio-reference inputs', async () => {
  let mA = applyPlan(setBrief(newMovie('movie-a', 'Movie A'), { story: 's' }), { lore: 'l', segments: [
    { title: 'A', prompt: 'v1', seconds: 5, continuous: false, dialogue: [] },
    { title: 'B', prompt: 'b', seconds: 5, continuous: false, dialogue: [] },
  ] });
  mA = addMedia(completeItem(mA, 'seg-1', { outputId: '/out/a-v1.mp4', jobId: 'job-v1', seconds: 5 }), [{ path: '/pics/ben.png', media: 'image', note: 'Ben' }]);
  let mRef = applyPlan(setBrief(newMovie('movie-ref', 'Ref Movie'), { story: 's' }), { lore: 'l', segments: [
    { title: 'One', prompt: 'one', seconds: 5, continuous: false, dialogue: [] },
    { title: 'Two', prompt: 'two', seconds: 5, continuous: false, dialogue: [] },
  ] });
  mRef = setSceneInputs(mRef, 'seg-2', { refs: [{ path: '/pics/anna.png', media: 'image', mediaMode: 'video', second: 0, strength: 1 }] });
  mRef = setMix(setMusicFile(mRef, '/music/bed.flac'), { mode: 'h3-reference' });
  stored[mA.id] = JSON.stringify(mA); stored[mRef.id] = JSON.stringify(mRef);
  const joins: string[][] = [];
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 10 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async intent => { joins.push((intent.h3.join as any).files.map((f: any) => f.filename)); return { id: 'jf', state: 'running', outputs: [] }; },
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film.mp4', subfolder: 'video' }] }),
    stitch: async () => { throw new Error('no blend'); },
  });
  const onPrepare = vi.fn();
  let musicPathPick = '/music/other.flac';
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const x = JSON.parse(text); return { id, title: x.title, items: x.items.length, targetSeconds: x.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_save') { const x = JSON.parse(a.manifest); stored[x.id] = a.manifest; return x.id; }
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    if (command === 'native_movie_music_info') return { seconds: 40 };
    if (command === 'native_movie_pick_music') return musicPathPick;
    throw new Error('unexpected ' + String(command));
  });
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-open="movie-a"]'); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Movie A'));

  // 1. Edited scene revision: rev 2 starts, user edits to rev 3 before rev 2 finishes -> stale rev 2 result is ignored, rev 1 history stays.
  fireEvent.change(inScene('seg-1', '[data-movie-seg-prompt]'), { target: { value: 'v2' } });
  fireEvent.click(inScene('seg-1', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  view.rerender(ui({ n: 1, run: { state: 'running', job: { id: 'job-v2' } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('making …'));
  fireEvent.change(inScene('seg-1', '[data-movie-seg-prompt]'), { target: { value: 'v3' } });
  expect(stateOf('seg-1')).toBe('not made');
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'job-v2' }, picture: vid('/out/a-v2.mp4') } }, 1));
  expect(stateOf('seg-1')).toBe('not made');
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(q('[data-movie-dirty]')).toBeNull());
  const savedSeg1 = JSON.parse(calls('native_movie_save')[0].manifest as string).items.find((i: any) => i.id === 'seg-1');
  expect([savedSeg1.state, savedSeg1.revision, savedSeg1.revisions.find((r: any) => r.n === 3)?.result]).toEqual(['planned', 3, undefined]);
  expect(savedSeg1.revisions.find((r: any) => r.n === 1)?.result).toEqual({ outputId: '/out/a-v1.mp4', jobId: 'job-v1', seconds: 5 });

  // 2. Replaced scene (same `seg-2` id and revision 1): late completion for the removed scene does not complete the new `seg-2`.
  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(2);
  fireEvent.change(inScene('seg-2', '[data-movie-seg-prompt]'), { target: { value: 'discarded' } });
  fireEvent.click(q('[data-movie-scene-remove="seg-2"]'));
  pick('seg-1'); fireEvent.click(q('[data-movie-scene-add]'));
  expect(q('[data-movie-scene-card="seg-2"]')).toBeTruthy();
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'job-seg2-old' }, picture: vid('/out/seg2-old.mp4') } }, 2));
  expect(stateOf('seg-2')).toBe('not made');

  // 3. Continuity chain: removing a later scene's reference invalidates even step 0 (`seg-1`), while an unchanged chain completes per step.
  fireEvent.change(q('[data-movie-transition="seg-2"]'), { target: { value: 'seamless' } });
  fireEvent.click(q('[data-movie-media-open="/pics/ben.png"]'));
  fireEvent.click(q('[data-movie-media-scene="seg-2"]'));
  fireEvent.click(inScene('seg-1', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(3);
  expect(onPrepare.mock.calls[2][0]).toMatchObject({ pipeline: 'ref2v', videoRefs: [expect.objectContaining({ path: '/pics/ben.png' })] });
  fireEvent.click(q('[data-movie-media-open="/pics/ben.png"]'));
  fireEvent.click(q('[data-movie-media-auto]')); // removes `/pics/ben.png` from `seg-2` while `seg-1` itself is untouched
  view.rerender(ui({ n: 3, run: { state: 'succeeded', job: { id: 'jc1' }, picture: vid('/out/c1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 3));
  view.rerender(ui({ n: 3, run: { state: 'succeeded', job: { id: 'jc2' }, picture: vid('/out/c2.mp4'), step: { index: 1, shotId: 'seg-2', total: 2 } } }, 3));
  expect([stateOf('seg-1'), stateOf('seg-2'), joins.length]).toEqual(['not made', 'not made', 0]);

  fireEvent.click(q('[data-movie-media-open="/pics/ben.png"]'));
  fireEvent.click(q('[data-movie-media-scene="seg-2"]'));
  fireEvent.click(inScene('seg-1', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(4);
  view.rerender(ui({ n: 4, run: { state: 'succeeded', job: { id: 'jc3' }, picture: vid('/out/c3.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 4));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  view.rerender(ui({ n: 4, run: { state: 'succeeded', job: { id: 'jc4' }, picture: vid('/out/c4.mp4'), step: { index: 1, shotId: 'seg-2', total: 2 } } }, 4));
  await waitFor(() => expect(stateOf('seg-2')).toBe('made'));
  await waitFor(() => expect(joins).toEqual([['/out/c3.mp4', '/out/c4.mp4']]));
  await waitFor(() => expect((q('[data-movie-open="movie-ref"]') as HTMLButtonElement).disabled).toBe(false));

  // 4. H3 audio-reference mode: changing an earlier scene's length or the music file invalidates the in-flight shot's audio slice.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(q('[data-movie-open="movie-ref"]'));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Ref Movie'));
  await waitFor(() => expect(calls('native_movie_music_info')).toHaveLength(1));
  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(5);
  expect(onPrepare.mock.calls[4][0]).toMatchObject({ audioRef: { path: '/music/bed.flac', trimStart: 5.167, trimEnd: 10.167 } });
  fireEvent.change(inScene('seg-1', '[data-movie-seg-seconds]'), { target: { value: '8' } });
  view.rerender(ui({ n: 5, run: { state: 'succeeded', job: { id: 'jr5' }, picture: vid('/out/ref-stale-trim.mp4') } }, 5));
  expect(stateOf('seg-2')).toBe('not made');

  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(6);
  openCard('music');
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(q('[data-movie-music-file]')?.textContent).toBe('other.flac'));
  view.rerender(ui({ n: 6, run: { state: 'succeeded', job: { id: 'jr6' }, picture: vid('/out/ref-stale-track.mp4') } }, 6));
  expect(stateOf('seg-2')).toBe('not made');
});

it('deferred film and mix completions do not mark the draft complete after assembly inputs or mix settings changed, releasing the slot when settled', async () => {
  const mJoin = filmMovie(true);
  const mMix = setMusicFile(scoredMovie(true), '/music/bed.wav');
  const mMixId = 'movie-mix';
  stored[mJoin.id] = JSON.stringify(mJoin);
  stored[mMixId] = JSON.stringify({ ...mMix, id: mMixId, title: 'Mix Movie' });
  const joinWaits: ReturnType<typeof deferred<string>>[] = [];
  const mixWaits: ReturnType<typeof deferred<{ path: string; seconds: number; ducked: boolean }>>[] = [];
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 10 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async () => ({ id: `jf-${joinWaits.length + 1}`, state: 'running', outputs: [] }),
    wait: async j => { const d = deferred<string>(); joinWaits.push(d); const file = await d.promise; return { ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: file, subfolder: 'video' }] }; },
    stitch: async () => { throw new Error('no blend'); },
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const x = JSON.parse(text); return { id, title: x.title, items: x.items.length, targetSeconds: x.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    if (command === 'native_movie_mix') { const d = deferred<{ path: string; seconds: number; ducked: boolean }>(); mixWaits.push(d); return d.promise; }
    throw new Error('unexpected ' + String(command));
  });
  render(<I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3] as any} onPrepare={vi.fn()}/></I18nProvider>);
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${mJoin.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-film-card]')).toBeTruthy());
  openCard('film');
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-film-run]'); expect((b as HTMLButtonElement).disabled).toBe(false); return b; }));
  await waitFor(() => expect(joinWaits).toHaveLength(1));
  expect(q('[data-movie-film-progress]')).toBeTruthy();
  expect(q('[data-movie-film-stop]')).toBeTruthy();
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  // Editing a scene changes the assembly inputs while the join is in flight; its late completion must not mark the film made.
  fireEvent.change(inScene('seg-2', '[data-movie-seg-prompt]'), { target: { value: 'changed shot' } });
  joinWaits[0].resolve('stale-film.mp4');
  openCard('film');
  await waitFor(() => expect(q('[data-movie-film-progress]')).toBeNull());
  expect(q('[data-movie-film-video]')).toBeNull();
  expect(q('[data-movie-film-card]').textContent).toContain('not made');

  // Mix: changing levelDb while mixing keeps New/Open deferred until settled, ignores the stale mix, and then allows New movie cleanly.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(q(`[data-movie-open="${mMixId}"]`));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Mix Movie'));
  openCard('music');
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-music-run]'); expect((b as HTMLButtonElement).disabled).toBe(false); return b; }));
  await waitFor(() => expect(mixWaits).toHaveLength(1));
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(q('[data-movie-mix="levelDb"]'), { target: { value: '-20' } });
  await act(async () => {
    mixWaits[0].resolve({ path: '/out/video/stale-scored.mp4', seconds: 10, ducked: true });
    await mixWaits[0].promise;
  });
  await waitFor(() => expect((q('[data-movie-music-run]') as HTMLButtonElement).disabled).toBe(false));
  expect(q('[data-movie-scored-video]')).toBeNull();
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(q('[data-movie-new]'));
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('');
  expect([q('[data-movie-dirty]'), q('[data-movie-note]')]).toEqual([null, null]);
});

it('Stop after this step lets the active scene or Continuity chain finish and keeps its clip without starting stitch, music or mix', async () => {
  let mStop = applyPlan(setBrief(newMovie('movie-stop', 'Stop Last'), { story: 's' }), { lore: 'l', segments: [
    { title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] },
    { title: 'B', prompt: 'b', seconds: 4, continuous: false, dialogue: [] },
  ] });
  mStop = setMusicPrompt(completeItem(mStop, 'seg-1', { outputId: '/out/a.mp4', seconds: 5 }), 'calm piano');
  const mChain = applyPlan(setBrief(newMovie('movie-chain', 'Stop Chain'), { story: 's' }), { lore: 'l', segments: [
    { title: 'Start', prompt: 'a', seconds: 5, continuous: false, dialogue: [] },
    { title: 'Cont', prompt: 'b', seconds: 4, continuous: true, dialogue: [] },
  ] });
  stored[mStop.id] = JSON.stringify(mStop); stored[mChain.id] = JSON.stringify(mChain);
  const joins: string[][] = [];
  let mixes = 0;
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 9 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async intent => { joins.push((intent.h3.join as any).files.map((f: any) => f.filename)); return { id: 'jf', state: 'running', outputs: [] }; },
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film.mp4', subfolder: 'video' }] }),
    stitch: async () => { throw new Error('no blend'); },
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const x = JSON.parse(text); return { id, title: x.title, items: x.items.length, targetSeconds: x.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_save') { const x = JSON.parse(a.manifest); stored[x.id] = a.manifest; return x.id; }
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    if (command === 'native_movie_mix') { mixes++; return { path: '/out/video/scored.mp4', seconds: 9, ducked: true }; }
    throw new Error('unexpected ' + String(command));
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3, ace] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-open="movie-stop"]'); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-run]')).toBeTruthy());
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'seg-2', run: true });
  view.rerender(ui({ n: 1, run: { state: 'running', job: { id: 'j2' } } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('making …'));
  fireEvent.click(q('[data-movie-run-stop]'));
  expect(q('[data-movie-run-stop]')).toBeNull();
  expect(stateOf('seg-2')).toBe('making …'); // current stage keeps running with progress
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j2' }, picture: vid('/out/b.mp4') } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('made'));
  expect(inScene('seg-2', '[data-movie-shot-video]')).toBeTruthy();
  expect([joins.length, onPrepare.mock.calls.length, mixes]).toEqual([0, 1, 0]);
  expect(q('[data-movie-film-card]').textContent).toContain('not made');
  // Saving and reopening a movie with all scenes made and an unmade film still starts nothing.
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(q('[data-movie-dirty]')).toBeNull());
  fireEvent.click(q('[data-movie-open="movie-stop"]'));
  await waitFor(() => expect(q('[data-movie-note]')?.textContent).toBe('Opened. Nothing was started.'));
  expect([joins.length, onPrepare.mock.calls.length, mixes]).toEqual([0, 1, 0]);

  // A Continuity chain remains one wizard stage: stopping during step 0 records both shots and stops before stitching.
  fireEvent.click(q('[data-movie-open="movie-chain"]'));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Stop Chain'));
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2));
  expect(onPrepare.mock.calls[1][0]).toMatchObject({ continuity: { shotIds: ['seg-1', 'seg-2'] }, run: true });
  view.rerender(ui({ n: 2, run: { state: 'running', step: { index: 0, shotId: 'seg-1', total: 2 } } }, 2));
  await waitFor(() => expect(stateOf('seg-1')).toBe('making …'));
  fireEvent.click(q('[data-movie-run-stop]'));
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'jc1' }, picture: vid('/out/c1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 2));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'jc2' }, picture: vid('/out/c2.mp4'), step: { index: 1, shotId: 'seg-2', total: 2 } } }, 2));
  await waitFor(() => expect(stateOf('seg-2')).toBe('made'));
  expect([joins.length, onPrepare.mock.calls.length, mixes]).toEqual([0, 2, 0]);
});

it('an intentional manual scene remake with deferred results still restitches the film once', async () => {
  const m = scoredMovie(true);
  stored[m.id] = JSON.stringify(m);
  const joins: string[][] = [];
  const joinDone = deferred<void>();
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 10 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async intent => { joins.push((intent.h3.join as any).files.map((f: any) => f.filename)); return { id: `jf-${joins.length}`, state: 'running', outputs: [] }; },
    wait: async j => { await joinDone.promise; return { ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film-remade.mp4', subfolder: 'video' }] }; },
    stitch: async () => { throw new Error('no blend'); },
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: [{ id: m.id, title: m.title, items: m.items.length, targetSeconds: m.targetSeconds, updated: 1 }], damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    throw new Error('unexpected ' + String(command));
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect(q('[data-movie-film-card]')).toBeTruthy());
  expect(joins).toEqual([]);
  fireEvent.click(inScene('seg-2', '[data-movie-shot-make]'));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  view.rerender(ui({ n: 1, run: { state: 'running', job: { id: 'jr1' } } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('making …'));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'jr1' }, picture: vid('/out/seg-2-remade.mp4') } }, 1));
  await waitFor(() => expect(joins).toEqual([['/out/seg-1.mp4', '/out/seg-2-remade.mp4']]));
  joinDone.resolve();
  openCard('film');
  await waitFor(() => expect(q('[data-movie-film-video] video')?.getAttribute('src')).toBe('asset:///out/video/film-remade.mp4'));
  expect(joins).toHaveLength(1);
});

it('terminal Continuity chain aborts unlock only on the matching hand-over, stop Make the movie, and preserve completed intermediate clips', async () => {
  let mChain = applyPlan(setBrief(newMovie('movie-chain-abort', 'Chain Abort'), { story: 's' }), { lore: 'l', segments: [
    { title: 'Start', prompt: 'Anna runs', seconds: 5, continuous: false, dialogue: [] },
    { title: 'Cont', prompt: 'Anna turns', seconds: 4, continuous: true, dialogue: [] },
    { title: 'Cut', prompt: 'Street', seconds: 5, continuous: false, dialogue: [] },
  ] });
  mChain = setMusicPrompt(mChain, 'calm piano');
  const mOther = applyPlan(setBrief(newMovie('movie-other', 'Other Movie'), { story: 's' }), { lore: 'l', segments: [
    { title: 'One', prompt: 'one', seconds: 5, continuous: false, dialogue: [] },
  ] });
  stored[mChain.id] = JSON.stringify(mChain); stored[mOther.id] = JSON.stringify(mOther);
  const joins: string[][] = [];
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async p => ({ sourceId: p, blockers: [], durationSeconds: 5 }), upload: async id => id,
    preflight: async () => ({ ok: true, issues: [], seconds: 14 }), epoch: async () => ({ epoch: 1, stopping: false }),
    run: async intent => { joins.push((intent.h3.join as any).files.map((f: any) => f.filename)); return { id: 'jf', state: 'running', outputs: [] }; },
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film.mp4', subfolder: 'video' }] }),
    stitch: async () => { throw new Error('no blend'); },
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const x = JSON.parse(text); return { id, title: x.title, items: x.items.length, targetSeconds: x.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    throw new Error('unexpected ' + String(command));
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3, ace] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-open="movie-chain-abort"]'); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Chain Abort'));

  // 1. First shot cannot start: an unrelated hand-over report keeps Movie Maker locked; the matching report unlocks it and stops autoRun.
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-open="movie-other"]') as HTMLButtonElement).disabled).toBe(true);
  expect((inScene('seg-3', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(true);
  expect(q('[data-movie-run-stop]')).toBeTruthy();

  view.rerender(ui({ n: 99, run: { state: 'unknown', error: 'unrelated handoff', step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-open="movie-other"]') as HTMLButtonElement).disabled).toBe(true);
  expect((inScene('seg-3', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(true);
  expect(q('[data-movie-run-stop]')).toBeTruthy();

  view.rerender(ui({ n: 1, run: { state: 'unknown', error: 'queue rejected first take', step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(false));
  expect((q('[data-movie-open="movie-other"]') as HTMLButtonElement).disabled).toBe(false);
  expect((inScene('seg-1', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(false);
  expect((inScene('seg-3', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(false);
  expect(q('[data-movie-run-stop]')).toBeNull();
  expect(q('[data-movie-error]')?.textContent).toBe('queue rejected first take');
  expect(inScene('seg-1', '[data-movie-shot-error]').textContent).toBe('queue rejected first take');
  expect(['seg-1', 'seg-2', 'seg-3'].map(stateOf)).toEqual(['not made', 'not made', 'not made']);
  expect([onPrepare.mock.calls.length, joins.length]).toEqual([1, 0]);

  // 2. `pinClip` fails after intermediate shot `seg-1` succeeded: unrelated report keeps lock; matching report unlocks, stops autoRun, and preserves `seg-1`'s clip.
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2));
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'jc1' }, picture: vid('/out/s1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 2));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  expect((q('[data-movie-open="movie-other"]') as HTMLButtonElement).disabled).toBe(true);
  expect((inScene('seg-3', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(true);

  view.rerender(ui({ n: 98, run: { state: 'unknown', error: 'unrelated abort', step: { index: 1, shotId: 'seg-2', total: 2 } } }, 2));
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  expect((inScene('seg-3', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(true);
  expect(q('[data-movie-run-stop]')).toBeTruthy();

  view.rerender(ui({ n: 2, run: { state: 'unknown', error: 'H3 session clip missing', step: { index: 1, shotId: 'seg-2', total: 2 } } }, 2));
  await waitFor(() => expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(false));
  expect((q('[data-movie-open="movie-other"]') as HTMLButtonElement).disabled).toBe(false);
  expect((inScene('seg-1', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(false);
  expect((inScene('seg-3', '[data-movie-shot-make]') as HTMLButtonElement).disabled).toBe(false);
  openCard('music');
  expect((q('[data-movie-music-generate]') as HTMLButtonElement).disabled).toBe(false);
  expect(q('[data-movie-run-stop]')).toBeNull();
  expect(['seg-1', 'seg-2', 'seg-3'].map(stateOf)).toEqual(['made', 'not made', 'not made']);
  expect(inScene('seg-1', '[data-movie-shot-video] video').getAttribute('src')).toBe('asset:///out/s1.mp4');
  expect(inScene('seg-2', '[data-movie-shot-error]').textContent).toBe('H3 session clip missing');
  expect(q('[data-movie-error]')?.textContent).toBe('H3 session clip missing');
  expect([onPrepare.mock.calls.length, joins.length]).toEqual([2, 0]);

  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(q('[data-movie-open="movie-other"]'));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Other Movie'));
});

it('Generate Stop after a reconciled intermediate chain shot keeps that clip and unlocks, and a stale succeeded music result stops Make the movie without mixing a newly picked track while valid music mixes', async () => {
  let mChain = applyPlan(setBrief(newMovie('movie-gen-stop', 'Gen Stop'), { story: 's' }), { lore: 'l', segments: [
    { title: 'Start', prompt: 'Anna runs', seconds: 5, continuous: false, dialogue: [] },
    { title: 'Cont', prompt: 'Anna turns', seconds: 4, continuous: true, dialogue: [] },
  ] });
  mChain = setMusicPrompt(mChain, 'calm piano');
  const mMusic = { ...setMusicPrompt(scoredMovie(true), 'calm piano'), id: 'movie-music-stale', title: 'Music Auto' };
  stored[mChain.id] = JSON.stringify(mChain); stored[mMusic.id] = JSON.stringify(mMusic);
  const mixes: Record<string, any>[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_movie_list') return { movies: Object.entries(stored).map(([id, text]) => { const x = JSON.parse(text); return { id, title: x.title, items: x.items.length, targetSeconds: x.targetSeconds, updated: 1 }; }), damaged: 0 };
    if (command === 'native_movie_open') return stored[a.id];
    if (command === 'native_movie_check') return { missing: [], checked: 1, truncated: false };
    if (command === 'native_llm_models') return { models: [], warnings: [] };
    if (command === 'native_logs_movie_notice') return null;
    if (command === 'native_movie_pick_music') return '/music/picked.wav';
    if (command === 'native_movie_mix') { mixes.push(a.request); return { path: '/out/video/scored.mp4', seconds: 10, ducked: true }; }
    throw new Error('unexpected ' + String(command));
  });
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker root="/env" endpoint="http://backend" models={[h3, ace] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.click(await waitFor(() => { const b = q('[data-movie-open="movie-gen-stop"]'); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Gen Stop'));

  // 1. Generate Stop during step 0 where step 0 reconciles as succeeded: step 0's clip is recorded, then the stop notice unlocks Movie Maker and keeps seg-2 runnable (`not made`, not `failed`).
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'jc1' }, picture: vid('/out/s1-reconciled.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  view.rerender(ui({ n: 1, run: { state: 'unknown', error: 'The run was stopped.', step: { index: 1, shotId: 'seg-2', total: 2 } } }, 1));
  await waitFor(() => expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(false));
  expect(q('[data-movie-run-stop]')).toBeNull();
  expect([stateOf('seg-1'), stateOf('seg-2')]).toEqual(['made', 'not made']);
  expect(inScene('seg-1', '[data-movie-shot-video] video').getAttribute('src')).toBe('asset:///out/s1-reconciled.mp4');
  expect((q('[data-movie-run]') as HTMLButtonElement).disabled).toBe(false);

  // 2. Stale succeeded music result after user picked a track during `Make the movie`: slot unlocks, `autoRun` stops, and no mix starts on `/music/picked.wav`.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(q('[data-movie-open="movie-music-stale"]'));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Music Auto'));
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2));
  expect(onPrepare.mock.calls[1][0]).toMatchObject({ pipeline: 't2m', run: true });
  expect(q('[data-movie-run-stop]')).toBeTruthy();
  expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(true);
  openCard('music');
  fireEvent.click(q('[data-movie-music-pick]'));
  await waitFor(() => expect(q('[data-movie-music-file]')?.textContent).toBe('picked.wav'));
  expect(mixes).toHaveLength(0);
  view.rerender(ui({ n: 2, run: { state: 'succeeded', job: { id: 'jm-stale' }, picture: { path: '/out/audio/stale.flac', audio: true, width: 0, height: 0, seed: 1, checkpoint: 'ace' } } }, 2));
  await waitFor(() => expect((q('[data-movie-new]') as HTMLButtonElement).disabled).toBe(false));
  expect((q('[data-movie-music-generate]') as HTMLButtonElement).disabled).toBe(false);
  expect(q('[data-movie-run-stop]')).toBeNull();
  expect(q('[data-movie-music-file]')?.textContent).toBe('picked.wav');
  expect(mixes).toHaveLength(0);
  expect(q('[data-movie-scored-video]')).toBeNull();

  // 3. Valid matching music result still advances `Make the movie` automatically into the mix.
  fireEvent.click(q('[data-movie-music-clear]'));
  expect(q('[data-movie-music-file]')).toBeNull();
  fireEvent.click(q('[data-movie-run]'));
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(3));
  view.rerender(ui({ n: 3, run: { state: 'succeeded', job: { id: 'jm-ok' }, picture: { path: '/out/audio/fresh.flac', audio: true, width: 0, height: 0, seed: 2, checkpoint: 'ace' } } }, 3));
  await waitFor(() => expect(mixes).toEqual([expect.objectContaining({ film: '/out/video/film.mp4', music: '/out/audio/fresh.flac' })]));
  openCard('music');
  await waitFor(() => expect(q('[data-movie-scored-video]')).toBeTruthy());
  expect(q('[data-movie-note]')?.textContent).toBe('The movie is made.');
});
