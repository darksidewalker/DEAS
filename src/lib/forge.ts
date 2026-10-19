import { invoke } from '@tauri-apps/api/core';
import families from '../families/builtin.json';

/** Prompt Forge runs in the DaSiWa node pack on the backend; `native_forge` forwards one call and adds DEAS's saved LLM endpoint. */
export interface ForgeModel { id: string; label: string; disabled?: boolean }
export interface ForgeModels { models: ForgeModel[]; errors: Record<string, string>; creativity: string[]; shot_counts: (string | number)[]; default_shots: string | number; durations?: number[] }
export interface WriteRequest { model: string; write_for: string; idea: string; detail?: number; creativity?: number; /** ComfyUI LoadImage names: input-folder relative, or `name [output]`. */ images?: string[] }
/** One Director Forge reference (`js/minimax_h3_forge_state.js::forgeReferences`): `path` is input-folder relative and only sent when the file lives there. */
export interface H3Reference { kind: 'image' | 'video' | 'audio'; role?: string; path?: string; easy_role?: string; stream?: 'video' | 'audio' | 'both'; subject_group?: string; duration_seconds?: number; instructions?: string }
export interface H3Request { model: string; mode: string; brief: string; duration: number; shots: string | number; detail: number; creativity: string; references: H3Reference[]; easy: boolean; see_pictures: boolean; shot_briefs?: string[]; output_canvas?: { width: number; height: number }; request_id?: string; /** Cast & scene cards: `{"1": text, place: text, style: text}`, each ≤ 600 chars. */ cast?: Record<string, string> }
export interface H3Result { simple_prompt: string; warnings: string[] }

export const H3 = 'MiniMax H3';
/** Dialects named by the family plugin, in family order. */
export const dialects = [...new Set((families as { forge?: string }[]).flatMap(f => f.forge ? [f.forge] : []))];
export const dialectOf = (family?: string) => (families as { id: string; forge?: string }[]).find(f => f.id === family)?.forge;

const call = <T>(baseUrl: string, root: string, route: string, body: object) => invoke<T>('native_forge', { baseUrl, root, route, body });
export const forgeModels = (baseUrl: string, root: string) => call<ForgeModels>(baseUrl, root, 'models', {});
export const writePrompt = (baseUrl: string, root: string, body: WriteRequest) => call<{ prompt: string; saw_images: number }>(baseUrl, root, 'write', body);
export const forgeH3 = (baseUrl: string, root: string, body: H3Request) => call<H3Result>(baseUrl, root, 'h3', body);
/** Reads one Cast or scene card from the labelled pictures (needs a vision model). */
export interface CastRequest { model: string; mode: string; character?: number; subject?: 'place' | 'style'; references: H3Reference[]; brief: string; shots: string | number; shot_briefs: string[]; redo?: boolean; request_id?: string }
export const readCast = (baseUrl: string, root: string, body: CastRequest) => call<{ text: string }>(baseUrl, root, 'cast', body);
/** Stops the running Director Forge call that carries this `request_id`. */
export const cancelForge = (baseUrl: string, root: string, request_id: string) => call<{ cancelled: boolean }>(baseUrl, root, 'cancel', { request_id });
/** A 404 — or 405, since ComfyUI's GET-only static `/` route catches unknown POST paths — means the node pack predates these routes. */
export const forgeError = (e: unknown) => { const text = e instanceof Error ? e.message : String(e); return /^40[45]\b/.test(text) ? 'forge.outdated' : text; };
