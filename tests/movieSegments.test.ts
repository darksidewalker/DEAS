import test from 'node:test';
import assert from 'node:assert/strict';
import { addCast, completeItem, manifestProblem, newMovie, setBrief, setCastRefs } from '../src/lib/movieManifest.ts';
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

import { setShotLoras, setShotModel } from '../src/lib/movieManifest.ts';
import { shotSettings } from '../src/lib/movieSegments.ts';
import { chainHandoff, chainOf } from '../src/lib/movieChainRun.ts';

test('a shot may have its own model and LoRAs: clamped, de-duplicated, capped, and the shot goes outdated', () => {
  let m = completeItem(film(), 'seg-1', { outputId: '/o/a.mp4' });
  m = setShotModel(m, 'seg-1', 'MiniMaxH3/other.safetensors');
  m = setShotLoras(m, 'seg-1', [{ name: 'a.safetensors', strength: 9 }, { name: 'a.safetensors', strength: 1 }, { name: 'b.safetensors', strength: -7 }, { name: 'c.safetensors', strength: NaN }]);
  const s = m.items.find(i => i.id === 'seg-1')!;
  assert.deepEqual([s.model, s.loras, s.state, s.revision], ['MiniMaxH3/other.safetensors', [{ name: 'a.safetensors', strength: 4 }, { name: 'b.safetensors', strength: -4 }], 'planned', 3]);
  assert.equal(manifestProblem(m), undefined);
  assert.equal(setShotModel(m, 'seg-1', null).items.find(i => i.id === 'seg-1')!.model, undefined);
  assert.equal(setShotLoras(m, 'seg-1', []).items.find(i => i.id === 'seg-1')!.loras, undefined);
  assert.equal(setShotLoras(m, 'seg-1', Array.from({ length: 12 }, (_, i) => ({ name: `l${i}`, strength: 1 }))).items.find(i => i.id === 'seg-1')!.loras!.length, 8);
  assert.throws(() => setShotModel(m, 'brief', 'x'), /Unknown shot/);
  assert.throws(() => setShotLoras(m, 'nope', []), /Unknown shot/);
  const bad = { ...m, items: m.items.map(i => i.id === 'brief' ? { ...i, loras: [] } : i) };
  assert.match(manifestProblem(bad)!, /segment-only/);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'seg-1' ? { ...i, loras: [{ name: 'a', strength: 5 }] } : i) })!, /bad shot LoRAs/);
});

test('the hand-over uses the shot\'s own model and LoRAs, and refuses what is not installed', () => {
  const env = { resolveModel: (n: string) => n === 'MiniMaxH3/own.safetensors' ? { name: n, path: '/m/own' } : undefined, hasLora: (n: string) => n === 'MiniMaxH3/style.safetensors' };
  let m = setShotModel(film(), 'seg-1', 'MiniMaxH3/own.safetensors');
  m = setShotLoras(m, 'seg-1', [{ name: 'MiniMaxH3/style.safetensors', strength: 0.7 }]);
  const r = shotHandoff(m, 'seg-1', model, false, src, env);
  assert.ok('handoff' in r);
  if ('handoff' in r) assert.deepEqual([r.handoff.model, r.handoff.loras], [{ name: 'MiniMaxH3/own.safetensors', path: '/m/own' }, [{ name: 'MiniMaxH3/style.safetensors', strength: 0.7 }]]);
  const plain = shotHandoff(film(), 'seg-1', model, false, src, env);
  assert.ok('handoff' in plain && plain.handoff.model === model && plain.handoff.loras === undefined);
  assert.deepEqual(shotHandoff(setShotModel(film(), 'seg-1', 'gone.safetensors'), 'seg-1', model, false, src, env), { blocked: 'wizards.movie.shot.modelMissing', detail: 'gone.safetensors' });
  assert.deepEqual(shotHandoff(setShotLoras(film(), 'seg-1', [{ name: 'gone-lora', strength: 1 }]), 'seg-1', model, false, src, env), { blocked: 'wizards.movie.shot.loraMissing', detail: 'gone-lora' });
  const first = film().items.find(i => i.id === 'seg-1')!;
  assert.deepEqual(shotSettings({ ...first, model: 'x' }, model), { model, loras: [] }); // without an environment nothing can be checked
});

test('a chain is made with the first shot\'s model and LoRAs; continued shots cannot differ', () => {
  const env = { resolveModel: (n: string) => ({ name: n, path: '/m/' + n }), hasLora: () => true };
  let m = film();
  m = { ...m, items: m.items.map(i => i.id === 'seg-2' ? { ...i, continuous: true } : i) };
  m = setShotModel(m, 'seg-1', 'first.safetensors');
  m = setShotLoras(m, 'seg-1', [{ name: 'L1', strength: 1 }]);
  m = setShotModel(m, 'seg-2', 'ignored.safetensors');
  const found = chainOf(m, 'seg-1')!;
  assert.deepEqual(found.chain.ids, ['seg-1', 'seg-2', 'seg-3']);
  const r = chainHandoff(m, found.chain, found.index, model, true, src, env);
  assert.ok('handoff' in r);
  if ('handoff' in r) assert.deepEqual([r.handoff.model.name, r.handoff.loras], ['first.safetensors', [{ name: 'L1', strength: 1 }]]);
});

import { shotOffset } from '../src/lib/movieSegments.ts';

test('a shot\'s place in the film is the made length of the shots before it', () => {
  const m = film(); // shots: 10 s cut, 5 s cut, 5 s continued
  assert.equal(shotOffset(m, 'seg-1'), 0);
  assert.equal(shotOffset(m, 'seg-2'), 243 / 24); // 10 s as a first take is 243 frames
  assert.equal(shotOffset(m, 'seg-3'), 243 / 24 + 124 / 24);
  assert.equal(shotOffset(m, 'nope'), 0);
});

test('reference mode hands H3 the shot\'s slice of the track, and refuses what H3 cannot take', () => {
  const track = { path: '/music/bed.flac', seconds: 40 };
  const m = setCastRefs(film(), 'cast-3', ['/p/ben.png']); // seg-2 now has a picture
  const r = shotHandoff(m, 'seg-2', model, false, src, undefined, track);
  assert.ok('handoff' in r);
  if (!('handoff' in r)) return;
  const a = r.handoff.audioRef!;
  assert.deepEqual([a.name, a.path, a.src, a.trimStart, a.trimEnd], ['bed.flac', '/music/bed.flac', 'asset:///music/bed.flac', 243 / 24, 243 / 24 + 5]);
  assert.equal(r.handoff.pipeline, 'ref2v');
  // no pictures → no audio reference possible (Ben has none in the plain film)
  assert.deepEqual(shotHandoff(film(), 'seg-2', model, false, src, undefined, track), { blocked: 'wizards.movie.shot.audioNeedsPicture' });
  // track too short for this shot's place
  const short = shotHandoff(m, 'seg-2', model, false, src, undefined, { path: '/m.wav', seconds: 12 });
  assert.ok('blocked' in short && short.blocked === 'wizards.movie.shot.audioTrackShort' && /12\.0 s \/ 15\.1 s/.test(short.detail!));
  // a slice must be 2–15 s
  const tiny = { ...m, items: m.items.map(i => i.id === 'seg-1' ? { ...i, seconds: 1.5 } : i) };
  assert.deepEqual(shotHandoff(tiny, 'seg-1', model, false, src, undefined, track), { blocked: 'wizards.movie.shot.audioClipLength', detail: '1.5 s' });
  // without reference mode nothing changes
  const plain = shotHandoff(m, 'seg-2', model, false, src);
  assert.ok('handoff' in plain && plain.handoff.audioRef === undefined);
});

test('a chain of continued shots cannot take the music as audio reference', () => {
  let m = film();
  m = { ...m, items: m.items.map(i => i.id === 'seg-2' ? { ...i, continuous: true } : i) };
  const found = chainOf(m, 'seg-1')!;
  assert.deepEqual(chainHandoff(m, found.chain, found.index, model, true, src, undefined, true), { blocked: 'wizards.movie.shot.audioNoChain' });
  assert.ok('handoff' in chainHandoff(m, found.chain, found.index, model, true, src, undefined, false));
});
