import { afterEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, readCurrentDiagnosticJob, loadDiagnosticJobOutput, exportDiagnosticJobOutput } from './jobs';
import type { DiagnosticImageIntentV1 } from './execution';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
const intent: DiagnosticImageIntentV1 = {
  recipeId: 'checkpoint-text-to-image-diagnostic', version: 1, positivePrompt: 'test', negativePrompt: '',
  checkpoint: 'observed.safetensors', seed: 0, width: 512, height: 512, steps: 20, cfg: 7,
  sampler: 'euler', scheduler: 'normal', outputPrefix: 'DEAS_diagnostic',
};
test('native-only commands preserve exact intent, explicit consent and job identity', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const response = { id: 'native-id' };
  vi.mocked(invoke).mockResolvedValue(response);
  expect(await prepareDiagnosticJob('http://127.0.0.1:7801/prefix/', intent)).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_prepare', { baseUrl: 'http://127.0.0.1:7801/prefix/', intent });
  expect(await submitDiagnosticJob('plan-id')).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_submit', { planId: 'plan-id', confirmed: true });
  expect(await readDiagnosticJobStatus('job-id')).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_status', { jobId: 'job-id' });
  expect(await readCurrentDiagnosticJob()).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_current', {});
  vi.mocked(invoke).mockResolvedValue(null);
  expect(await readCurrentDiagnosticJob()).toBeNull();
});
test('browser fails closed for all job commands without IPC or browser fetch', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const request of [prepareDiagnosticJob('http://127.0.0.1:7801', intent), submitDiagnosticJob('plan'), readDiagnosticJobStatus('job'), readCurrentDiagnosticJob(), loadDiagnosticJobOutput('job', 0), exportDiagnosticJobOutput('job', 0, 'Save')]) {
    await expect(request).rejects.toThrow('desktop app');
  }
  expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
test('output transfer and Save As are explicit native commands', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const output = { jobId: 'job', index: 0, mimeType: 'image/png', width: 512, height: 512, sha256: 'a'.repeat(64), bytes: [137, 80, 78, 71] };
  vi.mocked(invoke).mockResolvedValue(output);
  expect(await loadDiagnosticJobOutput('job', 0)).toEqual(output);
  expect(invoke).toHaveBeenLastCalledWith('native_job_output', { jobId: 'job', index: 0 });
  vi.mocked(invoke).mockResolvedValue(null);
  expect(await exportDiagnosticJobOutput('job', 0, 'Save PNG')).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('native_job_export', { jobId: 'job', index: 0, title: 'Save PNG' });
});
test.each([{ mimeType: 'image/jpeg' }, { jobId: 'foreign' }, { index: 1 }, { bytes: [] }, { bytes: [256] }, { bytes: [-1] }, { bytes: [0.5] }, { width: 8193 }, { width: 8192, height: 8192 }, { height: 0 }, { sha256: 'A'.repeat(64) }])('rejects malformed output before Blob allocation: %s', async invalid => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue({ jobId: 'job', index: 0, mimeType: 'image/png', width: 512, height: 512, sha256: 'a'.repeat(64), bytes: [137], ...invalid });
  await expect(loadDiagnosticJobOutput('job', 0)).rejects.toThrow('Invalid native PNG output');
});
test('rejects oversized and sparse byte arrays before allocating a typed buffer', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  for (const bytes of [new Array(144 * 1024 * 1024 + 1), new Array(1)]) {
    vi.mocked(invoke).mockResolvedValue({ jobId: 'job', index: 0, mimeType: 'image/png', width: 1, height: 1, sha256: 'a'.repeat(64), bytes });
    await expect(loadDiagnosticJobOutput('job', 0)).rejects.toThrow('Invalid native PNG output');
  }
});
test('4K PNG metadata passes the same dimension and pixel bounds as native output',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 const output={jobId:'job',index:0,mimeType:'image/png',width:3840,height:2160,sha256:'a'.repeat(64),bytes:[137,80,78,71]};
 vi.mocked(invoke).mockResolvedValue(output);
 expect(await loadDiagnosticJobOutput('job',0)).toEqual(output);
});
test('empty endpoints are rejected before IPC, native errors retain code and message', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  await expect(prepareDiagnosticJob('  ', intent)).rejects.toThrow('explicit backend endpoint');
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockRejectedValue({ code: 'MODEL_ERROR', message: 'Checkpoint failed to load' });
  await expect(submitDiagnosticJob('plan')).rejects.toThrow('MODEL_ERROR: Checkpoint failed to load');
});
