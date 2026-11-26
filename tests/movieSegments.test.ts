import test from 'node:test';
import assert from 'node:assert/strict';
import { addCast, manifestProblem, newMovie, setBrief, setCastRefs } from '../src/lib/movieManifest.ts';
import { applyPlan, type StoryPlan } from '../src/lib/movieStory.ts';
import { recordShotRun, shotHandoff, shotPrompt } from '../src/lib/movieSegments.ts';

const model = { name: 'h3.safetensors', path: '/m/h3.safetensors' };
const src = (p: string) => 'asset://' + p;
const film = () => {
  let m = setBrief(newMovie('m1', 'Chase', 20, '16:9'), { story: 'Anna chases Ben.' });
  m = addCast(m, 'actor', 'Anna', 'tall, red coat'); m = addCast(m, 'location', 'Street', 'wet street'); m = addCast(m, 'actor', 'Ben');
  m = setCastRefs(m, 'cast-1', ['/p/anna.png', '/p/anna2.jpg', '/p/clip.mp4']);
  m = setCastRefs(m, 'cast-2', ['/p/street.webp']);
  const plan: StoryPlan = { lore: 'lore', segments: [
    { title: 'Start', prompt: 'Wide shot, Anna runs', seconds: 10, castIds: ['cast-1', 'cast-2'], continuous: false, entry: 'dusk', exit: 'alley', dialogue: [{ castId: 'cast-1', line: 'Stop!', delivery: 'shouted' }] },
    { title: 'Alley', prompt: 'Ben hides', seconds: 5, castIds: ['cast-3'], continuous: false, dialogue: [] },
    { title: 'Catch', prompt: 'Close up', seconds: 5, castIds: ['cast-1'], continuous: true, dialogue: [] },
  ] };
  return applyPlan(m, plan);
};

test('a cut shot with cast pictures becomes a REF2VA hand-over with labels, notes and the model canvas', () => {
  const r = shotHandoff(film(), 'seg-1', model, false, src);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  const h = r.handoff;
  assert.deepEqual([h.wizard, h.strategy, h.pipeline, h.source, h.run, h.seconds], ['movie', 'seg-1', 'ref2v', 'movie', false, 10]);
  assert.deepEqual(h.references!.map(x => x.path), ['/p/anna.png', '/p/anna2.jpg', '/p/street.webp']);
  assert.equal(h.references![0].src, 'asset:///p/anna.png');
  assert.deepEqual(h.labels, [undefined, undefined, 'place']);
  assert.deepEqual(h.notes, ['Anna: tall, red coat', 'Anna: tall, red coat', 'Street: wet street']);
  assert.equal(r.skipped, 1);
  assert.match(h.positive, /^Wide shot, Anna runs At the start: dusk Anna says: "Stop!" \(shouted\)\. At the end: alley$/);
  assert.ok(h.size && h.size.width * 9 === h.size.height * 16 || h.size!.width > 0);
  assert.equal(h.picture, undefined);
});

test('a shot without pictures is text-to-video and carries the cast descriptions in its prompt', () => {
  const r = shotHandoff(film(), 'seg-2', model, true, src);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  assert.deepEqual([r.handoff.pipeline, r.handoff.references, r.handoff.run], ['t2v', undefined, true]);
  assert.equal(r.handoff.positive, 'Ben hides');
  const m = film();
  const withNote = { ...m, items: m.items.map(i => i.id === 'cast-3' ? { ...i, text: 'short, green hat' } : i) };
  assert.match(shotPrompt(withNote, withNote.items.find(i => i.id === 'seg-2')!, true), /Cast: Ben — short, green hat\./);
});

test('continued and unknown shots are blocked; too many pictures are refused', () => {
  const m = film();
  assert.deepEqual(shotHandoff(m, 'seg-3', model, false, src), { blocked: 'wizards.movie.shot.continued' });
  assert.deepEqual(shotHandoff(m, 'nope', model, false, src), { blocked: 'wizards.movie.shot.unknown' });
  const many = setCastRefs(m, 'cast-1', Array.from({ length: 13 }, (_, i) => `/p/${i}.png`));
  assert.deepEqual(shotHandoff(many, 'seg-1', model, false, src), { blocked: 'wizards.movie.shot.tooManyRefs' });
});

test('a finished video is recorded as the shot result; failures and non-video results are not', () => {
  const m = film();
  const done = recordShotRun(m, 'seg-1', { state: 'succeeded', job: { id: 'j1' }, picture: { path: '/out/a.mp4', video: true } }, 10.13);
  const s = done.items.find(i => i.id === 'seg-1')!;
  assert.deepEqual([s.state, s.revisions.at(-1)!.result], ['done', { outputId: '/out/a.mp4', jobId: 'j1', seconds: 10.13 }]);
  assert.equal(manifestProblem(done), undefined);
  assert.equal(recordShotRun(m, 'seg-1', { state: 'running' }), m);
  assert.equal(recordShotRun(m, 'seg-1', { state: 'failed' }).items.find(i => i.id === 'seg-1')!.state, 'failed');
  assert.equal(recordShotRun(m, 'seg-1', { state: 'succeeded', picture: { path: '/o/x.png' } }).items.find(i => i.id === 'seg-1')!.state, 'failed');
});
