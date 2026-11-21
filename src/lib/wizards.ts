import data from '../wizards/builtin.json' with { type: 'json' };
import families from '../families/builtin.json' with { type: 'json' };
import { canvasSize, validCanvas, type Size } from './resolution.ts';
import type { JobStatus } from './jobs.ts';

/**
 * Dark Wizards are data: each strategy names the model families it accepts in preference order, the ordinary
 * Generate pipeline it uses and the prompt template it fills. A wizard never guesses unknown models and never
 * runs anything itself — it hands an ordinary draft to Generate, where Run Plan and Run stay the authority.
 */
export type WizardField = 'target' | 'replacement';
export interface WizardStrategy {
  id: string;
  families: string[];
  pipeline: 't2i' | 'i2i';
  /** `reference`: the picture is a prompt reference of a text-to-image edit model; `edit`: it is the picture to edit. */
  source: 'reference' | 'edit';
  edit?: 'inpaint' | 'resample';
  positive: string;
  /**
   * Template used when an object picture is given and the chosen model's family is in `objectFamilies` (families whose
   * prompt encoder takes reference images). The picture to change is reference 1 (`image 1`), the object picture reference 2.
   */
  objectPositive?: string;
  objectFamilies?: string[];
  needsMask: boolean;
  /**
   * Strength the picture to edit is redrawn with (Generate's denoise / Inpaint strength). A replacement must redraw the
   * masked area completely: at Generate's default 0.8 Inpaint keeps the old object's shape and colour.
   */
  denoise?: number;
  /**
   * SAM masks of a one-click masked run grow outward by `maskGrow` source pixels and get a `maskBlur` soft edge (Generate's
   * Mask blur), so the replacement is not forced into the old object's exact silhouette.
   */
  maskGrow?: number;
  maskBlur?: number;
  /** With an object picture this strategy hands over the named strategy instead (when the chosen model fits it). */
  objectVia?: string;
}
/** `object`: the wizard also takes an optional object picture whose content goes into the picture to change. */
export interface WizardDescriptor { id: string; media: 'image'; fields: WizardField[]; strategies: WizardStrategy[]; library: string; object?: boolean }
/** The model facts a wizard needs; a subset of the native scan's LocalModel. */
export interface WizardModel { category: string; name: string; path: string; family?: string | null }
export interface WizardChoice { strategy: WizardStrategy; models: WizardModel[] }
export interface WizardPicture { name: string; path: string; src: string }
/**
 * One explicit hand-over into Generate. `size` is set only for reference edits (text-to-image keeps the picture's aspect); `references` follow the picture as further prompt references. `run` asks Generate to start the draft through its own Run path after applying it.
 * `mask` (masked edits with `run` only) is the *Replace what* text: Generate first masks the picture with its own SAM 3.1 text path, one mask layer per target, and starts the run only when a mask was found.
 */
export interface WizardHandoff {
  n: number; wizard: string; strategy: string; pipeline: 't2i' | 'i2i'; source: 'reference' | 'edit'; edit?: 'inpaint' | 'resample';
  model: { name: string; path: string }; picture: WizardPicture; references?: WizardPicture[]; positive: string; size?: Size; run?: boolean; mask?: string; denoise?: number;
  /** Masked edits: grow the SAM mask by this many pixels and set Generate's Mask blur. */
  maskGrow?: number; maskBlur?: number;
}
/** The picture a wizard's own run produced, in that job's native-held output folder. */
export interface WizardRunPicture { path: string; width: number; height: number; seed: number; checkpoint: string; ms?: number }
/**
 * Progress and outcome of a wizard run. Generate owns the submission, the queue and the polling; the wizard only shows
 * what its hand-over became and can stop that one job. `job` is the native-held status, kept so Stop targets it.
 */
export interface WizardRun {
  state: JobStatus['state']; value?: number; max?: number; preview?: string; error?: string;
  picture?: WizardRunPicture; job?: JobStatus;
  /** SAM 3.1 is still finding the mask; the drawing job has not been submitted yet. */
  masking?: boolean;
}
/** The job output file of a succeeded job as a local path, or undefined when its identity is not held. */
export function jobOutputPath(job: JobStatus, output: JobStatus['outputs'][number]): string | undefined {
  const root = job.outputRoot;
  if (!root) return undefined;
  const separator = root.includes('\\') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), ...output.subfolder.split(/[\\/]+/).filter(Boolean), output.filename].join(separator);
}

const modelCategories = ['checkpoints', 'diffusion_models', 'unet'];
const familyIds = new Set((families as { id: string }[]).map(f => f.id));
const fieldNames: WizardField[] = ['target', 'replacement'];
/** Families whose prompt encoder takes ordered reference pictures as `image 1`, `image 2` (TextEncodeQwenImage21). */
const referenceFamilies = new Set((families as { id: string; imagePrompting?: string }[]).filter(f => f.imagePrompting === 'qwen-image-2.1').map(f => f.id));

function validStrategy(s: unknown): s is WizardStrategy {
  if (!s || typeof s !== 'object') return false;
  const v = s as Record<string, unknown>;
  return typeof v.id === 'string' && /^[a-z][a-z0-9-]*$/.test(v.id)
    && Array.isArray(v.families) && v.families.length > 0 && v.families.every(f => typeof f === 'string' && familyIds.has(f))
    && (v.pipeline === 't2i' || v.pipeline === 'i2i')
    && (v.source === 'reference' ? v.pipeline === 't2i' && v.edit === undefined : v.source === 'edit' && v.pipeline === 'i2i' && (v.edit === 'inpaint' || v.edit === 'resample'))
    && typeof v.positive === 'string' && v.positive.length > 0 && v.positive.length <= 2000
    && (v.objectPositive === undefined) === (v.objectFamilies === undefined)
    && (v.objectPositive === undefined || (typeof v.objectPositive === 'string' && v.objectPositive.length > 0 && v.objectPositive.length <= 2000
      && Array.isArray(v.objectFamilies) && v.objectFamilies.length > 0 && v.objectFamilies.every(f => typeof f === 'string' && referenceFamilies.has(f) && (v.families as string[]).includes(f))))
    && typeof v.needsMask === 'boolean' && v.needsMask === (v.edit === 'inpaint')
    && (v.denoise === undefined || (v.source === 'edit' && typeof v.denoise === 'number' && v.denoise > 0 && v.denoise <= 1))
    && (v.maskGrow === undefined || (v.needsMask === true && Number.isSafeInteger(v.maskGrow) && (v.maskGrow as number) >= 0 && (v.maskGrow as number) <= 512))
    && (v.maskBlur === undefined || (v.needsMask === true && Number.isSafeInteger(v.maskBlur) && (v.maskBlur as number) >= 0 && (v.maskBlur as number) <= 31))
    && (v.objectVia === undefined || (typeof v.objectVia === 'string' && v.objectVia !== v.id && v.objectPositive === undefined));
}
/** Rejects malformed descriptors instead of half-applying them (unknown families, mismatched pipeline/source). */
export function validWizard(w: unknown): w is WizardDescriptor {
  if (!w || typeof w !== 'object') return false;
  const v = w as Record<string, unknown>;
  return typeof v.id === 'string' && /^[a-z][a-z0-9-]*$/.test(v.id) && v.media === 'image'
    && Array.isArray(v.fields) && v.fields.length > 0 && v.fields.every(f => fieldNames.includes(f as WizardField))
    && Array.isArray(v.strategies) && v.strategies.length > 0 && v.strategies.every(validStrategy)
    && new Set((v.strategies as WizardStrategy[]).map(s => s.id)).size === v.strategies.length
    && (v.strategies as WizardStrategy[]).every(s => s.objectVia === undefined || (v.strategies as WizardStrategy[]).some(o => o.id === s.objectVia && !!o.objectPositive))
    && typeof v.library === 'string' && v.library.trim().length > 0
    && (v.object === undefined || typeof v.object === 'boolean');
}
export const builtinWizards: WizardDescriptor[] = (data as unknown[]).filter(validWizard);

/** Installed models per strategy, in the strategy's family order and then by name; only known families count. */
export function wizardChoices(wizard: WizardDescriptor, models: readonly WizardModel[]): WizardChoice[] {
  return wizard.strategies.map(strategy => ({
    strategy,
    models: models.filter(m => modelCategories.includes(m.category) && !!m.family && strategy.families.includes(m.family))
      .sort((a, b) => strategy.families.indexOf(a.family!) - strategy.families.indexOf(b.family!) || a.name.localeCompare(b.name)),
  }));
}
/** The first strategy (in descriptor order) that has an installed model, or undefined when the Library is needed. */
export const preferredChoice = (choices: readonly WizardChoice[]) => choices.find(c => c.models.length > 0);

const placeholder = /\{(target|replacement)(?:\|([^{}]*))?\}/g;
/** Whether the object picture is used: the strategy has an object template and the chosen model's family takes reference pictures. */
export const usesObject = (strategy: WizardStrategy, family: string | null | undefined, hasObject: boolean) =>
  hasObject && !!strategy.objectPositive && !!family && !!strategy.objectFamilies?.includes(family);
const template = (strategy: WizardStrategy, withObject: boolean) => withObject && strategy.objectPositive ? strategy.objectPositive : strategy.positive;
/** Fills `{field}` (required) and `{field|fallback}` (optional) placeholders with trimmed, single-line user text. */
export function wizardPrompt(text: string, fields: Partial<Record<WizardField, string>>): string {
  return text.replace(placeholder, (_, k: WizardField, fallback?: string) => (fields[k] ?? '').replace(/\s+/g, ' ').trim() || (fallback ?? ''));
}
/** `withObject` is the result of `usesObject` for the chosen model. */
export const strategyPrompt = (strategy: WizardStrategy, fields: Partial<Record<WizardField, string>>, withObject = false) => wizardPrompt(template(strategy, withObject), fields);
/** Every required placeholder of the template in use must be filled. */
export const wizardReady = (strategy: WizardStrategy, fields: Partial<Record<WizardField, string>>, withObject = false) =>
  [...template(strategy, withObject).matchAll(placeholder)].every(([, k, fallback]) => fallback !== undefined || !!fields[k as WizardField]?.trim());

/**
 * Output canvas for a reference edit: the picture's aspect at the family's default pixel count, snapped to the
 * family grid (Qwen reference encoding needs 32). Undefined when the family declares no default size or the
 * result would not be a valid canvas — Generate then keeps its own size controls instead of guessing.
 */
export function wizardCanvas(familyId: string, picture: Size, grid?: number): Size | undefined {
  const f = (families as { id: string; multiple?: number; imagePrompting?: string; defaults?: { width?: number; height?: number } }[]).find(x => x.id === familyId);
  const d = f?.defaults;
  if (!d?.width || !d?.height || !(picture.width > 0 && picture.height > 0)) return undefined;
  const g = grid ?? (f?.imagePrompting === 'qwen-image-2.1' ? 32 : f?.multiple ?? 16);
  const size = canvasSize('auto', 'model', picture, 1, picture, { width: d.width, height: d.height }, picture, g);
  return validCanvas(size) && size.width % g === 0 && size.height % g === 0 ? size : undefined;
}

/** Opens the Library with the bundled catalog narrowed to `query`; it never downloads (consent stays in the Library). */
export const librarySearchEvent = 'deas:library-search';
export const findInLibrary = (query: string) => window.dispatchEvent(new CustomEvent(librarySearchEvent, { detail: query }));

/** Grid Generate's Inpaint requires for the picture to edit (mirrors Workbench: Qwen with prompt references needs 32, otherwise the family grid). */
export function editGrid(familyId: string, withReferences: boolean): number {
  const f = (families as { id: string; multiple?: number }[]).find(x => x.id === familyId);
  return withReferences && referenceFamilies.has(familyId) ? 32 : f?.multiple ?? 16;
}
