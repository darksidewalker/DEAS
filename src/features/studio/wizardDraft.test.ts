import { expect, it } from 'vitest';
import { wizardDraft } from './wizardDraft';
import type { WizardHandoff } from '../../lib/wizards';

const pic = (n: string) => ({ name: n, path: `/pics/${n}`, src: `asset://${n}` });
const base = { n: 1, wizard: 'replace', model: { name: 'm', path: '/m' }, positive: 'p' };
const key = () => 'k';
const none = () => false;

it('reference edit: the picture and extra references become prompt references, no media', () => {
  const d = wizardDraft({ ...base, strategy: 'reference', pipeline: 't2i', source: 'reference', picture: pic('a.png'), references: [pic('b.png')] } as WizardHandoff, none, key)!;
  expect(d.media).toBeNull();
  expect(d.imageRefs.map(r => [r.item.name, r.strength])).toEqual([['a.png', 0.6], ['b.png', 0.6]]);
  expect(d.video).toBeUndefined();
});

it('masked/plain edit: picture is the media, wizard file only when outside ComfyUI folders, with its edit settings', () => {
  const h = { ...base, strategy: 'inpaint', pipeline: 'i2i', source: 'edit', edit: 'inpaint', denoise: 1, maskBlur: 4, picture: pic('a.png') } as WizardHandoff;
  const d = wizardDraft(h, none, key)!;
  expect([d.media?.name, d.wizardPicture, d.edit, d.denoise, d.maskBlur]).toEqual(['a.png', { path: '/pics/a.png', name: 'a.png' }, 'inpaint', { inpaint: true, value: 1 }, 4]);
  expect(wizardDraft(h, () => 'a.png', key)!.wizardPicture).toBeNull();
  expect(wizardDraft({ ...h, edit: 'resample', maskBlur: 99 }, none, key)!.denoise).toEqual({ inpaint: false, value: 1 });
  expect(wizardDraft({ ...h, maskBlur: 99 }, none, key)!.maskBlur).toBeUndefined();
});

it('Replace video step: edited frame is the first frame, clip is the guide with its strength, seconds kept', () => {
  const d = wizardDraft({ ...base, strategy: 'edit', pipeline: 'v2v', source: 'video', picture: pic('f.png'), sourceVideo: pic('c.mp4'), sourceStrength: 0.2, seconds: 5 } as WizardHandoff, none, key)!;
  expect([d.media?.name, d.video?.sourceVideo?.media, d.video?.sourceStrength, d.video?.refs, d.seconds]).toEqual(['f.png', 'video', 0.2, [], 5]);
  const bad = wizardDraft({ ...base, strategy: 'edit', pipeline: 'v2v', source: 'video', picture: pic('f.png'), sourceStrength: 7, seconds: 0 } as WizardHandoff, none, key)!;
  expect([bad.video?.sourceVideo, bad.video?.sourceStrength, bad.seconds]).toEqual([null, undefined, undefined]);
});

it('Movie Maker shot: no first frame; ref2v takes labelled references, t2v none', () => {
  const h = { ...base, wizard: 'movie', strategy: 'seg-1', pipeline: 'ref2v', source: 'movie', references: [pic('a.png'), pic('s.png')], labels: [undefined, 'place'], notes: ['Anna', undefined], seconds: 10 } as WizardHandoff;
  const d = wizardDraft(h, none, key)!;
  expect([d.media, d.seconds, d.video!.sourceVideo]).toEqual([null, 10, null]);
  expect(d.video!.refs.map(r => [r.item.name, r.label, r.description, r.uiKey, r.second, r.mediaMode])).toEqual([['a.png', undefined, 'Anna', 'k', 0, 'video'], ['s.png', 'place', undefined, 'k', 0, 'video']]);
  expect(wizardDraft({ ...h, pipeline: 't2v' }, none, key)!.video!.refs).toEqual([]);
});

it('a hand-over that needs a picture and has none is refused', () => {
  expect(wizardDraft({ ...base, strategy: 'x', pipeline: 'i2i', source: 'edit' } as WizardHandoff, none, key)).toBeNull();
  expect(wizardDraft({ ...base, strategy: 'x', pipeline: 'i2v', source: 'video' } as WizardHandoff, none, key)).toBeNull();
});

it('Movie Maker music bed: a text-to-music draft with style, lyrics and length, no pictures or references', () => {
  const h = { ...base, wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', positive: '', music: { style: 'calm piano', lyrics: '', seconds: 42 } } as WizardHandoff;
  const d = wizardDraft(h, none, key)!;
  expect([d.media, d.imageRefs, d.music, d.seconds, d.video]).toEqual([null, [], { style: 'calm piano', lyrics: '', seconds: 42 }, undefined, { refs: [], sourceVideo: null }]);
  expect(wizardDraft({ ...h, music: undefined }, none, key)).toBeNull();
});
