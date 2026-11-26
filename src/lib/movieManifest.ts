/**
 * Movie Maker manifest core (UX-22d0): the versioned, bounded record of a movie — inputs, authored stages, segment items and their
 * results — plus the pure rules on it: validation, downstream staleness with a bounded rerun plan, revisions that keep old results,
 * and exact segment-duration arithmetic. No UI, no persistence and no generation live here; a stage later becomes an ordinary intent.
 */
export const MOVIE_MANIFEST_VERSION = 1;
export const MOVIE_LIMITS = { items: 400, deps: 32, revisions: 20, text: 20000, id: 80, castRefs: 16, dialogue: 32 } as const;

export type MovieItemKind = 'brief' | 'cast' | 'story' | 'voice' | 'music' | 'segment' | 'assemble';
export type MovieItemState = 'planned' | 'done' | 'stale' | 'failed';
export const MOVIE_ITEM_KINDS: readonly MovieItemKind[] = ['brief', 'cast', 'story', 'voice', 'music', 'segment', 'assemble'];
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
  /** Cast items only: what the entry is, and the reference pictures (absolute paths picked by the user; originals are never copied or changed). */
  role?: MovieCastRole;
  refs?: string[];
  /** Segments only (from the story plan): spoken lines by cast id, and the scene state the shot starts from / leaves behind. */
  dialogue?: MovieDialogue[];
  entry?: string;
  exit?: string;
}
export interface MovieDialogue { castId: string; line: string; delivery?: string }
export type MovieCastRole = 'actor' | 'location' | 'prop' | 'style';
export const MOVIE_CAST_ROLES: readonly MovieCastRole[] = ['actor', 'location', 'prop', 'style'];
export interface MovieManifest {
  version: typeof MOVIE_MANIFEST_VERSION;
  id: string;
  title: string;
  targetSeconds: number;
  aspect: string;
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
  if (v.kind !== 'cast' && (v.role !== undefined || v.refs !== undefined)) return `${at}: role/refs are cast-only`;
  if (v.role !== undefined && !MOVIE_CAST_ROLES.includes(v.role)) return `${at}: unknown cast role`;
  if (v.refs !== undefined && (!Array.isArray(v.refs) || v.refs.length > MOVIE_LIMITS.castRefs || v.refs.some(r => typeof r !== 'string' || r.length < 1 || r.length > 1024 || r.includes('\0')) || new Set(v.refs).size !== v.refs.length)) return `${at}: bad references`;
  if (v.kind === 'segment') {
    if (typeof v.seconds !== 'number' || !(v.seconds > 0) || !Number.isFinite(v.seconds)) return `${at}: segment needs seconds`;
    if (v.continuous !== undefined && typeof v.continuous !== 'boolean') return `${at}: bad continuity flag`;
    if ((v.entry !== undefined && !textOk(v.entry)) || (v.exit !== undefined && !textOk(v.exit))) return `${at}: bad scene state`;
    if (v.dialogue !== undefined && (!Array.isArray(v.dialogue) || v.dialogue.length > MOVIE_LIMITS.dialogue
      || v.dialogue.some(d => !d || !idOk(d.castId) || !ids.has(d.castId) || typeof d.line !== 'string' || d.line.length < 1 || d.line.length > 1000 || (d.delivery !== undefined && (typeof d.delivery !== 'string' || d.delivery.length > 200))))) return `${at}: bad dialogue`;
  } else if (v.seconds !== undefined || v.continuous !== undefined || v.dialogue !== undefined || v.entry !== undefined || v.exit !== undefined) return `${at}: seconds/continuity are segment-only`;
  return undefined;
}
/** The first problem found, or undefined for a valid manifest (schema, bounds, dangling or cyclic dependencies). */
export function manifestProblem(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return 'manifest is not an object';
  const v = m as Partial<MovieManifest>;
  if (v.version !== MOVIE_MANIFEST_VERSION) return 'unsupported manifest version';
  if (!idOk(v.id) || !textOk(v.title) || !textOk(v.aspect)) return 'bad manifest header';
  if (typeof v.targetSeconds !== 'number' || !(v.targetSeconds > 0) || !Number.isFinite(v.targetSeconds)) return 'bad target length';
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
const castId = (m: MovieManifest) => { let n = m.items.filter(i => i.kind === 'cast').length + 1; while (m.items.some(i => i.id === `cast-${n}`)) n++; return `cast-${n}`; };
/** Adds a cast entry that depends on the brief. */
export function addCast(m: MovieManifest, role: MovieCastRole, title: string, text = ''): MovieManifest {
  if (m.items.filter(i => i.kind === 'cast').length >= 64) throw new Error('A movie holds at most 64 cast entries.');
  return { ...m, items: [...m.items, { ...newItem(castId(m), 'cast', title, ['brief'], text), role, refs: [] }] };
}
/** Replaces a cast entry's references; a change stales what was built from it, like a text edit does. */
export function setCastRefs(m: MovieManifest, id: string, refs: string[]): MovieManifest {
  const cur = m.items.find(i => i.id === id && i.kind === 'cast');
  if (!cur) throw new Error(`Unknown cast entry ${id}.`);
  if (cur.locked) throw new Error(`${cur.title || id} is locked; unlock it first.`);
  const stale = new Set(downstream(m, id));
  return { ...m, items: m.items.map(i => i.id === id ? { ...i, refs: [...new Set(refs)].slice(0, MOVIE_LIMITS.castRefs) } : stale.has(i.id) && i.state === 'done' ? { ...i, state: 'stale' as const } : i) };
}
export function setCastRole(m: MovieManifest, id: string, role: MovieCastRole): MovieManifest {
  const cur = m.items.find(i => i.id === id && i.kind === 'cast');
  if (!cur) throw new Error(`Unknown cast entry ${id}.`);
  if (cur.locked) throw new Error(`${cur.title || id} is locked; unlock it first.`);
  return { ...m, items: m.items.map(i => i.id === id ? { ...i, role } : i) };
}
export function setItemTitle(m: MovieManifest, id: string, title: string): MovieManifest { return replaceItem(m, id, i => ({ ...i, title })); }
/** Removes a cast entry (never the brief); items that listed it as an input lose that dependency and, when finished, go stale. */
export function removeCast(m: MovieManifest, id: string): MovieManifest {
  const cur = m.items.find(i => i.id === id && i.kind === 'cast');
  if (!cur) throw new Error(`Unknown cast entry ${id}.`);
  if (cur.locked) throw new Error(`${cur.title || id} is locked; unlock it first.`);
  const stale = new Set(downstream(m, id));
  return { ...m, items: m.items.filter(i => i.id !== id).map(i => ({ ...i, deps: i.deps.filter(d => d !== id), ...(stale.has(i.id) && i.state === 'done' ? { state: 'stale' as const } : {}) })) };
}

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
/** Records a finished result on the current revision and marks the item done. */
export function completeItem(m: MovieManifest, id: string, result: MovieResult): MovieManifest {
  return replaceItem(m, id, i => ({ ...i, state: 'done', revisions: i.revisions.map(r => r.n === i.revision ? { ...r, result } : r) }));
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
