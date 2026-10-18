import { invoke } from '@tauri-apps/api/core';
import families from '../families/builtin.json';

/** Prompt Forge runs in the DaSiWa node pack on the backend; `native_forge` forwards one call and adds DEAS's saved LLM endpoint. */
export interface ForgeModel { id: string; label: string; disabled?: boolean }
export interface ForgeModels { models: ForgeModel[]; errors: Record<string, string>; creativity: string[]; shot_counts: (string | number)[]; default_shots: string | number; durations?: number[] }
export interface WriteRequest { model: string; write_for: string; idea: string; detail?: number; creativity?: number; /** ComfyUI LoadImage names: input-folder relative, or `name [output]`. */ images?: string[] }
export interface H3Reference { kind: 'image'; role: 'subject' | 'keyframe'; path: string; easy_role?: string }
export interface H3Request { model: string; mode: string; brief: string; duration: number; shots: string | number; detail: number; creativity: string; references: H3Reference[]; easy: boolean; see_pictures: boolean }
export interface H3Result { simple_prompt: string; warnings: string[] }

export const H3 = 'MiniMax H3';
/** Dialects named by the family plugin, in family order. */
export const dialects = [...new Set((families as { forge?: string }[]).flatMap(f => f.forge ? [f.forge] : []))];
export const dialectOf = (family?: string) => (families as { id: string; forge?: string }[]).find(f => f.id === family)?.forge;

const call = <T>(baseUrl: string, root: string, route: string, body: object) => invoke<T>('native_forge', { baseUrl, root, route, body });
export const forgeModels = (baseUrl: string, root: string) => call<ForgeModels>(baseUrl, root, 'models', {});
export const writePrompt = (baseUrl: string, root: string, body: WriteRequest) => call<{ prompt: string; saw_images: number }>(baseUrl, root, 'write', body);
export const forgeH3 = (baseUrl: string, root: string, body: H3Request) => call<H3Result>(baseUrl, root, 'h3', body);
/** A 404 — or 405, since ComfyUI's GET-only static `/` route catches unknown POST paths — means the node pack predates these routes. */
export const forgeError = (e: unknown) => { const text = e instanceof Error ? e.message : String(e); return /^40[45]\b/.test(text) ? 'forge.outdated' : text; };
