import test from 'node:test';
import assert from 'node:assert/strict';
import { addScene, completeItem, failItem, manifestProblem, newItem, newMovie, setMix, setMusicFile, setTransition, transitionOf, type MovieManifest } from '../src/lib/movieManifest.ts';
/** The music item as Movie Maker's music card creates it (movieMusic.ts needs the webview). */
const setMusicPrompt = (m: MovieManifest, text: string): MovieManifest => ({ ...m, items: [...m.items, newItem('music', 'music', 'Music', ['brief'], text)] });
import { needsStitch, nextMovieStep } from '../src/lib/movieRun.ts';
import { assembleMovie, assemblyPlan, type AssembleDeps } from '../src/lib/movieAssemble.ts';

const caps = { musicModel: true, canStitch: true };
const three = (): MovieManifest => [5, 4, 6].reduce((m, s) => addScene(m, s), newMovie('m1', 'F'));
const made = (m: MovieManifest, id: string) => completeItem(m, id, { outputId: `/out/${id}.mp4`, seconds: m.items.find(i => i.id === id)!.seconds });

test('Make the movie: scenes in order (a seamless run as one chain from its first scene), then the film, the music and the mix', () => {
  let m = setTransition(three(), 'seg-2', 'seamless');
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'scene', id: 'seg-1', chain: true });
  m = made(m, 'seg-1');
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'scene', id: 'seg-1', chain: true }, 'a chain whose later scene is missing is made again from its first');
  m = made(m, 'seg-2');
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'scene', id: 'seg-3', chain: false });
  m = made(m, 'seg-3');
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'film' });
  assert.equal(needsStitch(m), true);
  assert.deepEqual(nextMovieStep(m, { ...caps, canStitch: false }), { kind: 'blocked', why: 'noFilmRecipe' });
  m = completeItem(m, 'final', { outputId: '/out/film.mp4', seconds: 15 });
  assert.equal(needsStitch(m), false);
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'done' });
  m = setMusicPrompt(m, 'warm piano');
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'music' });
  assert.deepEqual(nextMovieStep(m, { ...caps, musicModel: false }), { kind: 'blocked', why: 'noMusicModel' });
  m = setMusicFile(m, '/out/bed.flac');
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'mix' });
  assert.deepEqual(nextMovieStep(setMix(m, { mode: 'h3-reference' }), caps), { kind: 'done' });
  m = completeItem(m, 'score', { outputId: '/out/film-scored.mp4' });
  assert.deepEqual(nextMovieStep(m, caps), { kind: 'done' });
});

test('a failed scene stops the run instead of looping; no scenes is said plainly', () => {
  assert.deepEqual(nextMovieStep(newMovie('x', 'x'), caps), { kind: 'blocked', why: 'noScenes' });
  assert.deepEqual(nextMovieStep(failItem(three(), 'seg-2'), caps), { kind: 'blocked', why: 'failed', id: 'seg-2' });
});

test('transitions: seamless remakes the scene, cut and blend only outdate the film; the first scene has none', () => {
  let m = ['seg-1', 'seg-2', 'seg-3'].reduce(made, three());
  m = completeItem(m, 'final', { outputId: '/out/film.mp4' });
  const blended = setTransition(m, 'seg-2', 'blend', 1);
  const by = (x: MovieManifest, id: string) => x.items.find(i => i.id === id)!;
  assert.deepEqual([transitionOf(by(blended, 'seg-2')), by(blended, 'seg-2').blend, by(blended, 'seg-2').state, by(blended, 'seg-2').revision, by(blended, 'final').state], ['blend', 1, 'done', by(m, 'seg-2').revision, 'stale']);
  assert.equal(manifestProblem(blended), undefined);
  assert.equal(setTransition(blended, 'seg-2', 'blend', 9).items.find(i => i.id === 'seg-2')!.blend, 3);
  const seamless = setTransition(blended, 'seg-2', 'seamless');
  assert.deepEqual([by(seamless, 'seg-2').continuous, by(seamless, 'seg-2').blend, by(seamless, 'seg-2').state], [true, undefined, 'planned']);
  assert.equal(transitionOf(by(setTransition(seamless, 'seg-2', 'cut'), 'seg-2')), 'cut');
  assert.throws(() => setTransition(m, 'seg-1', 'cut'), /first scene/);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'seg-2' ? { ...i, continuous: true, blend: 1 } : i) })!, /bad blend/);
});

test('a film with a blend is stitched natively with its crossfades; without one the Join clips recipe runs', async () => {
  let m = ['seg-1', 'seg-2', 'seg-3'].reduce(made, three());
  m = setTransition(m, 'seg-3', 'blend', 1);
  const plan = assemblyPlan(m);
  assert.ok(plan.ok && plan.expectedSeconds === 14);
  const calls: string[] = [];
  const deps: AssembleDeps = {
    inspect: async () => { calls.push('inspect'); return { sourceId: 'id', blockers: [], durationSeconds: 5 }; },
    upload: async () => 'x.mp4', preflight: async () => ({ ok: true, issues: [], seconds: 15 }),
    epoch: async () => ({ epoch: 1, stopping: false }), run: async () => { calls.push('join'); return { id: 'j', state: 'running', outputs: [] }; },
    wait: async j => ({ ...j, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'f.mp4', subfolder: '' }] }),
    stitch: async r => { calls.push(`stitch ${JSON.stringify(r)}`); return { path: '/out/film.mp4', seconds: 14 }; },
  };
  const r = await assembleMovie(m, deps, () => true);
  assert.deepEqual(calls, ['stitch {"clips":["/out/seg-1.mp4","/out/seg-2.mp4","/out/seg-3.mp4"],"blends":[null,1]}']);
  assert.deepEqual([r.path, r.seconds, r.mismatch], ['/out/film.mp4', 14, false]);
  calls.length = 0;
  await assembleMovie(setTransition(m, 'seg-3', 'cut'), deps, () => true);
  assert.ok(calls.includes('join') && !calls.some(c => c.startsWith('stitch')));
});

test('remaking a scene (a new clip for the same text) outdates the stitched film; recording the same clip again does not', () => {
  let m = ['seg-1', 'seg-2', 'seg-3'].reduce(made, three());
  m = completeItem(m, 'final', { outputId: '/out/film.mp4' });
  assert.equal(completeItem(m, 'seg-2', { outputId: '/out/seg-2.mp4' }).items.find(i => i.id === 'final')!.state, 'done');
  const remade = completeItem(m, 'seg-2', { outputId: '/out/seg-2-again.mp4' });
  assert.equal(remade.items.find(i => i.id === 'final')!.state, 'stale');
  assert.equal(needsStitch(remade), true);
});
