import { expect, it } from 'vitest';
import { completeItem, newMovie, setBrief, setMix, setMusicFile, addCast } from './movieManifest';
import { applyPlan } from './movieStory';
import { mixPlan, recordScore } from './movieMusic';

const film = (done: boolean) => {
  let m = applyPlan(addCast(setBrief(newMovie('m', 'F'), { story: 's' }), 'actor', 'A'), { lore: 'l', segments: [{ title: 'A', prompt: 'a', seconds: 5, castIds: [], continuous: false, dialogue: [] }] });
  if (done) m = ['seg-1', 'final'].reduce((x, id) => completeItem(x, id, { outputId: `/out/${id}.mp4` }), m);
  return setMusicFile(m, '/music/bed.wav');
};

it('the mix needs a music file, a made and current film, and the mix mode', () => {
  expect(mixPlan(film(true))).toEqual({ ok: true, film: '/out/final.mp4', music: '/music/bed.wav', mix: { mode: 'mix', levelDb: -14, duckDb: 12, fadeSeconds: 2 } });
  expect(mixPlan(film(false))).toEqual({ ok: false, why: 'noFilm' });
  expect(mixPlan(setMusicFile(film(true), null))).toEqual({ ok: false, why: 'noMusic' });
  expect(mixPlan(newMovie('x', 'x'))).toEqual({ ok: false, why: 'noMusic' });
  expect(mixPlan(setMix(film(true), { mode: 'h3-reference' }))).toEqual({ ok: false, why: 'mode' });
  const stale = { ...film(true), items: film(true).items.map(i => i.id === 'final' ? { ...i, state: 'stale' as const } : i) };
  expect(mixPlan(stale)).toEqual({ ok: false, why: 'filmOutdated' });
  const notVideo = completeItem(film(true), 'final', { outputId: '/out/x.png' });
  expect(mixPlan(notVideo)).toEqual({ ok: false, why: 'noFilm' });
});

it('the scored film is recorded on the score item', () => {
  const m = recordScore(film(true), { path: '/out/final-scored.mp4', seconds: 10, ducked: true });
  const s = m.items.find(i => i.kind === 'score')!;
  expect([s.state, s.revisions.at(-1)!.result]).toEqual(['done', { outputId: '/out/final-scored.mp4', seconds: 10 }]);
  expect(() => recordScore(newMovie('x', 'x'), { path: '/p', seconds: 1, ducked: false })).toThrow(/no score/);
});
