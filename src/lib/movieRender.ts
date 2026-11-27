/**
 * Movie Maker render settings (UX-22d8): the canvas and the sampling a shot is handed to Generate with. Two sources:
 * - `movie` (default): the movie's own settings — Generate's resolution choices (model default, 480p, 720p, … MP) on the movie's aspect,
 *   and per model the starting Steps/CFG/sampler/scheduler from family data, including a declared variant (a turbo merge samples
 *   differently from the base model). The movie's Steps/CFG override the default model's values; a scene with its own model uses that
 *   model's values unless the scene sets its own. Everything is computed here and shown before it is handed over.
 * - `generate`: Generate's own settings for the model (resolution and sampling as Generate shows them); only the aspect is handed over.
 * Pure: no React, no IPC.
 */
import families from '../families/builtin.json' with { type: 'json' };
import { canvasSize, resolutions, validCanvas, type Size } from './resolution.ts';
import type { MovieItem, MovieManifest, MovieRender } from './movieManifest.ts';

export interface Sampling { steps: number; cfg: number; sampler: string; scheduler: string }
type FamilyData = { id: string; multiple?: number; defaults?: { width?: number; height?: number; steps: number; cfg: number; sampler: string; scheduler: string }; variants?: { id: string; fileMatch: string[]; defaults: Partial<Sampling>; evidence?: string }[] };
const familyData = (id: string) => (families as FamilyData[]).find(f => f.id === id);
/** Generate's resolution choices a movie can use (no fixed size, no custom megapixels). */
export const MOVIE_RESOLUTIONS: readonly string[] = ['model', ...Object.keys(resolutions)];
export const RENDER_DEFAULT: Required<Pick<MovieRender, 'source' | 'resolution'>> = { source: 'movie', resolution: 'model' };
export const movieRender = (m: MovieManifest) => ({ ...RENDER_DEFAULT, ...m.render });

/** The variant of a family a file name declares (family data `variants[].fileMatch`, whole words of the lower-cased name). */
export function modelVariant(familyId: string, fileName: string): { id: string; evidence?: string } | undefined {
  const name = fileName.toLowerCase();
  const v = familyData(familyId)?.variants?.find(x => x.fileMatch.some(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[^a-z0-9]/g, '')}([^a-z0-9]|$)`).test(name)));
  return v && { id: v.id, ...(v.evidence ? { evidence: v.evidence } : {}) };
}
/** Starting Steps/CFG/sampler/scheduler of a model: its family's defaults, with a declared variant's values on top. */
export function startingSampling(familyId: string, fileName: string): Sampling | undefined {
  const f = familyData(familyId), d = f?.defaults;
  if (!d) return undefined;
  const v = f.variants?.find(x => x.id === modelVariant(familyId, fileName)?.id);
  return { steps: d.steps, cfg: d.cfg, sampler: d.sampler, scheduler: d.scheduler, ...v?.defaults };
}
/** The model a shot is made with (its own when set, else the movie's default) — for the settings shown and handed over. */
export function shotSampling(m: MovieManifest, shot: MovieItem | undefined, familyId: string, modelName: string, defaultModelName: string): Sampling | undefined {
  const start = startingSampling(familyId, modelName);
  if (!start) return undefined;
  const r = movieRender(m);
  // The movie's Steps/CFG belong to its default model; another model starts from its own values.
  const own = !shot?.model || shot.model === defaultModelName;
  const base = own ? { ...start, ...(r.steps !== undefined ? { steps: r.steps } : {}), ...(r.cfg !== undefined ? { cfg: r.cfg } : {}) } : start;
  return { ...base, ...(shot?.sampling?.steps !== undefined ? { steps: shot.sampling.steps } : {}), ...(shot?.sampling?.cfg !== undefined ? { cfg: shot.sampling.cfg } : {}) };
}
/** Exact canvas of a fixed aspect at a resolution choice, the way Generate computes it (Settings → resolution), on the family grid. */
export function movieSize(aspect: string, resolution: string, familyId: string): Size | undefined {
  const f = familyData(familyId), d = f?.defaults;
  if (!d?.width || !d.height || aspect === 'auto' || !MOVIE_RESOLUTIONS.includes(resolution)) return undefined;
  const grid = f?.multiple ?? 16;
  const size = canvasSize(aspect, resolution, { width: 1, height: 1 }, 1, { width: 0, height: 0 }, { width: d.width, height: d.height }, undefined, grid);
  return validCanvas(size) && size.width % grid === 0 && size.height % grid === 0 ? size : undefined;
}
/**
 * What a shot hands over for its canvas: a fixed size (movie source, fixed aspect), Generate's auto aspect with the movie's resolution
 * choice (movie source, auto), or only the aspect (Generate source: Generate keeps its own resolution).
 */
export function renderCanvas(m: MovieManifest, familyId: string): { size: Size } | { aspect: string; resolution?: string } | Record<string, never> {
  const r = movieRender(m);
  if (r.source === 'generate') return { aspect: m.aspect };
  if (m.aspect === 'auto') return { aspect: 'auto', resolution: r.resolution };
  const size = movieSize(m.aspect, r.resolution, familyId);
  return size ? { size } : {};
}
/** The sampling a shot hands over: none from Generate's source (Generate keeps its own). */
export function renderSampling(m: MovieManifest, shot: MovieItem | undefined, familyId: string, modelName: string, defaultModelName: string): { sampling: Sampling } | Record<string, never> {
  if (movieRender(m).source === 'generate') return {};
  const s = shotSampling(m, shot, familyId, modelName, defaultModelName);
  return s ? { sampling: s } : {};
}
