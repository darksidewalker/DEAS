/**
 * Movie Maker manifest core (UX-22d0): the versioned, bounded record of a movie — inputs, authored stages, segment items and their
 * results — plus the pure rules on it: validation, downstream staleness with a bounded rerun plan, revisions that keep old results,
 * and exact segment-duration arithmetic. No UI, no persistence and no generation live here; a stage later becomes an ordinary intent.
 */
export const MOVIE_MANIFEST_VERSION = 1;
export const MOVIE_LIMITS = { items: 400, deps: 32, revisions: 20, text: 20000, id: 80, sceneRefs: 16, dialogue: 32, loras: 8, media: 32, note: 2000 } as const;
export const LORA_STRENGTH = [-4, 4] as const;
/** Crossfade length of a *Blend* transition, seconds. */
export const BLEND_LIMITS = [0.25, 3] as const;
export const BLEND_DEFAULT = 0.75;

export type MovieItemKind = 'brief' | 'story' | 'voice' | 'music' | 'segment' | 'assemble' | 'score';
export type MovieItemState = 'planned' | 'done' | 'stale' | 'failed';
export const MOVIE_ITEM_KINDS: readonly MovieItemKind[] = ['brief', 'story', 'voice', 'music', 'segment', 'assemble', 'score'];
const states: readonly MovieItemState[] = ['planned', 'done', 'stale', 'failed'];

/** A finished result of one revision. `outputId` is the output identity the shared job path reported; the file itself is not copied here. */
export interface MovieResult { outputId: string; jobId?: string; seconds?: number }
export interface MovieRevision { n: number; text: string; result?: MovieResult }
export interface MovieItem {
  id: string;
  kind: MovieItemKind;
  title: string;
  /** Items this one is built from; changing any of them makes this item stale. */
  deps: string[];
  state: MovieItemState;
  /** Locked content (approved identity, manual text) is never recomputed without an explicit approval. */
  locked?: boolean;
  /** Authored text of the current revision (prompt, lore, line, brief). */
  text: string;
  /** Revision number of `text`; revisions keep every earlier text and result. */
  revision: number;
  revisions: MovieRevision[];
  /** Segments only: seconds submitted and whether the shot continues the previous segment (true) or cuts (false). */
  seconds?: number;
  continuous?: boolean;
  /** Segments only: how the film goes into this scene when it is a cut — a crossfade of picture and sound of this many seconds (0.25–3); unset = hard cut. Never with `continuous` (seamless). */
  blend?: number;
  /** Scenes (segments) only: the scene's inputs — first/last frame, source clip and references with the full Director options (absolute paths; originals are never copied or changed). */
  inputs?: SceneInputs;
  /** Segments only: spoken lines by speaker name, and the scene state the shot starts from / leaves behind. */
  dialogue?: MovieDialogue[];
  entry?: string;
  exit?: string;
  /** Segments only: this shot's own diffusion model (its file name as the model list shows it) and LoRAs for that model; unset = the movie's default model, no LoRAs. A continued shot inherits both from the first shot of its chain. */
  model?: string;
  loras?: MovieLora[];
  /** Segments only: this shot's own Steps/CFG (unset = the movie's values for the default model, or its own model's starting values). */
  sampling?: ShotSampling;
  /** Music items only: the track (an absolute path picked or generated; the file itself is never copied or changed). */
  file?: string;
  /** Music items only: sung lyrics (empty = instrumental), ACE-Step's tempo and lyrics language, the preset the style came from, and whether the planner writes lyrics. */
  lyrics?: string;
  bpm?: number;
  language?: string;
  preset?: string;
  vocals?: boolean;
  /** Score items only: how the music bed is mixed onto the joined film. */
  mix?: MovieMix;
}
/** Music bed mix: level and fade apply to the music, `duckDb` is how far it is pushed down under the film's own sound (H3's speech). */
export interface MovieMix { mode: 'mix' | 'h3-reference'; levelDb: number; duckDb: number; fadeSeconds: number }
export const DEFAULT_MIX: MovieMix = { mode: 'mix', levelDb: -14, duckDb: 12, fadeSeconds: 2 };
export const MIX_LIMITS = { levelDb: [-40, 6], duckDb: [0, 30], fadeSeconds: [0, 10] } as const;
export interface MovieLora { name: string; strength: number }
export interface ShotSampling { steps?: number; cfg?: number }
/** Generation settings for the whole movie: `movie` = the movie's own (resolution choice, Steps/CFG of the default model, unset = that model's starting values); `generate` = Generate's own settings for the model. `model` is the default video model's file name. */
export interface MovieRender { source: 'movie' | 'generate'; model?: string; resolution?: string; steps?: number; cfg?: number }
/** Generate's own bounds for Steps and CFG (Workbench `stepsField`/`cfgField`). */
export const SAMPLING_LIMITS = { steps: [1, 150], cfg: [0, 30] } as const;
export const MUSIC_TEXT_LIMITS = { lyrics: 4000, language: 16, preset: 60, bpm: [10, 300] } as const;
export interface MovieDialogue { speaker: string; line: string; delivery?: string }
export type SceneMediaKind = 'image' | 'video' | 'audio';
/** One file used as a frame or source: the path and what it is. */
export interface SceneMedia { path: string; media: SceneMediaKind }
/** A reference as Generate's References editor holds it (`VideoRef` without the webview URL and UI key). */
export interface SceneRef extends SceneMedia {
  mediaMode: 'video' | 'audio' | 'video_audio'; second: number; strength: number;
  trimStart?: number; trimEnd?: number; sourceDuration?: number;
  label?: string; instructions?: string; who?: number[]; whoAxis?: 'y' | 'z' | 'none'; boxes?: { n: number; box: [number, number, number, number] }[];
  keep?: string; drop?: string; description?: string;
}
/** A scene's inputs, assigned like Generate assigns them (`videoRoles.ts`): frames, an optional source clip, references. */
export interface SceneInputs { first?: SceneMedia; last?: SceneMedia; source?: SceneMedia; refs?: SceneRef[] }
/** A file thrown into the movie before it is planned: the planner places it into scenes. `note` is the user's or the picture description's words. */
/** `role`/`label`: how the medium is used when it is put into scenes (reference by default; a Director label for reference pictures). Where it is used is read from the scenes' inputs. */
export interface MovieMedia { path: string; media: SceneMediaKind; note?: string; role?: MediaRole; label?: string }
export type MediaRole = 'reference' | 'first' | 'last' | 'source';
export const MEDIA_ROLES: readonly MediaRole[] = ['reference', 'first', 'last', 'source'];
export interface MovieManifest {
  version: typeof MOVIE_MANIFEST_VERSION;
  id: string;
  title: string;
  targetSeconds: number;
  aspect: string;
  /** The movie's media pool (the story's pictures, clips and sound, not yet placed); scenes hold their own inputs. */
  media?: MovieMedia[];
  /** Canvas and sampling for every shot (absent = the movie's own settings at the model's starting values). */
  render?: MovieRender;
  items: MovieItem[];
}

const idOk = (s: unknown): s is string => typeof s === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${MOVIE_LIMITS.id}}$`).test(s);
const textOk = (s: unknown): s is string => typeof s === 'string' && s.length <= MOVIE_LIMITS.text;

function itemProblem(i: unknown, ids: ReadonlySet<string>): string | undefined {
  if (!i || typeof i !== 'object') return 'item is not an object';
  const v = i as Partial<MovieItem>;
  if (!idOk(v.id)) return 'bad item id';
  const at = `item ${v.id}`;
  if (!MOVIE_ITEM_KINDS.includes(v.kind as MovieItemKind)) return `${at}: unknown kind`;
  if (!textOk(v.title) || !textOk(v.text)) return `${at}: bad text`;
  if (!states.includes(v.state as MovieItemState)) return `${at}: unknown state`;
  if (!Array.isArray(v.deps) || v.deps.length > MOVIE_LIMITS.deps || v.deps.some(d => !idOk(d) || !ids.has(d) || d === v.id)) return `${at}: bad dependency`;
  if (new Set(v.deps).size !== v.deps.length) return `${at}: duplicate dependency`;
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 1) return `${at}: bad revision`;
  if (!Array.isArray(v.revisions) || v.revisions.length > MOVIE_LIMITS.revisions) return `${at}: bad revisions`;
  if (v.revisions.some(r => !r || !Number.isSafeInteger(r.n) || !textOk(r.text) || (r.result !== undefined && (typeof r.result.outputId !== 'string' || r.result.outputId.length < 1 || r.result.outputId.length > 500)))) return `${at}: bad revision entry`;
  if (v.locked !== undefined && typeof v.locked !== 'boolean') return `${at}: bad lock`;
  if (v.file !== undefined && (v.kind !== 'music' || typeof v.file !== 'string' || v.file.length < 1 || v.file.length > 1024 || v.file.includes('\0'))) return `${at}: bad music file`;
  if (v.mix !== undefined) {
    const x = v.mix, ok = (n: unknown, [lo, hi]: readonly [number, number]) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
    if (v.kind !== 'score' || !x || (x.mode !== 'mix' && x.mode !== 'h3-reference') || !ok(x.levelDb, MIX_LIMITS.levelDb) || !ok(x.duckDb, MIX_LIMITS.duckDb) || !ok(x.fadeSeconds, MIX_LIMITS.fadeSeconds)) return `${at}: bad mix settings`;
  }
  if (v.sampling !== undefined && (v.kind !== 'segment' || samplingProblem(v.sampling))) return `${at}: bad shot sampling`;
  if ([v.lyrics, v.bpm, v.language, v.preset, v.vocals].some(x => x !== undefined) && (v.kind !== 'music' || !optText(v.lyrics, MUSIC_TEXT_LIMITS.lyrics)
    || (v.bpm !== undefined && (!Number.isInteger(v.bpm) || !num(v.bpm, MUSIC_TEXT_LIMITS.bpm[0], MUSIC_TEXT_LIMITS.bpm[1])))
    || (v.language !== undefined && (typeof v.language !== 'string' || !/^[a-z]{2,8}$/.test(v.language)))
    || (v.preset !== undefined && (typeof v.preset !== 'string' || !/^[a-z0-9-]{1,60}$/.test(v.preset)))
    || (v.vocals !== undefined && typeof v.vocals !== 'boolean'))) return `${at}: bad music settings`;
  if (v.inputs !== undefined && (v.kind !== 'segment' || sceneInputsProblem(v.inputs))) return `${at}: bad scene inputs${v.kind === 'segment' ? ` (${sceneInputsProblem(v.inputs)})` : ' (scenes only)'}`;
  if (v.loras !== undefined && ((v.kind !== 'segment' && v.kind !== 'music') || !Array.isArray(v.loras) || v.loras.length > MOVIE_LIMITS.loras
    || v.loras.some(l => !l || typeof l.name !== 'string' || l.name.length < 1 || l.name.length > 300 || l.name.includes('\0') || typeof l.strength !== 'number' || !Number.isFinite(l.strength) || l.strength < LORA_STRENGTH[0] || l.strength > LORA_STRENGTH[1])
    || new Set(v.loras.map(l => l.name)).size !== v.loras.length)) return `${at}: bad LoRAs (shots and the music only)`;
  if (v.kind === 'segment') {
    if (typeof v.seconds !== 'number' || !(v.seconds > 0) || !Number.isFinite(v.seconds)) return `${at}: segment needs seconds`;
    if (v.continuous !== undefined && typeof v.continuous !== 'boolean') return `${at}: bad continuity flag`;
    if (v.blend !== undefined && (!num(v.blend, BLEND_LIMITS[0], BLEND_LIMITS[1]) || v.continuous)) return `${at}: bad blend`;
    if ((v.entry !== undefined && !textOk(v.entry)) || (v.exit !== undefined && !textOk(v.exit))) return `${at}: bad scene state`;
    if (v.model !== undefined && (typeof v.model !== 'string' || v.model.length < 1 || v.model.length > 300 || v.model.includes('\0'))) return `${at}: bad shot model`;
    if (v.dialogue !== undefined && (!Array.isArray(v.dialogue) || v.dialogue.length > MOVIE_LIMITS.dialogue
      || v.dialogue.some(d => !d || typeof d.speaker !== 'string' || d.speaker.length < 1 || d.speaker.length > 80 || typeof d.line !== 'string' || d.line.length < 1 || d.line.length > 1000 || (d.delivery !== undefined && (typeof d.delivery !== 'string' || d.delivery.length > 200))))) return `${at}: bad dialogue`;
  } else if (v.seconds !== undefined || v.continuous !== undefined || v.dialogue !== undefined || v.entry !== undefined || v.exit !== undefined || v.model !== undefined || v.blend !== undefined) return `${at}: seconds/continuity are segment-only`;
  return undefined;
}
/** The first problem found, or undefined for a valid manifest (schema, bounds, dangling or cyclic dependencies). */
export function manifestProblem(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return 'manifest is not an object';
  const v = m as Partial<MovieManifest>;
  if (v.version !== MOVIE_MANIFEST_VERSION) return 'unsupported manifest version';
  if (!idOk(v.id) || !textOk(v.title) || !textOk(v.aspect)) return 'bad manifest header';
  if (typeof v.targetSeconds !== 'number' || !(v.targetSeconds > 0) || !Number.isFinite(v.targetSeconds)) return 'bad target length';
  if (v.media !== undefined && (!Array.isArray(v.media) || v.media.length > MOVIE_LIMITS.media || new Set(v.media.map(x => x?.path)).size !== v.media.length
    || v.media.some(x => !mediaOk({ path: x?.path, media: x?.media }) || Object.keys(x).some(k => !['path', 'media', 'note', 'role', 'label'].includes(k)) || !optText(x.note, MOVIE_LIMITS.note)
      || (x.role !== undefined && !MEDIA_ROLES.includes(x.role)) || !optText(x.label, 40)))) return 'bad media pool';
  if (v.render !== undefined && renderProblem(v.render)) return 'bad render settings';
  if (!Array.isArray(v.items) || v.items.length > MOVIE_LIMITS.items) return 'bad item list';
  const ids = new Set<string>();
  for (const i of v.items) { const id = (i as MovieItem | undefined)?.id; if (typeof id === 'string') { if (ids.has(id)) return `duplicate item id ${id}`; ids.add(id); } }
  for (const i of v.items) { const p = itemProblem(i, ids); if (p) return p; }
  // Cycle check (depth-first with colours).
  const by = new Map(v.items.map(i => [i.id, i])), colour = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (colour.get(id) === 2) return false;
    if (colour.get(id) === 1) return true;
    colour.set(id, 1);
    for (const d of by.get(id)!.deps) if (visit(d)) return true;
    colour.set(id, 2); return false;
  };
  for (const i of v.items) if (visit(i.id)) return 'dependency cycle';
  return undefined;
}
export const isMovieManifest = (m: unknown): m is MovieManifest => manifestProblem(m) === undefined;
const samplingOk = (s: { steps?: unknown; cfg?: unknown }) => (s.steps === undefined || (Number.isInteger(s.steps) && num(s.steps, SAMPLING_LIMITS.steps[0], SAMPLING_LIMITS.steps[1])))
  && (s.cfg === undefined || num(s.cfg, SAMPLING_LIMITS.cfg[0], SAMPLING_LIMITS.cfg[1]));
/** Steps (whole, 1–150) and CFG (0–30), both optional, nothing else. Mirrored by `movie_store.rs`. */
export function samplingProblem(x: unknown): string | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
  if (Object.keys(x).some(k => !['steps', 'cfg'].includes(k))) return 'unknown field';
  return samplingOk(x as ShotSampling) ? undefined : 'out of range';
}
/** The movie's render settings: a known source, a resolution choice name, a model file name, optional Steps/CFG. */
export function renderProblem(x: unknown): string | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
  const v = x as MovieRender;
  if (Object.keys(v).some(k => !['source', 'model', 'resolution', 'steps', 'cfg'].includes(k))) return 'unknown field';
  if (v.source !== 'movie' && v.source !== 'generate') return 'bad source';
  if (v.model !== undefined && (typeof v.model !== 'string' || v.model.length < 1 || v.model.length > 300 || v.model.includes('\0'))) return 'bad model';
  if (v.resolution !== undefined && (typeof v.resolution !== 'string' || v.resolution.length < 1 || v.resolution.length > 20)) return 'bad resolution';
  return samplingOk(v) ? undefined : 'bad sampling';
}
/** Parses stored text; throws a readable error instead of half-loading a damaged or newer manifest. */
export function parseManifest(text: string): MovieManifest {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error('The movie file is not valid JSON.'); }
  const p = manifestProblem(v);
  if (p) throw new Error(`The movie file is not usable: ${p}.`);
  return v as MovieManifest;
}
export const serializeManifest = (m: MovieManifest): string => {
  const p = manifestProblem(m);
  if (p) throw new Error(`Refusing to save an invalid movie: ${p}.`);
  return JSON.stringify(m);
};

export const newMovie = (id: string, title: string, targetSeconds = 30, aspect = '16:9'): MovieManifest =>
  ({ version: MOVIE_MANIFEST_VERSION, id, title, targetSeconds, aspect, items: [newItem('brief', 'brief', title)] });
/** Brief edits: the story is the brief item's text (a new revision, downstream goes stale); title, length and aspect are header fields. */
export function setBrief(m: MovieManifest, b: { title?: string; story?: string; targetSeconds?: number; aspect?: string }): MovieManifest {
  let next: MovieManifest = { ...m, title: b.title ?? m.title, targetSeconds: b.targetSeconds ?? m.targetSeconds, aspect: b.aspect ?? m.aspect };
  next = { ...next, items: next.items.map(i => i.id === 'brief' ? { ...i, title: next.title } : i) };
  return b.story === undefined ? next : editItem(next, 'brief', b.story);
}
export function setItemTitle(m: MovieManifest, id: string, title: string): MovieManifest { return replaceItem(m, id, i => ({ ...i, title })); }
const pathOk = (p: unknown): p is string => typeof p === 'string' && p.length >= 1 && p.length <= 1024 && !p.includes('\0');
const KINDS: readonly SceneMediaKind[] = ['image', 'video', 'audio'];
const mediaOk = (x: unknown): boolean => !!x && typeof x === 'object' && pathOk((x as SceneMedia).path) && KINDS.includes((x as SceneMedia).media);
const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const optText = (x: unknown, max: number) => x === undefined || (typeof x === 'string' && x.length <= max);
const REF_KEYS = new Set(['path', 'media', 'mediaMode', 'second', 'strength', 'trimStart', 'trimEnd', 'sourceDuration', 'label', 'instructions', 'who', 'whoAxis', 'boxes', 'keep', 'drop', 'description']);
/** The first problem of a scene's inputs (bounded, typed, no unknown keys), or undefined. Mirrored by `movie_store.rs`. */
export function sceneInputsProblem(x: unknown): string | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
  const v = x as SceneInputs;
  if (Object.keys(v).some(k => !['first', 'last', 'source', 'refs'].includes(k))) return 'unknown field';
  for (const k of ['first', 'last', 'source'] as const) if (v[k] !== undefined && (!mediaOk(v[k]) || Object.keys(v[k]!).length !== 2)) return `bad ${k}`;
  if (v.refs === undefined) return undefined;
  if (!Array.isArray(v.refs) || v.refs.length > MOVIE_LIMITS.sceneRefs) return 'bad references';
  for (const r of v.refs) {
    if (!mediaOk(r) || Object.keys(r).some(k => !REF_KEYS.has(k))) return 'bad reference';
    if (!['video', 'audio', 'video_audio'].includes(r.mediaMode) || !num(r.second, 0, 3600) || !num(r.strength, 0, 10)) return 'bad reference settings';
    if (![r.trimStart, r.trimEnd, r.sourceDuration].every(t => t === undefined || num(t, 0, 36000))) return 'bad trim';
    if (!optText(r.label, 40) || ![r.instructions, r.keep, r.drop, r.description].every(t => optText(t, 4000))) return 'bad reference text';
    if (r.who !== undefined && (!Array.isArray(r.who) || r.who.length > 32 || r.who.some(n => !Number.isInteger(n) || n < 1 || n > 32))) return 'bad people';
    if (r.whoAxis !== undefined && !['y', 'z', 'none'].includes(r.whoAxis)) return 'bad people axis';
    if (r.boxes !== undefined && (!Array.isArray(r.boxes) || r.boxes.length > 32 || r.boxes.some(b => !b || !Number.isInteger(b.n) || b.n < 1 || b.n > 32 || !Array.isArray(b.box) || b.box.length !== 4 || b.box.some(c => !num(c, 0, 1))))) return 'bad people boxes';
  }
  return undefined;
}
/** Adds files to the movie's media pool (no repeats, at most 32); nothing is stale — the pool only feeds the planner. */
export function addMedia(m: MovieManifest, items: readonly MovieMedia[]): MovieManifest {
  const pool = [...(m.media ?? [])];
  for (const x of items) if (!pool.some(p => p.path === x.path) && pool.length < MOVIE_LIMITS.media && mediaOk(x)) pool.push({ path: x.path, media: x.media, ...(x.note ? { note: x.note.slice(0, MOVIE_LIMITS.note) } : {}) });
  return { ...m, media: pool };
}
export const removeMedia = (m: MovieManifest, path: string): MovieManifest => { const pool = (m.media ?? []).filter(x => x.path !== path); return { ...m, media: pool.length ? pool : undefined }; };
/** Removes a medium from the movie and from every scene that used it. */
export const dropMedia = (m: MovieManifest, path: string): MovieManifest => (m.media ?? []).some(x => x.path === path) ? removeMedia(assignMedia(m, path, []).movie, path) : m;
export const setMediaNote = (m: MovieManifest, path: string, note: string): MovieManifest =>
  ({ ...m, media: (m.media ?? []).map(x => x.path === path ? { ...x, note: note.trim() ? note.slice(0, MOVIE_LIMITS.note) : undefined } : x).map(x => x.note === undefined ? (({ note: _n, ...rest }) => rest)(x) : x) });
/** How a medium is used where it is used (read from the first scene holding it), else its pool preference, else reference. */
export function roleOf(m: MovieManifest, path: string): MediaRole {
  for (const i of m.items) {
    if (i.kind !== 'segment' || !i.inputs) continue;
    const v = i.inputs;
    if (v.first?.path === path) return 'first';
    if (v.last?.path === path) return 'last';
    if (v.source?.path === path) return 'source';
    if (v.refs?.some(r => r.path === path)) return 'reference';
  }
  return (m.media ?? []).find(x => x.path === path)?.role ?? 'reference';
}
/** The scenes a medium is used in (read from their inputs, so it never drifts from what a scene really holds). */
export const scenesUsing = (m: MovieManifest, path: string): string[] => m.items.filter(i => i.kind === 'segment' && sceneFiles(i).includes(path)).map(i => i.id);
/**
 * Puts a pool medium into exactly the given scenes with its role (and Director label for references) and takes it out of all others.
 * MiniMax H3 does not mix frames with references in one take, so a scene that would mix them is refused and named in `refused`;
 * a frame or source role needs a picture or clip. Changed scenes get a new revision (made ones go outdated).
 */
export function assignMedia(m: MovieManifest, path: string, scenes: readonly string[], role: MediaRole = 'reference', label?: string): { movie: MovieManifest; refused: string[] } {
  const item = (m.media ?? []).find(x => x.path === path);
  if (!item) throw new Error('This medium is not in the movie.');
  if ((role === 'first' || role === 'last') && item.media !== 'image') throw new Error('Only a picture can be a first or last frame.');
  if (role === 'source' && item.media !== 'video') throw new Error('Only a clip can be a source.');
  const want = new Set(scenes), refused: string[] = [];
  let next: MovieManifest = { ...m, media: (m.media ?? []).map(x => x.path === path ? { path: x.path, media: x.media, ...(x.note ? { note: x.note } : {}), ...(role !== 'reference' ? { role } : {}), ...(label && role === 'reference' ? { label } : {}) } : x) };
  for (const scene of next.items.filter(i => i.kind === 'segment')) {
    const v = scene.inputs ?? {};
    const without: SceneInputs = {
      ...(v.first && v.first.path !== path ? { first: v.first } : {}), ...(v.last && v.last.path !== path ? { last: v.last } : {}),
      ...(v.source && v.source.path !== path ? { source: v.source } : {}), ...((v.refs ?? []).some(r => r.path !== path) ? { refs: (v.refs ?? []).filter(r => r.path !== path) } : {}),
    };
    let inputs = without;
    if (want.has(scene.id)) {
      const frames = !!(without.first || without.last), refs = !!without.refs?.length;
      if (role === 'reference' ? frames : refs) { refused.push(scene.id); }
      else if (role === 'reference') inputs = { ...without, refs: [...(without.refs ?? []), { path, media: item.media, mediaMode: 'video' as const, second: 0, strength: 1, ...(label ? { label } : {}), ...(item.note ? { description: item.note.slice(0, 4000) } : {}) }].slice(0, MOVIE_LIMITS.sceneRefs) };
      else inputs = { ...without, [role]: { path, media: item.media } };
    }
    if (JSON.stringify(inputs) !== JSON.stringify(scene.inputs ?? {})) next = setSceneInputs(next, scene.id, inputs);
  }
  return { movie: next, refused };
}
/** Every file a scene uses (frames, source, references), in order, without repeats. */
export const sceneFiles = (i: MovieItem): string[] => [...new Set([i.inputs?.first?.path, i.inputs?.last?.path, i.inputs?.source?.path, ...(i.inputs?.refs ?? []).map(r => r.path)].filter((p): p is string => !!p))];
/** The movie's length is the sum of its scenes' lengths (the header keeps it for the planner and the music bed). */
export const scenesSeconds = (m: MovieManifest): number => Math.round(m.items.filter(i => i.kind === 'segment').reduce((a, i) => a + (i.seconds ?? 0), 0) * 1000) / 1000;
const withTotal = (m: MovieManifest): MovieManifest => { const t = scenesSeconds(m); return t > 0 && t !== m.targetSeconds ? { ...m, targetSeconds: t } : m; };
const sceneDeps = (m: MovieManifest) => [m.items.find(i => i.kind === 'story')?.id ?? 'brief'];
/** Adds an empty scene after `afterId` (or at the end) with the given length; the final film then depends on it and goes stale. */
export function addScene(m: MovieManifest, seconds: number, afterId?: string): MovieManifest {
  if (m.items.filter(i => i.kind === 'segment').length >= 60) throw new Error('A movie holds at most 60 scenes.');
  const used = new Set(m.items.map(i => i.id)); let k = 1; while (used.has(`seg-${k}`)) k++;
  const scene = newItem(`seg-${k}`, 'segment', '', sceneDeps(m), '', { seconds, continuous: false });
  const at = afterId ? m.items.findIndex(i => i.id === afterId) : -1;
  const items = at >= 0 ? [...m.items.slice(0, at + 1), scene, ...m.items.slice(at + 1)] : (() => { const f = m.items.findIndex(i => i.id === 'final'); return f >= 0 ? [...m.items.slice(0, f), scene, ...m.items.slice(f)] : [...m.items, scene]; })();
  let next: MovieManifest = { ...m, items };
  const all = next.items.filter(i => i.kind === 'segment').map(i => i.id);
  next = next.items.some(i => i.id === 'final') ? reviseItem(next, 'final', { deps: all }, true) : { ...next, items: [...next.items, newItem('final', 'assemble', 'Film', all)] };
  return withTotal(next);
}
/** Removes a scene (never a locked one); what was built from it goes stale and a following continued scene becomes a cut. */
export function removeScene(m: MovieManifest, id: string): MovieManifest {
  const cur = m.items.find(i => i.id === id && i.kind === 'segment');
  if (!cur) throw new Error(`Unknown scene ${id}.`);
  if (cur.locked) throw new Error(`${cur.title || id} is locked; unlock it first.`);
  const scenes = m.items.filter(i => i.kind === 'segment'), at = scenes.findIndex(i => i.id === id), after = scenes[at + 1];
  const stale = new Set(downstream(m, id));
  let next: MovieManifest = { ...m, items: m.items.filter(i => i.id !== id).map(i => ({ ...i, deps: i.deps.filter(d => d !== id), ...(stale.has(i.id) && i.state === 'done' ? { state: 'stale' as const } : {}) })) };
  if (after?.continuous && (at === 0 || !scenes[at - 1])) next = reviseItem(next, after.id, { continuous: false }, true);
  if (!next.items.some(i => i.kind === 'segment')) next = { ...next, items: next.items.filter(i => i.id !== 'final') };
  return withTotal(next);
}
/** Replaces a scene's inputs (empty parts dropped); a change is a new revision and stales what was built from the scene. */
export function setSceneInputs(m: MovieManifest, id: string, inputs: SceneInputs): MovieManifest {
  if (!m.items.some(i => i.id === id && i.kind === 'segment')) throw new Error(`Unknown scene ${id}.`);
  const clean: SceneInputs = { ...(inputs.first ? { first: inputs.first } : {}), ...(inputs.last ? { last: inputs.last } : {}), ...(inputs.source ? { source: inputs.source } : {}), ...(inputs.refs?.length ? { refs: inputs.refs } : {}) };
  const p = sceneInputsProblem(clean);
  if (p) throw new Error(`These scene inputs cannot be kept: ${p}.`);
  return reviseItem(m, id, { inputs: Object.keys(clean).length ? clean : undefined });
}
export type SceneTransition = 'seamless' | 'cut' | 'blend';
/** How the film goes into a scene (never the first): seamless (H3 continues the previous take), a hard cut, or a crossfade. */
export const transitionOf = (i: MovieItem): SceneTransition => i.continuous ? 'seamless' : i.blend ? 'blend' : 'cut';
/**
 * Sets the transition into a scene. Seamless ↔ not seamless changes how the scene is generated (a new revision, the scene must be made
 * again); cut ↔ blend or another blend length only changes the stitching, so only the film (and the scored film) go outdated.
 */
export function setTransition(m: MovieManifest, id: string, kind: SceneTransition, seconds: number = BLEND_DEFAULT): MovieManifest {
  const scenes = m.items.filter(i => i.kind === 'segment'), cur = scenes.find(i => i.id === id);
  if (!cur) throw new Error(`Unknown scene ${id}.`);
  if (scenes[0]?.id === id) throw new Error('The first scene has no transition.');
  const blend = kind === 'blend' ? Math.min(BLEND_LIMITS[1], Math.max(BLEND_LIMITS[0], seconds)) : undefined;
  if ((kind === 'seamless') !== !!cur.continuous) return reviseItem(m, id, { continuous: kind === 'seamless', blend }, true);
  if (blend === cur.blend) return m;
  const stale = new Set(downstream(m, id));
  return { ...m, items: m.items.map(i => i.id === id ? { ...i, blend } : stale.has(i.id) && i.state === 'done' && (i.kind === 'assemble' || i.kind === 'score') ? { ...i, state: 'stale' as const } : i) };
}
/** Sets a scene's length; the movie's length follows the sum of the scenes. */
export const setSceneSeconds = (m: MovieManifest, id: string, seconds: number): MovieManifest => withTotal(reviseItem(m, id, { seconds }));

export function newItem(id: string, kind: MovieItemKind, title: string, deps: string[] = [], text = '', extra: Pick<MovieItem, 'seconds' | 'continuous'> = {}): MovieItem {
  return { id, kind, title, deps, state: 'planned', text, revision: 1, revisions: [{ n: 1, text }], ...extra };
}

/** All items that (transitively) depend on `id`, in manifest order. A continuous segment also depends on the segment before it. */
export function downstream(m: MovieManifest, id: string): string[] {
  const segs = m.items.filter(i => i.kind === 'segment');
  const reverse = new Map<string, string[]>();
  const link = (from: string, to: string) => reverse.set(from, [...(reverse.get(from) ?? []), to]);
  for (const i of m.items) for (const d of i.deps) link(d, i.id);
  segs.forEach((s, n) => { if (n > 0 && s.continuous && !s.deps.includes(segs[n - 1].id)) link(segs[n - 1].id, s.id); });
  const seen = new Set<string>(), queue = [id];
  while (queue.length) for (const next of reverse.get(queue.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return m.items.filter(i => seen.has(i.id)).map(i => i.id);
}

/** A bounded rerun plan: what recomputes freely, what is locked and needs an explicit approval, what stays untouched. */
export interface RerunPlan { changed: string; rerun: string[]; needsApproval: string[]; untouched: string[] }
export function rerunPlan(m: MovieManifest, id: string): RerunPlan {
  const down = new Set(downstream(m, id));
  const rerun: string[] = [], needsApproval: string[] = [], untouched: string[] = [];
  for (const i of m.items) {
    if (i.id === id) continue;
    if (!down.has(i.id)) untouched.push(i.id);
    else (i.locked ? needsApproval : rerun).push(i.id);
  }
  return { changed: id, rerun, needsApproval, untouched };
}

const replaceItem = (m: MovieManifest, id: string, f: (i: MovieItem) => MovieItem): MovieManifest => {
  if (!m.items.some(i => i.id === id)) throw new Error(`Unknown movie item ${id}.`);
  return { ...m, items: m.items.map(i => i.id === id ? f(i) : i) };
};
/**
 * Edits an item's text as a new revision (the old text and result stay in `revisions`) and marks every downstream item stale.
 * Locked downstream items are marked stale too but are listed by `rerunPlan` as needing approval. A locked item itself refuses the edit
 * unless `force` is set. Returns the new manifest; the input is not mutated.
 */
export function editItem(m: MovieManifest, id: string, text: string, force = false): MovieManifest {
  const cur = m.items.find(i => i.id === id);
  if (!cur) throw new Error(`Unknown movie item ${id}.`);
  if (cur.locked && !force) throw new Error(`${cur.title || id} is locked; unlock it or approve the change first.`);
  if (text === cur.text) return m;
  const stale = new Set(downstream(m, id));
  const next = replaceItem(m, id, i => {
    const n = i.revision + 1;
    return { ...i, text, revision: n, state: 'planned', revisions: [...i.revisions, { n, text }].slice(-MOVIE_LIMITS.revisions) };
  });
  return { ...next, items: next.items.map(i => stale.has(i.id) && i.state === 'done' ? { ...i, state: 'stale' } : i) };
}
/**
 * Applies a patch (text, deps, seconds, continuity, dialogue, …) as one new revision when anything actually changes, and stales what was
 * built from the item. Returns the same manifest for an empty change. Locked items refuse unless `force`.
 */
export function reviseItem(m: MovieManifest, id: string, patch: Partial<Omit<MovieItem, 'id' | 'kind' | 'revision' | 'revisions' | 'state'>>, force = false): MovieManifest {
  const cur = m.items.find(i => i.id === id);
  if (!cur) throw new Error(`Unknown movie item ${id}.`);
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter(k => JSON.stringify(patch[k]) !== JSON.stringify(cur[k]));
  if (!changed.length) return m;
  if (cur.locked && !force) throw new Error(`${cur.title || id} is locked; unlock it or approve the change first.`);
  const stale = new Set(downstream(m, id));
  const text = patch.text ?? cur.text, n = cur.revision + 1;
  return { ...m, items: m.items.map(i => i.id === id
    ? { ...i, ...patch, text, revision: n, state: 'planned' as const, revisions: [...i.revisions, { n, text }].slice(-MOVIE_LIMITS.revisions) }
    : stale.has(i.id) && i.state === 'done' ? { ...i, state: 'stale' as const } : i) };
}
/** Items whose recorded clip is gone from disk go back to *not made* (the old result stays in the revision history) and what was built from them becomes stale. */
export function markResultsMissing(m: MovieManifest, ids: readonly string[]): MovieManifest {
  const gone = new Set(ids), stale = new Set(ids.flatMap(id => downstream(m, id)));
  return { ...m, items: m.items.map(i => gone.has(i.id) && i.state === 'done' ? { ...i, state: 'planned' as const } : stale.has(i.id) && !gone.has(i.id) && i.state === 'done' ? { ...i, state: 'stale' as const } : i) };
}
/** Changes the movie's render settings (Steps/CFG clamped to Generate's bounds; `undefined` clears a value). Not a revision: settings apply to shots made from now on. */
export function setRender(m: MovieManifest, patch: Partial<MovieRender>): MovieManifest {
  const cur: MovieRender = { source: 'movie', ...m.render };
  const next: MovieRender = { ...cur, ...patch };
  for (const k of Object.keys(next) as (keyof MovieRender)[]) if (next[k] === undefined) delete next[k];
  if (next.steps !== undefined) next.steps = Math.round(Math.min(SAMPLING_LIMITS.steps[1], Math.max(SAMPLING_LIMITS.steps[0], next.steps)));
  if (next.cfg !== undefined) next.cfg = Math.min(SAMPLING_LIMITS.cfg[1], Math.max(SAMPLING_LIMITS.cfg[0], next.cfg));
  return { ...m, render: next };
}
/** Sets (or clears with an empty object) a shot's own Steps/CFG; a revision, so a made shot goes outdated. */
export function setShotSampling(m: MovieManifest, id: string, sampling: ShotSampling): MovieManifest {
  if (!m.items.some(i => i.id === id && i.kind === 'segment')) throw new Error(`Unknown shot ${id}.`);
  const s: ShotSampling = {};
  if (sampling.steps !== undefined && Number.isFinite(sampling.steps)) s.steps = Math.round(Math.min(SAMPLING_LIMITS.steps[1], Math.max(SAMPLING_LIMITS.steps[0], sampling.steps)));
  if (sampling.cfg !== undefined && Number.isFinite(sampling.cfg)) s.cfg = Math.min(SAMPLING_LIMITS.cfg[1], Math.max(SAMPLING_LIMITS.cfg[0], sampling.cfg));
  return reviseItem(m, id, { sampling: Object.keys(s).length ? s : undefined });
}
/** Sets (or clears, with null) a shot's own model; a revision, so the shot and what follows it go outdated. */
export function setShotModel(m: MovieManifest, id: string, model: string | null): MovieManifest {
  if (!m.items.some(i => i.id === id && i.kind === 'segment')) throw new Error(`Unknown shot ${id}.`);
  return reviseItem(m, id, { model: model ?? undefined });
}
/** Replaces a shot's or the music item's LoRAs (at most 8, no repeats, strength clamped to the limits); an empty list clears them. */
export function setShotLoras(m: MovieManifest, id: string, loras: readonly MovieLora[]): MovieManifest {
  if (!m.items.some(i => i.id === id && (i.kind === 'segment' || i.kind === 'music'))) throw new Error(`Unknown shot ${id}.`);
  const seen = new Set<string>(), clean: MovieLora[] = [];
  for (const l of loras) {
    if (seen.has(l.name) || clean.length >= MOVIE_LIMITS.loras || !Number.isFinite(l.strength)) continue;
    seen.add(l.name); clean.push({ name: l.name, strength: Math.min(LORA_STRENGTH[1], Math.max(LORA_STRENGTH[0], l.strength)) });
  }
  return reviseItem(m, id, { loras: clean.length ? clean : undefined });
}
const hasKind = (m: MovieManifest, kind: MovieItemKind) => m.items.find(i => i.kind === kind);
/** Adds the score item (film + music → scored film) once the movie has both a final item and a music item. */
function ensureScore(m: MovieManifest): MovieManifest {
  const final = m.items.find(i => i.id === 'final'), music = hasKind(m, 'music');
  if (!final || !music || hasKind(m, 'score')) return m;
  return { ...m, items: [...m.items, { ...newItem('score', 'score', 'Scored film', ['final', music.id]), mix: { ...DEFAULT_MIX } }] };
}
/** Sets (or clears, with null) the music track; creates the music item on first use. Changing it makes the scored film outdated. */
export function setMusicFile(m: MovieManifest, path: string | null): MovieManifest {
  let next = m;
  if (!hasKind(next, 'music')) next = { ...next, items: [...next.items, newItem('music', 'music', 'Music', ['brief'])] };
  next = reviseItem(next, hasKind(next, 'music')!.id, { file: path ?? undefined }, true);
  return ensureScore(next);
}
/** Changes mix settings (clamped to the limits); the scored film becomes outdated. Needs the score item. */
export function setMix(m: MovieManifest, patch: Partial<MovieMix>): MovieManifest {
  const score = hasKind(m, 'score');
  if (!score) throw new Error('Choose a music file for the film first.');
  const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, n));
  const cur = score.mix ?? DEFAULT_MIX;
  const mix: MovieMix = {
    mode: patch.mode ?? cur.mode,
    levelDb: patch.levelDb !== undefined && Number.isFinite(patch.levelDb) ? clamp(patch.levelDb, MIX_LIMITS.levelDb) : cur.levelDb,
    duckDb: patch.duckDb !== undefined && Number.isFinite(patch.duckDb) ? clamp(patch.duckDb, MIX_LIMITS.duckDb) : cur.duckDb,
    fadeSeconds: patch.fadeSeconds !== undefined && Number.isFinite(patch.fadeSeconds) ? clamp(patch.fadeSeconds, MIX_LIMITS.fadeSeconds) : cur.fadeSeconds,
  };
  return reviseItem(m, score.id, { mix }, true);
}
/** Records a finished result on the current revision and marks the item done. */
export function completeItem(m: MovieManifest, id: string, result: MovieResult): MovieManifest {
  const cur = m.items.find(i => i.id === id);
  const before = cur?.revisions.find(r => r.n === cur.revision)?.result?.outputId;
  const next = replaceItem(m, id, i => ({ ...i, state: 'done', revisions: i.revisions.map(r => r.n === i.revision ? { ...r, result } : r) }));
  // A remade item (a new clip for the same text) outdates what was built from the old one, e.g. the stitched film.
  if (before === undefined || before === result.outputId) return next;
  const stale = new Set(downstream(next, id));
  return { ...next, items: next.items.map(i => stale.has(i.id) && i.state === 'done' ? { ...i, state: 'stale' as const } : i) };
}
export const failItem = (m: MovieManifest, id: string): MovieManifest => replaceItem(m, id, i => ({ ...i, state: 'failed' }));
export const setLocked = (m: MovieManifest, id: string, locked: boolean): MovieManifest => replaceItem(m, id, i => ({ ...i, locked }));
/** Returns an item to an earlier revision's text (as a new revision, so history only grows); its old result is not reused silently. */
export function restoreRevision(m: MovieManifest, id: string, n: number): MovieManifest {
  const cur = m.items.find(i => i.id === id), old = cur?.revisions.find(r => r.n === n);
  if (!cur || !old) throw new Error(`Item ${id} has no revision ${n}.`);
  return editItem(m, id, old.text, true);
}
/** Items to run next: planned or stale or failed, every dependency done, in manifest order. Stale locked items wait for approval. */
export function readyItems(m: MovieManifest, approved: ReadonlySet<string> = new Set()): string[] {
  const state = new Map(m.items.map(i => [i.id, i.state]));
  const segs = m.items.filter(i => i.kind === 'segment');
  return m.items.filter(i => {
    if (i.state === 'done') return false;
    if (i.locked && i.state === 'stale' && !approved.has(i.id)) return false;
    if (i.deps.some(d => state.get(d) !== 'done')) return false;
    const n = segs.findIndex(s => s.id === i.id);
    return !(n > 0 && i.continuous && state.get(segs[n - 1].id) !== 'done');
  }).map(i => i.id);
}

// --- duration arithmetic ---------------------------------------------------------------------------------------------------------

export interface SegmentLimits {
  /** Shortest and longest segment a model accepts, in seconds. */
  min: number; max: number;
  /** Granularity of segment lengths in seconds (0.1 by default). */
  step?: number;
  /** Seconds of each continued segment that repeat the end of the one before (0 for hard cuts). */
  overlap?: number;
}
export type SegmentPlan =
  | { ok: true; seconds: number[]; total: number }
  | { ok: false; reason: string; nearest?: { seconds: number[]; total: number } };

/**
 * Splits `target` seconds into the fewest segments within the limits so that the *delivered* length (sum of segments minus the overlap
 * repeated by every continued segment) equals the target exactly on the step grid. Integer arithmetic avoids float drift.
 * When it is unattainable the answer says why and offers the nearest attainable total instead of silently rounding.
 */
export function planSegments(target: number, limits: SegmentLimits): SegmentPlan {
  const step = limits.step ?? 0.1;
  const q = (x: number) => Math.round(x / step);
  const bad = [target, limits.min, limits.max, step, limits.overlap ?? 0].some(x => !Number.isFinite(x) || x < 0);
  if (bad || !(target > 0) || !(step > 0) || !(limits.min > 0) || limits.max < limits.min) return { ok: false, reason: 'The target length and the segment limits must be positive numbers with min ≤ max.' };
  const eps = 1e-9, T = q(target), ov = q(limits.overlap ?? 0);
  // A limit between two grid points rounds inwards, so a layout never exceeds what the model accepts.
  const lo = Math.ceil(limits.min / step - eps), hi = Math.floor(limits.max / step + eps);
  if (hi < lo) return { ok: false, reason: `No ${step}s step lies between ${limits.min}s and ${limits.max}s.` };
  if (ov >= lo) return { ok: false, reason: 'The overlap must be shorter than the shortest segment.' };
  const to = (xs: number[]) => xs.map(x => Math.round(x * step * 1e6) / 1e6);
  const split = (raw: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(raw / n) + (i < raw % n ? 1 : 0));
  const MAX_N = 200;
  let nearest: { n: number; delivered: number } | undefined;
  for (let n = 1; n <= MAX_N; n++) {
    const sub = ov * (n - 1), min = n * lo - sub, max = n * hi - sub;
    if (T >= min && T <= max) {
      const seconds = to(split(T + sub, n)), total = to([T])[0];
      return Math.abs(T * step - target) > step * 1e-6
        ? { ok: false, reason: `${target}s is not a multiple of the ${step}s step; the nearest attainable length is ${total}s.`, nearest: { seconds, total } }
        : { ok: true, seconds, total };
    }
    for (const d of [min, max]) if (d > 0 && (!nearest || Math.abs(d - T) < Math.abs(nearest.delivered - T))) nearest = { n, delivered: d };
    if (min > T && n > 1) break;
  }
  if (!nearest) return { ok: false, reason: 'No segment layout fits these limits.' };
  const raw = nearest.delivered + ov * (nearest.n - 1);
  const seconds = to(split(raw, nearest.n));
  return { ok: false, reason: `Exactly ${target}s cannot be built from ${limits.min}–${limits.max}s segments${ov ? ` with ${limits.overlap}s overlap` : ''} on a ${step}s grid; the nearest is ${to([nearest.delivered])[0]}s.`, nearest: { seconds, total: to([nearest.delivered])[0] } };
}
/** Delivered length of the manifest's segments: the sum of their seconds minus the overlap repeated by each continued segment. */
export function deliveredSeconds(m: MovieManifest, overlap = 0): number {
  const segs = m.items.filter(i => i.kind === 'segment');
  const q = (x: number) => Math.round(x * 1000);
  const total = segs.reduce((a, s, n) => a + q(s.seconds ?? 0) - (n > 0 && s.continuous ? q(overlap) : 0), 0);
  return total / 1000;
}
