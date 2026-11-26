/**
 * Movie Maker story planning (UX-22d3, no endpoint call): the prompt that asks a Prompt Forge LLM for a structured plan, the strict
 * parser/validator of what comes back, a diff the user approves, and the application of an approved plan to the manifest. Locked and
 * manual content is never overwritten, every change is a revision, and stale/rerun bookkeeping reuses the manifest core. Nothing here
 * sends anything: `plannerRequest` only builds the text and states what it contains so the caller can disclose the transfer first.
 */
import { MOVIE_LIMITS, newItem, planSegments, reviseItem, downstream, type MovieDialogue, type MovieItem, type MovieManifest, type SegmentLimits } from './movieManifest.ts';

export interface PlannedSegment { title: string; prompt: string; seconds: number; castIds: string[]; continuous: boolean; entry?: string; exit?: string; dialogue: MovieDialogue[] }
export interface StoryPlan { lore: string; segments: PlannedSegment[] }
export interface PlanCheck { plan?: StoryPlan; errors: string[]; warnings: string[] }

const SEGMENT_MAX = 60;
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();

/** The request for the planner and a plain statement of what it contains (reference pictures are never part of it). */
export function plannerRequest(m: MovieManifest, limits: SegmentLimits): { system: string; user: string; disclosure: { castEntries: number; storyCharacters: number; referencePicturesNotSent: number } } {
  const cast = m.items.filter(i => i.kind === 'cast');
  const brief = m.items.find(i => i.id === 'brief');
  const layout = planSegments(m.targetSeconds, limits);
  const hint = layout.ok ? `A layout that delivers exactly ${m.targetSeconds}s: ${layout.seconds.join(', ')} seconds.` : layout.reason;
  const system = [
    'You are a film planner. Answer with one JSON object only, no prose and no code fence.',
    'Schema: {"lore": string, "segments": [{"title": string, "prompt": string, "seconds": number, "castIds": string[], "continuous": boolean, "entry"?: string, "exit"?: string, "dialogue"?: [{"castId": string, "line": string, "delivery"?: string}]}]}.',
    '"lore" is the shared story bible (setting, chronology, tone). Each segment is one shot: "prompt" describes camera and action, "continuous" is true only when the shot continues the previous one without a cut (the first segment is never continuous).',
    '"castIds" and "dialogue.castId" must be ids from the cast list; dialogue only for entries of kind actor. Use "entry"/"exit" for what the scene looks like when the shot starts/ends.',
    `Each segment is ${limits.min}-${limits.max} seconds; delivered length = sum of seconds minus ${limits.overlap ?? 0}s for every continuous segment, and must equal ${m.targetSeconds}s. ${hint}`,
  ].join('\n');
  const user = [
    `Title: ${m.title}`, `Aspect: ${m.aspect}`, `Target length: ${m.targetSeconds}s`, '', 'Story:', brief?.text ?? '', '', 'Cast:',
    ...cast.map(c => `- id=${c.id} kind=${c.role ?? 'actor'} name=${c.title}${c.text ? ` — ${c.text}` : ''}`),
  ].join('\n');
  return { system, user, disclosure: { castEntries: cast.length, storyCharacters: (brief?.text ?? '').length, referencePicturesNotSent: cast.reduce((n, c) => n + (c.refs?.length ?? 0), 0) } };
}

/** Pulls the JSON object out of an answer (a fenced block or surrounding prose is tolerated, several objects are not). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The answer holds no JSON object.');
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new Error('The answer is not valid JSON.'); }
}

/** Strict validation against the manifest's cast and the model's segment limits. Errors block applying; warnings (length) do not. */
export function checkPlan(raw: unknown, m: MovieManifest, limits: SegmentLimits): PlanCheck {
  const errors: string[] = [], warnings: string[] = [];
  const o = raw as { lore?: unknown; segments?: unknown } | null;
  if (!o || typeof o !== 'object') return { errors: ['The plan is not an object.'], warnings };
  if (typeof o.lore !== 'string' || o.lore.length > MOVIE_LIMITS.text) errors.push('"lore" must be text.');
  if (!Array.isArray(o.segments) || !o.segments.length) return { errors: [...errors, '"segments" must be a non-empty list.'], warnings };
  if (o.segments.length > SEGMENT_MAX) return { errors: [...errors, `At most ${SEGMENT_MAX} segments are supported.`], warnings };
  const cast = new Map(m.items.filter(i => i.kind === 'cast').map(i => [i.id, i]));
  const step = limits.step ?? 0.1, eps = 1e-9;
  const segments: PlannedSegment[] = [];
  o.segments.forEach((s: Record<string, unknown>, n) => {
    const at = `Segment ${n + 1}`;
    if (!s || typeof s !== 'object') { errors.push(`${at} is not an object.`); return; }
    const str = (k: string, max: number, required: boolean) => {
      const v = s[k];
      if (v === undefined && !required) return undefined;
      if (typeof v !== 'string' || (required && !clean(v)) || v.length > max) { errors.push(`${at}: "${k}" must be text up to ${max} characters.`); return undefined; }
      return clean(v);
    };
    const title = str('title', 200, true), prompt = str('prompt', 4000, true), entry = str('entry', 2000, false), exit = str('exit', 2000, false);
    const seconds = s.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) errors.push(`${at}: "seconds" must be a number.`);
    else {
      if (seconds < limits.min - eps || seconds > limits.max + eps) errors.push(`${at}: ${seconds}s is outside ${limits.min}–${limits.max}s.`);
      if (Math.abs(Math.round(seconds / step) * step - seconds) > step * 1e-6) errors.push(`${at}: ${seconds}s is not a multiple of ${step}s.`);
    }
    const castIds = Array.isArray(s.castIds) ? s.castIds : [];
    if (!Array.isArray(s.castIds) || castIds.some(c => typeof c !== 'string' || !cast.has(c)) || new Set(castIds).size !== castIds.length) errors.push(`${at}: "castIds" must list known, distinct cast ids.`);
    if (typeof s.continuous !== 'boolean') errors.push(`${at}: "continuous" must be true or false.`);
    else if (s.continuous && n === 0) errors.push('Segment 1 cannot continue a previous shot.');
    const dialogue: MovieDialogue[] = [];
    if (s.dialogue !== undefined) {
      if (!Array.isArray(s.dialogue) || s.dialogue.length > MOVIE_LIMITS.dialogue) errors.push(`${at}: "dialogue" must be a list of at most ${MOVIE_LIMITS.dialogue} lines.`);
      else for (const d of s.dialogue as Record<string, unknown>[]) {
        const who = typeof d?.castId === 'string' ? cast.get(d.castId) : undefined;
        if (!who) errors.push(`${at}: dialogue names an unknown cast id.`);
        else if ((who.role ?? 'actor') !== 'actor') errors.push(`${at}: ${who.title} is not an actor and cannot speak.`);
        else if (typeof d.line !== 'string' || !clean(d.line) || d.line.length > 1000) errors.push(`${at}: a dialogue line must be 1–1000 characters.`);
        else if (d.delivery !== undefined && (typeof d.delivery !== 'string' || d.delivery.length > 200)) errors.push(`${at}: "delivery" must be text up to 200 characters.`);
        else {
          if (!castIds.includes(who.id)) warnings.push(`${at}: ${who.title} speaks but is not listed in "castIds".`);
          dialogue.push({ castId: who.id, line: clean(d.line), ...(d.delivery ? { delivery: clean(d.delivery as string) } : {}) });
        }
      }
    }
    if (title && prompt && typeof seconds === 'number' && typeof s.continuous === 'boolean')
      segments.push({ title, prompt, seconds, castIds: castIds as string[], continuous: s.continuous, ...(entry ? { entry } : {}), ...(exit ? { exit } : {}), dialogue });
  });
  if (errors.length) return { errors, warnings };
  const q = (x: number) => Math.round(x / step), ov = q(limits.overlap ?? 0);
  const delivered = segments.reduce((a, s) => a + q(s.seconds) - (s.continuous ? ov : 0), 0) * step;
  if (Math.abs(delivered - m.targetSeconds) > step * 0.5) {
    const alt = planSegments(m.targetSeconds, limits);
    warnings.push(`The plan delivers ${Math.round(delivered * 1e6) / 1e6}s, not the requested ${m.targetSeconds}s. ${alt.ok ? `An exact layout would be ${alt.seconds.join(', ')} seconds.` : alt.reason}`);
  }
  return { plan: { lore: clean(o.lore as string), segments }, errors, warnings };
}
/** Text + JSON in one step; throws the extraction error, returns the check otherwise. */
export const parsePlannerAnswer = (answer: string, m: MovieManifest, limits: SegmentLimits): PlanCheck => {
  try { return checkPlan(extractJson(answer), m, limits); } catch (e) { return { errors: [e instanceof Error ? e.message : String(e)], warnings: [] }; }
};

const segs = (m: MovieManifest) => m.items.filter(i => i.kind === 'segment');
const segmentPatch = (s: PlannedSegment, storyId: string) => ({
  title: s.title, text: s.prompt, seconds: s.seconds, continuous: s.continuous, deps: [storyId, ...s.castIds],
  dialogue: s.dialogue, entry: s.entry ?? '', exit: s.exit ?? '',
});
export interface PlanDiff { story: 'new' | 'changed' | 'same' | 'locked'; added: number; changed: string[]; unchanged: string[]; lockedKept: string[]; removed: string[]; staleAfter: string[] }
/** What applying the plan would do, for approval before anything is touched. Segments pair with existing ones by position. */
export function planDiff(m: MovieManifest, plan: StoryPlan): PlanDiff {
  const story = m.items.find(i => i.kind === 'story');
  const old = segs(m);
  const out: PlanDiff = { story: !story ? 'new' : story.locked ? 'locked' : story.text === plan.lore ? 'same' : 'changed', added: 0, changed: [], unchanged: [], lockedKept: [], removed: [], staleAfter: [] };
  plan.segments.forEach((s, n) => {
    const cur = old[n];
    if (!cur) { out.added++; return; }
    if (cur.locked) { out.lockedKept.push(cur.id); return; }
    const p = segmentPatch(s, story?.id ?? 'story');
    const same = (Object.keys(p) as (keyof typeof p)[]).every(k => JSON.stringify(p[k]) === JSON.stringify(cur[k] ?? (k === 'entry' || k === 'exit' ? '' : undefined)));
    (same ? out.unchanged : out.changed).push(cur.id);
  });
  for (const cur of old.slice(plan.segments.length)) (cur.locked ? out.lockedKept : out.removed).push(cur.id);
  const touched = new Set([...out.changed, ...out.removed]);
  const stale = new Set<string>();
  for (const id of touched) for (const d of downstream(m, id)) if (!touched.has(d)) stale.add(d);
  out.staleAfter = [...stale].filter(id => m.items.find(i => i.id === id)?.state === 'done');
  return out;
}

/**
 * Applies an approved plan: the story item carries the lore, segments take the plan's shots (positional pairing, locked segments and a
 * locked story are kept), surplus unlocked segments are removed, and the final assemble item depends on every segment. Changed items get a
 * new revision; everything built from them is marked stale. Throws before changing anything when a result would be invalid.
 */
export function applyPlan(m: MovieManifest, plan: StoryPlan): MovieManifest {
  const castIds = m.items.filter(i => i.kind === 'cast').map(i => i.id);
  let next = m;
  let story = next.items.find(i => i.kind === 'story');
  if (!story) {
    next = { ...next, items: [...next.items, newItem('story', 'story', 'Story', ['brief', ...castIds], plan.lore)] };
    story = next.items.find(i => i.kind === 'story')!;
  } else if (!story.locked) next = reviseItem(next, story.id, { text: plan.lore, deps: ['brief', ...castIds] });
  const storyId = story.id;
  const old = segs(next);
  const used = new Set(next.items.map(i => i.id));
  const ids: string[] = [];
  plan.segments.forEach((s, n) => {
    const cur = old[n];
    if (cur) {
      ids.push(cur.id);
      if (!cur.locked) next = reviseItem(next, cur.id, segmentPatch(s, storyId));
      return;
    }
    let k = n + 1; while (used.has(`seg-${k}`)) k++;
    const id = `seg-${k}`; used.add(id); ids.push(id);
    const p = segmentPatch(s, storyId);
    next = { ...next, items: [...next.items, newItem(id, 'segment', p.title, p.deps, p.text, { seconds: p.seconds, continuous: p.continuous })] };
    next = { ...next, items: next.items.map(i => i.id === id ? { ...i, dialogue: p.dialogue, entry: p.entry, exit: p.exit } : i) };
  });
  const surplus = new Set(old.slice(plan.segments.length).filter(i => !i.locked).map(i => i.id));
  if (surplus.size) {
    const stale = new Set([...surplus].flatMap(id => downstream(next, id)));
    next = { ...next, items: next.items.filter(i => !surplus.has(i.id)).map(i => ({ ...i, deps: i.deps.filter(d => !surplus.has(d)), ...(stale.has(i.id) && i.state === 'done' ? { state: 'stale' as const } : {}) })) };
  }
  const all = segs(next).map(i => i.id);
  const final = next.items.find(i => i.kind === 'assemble');
  if (!final) next = { ...next, items: [...next.items, newItem('final', 'assemble', 'Film', all)] };
  else next = reviseItem(next, final.id, { deps: all }, true);
  return next;
}
export type { MovieItem };

// --- family data and actual durations ---------------------------------------------------------------------------------------------
import families from '../families/builtin.json' with { type: 'json' };

/** Movie Maker's segment limits for a video family, from family data (`video.segment`); undefined when the family declares none. `unverified` is carried through so the UI can say so. */
export function segmentLimits(familyId: string): (SegmentLimits & { unverified: boolean }) | undefined {
  const seg = (families as { id: string; video?: { segment?: { min: number; max: number; step?: number; overlap?: number; unverified?: boolean } } }[]).find(f => f.id === familyId)?.video?.segment;
  return seg ? { min: seg.min, max: seg.max, step: seg.step, overlap: seg.overlap, unverified: seg.unverified !== false } : undefined;
}
/**
 * Seconds MiniMax H3 will actually produce for a requested length (24 fps): a new take snaps up to 17k+5 frames
 * (`videoIntent.ts::videoFrames`), a continued segment's newly visible part to whole 17-frame steps
 * (`jobs_video.rs::continuation_extension`). The plan shows these instead of the requested seconds.
 */
export function h3ActualSeconds(seconds: number, continuous: boolean): number {
  const frames = continuous
    ? Math.max(1, Math.floor(seconds * 24 / 17 + 0.5)) * 17
    : (() => { const n = Math.max(5, Math.round(seconds * 24)); return n + (((5 - (n % 17)) % 17) + 17) % 17; })();
  return frames / 24;
}
