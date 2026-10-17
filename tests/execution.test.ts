import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe, RecipeCompileError, type DiagnosticImageIntentV1, type RecipeAllowlist } from '../src/lib/execution.ts';

const intent: DiagnosticImageIntentV1 = {
  recipeId: 'checkpoint-text-to-image-diagnostic', version: 1,
  positivePrompt: 'a quiet forest', negativePrompt: 'blur', checkpoint: 'baseline/model.safetensors',
  seed: 42, width: 512, height: 768, steps: 20, cfg: 7,
  sampler: 'euler', scheduler: 'normal', outputPrefix: 'DEAS_diagnostic',
};
const allowlist: RecipeAllowlist = {
  nodes: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'],
  checkpoints: ['baseline/model.safetensors'], samplers: ['euler'], schedulers: ['normal'],
};

test('baseline diagnostic compiles deterministic built-in graph, never Director readiness', () => {
  const result = compileRecipe(intent, allowlist);
  assert.equal(result.recipeId, intent.recipeId);
  assert.equal(result.version, 1);
  assert.equal(result.generationReady, false);
  assert.deepEqual(result.requiredNodes, allowlist.nodes);
  assert.deepEqual(result.requiredModels, [{ kind: 'checkpoint', identifier: intent.checkpoint }]);
  assert.deepEqual(result.graph, {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: intent.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: intent.positivePrompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: intent.negativePrompt, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: intent.outputPrefix } },
  });
  assert.deepEqual(compileRecipe(intent, allowlist), result);
});

function rejects(input: unknown, verified: unknown, code: string, field: string) {
  assert.throws(() => compileRecipe(input, verified), (error: unknown) => {
    assert.ok(error instanceof RecipeCompileError);
    assert.equal(error.code, code);
    assert.equal(error.field, field);
    assert.ok(error.remedy.length > 10);
    return true;
  });
}

test('rejects malformed intents, unknown recipes, versions and enums at runtime', () => {
  for (const value of [null, undefined, [], 'intent', 1]) rejects(value, allowlist, 'INVALID_INTENT', 'intent');
  for (const recipeId of [undefined, 'director', 'video', 1]) rejects({ ...intent, recipeId }, allowlist, 'UNKNOWN_RECIPE', 'recipeId');
  for (const version of [undefined, 0, 2, '1', NaN]) rejects({ ...intent, version }, allowlist, 'UNSUPPORTED_VERSION', 'version');
  rejects({ ...intent, widgetState: {} }, allowlist, 'INVALID_INPUT', 'widgetState');
  for (const field of ['sampler', 'scheduler']) {
    for (const value of ['../x', 'a b', '', undefined, {}, 1]) {
      rejects({ ...intent, [field]: value }, allowlist, 'INVALID_INPUT', field);
    }
  }
});

test('validates bounded finite values, safe integer seeds and aligned dimensions', () => {
  const invalid = {
    seed: [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '42', undefined],
    width: [0, 63, 513, 8200, 512.5, NaN, Infinity, '512', undefined],
    height: [0, 63, 513, 8200, 512.5, NaN, Infinity, '512', undefined],
    steps: [0, 151, 1.5, NaN, Infinity, '20', undefined],
    cfg: [-1, 31, NaN, Infinity, '7', undefined],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) rejects({ ...intent, [field]: value }, allowlist, 'INVALID_INPUT', field);
  }
  for (const seed of [0, Number.MAX_SAFE_INTEGER]) {
    assert.equal(compileRecipe({ ...intent, seed, width: 64, height: 2048, steps: 150, cfg: 30 }, allowlist).graph['5'].inputs.seed, seed);
  }
  assert.doesNotThrow(() => compileRecipe({ ...intent, steps: 1, cfg: 0 }, allowlist));
});

test('rejects unsafe model identifiers even if listed, without normalizing identity', () => {
  for (const checkpoint of ['', '../m.safetensors', 'a/../m.safetensors', '/m.safetensors', 'a\\\\m.safetensors', 'C:m.safetensors', 'https://host/m', 'a//m', './m', ' m.safetensors', 'a\u0000m', 'a/%2e%2e/m']) {
    rejects({ ...intent, checkpoint }, { ...allowlist, checkpoints: [checkpoint] }, 'INVALID_INPUT', 'checkpoint');
  }
});

test('accepts model and image names with spaces and non-ASCII letters exactly as listed', () => {
  for (const checkpoint of ['MiniMaxH3/MM-H3 - Ahegao Face.safetensors', 'Größe/模型 v2.safetensors']) {
    assert.equal(compileRecipe({ ...intent, checkpoint }, { ...allowlist, checkpoints: [checkpoint] }).graph['1'].inputs.ckpt_name, checkpoint);
  }
});

test('validates prompts and app-owned output prefix without altering prompt text', () => {
  for (const field of ['positivePrompt', 'negativePrompt']) {
    for (const value of [null, undefined, 1, 'x'.repeat(16385), 'x\u0000y']) rejects({ ...intent, [field]: value }, allowlist, 'INVALID_INPUT', field);
  }
  for (const outputPrefix of ['', '../out', '/out', 'a/b', 'a\\\\b', 'a:b', 'a\n', 'x'.repeat(129), undefined]) {
    rejects({ ...intent, outputPrefix }, allowlist, 'INVALID_INPUT', 'outputPrefix');
  }
  const text = '  café\n森 🌲  ';
  const graph = compileRecipe({ ...intent, positivePrompt: text, negativePrompt: '' }, allowlist).graph;
  assert.equal(graph['2'].inputs.text, text);
  assert.equal(graph['3'].inputs.text, '');
});

test('does not mutate or retain input objects and returns deeply immutable compilation', () => {
  const frozenIntent = Object.freeze({ ...intent });
  const frozenAllowlist = Object.freeze(Object.fromEntries(Object.entries(allowlist).map(([key, values]) => [key, Object.freeze([...values])])));
  const before = JSON.stringify([frozenIntent, frozenAllowlist]);
  const result = compileRecipe(frozenIntent, frozenAllowlist);
  assert.equal(JSON.stringify([frozenIntent, frozenAllowlist]), before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.graph));
  assert.ok(Object.isFrozen(result.graph['2'].inputs.clip));
  assert.ok(Object.isFrozen(result.graph['5'].inputs));
  assert.ok(Object.isFrozen(result.requiredNodes));
  assert.ok(Object.isFrozen(result.requiredModels[0]));
  const mutable = { ...intent };
  const compiled = compileRecipe(mutable, allowlist);
  mutable.positivePrompt = 'changed';
  assert.equal(compiled.graph['2'].inputs.text, intent.positivePrompt);
});

test('rejects inherited and sparse allowlists instead of trusting ambiguous data', () => {
  rejects(intent, Object.create(allowlist), 'INVALID_ALLOWLIST', 'allowlist');
  rejects(intent, { ...allowlist, nodes: [...allowlist.nodes, ...new Array(1)] }, 'INVALID_ALLOWLIST', 'allowlist');
  const nodes = [...allowlist.nodes];
  nodes.length += 1;
  rejects(intent, { ...allowlist, nodes }, 'INVALID_ALLOWLIST', 'allowlist');
});

test('requires every intent field explicitly instead of inferring defaults', () => {
  for (const field of Object.keys(intent)) {
    const missing: Record<string, unknown> = { ...intent };
    delete missing[field];
    rejects(missing, allowlist, field === 'recipeId' ? 'UNKNOWN_RECIPE' : field === 'version' ? 'UNSUPPORTED_VERSION' : 'INVALID_INPUT', field);
  }
});

test('requires explicit verified capability and model allowlists, failing closed', () => {
  for (const missing of [undefined, null, {}, { ...allowlist, nodes: 'KSampler' }, { ...allowlist, checkpoints: [null] }]) {
    rejects(intent, missing, 'INVALID_ALLOWLIST', 'allowlist');
  }
  for (const node of allowlist.nodes) {
    rejects(intent, { ...allowlist, nodes: allowlist.nodes.filter(n => n !== node) }, 'MISSING_CAPABILITY', node);
  }
  rejects(intent, { ...allowlist, checkpoints: ['other.safetensors'] }, 'MISSING_MODEL', 'checkpoint');
  rejects(intent, { ...allowlist, checkpoints: [] }, 'MISSING_MODEL', 'checkpoint');
  rejects(intent, { ...allowlist, samplers: [] }, 'MISSING_CAPABILITY', 'sampler');
  rejects(intent, { ...allowlist, schedulers: [] }, 'MISSING_CAPABILITY', 'scheduler');
});

test('optional LoRAs chain after the checkpoint and must be verified', () => {
  const loras = [{ name: 'style/a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: -1 }];
  const graph = compileRecipe({ ...intent, loras }, { ...allowlist, loras: loras.map(l => l.name) }).graph;
  assert.deepEqual(graph.L1.inputs, { model: ['1', 0], clip: ['1', 1], lora_name: 'style/a.safetensors', strength_model: 0.8, strength_clip: 0.8 });
  assert.deepEqual(graph.L2.inputs.model, ['L1', 0]);
  assert.deepEqual(graph['5'].inputs.model, ['L2', 0]);
  assert.deepEqual(graph['2'].inputs.clip, ['L2', 1]);
  assert.deepEqual(compileRecipe({ ...intent, loras: [] }, allowlist).graph, compileRecipe(intent, allowlist).graph);
  rejects({ ...intent, loras }, allowlist, 'MISSING_MODEL', 'loras');
  for (const bad of ['x', [{ name: '../a', strength: 1 }], [{ name: 'a', strength: 11 }], [{ name: 'a', strength: 1, extra: 1 }], Array(9).fill({ name: 'a', strength: 1 })]) {
    rejects({ ...intent, loras: bad }, allowlist, 'INVALID_INPUT', 'loras');
  }
});

test('inputImage + denoise compile image-to-image through LoadImage/VAEEncode, verified against the backend lists', () => {
  const i2i = { ...intent, inputImage: 'ref.png', denoise: 0.6 };
  const verified = { ...allowlist, nodes: [...allowlist.nodes, 'LoadImage', 'VAEEncode'], images: ['ref.png'] };
  const graph = compileRecipe(i2i, verified).graph;
  assert.equal(graph['4'], undefined);
  assert.deepEqual(graph['8'], { class_type: 'LoadImage', inputs: { image: 'ref.png' } });
  assert.deepEqual(graph['9'].inputs, { pixels: ['8', 0], vae: ['1', 2] });
  assert.deepEqual(graph['5'].inputs.latent_image, ['9', 0]);
  assert.equal(graph['5'].inputs.denoise, 0.6);
  rejects(i2i, allowlist, 'MISSING_CAPABILITY', 'LoadImage');
  rejects(i2i, { ...verified, images: [] }, 'MISSING_MODEL', 'inputImage');
  rejects({ ...intent, denoise: 0.5 }, verified, 'INVALID_INPUT', 'inputImage');
  rejects({ ...i2i, inputImage: '../ref.png' }, verified, 'INVALID_INPUT', 'inputImage');
  rejects({ ...i2i, denoise: 1.5 }, verified, 'INVALID_INPUT', 'denoise');
});

test('inputResize builds scale/pad chains and requires only the used optional nodes', () => {
  const image = { ...intent, inputImage: 'ref.png', denoise: 0.6 };
  const lists = { ...allowlist, nodes: [...allowlist.nodes, 'LoadImage', 'VAEEncode', 'ImageScale', 'ImagePadForOutpaint'], images: ['ref.png'] };
  for (const crop of ['disabled', 'center'] as const) {
    const resize = { width: 512, height: 768, crop };
    const graph = compileRecipe({ ...image, inputResize: resize }, lists).graph;
    assert.deepEqual(graph.S, { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', ...resize } });
    assert.deepEqual(graph['9'].inputs.pixels, ['S', 0]);
    assert.equal(graph.P, undefined);
    const split = compileRecipe({ ...image, inputResize: resize, diffusion: { textEncoder: 'clip', clipType: 'sdxl', vae: 'vae' }, loras: [{ name: 'lora', strength: 1 }] }, { ...lists, nodes: [...lists.nodes, 'UNETLoader', 'CLIPLoader', 'VAELoader'], diffusionModels: [intent.checkpoint], textEncoders: ['clip'], clipTypes: ['sdxl'], vaes: ['vae'], loras: ['lora'] }).graph;
    assert.deepEqual(split['9'].inputs.vae, ['V', 0]);
    assert.deepEqual(split['5'].inputs.model, ['L1', 0]);
    const pad = { left: 8, right: 16, top: 24, bottom: 32 };
    const padded = { ...image, width: 536, height: 824, inputResize: { ...resize, pad } };
    const g = compileRecipe(padded, lists).graph;
    assert.deepEqual(g.P, { class_type: 'ImagePadForOutpaint', inputs: { image: ['S', 0], ...pad, feathering: 0 } });
    assert.deepEqual(g['9'].inputs.pixels, ['P', 0]);
    assert.deepEqual(g['5'].inputs.latent_image, ['9', 0]);
    assert.equal(g['5'].inputs.denoise, 0.6);
    for (const node of ['ImageScale', 'ImagePadForOutpaint']) rejects(padded, { ...lists, nodes: lists.nodes.filter(n => n !== node) }, 'MISSING_CAPABILITY', node);
    assert.doesNotThrow(() => compileRecipe({ ...image, inputResize: resize }, { ...lists, nodes: lists.nodes.filter(n => n !== 'ImagePadForOutpaint') }));
    assert.doesNotThrow(() => compileRecipe(image, { ...lists, nodes: lists.nodes.filter(n => !n.startsWith('Image')) }));
  }
});

test('inputResize validates exact fields, aligned integer ranges, image-only use and final geometry', () => {
  const resize = { width: 512, height: 768, crop: 'disabled' };
  const image = { ...intent, inputImage: 'ref.png', denoise: 0.6 };
  rejects({ ...intent, inputResize: resize }, allowlist, 'INVALID_INPUT', 'inputResize');
  const bad = [undefined, null, [], 'resize', {}, { ...resize, extra: 1 }, { width: 512, height: 768 },
    ...[0, -8, 7, 511, 512.5, 8200, '512', NaN, Infinity].map(width => ({ ...resize, width })),
    ...[0, 767, 768.5, 8200, '768'].map(height => ({ ...resize, height })),
    ...['fit', '', null, 1].map(crop => ({ ...resize, crop })),
    { ...resize, width: 504 }, { ...resize, height: 760 },
    ...[undefined, null, [], {}, { left: 0, right: 0, top: 0 }, { left: 0, right: 0, top: 0, bottom: 0, extra: 0 },
      ...[-8, 1, 8.5, 8200, '8', NaN].map(left => ({ left, right: 0, top: 0, bottom: 0 })),
      { left: 8, right: 0, top: 0, bottom: 0 }].map(pad => ({ ...resize, pad }))];
  for (const inputResize of bad) rejects({ ...image, inputResize }, allowlist, 'INVALID_INPUT', 'inputResize');
});

test('4K dimensions and pixel boundary are supported without allowing oversized areas', () => {
  for (const [width, height] of [[3840, 2160], [4096, 4096], [8192, 2048], [2048, 8192]]) assert.doesNotThrow(() => compileRecipe({ ...intent, width, height }, allowlist));
  rejects({ ...intent, width: 8192, height: 2056 }, allowlist, 'INVALID_INPUT', 'width');
});

test('diffusion loads the model through UNETLoader with its own text encoder and VAE, all verified', () => {
  const split = { ...intent, checkpoint: 'krea/k2.safetensors', diffusion: { textEncoder: 'qwen3vl_4b.safetensors', clipType: 'krea2', vae: 'q/qwen_image_vae.safetensors' }, loras: [{ name: 'k.safetensors', strength: 0.5 }] };
  const lists = { ...allowlist, nodes: [...allowlist.nodes, 'UNETLoader', 'CLIPLoader', 'VAELoader'], loras: ['k.safetensors'], diffusionModels: ['krea/k2.safetensors'], textEncoders: ['qwen3vl_4b.safetensors'], clipTypes: ['krea2'], vaes: ['q/qwen_image_vae.safetensors'] };
  const g = compileRecipe(split, lists).graph;
  assert.deepEqual(g['1'], { class_type: 'UNETLoader', inputs: { unet_name: 'krea/k2.safetensors', weight_dtype: 'default' } });
  assert.deepEqual(g.C.inputs, { clip_name: 'qwen3vl_4b.safetensors', type: 'krea2' });
  assert.deepEqual(g.L1.inputs.clip, ['C', 0]);
  assert.deepEqual(g['2'].inputs.clip, ['L1', 1]);
  assert.deepEqual(g['6'].inputs.vae, ['V', 0]);
  rejects(split, { ...lists, clipTypes: [] }, 'MISSING_MODEL', 'diffusion');
  rejects(split, { ...lists, diffusionModels: [] }, 'MISSING_MODEL', 'checkpoint');
  rejects({ ...split, diffusion: { ...split.diffusion, vae: '../x' } }, lists, 'INVALID_INPUT', 'diffusion');
});
