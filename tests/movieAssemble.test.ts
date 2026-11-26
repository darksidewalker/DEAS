import test from 'node:test';
import assert from 'node:assert/strict';
import { addCast, completeItem, editItem, failItem, manifestProblem, newMovie, setBrief } from '../src/lib/movieManifest.ts';
import { applyPlan } from '../src/lib/movieStory.ts';
import { AssemblyError, assemblyPlan, assembleMovie, recordFilm, type AssembleDeps, type AssemblyJob } from '../src/lib/movieAssemble.ts';

const base = () => {
  let m = setBrief(newMovie('m1', 'Chase', 15, '16:9'), { story: 's' });
  m = addCast(m, 'actor', 'Anna');
  return applyPlan(m, { lore: 'l', segments: [
    { title: 'A', prompt: 'a', seconds: 5, castIds: [], continuous: false, dialogue: [] },
    { title: 'B', prompt: 'b', seconds: 5, castIds: [], continuous: false, dialogue: [] },
    { title: 'C', prompt: 'c', seconds: 5, castIds: [], continuous: false, dialogue: [] },
  ] });
};
const made = () => ['seg-1', 'seg-2', 'seg-3'].reduce((m, id, n) => completeItem(m, id, { outputId: `/out/${id}.mp4`, jobId: `j${n}`, seconds: 5 }), base());

const deps = (over: Partial<AssembleDeps> = {}, log: string[] = []): AssembleDeps => ({
  inspect: async p => { log.push('inspect ' + p); return { sourceId: 'id-' + p, blockers: [], durationSeconds: 5 }; },
  upload: async id => { log.push('upload ' + id); return id.replace('id-/out/', 'in_'); },
  preflight: async n => { log.push('preflight ' + n.join(',')); return { ok: true, issues: [], seconds: 15 }; },
  epoch: async () => ({ epoch: 7, stopping: false }),
  run: async (intent, epoch) => { log.push('run ' + epoch + ' ' + JSON.stringify(intent)); return { id: 'job1', state: 'running', outputs: [] }; },
  wait: async job => ({ ...job, state: 'succeeded', outputRoot: '/out', outputs: [{ filename: 'film_00001.mp4', subfolder: 'video' }] }),
  ...over,
});

test('the plan lists clips in order, or says which shots keep the film from being assembled', () => {
  const ok = assemblyPlan(made());
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.clips.map(c => c.path), ok.expectedSeconds], [['/out/seg-1.mp4', '/out/seg-2.mp4', '/out/seg-3.mp4'], 15]);
  let m = made();
  m = editItem(m, 'seg-2', 'changed b');
  m = failItem(m, 'seg-3');
  const bad = assemblyPlan(m);
  assert.deepEqual(bad, { ok: false, missing: [{ id: 'seg-2', title: 'B', why: 'none' }, { id: 'seg-3', title: 'C', why: 'failed' }] });
  assert.deepEqual(assemblyPlan(base()).ok, false);
  const notClip = completeItem(made(), 'seg-1', { outputId: '/out/a.png' });
  assert.deepEqual((assemblyPlan(notClip) as any).missing, [{ id: 'seg-1', title: 'A', why: 'not-a-clip' }]);
  const cont = { ...made(), items: made().items.map(i => i.id === 'seg-2' ? { ...i, continuous: true } : i) };
  assert.equal(assemblyPlan(cont).ok, true); // continued shots are made with their chain and join like any other clip
  assert.deepEqual(assemblyPlan(newMovie('x', 'x')), { ok: false, missing: [] });
});

test('a stale (outdated) shot is named as outdated', () => {
  let m = made();
  m = editItem(m, 'story', 'rewritten');
  assert.deepEqual((assemblyPlan(m) as any).missing.map((x: any) => x.why), ['outdated', 'outdated', 'outdated']);
});

test('assembly copies each clip in order, checks, runs the files join and returns the output path', async () => {
  const log: string[] = [];
  const steps: string[] = [];
  const r = await assembleMovie(made(), deps({}, log), () => true, (s, n, t) => steps.push(`${s}${n ?? ''}/${t ?? ''}`));
  assert.deepEqual(log.slice(0, 7), ['inspect /out/seg-1.mp4', 'upload id-/out/seg-1.mp4', 'inspect /out/seg-2.mp4', 'upload id-/out/seg-2.mp4', 'inspect /out/seg-3.mp4', 'upload id-/out/seg-3.mp4', 'preflight in_seg-1.mp4,in_seg-2.mp4,in_seg-3.mp4']);
  assert.match(log[7], /^run 7 /);
  assert.deepEqual(JSON.parse(log[7].slice(6)), { recipeId: 'h3-join', version: 1, h3: { join: { kind: 'files', files: [{ filename: 'in_seg-1.mp4' }, { filename: 'in_seg-2.mp4' }, { filename: 'in_seg-3.mp4' }], smoothAudioSeams: true } } });
  assert.deepEqual([r.path, r.seconds, r.expectedSeconds, r.mismatch], ['/out/video/film_00001.mp4', 15, 15, false]);
  assert.deepEqual(steps, ['copy1/3', 'copy2/3', 'copy3/3', 'check/', 'join/']);
  const film = recordFilm(made(), r);
  const final = film.items.find(i => i.id === 'final')!;
  assert.deepEqual([final.state, final.revisions.at(-1)!.result], ['done', { outputId: '/out/video/film_00001.mp4', jobId: 'job1', seconds: 15 }]);
  assert.equal(manifestProblem(film), undefined);
  assert.equal((await assembleMovie(made(), deps({ preflight: async () => ({ ok: true, issues: [], seconds: 12 }) }), () => true)).mismatch, true);
});

test('blocked, failed and cancelled assemblies stop at the right step and run nothing after', async () => {
  const code = async (m: any, d: AssembleDeps, active = () => true) => assembleMovie(m, d, active).then(() => 'ok', (e: AssemblyError) => `${e.code}:${e.message}`);
  assert.match(await code(base(), deps()), /^blocked:Some shots/);
  const log: string[] = [];
  assert.match(await code(made(), deps({ inspect: async () => ({ sourceId: 'x', blockers: ['audio'], durationSeconds: 1 }) }, log)), /^blocked:The clip of “A” cannot be used \(audio\)/);
  assert.match(await code(made(), deps({ inspect: async () => null })), /^blocked:The clip of “A” cannot be used \(missing\)/);
  assert.match(await code(made(), deps({ preflight: async () => ({ ok: false, issues: ['gap', 'rate'], seconds: 0 }) })), /^blocked:gap; rate/);
  assert.match(await code(made(), deps({ epoch: async () => ({ epoch: 1, stopping: true }) })), /^cancelled/);
  assert.match(await code(made(), deps({ wait: async j => ({ ...j, state: 'failed' }) })), /^failed:The join did not finish/);
  assert.match(await code(made(), deps({ wait: async j => ({ ...j, state: 'succeeded', outputs: [] }) })), /^failed:The joined film has no readable file/);
  assert.match(await code(made(), deps({ wait: async j => ({ ...j, id: 'other', state: 'succeeded' } as AssemblyJob) })), /^failed:The join did not finish/);
  let n = 0;
  const log2: string[] = [];
  assert.match(await code(made(), deps({}, log2), () => ++n < 3), /^cancelled/);
  assert.ok(!log2.some(l => l.startsWith('run')));
});
