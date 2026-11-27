import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVIE_MANIFEST_VERSION, addScene, newMovie, removeScene, reviseItem, sceneFiles, scenesSeconds, setBrief, setSceneInputs, setSceneSeconds, completeItem, deliveredSeconds, downstream, editItem, manifestProblem, newItem, parseManifest, planSegments, readyItems, rerunPlan, restoreRevision, serializeManifest, setLocked, type MovieManifest } from '../src/lib/movieManifest.ts';

const film = (): MovieManifest => ({
  version: MOVIE_MANIFEST_VERSION, id: 'film1', title: 'Two actors', targetSeconds: 30, aspect: '16:9',
  items: [
    newItem('brief', 'brief', 'Brief', [], 'A chase.'),
    newItem('cast-a', 'voice', 'Anna', ['brief'], 'tall, red coat'),
    newItem('cast-b', 'voice', 'Ben', ['brief'], 'short, green hat'),
    newItem('story', 'story', 'Story', ['brief', 'cast-a', 'cast-b'], 'Anna runs.'),
    newItem('s1', 'segment', 'Shot 1', ['story', 'cast-a'], 'Anna runs', { seconds: 10, continuous: false }),
    newItem('s2', 'segment', 'Shot 2', ['story', 'cast-b'], 'Ben follows', { seconds: 10, continuous: true }),
    newItem('s3', 'segment', 'Shot 3', ['story'], 'They meet', { seconds: 10, continuous: false }),
    newItem('final', 'assemble', 'Film', ['s1', 's2', 's3']),
  ],
});
const doneAll = (m: MovieManifest) => m.items.reduce((a, i) => completeItem(a, i.id, { outputId: 'out-' + i.id }), m);

test('valid manifest round-trips and damaged ones are refused', () => {
  const m = film();
  assert.equal(manifestProblem(m), undefined);
  assert.deepEqual(parseManifest(serializeManifest(m)), m);
  assert.throws(() => parseManifest('{'), /not valid JSON/);
  assert.match(manifestProblem({ ...m, version: 2 })!, /version/);
  assert.match(manifestProblem({ ...m, items: [...m.items, m.items[0]] })!, /duplicate/);
  assert.match(manifestProblem({ ...m, items: [{ ...m.items[1], deps: ['ghost'] }, m.items[0]] })!, /dependency/);
  const cyc = { ...m, items: m.items.map(i => i.id === 'brief' ? { ...i, deps: ['final'] } : i) };
  assert.equal(manifestProblem(cyc), 'dependency cycle');
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 's1' ? { ...i, seconds: undefined } : i) })!, /seconds/);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'brief' ? { ...i, seconds: 3 } : i) })!, /segment-only/);
  // LoRAs belong to shots and to the music item only.
  const lora = [{ name: 'ace/lofi.safetensors', strength: 0.5 }];
  const withMusic = { ...m, items: [...m.items, { ...newItem('music', 'music', 'Music', ['brief']), loras: lora }] };
  assert.equal(manifestProblem(withMusic), undefined);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'cast-a' ? { ...i, loras: lora } : i) })!, /shots and the music only/); // a voice item takes none
  assert.match(manifestProblem({ ...withMusic, items: withMusic.items.map(i => i.id === 'music' ? { ...i, loras: [{ name: 'x', strength: 5 }] } : i) })!, /LoRAs/);
  assert.throws(() => serializeManifest({ ...m, version: 9 as 1 }), /Refusing/);
});

test('an edit marks only downstream finished items stale, keeps old revisions, and the input is not mutated', () => {
  const m = doneAll(film());
  const e = editItem(m, 'cast-b', 'short, blue hat');
  const st = Object.fromEntries(e.items.map(i => [i.id, i.state]));
  assert.deepEqual(st, { brief: 'done', 'cast-a': 'done', 'cast-b': 'planned', story: 'stale', s1: 'stale', s2: 'stale', s3: 'stale', final: 'stale' });
  assert.equal(m.items.find(i => i.id === 'cast-b')!.text, 'short, green hat');
  const b = e.items.find(i => i.id === 'cast-b')!;
  assert.equal(b.revision, 2);
  assert.equal(b.revisions[0].result?.outputId, 'out-cast-b');
  assert.equal(editItem(e, 'cast-b', 'short, blue hat'), e);
});

test('a continuous segment depends on the one before it; a cut does not', () => {
  const m = film();
  assert.deepEqual(downstream(m, 's1'), ['s2', 'final']);
  assert.deepEqual(downstream(m, 's2'), ['final']);
  assert.deepEqual(downstream(m, 'cast-a'), ['story', 's1', 's2', 's3', 'final']);
});

test('rerun plan separates free reruns, locked approvals and untouched items', () => {
  const m = setLocked(film(), 's3', true);
  const p = rerunPlan(m, 'story');
  assert.deepEqual(p.rerun, ['s1', 's2', 'final']);
  assert.deepEqual(p.needsApproval, ['s3']);
  assert.deepEqual(p.untouched, ['brief', 'cast-a', 'cast-b']);
});

test('locked items refuse edits unless forced; restore keeps history growing', () => {
  const m = setLocked(film(), 'cast-a', true);
  assert.throws(() => editItem(m, 'cast-a', 'x'), /locked/);
  const f = editItem(m, 'cast-a', 'x', true);
  const r = restoreRevision(f, 'cast-a', 1);
  const a = r.items.find(i => i.id === 'cast-a')!;
  assert.equal(a.text, 'tall, red coat');
  assert.deepEqual(a.revisions.map(x => x.n), [1, 2, 3]);
  assert.throws(() => restoreRevision(r, 'cast-a', 9), /no revision/);
});

test('ready items follow dependencies, continuity and approvals', () => {
  let m = film();
  assert.deepEqual(readyItems(m), ['brief']);
  for (const id of ['brief', 'cast-a', 'cast-b', 'story']) m = completeItem(m, id, { outputId: id });
  assert.deepEqual(readyItems(m), ['s1', 's3']);
  m = completeItem(m, 's1', { outputId: 's1' });
  assert.deepEqual(readyItems(m), ['s2', 's3']);
  // A stale locked segment waits for approval even when its inputs are done.
  let k = setLocked(doneAll(film()), 's3', true);
  k = { ...k, items: k.items.map(x => x.id === 's3' ? { ...x, state: 'stale' as const } : x) };
  assert.ok(!readyItems(k).includes('s3'));
  assert.ok(readyItems(k, new Set(['s3'])).includes('s3'));
});

test('segment arithmetic is exact, with overlap, and explains an unattainable total', () => {
  const a = planSegments(30, { min: 5, max: 15 });
  assert.deepEqual(a, { ok: true, seconds: [15, 15], total: 30 });
  const b = planSegments(30, { min: 5, max: 10, overlap: 1 });
  assert.ok(b.ok);
  if (b.ok) { assert.equal(b.seconds.length, 4); assert.equal(Math.round((b.seconds.reduce((x, y) => x + y, 0) - 3) * 10) / 10, 30); assert.ok(b.seconds.every(s => s >= 5 && s <= 10)); }
  const c = planSegments(7.3, { min: 5, max: 5, step: 5 });
  assert.equal(c.ok, false);
  if (!c.ok) { assert.match(c.reason, /nearest attainable length is 5s/); assert.equal(c.nearest?.total, 5); }
  const d = planSegments(2, { min: 5, max: 15 });
  assert.ok(!d.ok && d.nearest?.total === 5);
  assert.ok(!planSegments(0, { min: 5, max: 15 }).ok);
  assert.ok(!planSegments(10, { min: 5, max: 15, overlap: 5 }).ok);
  assert.deepEqual(planSegments(0.3, { min: 0.1, max: 0.1 }), { ok: true, seconds: [0.1, 0.1, 0.1], total: 0.3 });
});

test('delivered seconds subtract the overlap of continued segments only', () => {
  assert.equal(deliveredSeconds(film(), 1), 29);
  assert.equal(deliveredSeconds(film(), 0), 30);
});

test('scenes authoring: + adds a scene after the selected one, − removes it, the length is the sum, inputs are a revision', () => {
  let m = newMovie('m1', 'Chase');
  assert.equal(manifestProblem(m), undefined);
  m = setBrief(m, { story: 'Anna runs.', aspect: '9:16', title: 'Chase 2' });
  assert.deepEqual([m.title, m.aspect, m.items[0].title, m.items[0].text, m.items[0].revision], ['Chase 2', '9:16', 'Chase 2', 'Anna runs.', 2]);
  m = addScene(m, 5);
  m = addScene(m, 7);
  assert.deepEqual(m.items.map(i => i.id), ['brief', 'seg-1', 'seg-2', 'final']);
  assert.deepEqual(m.items.find(i => i.id === 'final')!.deps, ['seg-1', 'seg-2']);
  assert.equal(m.targetSeconds, 12);
  m = addScene(m, 4, 'seg-1');
  assert.deepEqual(m.items.filter(i => i.kind === 'segment').map(i => i.id), ['seg-1', 'seg-3', 'seg-2']);
  assert.equal(scenesSeconds(m), 16);
  m = setSceneSeconds(m, 'seg-3', 6.5);
  assert.equal(m.targetSeconds, 18.5);
  // Inputs: frames and references with the Director options; a change is a revision and stales a finished scene.
  m = completeItem(m, 'seg-1', { outputId: '/o/1.mp4' });
  const inputs = { first: { path: '/p/a.png', media: 'image' as const }, refs: [{ path: '/p/b.png', media: 'image' as const, mediaMode: 'video' as const, second: 0, strength: 1, label: 'character-1', boxes: [{ n: 1, box: [0.1, 0.1, 0.5, 0.9] as [number, number, number, number] }] }] };
  const withInputs = setSceneInputs(m, 'seg-1', inputs);
  assert.deepEqual(withInputs.items.find(i => i.id === 'seg-1')!.inputs, inputs);
  assert.equal(withInputs.items.find(i => i.id === 'seg-1')!.state, 'planned');
  assert.deepEqual(sceneFiles(withInputs.items.find(i => i.id === 'seg-1')!), ['/p/a.png', '/p/b.png']);
  assert.equal(manifestProblem(withInputs), undefined);
  assert.equal(setSceneInputs(withInputs, 'seg-1', {}).items.find(i => i.id === 'seg-1')!.inputs, undefined);
  assert.throws(() => setSceneInputs(m, 'seg-1', { refs: [{ path: '/p/x.png', media: 'image', mediaMode: 'video', second: 0, strength: 99 }] }), /cannot be kept/);
  // Inputs belong to scenes only; unknown fields are refused.
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'brief' ? { ...i, inputs: {} } : i) })!, /scenes only/);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'seg-2' ? { ...i, inputs: { first: { path: '/p/a.png', media: 'image', extra: 1 } } as never } : i) })!, /bad first/);
  // −: removing the first scene makes a following continued scene a cut; the last scene removes the film too.
  let c = reviseItem(m, 'seg-3', { continuous: true });
  c = removeScene(c, 'seg-1');
  assert.equal(c.items.find(i => i.id === 'seg-3')!.continuous, false);
  assert.deepEqual(c.items.find(i => i.id === 'final')!.deps, ['seg-3', 'seg-2']);
  assert.equal(c.targetSeconds, 13.5);
  assert.throws(() => removeScene(setLocked(c, 'seg-2', true), 'seg-2'), /locked/);
  assert.throws(() => removeScene(c, 'brief'), /Unknown scene/);
  const none = removeScene(removeScene(c, 'seg-3'), 'seg-2');
  assert.deepEqual(none.items.map(i => i.id), ['brief']);
  assert.equal(manifestProblem(none), undefined);
});

test('markResultsMissing sends gone clips back to not made and stales what was built from them', async () => {
  const { markResultsMissing } = await import('../src/lib/movieManifest.ts');
  const m = doneAll(film());
  const r = markResultsMissing(m, ['s1']);
  const st = Object.fromEntries(r.items.map(i => [i.id, i.state]));
  assert.deepEqual([st.s1, st.s2, st.s3, st.final, st.story, st.brief], ['planned', 'stale', 'done', 'stale', 'done', 'done']);
  assert.equal(r.items.find(i => i.id === 's1')!.revisions[0].result?.outputId, 'out-s1');
  assert.equal(manifestProblem(r), undefined);
  assert.equal(markResultsMissing(m, []).items.every(i => i.state === 'done'), true);
});

test('the media pool is bounded, typed and never stales anything', async () => {
  const { addMedia, removeMedia, setMediaNote } = await import('../src/lib/movieManifest.ts');
  const m = doneAll(film());
  const p = addMedia(m, [{ path: '/p/a.png', media: 'image' }, { path: '/p/b.mp4', media: 'video', note: 'the street' }]);
  assert.deepEqual(p.media, [{ path: '/p/a.png', media: 'image' }, { path: '/p/b.mp4', media: 'video', note: 'the street' }]);
  assert.deepEqual(p.items.map(i => i.state), m.items.map(i => i.state));
  assert.equal(manifestProblem(p), undefined);
  assert.equal(setMediaNote(p, '/p/a.png', 'Anna').media![0].note, 'Anna');
  assert.equal(setMediaNote(p, '/p/b.mp4', ' ').media![1].note, undefined);
  assert.deepEqual(removeMedia(p, '/p/a.png').media!.map(x => x.path), ['/p/b.mp4']);
  assert.equal(removeMedia(removeMedia(p, '/p/a.png'), '/p/b.mp4').media, undefined);
  assert.equal(addMedia(m, Array.from({ length: 40 }, (_, i) => ({ path: `/p/${i}.png`, media: 'image' as const }))).media!.length, 32);
  assert.match(manifestProblem({ ...p, media: [{ path: '/p/a.png', media: 'pdf' as never }] })!, /media pool/);
  assert.match(manifestProblem({ ...p, media: [{ path: '/p/a.png', media: 'image', extra: 1 } as never] })!, /media pool/);
});

test('a pool medium is used in several scenes with one role; H3 refuses mixing frames and references; Use in is read from the scenes', async () => {
  const { addMedia, assignMedia, scenesUsing, dropMedia, addScene, setSceneInputs } = await import('../src/lib/movieManifest.ts');
  let m = [5, 5, 5].reduce((x, s) => addScene(x, s), addMedia(newMovie('m', 'F'), [{ path: '/p/anna.png', media: 'image', note: 'Anna' }, { path: '/p/rain.wav', media: 'audio' }]));
  let r = assignMedia(m, '/p/anna.png', ['seg-1', 'seg-3'], 'reference', 'character-1');
  assert.deepEqual(r.refused, []);
  assert.deepEqual(scenesUsing(r.movie, '/p/anna.png'), ['seg-1', 'seg-3']);
  assert.deepEqual(r.movie.items.find(i => i.id === 'seg-1')!.inputs, { refs: [{ path: '/p/anna.png', media: 'image', mediaMode: 'video', second: 0, strength: 1, label: 'character-1', description: 'Anna' }] });
  assert.equal(r.movie.media![0].label, 'character-1');
  // Moving it: out of seg-3, into seg-2 as first frame; seg-2 holds a reference already → refused there.
  m = setSceneInputs(r.movie, 'seg-2', { refs: [{ path: '/p/x.png', media: 'image', mediaMode: 'video', second: 0, strength: 1 }] });
  r = assignMedia(m, '/p/anna.png', ['seg-2', 'seg-3'], 'first');
  assert.deepEqual(r.refused, ['seg-2']);
  assert.deepEqual(scenesUsing(r.movie, '/p/anna.png'), ['seg-3']);
  assert.deepEqual(r.movie.items.find(i => i.id === 'seg-3')!.inputs, { first: { path: '/p/anna.png', media: 'image' } });
  assert.equal(r.movie.media![0].role, 'first');
  assert.throws(() => assignMedia(m, '/p/rain.wav', ['seg-1'], 'first'), /Only a picture/);
  assert.equal(manifestProblem(r.movie), undefined);
  // Removing the medium takes it out of every scene.
  const gone = dropMedia(r.movie, '/p/anna.png');
  assert.deepEqual([gone.media!.map(x => x.path), gone.items.find(i => i.id === 'seg-3')!.inputs], [['/p/rain.wav'], undefined]);
});
