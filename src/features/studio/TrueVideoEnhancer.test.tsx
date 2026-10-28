import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { TrueVideoEnhancer } from './TrueVideoEnhancer';
import { bindVideoPost, runVideoPost, videoPostCapabilities, videoPostJobCommand, type VideoPostDraft, type VideoPostInspection } from '../../lib/videoPost';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); vi.mocked(isTauri).mockReturnValue(true); vi.mocked(invoke).mockImplementation(async command => command === 'native_video_post_capabilities' ? { available: false } : undefined); });
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
const source: VideoPostInspection = { name: 'source.mp4', width: 1920, height: 1080, fpsNumerator: 24000, fpsDenominator: 1001, durationSeconds: 12.5, pixelFormat: 'yuv420p', fieldOrder: 'progressive', colorTransfer: 'bt709', audioStreams: 2, subtitleStreams: 1, blockers: [], timingVerified: false, processingReady: false };
const projected = { name: source.name, width: source.width, height: source.height, fpsNumerator: source.fpsNumerator, fpsDenominator: source.fpsDenominator, audioStreams: source.audioStreams, subtitleStreams: source.subtitleStreams, blockers: [] };
const draft: VideoPostDraft = { kind: 'deas-video-post-draft', version: 1, source: projected, settings: { scale: 2, profile: 'mp4-h264' }, output: { filename: 'processed.mp4', width: 3840, height: 2160, fpsNumerator: 24000, fpsDenominator: 1001, container: 'mp4', videoEncoder: 'libx264', pixelFormat: 'yuv420p', audioEncoder: 'aac', audioBitrate: 192000 }, blockers: ['subtitlesUnsupported'], processingReady: false, timingVerified: false, encoderVerified: false };
const view = () => <I18nProvider><TrueVideoEnhancer/></I18nProvider>;
const choose = () => fireEvent.click(document.querySelector('[data-video-post-inspect]')!);
const check = () => fireEvent.click(document.querySelector('[data-tve-check]')!);
const change = (hook: string, value: string) => fireEvent.change(document.querySelector(`[data-tve-${hook}]`)!, { target: { value } });
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function inspected() { vi.mocked(invoke).mockResolvedValueOnce(source); await act(async () => choose()); }

test.each([false, true])('workspace badge reflects compiled native engine without claiming GPU readiness (%s)', async available => {
  vi.mocked(invoke).mockResolvedValueOnce({ available });
  await act(async () => { render(view()); });
  const badge = document.querySelector('[data-tve-build-mode]')!;
  expect(badge.getAttribute('data-tve-build-mode')).toBe(available ? 'native' : 'draft');
  expect(badge.textContent).toBe(available ? 'Native engine included' : 'DRAFT only');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_video_post_capabilities');
});

test('mount only reads compile capabilities, never probes or loads models', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ available: false });
  render(view());
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_video_post_capabilities');
  await act(async () => Promise.resolve());
  expect(document.querySelector('[data-tve-check]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-tve-scale]')).toHaveProperty('value', '2');
  expect(document.querySelector('[data-tve-profile]')).toHaveProperty('value', 'mp4-h264');
  await inspected();
  vi.mocked(invoke).mockClear(); vi.mocked(isTauri).mockReturnValue(false);
  change('scale', '4'); check(); choose();
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-tve-check]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-video-post-inspect]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-tve-run]')).toHaveProperty('disabled', true);
});

test('exact projected request and Rust output are displayed without deriving geometry, codecs or readiness', async () => {
  render(view()); await inspected();
  vi.mocked(invoke).mockResolvedValueOnce({ ...draft, output: { ...draft.output, width: 7776, fpsNumerator: 30000 } });
  await act(async () => check());
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_draft', { source: projected, settings: { scale: 2, profile: 'mp4-h264' } });
  const result = document.querySelector('[data-tve-draft]')!;
  expect(result.textContent).toContain('7776 × 2160');
  expect(result.textContent).toContain('30000/1001 fps');
  expect(result.textContent).toContain('mp4 · libx264 · yuv420p');
  expect(result.textContent).toContain('aac · 192000 bit/s');
  expect(document.querySelector('[data-tve-blocker]')?.textContent).toBe('Subtitles cannot be preserved by this draft.');
  expect(screen.getByText(/A draft is metadata only/)).toBeTruthy();
  expect(document.querySelector('[data-tve-run]')).toHaveProperty('disabled', true);
});

test('cancel and inspection failure retain the checked source/draft; successful replacement invalidates immediately', async () => {
  render(view()); await inspected(); vi.mocked(invoke).mockResolvedValueOnce(draft);
  await act(async () => check()); const checked = document.querySelector('[data-tve-draft]');
  vi.mocked(invoke).mockResolvedValueOnce(null); await act(async () => choose());
  expect(document.querySelector('[data-tve-draft]')).toBe(checked);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('probe failed')); await act(async () => choose());
  expect(document.querySelector('[data-tve-draft]')).toBe(checked);
  vi.mocked(invoke).mockResolvedValueOnce({ ...source, name: 'next.mkv' }); await act(async () => choose());
  expect(document.querySelector('[data-tve-draft]')).toBeNull();
  expect(screen.getByText('next.mkv')).toBeTruthy();
});

test.each(['scale', 'profile'])('%s edits immediately discard a shown draft and use exact new settings', async option => {
  render(view()); await inspected(); vi.mocked(invoke).mockResolvedValue(draft);
  await act(async () => check());
  change(option, option === 'scale' ? '4' : 'webm-vp9');
  expect(document.querySelector('[data-tve-draft]')).toBeNull();
  await act(async () => check());
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_draft', { source: projected, settings: option === 'scale' ? { scale: 4, profile: 'mp4-h264' } : { scale: 2, profile: 'webm-vp9' } });
});

test.each(['scale', 'profile', 'unmount'])('late results and errors after %s cannot restore obsolete draft state', async edit => {
  for (const outcome of ['success', 'failure']) {
    const rendered = render(view()); await inspected();
    const pending = deferred(); vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    act(() => { check(); check(); });
    expect(document.querySelector('[data-tve-check]')).toHaveProperty('disabled', true);
    if (edit === 'unmount') { rendered.unmount(); render(view()); }
    else change(edit, edit === 'scale' ? '1' : 'mkv-h264');
    await act(async () => outcome === 'success' ? pending.resolve(draft) : pending.reject(new Error('obsolete failure')));
    expect(document.querySelector('[data-tve-draft]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
  }
});

test('current failure is accessible, clears on edit/retry and preserves source', async () => {
  render(view()); await inspected();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('draft unavailable'));
  await act(async () => check());
  expect(screen.getByRole('alert').textContent).toContain('draft unavailable');
  change('scale', '1'); expect(screen.queryByRole('alert')).toBeNull();
  vi.mocked(invoke).mockResolvedValueOnce(draft); await act(async () => check());
  expect(document.querySelector('[data-tve-draft]')).toBeTruthy();
  expect(screen.getByText(source.name)).toBeTruthy();
});

test.each([
  { ...draft, processingReady: true }, { ...draft, timingVerified: true }, { ...draft, encoderVerified: true },
  { ...draft, kind: 'run' }, { ...draft, version: 2 }, { ...draft, output: { ...draft.output, width: 0 } },
  { ...draft, output: { ...draft.output, fpsDenominator: 0 } }, { ...draft, blockers: [42] },
  { ...draft, settings: { scale: 3, profile: 'mp4-h264' } }, { ...draft, source: null },
])('invalid native output fails closed: %j', async value => {
  render(view()); await inspected(); vi.mocked(invoke).mockResolvedValueOnce(value); await act(async () => check());
  expect(document.querySelector('[data-tve-draft]')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Invalid native video output draft');
});

const sourceId = '11111111-1111-4111-8111-111111111111';
const prepared = { id: '22222222-2222-4222-8222-222222222222', sourceId, sourceName: 'source.mp4', outputName: 'chosen.mp4', width: 3840, height: 2160, fpsNumerator: 24000, fpsDenominator: 1001, settings: { scale: 2, profile: 'mp4-h264' }, modelBound: false, timingVerified: false, encoderVerified: false, processingReady: false };
const prepare = () => fireEvent.click(document.querySelector('[data-tve-prepare]')!);
const recheck = () => fireEvent.click(document.querySelector('[data-tve-recheck]')!);
async function retained() { vi.mocked(invoke).mockResolvedValueOnce({ ...source, sourceId }); await act(async () => choose()); }

test('native preparation forwards only source authority, settings and localized title; cancellation retains it', async () => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_prepare', { sourceId, settings: { scale: 2, profile: 'mp4-h264' }, title: 'Choose processed output' });
  expect(document.querySelector('[data-tve-prepared]')?.textContent).toContain('chosen.mp4');
  expect(document.querySelector('[data-tve-prepared]')?.textContent).toContain('3840 × 2160');
  const previous = document.querySelector('[data-tve-prepared]');
  vi.mocked(invoke).mockResolvedValueOnce(null); await act(async () => prepare());
  expect(document.querySelector('[data-tve-prepared]')).toBe(previous);
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => recheck());
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_prepared_status', { id: prepared.id });
});

test.each(['legacy', 'browser', 'mkv-h264', 'webm-vp9'])('preparation is disabled for %s without breaking inspection or drafts', async mode => {
  render(view());
  expect(document.querySelector('[data-tve-prepare]')).toHaveProperty('disabled', true);
  if (mode === 'legacy') await inspected(); else await retained();
  if (mode === 'browser') { vi.mocked(isTauri).mockReturnValue(false); change('scale', '1'); }
  else if (mode !== 'legacy') change('profile', mode);
  vi.mocked(invoke).mockClear();
  prepare();
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-tve-prepare]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-video-post-source]')).toBeTruthy();
});

test('preparation permits native bounds diagnostics, preserves source/draft on error, and never polls', async () => {
  const rendered = render(view());
  vi.mocked(invoke).mockResolvedValueOnce({ ...source, sourceId, fpsNumerator: 0, blockers: ['unsupportedDimensions'] }); await act(async () => choose());
  vi.mocked(invoke).mockResolvedValueOnce(draft); await act(async () => check());
  const checked = document.querySelector('[data-tve-draft]');
  vi.mocked(invoke).mockRejectedValueOnce(new Error('native bounds rejected')); await act(async () => prepare());
  expect(document.querySelector('[data-tve-prepare-error]')?.textContent).toContain('native bounds rejected');
  expect(document.querySelector('[data-tve-draft]')).toBe(checked);
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  expect(document.querySelector('[data-tve-prepare-error]')).toBeNull();
  const calls = vi.mocked(invoke).mock.calls.length;
  rendered.rerender(view()); await act(async () => Promise.resolve());
  expect(invoke).toHaveBeenCalledTimes(calls);
});

test('source cancellation/failure retains preparation; successful replacement invalidates preparation and draft', async () => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(draft); await act(async () => check());
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  const previous = document.querySelector('[data-tve-prepared]');
  vi.mocked(invoke).mockResolvedValueOnce(null); await act(async () => choose());
  expect(document.querySelector('[data-tve-prepared]')).toBe(previous);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('source error')); await act(async () => choose());
  expect(document.querySelector('[data-tve-prepared]')).toBe(previous);
  await retained();
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-draft]')).toBeNull();
});

test.each(['scale', 'profile'])('%s edits discard both displayed draft and preparation immediately', async option => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(draft); await act(async () => check());
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  change(option, option === 'scale' ? '4' : 'webm-vp9');
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-draft]')).toBeNull();
  expect(document.querySelector('[data-video-post-source]')).toBeTruthy();
});

test.each(['not-a-uuid', '', null, 42])('invalid inspection source authority retains prior source and preparation: %j', async invalidId => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  const previous = document.querySelector('[data-tve-prepared]');
  vi.mocked(invoke).mockResolvedValueOnce({ ...source, sourceId: invalidId }); await act(async () => choose());
  expect(document.querySelector('[data-tve-prepared]')).toBe(previous);
  expect(screen.getByRole('alert').textContent).toContain('Invalid native video inspection');
});

test.each(['prepare', 'recheck'])('%s retains duplicate lock across edits until old request settles', async action => {
  render(view()); await retained();
  if (action === 'recheck') { vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare()); }
  const pending = deferred(); vi.mocked(invoke).mockReturnValueOnce(pending.promise);
  const start = action === 'prepare' ? prepare : recheck;
  const calls = vi.mocked(invoke).mock.calls.length;
  act(() => { start(); start(); });
  expect(invoke).toHaveBeenCalledTimes(calls + 1);
  change('scale', '4');
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-prepare]')).toHaveProperty('disabled', true);
  prepare(); check();
  expect(invoke).toHaveBeenCalledTimes(calls + 1);
  await act(async () => pending.resolve(prepared));
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-prepare]')).toHaveProperty('disabled', false);
});

test.each(['prepare', 'recheck'])('%s fences stale results and errors after settings edits or unmount', async action => {
  for (const edit of ['scale', 'profile', 'unmount']) for (const outcome of ['success', 'failure']) {
    const rendered = render(view()); await retained();
    if (action === 'recheck') { vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare()); }
    const pending = deferred(); vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    act(() => action === 'prepare' ? prepare() : recheck());
    if (edit === 'unmount') { rendered.unmount(); render(view()); }
    else change(edit, edit === 'scale' ? '4' : 'mkv-h264');
    await act(async () => outcome === 'success' ? pending.resolve(prepared) : pending.reject(new Error('obsolete preparation')));
    expect(document.querySelector('[data-tve-prepared]')).toBeNull();
    expect(document.querySelector('[data-tve-prepare-error]')).toBeNull();
    cleanup();
  }
});

test('recheck failure invalidates stale preparation but preserves inspected source and draft', async () => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(draft); await act(async () => check());
  const checked = document.querySelector('[data-tve-draft]');
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  vi.mocked(invoke).mockRejectedValueOnce(new Error('destination now exists')); await act(async () => recheck());
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-recheck]')).toBeNull();
  expect(document.querySelector('[data-tve-prepare-error]')?.textContent).toContain('destination now exists');
  expect(document.querySelector('[data-tve-draft]')).toBe(checked);
  expect(document.querySelector('[data-video-post-source]')?.textContent).toContain(source.name);
});

test.each([
  undefined, {}, { ...prepared, modelBound: true }, { ...prepared, timingVerified: true },
  { ...prepared, encoderVerified: true }, { ...prepared, processingReady: true },
  { ...prepared, id: '/tmp/output.mp4' }, { ...prepared, sourceId: 'not-a-uuid' },
  { ...prepared, sourceId: prepared.id }, { ...prepared, sourceName: 42 }, { ...prepared, outputName: '' },
  { ...prepared, width: 0 }, { ...prepared, height: 1.5 }, { ...prepared, fpsNumerator: 0 },
  { ...prepared, fpsDenominator: 0 }, { ...prepared, settings: null },
  { ...prepared, settings: { scale: 3, profile: 'mp4-h264' } },
  { ...prepared, settings: { scale: 4, profile: 'mp4-h264' } },
  { ...prepared, settings: { scale: 2, profile: 'mkv-h264' } },
])('invalid preparation DTO fails closed with fixed frontend error: %j', async value => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(value); await act(async () => prepare());
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-prepare-error]')?.textContent).toContain('Invalid native video output preparation');
});

test.each([null, { ...prepared, id: sourceId }, { ...prepared, outputName: 'changed.mp4' }, { ...prepared, width: 7776 }, { ...prepared, processingReady: true }])('invalid recheck DTO discards preparation: %j', async value => {
  render(view()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  vi.mocked(invoke).mockResolvedValueOnce(value); await act(async () => recheck());
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(document.querySelector('[data-tve-prepare-error]')?.textContent).toContain('Invalid native video output preparation');
});

const dictionaries = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' });
test.each(['en', 'de', 'fr', 'ja', 'tr', 'zh'])('%s localizes draft controls and new blockers, without duplicate source blockers', async locale => {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const dictionary = dictionaries[`./locales/${locale}.json`];
  const keys = Object.keys(dictionaries['./locales/en.json']).filter(k => k.startsWith('studio.tve.'));
  expect(Object.keys(dictionary).filter(k => k.startsWith('studio.tve.')).sort()).toEqual(keys.sort());
  for (const key of keys) expect(dictionary[key]?.trim()).toBeTruthy();
  render(view());
  expect(screen.getByRole('heading', { name: dictionary['studio.tve.title'] })).toBeTruthy();
  expect(screen.getByRole('button', { name: dictionary['studio.tve.check'] })).toBeTruthy();
  vi.mocked(invoke).mockResolvedValueOnce({ ...source, blockers: ['hdr'] }); await act(async () => choose());
  vi.mocked(invoke).mockResolvedValueOnce({ ...draft, blockers: ['hdr', 'outputDimensions', 'subtitlesUnsupported'] }); await act(async () => check());
  expect([...document.querySelectorAll('[data-tve-blocker]')].map(el => el.textContent)).toEqual(['outputDimensions', 'subtitlesUnsupported'].map(code => dictionary[`studio.videoPost.blocker.${code}`]));
  expect(screen.getAllByText(dictionary['studio.videoPost.blocker.hdr'])).toHaveLength(1);
  expect(screen.getByText(dictionary['studio.tve.limit'])).toBeTruthy();
  await retained();
  expect(screen.getByRole('button', { name: dictionary['studio.tve.prepare'] })).toBeTruthy();
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_prepare', { sourceId, settings: { scale: 2, profile: 'mp4-h264' }, title: dictionary['studio.tve.outputDialog'] });
  expect(screen.getByRole('button', { name: dictionary['studio.tve.recheck'] })).toBeTruthy();
  expect(screen.getByText(dictionary['studio.tve.prepareLimit'])).toBeTruthy();
});

test('audio-free output and a blocker-free draft still offer no execution', async () => {
  render(view()); await inspected();
  const { audioEncoder: _encoder, audioBitrate: _bitrate, ...output } = draft.output;
  vi.mocked(invoke).mockResolvedValueOnce({ ...draft, output, blockers: [] }); await act(async () => check());
  expect(screen.getByText('No audio')).toBeTruthy();
  expect(document.querySelector('[data-tve-blocker]')).toBeNull();
  expect(document.querySelector('[data-tve-run]')).toHaveProperty('disabled', true);
});


const binding = { id: '33333333-3333-4333-8333-333333333333', runtimeName: 'libonnxruntime.so', modelName: 'upscale.onnx' };
const starting = { id: '44444444-4444-4444-8444-444444444444', state: 'starting', sourceName: 'source.mp4', outputName: 'chosen.mp4' };
const clickTve = (hook: string) => fireEvent.click(document.querySelector(`[data-tve-${hook}]`)!);
const jobState = () => document.querySelector('[data-tve-job]')?.getAttribute('data-state');
async function bound() {
  vi.mocked(invoke).mockResolvedValueOnce(binding);
  await act(async () => clickTve('bind'));
}
async function runnable() {
  vi.mocked(invoke).mockResolvedValueOnce({ available: true });
  const rendered = render(view());
  await act(async () => Promise.resolve());
  await retained();
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare());
  await bound();
  return rendered;
}
async function running() {
  const rendered = await runnable();
  vi.mocked(invoke).mockResolvedValueOnce(starting);
  await act(async () => clickTve('run'));
  return rendered;
}
const advance = async (ms = 750) => act(async () => vi.advanceTimersByTimeAsync(ms));
afterEach(() => vi.useRealTimers());

test('bind uses localized trust titles, cancellation preserves profile and never initializes a runtime', async () => {
  await runnable();
  expect(screen.getByText(/execute native code with your user permissions/)).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_bind', { titles: {
    runtime: 'Choose trusted ONNX Runtime shared library', model: 'Choose trusted ONNX model', dependency: 'Choose trusted cuDNN library (optional; cancel to skip)',
  } });
  const shown = document.querySelector('[data-tve-profile-binding]');
  vi.mocked(invoke).mockResolvedValueOnce(null); await act(async () => clickTve('bind'));
  expect(document.querySelector('[data-tve-profile-binding]')).toBe(shown);
  expect(shown?.textContent).toContain('upscale.onnx');
  expect(vi.mocked(invoke).mock.calls.map(call => call[0])).not.toContain('native_video_post_run');
  expect(document.querySelector('input')).toBeNull();
});

test('run submits native IDs only, keeps preparation flags honest and guards double clicks while starting', async () => {
  await runnable();
  const request = deferred(); vi.mocked(invoke).mockReturnValueOnce(request.promise);
  const count = vi.mocked(invoke).mock.calls.length;
  act(() => { clickTve('run'); clickTve('run'); });
  expect(invoke).toHaveBeenCalledTimes(count + 1);
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_run', { preparationId: prepared.id, profileId: binding.id });
  change('scale', '4');
  await act(async () => request.resolve(starting));
  expect(document.querySelector('[data-tve-prepared]')).toBeNull();
  expect(jobState()).toBe('starting');
  expect(document.querySelector('[data-tve-bind]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-tve-run]')).toHaveProperty('disabled', true);
  expect(prepared.processingReady).toBe(false);
});

test('job polls by ID without overlap, survives edits and hidden navigation, and ends at real output', async () => {
  vi.useFakeTimers(); const rendered = await running();
  const request = deferred(); vi.mocked(invoke).mockReturnValueOnce(request.promise);
  await advance();
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_status', { id: starting.id });
  const count = vi.mocked(invoke).mock.calls.length;
  await advance(5000); expect(invoke).toHaveBeenCalledTimes(count);
  change('scale', '1'); await retained();
  await act(async () => request.resolve({ ...starting, state: 'succeeded', frames: 4, width: 128, height: 96 }));
  expect(jobState()).toBe('succeeded');
  expect(document.querySelector('[data-tve-job]')?.textContent).toContain('128 × 96');
  rendered.unmount();
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === 'native_video_post_stop')).toHaveLength(0);
});

test('retained hidden mount does not re-query capabilities or lose live/terminal metadata', async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValueOnce({ available: true });
  const rendered = render(<div hidden={false}>{view()}</div>);
  await act(async () => Promise.resolve()); await retained();
  vi.mocked(invoke).mockResolvedValueOnce(prepared); await act(async () => prepare()); await bound();
  vi.mocked(invoke).mockResolvedValueOnce(starting); await act(async () => clickTve('run'));
  rendered.rerender(<div hidden>{view()}</div>);
  change('scale', '1');
  vi.mocked(invoke).mockResolvedValueOnce({ ...starting, state: 'succeeded', frames: 4, width: 128, height: 96 });
  await advance();
  expect(jobState()).toBe('succeeded');
  expect(document.querySelector('[data-tve-job]')?.textContent).toContain('128 × 96');
  expect(document.querySelector('[data-tve-job]')?.textContent).toContain('chosen.mp4');
  expect(document.querySelector('video')).toBeNull();
  const count = vi.mocked(invoke).mock.calls.length;
  await advance(5000); rendered.rerender(<div hidden={false}>{view()}</div>);
  expect(invoke).toHaveBeenCalledTimes(count);
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === 'native_video_post_capabilities')).toHaveLength(1);
});

test('stop during pending status is exact-ID, duplicate guarded and fences stale status without claiming cancellation', async () => {
  vi.useFakeTimers(); await running();
  const status = deferred(); vi.mocked(invoke).mockReturnValueOnce(status.promise); await advance();
  const stop = deferred(); vi.mocked(invoke).mockReturnValueOnce(stop.promise);
  const count = vi.mocked(invoke).mock.calls.length;
  act(() => { clickTve('stop'); clickTve('stop'); });
  expect(invoke).toHaveBeenCalledTimes(count + 1);
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_stop', { id: starting.id });
  expect(jobState()).toBe('starting');
  await act(async () => stop.resolve({ ...starting, state: 'stopping' }));
  await act(async () => status.resolve({ ...starting, state: 'running' }));
  expect(jobState()).toBe('stopping');
  vi.mocked(invoke).mockResolvedValueOnce({ ...starting, state: 'cancelled' }); await advance();
  expect(jobState()).toBe('cancelled');
  const settled = vi.mocked(invoke).mock.calls.length; await advance(5000);
  expect(invoke).toHaveBeenCalledTimes(settled);
});

test('status errors stop retries, retain job/preparation and leave explicit Stop usable', async () => {
  vi.useFakeTimers(); await running();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('worker unavailable')); await advance();
  expect(document.querySelector('[data-tve-job-error]')?.textContent).toContain('Automatic status updates paused');
  expect(document.querySelector('[data-tve-job-error]')?.textContent).toContain('worker unavailable');
  expect(jobState()).toBe('starting');
  expect(document.querySelector('[data-tve-prepared]')).toBeTruthy();
  const count = vi.mocked(invoke).mock.calls.length; await advance(10000);
  expect(invoke).toHaveBeenCalledTimes(count);
  vi.mocked(invoke).mockResolvedValueOnce({ ...starting, state: 'cancelled' }); await act(async () => clickTve('stop'));
  expect(jobState()).toBe('cancelled');
});

test('unmount fences pending job responses and clears timers without implicitly stopping native jobs', async () => {
  vi.useFakeTimers(); const rendered = await running();
  const status = deferred(); vi.mocked(invoke).mockReturnValueOnce(status.promise); await advance();
  rendered.unmount();
  const count = vi.mocked(invoke).mock.calls.length;
  await act(async () => status.resolve({ ...starting, state: 'succeeded' })); await advance(10000);
  expect(invoke).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});

test('native dialogs share a duplicate lock; source inspection prevents binding or submission', async () => {
  await runnable();
  const request = deferred(); vi.mocked(invoke).mockReturnValueOnce(request.promise);
  act(() => choose());
  const count = vi.mocked(invoke).mock.calls.length;
  clickTve('bind'); clickTve('run'); prepare();
  expect(invoke).toHaveBeenCalledTimes(count);
  await act(async () => request.resolve(null));
  const bindRequest = deferred(); vi.mocked(invoke).mockReturnValueOnce(bindRequest.promise);
  act(() => { clickTve('bind'); clickTve('bind'); });
  expect(invoke).toHaveBeenCalledTimes(count + 1);
  choose(); prepare(); clickTve('run');
  expect(invoke).toHaveBeenCalledTimes(count + 1);
  await act(async () => bindRequest.resolve(null));
  expect(document.querySelector('[data-tve-run]')).toHaveProperty('disabled', false);
});

test.each([undefined, null, {}, { available: 1 }, { available: true, gpuReady: true }])('malformed capabilities reject: %j', async value => {
  vi.mocked(invoke).mockResolvedValueOnce(value);
  await expect(videoPostCapabilities()).rejects.toThrow('Invalid native video capabilities');
});
test.each([{}, { ...binding, id: '/tmp/runtime.so' }, { ...binding, dependencyName: null }, { ...binding, gpuReady: true }])('malformed bindings reject: %j', async value => {
  vi.mocked(invoke).mockResolvedValueOnce(value);
  await expect(bindVideoPost({ runtime: 'r', model: 'm', dependency: 'd' })).rejects.toThrow('Invalid native video binding');
});
test.each([null, {}, { ...starting, id: '/tmp/source.mp4' }, { ...starting, state: 'queued' }, { ...starting, frames: null }, { ...starting, frames: -1 }, { ...starting, width: 0 }, { ...starting, height: 1.5 }, { ...starting, error: null }, { ...starting, gpuReady: true }])('malformed job responses reject: %j', async value => {
  vi.mocked(invoke).mockResolvedValueOnce(value);
  await expect(runVideoPost(prepared.id, binding.id)).rejects.toThrow('Invalid native video job');
});
test('invalid IDs never reach native; status rejects mismatched job identity', async () => {
  await expect(runVideoPost('/tmp/source.mp4', binding.id)).rejects.toThrow();
  await expect(runVideoPost(prepared.id, 'browser-profile')).rejects.toThrow();
  await expect(videoPostJobCommand('stop', 'browser-job')).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce({ ...starting, id: binding.id });
  await expect(videoPostJobCommand('status', starting.id)).rejects.toThrow('Invalid native video job');
});


test('browser mount never even reads native capabilities', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  render(view()); await act(async () => Promise.resolve());
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-tve-bind]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-tve-run]')).toHaveProperty('disabled', true);
});

test.each(['bind', 'run'])('pending %s survives retained navigation but is fenced by unmount', async action => {
  const rendered = await runnable();
  const request = deferred(); vi.mocked(invoke).mockReturnValueOnce(request.promise);
  act(() => clickTve(action));
  const count = vi.mocked(invoke).mock.calls.length;
  rendered.rerender(view()); clickTve(action);
  expect(invoke).toHaveBeenCalledTimes(count);
  rendered.unmount(); render(view());
  await act(async () => request.resolve(action === 'bind' ? { ...binding, modelName: 'obsolete.onnx' } : starting));
  expect(document.querySelector('[data-tve-job]')).toBeNull();
  expect(document.querySelector('[data-tve-profile-binding]')).toBeNull();
});

test('malformed status pauses polling without losing metadata, and failed Stop remains explicit and retryable', async () => {
  vi.useFakeTimers(); await running();
  vi.mocked(invoke).mockResolvedValueOnce({ ...starting, frames: null }); await advance();
  expect(document.querySelector('[data-tve-job-error]')?.textContent).toContain('Invalid native video job');
  expect(jobState()).toBe('starting');
  vi.mocked(invoke).mockRejectedValueOnce(new Error('stop unavailable')); await act(async () => clickTve('stop'));
  expect(document.querySelector('[data-tve-job-error]')?.textContent).toContain('stop unavailable');
  expect(jobState()).toBe('starting');
  const count = vi.mocked(invoke).mock.calls.length; await advance(10000);
  expect(invoke).toHaveBeenCalledTimes(count);
  vi.mocked(invoke).mockResolvedValueOnce({ ...starting, state: 'cancelled' }); await act(async () => clickTve('stop'));
  expect(jobState()).toBe('cancelled');
});

test.each(['en', 'de', 'fr', 'ja', 'tr', 'zh'])('%s binds only with localized trust warning and all three native chooser titles', async locale => {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const d = dictionaries[`./locales/${locale}.json`];
  await runnable();
  expect(screen.getByText(d['studio.tve.trust'])).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith('native_video_post_bind', { titles: { runtime: d['studio.tve.runtimeDialog'], model: d['studio.tve.modelDialog'], dependency: d['studio.tve.dependencyDialog'] } });
  expect(screen.getByRole('button', { name: d['studio.tve.run'] })).toBeTruthy();
});
