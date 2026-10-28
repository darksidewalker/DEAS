import { aspects, canvasSize, validCanvas, type Size } from './resolution.ts';

/** Current Studio geometry, supplied without changing generation controls. */
export interface ForgeCanvasContext {
  key: string;
  effective: Size | null;
  model: Size;
  grid: number;
  /** Mandatory alignment can be smaller than the preferred ratio bucket grid. */
  requiredGrid?: number;
  resolution: string;
  megapixels: number;
  fixed: Size;
  readonly acceptsCanvas?: (size: Size) => boolean;
}

/** Geometry consumed by the result being explicitly sent to Studio. */
export interface ForgeSendCanvas {
  canvas: Size;
  contextKey: string;
}

export const forgeAspectChoices = ['N/A', ...aspects] as const;

/** Recognize saved registry labels without making an unknown choice a default. */
export function canonicalForgeAspect(value: string): string | null {
  const choice = value.trim();
  if (choice === '' || choice === 'N/A') return 'N/A';
  if ((aspects as readonly string[]).includes(choice)) return choice;
  // Older registries use labels such as "2:3 Portrait" and "2:2 Square".
  const numeric = /^(\d+)\s*:\s*(\d+)(?:\s*[A-Za-z][A-Za-z0-9 /_-]*)?$/.exec(choice);
  if (!numeric) return null;
  const width = Number(numeric[1]), height = Number(numeric[2]);
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) return null;
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  const reduced = `${width / a}:${height / a}`;
  return (aspects as readonly string[]).includes(reduced) ? reduced : null;
}

export interface ResolvedForgeCanvas {
  choice: string;
  canvas?: Size;
  error?: string;
}

const aligned = (size: Size, grid: number) =>
  validCanvas(size) && size.width % grid === 0 && size.height % grid === 0;

/** Resolve once for authoring; generation preparation remains authoritative. */
export function resolveForgeCanvas(
  aspect: string,
  custom: Size,
  context?: ForgeCanvasContext,
  route: 'image' | 'layout' = 'image',
): ResolvedForgeCanvas {
  const canonical = canonicalForgeAspect(aspect);
  const choice = canonical ?? aspect;
  if (canonical === null) return { choice, error: 'forge.canvas.unknown' };
  if (canonical === 'N/A') return { choice };
  if (!context || !context.key.trim() || !context.effective) {
    return { choice, error: 'forge.canvas.unresolved' };
  }
  const { effective, grid } = context;
  const requiredGrid = context.requiredGrid ?? grid;
  if (!Number.isInteger(grid) || grid < 8 || grid > 8192 || grid % 8 !== 0
    || !Number.isInteger(requiredGrid) || requiredGrid < 8 || requiredGrid > 8192 || requiredGrid % 8 !== 0
    || !validCanvas(effective) || !validCanvas(context.model)) {
    return { choice, error: 'forge.canvas.invalid' };
  }
  if (canonical === 'custom'
    && ![custom.width, custom.height].every(n => Number.isFinite(n) && n >= 1 && n <= 100)) {
    return { choice, error: 'forge.canvas.invalid' };
  }
  // A fixed Settings canvas supplies the pixel budget, not a ratio override.
  const fixed = context.resolution === 'fixed';
  const canvas = canonical === 'auto'
    ? { width: effective.width, height: effective.height }
    : canvasSize(canonical, fixed ? 'custom' : context.resolution, custom,
      fixed ? effective.width * effective.height / 1024 ** 2 : context.megapixels,
      context.fixed, context.model, undefined, grid);
  if (!aligned(canvas, requiredGrid)
    || (route === 'layout' && (canvas.width < 128 || canvas.height < 128
      || canvas.width % 16 !== 0 || canvas.height % 16 !== 0))) {
    return { choice, error: 'forge.canvas.invalid' };
  }
  return { choice, canvas };
}
