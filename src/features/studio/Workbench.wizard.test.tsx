import { evidence, heldJob, referenceModels, referenceNodes, refsEvidence, collection } from './Workbench.testHarness';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { loadDiagnosticJobOutput, pollWorkbench, readCurrentWorkbench, runWorkbenchJob, uploadInput, uploadMask, waitForWorkbenchJob } from '../../lib/jobs';
import type { WizardHandoff } from '../../lib/wizards';

const picture = { name: 'street.png', path: '/pics/street.png', src: 'asset://localhost//pics/street.png' };
const reference: WizardHandoff = { n: 1, wizard: 'replace', strategy: 'reference', pipeline: 't2i', source: 'reference', model: { name: 'qwen.safetensors', path: '/m/q' }, picture,
  positive: 'Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.', size: { width: 1216, height: 672 } };
const inpaint: WizardHandoff = { n: 1, wizard: 'replace', strategy: 'inpaint', pipeline: 'i2i', source: 'edit', edit: 'inpaint', model: { name: 'a.safetensors', path: '/m/a' }, picture, positive: 'a blue bicycle' };
const qwenEvidence = () => ({ ...refsEvidence, allowlist: { ...refsEvidence.allowlist, nodes: [...refsEvidence.allowlist.nodes, ...referenceNodes, 'UNETLoader', 'CLIPLoader', 'VAELoader'] } });
const prompt = () => (screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value;

test('a reference-edit hand-over selects the Qwen model, adds the picture as prompt reference, fixes the size and never runs', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  localStorage.setItem('deas.pref.studio.run.checkpoint', '"a.safetensors"');
  localStorage.setItem('deas.pref.studio.run.loras', JSON.stringify([{ name: 'style.safetensors', strength: 1, enabled: true }]));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  expect((screen.getByRole('combobox', { name: 'Checkpoint' }) as HTMLSelectElement).value).toBe('qwen.safetensors');
  expect(prompt()).toBe(reference.positive);
  expect(document.querySelector('[data-reference-controls] img')?.getAttribute('alt')).toBe('street.png');
  expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1216');
  expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('672');
  expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('fixed');
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference} planVisible/></I18nProvider>);
  const plan = JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
  expect(plan).toMatchObject({ checkpoint: 'qwen.safetensors', positivePrompt: reference.positive, width: 1216, height: 672, nativeImageReference: { method: 'qwen-image-2.1', images: ['/pics/street.png'] } });
  expect(plan.inputImage).toBeUndefined(); expect(plan.loras ?? []).toEqual([]);
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference}/></I18nProvider>);
  // The same hand-over number is applied once; re-renders do not re-apply over later edits.
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'my own edit' } });
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference}/></I18nProvider>);
  expect(prompt()).toBe('my own edit'); expect(applied).toHaveBeenCalledTimes(1);
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadInput).not.toHaveBeenCalled(); expect(uploadMask).not.toHaveBeenCalled();
});

test('a run hand-over applies the draft and starts it through Generate\'s own Run path, reporting the job back without a plain prepare', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  vi.mocked(uploadInput).mockResolvedValue('deas-inputs/street.png');
  vi.mocked(runWorkbenchJob).mockResolvedValue({ ...heldJob('wizard-run', 'running'), progress: { value: 3, max: 20 } });
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 2, run: true }}/></I18nProvider>);
  // The draft is applied first, so the intent Run builds carries the wizard's model, picture reference and size.
  await waitFor(() => expect(applied).toHaveBeenCalledWith(2, undefined, expect.objectContaining({ state: 'running', value: 3, max: 20 })));
  const [endpoint, intent] = vi.mocked(runWorkbenchJob).mock.calls.at(-1)!;
  expect(endpoint).toBe(evidence.baseUrl);
  expect(intent).toMatchObject({ checkpoint: 'qwen.safetensors', positivePrompt: reference.positive, width: 1216, height: 672,
    nativeImageReference: { method: 'qwen-image-2.1', images: ['deas-inputs/street.png'] } });
  expect((intent as { inputImage?: string }).inputImage).toBeUndefined();
  expect(prompt()).toBe(reference.positive);
  // A run hand-over is never reported as a plain prepare, so the wizard tab stays open.
  expect(applied.mock.calls.every(call => call[2] !== undefined)).toBe(true);
});

test('a wizard run reports the finished picture from that job\'s own native output folder', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  vi.mocked(uploadInput).mockResolvedValue('deas-inputs/street.png');
  vi.mocked(runWorkbenchJob).mockResolvedValue({ ...heldJob('wizard-run', 'running') });
  const finished = { ...heldJob('wizard-run', 'succeeded'), outputRoot: '/out', metadata: { startedAt: 0, generationMs: 4200 },
    outputs: [{ filename: 'done.png', subfolder: 'DEAS/replace', type: 'output' as const }] };
  vi.mocked(pollWorkbench).mockResolvedValue(collection([finished]));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 2, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(2, undefined, expect.objectContaining({
    state: 'succeeded', job: expect.objectContaining({ id: 'wizard-run' }),
    picture: expect.objectContaining({ path: '/out/DEAS/replace/done.png', width: 1216, height: 672, checkpoint: 'qwen.safetensors', ms: 4200 }) })), { timeout: 4000 });
  expect(applied.mock.calls.filter(call => call[0] === 2 && call[2]?.state === 'succeeded')).toHaveLength(1);
});

test('a wizard run that finished without a file or failed names the outcome instead of inventing a picture', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  vi.mocked(uploadInput).mockResolvedValue('deas-inputs/street.png');
  vi.mocked(runWorkbenchJob).mockResolvedValue({ ...heldJob('wizard-run', 'running') });
  vi.mocked(pollWorkbench).mockResolvedValue(collection([{ ...heldJob('wizard-run', 'succeeded'), outputRoot: '/out' }]));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 2, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(2, undefined, expect.objectContaining({ state: 'succeeded', error: 'The run finished without a picture file.' })), { timeout: 4000 });
  expect(applied.mock.calls.at(-1)![2]?.picture).toBeUndefined();
});

test('an inpaint hand-over opens the picture in Inpaint with the prompt and keeps Run behind the mask gate', async () => {
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }]);
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={inpaint}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  expect(prompt()).toBe('a blue bicycle');
  const img = screen.getByRole('img', { name: 'street.png' });
  Object.defineProperties(img, { naturalWidth: { value: 1024 }, naturalHeight: { value: 640 } }); fireEvent.load(img);
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.edit')!)).toBe('inpaint');
  expect(screen.getByRole('button', { name: 'Add mask' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Mask 1' })).toBeTruthy();
  expect(document.querySelector('.wb-editor-host')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadInput).not.toHaveBeenCalled();
});

test('a hand-over Generate cannot honour is refused by number without touching the draft; Beginner refuses too', async () => {
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }]);
  localStorage.setItem('deas.pref.studio.run.positive', JSON.stringify('kept'));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 4 }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(4, expect.stringContaining('Generate cannot use the model')));
  expect(prompt()).toBe('kept');
  expect(screen.getAllByText(/Generate cannot use the model the wizard chose/).length).toBeGreaterThan(0);
  view.unmount();
  // Beginner refuses a model its own composer cannot use (no family starting settings) the same way.
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }, { category: 'checkpoints', name: 'odd.safetensors', path: '/m/odd', size: 1, info: null }]);
  const beginner = vi.fn();
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{ models: '/m' }} beginner onWizardApplied={beginner} wizard={{ ...inpaint, n: 5, model: { name: 'odd.safetensors', path: '/m/odd' } }}/></I18nProvider>);
  await waitFor(() => expect(beginner).toHaveBeenCalledWith(5, expect.stringContaining('Generate cannot use the model')));
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('Beginner takes a reference-edit hand-over: wizard size kept over its starting settings, pictures shown with a Clear, no LoRAs, and the run goes through Run', async () => {
  vi.mocked(scanModels).mockResolvedValue([...referenceModels('qwen-image-2.1-turbo'), { category: 'loras', name: 'qlora.safetensors', family: 'qwen-image-2.1-turbo', path: '/m/l', size: 1, info: null }]);
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  vi.mocked(uploadInput).mockResolvedValue('deas-inputs/street.png');
  vi.mocked(runWorkbenchJob).mockResolvedValue({ ...heldJob('wizard-run', 'running') });
  localStorage.setItem('deas.pref.beginner.loras', JSON.stringify({ model: 'x', loras: [] }));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied, beginner: true };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('.beginner-selected-model')?.textContent).toBeTruthy());
  await waitFor(() => expect(scanModels).toHaveBeenCalled());
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 11, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(11, undefined, expect.objectContaining({ state: 'running' })));
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, unknown>;
  expect(intent).toMatchObject({ checkpoint: 'qwen.safetensors', positivePrompt: reference.positive, width: 1216, height: 672, nativeImageReference: { method: 'qwen-image-2.1', images: ['deas-inputs/street.png'] } });
  expect(intent.loras ?? []).toEqual([]);
  // Beginner's model-change reset ran after the hand-over; the composer still shows the wizard's size and pictures.
  await waitFor(() => expect((document.querySelector('[data-beginner-resolution]') as HTMLSelectElement).value).toBe('fixed'));
  expect(document.querySelector('[data-beginner-resolution] option[value="fixed"]')?.textContent).toBe('Wizard size 1216×672');
  expect(document.querySelector('[data-beginner-wizard-draft]')?.textContent).toContain('Wizard pictures: street.png');
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.resolution') ?? '"model"')).not.toBe('fixed');
  fireEvent.click(screen.getByRole('button', { name: 'Clear wizard draft' }));
  expect(document.querySelector('[data-beginner-wizard-draft]')).toBeNull();
});

test('Beginner takes a masked hand-over into its own Inpaint editor and labels it as a masked edit', async () => {
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }]);
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied, beginner: true };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(scanModels).toHaveBeenCalled());
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...inpaint, n: 12 }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(12));
  for (const img of screen.getAllByRole('img', { name: 'street.png' })) { Object.defineProperties(img, { naturalWidth: { value: 1024 }, naturalHeight: { value: 640 } }); fireEvent.load(img); }
  await waitFor(() => expect(document.querySelector('.wb-editor-host')).not.toBeNull());
  expect(document.querySelector('[data-beginner-wizard-draft]')?.textContent).toContain('Masked edit (inpaint)');
  expect(screen.getByRole('button', { name: 'Mask 1' })).toBeTruthy();
  expect(prompt()).toBe('a blue bicycle');
  fireEvent.click(screen.getByRole('button', { name: 'Clear wizard draft' }));
  // Clear returns to a plain picture-to-picture draft: the picture stays, the mask layers go.
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Mask 1' })).toBeNull());
  expect(document.querySelector('[data-beginner-wizard-draft]')).toBeNull();
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('a masked Qwen hand-over keeps one model: picture to edit plus image 1/image 2 prompt references, and the grid gate stays visible', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  const object = { name: 'dog.png', path: '/pics/dog.png', src: 'asset://localhost//pics/dog.png' };
  const handoff: WizardHandoff = { ...inpaint, model: { name: 'qwen.safetensors', path: '/m/q' }, references: [picture, object],
    positive: 'Replace the masked area of image 1 (the red car) with the dog from image 2.' };
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  const load = (width: number, height: number) => { for (const img of screen.getAllByRole('img', { name: 'street.png' })) { Object.defineProperties(img, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } }); fireEvent.load(img); } };
  load(1024, 576);
  await waitFor(() => expect(document.querySelector('.wb-editor-host')).not.toBeNull());
  expect(screen.queryByText(/Resample this image to the selected model’s resolution grid/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Mask 1' })).toBeTruthy();
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff} planVisible/></I18nProvider>);
  const plan = JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
  expect(plan).toMatchObject({ checkpoint: 'qwen.safetensors', width: 1024, height: 576, positivePrompt: handoff.positive, nativeImageReference: { method: 'qwen-image-2.1', images: ['/pics/street.png', '/pics/dog.png'] } });
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadInput).not.toHaveBeenCalled();
});

test('a masked Qwen hand-over of a picture off the 32 px grid shows Generate\'s resample gate instead of running', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...inpaint, model: { name: 'qwen.safetensors', path: '/m/q' }, references: [picture, { ...picture, name: 'dog.png', path: '/pics/dog.png' }] }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  for (const img of screen.getAllByRole('img', { name: 'street.png' })) { Object.defineProperties(img, { naturalWidth: { value: 1000 }, naturalHeight: { value: 600 } }); fireEvent.load(img); }
  expect(await screen.findByText(/Resample this image to the selected model’s resolution grid/)).toBeTruthy();
  expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});

const samCheckpoint = 'SAM3/sam3.1_multiplex_fp16.safetensors';
const samEvidence = (withNode = true) => ({ ...evidence, allowlist: { ...evidence.allowlist, nodes: [...evidence.allowlist.nodes, ...(withNode ? ['SAM3_Detect'] : [])], checkpoints: [...evidence.allowlist.checkpoints, samCheckpoint] } });
/** Canvas/bitmap stubs so the editor can export its source and import SAM's mask; `white` decides whether the returned mask has coverage. */
function maskCanvas(white: boolean) {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1024, height: 640, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (done) { done({ arrayBuffer: async () => png.buffer } as Blob); });
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ save: vi.fn(), restore: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), putImageData: vi.fn(), arc: vi.fn(), fill: vi.fn(), beginPath: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(white ? [255, 255, 255, 255] : [0, 0, 0, 0]) }) } as unknown as CanvasRenderingContext2D);
  vi.mocked(waitForWorkbenchJob).mockImplementation(async job => job);
  vi.mocked(loadDiagnosticJobOutput).mockResolvedValue({ jobId: 'sam', index: 0, bytes: Array.from(png), mimeType: 'image/png', width: 1024, height: 640, sha256: 'fixture' });
  vi.mocked(uploadMask).mockResolvedValue('deas-inputs/upload.png');
  vi.mocked(uploadInput).mockResolvedValue('deas-inputs/street.png');
  vi.mocked(runWorkbenchJob).mockImplementation(async (_url, intent) => (intent as { recipeId: string }).recipeId === 'sam3-mask'
    ? { ...heldJob('sam', 'succeeded'), intent, outputs: [{ filename: 'mask.png', subfolder: '', type: 'output' as const }] }
    : { ...heldJob('wizard-run', 'running'), intent, progress: { value: 1, max: 20 } });
}
const masked: WizardHandoff = { ...inpaint, n: 7, run: true, mask: 'the red car', denoise: 1 };
async function maskedRun(handoff: WizardHandoff) {
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }]);
  const applied = vi.fn(), sam = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied, onSamAvailability: sam };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(handoff.n, undefined, expect.anything()));
  const load = () => { for (const img of screen.queryAllByRole('img', { name: 'street.png' })) { Object.defineProperties(img, { naturalWidth: { value: 1024, configurable: true }, naturalHeight: { value: 640, configurable: true } }); fireEvent.load(img); } };
  load();
  return { applied, sam, view, load };
}

test('a masked run hand-over masks the picture with SAM 3.1 from Replace what, then starts the inpaint run through Generate\'s own Run', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(samEvidence());
  maskCanvas(true);
  const { applied, sam } = await maskedRun(masked);
  await waitFor(() => expect(sam).toHaveBeenLastCalledWith(''));
  expect(applied).toHaveBeenCalledWith(7, undefined, { state: 'queued', masking: true });
  await waitFor(() => expect(applied).toHaveBeenCalledWith(7, undefined, expect.objectContaining({ state: 'running', value: 1, max: 20, job: expect.objectContaining({ id: 'wizard-run' }) })), { timeout: 4000 });
  const [first, second] = vi.mocked(runWorkbenchJob).mock.calls.map(call => call[1] as unknown as Record<string, unknown>);
  // The SAM pass uses the wizard's target, not Generate's own SAM targets field, and Generate's selected SAM checkpoint.
  expect(first).toMatchObject({ recipeId: 'sam3-mask', checkpoint: samCheckpoint, prompt: 'the red car', width: 1024, height: 640 });
  // The wizard picture lives outside the ComfyUI input/output folders, so Run uploads it like a project input.
  expect(second).toMatchObject({ checkpoint: 'a.safetensors', positivePrompt: 'a blue bicycle', width: 1024, height: 640, inputMask: 'deas-inputs/upload.png', inputImage: 'deas-inputs/street.png', denoise: 1 });
  expect(uploadInput).toHaveBeenCalledWith(evidence.baseUrl, '/pics/street.png');
  expect(vi.mocked(runWorkbenchJob)).toHaveBeenCalledTimes(2);
  expect(screen.getByText('A separate SAM mask layer was added.')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.samTargets') ?? '""')).toBe('');
});

test('a masked run hand-over whose target SAM 3.1 cannot find leaves the prepared draft in Generate and never starts the drawing job', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(samEvidence());
  maskCanvas(false);
  const { applied } = await maskedRun({ ...masked, n: 8 });
  await waitFor(() => expect(applied).toHaveBeenCalledWith(8, undefined, { state: 'unknown', error: 'SAM 3.1 found no “the red car” in the picture. Draw the mask in Generate and press Run there.' }), { timeout: 4000 });
  expect(vi.mocked(runWorkbenchJob).mock.calls.map(call => (call[1] as { recipeId: string }).recipeId)).toEqual(['sam3-mask']);
  expect(prompt()).toBe('a blue bicycle');
  expect(document.querySelector('.wb-editor-host')).not.toBeNull();
});

test('a masked run hand-over without SAM 3.1 reports Generate\'s SAM reason and submits nothing', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(samEvidence(false));
  maskCanvas(true);
  const { applied, sam } = await maskedRun({ ...masked, n: 9 });
  await waitFor(() => expect(sam).toHaveBeenLastCalledWith(expect.stringContaining('SAM3_Detect')));
  expect(applied).toHaveBeenCalledWith(9, undefined, expect.objectContaining({ state: 'unknown', error: expect.stringContaining('SAM3_Detect') }));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadMask).not.toHaveBeenCalled();
  expect(prompt()).toBe('a blue bicycle');
});
