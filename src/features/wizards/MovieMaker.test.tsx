import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { MovieMaker } from './MovieMaker';
import { addCast, completeItem, newMovie, setBrief } from '../../lib/movieManifest';
import { applyPlan } from '../../lib/movieStory';
import * as assembleRun from '../../lib/movieAssembleRun';

vi.mock('../../lib/movieAssembleRun', () => ({ realAssembleDeps: vi.fn(), stopAssemblyJob: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, convertFileSrc: (p: string) => `asset://${p}` }));

let stored: Record<string, string>;
let picks: string[];
let checkReply: { id: string; kind: string; path: string }[] = [];
const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === name).map(([, a]) => a as Record<string, unknown>);
const view = () => render(<I18nProvider><MovieMaker/></I18nProvider>);
const q = (sel: string) => document.querySelector(sel) as HTMLElement;

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

it('edits the brief and cast with references, saves, and reopens without starting anything', async () => {
  view();
  await waitFor(() => expect(q('[data-movie-none]')).toBeTruthy());
  fireEvent.change(q('[data-movie-title]'), { target: { value: 'Chase' } });
  fireEvent.change(q('[data-movie-seconds]'), { target: { value: '45' } });
  fireEvent.change(q('[data-movie-aspect]'), { target: { value: '9:16' } });
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  fireEvent.change(q('[data-movie-new-name]'), { target: { value: 'Anna' } });
  fireEvent.click(q('[data-movie-add]'));
  expect(q('[data-movie-cast-item="cast-1"]')).toBeTruthy();
  picks.push('/pics/anna.png');
  fireEvent.click(q('[data-movie-add-ref]'));
  await waitFor(() => expect(document.querySelectorAll('[data-movie-ref]')).toHaveLength(1));
  expect(screen.getByText('anna.png')).toBeTruthy();
  fireEvent.click(q('[data-movie-save]'));
  await waitFor(() => expect(calls('native_movie_save')).toHaveLength(1));
  const saved = JSON.parse(calls('native_movie_save')[0].manifest as string);
  expect([saved.title, saved.targetSeconds, saved.aspect, saved.items[0].text, saved.items[1].title, saved.items[1].refs]).toEqual(['Chase', 45, '9:16', 'Anna runs.', 'Anna', ['/pics/anna.png']]);
  await waitFor(() => expect(q('[data-movie-note]')).toBeTruthy());
  // Fresh movie, then reopen the saved one: only list/open/save/pick commands ran, no job command.
  fireEvent.click(q('[data-movie-new]'));
  expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('');
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${saved.id}"]`); expect(b).toBeTruthy(); return b; }));
  await waitFor(() => expect((q('[data-movie-title]') as HTMLInputElement).value).toBe('Chase'));
  expect(q('[data-movie-cast-item="cast-1"]')).toBeTruthy();
  const used = new Set(vi.mocked(invoke).mock.calls.map(([c]) => c));
  expect([...used].sort()).toEqual(['native_analysis_pick', 'native_movie_check', 'native_movie_list', 'native_movie_open', 'native_movie_save']);
});

it('a locked cast entry cannot be edited, re-pictured or removed until unlocked', async () => {
  view();
  fireEvent.change(q('[data-movie-new-name]'), { target: { value: 'Ben' } });
  fireEvent.click(q('[data-movie-add]'));
  fireEvent.click(q('[data-movie-lock]'));
  for (const sel of ['[data-movie-remove]', '[data-movie-add-ref]', '[data-movie-cast-name]', '[data-movie-cast-text]', '[data-movie-role]']) expect((q(sel) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(q('[data-movie-lock]'));
  expect((q('[data-movie-remove]') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(q('[data-movie-remove]'));
  expect(q('[data-movie-cast-empty]')).toBeTruthy();
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
  { title: 'Start', prompt: 'Wide shot, Anna runs', seconds: 10, castIds: ['cast-1'], continuous: false, dialogue: [{ castId: 'cast-1', line: 'Stop!' }] },
  { title: 'Catch', prompt: 'Close up', seconds: 5, castIds: ['cast-1'], continuous: true },
] });
let llmReply: string, llmBase: string, generated: Record<string, any>[];
const planMock = (models: unknown[]) => vi.mocked(invoke).mockImplementation(async (command, args) => {
  const a = args as Record<string, any>;
  if (command === 'native_movie_list') return { movies: [], damaged: 0 };
  if (command === 'native_llm_models') return { models, warnings: [] };
  if (command === 'native_llm_read') return { provider: 'ollama', baseUrl: llmBase };
  if (command === 'native_llm_generate') { generated.push(a); return { text: llmReply, backend: a.request.model.provider }; }
  if (command === 'native_logs_movie_notice') return null;
  throw new Error('unexpected ' + String(command));
});
const prepare = async () => {
  render(<I18nProvider><MovieMaker modelsRoot="/m"/></I18nProvider>);
  fireEvent.change(q('[data-movie-seconds]'), { target: { value: '14' } });
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  fireEvent.change(q('[data-movie-new-name]'), { target: { value: 'Anna' } });
  fireEvent.click(q('[data-movie-add]'));
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
  expect(generated[0].request.prompt).toContain('id=cast-1 kind=actor name=Anna');
  expect(q('[data-movie-plan-diff]').textContent).toContain('2 new');
  fireEvent.click(q('[data-movie-plan-apply]'));
  expect(document.querySelectorAll('[data-movie-segment]')).toHaveLength(2);
  expect(q('[data-movie-seg-line]').textContent).toBe('Anna: Stop!');
  expect(q('[data-movie-lore]')).toBeTruthy();
  // 10 s new take → 243 frames = 10.13 s; 5 s continued → 119 frames = 4.96 s; total planned 15 vs target 14.
  expect(document.querySelectorAll('[data-movie-seg-actual]')[0].textContent).toContain('10.13');
  expect(q('[data-movie-total]').textContent).toContain('target 14 s');
  expect((document.querySelectorAll('[data-movie-seg-continuous]')[0] as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(document.querySelectorAll('[data-movie-seg-seconds]')[1], { target: { value: '4' } });
  expect(q('[data-movie-total]').textContent).toContain('Planned 14 s');
});

it('an external server only gets the brief after the destination is confirmed; cancel sends nothing', async () => {
  llmReply = answer; llmBase = 'https://llm.example.org:8443/v1'; generated = [];
  planMock([{ id: 'gpt', provider: 'openai', name: 'gpt' }]);
  await prepare();
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-remote]')).toBeTruthy());
  expect(q('[data-movie-remote]').textContent).toContain('llm.example.org:8443');
  expect(q('[data-movie-remote]').textContent).toContain('Reference pictures are not sent');
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
  render(<I18nProvider><MovieMaker modelsRoot="/m"/></I18nProvider>);
  await waitFor(() => expect(q('[data-movie-no-model]')).toBeTruthy());
  expect((q('[data-movie-plan-run]') as HTMLButtonElement).disabled).toBe(true);
  cleanup(); planMock([{ id: 'x', provider: 'local', name: 'x' }]);
  render(<I18nProvider><MovieMaker modelsRoot="/m"/></I18nProvider>);
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
    { title: 'Start', prompt: 'Anna runs', seconds: 10, castIds: ['cast-1'], continuous: false },
    { title: 'Catch', prompt: 'Close up', seconds: 4, castIds: ['cast-1'], continuous: true },
  ] }); llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker modelsRoot="/m" models={[h3Base, h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.change(q('[data-movie-seconds]'), { target: { value: '14' } });
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  fireEvent.change(q('[data-movie-new-name]'), { target: { value: 'Anna' } });
  fireEvent.click(q('[data-movie-add]'));
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-apply]'));
  const buttons = (sel: string) => [...document.querySelectorAll(sel)] as HTMLButtonElement[];
  expect(buttons('[data-movie-shot-make]').map(b => b.disabled)).toEqual([false, true]);
  expect((q('[data-movie-shot-model]') as HTMLSelectElement).value).toBe('/m/h3_turbo'); // the Turbo file is the default
  fireEvent.click(buttons('[data-movie-shot-make]')[0]);
  expect(onPrepare).toHaveBeenCalledTimes(1);
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', run: true, seconds: 10, model: { path: '/m/h3_turbo' } });
  // Generate reports the run: first running, then the finished video becomes the shot's result.
  view.rerender(ui({ n: 1, run: { state: 'running', job: { id: 'j1' } } }, 1));
  await waitFor(() => expect(document.querySelector('[data-movie-shot="seg-1"] [data-movie-shot-state]')!.textContent).toBe('making …'));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j1' }, picture: { path: '/out/seg1.mp4', video: true, width: 1, height: 1, seed: 1, checkpoint: 'h3' } } }, 1));
  await waitFor(() => expect(document.querySelector('[data-movie-shot-video]')).toBeTruthy());
  expect(document.querySelector('[data-movie-shot="seg-1"] [data-movie-shot-state]')!.textContent).toBe('made');
  expect(q('[data-movie-dirty]')).toBeTruthy();
  // A failed run marks the shot failed and shows the reason.
  fireEvent.click(buttons('[data-movie-shot-make]')[0]);
  view.rerender(ui({ n: 2, run: { state: 'failed', error: 'out of memory' } }, 2));
  await waitFor(() => expect(q('[data-movie-shot-error]').textContent).toBe('out of memory'));
  expect(document.querySelector('[data-movie-shot="seg-1"] [data-movie-shot-state]')!.textContent).toBe('failed');
});

it('without an H3 model the shot buttons are disabled with the reason', async () => {
  llmReply = ''; llmBase = ''; generated = [];
  planMock([]);
  const { container } = render(<I18nProvider><MovieMaker modelsRoot="/m" models={[]} onPrepare={vi.fn()}/></I18nProvider>);
  expect(container.querySelector('[data-movie-shot-nomodel]')).toBeNull(); // no shots yet, so nothing to explain
});

const filmMovie = (done: boolean) => {
  let m = addCast(setBrief(newMovie('movie-f', 'Film'), { story: 's', targetSeconds: 10 }), 'actor', 'Anna');
  m = applyPlan(m, { lore: 'l', segments: [
    { title: 'A', prompt: 'a', seconds: 5, castIds: [], continuous: false, dialogue: [] },
    { title: 'B', prompt: 'b', seconds: 5, castIds: [], continuous: false, dialogue: [] },
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
  render(<I18nProvider><MovieMaker modelsRoot="/m" endpoint={endpoint} models={[]} onPrepare={vi.fn()}/></I18nProvider>);
  fireEvent.click(await waitFor(() => { const b = q(`[data-movie-open="${m.id}"]`); expect(b).toBeTruthy(); return b; }));
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
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film.mp4', subfolder: 'video' }] }),
  });
  await openFilm(filmMovie(true));
  expect((q('[data-movie-film-run]') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(q('[data-movie-film-run]'));
  await waitFor(() => expect(q('[data-movie-film-video]')).toBeTruthy());
  expect(steps).toEqual(['inspect /out/seg-1.mp4', 'inspect /out/seg-2.mp4']);
  expect(q('[data-movie-film-video]').getAttribute('src')).toBe('asset:///out/video/film.mp4');
  expect(q('[data-movie-film-mismatch]').textContent).toContain('9 s but the shots add up to 10 s');
  expect(q('[data-movie-dirty]')).toBeTruthy();
  expect(calls('native_logs_movie_notice').map(c => c.operation)).toContain('join-done');
  expect(vi.mocked(assembleRun.realAssembleDeps).mock.calls[0][0]).toBe('http://backend');
});

it('a refused join shows the reason, logs it, and records nothing', async () => {
  vi.mocked(assembleRun.realAssembleDeps).mockReturnValue({
    inspect: async () => ({ sourceId: 'id', blockers: [], durationSeconds: 5 }), upload: async () => 'in.mp4',
    preflight: async () => ({ ok: false, issues: ['audio rate differs'], seconds: 0 }),
    epoch: async () => ({ epoch: 1, stopping: false }), run: async () => { throw new Error('must not run'); }, wait: async j => j,
  });
  await openFilm(filmMovie(true));
  fireEvent.click(q('[data-movie-film-run]'));
  await waitFor(() => expect(q('[data-movie-error]').textContent).toBe('audio rate differs'));
  expect(q('[data-movie-film-video]')).toBeNull();
  expect(calls('native_logs_movie_notice').map(c => c.operation)).toContain('join-blocked');
});

it('reopening reports the clips and pictures that are gone and can mark the missing clips as not made', async () => {
  checkReply = [{ id: 'seg-1', kind: 'result', path: '/out/seg-1.mp4' }, { id: 'cast-1', kind: 'reference', path: '/pics/anna.png' }];
  await openFilm(filmMovie(true));
  await waitFor(() => expect(q('[data-movie-gone]')).toBeTruthy());
  const items = [...document.querySelectorAll('[data-movie-gone] li')].map(x => x.textContent);
  expect(items).toEqual(['A: the made clip “seg-1.mp4” is missing', 'Anna: the reference picture “anna.png” is missing']);
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
  { title: 'Start', prompt: 'Anna runs', seconds: 5, castIds: ['cast-1'], continuous: false },
  { title: 'Alley', prompt: 'Ben hides', seconds: 4, castIds: ['cast-1'], continuous: true },
  { title: 'Cut', prompt: 'Street', seconds: 5, castIds: ['cast-1'], continuous: false },
] });
const chainUi = async () => {
  llmReply = chainReply; llmBase = 'http://127.0.0.1:11434'; generated = [];
  planMock([{ id: 'q', provider: 'local', name: 'q' }]);
  const onPrepare = vi.fn();
  const ui = (outcome?: any, handoff?: number) => <I18nProvider><MovieMaker modelsRoot="/m" models={[h3] as any} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/></I18nProvider>;
  const view = render(ui());
  fireEvent.change(q('[data-movie-seconds]'), { target: { value: '14' } });
  fireEvent.change(q('[data-movie-story]'), { target: { value: 'Anna runs.' } });
  fireEvent.change(q('[data-movie-new-name]'), { target: { value: 'Anna' } });
  fireEvent.click(q('[data-movie-add]'));
  await waitFor(() => expect(q('[data-movie-llm]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-run]'));
  await waitFor(() => expect(q('[data-movie-plan-apply]')).toBeTruthy());
  fireEvent.click(q('[data-movie-plan-apply]'));
  return { onPrepare, ui, view };
};
const stateOf = (id: string) => document.querySelector(`[data-movie-shot="${id}"] [data-movie-shot-state]`)!.textContent;
const vid = (path: string) => ({ path, video: true, width: 1, height: 1, seed: 1, checkpoint: 'h3' });

it('a chain is made from its first shot: one hand-over with the plan, each shot recorded as it finishes, busy until the last one', async () => {
  const { onPrepare, ui, view } = await chainUi();
  const make = [...document.querySelectorAll('[data-movie-shot-make]')] as HTMLButtonElement[];
  expect(make.map(b => [b.textContent, b.disabled])).toEqual([['Make the chain (2 shots)', false], ['Make this shot', true], ['Make this shot', false]]);
  expect((document.querySelectorAll('[data-movie-shot-make]')[1] as HTMLButtonElement).title).toBe('Made together with the first shot of its chain.');
  fireEvent.click(make[0]);
  const h = onPrepare.mock.calls[0][0];
  expect(h).toMatchObject({ wizard: 'movie', strategy: 'seg-1', run: true, continuity: { shotIds: ['seg-1', 'seg-2'], plan: { outputMode: 'segment', steps: [{ id: 'seg-1' }, { id: 'seg-2' }] } } });
  view.rerender(ui({ n: 1, run: { state: 'running', step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('making …'));
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j1' }, picture: vid('/out/s1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  expect(stateOf('seg-2')).toBe('not made');
  expect([...document.querySelectorAll('[data-movie-shot-make]')].every(b => (b as HTMLButtonElement).disabled)).toBe(true); // still busy between the steps
  view.rerender(ui({ n: 1, run: { state: 'succeeded', job: { id: 'j2' }, picture: vid('/out/s2.mp4'), step: { index: 1, shotId: 'seg-2', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('made'));
  expect((document.querySelectorAll('[data-movie-shot-make]')[0] as HTMLButtonElement).disabled).toBe(false);
  expect(document.querySelectorAll('[data-movie-shot-video]')).toHaveLength(2);
  expect([...document.querySelectorAll('[data-movie-seg-actual]')].map(x => x.textContent)).toEqual(['Will be made as 5.17 s', 'Will be made as 4.25 s', 'Will be made as 5.17 s']);
});

it('a failing step marks that shot failed, leaves the rest of the chain not made, and frees the buttons', async () => {
  const { ui, view } = await chainUi();
  fireEvent.click(document.querySelectorAll('[data-movie-shot-make]')[0]);
  view.rerender(ui({ n: 1, run: { state: 'succeeded', picture: vid('/out/s1.mp4'), step: { index: 0, shotId: 'seg-1', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-1')).toBe('made'));
  view.rerender(ui({ n: 1, run: { state: 'failed', error: 'out of memory', step: { index: 1, shotId: 'seg-2', total: 2 } } }, 1));
  await waitFor(() => expect(stateOf('seg-2')).toBe('failed'));
  expect(q('[data-movie-shot-error]').textContent).toBe('out of memory');
  expect((document.querySelectorAll('[data-movie-shot-make]')[0] as HTMLButtonElement).disabled).toBe(false);
  expect(stateOf('seg-3')).toBe('not made');
});
