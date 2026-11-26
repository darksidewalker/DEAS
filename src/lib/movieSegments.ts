/**
 * Movie Maker segment stage (UX-22d4a): turns one planned shot into an ordinary MiniMax H3 draft for Generate — text-to-video, or
 * REF2VA with the shot's cast pictures as references — and records the finished clip on the manifest. Only shots that start a new take
 * (a cut) are handled; continued shots need H3 Continuity and are reported as not supported yet. Nothing here runs anything.
 */
import { completeItem, failItem, type MovieItem, type MovieManifest } from './movieManifest.ts';
import { h3ActualSeconds } from './movieStory.ts';
import { wizardCanvas, type WizardHandoff, type WizardPicture } from './wizards.ts';

export const H3_REFERENCE_LIMIT = 12;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const LABEL: Record<string, string | undefined> = { location: 'place', style: 'style' };

/** Reference pictures of the given shots' cast entries, in order of first use, without repeats (images only; other files are counted). */
export function shotPictures(m: MovieManifest, shots: MovieItem[]): { picks: { path: string; label?: string; note?: string }[]; skipped: number } {
  const picks: { path: string; label?: string; note?: string }[] = [];
  const skippedFiles = new Set<string>();
  for (const shot of shots) for (const id of shot.deps) {
    const c = m.items.find(i => i.id === id && i.kind === 'cast');
    if (!c) continue;
    for (const p of c.refs ?? []) {
      if (!IMAGE.test(p)) { skippedFiles.add(p); continue; }
      if (picks.some(x => x.path === p)) continue;
      picks.push({ path: p, ...(LABEL[c.role ?? 'actor'] ? { label: LABEL[c.role ?? 'actor'] } : {}), note: `${c.title}${c.text.trim() ? `: ${c.text.trim()}` : ''}` });
    }
  }
  return { picks, skipped: skippedFiles.size };
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
export type ShotHandoff = { handoff: Omit<WizardHandoff, 'n'>; skipped: number } | { blocked: string; detail?: string };
/** Text of the shot as the model reads it: camera/action, the scene state it starts from and ends in, and the spoken lines. */
export function shotPrompt(m: MovieManifest, shot: MovieItem, withCast: boolean): string {
  const name = (id: string) => m.items.find(i => i.id === id)?.title || id;
  const parts = [shot.text.trim()];
  if (shot.entry?.trim()) parts.push(`At the start: ${shot.entry.trim()}`);
  for (const d of shot.dialogue ?? []) parts.push(`${name(d.castId)} says: "${d.line}"${d.delivery ? ` (${d.delivery})` : ''}.`);
  if (shot.exit?.trim()) parts.push(`At the end: ${shot.exit.trim()}`);
  if (withCast) {
    const cast = shot.deps.map(d => m.items.find(i => i.id === d && i.kind === 'cast')).filter((c): c is MovieItem => !!c && !!c.text.trim());
    if (cast.length) parts.push(`Cast: ${cast.map(c => `${c.title} — ${c.text.trim()}`).join('; ')}.`);
  }
  return parts.filter(Boolean).join(' ');
}
/**
 * The hand-over for one shot. `blocked` is an i18n key. Pictures come from the shot's cast entries in order (images only; other files are
 * counted in `skipped`); with none the shot is plain text-to-video. `toSrc` makes a webview URL for a path.
 */
export function shotHandoff(m: MovieManifest, segmentId: string, defaultModel: { name: string; path: string }, run: boolean, toSrc: (path: string) => string, env?: ShotEnv, track?: { path: string; seconds: number }): ShotHandoff {
  const shot = m.items.find(i => i.id === segmentId && i.kind === 'segment');
  if (!shot) return { blocked: 'wizards.movie.shot.unknown' };
  const order = m.items.filter(i => i.kind === 'segment');
  if (shot.continuous && order[0]?.id !== shot.id) return { blocked: 'wizards.movie.shot.continued' };
  const settings = shotSettings(shot, defaultModel, env);
  if ('blocked' in settings) return settings;
  const { model, loras } = settings;
  const { picks, skipped } = shotPictures(m, [shot]);
  if (picks.length > H3_REFERENCE_LIMIT) return { blocked: 'wizards.movie.shot.tooManyRefs' };
  const [w, h] = m.aspect.split(':').map(Number);
  const size = w > 0 && h > 0 ? wizardCanvas('minimax-h3', { width: w * 100, height: h * 100 }) : undefined;
  const refs: WizardPicture[] = picks.map(p => ({ name: fileName(p.path), path: p.path, src: toSrc(p.path) }));
  const audio = track ? shotAudio(m, shot, refs.length > 0, track, toSrc) : undefined;
  if (audio && 'blocked' in audio) return audio;
  return {
    skipped,
    handoff: {
      wizard: 'movie', strategy: shot.id, pipeline: refs.length ? 'ref2v' : 't2v', source: 'movie', model,
      ...(refs.length ? { references: refs, labels: picks.map(p => p.label), notes: picks.map(p => p.note) } : {}),
      positive: shotPrompt(m, shot, !refs.length), ...(size ? { size } : {}), seconds: shot.seconds, run, ...(loras.length ? { loras } : {}), ...(audio ? audio : {}),
    },
  };
}
/** Records what a wizard run reported for a shot: a finished video becomes the item's result, any other end marks it failed. */
export function recordShotRun(m: MovieManifest, segmentId: string, run: { state: string; job?: { id: string }; picture?: { path: string; video?: boolean } }, seconds?: number): MovieManifest {
  if (run.state === 'succeeded' && run.picture?.video) return completeItem(m, segmentId, { outputId: run.picture.path, ...(run.job ? { jobId: run.job.id } : {}), ...(seconds ? { seconds } : {}) });
  return run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded' ? failItem(m, segmentId) : m;
}
