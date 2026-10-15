import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from '../../i18n/I18nProvider';
import type { JobStatus } from '../../lib/jobs';
import { JobOutputPreview } from './JobOutputPreview';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
const job: JobStatus = { id: 'job', baseUrl: 'http://127.0.0.1:7801', promptId: 'prompt', state: 'succeeded', outputs: [{ filename: 'first.png', subfolder: '', type: 'output' }, { filename: 'second.png', subfolder: '', type: 'output' }], error: null, generationReady: false };
const output = { jobId: 'job', index: 0, mimeType: 'image/png', width: 512, height: 512, sha256: 'a'.repeat(64), bytes: [137, 80, 78, 71, 13, 10, 26, 10] };
const create = vi.fn(); const revoke = vi.fn();
beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  vi.mocked(isTauri).mockReturnValue(true);
  create.mockReturnValueOnce('blob:first').mockReturnValue('blob:second');
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const view = (value = job) => <I18nProvider><JobOutputPreview key={value.id} job={value} /></I18nProvider>;
const load = (index = 0) => fireEvent.click(document.querySelector(`[data-job-output-load="${index}"]`)!);
const save = () => fireEvent.click(document.querySelector('[data-job-output-export]')!);
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test.each(['replace', 'unmount'] as const)('pending preview discarded on %s without allocating a URL', async change => {
  const pending = deferred<typeof output>(); vi.mocked(invoke).mockReturnValue(pending.promise);
  const rendered = render(view());
  load(); load(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  if (change === 'replace') rendered.rerender(view({ ...job, id: 'replacement' }));
  else rendered.unmount();
  await act(async () => pending.resolve(output));
  expect(create).not.toHaveBeenCalled();
  expect(document.querySelector('[data-job-output-preview]')).toBeNull();
  expect(document.querySelector('[data-job-output-export]')).toBeNull();
});

test('job replacement revokes a loaded preview and cannot publish an old export or error', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(output);
  const rendered = render(view()); await act(async () => load());
  const pending = deferred<{ path: string; sha256: string; size: number }>();
  vi.mocked(invoke).mockReturnValueOnce(pending.promise);
  save(); load(1); save();
  expect(invoke).toHaveBeenCalledTimes(2);
  rendered.rerender(view({ ...job, id: 'replacement' }));
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:first');
  expect(document.querySelector('[data-job-output-preview]')).toBeNull();
  await act(async () => pending.resolve({ path: '/old.png', sha256: output.sha256, size: 8 }));
  expect(document.querySelector('[data-job-output-exported]')).toBeNull();
  expect(create).toHaveBeenCalledTimes(1);
});

test('late rejected transfer cannot publish errors after unmount', async () => {
  const pending = deferred<typeof output>(); vi.mocked(invoke).mockReturnValue(pending.promise);
  const rendered = render(view()); load(); rendered.unmount();
  await act(async () => pending.reject(new Error('old transfer error')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

test('browser cannot load or export; native failures and invalid PNG responses never fabricate previews', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const rendered = render(view()); await act(async () => load());
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(isTauri).mockReturnValue(true); rendered.rerender(view());
  vi.mocked(invoke).mockRejectedValueOnce({ code: 'OUTPUT_ERROR', message: 'PNG unavailable' });
  await act(async () => load());
  expect(screen.getByRole('alert').textContent).toContain('OUTPUT_ERROR: PNG unavailable');
  vi.mocked(invoke).mockResolvedValueOnce({ ...output, mimeType: 'image/jpeg' });
  await act(async () => load());
  expect(screen.getByRole('alert').textContent).toContain('Invalid native PNG output');
  expect(create).not.toHaveBeenCalled();
  expect(document.querySelector('[data-job-output-export]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

function LanguageChange() { const { setLocale } = useI18n(); return <button onClick={() => setLocale('de')}>DE</button>; }
test('locale changes preserve preview and do not reload or export; Save As title uses current language', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(output);
  render(<I18nProvider><LanguageChange /><JobOutputPreview job={job} /></I18nProvider>);
  await act(async () => load());
  fireEvent.click(screen.getByRole('button', { name: 'DE' }));
  expect(screen.getByRole('img').getAttribute('alt')).toBe('Vorschau der Diagnoseausgabe');
  expect(invoke).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1); expect(revoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(null); await act(async () => save());
  expect(invoke).toHaveBeenLastCalledWith('native_job_export', { jobId: 'job', index: 0, title: 'Diagnose-PNG als neue Datei speichern' });
  expect(fetch).not.toHaveBeenCalled();
});

test('Save As exports only the selected native cached original; cancellation is not success and failures are visible', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(output);
  render(view());
  expect(document.querySelector('[data-job-output-export]')).toBeNull();
  await act(async () => load());
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await act(async () => save());
  expect(invoke).toHaveBeenLastCalledWith('native_job_export', { jobId: 'job', index: 0, title: 'Save diagnostic PNG as a new file' });
  expect(document.querySelector('[data-job-output-exported]')).toBeNull();
  vi.mocked(invoke).mockRejectedValueOnce({ code: 'SAVE_FAILED', message: 'No space left' });
  await act(async () => save());
  expect(screen.getByRole('alert').textContent).toContain('SAVE_FAILED: No space left');
  vi.mocked(invoke).mockResolvedValueOnce({ path: '/chosen/new-file.png', sha256: output.sha256, size: output.bytes.length });
  await act(async () => save());
  expect(document.querySelector('[data-job-output-exported]')!.textContent).toContain('/chosen/new-file.png');
  expect(document.querySelector('[data-job-output-exported]')!.textContent).toContain(output.sha256);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'native_job_output')).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});

test('explicit native load creates only an original PNG Blob, replacement and unmount revoke URLs', async () => {
  vi.mocked(invoke).mockResolvedValue(output);
  const rendered = render(view());
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-job-output-export]')).toBeNull();
  await act(async () => load());
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_job_output', { jobId: 'job', index: 0 });
  const blob = create.mock.calls[0][0] as Blob;
  expect(blob.type).toBe('image/png');
  const bytes = await new Promise<ArrayBuffer>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob); });
  expect(Array.from(new Uint8Array(bytes))).toEqual(output.bytes);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:first');
  expect(screen.getByRole('img').getAttribute('alt')).toBe('Diagnostic output preview');
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue({ ...output, index: 1 });
  await act(async () => load(1));
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:first');
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:second');
  rendered.unmount();
  expect(revoke).toHaveBeenLastCalledWith('blob:second');
});
