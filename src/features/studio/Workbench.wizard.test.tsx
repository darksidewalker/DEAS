import { evidence, heldJob, ltxModels, referenceModels, referenceNodes, refsEvidence, collection, videoEvidence, mountAce } from './Workbench.testHarness';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { loadDiagnosticJobOutput, pollWorkbench, readCurrentWorkbench, readH3Session, runWorkbenchJob, stopWorkbench, stopWorkbenchJob, uploadInput, uploadMask, waitForWorkbenchJob } from '../../lib/jobs';
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
const masked: WizardHandoff = { ...inpaint, n: 7, run: true, mask: 'the red car', denoise: 1, maskGrow: 32, maskBlur: 4 };
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
  expect(second).toMatchObject({ checkpoint: 'a.safetensors', positivePrompt: 'a blue bicycle', width: 1024, height: 640, inputMask: 'deas-inputs/upload.png', inputImage: 'deas-inputs/street.png', denoise: 1, maskBlur: 4 });
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

test('a masked run hand-over sets the strategy CFG for the draft it runs', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(samEvidence());
  maskCanvas(true);
  localStorage.setItem('deas.pref.studio.run.cfg', '7');
  const { applied } = await maskedRun({ ...masked, n: 8, cfg: 4 });
  await waitFor(() => expect(applied).toHaveBeenCalledWith(8, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const drawn = vi.mocked(runWorkbenchJob).mock.calls.map(call => call[1] as unknown as Record<string, unknown>).find(i => i.recipeId !== 'sam3-mask')!;
  expect(drawn).toMatchObject({ positivePrompt: 'a blue bicycle', cfg: 4, denoise: 1 });
});

test('Beginner keeps the wizard CFG over its model-change starting values', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  vi.mocked(uploadInput).mockResolvedValue('deas-inputs/street.png');
  vi.mocked(runWorkbenchJob).mockResolvedValue({ ...heldJob('wizard-run', 'running') });
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied, beginner: true };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('.beginner-selected-model')?.textContent).toBeTruthy());
  await waitFor(() => expect(scanModels).toHaveBeenCalled());
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 12, run: true, cfg: 4 }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(12, undefined, expect.objectContaining({ state: 'running' })));
  expect(vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1]).toMatchObject({ checkpoint: 'qwen.safetensors', cfg: 4 });
  // Beginner's model-change reset ran after the hand-over; the draft's CFG is still the wizard's.
  await waitFor(() => expect((document.querySelector('[data-beginner-resolution]') as HTMLSelectElement).value).toBe('fixed'));
  expect((document.querySelector('input[data-num="cfg"]') as HTMLInputElement | null)?.value).toBe('4');
});

const h3Set = [
  { category: 'diffusion_models', name: 'h3.safetensors', path: '/m/h3', family: 'minimax-h3', size: 1, info: null },
  { category: 'text_encoders', name: 'minimax_h3_encoder.safetensors', path: '/m/t', size: 1, info: null },
  { category: 'vae', name: 'h3_video_vae.safetensors', path: '/m/hv', size: 1, info: null },
  { category: 'vae', name: 'h3_audio_vae.safetensors', path: '/m/ha', size: 1, info: null }];
const editedFrame = { name: 'edit.png', path: '/out/raw/edit.png', src: 'asset://localhost//out/raw/edit.png' };
const clipItem = { name: 'street.mp4', path: '/clips/street.mp4', src: 'asset://localhost//clips/street.mp4' };
async function videoWorkbench(beginner = false) {
  const ms = [...ltxModels, ...h3Set];
  vi.mocked(scanModels).mockResolvedValue(ms as never);
  vi.mocked(checkRecipePrerequisites).mockResolvedValue({ ...videoEvidence, allowlist: { ...videoEvidence.allowlist, nodes: [...videoEvidence.allowlist.nodes, 'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'VAELoader'],
    diffusionModels: ms.filter(m => 'family' in m && m.family).map(m => m.name), textEncoders: ms.filter(m => m.category === 'text_encoders').map(m => m.name), vaes: ms.filter(m => m.category === 'vae').map(m => m.name), clipTypes: ['ltxv', 'minimax'] } });
  vi.mocked(uploadInput).mockImplementation(async (_base, path) => `deas-inputs/${path.split('/').at(-1)}`);
  vi.mocked(runWorkbenchJob).mockImplementation(async (base, intent) => ({ ...heldJob('wizard-video', 'running', base), intent }));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied, beginner };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  if (beginner) await waitFor(() => expect(scanModels).toHaveBeenCalled());
  else await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toMatch(/ltx|h3/));
  return { applied, props, view };
}

test('a Replace video step "Edit video" runs LTX video-to-video with the clip as guide and the edited frame as first frame', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 21, wizard: 'replace', strategy: 'edit', pipeline: 'v2v', source: 'video', model: { name: 'LTX2/ltx.safetensors', path: '/m/unet/LTX2/ltx.safetensors' },
    picture: editedFrame, sourceVideo: clipItem, sourceStrength: 0.2, seconds: 5, size: { width: 1280, height: 704 }, positive: 'The same shot with a red apple.', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(21, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ recipeId: 'video-generation', family: 'ltx-2', model: 'LTX2/ltx.safetensors', positivePrompt: 'The same shot with a red apple.', width: 1280, height: 704, frames: 121,
    sourceVideo: 'deas-inputs/street.mp4', firstFrame: 'raw/edit.png [output]' }); // the edited frame is used in place from the output folder
  expect(intent.ltx.sourceStrength).toBe(0.2);
});

test('a Replace video step "Re-animate" runs H3 image-to-video from the edited frame without the clip', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 22, wizard: 'replace', strategy: 'reanimate', pipeline: 'i2v', source: 'video', model: { name: 'h3.safetensors', path: '/m/h3' },
    picture: editedFrame, seconds: 5, size: { width: 1216, height: 672 }, positive: 'A red apple stays in the scene.', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(22, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ family: 'minimax-h3', model: 'h3.safetensors', width: 1216, height: 672, frames: 124, positivePrompt: 'A red apple stays in the scene.' });
  expect(intent.h3).toMatchObject({ mode: 'I2VA', references: [{ slot: 0, image: 'deas-inputs/edit.png' }] });
  expect(intent.sourceVideo).toBeUndefined();
});

test('a wizard video run reports its video file, not the first-frame picture of that job', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 23, wizard: 'replace', strategy: 'reanimate', pipeline: 'i2v', source: 'video', model: { name: 'h3.safetensors', path: '/m/h3' },
    picture: editedFrame, seconds: 5, size: { width: 1216, height: 672 }, positive: 'apple', run: true };
  vi.mocked(pollWorkbench).mockResolvedValue(collection([{ ...heldJob('wizard-video', 'succeeded', evidence.baseUrl), outputRoot: '/out',
    outputs: [{ filename: 'replace_00001-first-frame.png', subfolder: 'video', type: 'output' as const }, { filename: 'replace_00001.mp4', subfolder: 'video', type: 'output' as const, format: 'video/h264-mp4' }] }]));
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(23, undefined, expect.objectContaining({ state: 'succeeded', picture: expect.objectContaining({ path: '/out/video/replace_00001.mp4', video: true, checkpoint: 'h3.safetensors' }) })), { timeout: 8000 });
});

test('Beginner runs the Replace re-animate step at the wizard length and keeps that length for the next Run', async () => {
  const { applied, props, view } = await videoWorkbench(true);
  const handoff: WizardHandoff = { n: 24, wizard: 'replace', strategy: 'reanimate', pipeline: 'i2v', source: 'video', model: { name: 'h3.safetensors', path: '/m/h3' },
    picture: editedFrame, seconds: 4.2, size: { width: 1216, height: 672 }, positive: 'apple', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(24, undefined, expect.anything()), { timeout: 4000 });
  const reply = applied.mock.calls.find(c => c[0] === 24)!;
  expect(reply[2]).toMatchObject({ state: 'running' });
  expect(vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1]).toMatchObject({ family: 'minimax-h3', width: 1216, height: 672, h3: { mode: 'I2VA' } });
  // H3 frames follow 17k+5 at 24 fps; 4.2 s maps to the grid, not to a family default.
  const frames = (vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as { frames: number }).frames;
  expect((frames - 5) % 17).toBe(0); expect(frames).toBeGreaterThan(80); expect(frames).toBeLessThan(124);
  // The draft keeps the wizard's length for the next Run.
  vi.mocked(runWorkbenchJob).mockImplementation(async (base, intent) => ({ ...heldJob('again', 'failed', base), intent }));
  const runButton = document.querySelector('[data-run]') as HTMLButtonElement;
  await waitFor(() => expect(runButton.disabled).toBe(false), { timeout: 4000 });
  fireEvent.click(runButton);
  await waitFor(() => expect(vi.mocked(runWorkbenchJob).mock.calls.length).toBeGreaterThan(1));
  expect((vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as { frames: number }).frames).toBe(frames);
});

test('a Movie Maker shot without pictures runs H3 text-to-video at its seconds and canvas', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 31, wizard: 'movie', strategy: 'seg-2', pipeline: 't2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' },
    seconds: 5, size: { width: 1216, height: 672 }, positive: 'Ben hides in the alley', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(31, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ family: 'minimax-h3', model: 'h3.safetensors', width: 1216, height: 672, frames: 124, positivePrompt: 'Ben hides in the alley' });
  expect(intent.h3).toMatchObject({ mode: 'T2VA' });
  expect(intent.sourceVideo).toBeUndefined();
});

const vref = (n: string, extra: Record<string, unknown> = {}) => ({ name: n, path: `/pics/${n}`, src: `asset://localhost//pics/${n}`, media: 'image' as const, mediaMode: 'video' as const, second: 0, strength: 1, ...extra });
test('a Movie Maker scene with references runs H3 REF2VA with exactly those references and their labels', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 32, wizard: 'movie', strategy: 'seg-1', pipeline: 'ref2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' },
    videoRefs: [vref('anna.png', { label: 'character-1' }), vref('street.png', { label: 'place' })], seconds: 5, size: { width: 1216, height: 672 }, positive: 'Anna runs', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(32, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ family: 'minimax-h3', positivePrompt: 'Anna runs' });
  expect(intent.h3.mode).toBe('REF2VA');
  expect(intent.h3.media.filter((m: { type: string }) => m.type === 'image')).toHaveLength(2);
});

test('a Movie Maker scene with first and last frame runs H3 FL2VA with those frames and no references', async () => {
  const { applied, props, view } = await videoWorkbench();
  const pic = (n: string) => ({ name: n, path: `/pics/${n}`, src: `asset://localhost//pics/${n}` });
  const handoff: WizardHandoff = { n: 33, wizard: 'movie', strategy: 'seg-2', pipeline: 'i2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' },
    frames: { first: pic('open.png'), last: pic('close.png') }, seconds: 5, size: { width: 1216, height: 672 }, positive: 'Door opens', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(33, undefined, expect.objectContaining({ state: 'running' })), { timeout: 5000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent.h3.mode).toBe('FL2VA');
  expect(JSON.stringify(intent)).toContain('open.png');
  expect(JSON.stringify(intent)).toContain('close.png');
});

const chain: WizardHandoff = { n: 41, wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' }, seconds: 5, size: { width: 1216, height: 672 }, positive: 'Anna runs',
  continuity: { shotIds: ['seg-1', 'seg-2'], plan: { enabled: true, session: 'mm-movie-x-c1', outputMode: 'segment', overlapFrames: 22, steps: [{ id: 'seg-1', seconds: 5, action: 'Anna runs' }, { id: 'seg-2', seconds: 4, action: 'Anna stops' }] } } };

test('a Movie Maker chain runs on its own plan; the user\'s saved continuity plan is never touched and can be taken back', async () => {
  const mine = { session: 'my-session', outputMode: 'full', steps: [{ id: 'm1', seconds: 3, action: 'mine' }] };
  localStorage.setItem('deas.pref.studio.run.continuity', JSON.stringify(mine));
  const { applied, props, view } = await videoWorkbench();
  view.rerender(<I18nProvider><Workbench {...props} wizard={chain}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(41));
  expect(document.querySelector('[data-movie-plan-notice]')!.textContent).toContain('2 shots');
  expect(document.querySelector('[data-continuity-open]')!.getAttribute('data-continuity-enabled')).toBe('true');
  expect(prompt()).toBe('Anna runs');
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  expect(document.querySelectorAll('[data-step]')).toHaveLength(2);
  expect(screen.getByRole('textbox', { name: 'Session name' })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement).value).toBe('mm-movie-x-c1');
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!)).toEqual(mine);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Continuity' })).getByRole('button', { name: 'Close' }));
  fireEvent.click(document.querySelector('[data-movie-plan-release]')!);
  expect(document.querySelector('[data-movie-plan-notice]')).toBeNull();
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  expect((screen.getByRole('textbox', { name: 'Session name' }) as HTMLInputElement).value).toBe('my-session');
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity')!)).toEqual(mine);
});

test('Run all on a movie chain captures the first take, pins its clip, then continues from it with the next shot\'s action', async () => {
  const { applied, props, view } = await videoWorkbench();
  let n = 0;
  vi.mocked(runWorkbenchJob).mockImplementation(async (base, intent) => ({ ...heldJob(`chain-${++n}`, 'queued', base), intent }));
  vi.mocked(pollWorkbench).mockImplementation(async () => collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async r => ({ ...(await r.value), state: 'succeeded' as const })))));
  vi.mocked(readH3Session).mockResolvedValue({ latestId: null, clips: [{ clipId: 'take1', parent: null, frames: 124, completed: 1, export: null }, { clipId: 'take2', parent: 'take1', frames: 221, completed: 2, export: null }] } as never);
  view.rerender(<I18nProvider><Workbench {...props} wizard={chain}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(41));
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(2), { timeout: 8000 });
  const [first, second] = vi.mocked(runWorkbenchJob).mock.calls.map(c => c[1] as unknown as { positivePrompt: string; frames: number; h3: { mode: string; continuity: Record<string, unknown> } });
  expect([first.positivePrompt, first.frames, first.h3.mode]).toEqual(['Anna runs', 124, 'T2VA']);
  expect(first.h3.continuity).toMatchObject({ session: 'mm-movie-x-c1', sourceId: '', capture: true, outputMode: 'segment' });
  expect(Object.hasOwn(first.h3.continuity, 'overlapFrames')).toBe(false); // a new take has no source to overlap
  expect(second.h3.continuity).toMatchObject({ session: 'mm-movie-x-c1', sourceId: 'take1', capture: true, action: 'Anna stops', outputMode: 'segment', overlapFrames: 22 });
  expect(second.frames).toBeGreaterThan(0);
  expect(readH3Session).toHaveBeenCalledWith(expect.any(String), 'mm-movie-x-c1');
  expect(localStorage.getItem('deas.pref.studio.run.continuity')).not.toContain('mm-movie-x-c1');
});

test('a Movie Maker chain hand-over that asks to run starts Run all by itself and reports every shot with its own clip', async () => {
  const { applied, props, view } = await videoWorkbench();
  let n = 0;
  vi.mocked(runWorkbenchJob).mockImplementation(async (base, intent) => ({ ...heldJob(`chain-${++n}`, 'queued', base), intent }));
  vi.mocked(pollWorkbench).mockImplementation(async () => collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async (r, i) => ({ ...(await r.value), state: 'succeeded' as const, outputRoot: '/out',
    outputs: [{ filename: `shot${i + 1}.mp4`, subfolder: 'video', type: 'output' as const, format: 'video/h264-mp4' }, { filename: `shot${i + 1}-first-frame.png`, subfolder: 'video', type: 'output' as const }] })))));
  vi.mocked(readH3Session).mockResolvedValue({ latestId: null, clips: [{ clipId: 'take1', parent: null, frames: 124, completed: 1, export: null }, { clipId: 'take2', parent: 'take1', frames: 221, completed: 2, export: null }] } as never);
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 42, run: true }}/></I18nProvider>);
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(2), { timeout: 8000 });
  const reports = () => applied.mock.calls.filter(c => c[0] === 42).map(c => c[2]).filter(Boolean);
  await waitFor(() => expect(reports().filter(r => r.state === 'succeeded' && r.picture).map(r => [r.step.shotId, r.picture.path])).toEqual([['seg-1', '/out/video/shot1.mp4'], ['seg-2', '/out/video/shot2.mp4']]), { timeout: 8000 });
  const steps = reports().filter(r => r.step).map(r => r.step.index);
  expect(steps[0]).toBe(0);
  expect(reports().find(r => r.state === 'succeeded')!.step.total).toBe(2);
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.continuity') ?? '{"session":"none"}').session).not.toBe('mm-movie-x-c1');
});

test('a Movie Maker chain whose first shot cannot start stops Run all and reports the reason for that hand-over while leaving Studio Continuity unchanged', async () => {
  const userPlan = { enabled: true, session: 'my-session', outputMode: 'segment', steps: [{ id: 'u1', seconds: 5, action: 'user shot' }] };
  localStorage.setItem('deas.pref.studio.run.continuity', JSON.stringify(userPlan));
  const { applied, props, view } = await videoWorkbench();
  vi.mocked(runWorkbenchJob).mockRejectedValueOnce(new Error('queue rejected first take'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 43, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(43, undefined, {
    state: 'unknown',
    error: 'queue rejected first take',
    step: { index: 0, shotId: 'seg-1', total: 2 },
  }), { timeout: 5000 });
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  await waitFor(() => expect((document.querySelector('[data-movie-plan-release]') as HTMLButtonElement | null)?.disabled).toBe(false));

  // A capability block reached before `runWorkbenchJob` also reports the concrete reason for that hand-over number.
  // For a non-GGUF H3 run the backend capability check that owns Run is the sampler/scheduler and node allowlist
  // (the family's components come from the local model scan), so the block drops the sampler the recipe needs.
  vi.mocked(checkRecipePrerequisites).mockResolvedValue({
    ...videoEvidence,
    allowlist: { ...videoEvidence.allowlist, samplers: [] },
  });
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Continuity' })).getByRole('button', { name: 'Close' }));
  // Trigger a capability refresh via Options dock so the missing sampler blocks Run before submission.
  fireEvent.click(document.querySelector('[data-dock-tab="options"]')!);
  await waitFor(() => expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(true));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 44, run: true }}/></I18nProvider>);
  // The reason is the unavailable list naming the sampler the recipe needs (res_multistep is Generate's current sampler).
  await waitFor(() => expect(applied).toHaveBeenCalledWith(44, undefined, expect.objectContaining({
    state: 'unknown',
    error: expect.stringContaining('res_multistep'),
    step: { index: 0, shotId: 'seg-1', total: 2 },
  })), { timeout: 5000 });
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);

  // Release the Movie Maker plan and restore prerequisites: ordinary Studio Continuity never emits wizard outcomes on failure.
  vi.mocked(checkRecipePrerequisites).mockResolvedValue({
    ...videoEvidence,
    allowlist: { ...videoEvidence.allowlist, nodes: [...videoEvidence.allowlist.nodes, 'UNETLoader', 'CLIPLoader', 'VAELoader'], diffusionModels: ['h3.safetensors'], textEncoders: ['minimax_h3_encoder.safetensors'], vaes: ['h3_video_vae.safetensors', 'h3_audio_vae.safetensors'], clipTypes: ['minimax'] },
  });
  fireEvent.click(document.querySelector('[data-dock-tab="media"]')!);
  fireEvent.click(document.querySelector('[data-dock-tab="options"]')!);
  await waitFor(() => expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(document.querySelector('[data-movie-plan-release]')!);
  applied.mockClear();
  vi.mocked(runWorkbenchJob).mockRejectedValueOnce(new Error('studio continuity error'));
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(2), { timeout: 5000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(applied).not.toHaveBeenCalled();
}, 30000);

test('a Movie Maker chain where pinClip fails after an intermediate shot reports the finished clip first and then reports why the chain cannot continue', async () => {
  const userPlan = { enabled: true, session: 'my-session', outputMode: 'segment', steps: [{ id: 'u1', seconds: 5, action: 'one' }, { id: 'u2', seconds: 4, action: 'two' }] };
  localStorage.setItem('deas.pref.studio.run.continuity', JSON.stringify(userPlan));
  const { applied, props, view } = await videoWorkbench();
  let n = 0;
  vi.mocked(runWorkbenchJob).mockImplementation(async (base, intent) => ({ ...heldJob(`chain-${++n}`, 'queued', base), intent }));
  vi.mocked(pollWorkbench).mockImplementation(async () => collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async (r, i) => ({
    ...(await r.value),
    state: 'succeeded' as const,
    outputRoot: '/out',
    outputs: [{ filename: `shot${i + 1}.mp4`, subfolder: 'video', type: 'output' as const, format: 'video/h264-mp4' }],
  })))));

  // 1. Session read rejects after step 0 succeeded: step 0's clip is delivered first, step 1 never starts, and step 1's abort is reported.
  vi.mocked(readH3Session).mockRejectedValueOnce(new Error('H3 session read failed'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 45, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(45, undefined, {
    state: 'unknown',
    error: 'H3 session read failed',
    step: { index: 1, shotId: 'seg-2', total: 2 },
  }), { timeout: 8000 });
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  const calls45 = applied.mock.calls.filter(c => c[0] === 45).map(c => c[2]).filter(Boolean);
  const step0At = calls45.findIndex(r => r.state === 'succeeded' && r.step?.shotId === 'seg-1' && r.picture?.path === '/out/video/shot1.mp4');
  const abortAt = calls45.findIndex(r => r.state === 'unknown' && r.step?.shotId === 'seg-2' && r.error === 'H3 session read failed');
  expect(step0At).toBeGreaterThanOrEqual(0);
  expect(abortAt).toBeGreaterThan(step0At);
  await waitFor(() => expect((document.querySelector('[data-movie-plan-release]') as HTMLButtonElement | null)?.disabled).toBe(false));

  // 2. Session read resolves with no matching clip: `resolveClip` fails with `noClip`, stopping before step 1 and reporting back.
  vi.mocked(readH3Session).mockResolvedValueOnce({ latestId: null, clips: [] } as never);
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 46, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(46, undefined, expect.objectContaining({
    state: 'unknown',
    error: expect.stringMatching(/\S/),
    step: { index: 1, shotId: 'seg-2', total: 2 },
  })), { timeout: 8000 });
  expect(runWorkbenchJob).toHaveBeenCalledTimes(2);
  const calls46 = applied.mock.calls.filter(c => c[0] === 46).map(c => c[2]).filter(Boolean);
  expect(calls46.some(r => r.state === 'succeeded' && r.step?.shotId === 'seg-1' && r.picture?.path === '/out/video/shot2.mp4')).toBe(true);

  // 3. Ordinary Studio Continuity (`userPlan`) stays unchanged: a `pinClip` failure stops Run all locally without calling `onWizardApplied`.
  await waitFor(() => expect((document.querySelector('[data-movie-plan-release]') as HTMLButtonElement | null)?.disabled).toBe(false));
  fireEvent.click(document.querySelector('[data-movie-plan-release]')!);
  applied.mockClear();
  vi.mocked(readH3Session).mockRejectedValueOnce(new Error('user session read failed'));
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
  await waitFor(() => expect(readH3Session).toHaveBeenCalledWith(expect.any(String), 'my-session'), { timeout: 8000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(runWorkbenchJob).toHaveBeenCalledTimes(3);
  expect(applied).not.toHaveBeenCalled();
}, 30000);

test('stopping a Movie Maker chain in Generate delivers a reconciled intermediate clip before ending the chain, avoids duplicate notices on cancelled jobs, and leaves Studio Continuity unchanged', async () => {
  const userPlan = { enabled: true, session: 'my-session', outputMode: 'segment', steps: [{ id: 'u1', seconds: 5, action: 'one' }, { id: 'u2', seconds: 4, action: 'two' }] };
  localStorage.setItem('deas.pref.studio.run.continuity', JSON.stringify(userPlan));
  const { applied, props, view } = await videoWorkbench();

  // 1. Stop all (`stop()`): intermediate shot reconciles as `succeeded` in `stopWorkbench()` -> valid clip delivered first, then chain ended, no step 1.
  vi.mocked(runWorkbenchJob).mockImplementationOnce(async (base, intent) => ({ ...heldJob('chain-s1', 'running', base), intent }));
  vi.mocked(pollWorkbench).mockImplementation(async () => collection([{ ...heldJob('chain-s1', 'running', evidence.baseUrl) }]));
  vi.mocked(stopWorkbench).mockResolvedValueOnce({
    ...collection([{ ...heldJob('chain-s1', 'succeeded', evidence.baseUrl), outputRoot: '/out', outputs: [{ filename: 'shot1.mp4', subfolder: 'video', type: 'output' as const, format: 'video/h264-mp4' }] }]),
    outcome: 'settled', discarded: 0, issues: [],
  });
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 47, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(47, undefined, expect.objectContaining({ state: 'running', step: { index: 0, shotId: 'seg-1', total: 2 } })), { timeout: 5000 });
  fireEvent.click(document.querySelector('[data-run-stop]')!);
  fireEvent.click(document.querySelector('[data-run-stop-all]')!);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(47, undefined, expect.objectContaining({
    state: 'unknown',
    error: expect.stringMatching(/\S/),
    step: { index: 1, shotId: 'seg-2', total: 2 },
  })), { timeout: 5000 });
  expect(stopWorkbench).toHaveBeenCalledTimes(1);
  expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
  expect(readH3Session).not.toHaveBeenCalled();
  const calls47 = applied.mock.calls.filter(c => c[0] === 47).map(c => c[2]).filter(Boolean);
  const s1ClipAt = calls47.findIndex(r => r.state === 'succeeded' && r.step?.shotId === 'seg-1' && r.picture?.path === '/out/video/shot1.mp4');
  const s1EndAt = calls47.findIndex(r => r.state === 'unknown' && r.step?.shotId === 'seg-2');
  expect(s1ClipAt).toBeGreaterThanOrEqual(0);
  expect(s1EndAt).toBeGreaterThan(s1ClipAt);

  // 2. Stop current (`stopJob()`): intermediate shot stays `running` during `stopWorkbenchJob` and reconciles as `succeeded` on poll -> clip first, then chain ended.
  vi.mocked(runWorkbenchJob).mockImplementationOnce(async (base, intent) => ({ ...heldJob('chain-s2', 'running', base), intent }));
  let s2Stopped = false;
  vi.mocked(pollWorkbench).mockImplementation(async () => collection([{
    ...heldJob('chain-s2', s2Stopped ? 'succeeded' : 'running', evidence.baseUrl),
    ...(s2Stopped ? { outputRoot: '/out', outputs: [{ filename: 'shot2.mp4', subfolder: 'video', type: 'output' as const, format: 'video/h264-mp4' }] } : {}),
  }]));
  vi.mocked(stopWorkbenchJob).mockImplementationOnce(async job => { s2Stopped = true; return { ...job, state: 'running' }; });
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 48, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(48, undefined, expect.objectContaining({ state: 'running', step: { index: 0, shotId: 'seg-1', total: 2 } })), { timeout: 5000 });
  fireEvent.click(document.querySelector('[data-run-stop]')!);
  fireEvent.click(document.querySelector('[data-run-stop-current]')!);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(48, undefined, expect.objectContaining({
    state: 'unknown',
    error: expect.stringMatching(/\S/),
    step: { index: 1, shotId: 'seg-2', total: 2 },
  })), { timeout: 8000 });
  expect(stopWorkbenchJob).toHaveBeenCalledTimes(1);
  expect(runWorkbenchJob).toHaveBeenCalledTimes(2);
  const calls48 = applied.mock.calls.filter(c => c[0] === 48).map(c => c[2]).filter(Boolean);
  const s2ClipAt = calls48.findIndex(r => r.state === 'succeeded' && r.step?.shotId === 'seg-1' && r.picture?.path === '/out/video/shot2.mp4');
  const s2EndAt = calls48.findIndex(r => r.state === 'unknown' && r.step?.shotId === 'seg-2');
  expect(s2ClipAt).toBeGreaterThanOrEqual(0);
  expect(s2EndAt).toBeGreaterThan(s2ClipAt);

  // 3. Stopped job reconciles as `cancelled`: single terminal notice, no duplicate `unknown` notice.
  vi.mocked(runWorkbenchJob).mockImplementationOnce(async (base, intent) => ({ ...heldJob('chain-s3', 'running', base), intent }));
  vi.mocked(pollWorkbench).mockImplementation(async () => collection([{ ...heldJob('chain-s3', 'running', evidence.baseUrl) }]));
  vi.mocked(stopWorkbench).mockResolvedValueOnce({
    ...collection([{ ...heldJob('chain-s3', 'cancelled', evidence.baseUrl) }]),
    outcome: 'settled', discarded: 0, issues: [],
  });
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...chain, n: 49, run: true }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(49, undefined, expect.objectContaining({ state: 'running', step: { index: 0, shotId: 'seg-1', total: 2 } })), { timeout: 5000 });
  fireEvent.click(document.querySelector('[data-run-stop]')!);
  fireEvent.click(document.querySelector('[data-run-stop-all]')!);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(49, undefined, expect.objectContaining({
    state: 'cancelled',
    error: expect.stringMatching(/\S/),
    step: { index: 0, shotId: 'seg-1', total: 2 },
  })), { timeout: 5000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  const terminal49 = applied.mock.calls.filter(c => c[0] === 49 && c[2] && c[2].state !== 'queued' && c[2].state !== 'running');
  expect(terminal49).toHaveLength(1);

  // 4. Ordinary Studio Continuity (`userPlan`) stays unchanged when stopped and reconciling as `succeeded`.
  await waitFor(() => expect((document.querySelector('[data-movie-plan-release]') as HTMLButtonElement | null)?.disabled).toBe(false));
  fireEvent.click(document.querySelector('[data-movie-plan-release]')!);
  applied.mockClear();
  vi.mocked(runWorkbenchJob).mockImplementationOnce(async (base, intent) => ({ ...heldJob('user-s1', 'running', base), intent }));
  vi.mocked(stopWorkbench).mockResolvedValueOnce({
    ...collection([{ ...heldJob('user-s1', 'succeeded', evidence.baseUrl), outputRoot: '/out', outputs: [{ filename: 'u1.mp4', subfolder: 'video', type: 'output' as const, format: 'video/h264-mp4' }] }]),
    outcome: 'settled', discarded: 0, issues: [],
  });
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(4), { timeout: 5000 });
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Continuity' })).getByRole('button', { name: 'Close' }));
  fireEvent.click(document.querySelector('[data-run-stop]')!);
  fireEvent.click(document.querySelector('[data-run-stop-all]')!);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(runWorkbenchJob).toHaveBeenCalledTimes(4);
  expect(applied).not.toHaveBeenCalled();
}, 30000);

test('a Movie Maker music bed hand-over fills the ACE-Step draft (style, no lyrics, the film\'s length), runs it, and reports the audio file', async () => {
  const view = await mountAce();
  const props = { endpoint: evidence.baseUrl, root: '/env', roots: { models: '/m' } };
  const applied = vi.fn();
  vi.mocked(pollWorkbench).mockImplementation(async () => collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async r => ({ ...(await r.value), state: 'succeeded' as const, outputRoot: '/out',
    outputs: [{ filename: 'bed_00001_.flac', subfolder: 'audio', type: 'output' as const, format: 'audio/flac' }] })))));
  const handoff: WizardHandoff = { n: 51, wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', positive: '', run: true,
    model: { name: 'ace-step-1-5-turbo.safetensors', path: '/m/checkpoints/ace-step-1-5-turbo.safetensors' }, music: { style: 'calm cinematic piano', lyrics: '', seconds: 42 } };
  view.rerender(<I18nProvider><Workbench {...props} onWizardApplied={applied} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(1), { timeout: 6000 });
  expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({ recipeId: 'music-generation', family: 'ace-step-1-5-turbo', checkpoint: 'ace-step-1-5-turbo.safetensors', style: 'calm cinematic piano', lyrics: '', maxDuration: 42 });
  await waitFor(() => expect(applied).toHaveBeenCalledWith(51, undefined, expect.objectContaining({ state: 'succeeded', picture: expect.objectContaining({ path: '/out/audio/bed_00001_.flac', audio: true, width: 0, height: 0, checkpoint: 'ace-step-1-5-turbo.safetensors' }) })), { timeout: 8000 });
});

test('a Movie Maker music hand-over runs ACE-Step with exactly its LoRAs, and without LoRAs it clears Generate\'s list', async () => {
  localStorage.setItem('deas.pref.studio.run.loras', JSON.stringify([{ name: 'picture.safetensors', strength: 1, enabled: true }]));
  const lofi = { category: 'loras', name: 'ace/lofi.safetensors', path: '/m/loras/ace/lofi.safetensors', size: 1, info: null, family: 'ace-step-1-5' };
  const picture = { category: 'loras', name: 'picture.safetensors', path: '/m/loras/picture.safetensors', size: 1, info: null, family: 'sdxl' };
  const view = await mountAce('checkpoints', [], [lofi, picture] as never);
  const props = { endpoint: evidence.baseUrl, root: '/env', roots: { models: '/m' } };
  const applied = vi.fn();
  const base: WizardHandoff = { n: 52, wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', positive: '', run: true,
    model: { name: 'ace-step-1-5-turbo.safetensors', path: '/m/checkpoints/ace-step-1-5-turbo.safetensors' }, music: { style: 'lofi', lyrics: '', seconds: 30 }, loras: [{ name: 'ace/lofi.safetensors', strength: 0.6 }] };
  view.rerender(<I18nProvider><Workbench {...props} onWizardApplied={applied} wizard={base}/></I18nProvider>);
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(1), { timeout: 6000 });
  expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({ family: 'ace-step-1-5-turbo', loras: [{ name: 'ace/lofi.safetensors', strength: 0.6 }] });
  view.rerender(<I18nProvider><Workbench {...props} onWizardApplied={applied} wizard={{ ...base, n: 53, loras: [] }}/></I18nProvider>);
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(2), { timeout: 6000 });
  expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).not.toHaveProperty('loras');
});

test('a Movie Maker shot with LoRAs runs with exactly those LoRAs on its model and replaces whatever Generate had selected', async () => {
  localStorage.setItem('deas.pref.studio.run.loras', JSON.stringify([{ name: 'other.safetensors', strength: 1, enabled: true }]));
  const lora = { category: 'loras', name: 'MiniMaxH3/style.safetensors', path: '/m/loras/MiniMaxH3/style.safetensors', size: 1, info: null, family: 'minimax-h3' };
  const ms = [...ltxModels, ...h3Set, lora];
  vi.mocked(scanModels).mockResolvedValue(ms as never);
  vi.mocked(checkRecipePrerequisites).mockResolvedValue({ ...videoEvidence, allowlist: { ...videoEvidence.allowlist, nodes: [...videoEvidence.allowlist.nodes, 'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'VAELoader', 'LoraLoaderModelOnly'], loras: ['MiniMaxH3/style.safetensors', 'other.safetensors'],
    diffusionModels: ms.filter(m => 'family' in m && m.family && m.category !== 'loras').map(m => m.name), textEncoders: ms.filter(m => m.category === 'text_encoders').map(m => m.name), vaes: ms.filter(m => m.category === 'vae').map(m => m.name), clipTypes: ['ltxv', 'minimax'] } });
  vi.mocked(runWorkbenchJob).mockImplementation(async (base, intent) => ({ ...heldJob('lora-shot', 'running', base), intent }));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m', output: '/out' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toMatch(/ltx|h3/));
  const handoff: WizardHandoff = { n: 61, wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' }, seconds: 5,
    size: { width: 1216, height: 672 }, positive: 'Anna runs', run: true, loras: [{ name: 'MiniMaxH3/style.safetensors', strength: 0.7 }] };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(61, undefined, expect.objectContaining({ state: 'running' })), { timeout: 5000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ family: 'minimax-h3', model: 'h3.safetensors', positivePrompt: 'Anna runs', loras: [{ name: 'MiniMaxH3/style.safetensors', strength: 0.7 }] });
});

test('a Movie Maker shot with aspect auto switches Generate to its own auto aspect (first reference) instead of a fixed size', async () => {
  localStorage.setItem('deas.pref.studio.run.aspect', JSON.stringify('16:9'));
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 72, wizard: 'movie', strategy: 'seg-1', pipeline: 'ref2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' }, videoRefs: [vref('anna.png')],
    aspect: 'auto', seconds: 5, positive: 'Anna runs', run: false };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied.mock.calls.some(c => c[0] === 72)).toBe(true), { timeout: 5000 });
  await waitFor(() => expect((document.querySelector('[data-aspect]') as HTMLSelectElement | null)?.value).toBe('auto'), { timeout: 5000 });
});

test('a Movie Maker shot in reference mode runs REF2VA with its pictures and its slice of the music track as an audio reference', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 71, wizard: 'movie', strategy: 'seg-2', pipeline: 'ref2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' }, videoRefs: [vref('anna.png')],
    audioRef: { name: 'bed.flac', path: '/music/bed.flac', src: 'asset://localhost//music/bed.flac', trimStart: 10.125, trimEnd: 15.125 }, seconds: 5, size: { width: 1216, height: 672 }, positive: 'Anna runs', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(71, undefined, expect.objectContaining({ state: 'running' })), { timeout: 5000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent.h3.mode).toBe('REF2VA');
  const media = intent.h3.media as { type: string; file: string; trimStart?: number; trimEnd?: number }[];
  expect(media.map(m => m.type)).toEqual(['image', 'audio']);
  expect(media[1]).toMatchObject({ file: 'deas-inputs/bed.flac', trimStart: 10.125, trimEnd: 15.125 });
});

test('a Movie Maker shot with the movie\'s own settings runs at exactly its Steps, CFG, sampler and scheduler', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 61, wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' },
    seconds: 5, size: { width: 1152, height: 672 }, positive: 'Anna runs', run: true, sampling: { steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' } };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(61, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ family: 'minimax-h3', width: 1152, height: 672, steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' });
});

test('a Movie Maker shot without a fixed size takes the movie\'s aspect and resolution choice through Generate\'s own canvas rule', async () => {
  const { applied, props, view } = await videoWorkbench();
  const handoff: WizardHandoff = { n: 62, wizard: 'movie', strategy: 'seg-1', pipeline: 't2v', source: 'movie', model: { name: 'h3.safetensors', path: '/m/h3' },
    seconds: 5, aspect: '9:16', resolution: '720p', positive: 'Anna runs', run: true };
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(62, undefined, expect.objectContaining({ state: 'running' })), { timeout: 4000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls.at(-1)![1] as unknown as Record<string, any>;
  // Generate's 9:16 at 720p on H3's 32-px grid (the size Movie Maker shows for this choice).
  expect([intent.width, intent.height]).toEqual([736, 1248]);
});

test('a Movie Maker music hand-over with lyrics sets ACE-Step 1.5\'s tempo and lyrics language and the model\'s sampling', async () => {
  const view = await mountAce();
  const props = { endpoint: evidence.baseUrl, root: '/env', roots: { models: '/m' } };
  const handoff: WizardHandoff = { n: 63, wizard: 'movie', strategy: 'music', pipeline: 't2m', source: 'movie', positive: '', run: true,
    model: { name: 'ace-step-1-5-turbo.safetensors', path: '/m/checkpoints/ace-step-1-5-turbo.safetensors' }, music: { style: 'noir jazz', lyrics: '[Verse]\nRegen', seconds: 30, bpm: 85, language: 'de' },
    sampling: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' } };
  view.rerender(<I18nProvider><Workbench {...props} onWizardApplied={vi.fn()} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(runWorkbenchJob).toHaveBeenCalledTimes(1), { timeout: 6000 });
  const intent = vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as Record<string, any>;
  expect(intent).toMatchObject({ recipeId: 'music-generation', style: 'noir jazz', lyrics: '[Verse]\nRegen', maxDuration: 30, steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' });
  expect([intent.ace.bpm, intent.ace.language, intent.ace.shift]).toEqual([85, 'de', 3]);
});
