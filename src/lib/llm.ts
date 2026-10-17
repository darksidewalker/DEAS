import { invoke } from '@tauri-apps/api/core';

export type LlmProvider = 'local' | 'ollama' | 'openai';
export interface LlmConfig { provider: LlmProvider; baseUrl: string }
export interface LlmModelRef { id: string; provider: LlmProvider }
export interface LlmModel extends LlmModelRef { name: string }
export interface LlmModels { models: LlmModel[]; warnings: string[] }
export interface LlmRequest { model: LlmModelRef; system: string; prompt: string; maxTokens: number; temperature: number }
export interface LlmResult { text: string; backend: LlmProvider }
export const defaultLlmConfig: LlmConfig = { provider: 'local', baseUrl: 'http://127.0.0.1:11434' };

/** Read-only discovery of local models and the saved optional external endpoint. */
export function discoverLlmModels(root: string): Promise<LlmModels> {
  return invoke<LlmModels>('native_llm_models', { root });
}

/** Explicit completion with a per-request model, never a global model preference. */
export function generateLlm(root: string, request: LlmRequest): Promise<LlmResult> {
  return invoke<LlmResult>('native_llm_generate', { root, request });
}
