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
  /** Any sampler/scheduler the backend lists in object_info. */
  readonly sampler: string;
  readonly scheduler: string;
  readonly outputPrefix: string;
  /** Optional LoRA chain applied after the checkpoint; strength feeds both model and CLIP. */
  readonly loras?: readonly { readonly name: string; readonly strength: number }[];
  /** Image-to-image: a file name from the backend's input folder plus denoise strength (given together). */
  readonly inputImage?: string;
  readonly denoise?: number;
  /** Inpaint mask uploaded by `native_mask_upload` (`deas-masks/<uuid>.png`, white = repaint), at the unresized source's size. */
  readonly inputMask?: string;
  /** Up to 4 extra images (input or `[output]` files) pasted onto the source in source pixels before encoding. */
  readonly inputLayers?: readonly { readonly image: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
  readonly inputResize?: { readonly width: number; readonly height: number; readonly crop: 'disabled' | 'center'; readonly pad?: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } };
  /** Load `checkpoint` as a diffusion model (UNETLoader) with its own text encoder (CLIPLoader type) and VAE. */
  readonly diffusion?: { readonly textEncoder: string; readonly clipType: string; readonly vae: string };
  /** Workbench Options: model patches (one attention backend, step cache, torch.compile) and tiled VAE. */
  readonly options?: RunOptions;
  /** Model-fixed schedule (steps + 1 values, descending to 0): ManualSigmas → SamplerCustomAdvanced replaces KSampler; `scheduler` is then unused. */
  readonly sigmas?: readonly number[];
}
export interface RunOptions {
  /** `ModelAttentionBackend` choice; exclusive with `sage`. */
  readonly attention?: string;
  /** `PathchSageAttentionKJ` mode (KJNodes). */
  readonly sage?: string;
  readonly cache?: { readonly node: 'EasyCache' | 'LazyCache'; readonly threshold: number };
  /** `TorchCompileModel` backend. */
  readonly compile?: string;
  /** Tile edge for VAEDecodeTiled/VAEEncodeTiled, 256–4096 in steps of 64. */
  readonly vaeTile?: number;
}

/** Supply fresh, verified backend identities. This pure compiler performs no discovery. */
export interface RecipeAllowlist {
  readonly nodes: readonly string[];
  readonly checkpoints: readonly string[];
  readonly loras?: readonly string[];
  readonly images?: readonly string[];
  readonly samplers: readonly string[];
  readonly schedulers: readonly string[];
  readonly diffusionModels?: readonly string[];
  readonly textEncoders?: readonly string[];
  readonly clipTypes?: readonly string[];
  readonly vaes?: readonly string[];
  readonly attention?: readonly string[];
  readonly sage?: readonly string[];
  readonly compile?: readonly string[];
}
export type ApiLink = readonly [nodeId: string, outputIndex: number];
export interface ApiNode {
  readonly class_type: string;
  readonly inputs: Readonly<Record<string, string | number | boolean | ApiLink>>;
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
    if (!fields.includes(key) && !['loras', 'inputImage', 'denoise', 'diffusion', 'inputResize', 'inputMask', 'inputLayers', 'options', 'sigmas'].includes(key)) invalid(key, 'Unknown domain intent field.', 'Remove unsupported fields; do not pass widget or canvas state.');
  }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) invalid(field, 'Missing required intent field.', 'Supply this explicit DEAS-owned intent field; no defaults are inferred.');
  }
  for (const field of ['positivePrompt', 'negativePrompt']) {
    const text = input[field];
    if (typeof text !== 'string' || text.length > 16384 || text.includes('\u0000')) invalid(field, 'Expected a prompt string of at most 16384 characters without NUL.', 'Supply a bounded prompt string; an empty prompt is permitted.');
  }
  // Same grammar as native `model_name`: spaces and non-ASCII letters allowed; no traversal, host paths, URLs or control characters.
  const safeModel = (id: unknown): id is string => typeof id === 'string' && new TextEncoder().encode(id).length <= 255 && id.split('/').every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..' && segment.trim() === segment && !/[\p{Cc}\\:%]/u.test(segment));
  if (!safeModel(input.checkpoint)) invalid('checkpoint', 'Unsafe model identifier.', 'Use the exact verified relative identifier, never a host path or URL.');
  if (Object.hasOwn(input, 'inputImage') !== Object.hasOwn(input, 'denoise')) invalid('inputImage', 'inputImage and denoise must be given together.', 'Supply both for image-to-image or neither for text-to-image.');
  if (Object.hasOwn(input, 'inputImage') && !safeModel(input.inputImage)) invalid('inputImage', 'Unsafe input image identifier.', 'Use a file name from the backend input folder.');
  if (Object.hasOwn(input, 'denoise') && !(typeof input.denoise === 'number' && Number.isFinite(input.denoise) && input.denoise >= 0 && input.denoise <= 1)) invalid('denoise', 'Denoise must be a finite number in [0, 1].', 'Supply a denoise strength between 0 and 1.');
  if (Object.hasOwn(input, 'inputMask') && (!Object.hasOwn(input, 'inputImage') || Object.hasOwn(input, 'inputResize')
    || !/^deas-masks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/u.test(String(input.inputMask)))) invalid('inputMask', 'Invalid inpaint mask.', 'Upload the mask natively and use it with an unresized inputImage.');
  const layers = input.inputLayers;
  if (Object.hasOwn(input, 'inputLayers') && (!Object.hasOwn(input, 'inputImage') || !Array.isArray(layers) || layers.length < 1 || layers.length > 4
    || !layers.every(l => isRecord(l) && Object.keys(l).length === 5 && safeModel(l.image) && ['x', 'y', 'width', 'height'].every(k =>
      Number.isSafeInteger(l[k]) && (l[k] as number) <= 8192 && ((l[k] as number) > 0 || ((k === 'x' || k === 'y') && l[k] === 0)))))) invalid('inputLayers', 'Invalid image layers.', 'Supply 1-4 {image, x, y, width, height} in source pixels on an inputImage.');
  const loras = input.loras ?? [];
  if (!Array.isArray(loras) || loras.length > 8 || !loras.every(l => isRecord(l) && Object.keys(l).length === 2 && safeModel(l.name)
    && typeof l.strength === 'number' && Number.isFinite(l.strength) && Math.abs(l.strength) <= 10)) {
    invalid('loras', 'Invalid LoRA list.', 'Supply at most 8 verified {name, strength in [-10, 10]} entries.');
  }
  for (const [field, min, max, integer, alignment] of [
    ['seed', 0, Number.MAX_SAFE_INTEGER, true, 1],
    ['width', 64, 8192, true, 8], ['height', 64, 8192, true, 8],
    ['steps', 1, 150, true, 1], ['cfg', 0, 30, false, 1],
  ] as const) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && (!Number.isSafeInteger(value) || value % alignment !== 0))) {
      invalid(field, 'Numeric value is out of bounds, unsafe, or unaligned.', `Supply a finite ${integer ? 'safe integer' : 'number'} in [${min}, ${max}]${alignment > 1 ? ` aligned to ${alignment}` : ''}.`);
    }
  }
  if ((input.width as number) * (input.height as number) > 16_777_216) invalid('width', 'Pixel limit exceeded.', 'Use at most 16,777,216 output pixels.');
  if (Object.hasOwn(input, 'inputResize')) {
    const r = input.inputResize;
    const aligned = (v: unknown, min: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= 8192 && v % 8 === 0;
    if (!Object.hasOwn(input, 'inputImage') || !isRecord(r) || ![3, 4].includes(Object.keys(r).length)
      || Object.keys(r).some(k => !['width', 'height', 'crop', 'pad'].includes(k)) || !['width', 'height', 'crop'].every(k => Object.hasOwn(r, k))
      || !aligned(r.width, 8) || !aligned(r.height, 8) || !['disabled', 'center'].includes(r.crop as string)) {
      invalid('inputResize', 'Invalid image resize.', 'Supply inputImage + denoise and {width, height, crop} with positive dimensions aligned to 8.');
    }
    const resize = r as Record<string, unknown>;
    const pad = resize.pad;
    if (Object.hasOwn(resize, 'pad') && (!isRecord(pad) || Object.keys(pad).length !== 4 || !['left', 'right', 'top', 'bottom'].every(k => Object.hasOwn(pad, k) && aligned(pad[k], 0)))) {
      invalid('inputResize', 'Invalid padding.', 'Supply exactly four nonnegative pads aligned to 8, at most 8192 each.');
    }
    const pads = pad as Record<string, number> | undefined;
    if ((resize.width as number) + (pads?.left ?? 0) + (pads?.right ?? 0) !== input.width
      || (resize.height as number) + (pads?.top ?? 0) + (pads?.bottom ?? 0) !== input.height) {
      invalid('inputResize', 'Resize plus padding must match output dimensions.', 'Use resize dimensions plus pads equal to intent width and height.');
    }
  }
  const safeChoice = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(v);
  for (const field of ['sampler', 'scheduler']) {
    if (!safeChoice(input[field])) invalid(field, 'Unsafe recipe enum.', `Choose a ${field} the backend lists.`);
  }
  const d = input.diffusion;
  if (d !== undefined && !(isRecord(d) && Object.keys(d).length === 3 && safeModel(d.textEncoder) && safeModel(d.vae) && safeChoice(d.clipType))) {
    invalid('diffusion', 'Invalid diffusion loader.', 'Supply {textEncoder, clipType, vae} from the verified backend lists.');
  }
  // Same grammar as native `safe_option`: option enums may carry spaces and `+` (`pytorch attention`, `…fp8_cuda++`).
  const safeOption = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9 _.+-]{1,64}$/u.test(v) && v.trim() === v;
  const o = input.options;
  if (o !== undefined) {
    const c = isRecord(o) ? o.cache : undefined;
    if (!isRecord(o) || Object.keys(o).some(k => !['attention', 'sage', 'cache', 'compile', 'vaeTile'].includes(k))
      || ['attention', 'sage', 'compile'].some(k => Object.hasOwn(o, k) && !safeOption(o[k]))
      || (Object.hasOwn(o, 'attention') && Object.hasOwn(o, 'sage'))
      || (c !== undefined && !(isRecord(c) && Object.keys(c).length === 2 && ['EasyCache', 'LazyCache'].includes(c.node as string)
        && typeof c.threshold === 'number' && Number.isFinite(c.threshold) && c.threshold >= 0 && c.threshold <= 3))
      || (Object.hasOwn(o, 'vaeTile') && !(Number.isSafeInteger(o.vaeTile) && (o.vaeTile as number) >= 256 && (o.vaeTile as number) <= 4096 && (o.vaeTile as number) % 64 === 0))) {
      invalid('options', 'Invalid options.', 'Use one attention backend, listed choices, a cache threshold in [0, 3] and a VAE tile of 256–4096 in steps of 64.');
    }
  }
  const s = input.sigmas;
  if (s !== undefined && !(Array.isArray(s) && s.length === (input.steps as number) + 1 && s.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000)
    && s.every((v, n) => n === 0 || v < s[n - 1]) && s[s.length - 1] === 0)) {
    invalid('sigmas', 'Invalid sigmas.', 'Supply steps + 1 finite values, strictly descending and ending at 0.');
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
  const sigmaNodes = ['RandomNoise', 'CFGGuider', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced'];
  for (const node of [...requiredNodes, ...(intent.inputImage !== undefined ? ['LoadImage', 'VAEEncode'] : []), ...(intent.inputResize ? ['ImageScale', ...(intent.inputResize.pad ? ['ImagePadForOutpaint'] : [])] : []), ...(intent.sigmas ? sigmaNodes : []), ...(intent.inputMask ? ['LoadImageMask', 'SetLatentNoiseMask', 'ImageCompositeMasked'] : []), ...(intent.inputLayers ? ['ImageScale', 'ImageCompositeMasked'] : [])]) {
    if (!allowlist.nodes.includes(node)) throw new RecipeCompileError('MISSING_CAPABILITY', node, 'Required built-in node is unavailable.', 'Verify a compatible backend with this built-in node before compiling.');
  }
  const d = intent.diffusion;
  for (const node of d ? ['UNETLoader', 'CLIPLoader', 'VAELoader'] : []) {
    if (!allowlist.nodes.includes(node)) throw new RecipeCompileError('MISSING_CAPABILITY', node, 'Required built-in node is unavailable.', 'Verify a compatible backend with this built-in node before compiling.');
  }
  if (!(d ? allowlist.diffusionModels ?? [] : allowlist.checkpoints).includes(intent.checkpoint)) throw new RecipeCompileError('MISSING_MODEL', 'checkpoint', 'Checkpoint is not in the verified model list.', 'Select an exact checkpoint identifier from the verified backend model list.');
  if (d && !(allowlist.textEncoders?.includes(d.textEncoder) && allowlist.vaes?.includes(d.vae) && allowlist.clipTypes?.includes(d.clipType))) throw new RecipeCompileError('MISSING_MODEL', 'diffusion', 'Text encoder, VAE or CLIP type is not in the verified backend lists.', 'Select files and a CLIP type the backend lists.');
  // object_info lists only the input folder; ComfyUI resolves an `[output]` file itself (containment + existence in LoadImage).
  for (const image of [intent.inputImage, ...(intent.inputLayers ?? []).map(l => l.image)]) if (image !== undefined && !image.endsWith(' [output]') && !allowlist.images?.includes(image)) throw new RecipeCompileError('MISSING_MODEL', 'inputImage', 'Input image is not in the backend input folder list.', 'Pick a file the backend lists in its input folder.');
  const loras = intent.loras ?? [];
  for (const lora of loras) {
    if (!allowlist.loras?.includes(lora.name)) throw new RecipeCompileError('MISSING_MODEL', 'loras', 'LoRA is not in the verified model list.', 'Select exact LoRA identifiers from the verified backend model list.');
  }
  for (const [field, available] of [['sampler', allowlist.samplers], ['scheduler', allowlist.schedulers]] as const) {
    if (!available.includes(intent[field])) throw new RecipeCompileError('MISSING_CAPABILITY', field, 'Choice is not verified on this backend.', 'Select a choice available in the verified backend capability list.');
  }
  const o = intent.options ?? {};
  const tiled = o.vaeTile !== undefined;
  const patches: (readonly [id: string, node: string, inputs: Record<string, string | number | boolean>])[] = [
    ...(o.attention !== undefined ? [['A', 'ModelAttentionBackend', { attention: o.attention }] as const] : []),
    ...(o.sage !== undefined ? [['K', 'PathchSageAttentionKJ', { sage_attention: o.sage }] as const] : []),
    // start/end are the nodes' own defaults.
    ...(o.cache ? [['E', o.cache.node, { reuse_threshold: o.cache.threshold, start_percent: 0.15, end_percent: 0.95, verbose: false }] as const] : []),
    ...(o.compile !== undefined ? [['T', 'TorchCompileModel', { backend: o.compile }] as const] : []),
  ];
  for (const [field, value] of [['attention', o.attention], ['sage', o.sage], ['compile', o.compile]] as const) {
    if (value !== undefined && !allowlist[field]?.includes(value)) throw new RecipeCompileError('MISSING_CAPABILITY', `options.${field}`, 'Choice is not verified on this backend.', 'Select a choice the backend lists.');
  }
  for (const node of [...patches.map(p => p[1]), ...(tiled ? ['VAEDecodeTiled', ...(intent.inputImage !== undefined ? ['VAEEncodeTiled'] : [])] : [])]) {
    if (!allowlist.nodes.includes(node)) throw new RecipeCompileError('MISSING_CAPABILITY', node, 'Option node is unavailable.', 'Install the node pack or turn the option off.');
  }
  // LoraLoaders chain after the loaders; the last one feeds the sampler and both encoders.
  const chain: Record<string, ApiNode> = d ? {
    C: { class_type: 'CLIPLoader', inputs: { clip_name: d.textEncoder, type: d.clipType } },
    V: { class_type: 'VAELoader', inputs: { vae_name: d.vae } },
  } : {};
  let model: ApiLink = ['1', 0], clip: ApiLink = d ? ['C', 0] : ['1', 1];
  const vae: ApiLink = d ? ['V', 0] : ['1', 2];
  loras.forEach((lora, n) => {
    const id = `L${n + 1}`;
    chain[id] = { class_type: 'LoraLoader', inputs: { model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength } };
    model = [id, 0]; clip = [id, 1];
  });
  // Patches chain after the LoRAs; compile last so it sees every other patch.
  for (const [id, node, inputs] of patches) {
    chain[id] = { class_type: node, inputs: { ...inputs, model } };
    model = [id, 0];
  }
  // Spatial tiles; the temporal values are the node defaults (used by video VAEs only).
  const tiles: Record<string, number> = tiled ? { tile_size: o.vaeTile!, overlap: 64, temporal_size: 64, temporal_overlap: 8 } : {};
  const result: CompiledRecipe = {
    recipeId: intent.recipeId, version: 1, generationReady: false,
    requiredNodes,
    requiredModels: [{ kind: 'checkpoint', identifier: intent.checkpoint }],
    graph: {
      '1': d ? { class_type: 'UNETLoader', inputs: { unet_name: intent.checkpoint, weight_dtype: 'default' } } : { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: intent.checkpoint } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: intent.positivePrompt, clip } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: intent.negativePrompt, clip } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: intent.width, height: intent.height, batch_size: 1 } },
      '5': { class_type: 'KSampler', inputs: { model, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: intent.seed, steps: intent.steps, cfg: intent.cfg, sampler_name: intent.sampler, scheduler: intent.scheduler, denoise: 1 } },
      '6': { class_type: tiled ? 'VAEDecodeTiled' : 'VAEDecode', inputs: { samples: ['5', 0], vae, ...tiles } },
      '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: intent.outputPrefix } },
      ...chain,
      ...(intent.inputImage !== undefined ? { '8': { class_type: 'LoadImage', inputs: { image: intent.inputImage } }, '9': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae } } } : {}),
    },
  };
  if (intent.sigmas) {
    const graph = result.graph as Record<string, ApiNode>;
    graph.N = { class_type: 'RandomNoise', inputs: { noise_seed: intent.seed } };
    graph.G = { class_type: 'CFGGuider', inputs: { model, positive: ['2', 0], negative: ['3', 0], cfg: intent.cfg } };
    graph.Q = { class_type: 'KSamplerSelect', inputs: { sampler_name: intent.sampler } };
    graph.Z = { class_type: 'ManualSigmas', inputs: { sigmas: intent.sigmas.join(', ') } };
    graph['5'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['N', 0], guider: ['G', 0], sampler: ['Q', 0], sigmas: ['Z', 0], latent_image: ['4', 0] } };
  }
  if (intent.inputImage !== undefined) {
    const graph = result.graph as Record<string, ApiNode>;
    const r = intent.inputResize;
    // Layers are pasted in source pixels, so they come before any resize and stay under an inpaint composite.
    // shortcut: pasted opaque (alpha ignored); feed LoadImage's inverted mask when cut-outs matter.
    let base: ApiLink = ['8', 0];
    (intent.inputLayers ?? []).forEach((l, n) => {
      graph[`I${n}`] = { class_type: 'LoadImage', inputs: { image: l.image } };
      graph[`R${n}`] = { class_type: 'ImageScale', inputs: { image: [`I${n}`, 0], upscale_method: 'lanczos', width: l.width, height: l.height, crop: 'disabled' } };
      graph[`B${n}`] = { class_type: 'ImageCompositeMasked', inputs: { destination: base, source: [`R${n}`, 0], x: l.x, y: l.y, resize_source: false } };
      base = [`B${n}`, 0];
    });
    graph['9'] = { class_type: 'VAEEncode', inputs: { pixels: base, vae } };
    if (r) {
      graph.S = { class_type: 'ImageScale', inputs: { image: base, upscale_method: 'lanczos', width: r.width, height: r.height, crop: r.crop } };
      if (r.pad) graph.P = { class_type: 'ImagePadForOutpaint', inputs: { image: ['S', 0], ...r.pad, feathering: 0 } };
      graph['9'] = { class_type: 'VAEEncode', inputs: { pixels: [r.pad ? 'P' : 'S', 0], vae } };
    }
    if (tiled) graph['9'] = { class_type: 'VAEEncodeTiled', inputs: { ...graph['9'].inputs, ...tiles } };
    delete graph['4'];
    graph['5'] = { ...graph['5'], inputs: { ...graph['5'].inputs, latent_image: ['9', 0], ...(intent.sigmas ? {} : { denoise: intent.denoise! }) } };
    if (intent.inputMask) {
      // Only the painted area is resampled, then composited onto the untouched source pixels.
      graph.W = { class_type: 'LoadImageMask', inputs: { image: intent.inputMask, channel: 'red' } };
      graph.X = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['9', 0], mask: ['W', 0] } };
      graph.Y = { class_type: 'ImageCompositeMasked', inputs: { destination: base, source: ['6', 0], x: 0, y: 0, resize_source: false, mask: ['W', 0] } };
      graph['5'] = { ...graph['5'], inputs: { ...graph['5'].inputs, latent_image: ['X', 0] } };
      graph['7'] = { ...graph['7'], inputs: { ...graph['7'].inputs, images: ['Y', 0] } };
    }
  }
  // Civitai links resources only by hash from an A1111 `parameters` chunk, which core SaveImage cannot write; the DaSiWa saver (Output package) adds it beside prompt/workflow.
  if (['DaSiWa_MetadataImageSaver', 'DaSiWa_MetadataConfig'].every(node => allowlist.nodes.includes(node))) {
    const graph = result.graph as Record<string, ApiNode>;
    graph.M = { class_type: 'DaSiWa_MetadataConfig', inputs: { save_workflow: true, model_hash: '', node_positive: ['2', 0], node_negative: ['3', 0], node_model: ['1', 0], node_latent: ['5', 0] } };
    graph['7'] = { class_type: 'DaSiWa_MetadataImageSaver', inputs: { images: graph['7'].inputs.images, filename_prefix: intent.outputPrefix, file_format: 'png', compression: 44, save_output: true, metadata_config: ['M', 0] } };
  }
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
