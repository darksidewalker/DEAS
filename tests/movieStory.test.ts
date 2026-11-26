import test from 'node:test';
import assert from 'node:assert/strict';
import { addCast, completeItem, manifestProblem, newMovie, setBrief, setLocked, type MovieManifest, type SegmentLimits } from '../src/lib/movieManifest.ts';
import { applyPlan, checkPlan, extractJson, parsePlannerAnswer, planDiff, plannerRequest, type StoryPlan } from '../src/lib/movieStory.ts';

const limits: SegmentLimits = { min: 5, max: 15, overlap: 1 };
const base = (): MovieManifest => {
  let m = setBrief(newMovie('m1', 'Chase', 28, '16:9'), { story: 'Anna chases Ben.' });
  m = addCast(m, 'actor', 'Anna', 'tall'); m = addCast(m, 'actor', 'Ben'); m = addCast(m, 'location', 'Street');
  return setLocked(m, 'cast-3', false);
};
const good = (): StoryPlan => ({ lore: 'A chase at dusk.', segments: [
  { title: 'Start', prompt: 'Wide shot, Anna runs', seconds: 10, castIds: ['cast-1', 'cast-3'], continuous: false, entry: 'dusk', exit: 'alley', dialogue: [{ castId: 'cast-1', line: 'Stop!', delivery: 'shouted' }] },
  { title: 'Alley', prompt: 'Tracking shot, Ben hides', seconds: 10, castIds: ['cast-2'], continuous: true, dialogue: [] },
  { title: 'Catch', prompt: 'Close up', seconds: 10, castIds: ['cast-1', 'cast-2'], continuous: true, dialogue: [] },
] });

test('planner request lists the cast, the exact layout hint, and never sends reference pictures', () => {
  let m = base();
  m = { ...m, items: m.items.map(i => i.id === 'cast-1' ? { ...i, refs: ['/p/a.png', '/p/b.png'] } : i) };
  const r = plannerRequest(m, limits);
  assert.match(r.user, /id=cast-1 kind=actor name=Anna — tall/);
  assert.match(r.user, /id=cast-3 kind=location name=Street/);
  assert.match(r.system, /exactly 28s: /);
  assert.doesNotMatch(r.user + r.system, /a\.png/);
  assert.deepEqual(r.disclosure, { castEntries: 3, storyCharacters: 16, referencePicturesNotSent: 2 });
});

test('JSON is pulled out of fenced or chatty answers, and garbage is refused', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```\nenjoy'), { a: 1 });
  assert.deepEqual(extractJson('{"a":2}'), { a: 2 });
  assert.throws(() => extractJson('no json'), /no JSON/);
  assert.throws(() => extractJson('{"a":'), /no JSON|not valid/);
  assert.deepEqual(parsePlannerAnswer('{', base(), limits).errors.length, 1);
});

test('a valid plan passes with the exact delivered length; unattainable or off-length plans warn', () => {
  const m = base();
  const ok = checkPlan(good(), m, limits);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.plan!.segments.length, 3);
  const short = good(); short.segments[2].seconds = 5;
  const c = checkPlan(short, m, limits);
  assert.deepEqual(c.errors, []);
  assert.match(c.warnings[0], /delivers 23s, not the requested 28s/);
  assert.match(c.warnings[0], /exact layout/);
});

test('invalid plans are rejected with specific errors', () => {
  const m = base();
  const bad = (f: (p: StoryPlan) => void) => { const p = good(); f(p); return checkPlan(p, m, limits).errors.join(' | '); };
  assert.match(bad(p => { p.segments[0].castIds = ['ghost']; }), /known, distinct cast ids/);
  assert.match(bad(p => { p.segments[1].seconds = 30; }), /outside 5–15s/);
  assert.match(bad(p => { p.segments[1].seconds = 7.25; }), /multiple of 0.1s/);
  assert.match(bad(p => { p.segments[0].continuous = true; }), /Segment 1 cannot continue/);
  assert.match(bad(p => { p.segments[0].dialogue = [{ castId: 'cast-3', line: 'hi' }]; }), /not an actor/);
  assert.match(bad(p => { p.segments[0].dialogue = [{ castId: 'zzz', line: 'hi' }]; }), /unknown cast id/);
  assert.match(bad(p => { p.segments[0].prompt = ' '; }), /"prompt" must be text/);
  assert.match(bad(p => { (p as any).lore = 5; }), /"lore"/);
  assert.match(checkPlan({ lore: '', segments: [] }, m, limits).errors[0], /non-empty/);
  assert.match(checkPlan(null, m, limits).errors[0], /not an object/);
  const w = good(); w.segments[1].dialogue = [{ castId: 'cast-1', line: 'x' }];
  assert.match(checkPlan(w, m, limits).warnings[0], /not listed in "castIds"/);
});

test('applying a plan builds story, segments and the assemble item and stays a valid manifest', () => {
  const m = applyPlan(base(), good());
  assert.equal(manifestProblem(m), undefined);
  assert.deepEqual(m.items.map(i => i.id), ['brief', 'cast-1', 'cast-2', 'cast-3', 'story', 'seg-1', 'seg-2', 'seg-3', 'final']);
  const s1 = m.items.find(i => i.id === 'seg-1')!;
  assert.deepEqual([s1.seconds, s1.continuous, s1.deps, s1.dialogue, s1.entry, s1.exit], [10, false, ['story', 'cast-1', 'cast-3'], [{ castId: 'cast-1', line: 'Stop!', delivery: 'shouted' }], 'dusk', 'alley']);
  assert.deepEqual(m.items.find(i => i.id === 'final')!.deps, ['seg-1', 'seg-2', 'seg-3']);
  assert.deepEqual(m.items.find(i => i.id === 'story')!.deps, ['brief', 'cast-1', 'cast-2', 'cast-3']);
});

test('re-applying keeps locked segments, revisions and old results, stales only what changed, and removes surplus', () => {
  let m = applyPlan(base(), good());
  for (const id of ['story', 'seg-1', 'seg-2', 'seg-3', 'final']) m = completeItem(m, id, { outputId: 'o-' + id });
  m = setLocked(m, 'seg-2', true);
  const next = good();
  next.segments[0].prompt = 'New wide shot';
  next.segments[1].prompt = 'IGNORED (locked)';
  next.segments.pop();
  const diff = planDiff(m, next);
  assert.deepEqual([diff.story, diff.changed, diff.unchanged, diff.lockedKept, diff.removed], ['same', ['seg-1'], [], ['seg-2'], ['seg-3']]);
  const out = applyPlan(m, next);
  assert.equal(manifestProblem(out), undefined);
  const by = (id: string) => out.items.find(i => i.id === id)!;
  assert.equal(by('seg-1').text, 'New wide shot');
  assert.equal(by('seg-1').revision, 2);
  assert.equal(by('seg-1').revisions[0].result?.outputId, 'o-seg-1');
  assert.equal(by('seg-2').text, 'Tracking shot, Ben hides');
  assert.equal(by('seg-2').revision, 1);
  assert.equal(out.items.some(i => i.id === 'seg-3'), false);
  assert.deepEqual(by('final').deps, ['seg-1', 'seg-2']);
  assert.equal(by('final').state, 'stale');
  // Same plan again: nothing changes at all.
  const again = applyPlan(out, next);
  assert.deepEqual(again.items.map(i => [i.id, i.revision]), out.items.map(i => [i.id, i.revision]));
});

test('a locked story keeps its text and new segments get fresh ids', () => {
  let m = applyPlan(base(), good());
  m = setLocked(m, 'story', true);
  const p = good(); p.lore = 'Rewritten'; p.segments.push({ title: 'End', prompt: 'Fade', seconds: 5, castIds: [], continuous: false, dialogue: [] });
  const out = applyPlan(m, p);
  assert.equal(out.items.find(i => i.id === 'story')!.text, 'A chase at dusk.');
  assert.equal(out.items.filter(i => i.kind === 'segment').length, 4);
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
