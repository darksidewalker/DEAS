/**
 * Movie Maker segment stage (UX-22d4a): turns one planned shot into an ordinary MiniMax H3 draft for Generate — text-to-video, or
 * REF2VA with the shot's cast pictures as references — and records the finished clip on the manifest. Only shots that start a new take
 * (a cut) are handled; continued shots need H3 Continuity and are reported as not supported yet. Nothing here runs anything.
 */
import { completeItem, failItem, type MovieItem, type MovieManifest } from './movieManifest.ts';
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
export type ShotHandoff = { handoff: Omit<WizardHandoff, 'n'>; skipped: number } | { blocked: string };
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
export function shotHandoff(m: MovieManifest, segmentId: string, model: { name: string; path: string }, run: boolean, toSrc: (path: string) => string): ShotHandoff {
  const shot = m.items.find(i => i.id === segmentId && i.kind === 'segment');
  if (!shot) return { blocked: 'wizards.movie.shot.unknown' };
  const order = m.items.filter(i => i.kind === 'segment');
  if (shot.continuous && order[0]?.id !== shot.id) return { blocked: 'wizards.movie.shot.continued' };
  const { picks, skipped } = shotPictures(m, [shot]);
  if (picks.length > H3_REFERENCE_LIMIT) return { blocked: 'wizards.movie.shot.tooManyRefs' };
  const [w, h] = m.aspect.split(':').map(Number);
  const size = w > 0 && h > 0 ? wizardCanvas('minimax-h3', { width: w * 100, height: h * 100 }) : undefined;
  const refs: WizardPicture[] = picks.map(p => ({ name: fileName(p.path), path: p.path, src: toSrc(p.path) }));
  return {
    skipped,
    handoff: {
      wizard: 'movie', strategy: shot.id, pipeline: refs.length ? 'ref2v' : 't2v', source: 'movie', model,
      ...(refs.length ? { references: refs, labels: picks.map(p => p.label), notes: picks.map(p => p.note) } : {}),
      positive: shotPrompt(m, shot, !refs.length), ...(size ? { size } : {}), seconds: shot.seconds, run,
    },
  };
}
/** Records what a wizard run reported for a shot: a finished video becomes the item's result, any other end marks it failed. */
export function recordShotRun(m: MovieManifest, segmentId: string, run: { state: string; job?: { id: string }; picture?: { path: string; video?: boolean } }, seconds?: number): MovieManifest {
  if (run.state === 'succeeded' && run.picture?.video) return completeItem(m, segmentId, { outputId: run.picture.path, ...(run.job ? { jobId: run.job.id } : {}), ...(seconds ? { seconds } : {}) });
  return run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded' ? failItem(m, segmentId) : m;
}
