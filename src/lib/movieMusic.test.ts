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

import { MUSIC_FAMILIES, isRestrictedMusicFamily, musicHandoff, musicSeconds, recordGeneratedMusic, setMusicLoras, setMusicPrompt } from './movieMusic';

it('the bed is as long as the made film, else the planned shots, else the target', () => {
  const planned = film(false);
  expect(musicSeconds(planned)).toBe(5);
  const made = completeItem(film(true), 'final', { outputId: '/out/final.mp4', seconds: 41.3 });
  expect(musicSeconds(made)).toBe(42);
  expect(musicSeconds(newMovie('x', 'x', 90))).toBe(90);
  expect(musicSeconds(newMovie('x', 'x', 5000))).toBe(1000);
});

it('the hand-over is an instrumental text-to-music draft from the music prompt, and needs the prompt', () => {
  const model = { name: 'ace-step-1-5-turbo.safetensors', path: '/m/ace' };
  expect(musicHandoff(film(true), model, true)).toEqual({ blocked: 'wizards.movie.music.needPrompt' });
  const m = setMusicPrompt(film(true), '  calm piano  ');
  const r = musicHandoff(m, model, false);
  expect(r).toEqual({ handoff: { wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', model, positive: '', run: false, music: { style: 'calm piano', lyrics: '', seconds: 5 }, loras: [] } });
  expect(setMusicPrompt(m, '  calm piano  ')).toBe(m); // unchanged text is not a new revision
  expect(setMusicPrompt(newMovie('x', 'x'), 'a').items.map(i => i.id)).toEqual(['brief', 'music']);
  expect(MUSIC_FAMILIES[0]).toBe('ace-step-1-5-turbo');
  expect([isRestrictedMusicFamily('yue2'), isRestrictedMusicFamily('ace-step-1-5-turbo'), isRestrictedMusicFamily(null)]).toEqual([true, false, false]);
});

it('the music item carries its own LoRAs: installed-checked, refused on YuE2, and the music item is created when needed', () => {
  const ace = { name: 'ace-step-1-5-turbo.safetensors', path: '/m/ace', family: 'ace-step-1-5-turbo' };
  let m = setMusicLoras(film(true), [{ name: 'ace/lofi.safetensors', strength: 9 }, { name: 'ace/lofi.safetensors', strength: 1 }]);
  expect(m.items.find(i => i.kind === 'music')!.loras).toEqual([{ name: 'ace/lofi.safetensors', strength: 4 }]); // clamped, no repeats
  m = setMusicPrompt(m, 'lofi');
  const r = musicHandoff(m, ace, true, n => n === 'ace/lofi.safetensors');
  expect('handoff' in r && r.handoff.loras).toEqual([{ name: 'ace/lofi.safetensors', strength: 4 }]);
  expect('handoff' in r && r.handoff.model).toEqual({ name: ace.name, path: ace.path }); // the family is not part of the hand-over
  expect(musicHandoff(m, ace, true, () => false)).toEqual({ blocked: 'wizards.movie.music.loraMissing', detail: 'ace/lofi.safetensors' });
  expect(musicHandoff(m, { name: 'yue2.safetensors', path: '/m/y', family: 'yue2' }, true)).toEqual({ blocked: 'wizards.movie.music.loraYue2' });
  expect(musicHandoff(setMusicLoras(m, []), { name: 'yue2.safetensors', path: '/m/y', family: 'yue2' }, true)).toHaveProperty('handoff');
  expect(setMusicLoras(newMovie('x', 'x'), [{ name: 'a.safetensors', strength: 1 }]).items.map(i => i.id)).toEqual(['brief', 'music']);
});

it('a generated track becomes the music file and result, makes the scored film outdated, and a failure marks the item failed', () => {
  let m = setMusicPrompt(film(true), 'calm piano');
  m = completeItem(m, 'score', { outputId: '/out/old-scored.mp4' });
  const ok = recordGeneratedMusic(m, { state: 'succeeded', job: { id: 'j9' }, picture: { path: '/out/audio/bed.flac', audio: true } });
  const music = ok.items.find(i => i.kind === 'music')!;
  expect([music.file, music.state, music.revisions.at(-1)!.result]).toEqual(['/out/audio/bed.flac', 'done', { outputId: '/out/audio/bed.flac', jobId: 'j9' }]);
  expect(ok.items.find(i => i.kind === 'score')!.state).toBe('stale');
  expect(recordGeneratedMusic(m, { state: 'running' })).toBe(m);
  expect(recordGeneratedMusic(m, { state: 'failed' }).items.find(i => i.kind === 'music')!.state).toBe('failed');
  expect(recordGeneratedMusic(m, { state: 'succeeded', picture: { path: '/out/x.png' } }).items.find(i => i.kind === 'music')!.state).toBe('failed');
  expect(recordGeneratedMusic(newMovie('x', 'x'), { state: 'failed' }).items.length).toBe(1);
});
