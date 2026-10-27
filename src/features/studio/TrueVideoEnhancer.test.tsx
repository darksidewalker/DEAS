import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { TrueVideoEnhancer } from './TrueVideoEnhancer';
import type { VideoPostDraft, VideoPostInspection } from '../../lib/videoPost';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); vi.mocked(isTauri).mockReturnValue(true); });
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

test('mount and missing native never probe, load models or create output; checking requires a source', async () => {
  render(view());
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-tve-check]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-tve-scale]')).toHaveProperty('value', '2');
  expect(document.querySelector('[data-tve-profile]')).toHaveProperty('value', 'mp4-h264');
  await inspected();
  vi.mocked(invoke).mockClear(); vi.mocked(isTauri).mockReturnValue(false);
  change('scale', '4'); check(); choose();
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-tve-check]')).toHaveProperty('disabled', true);
  expect(document.querySelector('[data-video-post-inspect]')).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: /run|queue|preview/i })).toBeNull();
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
  expect(screen.getByText(/Metadata draft only/).textContent).toContain('no runnable video engine');
  expect(screen.queryByRole('button', { name: /run/i })).toBeNull();
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

test.each(['scale', 'profile', 'source', 'unmount'])('late results and errors after %s cannot restore obsolete draft state', async edit => {
  for (const outcome of ['success', 'failure']) {
    const rendered = render(view()); await inspected();
    const pending = deferred(); vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    act(() => { check(); check(); });
    expect(document.querySelector('[data-tve-check]')).toHaveProperty('disabled', true);
    if (edit === 'source') { vi.mocked(invoke).mockResolvedValueOnce({ ...source, name: 'new.mp4' }); await act(async () => choose()); }
    else if (edit === 'unmount') { rendered.unmount(); render(view()); }
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
});

test('audio-free output and a blocker-free draft still offer no execution', async () => {
  render(view()); await inspected();
  const { audioEncoder: _encoder, audioBitrate: _bitrate, ...output } = draft.output;
  vi.mocked(invoke).mockResolvedValueOnce({ ...draft, output, blockers: [] }); await act(async () => check());
  expect(screen.getByText('No audio')).toBeTruthy();
  expect(document.querySelector('[data-tve-blocker]')).toBeNull();
  expect(screen.queryByRole('button', { name: /run|start/i })).toBeNull();
});
