/**
 * Movie Maker *Make the movie* (UX-22d7f): what has to happen next to get from the plan to the finished film. One step at a time, in a
 * fixed order — every scene that is not made (a seamless run as one Continuity chain from its first scene), then the stitched film,
 * then the music bed (when it is set up) and its mix. Pure: the component runs the step and asks again when it ended.
 */
import { assemblyPlan } from './movieAssemble.ts';
import { chains } from './movieChains.ts';
import type { MovieManifest } from './movieManifest.ts';

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
