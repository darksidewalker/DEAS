import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { Monitoring, SAMPLE_LIMIT, describeIntent, peakSummary, timeline, type MonitoringSample } from './Monitoring';
import type { HistoryRecord } from '../studio/history';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} })) as never;

const image = { recipeId: 'diagnostic-image', version: 1, positivePrompt: 'p', negativePrompt: '', checkpoint: 'sdxl.safetensors', seed: 7, width: 896, height: 1152, steps: 30, cfg: 5, sampler: 'euler', scheduler: 'simple', denoise: 1, outputPrefix: 'raw/x' } as unknown as HistoryRecord['intent'];
const record = (id: string, patch: Partial<HistoryRecord>): HistoryRecord => ({ id, clientId: null, promptId: null, origin: 'studio', appVersion: '0.2.9', admittedAt: 1000, observedAt: 9000, revision: 1, state: 'succeeded', intent: image, outputs: [], outputRoot: null, backendOrigin: 'http://127.0.0.1:7801', error: null, startedAt: 3000, generationMs: 5000, ...patch });
const sample = (at: number, cpu = 40): MonitoringSample => ({ at, source: 'native', cpu: { percent: cpu, count: 16 }, ram: { used: 8 * 2 ** 30, total: 64 * 2 ** 30 }, swap: null, disks: [{ path: '/env', used: 2 ** 40, total: 4 * 2 ** 40 }], diskIo: { readMibS: 120.4, writeMibS: 3.2 }, gpus: [{ index: 0, name: 'RTX 5090', utilization: 3, memoryUsed: 31355 * 2 ** 20, memoryTotal: 32607 * 2 ** 20, temperature: 52, powerW: 38.6, powerLimitW: 420 }] });

beforeEach(() => { vi.useFakeTimers(); localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); vi.mocked(isTauri).mockReturnValue(true); });
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.resetAllMocks(); });

test('describes intents and derives queued/running timing from the history record', () => {
  expect(describeIntent(image)).toEqual({ pipeline: 't2i', model: 'sdxl.safetensors', size: '896×1152', steps: 30, seed: 7 });
  expect(timeline(record('a', {}))).toEqual({ queuedMs: 2000, runningMs: 5000, wallMs: 7000 });
  // Failed before a measured end: the running span ends at the last observation; never started: no running span.
  expect(timeline(record('b', { state: 'failed', generationMs: null }))).toEqual({ queuedMs: 2000, runningMs: 6000, wallMs: 8000 });
  expect(timeline(record('c', { state: 'cancelled', startedAt: null, generationMs: null }))).toEqual({ queuedMs: 8000, runningMs: 0, wallMs: 8000 });
  expect(peakSummary(undefined, 'en')).toBeNull();
  expect(peakSummary({ samples: 0, cpuPercent: 1, ramUsed: null, gpuUtilization: null, vramUsed: null, temperature: null, powerW: null, diskReadMibS: null, diskWriteMibS: null }, 'en')).toBeNull();
  expect(peakSummary({ samples: 3, cpuPercent: 81.6, ramUsed: 30 * 2 ** 30, gpuUtilization: 99, vramUsed: 31 * 2 ** 30, temperature: 71.2, powerW: 418, diskReadMibS: 240, diskWriteMibS: null }, 'en')).toBe('CPU 82 % · RAM 30 GiB · GPU 99 % · VRAM 31 GiB · 71 °C · 418 W · I/O 240 MiB/s / —');
});

test('inactive tab makes no native calls; active tab polls history and one telemetry sample per second, bounded to 60', async () => {
  let n = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'native_jobs_history') return { schemaVersion: 1, readOnly: false, error: null, records: [record('live', { state: 'running', generationMs: null }), record('ok', { peaks: { samples: 4, cpuPercent: 55, ramUsed: 20 * 2 ** 30, gpuUtilization: 97, vramUsed: 28 * 2 ** 30, temperature: 66, powerW: 400, diskReadMibS: 12, diskWriteMibS: 0.5 } }), record('bad', { state: 'failed', error: 'boom', generationMs: null })] };
    if (command === 'native_monitoring_sample') return sample(++n);
    throw new Error(`Unexpected command: ${command}`);
  });
  const view = render(<I18nProvider><Monitoring active={false} root="/env"/></I18nProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(<I18nProvider><Monitoring active root="/env"/></I18nProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(invoke).toHaveBeenCalledWith('native_monitoring_sample', { root: '/env' });
  expect(invoke).toHaveBeenCalledWith('native_jobs_history', {});
  // Only finished attempts are listed; the live one is left to the queue.
  expect(document.querySelectorAll('[data-monitoring-row]')).toHaveLength(2);
  expect(document.querySelector('[data-monitoring-headline]')!.textContent).toContain('5 sec');
  expect(document.querySelector('[data-monitoring-row="failed"]')).not.toBeNull();
  // Header line: current values compact in one paragraph; the GPU vendor prefix is dropped.
  const values = document.querySelector('[data-monitoring-values]')!.textContent!;
  expect(values).toContain('CPU 40 %'); expect(values).toContain('RAM 8 GiB / 64 GiB'); expect(values).toContain('GPU0 RTX 5090 3 %'); expect(values).toContain('I/O 120 MiB/s / 3.2 MiB/s'); expect(values).toContain('39 W');
  // Peaks per finished attempt; a record without samples says so.
  const peaks = [...document.querySelectorAll('[data-monitoring-peaks]')].map(td => td.textContent);
  expect(peaks[0]).toBe('CPU 55 % · RAM 20 GiB · GPU 97 % · VRAM 28 GiB · 66 °C · 400 W · I/O 12 MiB/s / 0.5 MiB/s');
  expect(peaks[1]).toBe('not sampled');
  // One graph per component, Generations above System.
  expect([...document.querySelectorAll('[data-monitoring-metric]')].map(f => f.getAttribute('data-monitoring-metric'))).toEqual(['cpu', 'ram', 'gpu', 'vram', 'ioRead', 'ioWrite']);
  expect(screen.getAllByRole('img', { name: /Last 60 samples/ })).toHaveLength(6);
  expect(document.querySelector('#monitoring-generations')!.compareDocumentPosition(document.querySelector('#monitoring-system')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(SAMPLE_LIMIT * 1000 + 5000); });
  expect(n).toBeGreaterThan(SAMPLE_LIMIT);
  expect(n).toBeLessThanOrEqual(SAMPLE_LIMIT + 7);
  view.rerender(<I18nProvider><Monitoring active={false} root="/env"/></I18nProvider>);
  const calls = vi.mocked(invoke).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(vi.mocked(invoke).mock.calls.length).toBe(calls);
});

test('a failed sample shows its error and history failure its own message', async () => {
  vi.mocked(invoke).mockImplementation(async command => { throw new Error(`${command} down`); });
  render(<I18nProvider><Monitoring active/></I18nProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(screen.getAllByRole('alert').map(a => a.textContent)).toEqual(expect.arrayContaining(['History could not be read. See Logs.', 'Error: native_monitoring_sample down']));
});
