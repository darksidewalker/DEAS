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

const vref = (n: string, extra: Record<string, unknown> = {}) => ({ ...pic(n), media: n.endsWith('.mp4') ? 'video' as const : 'image' as const, mediaMode: 'video' as const, second: 0, strength: 1, ...extra });
it('Movie Maker scene: ref2v takes its references with every Director option; frames become first/last frame; t2v none', () => {
  const h = { ...base, wizard: 'movie', strategy: 'seg-1', pipeline: 'ref2v', source: 'movie', seconds: 10,
    videoRefs: [vref('a.png', { label: 'character-1', description: 'Anna', boxes: [{ n: 1, box: [0, 0, 1, 1] }] }), vref('c.mp4', { mediaMode: 'video_audio', trimStart: 1, trimEnd: 4 })] } as WizardHandoff;
  const d = wizardDraft(h, none, key)!;
  expect([d.media, d.seconds, d.video!.sourceVideo, d.video!.lastFrame]).toEqual([null, 10, null, null]);
  expect(d.video!.refs.map(r => [r.item.name, r.item.path, r.item.media, r.label, r.description, r.boxes, r.mediaMode, r.trimStart, r.trimEnd, r.uiKey])).toEqual([
    ['a.png', '/pics/a.png', 'image', 'character-1', 'Anna', [{ n: 1, box: [0, 0, 1, 1] }], 'video', undefined, undefined, 'k'],
    ['c.mp4', '/pics/c.mp4', 'video', undefined, undefined, undefined, 'video_audio', 1, 4, 'k']]);
  expect(wizardDraft({ ...h, pipeline: 't2v' }, none, key)!.video!.refs).toEqual([]);
  const framed = wizardDraft({ ...base, wizard: 'movie', strategy: 'seg-2', pipeline: 'i2v', source: 'movie', seconds: 5, frames: { first: pic('f.png'), last: pic('l.png') } } as WizardHandoff, none, key)!;
  expect([framed.media?.path, framed.video!.lastFrame?.path, framed.video!.refs]).toEqual(['/pics/f.png', '/pics/l.png', []]);
  const lastOnly = wizardDraft({ ...base, wizard: 'movie', strategy: 'seg-2', pipeline: 'i2v', source: 'movie', seconds: 5, frames: { last: pic('l.png') } } as WizardHandoff, none, key)!;
  expect([lastOnly.media?.path, lastOnly.video!.lastFrame?.path]).toEqual(['/pics/l.png', '/pics/l.png']);
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
  // Its LoRAs always replace Generate's list: none means an empty list, never the picture LoRAs left in Generate.
  expect(d.loras).toEqual([]);
  expect(wizardDraft({ ...h, loras: [{ name: 'ace/lofi.safetensors', strength: 0.5 }] }, none, key)!.loras).toEqual([{ name: 'ace/lofi.safetensors', strength: 0.5 }]);
});

it('Movie Maker shot LoRAs are carried into the draft; none means the list stays as the hand-over reset it', () => {
  const h = { ...base, wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', seconds: 5, loras: [{ name: 'MiniMaxH3/style.safetensors', strength: 0.7 }] } as WizardHandoff;
  expect(wizardDraft(h, none, key)!.loras).toEqual([{ name: 'MiniMaxH3/style.safetensors', strength: 0.7 }]);
  expect(wizardDraft({ ...h, loras: [] }, none, key)!.loras).toBeUndefined();
  expect(wizardDraft({ ...h, loras: undefined }, none, key)!.loras).toBeUndefined();
});

it('Movie Maker reference mode: the music slice is an audio reference after the pictures, trimmed to the shot', () => {
  const h = { ...base, wizard: 'movie', strategy: 'seg-1', pipeline: 'ref2v', source: 'movie', seconds: 5, videoRefs: [vref('a.png')],
    audioRef: { name: 'bed.flac', path: '/music/bed.flac', src: 'asset://bed', trimStart: 10.125, trimEnd: 15.125 } } as WizardHandoff;
  const refs = wizardDraft(h, none, key)!.video!.refs;
  expect(refs.map(r => [r.item.media, r.item.name, r.mediaMode, r.trimStart, r.trimEnd])).toEqual([['image', 'a.png', 'video', undefined, undefined], ['audio', 'bed.flac', 'audio', 10.125, 15.125]]);
  expect(wizardDraft({ ...h, pipeline: 't2v', videoRefs: undefined }, none, key)!.video!.refs).toEqual([]);
});

it('Movie Maker music bed: tempo and lyrics language travel with the draft when set', () => {
  const h = { ...base, wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', positive: '', music: { style: 'jazz', lyrics: '[Verse] x', seconds: 30, bpm: 85, language: 'de' } } as WizardHandoff;
  expect(wizardDraft(h, none, key)!.music).toEqual({ style: 'jazz', lyrics: '[Verse] x', seconds: 30, bpm: 85, language: 'de' });
});
