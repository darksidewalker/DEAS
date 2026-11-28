import test from 'node:test';
import assert from 'node:assert/strict';
import { addScene, completeItem, editItem, failItem, manifestProblem, newItem, newMovie, removeScene, setBrief, setMix, setMusicFile, setRender, setSceneInputs, setSceneSeconds, setTransition, transitionOf, type MovieManifest } from '../src/lib/movieManifest.ts';
/** The music item as Movie Maker's music card creates it (movieMusic.ts needs the webview). */
const setMusicPrompt = (m: MovieManifest, text: string): MovieManifest => ({ ...m, items: [...m.items, newItem('music', 'music', 'Music', ['brief'], text)] });
import { advanceItemEpochs, canApplyMusicGeneration, canApplySceneStep, canCompleteFilm, canCompleteMix, captureFilmSubmission, captureMixSubmission, captureMusicSubmission, captureSceneSubmission, needsStitch, nextMovieStep, pendingTargetShot, recordCompletedChainShot, shouldRestitchAfterShot, type SceneInputContext } from '../src/lib/movieRun.ts';
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

const h3Ctx: SceneInputContext = { defaultModel: { name: 'h3_turbo.safetensors', path: '/m/h3_turbo' } };

test('scene and chain submissions bind to the originating draft, item epoch, revision and effective shared inputs', () => {
  const m0 = setTransition(three(), 'seg-2', 'seamless');
  let epochs = new Map<string, number>();
  const single = captureSceneSubmission(1, 1, m0, epochs, ['seg-3'], [6.13], true, 'manual', false, h3Ctx)!;
  assert.equal(canApplySceneStep(1, m0, epochs, single, 'seg-3', undefined, h3Ctx)?.actualSeconds, 6.13);
  assert.equal(canApplySceneStep(2, m0, epochs, single, 'seg-3', undefined, h3Ctx), null, 'reopened or new draft instance rejects late reply');
  assert.equal(canApplySceneStep(1, { ...m0, id: 'm2' }, epochs, single, 'seg-3', undefined, h3Ctx), null);
  assert.equal(canApplySceneStep(1, editItem(m0, 'seg-3', 'new prompt'), epochs, single, 'seg-3', undefined, h3Ctx), null);
  assert.equal(canApplySceneStep(1, setSceneSeconds(m0, 'seg-3', 7), epochs, single, 'seg-3', undefined, h3Ctx), null);
  assert.equal(canApplySceneStep(1, setBrief(m0, { aspect: '9:16' }), epochs, single, 'seg-3', undefined, h3Ctx), null, 'movie-wide canvas change invalidates shot');
  assert.equal(canApplySceneStep(1, setRender(m0, { steps: 14 }), epochs, single, 'seg-3', undefined, h3Ctx), null, 'movie-wide sampling change invalidates shot');

  // Removing `seg-3` and adding a scene back reuses `seg-3` at revision 1; the advanced item epoch rejects the old submission.
  const without = removeScene(m0, 'seg-3');
  epochs = advanceItemEpochs(m0, without, epochs);
  const replaced = addScene(without, 6);
  epochs = advanceItemEpochs(without, replaced, epochs);
  assert.equal(replaced.items.find(i => i.id === 'seg-3')!.revision, 1);
  assert.equal(canApplySceneStep(1, replaced, epochs, single, 'seg-3', undefined, h3Ctx), null);

  // Chain: step 0 completion keeps step 1 valid (including remaking an already-made chain), while editing either step invalidates step 1.
  const refBen = { path: '/p/ben.png', media: 'image' as const, mediaMode: 'video' as const, second: 0, strength: 1 };
  const withLaterRef = setSceneInputs(m0, 'seg-2', { refs: [refBen] });
  const madeChain = ['seg-1', 'seg-2'].reduce(made, withLaterRef);
  const chainEpochs = new Map<string, number>();
  const chainSub = captureSceneSubmission(2, 1, madeChain, chainEpochs, ['seg-1', 'seg-2'], [5.17, 4.25], true, 'auto', true, h3Ctx)!;
  assert.equal(canApplySceneStep(1, madeChain, chainEpochs, chainSub, 'seg-1', 0, h3Ctx)?.actualSeconds, 5.17);
  // Changing or removing `seg-2`'s reference alters the shared REF2VA inputs submitted for `seg-1`'s first take, so even step 0 is rejected.
  assert.equal(canApplySceneStep(1, setSceneInputs(madeChain, 'seg-2', {}), chainEpochs, chainSub, 'seg-1', 0, h3Ctx), null);
  const appended = setTransition(addScene(madeChain, 4, 'seg-2'), 'seg-4', 'seamless');
  const appendedWithRef = setSceneInputs(appended, 'seg-4', { refs: [{ ...refBen, path: '/p/cat.png' }] });
  assert.equal(canApplySceneStep(1, appendedWithRef, chainEpochs, chainSub, 'seg-1', 0, h3Ctx), null);

  // Normal per-step completion with unchanged inputs stays valid through the whole chain.
  const afterStep0 = completeItem(madeChain, 'seg-1', { outputId: '/out/seg-1-remade.mp4', seconds: 5.17 });
  assert.equal(afterStep0.items.find(i => i.id === 'seg-2')!.state, 'stale');
  assert.equal(canApplySceneStep(1, afterStep0, chainEpochs, chainSub, 'seg-2', 1, h3Ctx)?.actualSeconds, 4.25);
  assert.equal(canApplySceneStep(1, editItem(afterStep0, 'seg-2', 'edited'), chainEpochs, chainSub, 'seg-2', 1, h3Ctx), null);
  assert.equal(canApplySceneStep(1, editItem(afterStep0, 'seg-1', 'edited first'), chainEpochs, chainSub, 'seg-2', 1, h3Ctx), null);
  const inserted = addScene(afterStep0, 3, 'seg-1');
  assert.equal(canApplySceneStep(1, inserted, chainEpochs, chainSub, 'seg-2', 1, h3Ctx), null);
});

test('H3 audio-reference mode binds a shot to its music track and the effective trim offset from earlier scenes', () => {
  const refAnna = { path: '/p/anna.png', media: 'image' as const, mediaMode: 'video' as const, second: 0, strength: 1 };
  let m = setSceneInputs(three(), 'seg-2', { refs: [refAnna] });
  m = setMix(setMusicFile(m, '/music/bed.flac'), { mode: 'h3-reference' });
  const epochs = new Map<string, number>();
  const refCtx: SceneInputContext = { ...h3Ctx, track: { path: '/music/bed.flac', seconds: 40 } };
  const sub = captureSceneSubmission(1, 1, m, epochs, ['seg-2'], [4.25], true, 'manual', false, refCtx)!;
  assert.ok(sub);
  // Completing an earlier cut scene without changing its duration keeps `seg-2`'s audio slice valid; editing a later scene also keeps it valid.
  assert.equal(canApplySceneStep(1, made(m, 'seg-1'), epochs, sub, 'seg-2', undefined, refCtx)?.actualSeconds, 4.25);
  assert.equal(canApplySceneStep(1, setSceneSeconds(m, 'seg-3', 9), epochs, sub, 'seg-2', undefined, refCtx)?.actualSeconds, 4.25);
  // Changing an earlier scene's duration, the music track, or mix mode alters the effective audio slice and rejects completion.
  assert.equal(canApplySceneStep(1, setSceneSeconds(m, 'seg-1', 8), epochs, sub, 'seg-2', undefined, refCtx), null);
  assert.equal(canApplySceneStep(1, setMusicFile(m, '/music/other.flac'), epochs, sub, 'seg-2', undefined, { ...h3Ctx, track: { path: '/music/other.flac', seconds: 40 } }), null);
  assert.equal(canApplySceneStep(1, m, epochs, sub, 'seg-2', undefined, { ...h3Ctx, track: undefined }), null);
  assert.equal(canApplySceneStep(1, setMix(m, { mode: 'mix' }), epochs, sub, 'seg-2', undefined, refCtx), null);
});

test('only intentional manual shot completions request an automatic restitch; Make the movie stages stop cleanly after Stop', () => {
  const m = three(), epochs = new Map<string, number>();
  const autoShot = captureSceneSubmission(1, 1, m, epochs, ['seg-3'], [6.13], true, 'auto', false, h3Ctx)!;
  const manualShot = captureSceneSubmission(2, 1, m, epochs, ['seg-3'], [6.13], true, 'manual', false, h3Ctx)!;
  const prepareOnly = captureSceneSubmission(3, 1, m, epochs, ['seg-3'], [6.13], false, 'manual', false, h3Ctx)!;
  assert.equal(shouldRestitchAfterShot(autoShot, true, 'succeeded', true), false);
  assert.equal(shouldRestitchAfterShot(manualShot, false, 'succeeded', true), false, 'mid-chain step waits for last shot');
  assert.equal(shouldRestitchAfterShot(manualShot, true, 'failed', true), false);
  assert.equal(shouldRestitchAfterShot(manualShot, true, 'succeeded', false), false, 'stale completion never restitches');
  assert.equal(shouldRestitchAfterShot(prepareOnly, true, 'succeeded', true), false);
  assert.equal(shouldRestitchAfterShot(manualShot, true, 'succeeded', true), true);
});

test('film, music and mix completions reject changed assembly inputs, transitions, tracks, mix settings and drafts', () => {
  const ready = ['seg-1', 'seg-2', 'seg-3'].reduce(made, three());
  const epochs = new Map<string, number>();
  const filmSub = captureFilmSubmission(1, ready, epochs)!;
  assert.equal(canCompleteFilm(1, ready, epochs, filmSub), true);
  assert.equal(canCompleteFilm(2, ready, epochs, filmSub), false);
  // Changing cut ↔ blend does not increment final.revision, so the assembly-input snapshot itself must reject the stale join.
  assert.equal(canCompleteFilm(1, setTransition(ready, 'seg-2', 'blend', 1), epochs, filmSub), false);
  assert.equal(canCompleteFilm(1, completeItem(ready, 'seg-2', { outputId: '/out/seg-2-v2.mp4', seconds: 4 }), epochs, filmSub), false);
  assert.equal(canCompleteFilm(1, editItem(ready, 'brief', 'rewritten story'), epochs, filmSub), false);

  const withPrompt = setMusicPrompt(completeItem(ready, 'final', { outputId: '/out/film.mp4', seconds: 15 }), 'calm piano');
  const musicSub = captureMusicSubmission(1, 1, withPrompt, epochs, 15, true)!;
  assert.equal(canApplyMusicGeneration(1, withPrompt, epochs, musicSub, 15), true);
  assert.equal(canApplyMusicGeneration(2, withPrompt, epochs, musicSub, 15), false);
  assert.equal(canApplyMusicGeneration(1, editItem(withPrompt, 'music', 'upbeat'), epochs, musicSub, 15), false);
  assert.equal(canApplyMusicGeneration(1, setMusicFile(withPrompt, '/in/other.wav'), epochs, musicSub, 15), false);
  assert.equal(canApplyMusicGeneration(1, withPrompt, epochs, musicSub, 20), false);

  const mixReady = setMusicFile(completeItem(ready, 'final', { outputId: '/out/film.mp4', seconds: 15 }), '/in/bed.wav');
  const mixSub = captureMixSubmission(1, mixReady, epochs)!;
  assert.equal(canCompleteMix(1, mixReady, epochs, mixSub), true);
  assert.equal(canCompleteMix(2, mixReady, epochs, mixSub), false);
  assert.equal(canCompleteMix(1, setMix(mixReady, { levelDb: -20 }), epochs, mixSub), false);
  assert.equal(canCompleteMix(1, setMusicFile(mixReady, '/in/other.wav'), epochs, mixSub), false);
  assert.equal(canCompleteMix(1, completeItem(mixReady, 'final', { outputId: '/out/film-2.mp4', seconds: 15 }), epochs, mixSub), false);
  assert.equal(canCompleteMix(1, setTransition(mixReady, 'seg-2', 'blend', 1), epochs, mixSub), false);
});

test('completed intermediate chain steps stay recorded so a subsequent chain abort targets the blocked next shot instead of overwriting earlier clips', () => {
  const m = setTransition(three(), 'seg-2', 'seamless');
  const epochs = new Map<string, number>();
  const sub = captureSceneSubmission(7, 1, m, epochs, ['seg-1', 'seg-2'], [5.17, 4.25], true, 'auto', true, h3Ctx)!;
  assert.deepEqual(sub.completedIds, []);
  assert.deepEqual(pendingTargetShot(sub), { id: 'seg-1', stepIndex: 0 });
  assert.deepEqual(pendingTargetShot(sub, { index: 0, shotId: 'seg-1', total: 2 }), { id: 'seg-1', stepIndex: 0 });
  const afterStep0 = recordCompletedChainShot(sub, 'seg-1');
  assert.deepEqual(afterStep0.completedIds, ['seg-1']);
  assert.equal(recordCompletedChainShot(afterStep0, 'seg-1'), afterStep0);
  // Explicit step report and step-less fallback both resolve to the uncompleted continuation `seg-2`.
  assert.deepEqual(pendingTargetShot(afterStep0, { index: 1, shotId: 'seg-2', total: 2 }), { id: 'seg-2', stepIndex: 1 });
  assert.deepEqual(pendingTargetShot(afterStep0), { id: 'seg-2', stepIndex: 1 });
});
