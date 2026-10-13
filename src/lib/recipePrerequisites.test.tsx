import { afterEach, expect, test, vi } from 'vitest';
import { checkRecipePrerequisites } from './recipePrerequisites';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
afterEach(() => { vi.resetAllMocks(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.unstubAllGlobals(); });
test('native IPC fixture uses exact explicit endpoint and returns observed evidence', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  const fixture = { baseUrl: 'http://127.0.0.1:7801/', recipeId: 'checkpoint-text-to-image-diagnostic', version: 1, allowlist: { nodes: [], checkpoints: [], samplers: [], schedulers: [] }, missingNodes: ['KSampler'], generationReady: false };
  vi.mocked(invoke).mockResolvedValue(fixture);
  expect(await checkRecipePrerequisites('http://127.0.0.1:7801')).toBe(fixture);
  expect(invoke).toHaveBeenCalledWith('native_recipe_prerequisites', { baseUrl: 'http://127.0.0.1:7801' });
  await expect(checkRecipePrerequisites(' ')).rejects.toThrow(/explicit/);
  expect(invoke).toHaveBeenCalledTimes(1);
});
test('structured native IPC errors retain actionable technical detail', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  vi.mocked(invoke).mockRejectedValue({ code: 'HTTP_ERROR', message: 'object_info: HTTP 401', endpoint: 'http://127.0.0.1:7801/' });
  await expect(checkRecipePrerequisites('http://127.0.0.1:7801')).rejects.toThrow('HTTP_ERROR · http://127.0.0.1:7801/: object_info: HTTP 401');
});
test('browser preview fails closed without IPC or fetch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(checkRecipePrerequisites('http://127.0.0.1:7801')).rejects.toThrow(/desktop/);
  expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
