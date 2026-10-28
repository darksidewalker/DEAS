import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { VideoPostProcessing } from './VideoPostProcessing';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); vi.mocked(isTauri).mockReturnValue(true); });
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
const view = () => <I18nProvider><VideoPostProcessing /></I18nProvider>;
const choose = () => fireEvent.click(screen.getByRole('button', { name: 'Choose video source…' }));
const source = { name: 'source.mp4', width: 1920, height: 1080, fpsNumerator: 24000, fpsDenominator: 1001, durationSeconds: 12.5, pixelFormat: 'yuv420p', fieldOrder: 'progressive', colorTransfer: 'bt709', audioStreams: 2, subtitleStreams: 1, blockers: [], timingVerified: false, processingReady: false };
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('inspection callback emits only successful metadata, never cancellation or failed reads', async () => {
  const onInspected = vi.fn();
  vi.mocked(invoke).mockResolvedValueOnce(source).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('failed'));
  render(<I18nProvider><VideoPostProcessing onInspected={onInspected}/></I18nProvider>);
  await act(async () => choose()); await act(async () => choose()); await act(async () => choose());
  expect(onInspected).toHaveBeenCalledExactlyOnceWith(source);
});

test('cancel preserves a previous successful source, including on the first choice', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce(source).mockResolvedValueOnce(null);
  render(view());
  await act(async () => choose());
  expect(document.querySelector('[data-video-post-source]')).toBeNull();
  await act(async () => choose());
  await act(async () => choose());
  expect(screen.getByText('source.mp4')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('failure is accessible, retains the snapshot and clears immediately on explicit retry', async () => {
  const pending = deferred();
  vi.mocked(invoke).mockResolvedValueOnce(source).mockRejectedValueOnce({ code: 'PROBE_FAILED', message: 'Inspection unavailable' }).mockReturnValueOnce(pending.promise);
  render(view());
  await act(async () => choose());
  await act(async () => choose());
  expect(screen.getByRole('alert').textContent).toContain('Inspection unavailable');
  expect(screen.getByText('source.mp4')).toBeTruthy();
  choose();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Inspecting');
  expect(document.querySelector('[data-video-post]')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => pending.resolve({ ...source, name: 'retry.mkv' }));
  expect(screen.getByText('retry.mkv')).toBeTruthy();
  expect(document.querySelector('[data-video-post]')?.getAttribute('aria-busy')).toBe('false');
});

test('duplicate clicks are locked until the explicit inspection settles', async () => {
  const pending = deferred(); vi.mocked(invoke).mockReturnValueOnce(pending.promise);
  render(view());
  act(() => { choose(); choose(); });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve(null));
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
});

test.each(['success', 'failure'] as const)('late %s after unmount cannot publish into a new card', async outcome => {
  const pending = deferred(); vi.mocked(invoke).mockReturnValueOnce(pending.promise);
  const rendered = render(view()); choose(); rendered.unmount(); render(view());
  await act(async () => outcome === 'success' ? pending.resolve(source) : pending.reject(new Error('late error')));
  expect(document.querySelector('[data-video-post-source]')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('browser mode never invokes native inspection', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  render(view());
  await act(async () => choose());
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByText('Video inspection requires the desktop app.')).toBeTruthy();
});

test.each([
  { ...source, width: -1 }, { ...source, durationSeconds: -1 },
  { ...source, processingReady: true }, { ...source, blockers: [1] }, { ...source, fpsDenominator: 0 },
])('invalid native response fails closed without a source snapshot: %j', async invalid => {
  vi.mocked(invoke).mockResolvedValue(invalid);
  render(view()); await act(async () => choose());
  expect(screen.getByRole('alert').textContent).toContain('Invalid native video inspection');
  expect(document.querySelector('[data-video-post-source]')).toBeNull();
});

const dictionaries = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' });
const blockerCodes = ['cadenceUnknown', 'cadenceMismatch', 'interlaced', 'rotation', 'alpha', 'hdr', 'colorUnknown', 'unsupportedPixelFormat', 'multipleVideoStreams', 'unsupportedDimensions', 'fieldOrderUnknown', 'nonSquarePixels', 'pixelAspectUnknown'];
test.each(['en', 'de', 'fr', 'ja', 'tr', 'zh'])('%s uses its own labels, chooser title and every localized blocker', async locale => {
  const dictionary = dictionaries[`./locales/${locale}.json`];
  const expectedKeys = Object.keys(dictionaries['./locales/en.json']).filter(key => key.startsWith('studio.videoPost.'));
  expect(Object.keys(dictionary).filter(key => key.startsWith('studio.videoPost.')).sort()).toEqual(expectedKeys.sort());
  for (const key of expectedKeys) expect(dictionary[key]?.trim()).toBeTruthy();
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  vi.mocked(invoke).mockResolvedValue({ ...source, durationSeconds: null, blockers: blockerCodes });
  render(view());
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: dictionary['studio.videoPost.choose'] })));
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_video_post_inspect', { title: dictionary['studio.videoPost.dialog'] });
  const blockers = [...document.querySelectorAll('[data-video-post-blocker]')].map(element => element.textContent);
  expect(blockers).toEqual(blockerCodes.map(code => dictionary[`studio.videoPost.blocker.${code}`]));
  expect(screen.getByText(dictionary['studio.videoPost.limit'])).toBeTruthy();
  expect(document.querySelector('[data-video-post-source]')?.textContent).not.toContain('12.5 s');
});

test('unknown source rate is not displayed as zero fps', async () => {
  vi.mocked(invoke).mockResolvedValue({ ...source, fpsNumerator: 0, fpsDenominator: 1, blockers: ['cadenceUnknown'] });
  render(view()); await act(async () => choose());
  expect(document.querySelector('[data-video-post-source]')?.textContent).not.toContain('0/1 fps');
  expect(document.querySelector('[data-video-post-source]')?.textContent).toContain('Frame cadence is unknown.');
});

test('only an explicit choice invokes the native chooser and displays an inspection, never readiness', async () => {
  vi.mocked(invoke).mockResolvedValue(source);
  render(view());
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByText(/matching header rates do not prove CFR/)).toBeTruthy();
  expect(screen.getByText(/Nothing is processed by inspection/)).toBeTruthy();
  await act(async () => choose());
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_video_post_inspect', { title: 'Choose video source' });
  expect(screen.getByText('source.mp4')).toBeTruthy();
  expect(screen.getByText(/1920 × 1080 · 24000\/1001 fps/)).toBeTruthy();
  expect(screen.getByText(/12.5 s/)).toBeTruthy();
  expect(screen.getByText(/Audio streams: 2 · Subtitle streams: 1/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /run/i })).toBeNull();
});
