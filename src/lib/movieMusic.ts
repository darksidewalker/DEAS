import { invoke } from '@tauri-apps/api/core';
import { completeItem, type MovieMix, type MovieManifest } from './movieManifest';

export interface MixAnswer { path: string; seconds: number; ducked: boolean }
export type MixPlan = { ok: true; film: string; music: string; mix: MovieMix } | { ok: false; why: 'noMusic' | 'noFilm' | 'filmOutdated' | 'mode' };
const VIDEO = /\.(mp4|mov|mkv|webm)$/i;
/** What the mix needs: the joined film (made, up to date, a video file), a music file, and the `mix` mode (the H3-reference mode is a different path and never mixes). */
export function mixPlan(m: MovieManifest): MixPlan {
  const final = m.items.find(i => i.id === 'final'), music = m.items.find(i => i.kind === 'music'), score = m.items.find(i => i.kind === 'score');
  if (!music?.file || !score?.mix) return { ok: false, why: 'noMusic' };
  if (score.mix.mode !== 'mix') return { ok: false, why: 'mode' };
  const film = final?.revisions.find(r => r.n === final.revision)?.result?.outputId;
  if (!final || final.state === 'stale') return { ok: false, why: 'filmOutdated' };
  if (final.state !== 'done' || !film || !VIDEO.test(film)) return { ok: false, why: 'noFilm' };
  return { ok: true, film, music: music.file, mix: score.mix };
}
/** Mixes the music onto the film beside it under a fresh name; the original film is never changed. */
export const mixMusic = (p: Extract<MixPlan, { ok: true }>) =>
  invoke<MixAnswer>('native_movie_mix', { request: { film: p.film, music: p.music, levelDb: p.mix.levelDb, duckDb: p.mix.duckDb, fadeSeconds: p.mix.fadeSeconds } });
export const pickMusic = (title: string) => invoke<string | null>('native_movie_pick_music', { title });
/** Records the scored film on the score item. */
export function recordScore(m: MovieManifest, r: MixAnswer): MovieManifest {
  const score = m.items.find(i => i.kind === 'score');
  if (!score) throw new Error('This movie has no score item.');
  return completeItem(m, score.id, { outputId: r.path, seconds: r.seconds });
}
