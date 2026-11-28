/**
 * Movie Maker *Make the movie* (UX-22d7f): what has to happen next to get from the plan to the finished film, plus pure bindings for
 * in-flight scene/chain, music, film and mix runs so stale completions never mark a newer revision or another draft complete.
 */
import { assemblyPlan } from './movieAssemble.ts';
import { chainHandoff, chainOf } from './movieChainRun.ts';
import { chains } from './movieChains.ts';
import type { MovieItemState, MovieManifest, MovieMix } from './movieManifest.ts';
import { shotHandoff, type ShotEnv } from './movieSegments.ts';

export type MovieStep =
  | { kind: 'scene'; id: string; chain: boolean }
  | { kind: 'film' }
  | { kind: 'music' }
  | { kind: 'mix' }
  | { kind: 'done' }
  | { kind: 'blocked'; why: 'failed' | 'noScenes' | 'noMusicModel' | 'noFilmRecipe'; id?: string };

export interface MovieRunCaps {
  /** A music model is installed (the bed can be generated). */
  musicModel: boolean;
  /** The film can be stitched (desktop app with a backend, or FFmpeg for blends). */
  canStitch: boolean;
}
const VIDEO = /\.(mp4|webm|mkv|mov)$/i;

/** The next step, or `done`. A scene that failed stops the run (it is not retried in a loop); remake it on its own, then continue. */
export function nextMovieStep(m: MovieManifest, caps: MovieRunCaps): MovieStep {
  const scenes = m.items.filter(i => i.kind === 'segment');
  if (!scenes.length) return { kind: 'blocked', why: 'noScenes' };
  const failed = scenes.find(s => s.state === 'failed');
  if (failed) return { kind: 'blocked', why: 'failed', id: failed.id };
  const todo = scenes.find(s => s.state !== 'done');
  if (todo) {
    const chain = chains(m).find(c => c.ids.includes(todo.id));
    return { kind: 'scene', id: chain?.ids[0] ?? todo.id, chain: !!chain && chain.ids.length > 1 };
  }
  const film = m.items.find(i => i.id === 'final');
  if (film?.state !== 'done') {
    if (!caps.canStitch) return { kind: 'blocked', why: 'noFilmRecipe' };
    return assemblyPlan(m).ok ? { kind: 'film' } : { kind: 'blocked', why: 'failed' };
  }
  const music = m.items.find(i => i.kind === 'music'), score = m.items.find(i => i.kind === 'score');
  if (music && !music.file && music.text.trim()) {
    if (music.state === 'failed') return { kind: 'blocked', why: 'failed', id: music.id };
    return caps.musicModel ? { kind: 'music' } : { kind: 'blocked', why: 'noMusicModel' };
  }
  const filmClip = film.revisions.find(r => r.n === film.revision)?.result?.outputId;
  if (music?.file && score?.mix?.mode === 'mix' && score.state !== 'done' && filmClip && VIDEO.test(filmClip)) return { kind: 'mix' };
  return { kind: 'done' };
}
/** Whether the film should be stitched again on its own: every scene is made and the film is missing or outdated. */
export const needsStitch = (m: MovieManifest): boolean => {
  const film = m.items.find(i => i.id === 'final');
  return !!film && film.state !== 'done' && assemblyPlan(m).ok;
};

// --- in-flight stage bindings (stale-result and Stop-after-step guards) -----------------------------------------------------------

export type ShotOrigin = 'manual' | 'auto';
export type ItemEpochs = ReadonlyMap<string, number>;

/**
 * Advances per-item instance epochs across a manifest edit within one draft. Removing an item (e.g. `seg-1`, which `addScene` can reuse at
 * revision 1) bumps its epoch, so a newly added item with the same id and revision 1 never matches a pending run from the removed item.
 */
export function advanceItemEpochs(prev: MovieManifest, next: MovieManifest, prevEpochs: ItemEpochs): Map<string, number> {
  if (prev.id !== next.id) return new Map();
  const out = new Map(prevEpochs);
  const prevById = new Map(prev.items.map(i => [i.id, i]));
  const nextIds = new Set(next.items.map(i => i.id));
  for (const [id] of prevById) {
    if (!nextIds.has(id)) out.set(id, (out.get(id) ?? 0) + 1);
  }
  for (const item of next.items) {
    const old = prevById.get(item.id);
    if (old && (old.kind !== item.kind || item.revision < old.revision)) out.set(item.id, (out.get(item.id) ?? 0) + 1);
  }
  return out;
}

export interface SubmittedScene {
  id: string;
  epoch: number;
  revision: number;
  actualSeconds: number | undefined;
  continuous: boolean;
  seconds: number | undefined;
  action: string;
}

/** Ambient model/audio facts needed to compute the exact effective hand-over inputs of a scene or Continuity chain. */
export interface SceneInputContext {
  defaultModel: { name: string; path: string } | undefined;
  toSrc?: (path: string) => string;
  env?: ShotEnv;
  /** Resolved length of the active music file (used when `score.mix.mode === 'h3-reference'`). */
  track?: { path: string; seconds: number };
}

export type PendingGeneration =
  | {
      kind: 'scene';
      n: number;
      draft: number;
      movieId: string;
      run: boolean;
      origin: ShotOrigin;
      shots: SubmittedScene[];
      chain: boolean;
      sharedSignature: string;
      completedIds: readonly string[];
    }
  | {
      kind: 'music';
      n: number;
      draft: number;
      movieId: string;
      run: boolean;
      musicId: string;
      epoch: number;
      revision: number;
      signature: string;
    };

const identitySrc = (p: string) => p;
const isH3ReferenceMode = (m: MovieManifest): { active: boolean; musicFile?: string } => {
  const music = m.items.find(i => i.kind === 'music'), score = m.items.find(i => i.kind === 'score');
  const active = score?.mix?.mode === 'h3-reference' && !!music?.file;
  return { active, ...(music?.file ? { musicFile: music.file } : {}) };
};

function computeSceneSharedInputs(
  m: MovieManifest, firstId: string, chain: boolean, run: boolean, ctx: SceneInputContext,
): { sharedSignature: string; steps?: { id: string; seconds: number; action: string }[] } | null {
  if (!ctx.defaultModel) return null;
  const toSrc = ctx.toSrc ?? identitySrc;
  const refMode = isH3ReferenceMode(m);
  if (chain) {
    const found = chainOf(m, firstId);
    if (!found) return null;
    const r = chainHandoff(m, found.chain, found.index, ctx.defaultModel, run, toSrc, ctx.env, refMode.active);
    if ('blocked' in r || !r.handoff.continuity) return null;
    const { continuity, ...shared } = r.handoff;
    const { session: _session, steps, ...planShared } = continuity.plan;
    return { sharedSignature: JSON.stringify({ kind: 'chain', shared, plan: planShared }), steps };
  }
  const track = refMode.active && refMode.musicFile && ctx.track?.path === refMode.musicFile ? ctx.track : undefined;
  if (refMode.active && !track) return null;
  const r = shotHandoff(m, firstId, ctx.defaultModel, run, toSrc, ctx.env, track);
  if ('blocked' in r) return null;
  return { sharedSignature: JSON.stringify({ kind: 'shot', handoff: r.handoff }) };
}

/** Captures the originating draft, exact scene/chain revisions and effective shared Generate inputs at hand-over time. */
export function captureSceneSubmission(
  n: number, draft: number, m: MovieManifest, epochs: ItemEpochs,
  ids: readonly string[], actualSeconds: readonly (number | undefined)[],
  run: boolean, origin: ShotOrigin, chain: boolean, ctx: SceneInputContext,
): Extract<PendingGeneration, { kind: 'scene' }> | null {
  if (!ids.length) return null;
  const eff = computeSceneSharedInputs(m, ids[0], chain, run, ctx);
  if (!eff) return null;
  if (chain && (!eff.steps || eff.steps.length !== ids.length)) return null;
  const segs = m.items.filter(i => i.kind === 'segment');
  const shots: SubmittedScene[] = [];
  for (let k = 0; k < ids.length; k++) {
    const at = segs.findIndex(s => s.id === ids[k]);
    if (at < 0) return null;
    const s = segs[at];
    const step = eff.steps?.[k];
    shots.push({
      id: s.id, epoch: epochs.get(s.id) ?? 0, revision: s.revision, actualSeconds: actualSeconds[k],
      continuous: at > 0 && !!s.continuous, seconds: step ? step.seconds : s.seconds, action: step ? step.action : s.text,
    });
  }
  return { kind: 'scene', n, draft, movieId: m.id, run, origin, shots, chain, sharedSignature: eff.sharedSignature, completedIds: [] };
}

/** Records that an intermediate Continuity chain shot completed, so a subsequent chain abort preserves it and targets the blocked next shot. */
export function recordCompletedChainShot(
  pending: Extract<PendingGeneration, { kind: 'scene' }>, shotId: string,
): Extract<PendingGeneration, { kind: 'scene' }> {
  return pending.completedIds.includes(shotId) ? pending : { ...pending, completedIds: [...pending.completedIds, shotId] };
}

/** Resolves which submitted shot an outcome report refers to, defaulting to the first uncompleted shot in the submission when `step` is absent. */
export function pendingTargetShot(
  pending: Extract<PendingGeneration, { kind: 'scene' }>, step?: { index: number; shotId: string; total: number },
): { id: string; stepIndex: number | undefined } {
  if (step?.shotId) return { id: step.shotId, stepIndex: step.index };
  const target = pending.shots.find(x => !pending.completedIds.includes(x.id)) ?? pending.shots[0];
  return { id: target?.id ?? '', stepIndex: target ? pending.shots.indexOf(target) : undefined };
}

/**
 * Returns the submitted scene record when `shotId` (every earlier step of its chain, and all effective shared inputs sent to Generate —
 * including references from later scenes in a Continuity chain and H3 audio-reference track/trim offsets from earlier scenes) still match
 * the originating draft, item instance and revision; returns `null` otherwise.
 */
export function canApplySceneStep(
  draft: number, m: MovieManifest, epochs: ItemEpochs,
  pending: Extract<PendingGeneration, { kind: 'scene' }>, shotId: string, stepIndex: number | undefined, ctx: SceneInputContext,
): SubmittedScene | null {
  if (draft !== pending.draft || m.id !== pending.movieId) return null;
  const idx = stepIndex ?? (pending.shots.length === 1 && pending.shots[0].id === shotId ? 0 : -1);
  if (idx < 0 || idx >= pending.shots.length || pending.shots[idx].id !== shotId) return null;
  const segs = m.items.filter(i => i.kind === 'segment');
  const start = segs.findIndex(s => s.id === pending.shots[0].id);
  if (start < 0 || start + idx >= segs.length) return null;
  for (let j = 0; j <= idx; j++) {
    const cur = segs[start + j], want = pending.shots[j];
    if (!cur || cur.id !== want.id || (epochs.get(cur.id) ?? 0) !== want.epoch || cur.revision !== want.revision) return null;
    if ((start + j > 0 && !!cur.continuous) !== want.continuous) return null;
  }
  const eff = computeSceneSharedInputs(m, pending.shots[0].id, pending.chain, pending.run, ctx);
  if (!eff || eff.sharedSignature !== pending.sharedSignature) return null;
  if (pending.chain) {
    if (!eff.steps || eff.steps.length <= idx) return null;
    for (let j = 0; j <= idx; j++) {
      const step = eff.steps[j], want = pending.shots[j];
      if (step.id !== want.id || step.seconds !== want.seconds || step.action !== want.action) return null;
    }
  }
  return pending.shots[idx];
}

const musicSig = (m: MovieManifest, seconds: number, modelPath: string): string => {
  const mu = m.items.find(i => i.kind === 'music');
  return JSON.stringify(mu ? {
    file: mu.file ?? null, text: mu.text, preset: mu.preset ?? null, lyrics: mu.lyrics ?? null,
    bpm: mu.bpm ?? null, language: mu.language ?? null, loras: mu.loras ?? [],
    renderSource: m.render?.source ?? 'movie', modelPath, seconds,
  } : null);
};

export function captureMusicSubmission(
  n: number, draft: number, m: MovieManifest, epochs: ItemEpochs, seconds: number, run: boolean, modelPath = '',
): Extract<PendingGeneration, { kind: 'music' }> | null {
  const mu = m.items.find(i => i.kind === 'music');
  if (!mu) return null;
  return { kind: 'music', n, draft, movieId: m.id, run, musicId: mu.id, epoch: epochs.get(mu.id) ?? 0, revision: mu.revision, signature: musicSig(m, seconds, modelPath) };
}

export function canApplyMusicGeneration(
  draft: number, m: MovieManifest, epochs: ItemEpochs,
  pending: Extract<PendingGeneration, { kind: 'music' }>, currentSeconds: number, modelPath = '',
): boolean {
  if (draft !== pending.draft || m.id !== pending.movieId) return false;
  const mu = m.items.find(i => i.kind === 'music');
  if (!mu || mu.id !== pending.musicId || (epochs.get(mu.id) ?? 0) !== pending.epoch || mu.revision !== pending.revision) return false;
  return musicSig(m, currentSeconds, modelPath) === pending.signature;
}

/**
 * Only an intentional manual shot/chain completion asks for an automatic re-stitch once every scene is made.
 * Stages started by *Make the movie* (`origin === 'auto'`) advance through `nextMovieStep` while active, and stop cleanly without
 * triggering a stitch, music generation or mix when *Stop after this step* was pressed.
 */
export const shouldRestitchAfterShot = (pending: Extract<PendingGeneration, { kind: 'scene' }>, lastShot: boolean, state: string, applied: boolean): boolean =>
  pending.run && pending.origin === 'manual' && lastShot && state === 'succeeded' && applied;

export interface SubmittedFilm {
  draft: number;
  movieId: string;
  finalEpoch: number;
  finalRevision: number;
  scenes: {
    id: string;
    epoch: number;
    revision: number;
    continuous: boolean;
    blend: number | null;
    path: string;
    seconds: number | null;
  }[];
}

export function captureFilmSubmission(draft: number, m: MovieManifest, epochs: ItemEpochs): SubmittedFilm | null {
  const final = m.items.find(i => i.id === 'final'), plan = assemblyPlan(m);
  if (!final || !plan.ok) return null;
  const segs = m.items.filter(i => i.kind === 'segment');
  if (segs.length !== plan.clips.length) return null;
  return {
    draft, movieId: m.id, finalEpoch: epochs.get(final.id) ?? 0, finalRevision: final.revision,
    scenes: segs.map((s, k) => ({
      id: s.id, epoch: epochs.get(s.id) ?? 0, revision: s.revision, continuous: !!s.continuous,
      blend: plan.clips[k].blend ?? null, path: plan.clips[k].path, seconds: plan.clips[k].seconds ?? null,
    })),
  };
}

export function canCompleteFilm(draft: number, m: MovieManifest, epochs: ItemEpochs, sub: SubmittedFilm): boolean {
  if (draft !== sub.draft || m.id !== sub.movieId) return false;
  const final = m.items.find(i => i.id === 'final'), plan = assemblyPlan(m);
  if (!final || (epochs.get(final.id) ?? 0) !== sub.finalEpoch || final.revision !== sub.finalRevision || !plan.ok) return false;
  const segs = m.items.filter(i => i.kind === 'segment');
  if (segs.length !== sub.scenes.length || plan.clips.length !== sub.scenes.length) return false;
  return sub.scenes.every((want, k) => {
    const s = segs[k], c = plan.clips[k];
    return s.id === want.id && (epochs.get(s.id) ?? 0) === want.epoch && s.revision === want.revision
      && !!s.continuous === want.continuous && (c.blend ?? null) === want.blend && c.path === want.path && (c.seconds ?? null) === want.seconds;
  });
}

export interface SubmittedMix {
  draft: number;
  movieId: string;
  finalEpoch: number;
  finalRevision: number;
  film: string;
  musicId: string;
  musicEpoch: number;
  musicRevision: number;
  music: string;
  scoreId: string;
  scoreEpoch: number;
  scoreRevision: number;
  mix: MovieMix;
  scenes: {
    id: string;
    epoch: number;
    revision: number;
    state: MovieItemState;
    continuous: boolean;
    blend: number | null;
    outputId: string | null;
  }[];
}

export function captureMixSubmission(draft: number, m: MovieManifest, epochs: ItemEpochs): SubmittedMix | null {
  const final = m.items.find(i => i.id === 'final'), music = m.items.find(i => i.kind === 'music'), score = m.items.find(i => i.kind === 'score');
  const film = final?.revisions.find(r => r.n === final.revision)?.result?.outputId;
  if (!final || final.state !== 'done' || !film || !VIDEO.test(film) || !music?.file || !score?.mix || score.mix.mode !== 'mix') return null;
  const segs = m.items.filter(i => i.kind === 'segment');
  return {
    draft, movieId: m.id,
    finalEpoch: epochs.get(final.id) ?? 0, finalRevision: final.revision, film,
    musicId: music.id, musicEpoch: epochs.get(music.id) ?? 0, musicRevision: music.revision, music: music.file,
    scoreId: score.id, scoreEpoch: epochs.get(score.id) ?? 0, scoreRevision: score.revision, mix: { ...score.mix },
    scenes: segs.map(s => ({
      id: s.id, epoch: epochs.get(s.id) ?? 0, revision: s.revision, state: s.state,
      continuous: !!s.continuous, blend: s.blend ?? null,
      outputId: s.revisions.find(r => r.n === s.revision)?.result?.outputId ?? null,
    })),
  };
}

export function canCompleteMix(draft: number, m: MovieManifest, epochs: ItemEpochs, sub: SubmittedMix): boolean {
  if (draft !== sub.draft || m.id !== sub.movieId) return false;
  const final = m.items.find(i => i.id === 'final'), music = m.items.find(i => i.kind === 'music'), score = m.items.find(i => i.kind === 'score');
  const film = final?.revisions.find(r => r.n === final.revision)?.result?.outputId;
  if (!final || final.state !== 'done' || (epochs.get(final.id) ?? 0) !== sub.finalEpoch || final.revision !== sub.finalRevision || film !== sub.film) return false;
  if (!music || music.id !== sub.musicId || (epochs.get(music.id) ?? 0) !== sub.musicEpoch || music.revision !== sub.musicRevision || music.file !== sub.music) return false;
  if (!score?.mix || score.id !== sub.scoreId || (epochs.get(score.id) ?? 0) !== sub.scoreEpoch || score.revision !== sub.scoreRevision) return false;
  const x = score.mix, w = sub.mix;
  if (x.mode !== w.mode || x.levelDb !== w.levelDb || x.duckDb !== w.duckDb || x.fadeSeconds !== w.fadeSeconds) return false;
  const segs = m.items.filter(i => i.kind === 'segment');
  if (segs.length !== sub.scenes.length) return false;
  return sub.scenes.every((want, k) => {
    const s = segs[k];
    const out = s.revisions.find(r => r.n === s.revision)?.result?.outputId ?? null;
    return s.id === want.id && (epochs.get(s.id) ?? 0) === want.epoch && s.revision === want.revision && s.state === want.state
      && !!s.continuous === want.continuous && (s.blend ?? null) === want.blend && out === want.outputId;
  });
}
