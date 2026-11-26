import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIX, addCast, completeItem, manifestProblem, newMovie, setBrief, setMix, setMusicFile } from '../src/lib/movieManifest.ts';
import { applyPlan } from '../src/lib/movieStory.ts';

const film = () => applyPlan(addCast(setBrief(newMovie('m1', 'F', 10, '16:9'), { story: 's' }), 'actor', 'Anna'), { lore: 'l', segments: [
  { title: 'A', prompt: 'a', seconds: 5, castIds: [], continuous: false, dialogue: [] }, { title: 'B', prompt: 'b', seconds: 5, castIds: [], continuous: false, dialogue: [] }] });
const done = () => ['seg-1', 'seg-2', 'final'].reduce((m, id) => completeItem(m, id, { outputId: `/out/${id}.mp4`, seconds: 5 }), film());

test('choosing a track creates the music and score items once the film exists, with default mix settings', () => {
  let m = setMusicFile(film(), '/music/bed.wav');
  assert.deepEqual(m.items.filter(i => i.kind === 'music' || i.kind === 'score').map(i => [i.id, i.deps, i.file]), [['music', ['brief'], '/music/bed.wav'], ['score', ['final', 'music'], undefined]]);
  assert.deepEqual(m.items.find(i => i.id === 'score')!.mix, DEFAULT_MIX);
  assert.equal(manifestProblem(m), undefined);
  // Choosing again revises the same item and does not add another score.
  m = setMusicFile(m, '/music/other.wav');
  assert.equal(m.items.filter(i => i.kind === 'score').length, 1);
  assert.equal(m.items.find(i => i.id === 'music')!.revision, 3);
  // No film item yet (no story plan): music alone, no score.
  const early = setMusicFile(newMovie('x', 'x'), '/m.wav');
  assert.deepEqual(early.items.map(i => i.id), ['brief', 'music']);
});

test('mix settings are clamped, make the scored film outdated, and need the score item', () => {
  assert.throws(() => setMix(film(), { levelDb: 0 }), /Choose a music file/);
  let m = setMusicFile(done(), '/music/bed.wav');
  m = completeItem(m, 'score', { outputId: '/out/final-scored.mp4' });
  assert.equal(m.items.find(i => i.id === 'score')!.state, 'done');
  m = setMix(m, { levelDb: -99, duckDb: 99, fadeSeconds: -3 });
  const mix = m.items.find(i => i.id === 'score')!.mix!;
  assert.deepEqual(mix, { mode: 'mix', levelDb: -40, duckDb: 30, fadeSeconds: 0 });
  assert.equal(m.items.find(i => i.id === 'score')!.state, 'planned');
  assert.equal(setMix(m, { levelDb: NaN }).items.find(i => i.id === 'score')!.mix!.levelDb, -40);
  assert.equal(manifestProblem(m), undefined);
});

test('a changed music file or film marks the scored film outdated', () => {
  let m = completeItem(setMusicFile(done(), '/music/a.wav'), 'score', { outputId: '/o/s.mp4' });
  assert.equal(setMusicFile(m, '/music/b.wav').items.find(i => i.id === 'score')!.state, 'stale');
  assert.equal(setMusicFile(m, null).items.find(i => i.id === 'music')!.file, undefined);
  const edited = { ...m, items: m.items.map(i => i.id === 'seg-1' ? { ...i } : i) };
  assert.equal(edited.items.find(i => i.id === 'score')!.state, 'done');
});

test('invalid music/mix data is refused by the validator', () => {
  const m = setMusicFile(film(), '/music/bed.wav');
  const bad = (id: string, patch: object) => manifestProblem({ ...m, items: m.items.map(i => i.id === id ? { ...i, ...patch } : i) });
  assert.match(bad('score', { mix: { ...DEFAULT_MIX, duckDb: 31 } })!, /bad mix settings/);
  assert.match(bad('score', { mix: { ...DEFAULT_MIX, mode: 'loud' } })!, /bad mix settings/);
  assert.match(bad('brief', { mix: DEFAULT_MIX })!, /bad mix settings/);
  assert.match(bad('brief', { file: '/x.wav' })!, /bad music file/);
  assert.match(bad('music', { file: '' })!, /bad music file/);
});
