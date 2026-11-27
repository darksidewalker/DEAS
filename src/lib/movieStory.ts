/**
 * Movie Maker story planning (UX-22d3, no endpoint call): the prompt that asks a Prompt Forge LLM for a structured plan, the strict
 * parser/validator of what comes back, a diff the user approves, and the application of an approved plan to the manifest. Locked and
 * manual content is never overwritten, every change is a revision, and stale/rerun bookkeeping reuses the manifest core. Nothing here
 * sends anything: `plannerRequest` only builds the text and states what it contains so the caller can disclose the transfer first.
 */
import { MOVIE_LIMITS, MUSIC_TEXT_LIMITS, newItem, reviseItem, downstream, sceneFiles, scenesUsing, type MovieDialogue, type MovieItem, type MovieManifest, type SceneInputs, type SegmentLimits } from './movieManifest.ts';

/** Where the planner puts a pool file: index into `MovieManifest.media`, as a reference or a frame. */
export interface PlannedInput { media: number; role: 'reference' | 'first' | 'last' }
export interface PlannedSegment { title: string; prompt: string; seconds: number; continuous: boolean; entry?: string; exit?: string; dialogue: MovieDialogue[]; inputs?: PlannedInput[] }
/**
 * `music`: the style of the music bed fitting the film (suggest only); `musicLyrics` its sung words when the movie asks the planner for
 * lyrics, `musicBpm` its tempo. Length, model and mix stay DEAS' deterministic defaults.
 */
export interface StoryPlan { lore: string; segments: PlannedSegment[]; music?: string; musicLyrics?: string; musicBpm?: number }
export interface PlanCheck { plan?: StoryPlan; errors: string[]; warnings: string[] }
/** `suggest`: the planner proposes the scene list from the story (scenes with inputs are kept). `write`: it writes the user's scenes, keeping their number, lengths, continuity and inputs. */
export type PlanMode = 'suggest' | 'write';

const SEGMENT_MAX = 60;
/** MiniMax H3's reference counts, as Generate's References editor enforces them (`ReferencesPanel.tsx::over`): at most 12 items, 9 pictures, 3 clips, 3 sounds. */
export function withinH3References(kinds: readonly (string | undefined)[]): boolean {
  const n = (k: string) => kinds.filter(x => x === k).length;
  return kinds.length <= 12 && n('image') <= 9 && n('video') <= 3 && n('audio') <= 3;
}
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
const segs = (m: MovieManifest) => m.items.filter(i => i.kind === 'segment');
/** What the planner is told about a scene's inputs: kinds, roles, labels and the user's own notes — never a file or its name. */
function inputsLine(i: MovieItem): string {
  const v = i.inputs; if (!v) return 'no inputs';
  const parts: string[] = [];
  if (v.first) parts.push('first frame: a picture');
  if (v.last) parts.push('last frame: a picture');
  if (v.source) parts.push('source clip to follow');
  for (const r of v.refs ?? []) {
    const what = r.media === 'image' ? 'picture' : r.media === 'audio' || r.mediaMode === 'audio' ? 'sound' : 'clip';
    const note = [r.label, r.description, r.instructions].filter(Boolean).join(' — ');
    parts.push(`reference ${what}${note ? ` (${note})` : ''}`);
  }
  return parts.join('; ');
}

const musicItem = (m: MovieManifest) => m.items.find(i => i.kind === 'music');
/** Seconds the music has to fill: the planned scenes, else the movie's target. */
const filmSeconds = (m: MovieManifest) => Math.max(1, Math.ceil(segs(m).reduce((a, i) => a + (i.seconds ?? 0), 0) || m.targetSeconds));
const languageName = (code: string) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code; } catch { return code; } };
/** The music part of the schema: lyrics only when the movie asks the planner for them (the music item's *vocals*). */
export const musicSchema = (m: MovieManifest) => `{"style": string, "bpm"?: number${musicItem(m)?.vocals ? ', "lyrics": string' : ''}}`;
/** What the planner is told about the music: instrumental unless lyrics are asked for; a style the user chose is kept. */
export function musicInstructions(m: MovieManifest): string[] {
  const mu = musicItem(m), style = mu?.text.trim(), secs = filmSeconds(m);
  const lines = mu?.vocals
    ? [`"music" is a song that fits the whole film (about ${secs} s): "style" names genre, mood, instruments, tempo, the vocal type and the sung language as comma-separated tags; "lyrics" are short song lyrics in ${languageName(mu.language ?? 'en')} with section tags like [Verse] and [Chorus], sized for about ${secs} s; "bpm" is the tempo as a whole number.`]
    : ['"music.style" describes an instrumental music bed that fits the whole film: genre, mood, instruments and tempo as comma-separated tags, no lyrics, no vocals. "music.bpm" is its tempo as a whole number.'];
  if (style) lines.push(`The music style is chosen by the user: "${style.slice(0, 600)}". Repeat it unchanged in "music.style"${mu?.vocals ? ' and write the lyrics for it' : ''}.`);
  return lines;
}
/** The request for the planner and a plain statement of what it contains (input files are never part of it). */
export function plannerRequest(m: MovieManifest, limits: SegmentLimits, mode: PlanMode = 'suggest'): { system: string; user: string; disclosure: { scenes: number; storyCharacters: number; inputsNotSent: number } } {
  const brief = m.items.find(i => i.id === 'brief');
  const scenes = segs(m);
  const sceneSchema = mode === 'write'
    ? '{"title": string, "prompt": string, "entry"?: string, "exit"?: string, "dialogue"?: [{"speaker": string, "line": string, "delivery"?: string}]}'
    : '{"title": string, "prompt": string, "seconds": number, "continuous": boolean, "entry"?: string, "exit"?: string, "dialogue"?: [{"speaker": string, "line": string, "delivery"?: string}], "inputs"?: [{"media": string, "role": "reference" | "first" | "last"}]}';
  const pool = m.media ?? [];
  const system = [
    'You are a film planner. Answer with one JSON object only, no prose and no code fence.',
    `Schema: {"lore": string, "segments": [${sceneSchema}]${mode === 'suggest' ? `, "music"?: ${musicSchema(m)}` : ''}}.`,
    '"lore" is the shared story bible (setting, characters, chronology, tone). Each segment is one scene/shot. "prompt" describes what happens in the scene, which persons are in it (by name, with their look) and the camera. Name every speaker in "dialogue.speaker" exactly as the prompt names that person. Use "entry"/"exit" for what the scene looks like when it starts/ends.',
    mode === 'write'
      ? `Write exactly ${scenes.length} segments, one per given scene, in the given order. Do not change their number, lengths or continuity; use every input a scene lists.`
      : `"continuous" is true only when the scene continues the previous one without a cut (the first is never continuous). Each segment is ${limits.min}-${limits.max} seconds in steps of ${limits.step ?? 0.1}; the movie's length is the sum. Keep the given scenes that have inputs, in order, and use every input.${pool.length ? ' Every listed medium must appear in "inputs" of the scene(s) it belongs to (its id like "m1"; "reference" for people, places, objects, style, clips and sound; "first"/"last" only for a picture that is the exact opening/closing frame; a scene takes either references or frames, not both).' : ''}`,
    ...(mode === 'suggest' ? musicInstructions(m) : []),
  ].join('\n');
  const user = [
    `Title: ${m.title}`, `Aspect: ${m.aspect}`, '', 'Story:', brief?.text ?? '',
    ...(mode === 'suggest' && pool.length ? ['', 'Media:', ...pool.map((x, n) => { const used = scenesUsing(m, x.path).map(id => scenes.findIndex(sc => sc.id === id) + 1); return `m${n + 1}. ${x.media === 'image' ? 'picture' : x.media === 'video' ? 'clip' : 'sound'}${x.note?.trim() ? ` — ${x.note.trim()}` : ' (no description)'}${used.length ? ` (already placed by the user in scene ${used.join(', ')}; keep it there, do not place it)` : ''}`; })] : []),
    ...(scenes.length ? ['', 'Scenes:', ...scenes.map((i, n) => `${n + 1}. ${i.seconds ?? 0}s${n > 0 && i.continuous ? ', continues the previous scene' : ''} — ${i.text.trim() || i.title.trim() || '(no description yet)'} — inputs: ${inputsLine(i)}`)] : []),
  ].join('\n');
  return { system, user, disclosure: { scenes: scenes.length, storyCharacters: (brief?.text ?? '').length, inputsNotSent: scenes.reduce((n, i) => n + sceneFiles(i).length, 0) + pool.length } };
}

/** Pulls the JSON object out of an answer (a fenced block or surrounding prose is tolerated, several objects are not). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The answer holds no JSON object.');
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new Error('The answer is not valid JSON.'); }
}

/** Strict validation against the model's segment limits (and, when writing, the user's scenes). Errors block applying. */
export function checkPlan(raw: unknown, m: MovieManifest, limits: SegmentLimits, mode: PlanMode = 'suggest'): PlanCheck {
  const errors: string[] = [], warnings: string[] = [];
  const o = raw as { lore?: unknown; segments?: unknown } | null;
  if (!o || typeof o !== 'object') return { errors: ['The plan is not an object.'], warnings };
  if (typeof o.lore !== 'string' || o.lore.length > MOVIE_LIMITS.text) errors.push('"lore" must be text.');
  if (!Array.isArray(o.segments) || !o.segments.length) return { errors: [...errors, '"segments" must be a non-empty list.'], warnings };
  if (o.segments.length > SEGMENT_MAX) return { errors: [...errors, `At most ${SEGMENT_MAX} segments are supported.`], warnings };
  const scenes = segs(m);
  if (mode === 'write' && o.segments.length !== scenes.length) return { errors: [...errors, `The plan has ${o.segments.length} segments for ${scenes.length} scenes.`], warnings };
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
    // Writing keeps the user's lengths and continuity; suggesting validates the planner's.
    const seconds = mode === 'write' ? scenes[n].seconds ?? limits.min : s.seconds;
    const continuous = mode === 'write' ? !!scenes[n].continuous && n > 0 : s.continuous;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) errors.push(`${at}: "seconds" must be a number.`);
    else if (mode === 'suggest') {
      if (seconds < limits.min - eps || seconds > limits.max + eps) errors.push(`${at}: ${seconds}s is outside ${limits.min}–${limits.max}s.`);
      if (Math.abs(Math.round(seconds / step) * step - seconds) > step * 1e-6) errors.push(`${at}: ${seconds}s is not a multiple of ${step}s.`);
    }
    if (typeof continuous !== 'boolean') errors.push(`${at}: "continuous" must be true or false.`);
    else if (continuous && n === 0) errors.push('Segment 1 cannot continue a previous shot.');
    const dialogue: MovieDialogue[] = [];
    if (s.dialogue !== undefined) {
      if (!Array.isArray(s.dialogue) || s.dialogue.length > MOVIE_LIMITS.dialogue) errors.push(`${at}: "dialogue" must be a list of at most ${MOVIE_LIMITS.dialogue} lines.`);
      else for (const d of s.dialogue as Record<string, unknown>[]) {
        if (typeof d?.speaker !== 'string' || !clean(d.speaker) || d.speaker.length > 80) errors.push(`${at}: every dialogue line needs a speaker name up to 80 characters.`);
        else if (typeof d.line !== 'string' || !clean(d.line) || d.line.length > 1000) errors.push(`${at}: a dialogue line must be 1–1000 characters.`);
        else if (d.delivery !== undefined && (typeof d.delivery !== 'string' || d.delivery.length > 200)) errors.push(`${at}: "delivery" must be text up to 200 characters.`);
        else {
          if (prompt && !prompt.toLowerCase().includes(clean(d.speaker).toLowerCase())) warnings.push(`${at}: ${clean(d.speaker)} speaks but the prompt does not name them.`);
          dialogue.push({ speaker: clean(d.speaker), line: clean(d.line), ...(d.delivery ? { delivery: clean(d.delivery as string) } : {}) });
        }
      }
    }
    // Placement of pool media (suggest only): known ids and roles; frames only from pictures; references win over frames (H3 cannot mix them).
    const inputs: PlannedInput[] = [];
    const fixed = new Set((m.media ?? []).map((x, i) => scenesUsing(m, x.path).length ? i : -1).filter(i => i >= 0));
    if (mode === 'suggest' && s.inputs !== undefined) {
      if (!Array.isArray(s.inputs) || s.inputs.length > MOVIE_LIMITS.sceneRefs) errors.push(`${at}: "inputs" must be a list of at most ${MOVIE_LIMITS.sceneRefs}.`);
      else for (const x of s.inputs as Record<string, unknown>[]) {
        const k = typeof x?.media === 'string' ? /^m(\d+)$/.exec(x.media) : null, idx = k ? Number(k[1]) - 1 : -1, item = (m.media ?? [])[idx];
        if (!item) errors.push(`${at}: "inputs" names an unknown medium ${String(x?.media)}.`);
        else if (!['reference', 'first', 'last'].includes(x.role as string)) errors.push(`${at}: an input role must be reference, first or last.`);
        else if (fixed.has(idx)) warnings.push(`${at}: m${idx + 1} is placed by you; the plan's placement is ignored.`);
        else if (x.role !== 'reference' && item.media !== 'image') warnings.push(`${at}: m${idx + 1} is not a picture, so it is used as a reference instead of a frame.`), inputs.push({ media: idx, role: 'reference' });
        else if (!inputs.some(i => i.media === idx)) inputs.push({ media: idx, role: x.role as PlannedInput['role'] });
      }
      if (inputs.some(i => i.role === 'reference') && inputs.some(i => i.role !== 'reference')) {
        warnings.push(`${at}: references and frames cannot be combined on MiniMax H3; the frames are used as references.`);
        for (const i of inputs) i.role = 'reference';
      }
    }
    if (title && prompt && typeof seconds === 'number' && typeof continuous === 'boolean')
      segments.push({ title, prompt, seconds, continuous, ...(entry ? { entry } : {}), ...(exit ? { exit } : {}), dialogue, ...(inputs.length ? { inputs } : {}) });
  });
  if (errors.length) return { errors, warnings };
  if (mode === 'suggest') {
    // Placing the user's media must not depend on the model answering the optional "inputs" field: every medium the plan left out is
    // placed by DEAS as a reference in each scene that has no frames, within MiniMax H3's reference counts (the media are the film's
    // people, places and sound unless the plan says where they belong).
    const used = new Set(segments.flatMap(x => x.inputs ?? []).map(i => i.media));
    // Media the user placed are binding: only media left on Auto are placed by the plan or by this fallback.
    const unused = (m.media ?? []).map((x, n) => scenesUsing(m, x.path).length ? -1 : n).filter(n => n >= 0 && !used.has(n));
    if (unused.length && segments.length) {
      const pool = m.media ?? [];
      const placedEverywhere: number[] = [];
      for (const n of unused) {
        let placed = false;
        for (const seg of segments) {
          const list = seg.inputs ?? [];
          if (list.some(i => i.role !== 'reference')) continue;
          const next = [...list, { media: n, role: 'reference' as const }];
          if (!withinH3References(next.map(i => pool[i.media]?.media))) continue;
          seg.inputs = next; placed = true;
        }
        if (placed) placedEverywhere.push(n);
      }
      if (placedEverywhere.length) warnings.push(`The plan did not say where ${placedEverywhere.map(n => `m${n + 1}`).join(', ')} belong${placedEverywhere.length > 1 ? '' : 's'}; DEAS put ${placedEverywhere.length > 1 ? 'them' : 'it'} into every scene as a reference.`);
      const left = unused.filter(n => !placedEverywhere.includes(n));
      if (left.length) warnings.push(`Not placed in any scene: ${left.map(n => `m${n + 1}`).join(', ')} (no scene had room for another reference).`);
    }
    const kept = scenes.filter(i => i.inputs).length;
    if (segments.length < kept) warnings.push(`The plan has ${segments.length} scenes but ${kept} of yours have inputs; those are kept after the plan's scenes.`);
  }
  const mu = mode === 'suggest' ? checkMusic((o as { music?: unknown }).music, m, warnings) : {};
  return { plan: { lore: clean(o.lore as string), segments, ...mu }, errors, warnings };
}
/** The music part of an answer: usable style, lyrics (only when asked for) and a whole tempo inside ACE-Step's bounds; anything else is a warning, never an error. */
function checkMusic(mu: unknown, m: MovieManifest, warnings: string[]): Pick<StoryPlan, 'music' | 'musicLyrics' | 'musicBpm'> {
  if (mu === undefined) return {};
  const v = mu as { style?: unknown; lyrics?: unknown; bpm?: unknown } | null;
  if (!v || typeof v !== 'object') { warnings.push('"music" is not an object; the music is left as it is.'); return {}; }
  const out: Pick<StoryPlan, 'music' | 'musicLyrics' | 'musicBpm'> = {};
  if (v.style !== undefined) {
    if (typeof v.style !== 'string' || v.style.length > 2000) warnings.push('"music.style" is not usable text; the music is left as it is.');
    else if (clean(v.style)) out.music = clean(v.style);
  }
  if (v.lyrics !== undefined && musicItem(m)?.vocals) {
    if (typeof v.lyrics !== 'string' || v.lyrics.length > MUSIC_TEXT_LIMITS.lyrics) warnings.push(`"music.lyrics" must be text up to ${MUSIC_TEXT_LIMITS.lyrics} characters; no lyrics were taken.`);
    else if (v.lyrics.trim()) out.musicLyrics = v.lyrics.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  }
  if (v.bpm !== undefined) {
    const [lo, hi] = MUSIC_TEXT_LIMITS.bpm;
    if (typeof v.bpm !== 'number' || !Number.isFinite(v.bpm) || v.bpm < lo || v.bpm > hi) warnings.push(`"music.bpm" must be a tempo of ${lo}–${hi}; it was not taken.`);
    else out.musicBpm = Math.round(v.bpm);
  }
  return out;
}
/** A music-only request (the music card's *Write with the planner*): the story, the scenes' text and the music settings — no media, no files. */
export function musicRequest(m: MovieManifest): { system: string; user: string; disclosure: { scenes: number; storyCharacters: number; inputsNotSent: number } } {
  const brief = m.items.find(i => i.id === 'brief'), story = m.items.find(i => i.kind === 'story'), scenes = segs(m);
  const system = ['You are a film composer. Answer with one JSON object only, no prose and no code fence.', `Schema: {"music": ${musicSchema(m)}}.`, ...musicInstructions(m)].join('\n');
  const user = [`Title: ${m.title}`, '', 'Story:', brief?.text ?? '', ...(story?.text.trim() ? ['', 'Story bible:', story.text.trim().slice(0, 3000)] : []),
    ...(scenes.length ? ['', 'Scenes:', ...scenes.map((i, n) => `${n + 1}. ${i.seconds ?? 0}s — ${i.text.trim() || i.title.trim() || '(no description yet)'}`)] : [])].join('\n');
  return { system, user, disclosure: { scenes: scenes.length, storyCharacters: (brief?.text ?? '').length, inputsNotSent: (m.media ?? []).length } };
}
export interface MusicCheck { music?: Pick<StoryPlan, 'music' | 'musicLyrics' | 'musicBpm'>; errors: string[]; warnings: string[] }
/** Parses a music-only answer; an answer with nothing usable is an error (nothing changes). */
export function parseMusicAnswer(answer: string, m: MovieManifest): MusicCheck {
  const warnings: string[] = [];
  let raw: unknown;
  try { raw = extractJson(answer); } catch (e) { return { errors: [e instanceof Error ? e.message : String(e)], warnings }; }
  const music = checkMusic((raw as { music?: unknown } | null)?.music, m, warnings);
  return Object.keys(music).length ? { music, errors: [], warnings } : { errors: ['The answer has no usable music.', ...warnings], warnings: [] };
}
/** Applies a music suggestion: only empty fields are filled (style, lyrics, tempo), unless `replace` — what the user wrote stays otherwise. */
export function applyMusic(m: MovieManifest, mu: Pick<StoryPlan, 'music' | 'musicLyrics' | 'musicBpm'>, replace = false): MovieManifest {
  let next = m;
  let item = musicItem(next);
  if (!item) { next = { ...next, items: [...next.items, newItem('music', 'music', 'Music', ['brief'])] }; item = musicItem(next)!; }
  const patch: Partial<MovieItem> = {};
  if (mu.music && (replace || (!item.file && !item.text.trim()))) patch.text = mu.music;
  if (mu.musicLyrics && item.vocals && (replace || !item.lyrics?.trim())) patch.lyrics = mu.musicLyrics;
  if (mu.musicBpm && (replace || !item.bpm)) patch.bpm = mu.musicBpm;
  // A planner text is not the preset's text any more: the preset mark goes when the style changes.
  if (patch.text !== undefined && patch.text !== item.text) patch.preset = undefined;
  return Object.keys(patch).length ? reviseItem(next, item.id, patch, true) : next;
}
/** What applying would set in the music, field by field: `set` (filled), `kept` (the user's own stays), `none` (nothing suggested). */
export function musicDiff(m: MovieManifest, mu: Pick<StoryPlan, 'music' | 'musicLyrics' | 'musicBpm'>, replace = false): { style: 'set' | 'kept' | 'none'; lyrics: 'set' | 'kept' | 'none'; bpm: 'set' | 'kept' | 'none' } {
  const item = musicItem(m);
  return {
    style: !mu.music ? 'none' : replace || (!item?.file && !item?.text.trim()) ? 'set' : 'kept',
    lyrics: !mu.musicLyrics ? 'none' : item?.vocals && (replace || !item.lyrics?.trim()) ? 'set' : 'kept',
    bpm: !mu.musicBpm ? 'none' : replace || !item?.bpm ? 'set' : 'kept',
  };
}
/** Text + JSON in one step; throws the extraction error, returns the check otherwise. */
export const parsePlannerAnswer = (answer: string, m: MovieManifest, limits: SegmentLimits, mode: PlanMode = 'suggest'): PlanCheck => {
  try { return checkPlan(extractJson(answer), m, limits, mode); } catch (e) { return { errors: [e instanceof Error ? e.message : String(e)], warnings: [] }; }
};

/** The scene inputs a placement gives, built from the pool (a reference carries the medium's note as its description). */
export function plannedInputs(m: MovieManifest, list: readonly PlannedInput[] | undefined): SceneInputs | undefined {
  const pool = m.media ?? [];
  const refs = (list ?? []).filter(i => i.role === 'reference' && pool[i.media]).map(i => ({ path: pool[i.media].path, media: pool[i.media].media, mediaMode: 'video' as const, second: 0, strength: 1, ...(pool[i.media].note ? { description: pool[i.media].note!.slice(0, 4000) } : {}) }));
  const frame = (role: 'first' | 'last') => { const i = (list ?? []).find(x => x.role === role && pool[x.media]?.media === 'image'); return i ? { path: pool[i.media].path, media: 'image' as const } : undefined; };
  const out: SceneInputs = refs.length ? { refs } : { ...(frame('first') ? { first: frame('first') } : {}), ...(frame('last') ? { last: frame('last') } : {}) };
  return Object.keys(out).length ? out : undefined;
}
function mergeInputs(own: SceneInputs | undefined, placed: SceneInputs | undefined): SceneInputs | undefined {
  if (!placed) return own;
  if (!own) return placed;
  if (own.first || own.last || !placed.refs?.length) return own;
  const refs = [...(own.refs ?? [])];
  for (const r of placed.refs) if (!refs.some(x => x.path === r.path) && withinH3References([...refs, r].map(x => x.media))) refs.push(r);
  return { ...own, refs };
}
const segmentPatch = (s: PlannedSegment, storyId: string) => ({
  title: s.title, text: s.prompt, seconds: s.seconds, continuous: s.continuous, deps: [storyId],
  dialogue: s.dialogue, entry: s.entry ?? '', exit: s.exit ?? '',
});
/** How a plan is applied: made scenes are left alone unless `rewriteMade` (the proposal's *Also rewrite made scenes*). */
export interface ApplyOptions { rewriteMade?: boolean }
/** A scene the plan does not change: locked, or made while made scenes are kept. */
const untouched = (i: MovieItem, o: ApplyOptions) => !!i.locked || (!o.rewriteMade && i.state === 'done');
/** Scenes a suggestion may not drop: untouched ones and ones holding the user's media. */
const keeps = (i: MovieItem, o: ApplyOptions = {}) => untouched(i, o) || !!i.inputs;
export interface PlanDiff { story: 'new' | 'changed' | 'same' | 'locked'; music: 'none' | 'set' | 'kept'; added: number; changed: string[]; unchanged: string[]; lockedKept: string[]; removed: string[]; staleAfter: string[] }
/** What applying the plan would do, for approval before anything is touched. Segments pair with existing ones by position. */
export function planDiff(m: MovieManifest, plan: StoryPlan, o: ApplyOptions = {}): PlanDiff {
  const story = m.items.find(i => i.kind === 'story');
  const old = segs(m);
  const musicItem = m.items.find(i => i.kind === 'music');
  const out: PlanDiff = { story: !story ? 'new' : story.locked ? 'locked' : story.text === plan.lore ? 'same' : 'changed', music: !plan.music ? 'none' : musicItem?.file || musicItem?.text.trim() ? 'kept' : 'set', added: 0, changed: [], unchanged: [], lockedKept: [], removed: [], staleAfter: [] };
  plan.segments.forEach((s, n) => {
    const cur = old[n];
    if (!cur) { out.added++; return; }
    if (untouched(cur, o)) { out.lockedKept.push(cur.id); return; }
    const p = segmentPatch(s, story?.id ?? 'story');
    const same = (Object.keys(p) as (keyof typeof p)[]).every(k => JSON.stringify(p[k]) === JSON.stringify(cur[k] ?? (k === 'entry' || k === 'exit' ? '' : undefined)));
    (same ? out.unchanged : out.changed).push(cur.id);
  });
  for (const cur of old.slice(plan.segments.length)) (keeps(cur, o) ? out.lockedKept : out.removed).push(cur.id);
  const touched = new Set([...out.changed, ...out.removed]);
  const stale = new Set<string>();
  for (const id of touched) for (const d of downstream(m, id)) if (!touched.has(d)) stale.add(d);
  out.staleAfter = [...stale].filter(id => m.items.find(i => i.id === id)?.state === 'done');
  return out;
}

/** One scene of the proposal as it would end up: `new`, `changed` (with what it was), `same`, or `kept` (a made scene the plan leaves alone — the scene as it is, plus the plan's suggestion). */
export interface PlanRow { n: number; status: 'new' | 'changed' | 'same' | 'kept'; id?: string; planned: PlannedSegment; current?: { title: string; text: string; seconds?: number; continuous?: boolean; entry?: string; exit?: string; dialogue?: MovieDialogue[] } }
/** The proposal scene by scene, in the order the film would have them, plus the scenes that would be removed and the ones kept after the plan's scenes. */
export function planRows(m: MovieManifest, plan: StoryPlan, o: ApplyOptions = {}): { rows: PlanRow[]; removed: { id: string; title: string }[]; keptAfter: { id: string; title: string }[] } {
  const d = planDiff(m, plan, o), old = segs(m);
  const snap = (i: MovieItem) => ({ title: i.title, text: i.text, seconds: i.seconds, continuous: i.continuous, entry: i.entry, exit: i.exit, dialogue: i.dialogue });
  const rows: PlanRow[] = plan.segments.map((planned, n) => {
    const cur = old[n];
    if (!cur) return { n: n + 1, status: 'new', planned };
    const status = d.lockedKept.includes(cur.id) ? 'kept' : d.changed.includes(cur.id) ? 'changed' : 'same';
    return { n: n + 1, status, id: cur.id, planned, current: snap(cur) };
  });
  const after = old.slice(plan.segments.length);
  return {
    rows,
    removed: after.filter(i => d.removed.includes(i.id)).map(i => ({ id: i.id, title: i.title })),
    keptAfter: after.filter(i => d.lockedKept.includes(i.id)).map(i => ({ id: i.id, title: i.title })),
  };
}
/**
 * Applies an approved plan: the story item carries the lore, scenes take the plan's text by position (locked scenes and a locked story
 * are kept; a scene's inputs are never touched), surplus scenes without inputs are removed, and the final film depends on every scene.
 * Changed items get a new revision; everything built from them is marked stale.
 */
export function applyPlan(m: MovieManifest, plan: StoryPlan, o: ApplyOptions = {}): MovieManifest {
  let next = m;
  let story = next.items.find(i => i.kind === 'story');
  if (!story) {
    next = { ...next, items: [...next.items, newItem('story', 'story', 'Story', ['brief'], plan.lore)] };
    story = next.items.find(i => i.kind === 'story')!;
  } else if (!story.locked) next = reviseItem(next, story.id, { text: plan.lore, deps: ['brief'] });
  const storyId = story.id;
  const old = segs(next);
  const used = new Set(next.items.map(i => i.id));
  plan.segments.forEach((s, n) => {
    const cur = old[n];
    // A scene keeps its own inputs; the plan's placements are added to them (references next to references, within H3's counts —
    // never next to frames), and an empty scene simply takes them.
    const placed = plannedInputs(next, s.inputs);
    if (cur) { if (!untouched(cur, o)) { const merged = mergeInputs(cur.inputs, placed); next = reviseItem(next, cur.id, { ...segmentPatch(s, storyId), ...(merged ? { inputs: merged } : {}) }); } return; }
    let k = n + 1; while (used.has(`seg-${k}`)) k++;
    const id = `seg-${k}`; used.add(id);
    const p = segmentPatch(s, storyId);
    const scene = { ...newItem(id, 'segment', p.title, p.deps, p.text, { seconds: p.seconds, continuous: p.continuous }), dialogue: p.dialogue, entry: p.entry, exit: p.exit, ...(placed ? { inputs: placed } : {}) };
    const f = next.items.findIndex(i => i.id === 'final');
    next = { ...next, items: f >= 0 ? [...next.items.slice(0, f), scene, ...next.items.slice(f)] : [...next.items, scene] };
  });
  const surplus = new Set(old.slice(plan.segments.length).filter(i => !keeps(i, o)).map(i => i.id));
  if (surplus.size) {
    const stale = new Set([...surplus].flatMap(id => downstream(next, id)));
    next = { ...next, items: next.items.filter(i => !surplus.has(i.id)).map(i => ({ ...i, deps: i.deps.filter(d => !surplus.has(d)), ...(stale.has(i.id) && i.state === 'done' ? { state: 'stale' as const } : {}) })) };
  }
  const all = segs(next).map(i => i.id);
  const final = next.items.find(i => i.id === 'final');
  if (!final) next = { ...next, items: [...next.items, newItem('final', 'assemble', 'Film', all)] };
  else next = reviseItem(next, final.id, { deps: all }, true);
  // The music bed's style, lyrics (when asked for) and tempo — each only where the user has nothing of their own yet.
  if (plan.music || plan.musicLyrics || plan.musicBpm) {
    const before = next.items.find(i => i.kind === 'music');
    next = applyMusic(next, plan);
    // A new music item keeps its first text as revision 1 (as before), not as an edit of an empty one.
    if (!before) next = { ...next, items: next.items.map(i => i.kind === 'music' ? { ...i, revision: 1, revisions: [{ n: 1, text: i.text }] } : i) };
  }
  const total = Math.round(segs(next).reduce((a, i) => a + (i.seconds ?? 0), 0) * 1000) / 1000;
  return total > 0 ? { ...next, targetSeconds: total } : next;
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
