/**
 * Movie Maker segment stage (UX-22d4a): turns one planned shot into an ordinary MiniMax H3 draft for Generate — text-to-video, or
 * REF2VA with the shot's cast pictures as references — and records the finished clip on the manifest. Only shots that start a new take
 * (a cut) are handled; continued shots need H3 Continuity and are reported as not supported yet. Nothing here runs anything.
 */
import { completeItem, failItem, type MovieItem, type MovieManifest } from './movieManifest.ts';
import { h3ActualSeconds } from './movieStory.ts';
import type { WizardHandoff, WizardPicture } from './wizards.ts';
import { renderCanvas, renderSampling } from './movieRender.ts';

/** The video family every Movie Maker shot is made with. */
export const SHOT_FAMILY = 'minimax-h3';

export const H3_REFERENCE_LIMIT = 12;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** How a scene's inputs go to Generate: its frames (I2VA/FL2VA) or its references (REF2VA) with every Director option, as Generate holds them. */
export interface SceneHandoffParts { pipeline: 't2v' | 'i2v' | 'v2v' | 'ref2v'; frames?: NonNullable<WizardHandoff['frames']>; videoRefs?: NonNullable<WizardHandoff['videoRefs']>; source?: WizardPicture }
/** Pipeline and inputs from the scenes' inputs (a chain passes all its scenes: frames come from the first, references from all, without repeats). */
export function sceneParts(scenes: MovieItem[], toSrc: (path: string) => string): SceneHandoffParts | { blocked: string } {
  const pic = (x: { path: string }): WizardPicture => ({ name: fileName(x.path), path: x.path, src: toSrc(x.path) });
  const first = scenes[0]?.inputs;
  const refs = scenes.flatMap(s => s.inputs?.refs ?? []).filter((r, n, all) => all.findIndex(x => x.path === r.path && x.mediaMode === r.mediaMode) === n);
  const frames = first?.first || first?.last ? { ...(first.first ? { first: pic(first.first) } : {}), ...(first.last ? { last: pic(first.last) } : {}) } : undefined;
  // MiniMax H3 does not mix frames with references (`family.video.mixReferences`); the scene editor keeps them apart, a chain could join them.
  if (refs.length && frames) return { blocked: 'wizards.movie.shot.mixedInputs' };
  if (refs.length > H3_REFERENCE_LIMIT) return { blocked: 'wizards.movie.shot.tooManyRefs' };
  if (refs.length) return { pipeline: 'ref2v', videoRefs: refs.map(r => ({ ...r, name: fileName(r.path), src: toSrc(r.path) })) };
  if (first?.source) return { pipeline: 'v2v', source: pic(first.source), ...(frames ? { frames } : {}) };
  return frames ? { pipeline: 'i2v', frames } : { pipeline: 't2v' };
}
/** What Generate has installed, so a shot's own model and LoRAs can be checked before anything is handed over. */
export interface ShotEnv { resolveModel: (name: string) => { name: string; path: string } | undefined; hasLora: (name: string) => boolean }
export type ShotBlock = { blocked: 'wizards.movie.shot.modelMissing' | 'wizards.movie.shot.loraMissing'; detail: string };
/** The model and LoRAs a shot is made with: its own model when set (it must be installed), else the default; its LoRAs must all be installed. */
export function shotSettings(shot: MovieItem, defaultModel: { name: string; path: string }, env?: ShotEnv): { model: { name: string; path: string }; loras: { name: string; strength: number }[] } | ShotBlock {
  let model = defaultModel;
  if (shot.model) {
    const own = env?.resolveModel(shot.model);
    if (env && !own) return { blocked: 'wizards.movie.shot.modelMissing', detail: shot.model };
    if (own) model = own;
  }
  const loras = (shot.loras ?? []).map(l => ({ name: l.name, strength: l.strength }));
  const gone = env ? loras.find(l => !env.hasLora(l.name)) : undefined;
  if (gone) return { blocked: 'wizards.movie.shot.loraMissing', detail: gone.name };
  return { model, loras };
}
/** Where a shot starts in the finished film: the made length of every shot before it (a continued shot counts its whole-17-frame extension). */
export function shotOffset(m: MovieManifest, shotId: string): number {
  const shots = m.items.filter(i => i.kind === 'segment');
  const at = shots.findIndex(s => s.id === shotId);
  return shots.slice(0, Math.max(at, 0)).reduce((a, s, n) => a + h3ActualSeconds(s.seconds ?? 0, !!s.continuous && n > 0), 0);
}
export type AudioBlock = { blocked: 'wizards.movie.shot.audioNeedsPicture' | 'wizards.movie.shot.audioTrackShort' | 'wizards.movie.shot.audioNoChain' | 'wizards.movie.shot.audioClipLength'; detail?: string };
/** The music track as the shot's audio reference: its slice of the track (start = the shot's place in the film, length = the shot's seconds). Reference mode only. */
export function shotAudio(m: MovieManifest, shot: MovieItem, hasPictures: boolean, track: { path: string; seconds: number }, toSrc: (p: string) => string): { audioRef: NonNullable<WizardHandoff['audioRef']> } | AudioBlock {
  if (!hasPictures) return { blocked: 'wizards.movie.shot.audioNeedsPicture' };
  const len = shot.seconds ?? 0, start = Math.round(shotOffset(m, shot.id) * 1000) / 1000, end = Math.round((start + len) * 1000) / 1000;
  if (len < 2 || len > 15) return { blocked: 'wizards.movie.shot.audioClipLength', detail: `${len} s` };
  if (end > track.seconds + 1e-6) return { blocked: 'wizards.movie.shot.audioTrackShort', detail: `${track.seconds.toFixed(1)} s / ${end.toFixed(1)} s` };
  return { audioRef: { name: track.path.split(/[\\/]/).pop() ?? track.path, path: track.path, src: toSrc(track.path), trimStart: start, trimEnd: end } };
}
/**
 * The canvas a shot is handed over with (`movieRender.ts`): with the movie's own settings a fixed aspect becomes the exact H3 canvas of
 * that ratio at the movie's resolution choice, computed like Generate's resolution settings; `auto` hands over Generate's auto aspect with
 * that choice; with Generate's settings only the aspect goes over. Never a size Generate would not compute itself.
 */
export const movieCanvas = (m: MovieManifest) => renderCanvas(m, SHOT_FAMILY);
export type ShotHandoff = { handoff: Omit<WizardHandoff, 'n'>; skipped: number } | { blocked: string; detail?: string };
/** Text of the scene as the model reads it: what happens and who is in it, the state it starts from and ends in, and the spoken lines. */
export function shotPrompt(_m: MovieManifest, shot: MovieItem): string {
  const parts = [shot.text.trim()];
  if (shot.entry?.trim()) parts.push(`At the start: ${shot.entry.trim()}`);
  for (const d of shot.dialogue ?? []) parts.push(`${d.speaker} says: "${d.line}"${d.delivery ? ` (${d.delivery})` : ''}.`);
  if (shot.exit?.trim()) parts.push(`At the end: ${shot.exit.trim()}`);
  return parts.filter(Boolean).join(' ');
}
/**
 * The hand-over for one scene. `blocked` is an i18n key. The scene's frames, source clip and references go to Generate exactly as the
 * scene editor assigned them; with none the scene is plain text-to-video. `toSrc` makes a webview URL for a path.
 */
export function shotHandoff(m: MovieManifest, segmentId: string, defaultModel: { name: string; path: string }, run: boolean, toSrc: (path: string) => string, env?: ShotEnv, track?: { path: string; seconds: number }): ShotHandoff {
  const shot = m.items.find(i => i.id === segmentId && i.kind === 'segment');
  if (!shot) return { blocked: 'wizards.movie.shot.unknown' };
  const order = m.items.filter(i => i.kind === 'segment');
  if (shot.continuous && order[0]?.id !== shot.id) return { blocked: 'wizards.movie.shot.continued' };
  const settings = shotSettings(shot, defaultModel, env);
  if ('blocked' in settings) return settings;
  const { model, loras } = settings;
  const parts = sceneParts([shot], toSrc);
  if ('blocked' in parts) return parts;
  const pictures = !!parts.videoRefs?.some(r => r.media === 'image');
  const audio = track ? shotAudio(m, shot, pictures, track, toSrc) : undefined;
  if (audio && 'blocked' in audio) return audio;
  const pipeline = audio && parts.pipeline !== 'ref2v' ? 'ref2v' : parts.pipeline;
  return {
    skipped: 0,
    handoff: {
      wizard: 'movie', strategy: shot.id, pipeline, source: 'movie', model,
      ...(parts.frames ? { frames: parts.frames } : {}), ...(parts.videoRefs ? { videoRefs: parts.videoRefs } : {}), ...(parts.source ? { sourceVideo: parts.source } : {}),
      positive: shotPrompt(m, shot), ...movieCanvas(m), ...renderSampling(m, shot, SHOT_FAMILY, model.name, defaultModel.name), seconds: shot.seconds, run, ...(loras.length ? { loras } : {}), ...(audio ? audio : {}),
    },
  };
}
/** Records what a wizard run reported for a shot: a finished video becomes the item's result, any other end marks it failed. */
export function recordShotRun(m: MovieManifest, segmentId: string, run: { state: string; job?: { id: string }; picture?: { path: string; video?: boolean } }, seconds?: number): MovieManifest {
  if (run.state === 'succeeded' && run.picture?.video) return completeItem(m, segmentId, { outputId: run.picture.path, ...(run.job ? { jobId: run.job.id } : {}), ...(seconds ? { seconds } : {}) });
  return run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded' ? failItem(m, segmentId) : m;
}
