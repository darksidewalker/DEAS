import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useForgeModels } from './ForgeButton';
import { nativeModelId } from '../../lib/forge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test.each(['local:nested/model.gguf', 'ollama:qwen:latest', 'openai:remote'])('native request strips only the provider prefix from %s', id => {
  expect(nativeModelId(id)).toBe(id.slice(id.indexOf(':') + 1));
});

test('native model discovery lists provider-qualified models and diagnostics without ComfyUI', async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'native_llm_models') return { models: [
      { provider: 'local', id: 'nested/model.gguf', name: 'Local model' },
      { provider: 'ollama', id: 'qwen:latest', name: 'Qwen' },
      { provider: 'openai', id: 'remote', name: 'Remote' },
    ], warnings: ['Optional endpoint unavailable'] };
    throw Error(`Unexpected ${command}`);
  });
  const { result } = renderHook(() => useForgeModels('', '/env'));
  act(() => result.current.load());
  await waitFor(() => expect(result.current.usable.map(m => m.id)).toEqual(['local:nested/model.gguf', 'ollama:qwen:latest', 'openai:remote']));
  expect(result.current.usable.map(m => m.label)).toEqual(['Local model', 'Qwen', 'Remote']);
  expect(Object.values(result.current.list!.errors)).toEqual(['Optional endpoint unavailable']);
  expect(vi.mocked(invoke).mock.calls).toEqual([['native_llm_models', { root: '/env' }]]);
});
