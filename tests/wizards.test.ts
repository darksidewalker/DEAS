import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinWizards, editGrid, preferredChoice, strategyPrompt, usesObject, validWizard, wizardCanvas, wizardChoices, wizardPrompt, wizardReady, type WizardModel } from '../src/lib/wizards.ts';

const replace = builtinWizards.find(w => w.id === 'replace')!;
const model = (name: string, family: string | null, category = 'diffusion_models'): WizardModel => ({ name, family, category, path: `/m/${name}` });

test('bundled Replace wizard is valid data: Qwen reference edit first, masked edit second on the same Qwen models before other families', () => {
  assert.ok(replace);
  assert.equal(replace.object, true);
  assert.deepEqual(replace.strategies[1].families.slice(0, 2), ['qwen-image-2.1', 'qwen-image-2.1-turbo']);
  assert.deepEqual(replace.strategies[0].objectFamilies, ['qwen-image-2.1', 'qwen-image-2.1-turbo']);
  // Owner decision: an object request on the masked method goes to the reference edit (a masked edit keeps the old object).
  assert.equal(replace.strategies[1].objectVia, 'reference');
  assert.equal(replace.strategies[1].objectPositive, undefined);
  // SAM masks of a masked one-click run grow 32 px and get a 4 px soft edge.
  assert.equal(replace.strategies[1].maskGrow, 32);
  assert.equal(replace.strategies[1].maskBlur, 4);
  assert.deepEqual(replace.strategies.map(s => s.id), ['reference', 'inpaint']);
  assert.deepEqual(replace.strategies[0].families, ['qwen-image-2.1', 'qwen-image-2.1-turbo']);
  assert.equal(replace.strategies[0].source, 'reference');
  assert.equal(replace.strategies[1].edit, 'inpaint');
  assert.equal(replace.strategies[1].needsMask, true);
  // A replacement redraws the masked area completely; the reference edit has no source strength.
  assert.equal(replace.strategies[1].denoise, 1);
  assert.equal(replace.strategies[0].denoise, undefined);
});

test('descriptor validation refuses unknown families and mismatched pipeline/source/mask combinations', () => {
  const base = structuredClone(replace);
  assert.equal(validWizard(base), true);
  const broken = (patch: (w: typeof base) => void) => { const w = structuredClone(replace); patch(w); return validWizard(w); };
  assert.equal(broken(w => { w.strategies[0].families = ['not-a-family']; }), false);
  assert.equal(broken(w => { w.strategies[0].pipeline = 'i2i'; }), false);
  assert.equal(broken(w => { w.strategies[1].pipeline = 't2i'; }), false);
  assert.equal(broken(w => { w.strategies[1].needsMask = false; }), false);
  assert.equal(broken(w => { w.strategies[1].denoise = 0; }), false);
  assert.equal(broken(w => { w.strategies[1].denoise = 1.5; }), false);
  assert.equal(broken(w => { w.strategies[0].denoise = 1; }), false); // a reference edit has no picture to redraw
  assert.equal(broken(w => { w.strategies[1].id = 'reference'; }), false);
  assert.equal(broken(w => { w.library = ' '; }), false);
  assert.equal(broken(w => { delete w.strategies[0].objectFamilies; }), false); // an object template needs families that take references
  assert.equal(broken(w => { w.strategies[0].objectFamilies = ['sdxl']; }), false); // SDXL has no image 1/image 2 reference encoder
  assert.equal(broken(w => { w.strategies[1].objectVia = 'nowhere'; }), false);
  assert.equal(broken(w => { w.strategies[1].objectVia = 'inpaint'; }), false);
  assert.equal(broken(w => { delete w.strategies[0].objectPositive; delete w.strategies[0].objectFamilies; }), false); // the target needs an object template
  assert.equal(broken(w => { w.strategies[1].maskGrow = -1; }), false);
  assert.equal(broken(w => { w.strategies[1].maskBlur = 32; }), false);
  assert.equal(broken(w => { w.strategies[0].maskGrow = 8; }), false); // no mask on a reference edit
  assert.equal(broken(w => { w.strategies[0].objectFamilies = ['krea-2']; }), false); // not among the strategy's families
});

test('choices list only installed models of declared families, in family order; unknown and LoRA files never count', () => {
  const models = [model('zz-sdxl.safetensors', 'sdxl', 'checkpoints'), model('turbo.safetensors', 'qwen-image-2.1-turbo'), model('base.safetensors', 'qwen-image-2.1'),
    model('mystery.safetensors', null), model('qwen-lora.safetensors', 'qwen-image-2.1', 'loras'), model('flux2.safetensors', 'flux2')];
  const choices = wizardChoices(replace, models);
  assert.deepEqual(choices[0].models.map(m => m.name), ['base.safetensors', 'turbo.safetensors']);
  assert.deepEqual(choices[1].models.map(m => m.name), ['base.safetensors', 'turbo.safetensors', 'flux2.safetensors', 'zz-sdxl.safetensors']);
  assert.equal(preferredChoice(choices)?.strategy.id, 'reference');
  assert.equal(preferredChoice(wizardChoices(replace, [model('flux2.safetensors', 'flux2')]))?.strategy.id, 'inpaint');
  assert.equal(preferredChoice(wizardChoices(replace, [model('mystery.safetensors', null)])), undefined);
});

test('prompt templates fill trimmed single-line fields; readiness requires every used field', () => {
  const [reference, inpaint] = replace.strategies;
  assert.equal(wizardPrompt(reference.positive, { target: '  the red\ncar ', replacement: 'a blue bicycle' }),
    'Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.');
  assert.equal(wizardPrompt(inpaint.positive, { target: 'ignored', replacement: ' a cat ' }), 'a cat');
  assert.equal(wizardReady(reference, { replacement: 'x' }), false);
  assert.equal(wizardReady(inpaint, { replacement: 'x' }), true);
  assert.equal(wizardReady(inpaint, { replacement: '  ' }), false);
});

test('reference-edit canvas keeps the picture aspect at the family pixel budget on the Qwen 32-pixel grid', () => {
  const wide = wizardCanvas('qwen-image-2.1-turbo', { width: 1920, height: 1080 })!;
  assert.equal(wide.width % 32, 0); assert.equal(wide.height % 32, 0);
  assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.05, JSON.stringify(wide));
  assert.ok(Math.abs(wide.width * wide.height - 1024 * 1024) / (1024 * 1024) < 0.08, JSON.stringify(wide));
  assert.deepEqual(wizardCanvas('qwen-image-2.1-turbo', { width: 800, height: 800 }), { width: 1024, height: 1024 });
  assert.equal(wizardCanvas('qwen-image-2.1', { width: 0, height: 10 }), undefined);
  assert.equal(wizardCanvas('no-such-family', { width: 10, height: 10 }), undefined);
});

test('the object picture is used only by models whose encoder takes references, with image 1 = picture to change and image 2 = object', () => {
  const [reference, inpaint] = replace.strategies;
  assert.equal(usesObject(reference, 'qwen-image-2.1-turbo', true), true);
  assert.equal(usesObject(reference, 'qwen-image-2.1-turbo', false), false);
  assert.equal(usesObject(inpaint, 'qwen-image-2.1', true), false); // the masked edit itself never reads the object picture: it routes to the reference edit
  assert.equal(usesObject(inpaint, 'sdxl', true), false);
  assert.equal(strategyPrompt(reference, { target: 'the red car' }, true),
    'Replace the red car in image 1 with the main object from image 2. Keep everything else in image 1 unchanged and match its lighting and perspective.');
  assert.equal(strategyPrompt(reference, { target: 'the red car', replacement: 'the dog' }, true).includes('with the dog from image 2'), true);
  assert.equal(wizardReady(reference, { target: 'the red car' }, true), true); // replacement has a fallback with an object picture
  assert.equal(wizardReady(reference, { target: 'the red car' }, false), false);
  assert.equal(strategyPrompt(inpaint, { replacement: 'a cat' }, false), 'a cat');
});

test('inpaint grid mirrors Generate: Qwen with references 32, otherwise the family grid', () => {
  assert.equal(editGrid('qwen-image-2.1', true), 32);
  assert.equal(editGrid('qwen-image-2.1', false), 16);
  assert.equal(editGrid('sdxl', true), 64);
  assert.equal(editGrid('unknown', false), 16);
});
