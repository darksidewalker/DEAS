import { invoke } from '@tauri-apps/api/core';
import { discoverLlmModels, generateLlm, type LlmConfig, type LlmModel, type LlmModelRef } from './llm';
import type { MovieManifest, SegmentLimits } from './movieManifest';
import { musicRequest, parseMusicAnswer, parsePlannerAnswer, plannerRequest, type MusicCheck, type PlanCheck, type PlanMode } from './movieStory';

/** The planner's request must fit a 4096-token window together with its answer; refuse a longer brief instead of silently truncating it. */
export const PLANNER_MAX_CHARS = 6000;
export type MovieNotice = 'plan-remote' | 'plan-failed' | 'plan-invalid' | 'plan-applied' | 'join-blocked' | 'join-failed' | 'join-done' | 'join-cancelled' | 'submission-stale';
const note = (operation: MovieNotice) => void invoke('native_logs_movie_notice', { operation }).catch(() => undefined);
export const logMovieNotice = note;

export const loopbackHost = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(host);
/** Where a request with this model goes: `host` is set (and `remote` true) only for an external server that is not on this machine. Never reads the key. */
export async function plannerDestination(root: string, model: LlmModelRef): Promise<{ remote: boolean; host: string }> {
  if (model.provider === 'local') return { remote: false, host: '' };
  const config = await invoke<LlmConfig>('native_llm_read', { root });
  let host = '';
  try { host = new URL(config.baseUrl).host; } catch { host = ''; }
  const bare = host.replace(/:\d+$/, '');
  return { remote: !loopbackHost(bare), host: host || config.baseUrl };
}
export const listPlannerModels = async (root: string): Promise<LlmModel[]> => (await discoverLlmModels(root)).models;
/** Size of what would be sent, for the disclosure and the length bound. */
export function plannerPayload(m: MovieManifest, limits: SegmentLimits, mode: PlanMode = 'suggest') {
  const r = plannerRequest(m, limits, mode);
  return { ...r, chars: r.system.length + r.user.length };
}
/** One explicit completion with the chosen model, parsed and validated; throws only when the request itself failed. */
export async function requestPlan(root: string, model: LlmModelRef, m: MovieManifest, limits: SegmentLimits, mode: PlanMode = 'suggest'): Promise<PlanCheck> {
  const r = plannerRequest(m, limits, mode);
  let text: string;
  try { text = (await generateLlm(root, { model: { id: model.id, provider: model.provider }, system: r.system, prompt: r.user, maxTokens: 4095, temperature: 0.4 })).text; }
  catch (e) { note('plan-failed'); throw e; }
  const check = parsePlannerAnswer(text, m, limits, mode);
  if (!check.plan) note('plan-invalid');
  return check;
}
/** Size of the music-only request, for the disclosure and the length bound. */
export function musicPayload(m: MovieManifest) {
  const r = musicRequest(m);
  return { ...r, chars: r.system.length + r.user.length };
}
/** One explicit completion for the music only (style, tempo and — when asked for — lyrics), parsed and validated. */
export async function requestMusic(root: string, model: LlmModelRef, m: MovieManifest): Promise<MusicCheck> {
  const r = musicRequest(m);
  let text: string;
  try { text = (await generateLlm(root, { model: { id: model.id, provider: model.provider }, system: r.system, prompt: r.user, maxTokens: 2048, temperature: 0.6 })).text; }
  catch (e) { note('plan-failed'); throw e; }
  const check = parseMusicAnswer(text, m);
  if (!check.music) note('plan-invalid');
  return check;
}
