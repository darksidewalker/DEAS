import test from 'node:test';
import assert from 'node:assert/strict';
import { addScene, completeItem, manifestProblem, newMovie, setBrief, setLocked, setSceneInputs, type MovieManifest, type SegmentLimits } from '../src/lib/movieManifest.ts';
import { applyPlan, checkPlan, extractJson, parsePlannerAnswer, planDiff, plannerRequest, type StoryPlan } from '../src/lib/movieStory.ts';

const limits: SegmentLimits = { min: 5, max: 15, overlap: 1 };
const base = (): MovieManifest => setBrief(newMovie('m1', 'Chase', 28, '16:9'), { story: 'Anna chases Ben.' });
const good = (): StoryPlan => ({ lore: 'A chase at dusk.', segments: [
  { title: 'Start', prompt: 'Wide shot, Anna (tall, red coat) runs', seconds: 10, continuous: false, entry: 'dusk', exit: 'alley', dialogue: [{ speaker: 'Anna', line: 'Stop!', delivery: 'shouted' }] },
  { title: 'Alley', prompt: 'Tracking shot, Ben hides', seconds: 10, continuous: true, dialogue: [] },
  { title: 'Catch', prompt: 'Close up of Anna and Ben', seconds: 10, continuous: true, dialogue: [] },
] });
/** A movie the user built: two scenes, the first with a picture reference and a note. */
const built = (): MovieManifest => {
  let m = addScene(addScene(base(), 6), 4);
  m = setSceneInputs(m, 'seg-1', { refs: [{ path: '/p/anna.png', media: 'image', mediaMode: 'video', second: 0, strength: 1, label: 'character-1', description: 'Anna, red coat' }] });
  return m;
};

test('the suggest request carries the story and the scenes with what their inputs are, never a file', () => {
  const r = plannerRequest(built(), limits, 'suggest');
  assert.match(r.user, /Story:\nAnna chases Ben\./);
  assert.match(r.user, /1\. 6s .* inputs: reference picture \(character-1 — Anna, red coat\)/);
  assert.match(r.user, /2\. 4s .* inputs: no inputs/);
  assert.match(r.system, /which persons are in it/);
  assert.match(r.system, /Keep the given scenes that have inputs/);
  assert.doesNotMatch(r.user + r.system, /anna\.png/);
  assert.deepEqual(r.disclosure, { scenes: 2, storyCharacters: 16, inputsNotSent: 1 });
  const w = plannerRequest(built(), limits, 'write');
  assert.match(w.system, /exactly 2 segments/);
  assert.doesNotMatch(w.system, /"seconds"/);
});

test('JSON is pulled out of fenced or chatty answers, and garbage is refused', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```\nenjoy'), { a: 1 });
  assert.deepEqual(extractJson('{"a":2}'), { a: 2 });
  assert.throws(() => extractJson('no json'), /no JSON/);
  assert.throws(() => extractJson('{"a":'), /no JSON|not valid/);
  assert.deepEqual(parsePlannerAnswer('{', base(), limits).errors.length, 1);
});

test('a valid suggestion passes; invalid ones are rejected with specific errors', () => {
  const m = base();
  const ok = checkPlan(good(), m, limits);
  assert.deepEqual([ok.errors, ok.warnings, ok.plan!.segments.length], [[], [], 3]);
  const bad = (f: (p: StoryPlan) => void) => { const p = good(); f(p); return checkPlan(p, m, limits).errors.join(' | '); };
  assert.match(bad(p => { p.segments[1].seconds = 30; }), /outside 5–15s/);
  assert.match(bad(p => { p.segments[1].seconds = 7.25; }), /multiple of 0.1s/);
  assert.match(bad(p => { p.segments[0].continuous = true; }), /Segment 1 cannot continue/);
  assert.match(bad(p => { p.segments[0].dialogue = [{ speaker: '', line: 'hi' }]; }), /speaker name/);
  assert.match(bad(p => { p.segments[0].prompt = ' '; }), /"prompt" must be text/);
  assert.match(bad(p => { (p as any).lore = 5; }), /"lore"/);
  assert.match(checkPlan({ lore: '', segments: [] }, m, limits).errors[0], /non-empty/);
  assert.match(checkPlan(null, m, limits).errors[0], /not an object/);
  const w = good(); w.segments[1].dialogue = [{ speaker: 'Clara', line: 'x' }];
  assert.match(checkPlan(w, m, limits).warnings[0], /Clara speaks but the prompt does not name them/);
});

test('writing my scenes keeps their number, lengths, continuity and inputs and only fills the text', () => {
  const m = built();
  const answer = { lore: 'Dusk.', segments: [
    { title: 'Run', prompt: 'Anna in her red coat runs', seconds: 99, continuous: true, dialogue: [{ speaker: 'Anna', line: 'Wait!' }] },
    { title: 'Hide', prompt: 'Ben hides' },
  ] };
  const c = checkPlan(answer, m, limits, 'write');
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.plan!.segments.map(s => [s.seconds, s.continuous]), [[6, false], [4, false]]);
  const out = applyPlan(m, c.plan!);
  assert.equal(manifestProblem(out), undefined);
  const s1 = out.items.find(i => i.id === 'seg-1')!;
  assert.deepEqual([s1.title, s1.text, s1.seconds, s1.dialogue, s1.inputs?.refs?.[0].path], ['Run', 'Anna in her red coat runs', 6, [{ speaker: 'Anna', line: 'Wait!' }], '/p/anna.png']);
  assert.match(checkPlan({ lore: 'x', segments: [answer.segments[0]] }, m, limits, 'write').errors[0], /1 segments for 2 scenes/);
});

test('applying a suggestion builds story, scenes and the film item and stays a valid manifest', () => {
  const m = applyPlan(base(), good());
  assert.equal(manifestProblem(m), undefined);
  assert.deepEqual(m.items.map(i => i.id), ['brief', 'story', 'seg-1', 'seg-2', 'seg-3', 'final']);
  const s1 = m.items.find(i => i.id === 'seg-1')!;
  assert.deepEqual([s1.seconds, s1.continuous, s1.deps, s1.dialogue, s1.entry, s1.exit], [10, false, ['story'], [{ speaker: 'Anna', line: 'Stop!', delivery: 'shouted' }], 'dusk', 'alley']);
  assert.deepEqual(m.items.find(i => i.id === 'final')!.deps, ['seg-1', 'seg-2', 'seg-3']);
  assert.equal(m.targetSeconds, 30);
});

test('a suggestion never drops a scene holding inputs; locked scenes, revisions and results are kept', () => {
  let m = applyPlan(base(), good());
  for (const id of ['story', 'seg-1', 'seg-2', 'seg-3', 'final']) m = completeItem(m, id, { outputId: 'o-' + id });
  m = setLocked(m, 'seg-2', true);
  m = setSceneInputs(m, 'seg-3', { first: { path: '/p/f.png', media: 'image' } });
  const next = good();
  next.segments[0].prompt = 'New wide shot';
  next.segments[1].prompt = 'IGNORED (locked)';
  next.segments.pop();
  // Made scenes are left alone by default (the lock switch is gone from the UI) …
  const kept = planDiff(m, next);
  assert.deepEqual([kept.changed, kept.lockedKept], [[], ['seg-1', 'seg-2', 'seg-3']]);
  assert.equal(applyPlan(m, next).items.find(i => i.id === 'seg-1')!.text, 'Wide shot, Anna (tall, red coat) runs');
  // … and rewritten only with *Also rewrite made scenes*.
  const diff = planDiff(m, next, { rewriteMade: true });
  assert.deepEqual([diff.story, diff.changed, diff.lockedKept, diff.removed], ['same', ['seg-1'], ['seg-2', 'seg-3'], []]);
  const out = applyPlan(m, next, { rewriteMade: true });
  const by = (id: string) => out.items.find(i => i.id === id)!;
  assert.deepEqual([by('seg-1').text, by('seg-1').revision, by('seg-1').revisions[0].result?.outputId], ['New wide shot', 2, 'o-seg-1']);
  assert.equal(by('seg-2').text, 'Tracking shot, Ben hides');
  assert.deepEqual(by('seg-3').inputs, { first: { path: '/p/f.png', media: 'image' } });
  assert.deepEqual(by('final').deps, ['seg-1', 'seg-2', 'seg-3']);
  // Without inputs the surplus scene goes.
  const plain = applyPlan(setSceneInputs(m, 'seg-3', {}), next, { rewriteMade: true });
  assert.equal(plain.items.some(i => i.id === 'seg-3'), false);
  const again = applyPlan(out, next, { rewriteMade: true });
  assert.deepEqual(again.items.map(i => [i.id, i.revision]), out.items.map(i => [i.id, i.revision]));
});

test('the suggestion sets up the music bed style when there is no track or own text yet', () => {
  const plan = { ...good(), music: 'slow warm piano and strings, no vocals' };
  const c = checkPlan({ ...good(), music: { style: '  slow warm piano and strings, no vocals ' } }, base(), limits);
  assert.equal(c.plan!.music, 'slow warm piano and strings, no vocals');
  assert.match(plannerRequest(base(), limits, 'suggest').system, /"music.style" describes an instrumental music bed/);
  assert.doesNotMatch(plannerRequest(base(), limits, 'write').system, /music/);
  const out = applyPlan(base(), plan);
  assert.equal(out.items.find(i => i.kind === 'music')!.text, 'slow warm piano and strings, no vocals');
  assert.equal(planDiff(base(), plan).music, 'set');
  // Own text or a chosen track wins.
  const own = { ...out, items: out.items.map(i => i.kind === 'music' ? { ...i, text: 'my text' } : i) };
  assert.equal(applyPlan(own, { ...plan, music: 'other' }).items.find(i => i.kind === 'music')!.text, 'my text');
  assert.equal(planDiff(own, plan).music, 'kept');
  assert.match(checkPlan({ ...good(), music: { style: 5 } }, base(), limits).warnings[0], /music.style/);
});

test('a locked story keeps its text and new scenes get fresh ids before the film', () => {
  let m = applyPlan(base(), good());
  m = setLocked(m, 'story', true);
  const p = good(); p.lore = 'Rewritten'; p.segments.push({ title: 'End', prompt: 'Fade', seconds: 5, continuous: false, dialogue: [] });
  const out = applyPlan(m, p);
  assert.equal(out.items.find(i => i.id === 'story')!.text, 'A chase at dusk.');
  assert.deepEqual(out.items.map(i => i.id).slice(-2), ['seg-4', 'final']);
  assert.equal(manifestProblem(out), undefined);
  assert.equal(planDiff(m, p).story, 'locked');
});

test('segment limits come from family data and H3 actual durations follow the frame grids', async () => {
  const { segmentLimits, h3ActualSeconds } = await import('../src/lib/movieStory.ts');
  assert.deepEqual(segmentLimits('minimax-h3'), { min: 2, max: 15, step: 0.5, overlap: 0, unverified: true });
  assert.equal(segmentLimits('sdxl'), undefined);
  assert.equal(h3ActualSeconds(5, false), 124 / 24);
  assert.equal(h3ActualSeconds(15, false), 362 / 24);
  assert.equal(h3ActualSeconds(5, true), 119 / 24);
  assert.equal(h3ActualSeconds(0.1, true), 17 / 24);
});

test('media pool: the suggestion places pool media into scenes as references or frames; notes travel, files never do', async () => {
  const { addMedia, setMediaNote } = await import('../src/lib/movieManifest.ts');
  let m = addMedia(base(), [{ path: '/p/anna.png', media: 'image' }, { path: '/p/door.png', media: 'image' }, { path: '/p/rain.wav', media: 'audio' }, { path: '/p/anna.png', media: 'image' }]);
  m = setMediaNote(m, '/p/anna.png', 'Anna, red coat');
  assert.equal(m.media!.length, 3);
  const r = plannerRequest(m, limits, 'suggest');
  assert.match(r.user, /Media:\nm1\. picture — Anna, red coat\nm2\. picture \(no description\)\nm3\. sound \(no description\)/);
  assert.match(r.system, /Every listed medium must appear in "inputs"/);
  assert.doesNotMatch(r.user + r.system, /anna\.png|door\.png|rain\.wav/);
  assert.equal(r.disclosure.inputsNotSent, 3);
  const answer = { lore: 'L', segments: [
    { title: 'A', prompt: 'Anna walks in the rain', seconds: 5, continuous: false, inputs: [{ media: 'm1', role: 'reference' }, { media: 'm3', role: 'first' }] },
    { title: 'B', prompt: 'The door opens', seconds: 5, continuous: false, inputs: [{ media: 'm2', role: 'first' }] },
  ] };
  const c = checkPlan(answer, m, limits);
  assert.deepEqual(c.errors, []);
  assert.match(c.warnings.join(' '), /m3 is not a picture/);
  const out = applyPlan(m, c.plan!);
  assert.equal(manifestProblem(out), undefined);
  const by = (id: string) => out.items.find(i => i.id === id)!;
  assert.deepEqual(by('seg-1').inputs!.refs!.map(x => [x.path, x.description]), [['/p/anna.png', 'Anna, red coat'], ['/p/rain.wav', undefined]]);
  assert.deepEqual(by('seg-2').inputs, { first: { path: '/p/door.png', media: 'image' } });
  // Unknown media ids are errors; media placed nowhere is a warning; references win over frames in one scene.
  assert.match(checkPlan({ lore: 'L', segments: [{ ...answer.segments[0], inputs: [{ media: 'm9', role: 'reference' }] }] }, m, limits).errors[0], /unknown medium m9/);
  assert.match(checkPlan({ lore: 'L', segments: [answer.segments[1]] }, m, limits).warnings.join(' '), /Not placed in any scene: m1, m3/);
  const mixed = checkPlan({ lore: 'L', segments: [{ ...answer.segments[0], inputs: [{ media: 'm1', role: 'reference' }, { media: 'm2', role: 'last' }] }] }, m, limits);
  assert.deepEqual(mixed.plan!.segments[0].inputs, [{ media: 0, role: 'reference' }, { media: 1, role: 'reference' }, { media: 2, role: 'reference' }]); // m3 left out by the plan: DEAS adds it
  // A scene that already has inputs keeps them.
  const kept = applyPlan(applyPlan(m, c.plan!), { ...c.plan!, segments: c.plan!.segments.map(x => ({ ...x, inputs: [{ media: 1, role: 'reference' as const }] })) });
  assert.deepEqual(kept.items.find(i => i.id === 'seg-2')!.inputs, { first: { path: '/p/door.png', media: 'image' } });
});

test('media the model did not place are placed by DEAS as references in every scene without frames, within H3 counts', async () => {
  const { addMedia } = await import('../src/lib/movieManifest.ts');
  const m = addMedia(base(), [{ path: '/p/anna.png', media: 'image' }, { path: '/p/rain.wav', media: 'audio' }]);
  // The model ignored the media completely: before the fix every scene became text-to-video.
  const c = checkPlan({ lore: 'L', segments: [{ title: 'A', prompt: 'Anna walks', seconds: 5, continuous: false }, { title: 'B', prompt: 'Anna stops', seconds: 5, continuous: false }] }, m, limits);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.plan!.segments.map(s => s.inputs), [[{ media: 0, role: 'reference' }, { media: 1, role: 'reference' }], [{ media: 0, role: 'reference' }, { media: 1, role: 'reference' }]]);
  assert.match(c.warnings.join(' '), /did not say where m1, m2 belong; DEAS put them into every scene/);
  const out = applyPlan(m, c.plan!);
  assert.deepEqual(out.items.filter(i => i.kind === 'segment').map(i => i.inputs?.refs?.map(r => r.path)), [['/p/anna.png', '/p/rain.wav'], ['/p/anna.png', '/p/rain.wav']]);
  // A scene the plan gave frames is left alone; H3 counts are respected (at most 3 sounds).
  const framed = checkPlan({ lore: 'L', segments: [{ title: 'A', prompt: 'x', seconds: 5, continuous: false, inputs: [{ media: 'm1', role: 'first' }] }] }, m, limits);
  assert.deepEqual(framed.plan!.segments[0].inputs, [{ media: 0, role: 'first' }]);
  assert.match(framed.warnings.join(' '), /Not placed in any scene: m2/);
  const sounds = addMedia(base(), Array.from({ length: 4 }, (_, i) => ({ path: `/p/${i}.wav`, media: 'audio' as const })));
  const capped = checkPlan({ lore: 'L', segments: [{ title: 'A', prompt: 'x', seconds: 5, continuous: false }] }, sounds, limits);
  assert.equal(capped.plan!.segments[0].inputs!.length, 3);
});

test('media the user placed are binding: the request says so, the plan cannot move them and the fallback leaves them', async () => {
  const { addMedia, assignMedia, addScene } = await import('../src/lib/movieManifest.ts');
  let m = addScene(addScene(addMedia(base(), [{ path: '/p/anna.png', media: 'image' }, { path: '/p/rain.wav', media: 'audio' }]), 5), 5);
  m = assignMedia(m, '/p/anna.png', ['seg-2'], 'reference').movie;
  assert.match(plannerRequest(m, limits, 'suggest').user, /m1\. picture \(no description\) \(already placed by the user in scene 2; keep it there, do not place it\)/);
  const c = checkPlan({ lore: 'L', segments: [{ title: 'A', prompt: 'x', seconds: 5, continuous: false, inputs: [{ media: 'm1', role: 'reference' }] }, { title: 'B', prompt: 'y', seconds: 5, continuous: false }] }, m, limits);
  assert.match(c.warnings.join(' '), /m1 is placed by you; the plan's placement is ignored/);
  assert.deepEqual(c.plan!.segments.map(s => s.inputs), [[{ media: 1, role: 'reference' }], [{ media: 1, role: 'reference' }]], 'only the Auto sound is placed by the fallback');
  const out = applyPlan(m, c.plan!);
  assert.deepEqual(out.items.filter(i => i.kind === 'segment').map(i => i.inputs?.refs?.map(r => r.path)), [['/p/rain.wav'], ['/p/anna.png', '/p/rain.wav']], 'the user\'s picture stays in scene 2, the sound joins it');
});

import { applyMusic, musicDiff, musicRequest, parseMusicAnswer, planRows } from '../src/lib/movieStory.ts';
import { newItem, type MovieItem } from '../src/lib/movieManifest.ts';
/** The movie with a music item carrying these settings. */
const withMusic = (m: MovieManifest, music: Partial<MovieItem>): MovieManifest => ({ ...m, items: [...m.items, { ...newItem('music', 'music', 'Music', ['brief']), ...music }] });

test('the planner asks for an instrumental bed with a tempo; lyrics only when the movie asks for a song, and a chosen style is kept', () => {
  let r = plannerRequest(base(), limits);
  assert.match(r.system, /"music"\?: \{"style": string, "bpm"\?: number\}/);
  assert.match(r.system, /instrumental music bed/);
  assert.doesNotMatch(r.system, /"lyrics"/);
  r = plannerRequest(withMusic(base(), { text: 'noir jazz, instrumental', vocals: true, language: 'de' }), limits);
  assert.match(r.system, /"lyrics": string/);
  assert.match(r.system, /short song lyrics in German with section tags/);
  assert.match(r.system, /The music style is chosen by the user: "noir jazz, instrumental"\. Repeat it unchanged in "music.style" and write the lyrics for it\./);
  // Lyrics in an answer are only taken when they were asked for; a tempo out of ACE-Step's range is a warning.
  const answer = { ...good(), music: { style: 'synthwave', bpm: 112.4, lyrics: '[Verse]\nNeon rain' } };
  const sung = checkPlan(answer, withMusic(base(), { vocals: true }), limits);
  assert.deepEqual([sung.plan?.music, sung.plan?.musicBpm, sung.plan?.musicLyrics], ['synthwave', 112, '[Verse]\nNeon rain']);
  const plain = checkPlan(answer, base(), limits);
  assert.deepEqual([plain.plan?.music, plain.plan?.musicLyrics], ['synthwave', undefined]);
  const fast = checkPlan({ ...good(), music: { style: 'x', bpm: 900 } }, base(), limits);
  assert.ok(fast.plan && fast.plan.musicBpm === undefined && fast.warnings.some(w => /music.bpm/.test(w)));
});

test('applying a plan fills only empty music fields: style, tempo and (for a song) lyrics; the user\'s own stay', () => {
  const plan = { ...good(), music: 'synthwave', musicBpm: 110, musicLyrics: '[Chorus]\nRun' };
  let m = applyPlan(withMusic(base(), { vocals: true }), plan);
  let mu = m.items.find(i => i.kind === 'music')!;
  assert.deepEqual([mu.text, mu.bpm, mu.lyrics], ['synthwave', 110, '[Chorus]\nRun']);
  assert.equal(manifestProblem(m), undefined);
  m = applyPlan(withMusic(base(), { text: 'my style', bpm: 70, lyrics: 'my words', vocals: true, preset: 'ambient' }), plan);
  mu = m.items.find(i => i.kind === 'music')!;
  assert.deepEqual([mu.text, mu.bpm, mu.lyrics, mu.preset], ['my style', 70, 'my words', 'ambient']);
  // Without a music item the plan creates it with the style as its first revision (as before).
  m = applyPlan(base(), plan);
  mu = m.items.find(i => i.kind === 'music')!;
  assert.deepEqual([mu.text, mu.bpm, mu.lyrics, mu.revision], ['synthwave', 110, undefined, 1]);
});

test('the proposal lists every scene with its status, the scene it replaces, removed and kept scenes', () => {
  let m = applyPlan(base(), good());
  m = completeItem(m, 'seg-1', { outputId: '/o/1.mp4' });
  const next: StoryPlan = { lore: 'new lore', segments: [
    { title: 'Start again', prompt: 'other', seconds: 10, continuous: false, dialogue: [] },
    { title: 'Alley', prompt: 'Tracking shot, Ben hides', seconds: 10, continuous: true, dialogue: [] },
  ] };
  const rows = planRows(m, next);
  assert.deepEqual(rows.rows.map(r => [r.n, r.status, r.id]), [[1, 'kept', 'seg-1'], [2, 'same', 'seg-2']]);
  assert.equal(rows.rows[0].current?.title, 'Start');
  assert.deepEqual(rows.removed.map(x => x.id), ['seg-3']);
  const rewrite = planRows(m, next, { rewriteMade: true });
  assert.deepEqual(rewrite.rows.map(r => r.status), ['changed', 'same']);
  assert.equal(rewrite.rows[0].current?.text, 'Wide shot, Anna (tall, red coat) runs');
  const more = planRows(m, { ...next, segments: [...next.segments, { title: 'Z', prompt: 'z', seconds: 5, continuous: false, dialogue: [] }, { title: 'Y', prompt: 'y', seconds: 5, continuous: false, dialogue: [] }] });
  assert.deepEqual(more.rows.map(r => r.status), ['kept', 'same', 'changed', 'new']);
});

test('the music-only request sends the story and scenes, never media; its answer fills empty fields unless replace', () => {
  const m = withMusic(applyPlan(base(), good()), { vocals: true, lyrics: 'mine' });
  const r = musicRequest(m);
  assert.match(r.system, /film composer/);
  assert.match(r.user, /Story:\nAnna chases Ben\./);
  assert.match(r.user, /Scenes:\n1\. 10s — Wide shot/);
  assert.match(r.user, /Story bible:\nA chase at dusk\./);
  const check = parseMusicAnswer('```json\n{"music": {"style": "dark synth", "bpm": 96, "lyrics": "[Verse] new"}}\n```', m);
  assert.deepEqual(check.music, { music: 'dark synth', musicBpm: 96, musicLyrics: '[Verse] new' });
  assert.deepEqual(musicDiff(m, check.music!), { style: 'set', lyrics: 'kept', bpm: 'set' });
  const kept = applyMusic(m, check.music!).items.find(i => i.kind === 'music')!;
  assert.deepEqual([kept.text, kept.lyrics, kept.bpm], ['dark synth', 'mine', 96]);
  const replaced = applyMusic(m, check.music!, true).items.find(i => i.kind === 'music')!;
  assert.equal(replaced.lyrics, '[Verse] new');
  assert.deepEqual(parseMusicAnswer('{"music": {}}', m).errors[0], 'The answer has no usable music.');
  assert.match(parseMusicAnswer('nope', m).errors[0], /no JSON object/);
});
