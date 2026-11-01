import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { Monitoring, SAMPLE_LIMIT, describeIntent, timeline, type MonitoringSample } from './Monitoring';
import type { HistoryRecord } from '../studio/history';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} })) as never;

const image = { recipeId: 'diagnostic-image', version: 1, positivePrompt: 'p', negativePrompt: '', checkpoint: 'sdxl.safetensors', seed: 7, width: 896, height: 1152, steps: 30, cfg: 5, sampler: 'euler', scheduler: 'simple', denoise: 1, outputPrefix: 'raw/x' } as unknown as HistoryRecord['intent'];
const record = (id: string, patch: Partial<HistoryRecord>): HistoryRecord => ({ id, clientId: null, promptId: null, origin: 'studio', appVersion: '0.2.9', admittedAt: 1000, observedAt: 9000, revision: 1, state: 'succeeded', intent: image, outputs: [], outputRoot: null, backendOrigin: 'http://127.0.0.1:7801', error: null, startedAt: 3000, generationMs: 5000, ...patch });
const sample = (at: number, cpu = 40): MonitoringSample => ({ at, source: 'native', cpu: { percent: cpu, count: 16 }, ram: { used: 8 * 2 ** 30, total: 64 * 2 ** 30 }, swap: null, disks: [{ path: '/env', used: 2 ** 40, total: 4 * 2 ** 40 }], gpus: [{ index: 0, name: 'RTX 5090', utilization: 3, memoryUsed: 31355 * 2 ** 20, memoryTotal: 32607 * 2 ** 20, temperature: 52, powerW: 38.6, powerLimitW: 420 }] });

beforeEach(() => { vi.useFakeTimers(); localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); vi.mocked(isTauri).mockReturnValue(true); });
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.resetAllMocks(); });

test('describes intents and derives queued/running timing from the history record', () => {
  expect(describeIntent(image)).toEqual({ pipeline: 't2i', model: 'sdxl.safetensors', size: '896×1152', steps: 30, seed: 7 });
  expect(timeline(record('a', {}))).toEqual({ queuedMs: 2000, runningMs: 5000, wallMs: 7000 });
  // Failed before a measured end: the running span ends at the last observation; never started: no running span.
  expect(timeline(record('b', { state: 'failed', generationMs: null }))).toEqual({ queuedMs: 2000, runningMs: 6000, wallMs: 8000 });
  expect(timeline(record('c', { state: 'cancelled', startedAt: null, generationMs: null }))).toEqual({ queuedMs: 8000, runningMs: 0, wallMs: 8000 });
});

test('inactive tab makes no native calls; active tab polls history and one telemetry sample per second, bounded to 60', async () => {
  let n = 0;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'native_jobs_history') return { schemaVersion: 1, readOnly: false, error: null, records: [record('live', { state: 'running', generationMs: null }), record('ok', {}), record('bad', { state: 'failed', error: 'boom', generationMs: null })] };
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
  const values = document.querySelector('[data-monitoring-values]')!.textContent!;
  expect(values).toContain('40 %'); expect(values).toContain('8 GiB / 64 GiB'); expect(values).toContain('RTX 5090'); expect(values).toContain('39 W / 420 W');
  expect(screen.getByRole('img', { name: /Last 60 samples/ })).toBeTruthy();
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
