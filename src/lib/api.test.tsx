import { afterEach, expect, test, vi } from 'vitest';
import { negotiateApi } from './api';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({invoke:vi.fn()}));
afterEach(() => { delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__; vi.resetAllMocks(); });
test('blank and browser-preview endpoints never invoke native IPC or fetch', async () => {
  const fetchSpy=vi.spyOn(globalThis,'fetch');
  try {
    await expect(negotiateApi(' ')).rejects.toThrow('explicit');
    await expect(negotiateApi('http://127.0.0.1:7801')).rejects.toThrow('desktop');
    expect(invoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});
test('desktop calls exactly the read-only command with the explicit unchanged endpoint', async () => {
  (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__={};
  const result={baseUrl:'http://127.0.0.1:8189/',protocol:'v2',generationReady:false,capabilities:['v2Health','v2JobListing']};
  vi.mocked(invoke).mockResolvedValue(result);
  expect(await negotiateApi('http://127.0.0.1:8189')).toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native_negotiate_api',{baseUrl:'http://127.0.0.1:8189'});
});
test('structured native authentication failure retains actionable code and endpoint', async () => {
  (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__={};
  vi.mocked(invoke).mockRejectedValue({code:'authentication',endpoint:'api/v2/jobs?limit=1',message:'Probe returned HTTP 401'});
  await expect(negotiateApi('http://127.0.0.1:8189')).rejects.toThrow('authentication · api/v2/jobs?limit=1: Probe returned HTTP 401');
});
