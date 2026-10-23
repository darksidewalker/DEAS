import { Channel, invoke } from '@tauri-apps/api/core';
import { isString, readPref } from './preferences';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface ChatHit { n: number; title: string; url: string; domain: string; snippet: string }
export interface WrittenPrompt { target: string; label: string; prompt: string; negative?: string | null }
export interface ChatMessage { role: 'user' | 'assistant'; content: string; pictures: number; prompts: WrittenPrompt[]; citations: ChatHit[]; tools: string[]; at: number }
export interface ChatThread { id: string; title: string; model: string; created: number; updated: number; messages: ChatMessage[] }
export interface ChatSummary { id: string; title: string; updated: number; count: number }
export interface ChatSettings { search: 'off' | 'duckduckgo' | 'searxng'; searxngUrl: string }
export type ChatEvent =
  | { event: 'chat'; id: string; title: string }
  | { event: 'searched'; query: string; results: ChatHit[]; detail: string | null }
  | { event: 'status'; state: string; detail: string | null }
  | { event: 'text'; text: string }
  | { event: 'prompt'; prompt: WrittenPrompt }
  | { event: 'done'; message: ChatMessage };
export interface ChatSend { id?: string; message: string; model: string; pictures: string[]; context?: string; search: boolean }

/** One turn, streamed: `onEvent` sees the text as it is written. Resolves with the finished answer. */
export function sendChat(root: string, request: ChatSend, onEvent: (e: ChatEvent) => void) {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<ChatMessage>('native_chat_send', { root, request, onEvent: channel });
}
export const cancelChat = (id: string) => invoke<boolean>('native_chat_cancel', { id });
export const listChats = (root: string) => invoke<ChatSummary[]>('native_chat_list', { root });
export const getChat = (root: string, id: string) => invoke<ChatThread>('native_chat_get', { root, id });
export const renameChat = (root: string, id: string, title: string) => invoke<void>('native_chat_rename', { root, id, title });
export const deleteChat = (root: string, id: string) => invoke<void>('native_chat_delete', { root, id });
export const chatSettings = (root: string) => invoke<ChatSettings>('native_chat_settings', { root });
export const saveChatSettings = (root: string, settings: ChatSettings) => invoke<ChatSettings>('native_chat_settings_write', { root, settings });

/** What the person is working on, read from Studio and Prompt Forge at the moment they send. */
export function workingContext() {
  const s = (key: string) => readPref(key, '', isString).trim();
  const n = (key: string) => readPref(key, 0, isNumber);
  const lines = [
    s('studio.tab') && `Open tab: ${s('studio.tab')}`,
    s('studio.run.pipeline') && `Studio pipeline: ${s('studio.run.pipeline')}`,
    s('studio.run.checkpoint') && `Model / checkpoint: ${s('studio.run.checkpoint')}`,
    n('studio.run.width') && n('studio.run.height') ? `Size: ${n('studio.run.width')}×${n('studio.run.height')}` : '',
    n('studio.run.steps') ? `Steps ${n('studio.run.steps')}, CFG ${n('studio.run.cfg')}, sampler ${s('studio.run.sampler') || 'default'} / ${s('studio.run.scheduler') || 'default'}` : '',
    s('studio.run.positive') && `Studio positive prompt:\n${s('studio.run.positive')}`,
    s('studio.run.negative') && `Studio negative prompt:\n${s('studio.run.negative')}`,
    s('forge.brief') && `Prompt Forge brief${s('forge.target') ? ` (writing for ${s('forge.target')})` : ''}:\n${s('forge.brief')}`,
  ].filter(Boolean);
  return lines.join('\n');
}
