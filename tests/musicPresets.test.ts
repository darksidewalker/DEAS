import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MUSIC_PRESETS, loadMusicPresets, musicPresetProblem, presetDialect, presetName, styleFor } from '../src/lib/musicPresets.ts';

const raw = JSON.parse(readFileSync(new URL('../src/wizards/musicPresets.json', import.meta.url), 'utf8'));
const locales = ['en', 'de', 'fr', 'ja', 'ru', 'tr', 'zh'];

test('every bundled music preset is usable: named in every app language, instrumental in both dialects, a tempo ACE-Step accepts', () => {
  assert.equal(MUSIC_PRESETS.length, raw.presets.length);
  assert.ok(MUSIC_PRESETS.length >= 10);
  for (const p of MUSIC_PRESETS) {
    assert.equal(musicPresetProblem(p), undefined, p.id);
    assert.deepEqual(Object.keys(p.name).sort(), [...locales].sort(), p.id);
    assert.match(p.ace, /\binstrumental\b/, p.id);
    // The YuE2 dialect follows the DaSiWa instrumental writer: it begins with Instrumental and says no vocals.
    assert.match(p.yue2, /^Instrumental, /, p.id);
    assert.match(p.yue2, /no vocals$/, p.id);
    assert.ok(p.yue2.includes(`${p.bpm} BPM`), `${p.id} names its tempo in the YuE2 line`);
    assert.doesNotMatch(`${p.ace} ${p.yue2}`, /\b(choir|singer|vocals?:|lyrics)\b/i, p.id);
  }
});

test('invalid preset entries are dropped instead of half-used; later duplicates lose', () => {
  const ok = raw.presets[0];
  const list = loadMusicPresets({ presets: [ok, { ...ok }, { ...ok, id: 'Bad Id' }, { ...ok, id: 'nobpm', bpm: 400 }, { ...ok, id: 'noname', name: { de: 'x' } }, { ...ok, id: 'noyue', yue2: '' }, null] });
  assert.deepEqual(list.map(p => p.id), [ok.id]);
  assert.deepEqual(loadMusicPresets({}), []);
});

test('a preset reads in the chosen model\'s dialect while untouched; an edited text is never replaced', () => {
  const p = MUSIC_PRESETS[0];
  assert.equal(presetDialect('yue2'), 'yue2');
  assert.equal(presetDialect('ace-step-1-5-turbo'), 'ace');
  assert.equal(styleFor(p.ace, p.id, 'yue2'), p.yue2);
  assert.equal(styleFor(p.yue2, p.id, 'ace-step-1-5-xl-sft'), p.ace);
  assert.equal(styleFor(`${p.ace}, more cowbell`, p.id, 'yue2'), `${p.ace}, more cowbell`);
  assert.equal(styleFor('my own', undefined, 'yue2'), 'my own');
  assert.equal(presetName(p, 'de'), p.name.de);
  assert.equal(presetName(p, 'pt-BR'), p.name.en);
});
