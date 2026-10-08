/** DEAS-owned diagnostic intent, not a Director/video recipe or widget schema. */
export interface DiagnosticImageIntentV1 {
  readonly recipeId: 'checkpoint-text-to-image-diagnostic';
  readonly version: 1;
  readonly positivePrompt: string;
  readonly negativePrompt: string;
  readonly checkpoint: string;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly cfg: number;
  readonly sampler: 'euler' | 'euler_ancestral' | 'dpmpp_2m';
  readonly scheduler: 'normal' | 'karras' | 'simple';
  readonly outputPrefix: string;
}

/** Supply fresh, verified backend identities. This pure compiler performs no discovery. */
export interface RecipeAllowlist {
  readonly nodes: readonly string[];
  readonly checkpoints: readonly string[];
  readonly samplers: readonly string[];
  readonly schedulers: readonly string[];
}
export type ApiLink = readonly [nodeId: string, outputIndex: number];
export interface ApiNode {
  readonly class_type: string;
  readonly inputs: Readonly<Record<string, string | number | ApiLink>>;
}
export interface CompiledRecipe {
  readonly recipeId: DiagnosticImageIntentV1['recipeId'];
  readonly version: 1;
  readonly graph: Readonly<Record<string, ApiNode>>;
  readonly requiredNodes: readonly string[];
  readonly requiredModels: readonly { readonly kind: 'checkpoint'; readonly identifier: string }[];
  readonly generationReady: false;
}

export type RecipeErrorCode = 'INVALID_ALLOWLIST' | 'MISSING_CAPABILITY' | 'MISSING_MODEL' | 'INVALID_INTENT' | 'UNKNOWN_RECIPE' | 'UNSUPPORTED_VERSION' | 'INVALID_INPUT';
export class RecipeCompileError extends Error {
  readonly code: RecipeErrorCode;
  readonly field: string;
  readonly remedy: string;
  constructor(code: RecipeErrorCode, field: string, message: string, remedy: string) {
    super(`${field}: ${message}`);
    this.name = 'RecipeCompileError';
    this.code = code;
    this.field = field;
    this.remedy = remedy;
  }
}
const requiredNodes = Object.freeze(['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bounds are diagnostic resource guards, not a claim of available GPU memory. */
function validateIntent(input: unknown): DiagnosticImageIntentV1 {
  if (!isRecord(input)) throw new RecipeCompileError('INVALID_INTENT', 'intent', 'Expected a domain intent object.', 'Provide the explicit versioned diagnostic text-to-image intent.');
  if (input.recipeId !== 'checkpoint-text-to-image-diagnostic') throw new RecipeCompileError('UNKNOWN_RECIPE', 'recipeId', 'Unknown recipe identity.', 'Use checkpoint-text-to-image-diagnostic; Director/video recipes are not implemented.');
  if (input.version !== 1) throw new RecipeCompileError('UNSUPPORTED_VERSION', 'version', 'Only numeric version 1 is supported.', 'Provide version: 1 without coercion or migrate the original intent explicitly.');
  const fields = ['recipeId', 'version', 'positivePrompt', 'negativePrompt', 'checkpoint', 'seed', 'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler', 'outputPrefix'];
  const invalid = (field: string, message: string, remedy: string): never => {
    throw new RecipeCompileError('INVALID_INPUT', field, message, remedy);
  };
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) invalid(key, 'Unknown domain intent field.', 'Remove unsupported fields; do not pass widget or canvas state.');
  }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) invalid(field, 'Missing required intent field.', 'Supply this explicit DEAS-owned intent field; no defaults are inferred.');
  }
  for (const field of ['positivePrompt', 'negativePrompt']) {
    const text = input[field];
    if (typeof text !== 'string' || text.length > 16384 || text.includes('\u0000')) invalid(field, 'Expected a prompt string of at most 16384 characters without NUL.', 'Supply a bounded prompt string; an empty prompt is permitted.');
  }
  const checkpoint = input.checkpoint;
  if (typeof checkpoint !== 'string' || checkpoint.length > 255 || !checkpoint.split('/').every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..' && !/[^A-Za-z0-9_.-]/u.test(segment))) {
    invalid('checkpoint', 'Unsafe model identifier.', 'Use the exact verified relative identifier with safe ASCII path segments, never a host path or URL.');
  }
  for (const [field, min, max, integer, alignment] of [
    ['seed', 0, Number.MAX_SAFE_INTEGER, true, 1],
    ['width', 64, 2048, true, 8], ['height', 64, 2048, true, 8],
    ['steps', 1, 150, true, 1], ['cfg', 0, 30, false, 1],
  ] as const) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && (!Number.isSafeInteger(value) || value % alignment !== 0))) {
      invalid(field, 'Numeric value is out of bounds, unsafe, or unaligned.', `Supply a finite ${integer ? 'safe integer' : 'number'} in [${min}, ${max}]${alignment > 1 ? ` aligned to ${alignment}` : ''}.`);
    }
  }
  for (const [field, choices] of [['sampler', ['euler', 'euler_ancestral', 'dpmpp_2m']], ['scheduler', ['normal', 'karras', 'simple']]] as const) {
    if (typeof input[field] !== 'string' || !(choices as readonly string[]).includes(input[field] as string)) invalid(field, 'Unsupported recipe enum.', `Choose an explicitly supported ${field}: ${choices.join(', ')}.`);
  }
  const prefix = input.outputPrefix;
  if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > 128 || /[^A-Za-z0-9_-]/u.test(prefix)) invalid('outputPrefix', 'Unsafe output prefix.', 'Use 1–128 ASCII letters, digits, underscores or hyphens; no paths.');
  return input as unknown as DiagnosticImageIntentV1;
}

/** Pure compilation only: allowlists must be verified by the caller, not user declarations. */
export function compileRecipe(input: unknown, verified: unknown): CompiledRecipe {
  const intent = validateIntent(input);
  if (!isRecord(verified) || !['nodes', 'checkpoints', 'samplers', 'schedulers'].every(key =>
    Object.hasOwn(verified, key) && Array.isArray(verified[key]) && Array.from(verified[key]).every((v: unknown) => typeof v === 'string' && v.length > 0))) {
    throw new RecipeCompileError('INVALID_ALLOWLIST', 'allowlist', 'Explicit capability/model lists are required.', 'Supply all four string arrays from a verified backend probe.');
  }
  const allowlist = verified as unknown as RecipeAllowlist;
  for (const node of requiredNodes) {
    if (!allowlist.nodes.includes(node)) throw new RecipeCompileError('MISSING_CAPABILITY', node, 'Required built-in node is unavailable.', 'Verify a compatible backend with this built-in node before compiling.');
  }
  if (!allowlist.checkpoints.includes(intent.checkpoint)) throw new RecipeCompileError('MISSING_MODEL', 'checkpoint', 'Checkpoint is not in the verified model list.', 'Select an exact checkpoint identifier from the verified backend model list.');
  for (const [field, available] of [['sampler', allowlist.samplers], ['scheduler', allowlist.schedulers]] as const) {
    if (!available.includes(intent[field])) throw new RecipeCompileError('MISSING_CAPABILITY', field, 'Choice is not verified on this backend.', 'Select a choice available in the verified backend capability list.');
  }
  const result: CompiledRecipe = {
    recipeId: intent.recipeId, version: 1, generationReady: false,
    requiredNodes,
    requiredModels: [{ kind: 'checkpoint', identifier: intent.checkpoint }],
    graph: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: intent.checkpoint } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: intent.positivePrompt, clip: ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: intent.negativePrompt, clip: ['1', 1] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: intent.width, height: intent.height, batch_size: 1 } },
      '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: intent.seed, steps: intent.steps, cfg: intent.cfg, sampler_name: intent.sampler, scheduler: intent.scheduler, denoise: 1 } },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: intent.outputPrefix } },
    },
  };
  for (const node of Object.values(result.graph)) {
    for (const value of Object.values(node.inputs)) if (Array.isArray(value)) Object.freeze(value);
    Object.freeze(node.inputs);
    Object.freeze(node);
  }
  Object.freeze(result.graph);
  for (const model of result.requiredModels) Object.freeze(model);
  Object.freeze(result.requiredModels);
  return Object.freeze(result);
}
