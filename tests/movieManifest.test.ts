import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVIE_MANIFEST_VERSION, addCast, newMovie, removeCast, setBrief, setCastRefs, completeItem, deliveredSeconds, downstream, editItem, manifestProblem, newItem, parseManifest, planSegments, readyItems, rerunPlan, restoreRevision, serializeManifest, setLocked, type MovieManifest } from '../src/lib/movieManifest.ts';

const film = (): MovieManifest => ({
  version: MOVIE_MANIFEST_VERSION, id: 'film1', title: 'Two actors', targetSeconds: 30, aspect: '16:9',
  items: [
    newItem('brief', 'brief', 'Brief', [], 'A chase.'),
    newItem('cast-a', 'cast', 'Anna', ['brief'], 'tall, red coat'),
    newItem('cast-b', 'cast', 'Ben', ['brief'], 'short, green hat'),
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
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'cast-a' ? { ...i, loras: lora } : i) })!, /shots and the music only/);
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

test('brief and cast authoring: new movie, cast entries, references, staleness', () => {
  let m = newMovie('m1', 'Chase');
  assert.equal(manifestProblem(m), undefined);
  m = setBrief(m, { story: 'Anna runs.', targetSeconds: 20, aspect: '9:16', title: 'Chase 2' });
  assert.deepEqual([m.title, m.targetSeconds, m.aspect, m.items[0].title, m.items[0].text, m.items[0].revision], ['Chase 2', 20, '9:16', 'Chase 2', 'Anna runs.', 2]);
  m = addCast(m, 'actor', 'Anna', 'tall');
  m = addCast(m, 'location', 'Street');
  assert.deepEqual(m.items.map(i => i.id), ['brief', 'cast-1', 'cast-2']);
  assert.equal(manifestProblem(m), undefined);
  m = setCastRefs(m, 'cast-1', ['/p/a.png', '/p/a.png', '/p/b.png']);
  assert.deepEqual(m.items[1].refs, ['/p/a.png', '/p/b.png']);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'brief' ? { ...i, role: 'actor' as const } : i) })!, /cast-only/);
  // Something finished from cast-1 goes stale when its pictures change; a removed entry leaves the dependencies.
  let f = { ...m, items: [...m.items, newItem('story', 'story', 'Story', ['brief', 'cast-1', 'cast-2'])] };
  f = completeItem(f, 'story', { outputId: 'o' });
  const changed = setCastRefs(f, 'cast-1', ['/p/c.png']);
  assert.equal(changed.items.find(i => i.id === 'story')!.state, 'stale');
  const removed = removeCast(f, 'cast-2');
  assert.deepEqual(removed.items.find(i => i.id === 'story')!.deps, ['brief', 'cast-1']);
  assert.equal(removed.items.find(i => i.id === 'story')!.state, 'stale');
  assert.equal(manifestProblem(removed), undefined);
  assert.throws(() => removeCast(m, 'brief'), /Unknown cast/);
  assert.throws(() => removeCast(setLocked(m, 'cast-1', true), 'cast-1'), /locked/);
  assert.equal(addCast(removeCast(m, 'cast-1'), 'prop', 'Key').items.at(-1)!.id, 'cast-3');
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
