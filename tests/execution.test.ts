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
    for (const value of ['unknown', undefined, {}, 1]) {
      rejects({ ...intent, [field]: value }, { ...allowlist, samplers: ['unknown'], schedulers: ['unknown'] }, 'INVALID_INPUT', field);
    }
  }
});

test('validates bounded finite values, safe integer seeds and aligned dimensions', () => {
  const invalid = {
    seed: [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '42', undefined],
    width: [0, 63, 513, 2056, 512.5, NaN, Infinity, '512', undefined],
    height: [0, 63, 513, 2056, 512.5, NaN, Infinity, '512', undefined],
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
