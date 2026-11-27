import { invoke } from '@tauri-apps/api/core';
import { MUSIC_TEXT_LIMITS, completeItem, newItem, setMusicFile, setShotLoras, type MovieItem, type MovieLora, type MovieMix, type MovieManifest } from './movieManifest';
import type { WizardHandoff } from './wizards';
import { aceMusicProfile } from './musicIntent.ts';
import { styleFor } from './musicPresets.ts';

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
/** Length of a music file in seconds (native ffprobe; same file checks as the mix). */
export const musicInfo = (path: string) => invoke<{ seconds: number }>('native_movie_music_info', { path });
export const pickMusic = (title: string) => invoke<string | null>('native_movie_pick_music', { title });
/** Records the scored film on the score item. */
export function recordScore(m: MovieManifest, r: MixAnswer): MovieManifest {
  const score = m.items.find(i => i.kind === 'score');
  if (!score) throw new Error('This movie has no score item.');
  return completeItem(m, score.id, { outputId: r.path, seconds: r.seconds });
}

// --- generating the track (UX-22d5c) ----------------------------------------------------------------------------------------------
/** Music families Movie Maker can ask Generate for, ACE-Step 1.5 first (owner default), quick variants first within a family; YuE2 last (CC-BY-NC weights). */
export const MUSIC_FAMILIES = ['ace-step-1-5-turbo', 'ace-step-1-5-xl-turbo', 'ace-step-1-5-sft', 'ace-step-1-5-base', 'ace-step-1-5-xl-sft', 'ace-step-1-5-xl-base', 'yue2'] as const;
export const isRestrictedMusicFamily = (family: string | null | undefined) => family === 'yue2';
/** Length of the bed: the joined film when it is made, else the sum of the planned shots, else the movie's target; whole seconds, at least 1. */
export function musicSeconds(m: MovieManifest): number {
  const final = m.items.find(i => i.id === 'final');
  const made = final?.state === 'done' ? final.revisions.find(r => r.n === final.revision)?.result?.seconds : undefined;
  const shots = m.items.filter(i => i.kind === 'segment').reduce((a, s) => a + (s.seconds ?? 0), 0);
  return Math.min(1000, Math.max(1, Math.ceil(made ?? (shots > 0 ? shots : m.targetSeconds))));
}
export type MusicHandoff = { handoff: Omit<WizardHandoff, 'n'> } | { blocked: 'wizards.movie.music.needPrompt' } | { blocked: 'wizards.movie.music.loraYue2' } | { blocked: 'wizards.movie.music.loraMissing'; detail: string };
/**
 * The hand-over that makes the track: the music item's text is the style (a preset's text in the model's own dialect), its lyrics
 * (empty = an instrumental bed), the film's length and the music item's LoRAs (ACE-Step only: YuE2 has no LoRA path; every LoRA must
 * still be installed). ACE-Step 1.5 also gets the tempo and lyrics language when set; with the movie's own settings (`sampling`), the
 * model's starting Steps/CFG/sampler/scheduler ride along so a Turbo and a Base model each sample as they should.
 */
export function musicHandoff(m: MovieManifest, model: { name: string; path: string; family?: string | null }, run: boolean, hasLora?: (name: string) => boolean, sampling = false): MusicHandoff {
  const item = m.items.find(i => i.kind === 'music');
  const style = styleFor(item?.text ?? '', item?.preset, model.family).trim();
  if (!style) return { blocked: 'wizards.movie.music.needPrompt' };
  const loras = (item?.loras ?? []).map(l => ({ name: l.name, strength: l.strength }));
  if (loras.length && isRestrictedMusicFamily(model.family)) return { blocked: 'wizards.movie.music.loraYue2' };
  const gone = hasLora ? loras.find(l => !hasLora(l.name)) : undefined;
  if (gone) return { blocked: 'wizards.movie.music.loraMissing', detail: gone.name };
  const ace = aceMusicProfile(model.family ?? undefined);
  const v15 = ace?.version === '1.5';
  const music = { style, lyrics: item?.lyrics?.trim() ?? '', seconds: musicSeconds(m), ...(v15 && item?.bpm ? { bpm: item.bpm } : {}), ...(v15 && item?.language ? { language: item.language } : {}) };
  return { handoff: { wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', model: { name: model.name, path: model.path }, positive: '', run, music, loras,
    ...(sampling && ace ? { sampling: { steps: ace.steps, cfg: ace.cfg, sampler: ace.sampler, scheduler: ace.scheduler } } : {}) } };
}
/** Sets the music item's LoRAs, creating the music item when needed (like the style text). */
export function setMusicLoras(m: MovieManifest, loras: readonly MovieLora[]): MovieManifest {
  const next = m.items.some(i => i.kind === 'music') ? m : { ...m, items: [...m.items, newItem('music', 'music', 'Music', ['brief'])] };
  return setShotLoras(next, next.items.find(i => i.kind === 'music')!.id, loras);
}
/** Creates the music item when needed and sets the style text the track is generated from. */
export function setMusicPrompt(m: MovieManifest, text: string): MovieManifest {
  const next = m.items.some(i => i.kind === 'music') ? m : { ...m, items: [...m.items, newItem('music', 'music', 'Music', ['brief'])] };
  const music = next.items.find(i => i.kind === 'music')!;
  return text === music.text ? next : { ...next, items: next.items.map(i => i === music ? { ...i, text, revision: i.revision + 1, state: 'planned' as const, revisions: [...i.revisions, { n: i.revision + 1, text }].slice(-20) } : i) };
}
/** A generated track becomes the music file (so the scored film goes outdated) and the music item's result. */
export function recordGeneratedMusic(m: MovieManifest, run: { state: string; job?: { id: string }; picture?: { path: string; audio?: boolean } }): MovieManifest {
  const music = m.items.find(i => i.kind === 'music');
  if (!music) return m;
  if (run.state === 'succeeded' && run.picture?.audio) return completeItem(setMusicFile(m, run.picture.path), music.id, { outputId: run.picture.path, ...(run.job ? { jobId: run.job.id } : {}) });
  return run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded' ? { ...m, items: m.items.map(i => i.id === music.id ? { ...i, state: 'failed' as const } : i) } : m;
}
/** Music-only settings (lyrics, tempo, language, preset, planner-writes-lyrics), creating the music item when needed. Lyrics are a revision like the style; the rest is a plain setting. */
export function setMusicFields(m: MovieManifest, patch: Partial<Pick<MovieItem, 'lyrics' | 'bpm' | 'language' | 'preset' | 'vocals'>>): MovieManifest {
  const next = m.items.some(i => i.kind === 'music') ? m : { ...m, items: [...m.items, newItem('music', 'music', 'Music', ['brief'])] };
  const music = next.items.find(i => i.kind === 'music')!;
  const clean: Partial<MovieItem> = {};
  for (const [k, v] of Object.entries(patch) as [keyof typeof patch, unknown][]) (clean as Record<string, unknown>)[k] = v === '' || v === false ? undefined : v;
  if (clean.bpm !== undefined) clean.bpm = Math.round(Math.min(MUSIC_TEXT_LIMITS.bpm[1], Math.max(MUSIC_TEXT_LIMITS.bpm[0], clean.bpm)));
  if (clean.lyrics !== undefined) clean.lyrics = clean.lyrics.slice(0, MUSIC_TEXT_LIMITS.lyrics);
  const changed = (Object.keys(clean) as (keyof MovieItem)[]).some(k => JSON.stringify(clean[k]) !== JSON.stringify(music[k]));
  if (!changed) return next;
  return { ...next, items: next.items.map(i => i === music ? { ...i, ...clean, state: i.state === 'failed' ? 'planned' as const : i.state } : i) };
}
