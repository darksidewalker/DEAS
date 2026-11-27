import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { librarySearchEvent } from '../../lib/wizards';
import { DarkWizards } from './DarkWizards';
import type { JobStatus } from '../../lib/jobs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const qwen = { category: 'diffusion_models', name: 'qwen_image_2.1_turbo.safetensors', path: '/m/diffusion_models/qwen_image_2.1_turbo.safetensors', size: 1, info: null, family: 'qwen-image-2.1-turbo' };
const qwenFull = { category: 'diffusion_models', name: 'qwen_image_2.1_int8.safetensors', path: '/m/diffusion_models/qwen_image_2.1_int8.safetensors', size: 1, info: null, family: 'qwen-image-2.1' };
const sdxl = { category: 'checkpoints', name: 'sdxl.safetensors', path: '/m/checkpoints/sdxl.safetensors', size: 1, info: null, family: 'sdxl' };
const lora = { category: 'loras', name: 'qwen-lora.safetensors', path: '/m/loras/qwen-lora.safetensors', size: 1, info: null, family: 'qwen-image-2.1' };
let models: unknown[];
let picks: string[];
const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === name).map(([, a]) => a as Record<string, unknown>);

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  models = [qwen, sdxl, lora]; picks = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_models_scan') return models;
    if (command === 'native_analysis_pick') return picks.shift() ?? '/pics/street.png';
    if (command === 'native_media_describe') return a.paths.map((path: string) => ({ kind: 'file', name: path.split('/').pop(), path, media: /\.(png|jpe?g|webp)$/i.test(path) ? 'image' : /\.(mp4|mov|webm|mkv)$/i.test(path) ? 'video' : null }));
    if (command === 'native_analysis_frames_open') return { name: 'clip', width: 1280, height: 720, fps: 24, count: 192, duration: 8, stride: 1, thumbs: [] };
    if (command === 'native_analysis_frame') return `/runtime/frames/${a.index}.png`;
    if (command === 'native_media_copy_in') return '/in/clip-first.png';
    if (command === 'native_workbench_interrupt_running' || command === 'native_workbench_cancel_pending') return { ...(a as object) } as never;
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const ui = (props: Partial<Parameters<typeof DarkWizards>[0]> = {}) => {
  const onPrepare = vi.fn();
  const view = render(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} {...props}/></I18nProvider>);
  return { onPrepare, view };
};
async function choosePicture(width = 1920, height = 1080, slot: 'picture to change' | 'object to put in' = 'picture to change', name = 'street.png') {
  fireEvent.click(await screen.findByRole('button', { name: `Choose… ${slot}` }));
  const img = await screen.findByRole('img', { name });
  Object.defineProperties(img, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  fireEvent.load(img);
  await screen.findByText(`${name} · ${width}×${height}`);
}
const type = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });

it('prefers the Qwen reference edit, keeps the picture aspect on the 32 px grid and prepares Generate without running', async () => {
  const { onPrepare } = ui();
  await choosePicture();
  const prepare = screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement;
  expect(screen.getByRole('button', { name: 'Reference edit (Qwen Image 2.1)', pressed: true })).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path);
  type('With what', 'a blue bicycle');
  expect(prepare.disabled).toBe(true); // the reference template also needs "Replace what"
  type('Replace what', 'the red car');
  expect(prepare.disabled).toBe(false);
  fireEvent.click(prepare);
  expect(onPrepare).toHaveBeenCalledTimes(1);
  const handoff = onPrepare.mock.calls[0][0];
  expect(handoff).toMatchObject({ wizard: 'replace', strategy: 'reference', pipeline: 't2i', source: 'reference', model: { name: qwen.name, path: qwen.path },
    picture: { name: 'street.png', path: '/pics/street.png', src: 'asset:///pics/street.png' },
    positive: 'Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.' });
  expect(handoff.edit).toBeUndefined();
  expect(handoff.size.width % 32).toBe(0); expect(handoff.size.height % 32).toBe(0);
  expect(Math.abs(handoff.size.width / handoff.size.height - 16 / 9)).toBeLessThan(0.05);
  expect(calls('native_models_scan')).toEqual([{ root: '/m' }]);
  // The wizard only scans, describes and asks for a file; it never prepares, uploads or submits jobs itself.
  expect(vi.mocked(invoke).mock.calls.map(([c]) => c).sort()).toEqual(['native_analysis_pick', 'native_media_describe', 'native_models_scan']);
});

it('falls back to inpaint with only the replacement text, and lets the user switch methods when both exist', async () => {
  models = [sdxl];
  const { onPrepare } = ui();
  await choosePicture(1000, 600);
  expect(screen.getByRole('button', { name: 'Reference edit (Qwen Image 2.1)' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Paint a mask (inpaint)', pressed: true })).toBeTruthy();
  expect(screen.getByText(/Paint over what should change/)).toBeTruthy();
  type('With what', 'a cat');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'inpaint', pipeline: 'i2i', source: 'edit', edit: 'inpaint', positive: 'a cat', model: { path: sdxl.path } });
  expect(onPrepare.mock.calls[0][0].size).toBeUndefined();
  cleanup(); models = [qwen, sdxl];
  ui();
  await screen.findByRole('button', { name: 'Reference edit (Qwen Image 2.1)', pressed: true });
  fireEvent.click(screen.getByRole('button', { name: 'Paint a mask (inpaint)' }));
  // Painting a mask keeps the Qwen model; other families are only offered below it.
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path);
  expect([...(screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).options].map(o => o.value)).toEqual([qwen.path, sdxl.path]);
});

it('Look again stays available beside the model, so a model copied in later becomes the preferred choice', async () => {
  models = [sdxl];
  ui();
  await choosePicture(1024, 640);
  expect((await screen.findByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(sdxl.path);
  expect(screen.getByRole('button', { name: 'Paint a mask (inpaint)', pressed: true })).toBeTruthy();
  models = [qwen, sdxl];
  fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path));
  expect(screen.getByRole('button', { name: 'Reference edit (Qwen Image 2.1)', pressed: true })).toBeTruthy();
  expect(calls('native_models_scan').at(-1)).toMatchObject({ refresh: true });
});

it('without a suitable model offers the Library search and a rescan instead of guessing', async () => {
  models = [{ ...sdxl, family: null }, lora];
  const asked = vi.fn(); window.addEventListener(librarySearchEvent, asked);
  ui();
  expect(await screen.findByText(/No suitable model is installed\. The wizard prefers Qwen Image 2\.1/)).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Find in Library' }));
  expect((asked.mock.calls[0][0] as CustomEvent).detail).toBe('Qwen Image 2.1');
  window.removeEventListener(librarySearchEvent, asked);
  models = [qwen];
  fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
  await screen.findByRole('combobox', { name: 'Model' });
  expect(calls('native_models_scan').at(-1)).toEqual({ root: '/m', refresh: true });
  expect((screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement).disabled).toBe(true); // no picture yet
});

it('takes a file copied in a file manager by Ctrl+V, refuses other files, and shows Generate\'s refusal of the current hand-over', async () => {
  const { view, onPrepare } = ui({ handoff: 2, outcome: { n: 1, error: 'old refusal' } });
  await screen.findByRole('combobox', { name: 'Model' });
  expect(screen.queryByText('old refusal')).toBeNull();
  expect((screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement).disabled).toBe(true); // hand-over 2 still pending
  fireEvent.paste(document.body, { clipboardData: { files: [], getData: (type: string) => type === 'text/uri-list' ? 'file:///pics/My%20Cat.webp' : '' } });
  expect(await screen.findByRole('img', { name: 'My Cat.webp' })).toBeTruthy();
  fireEvent.paste(document.body, { clipboardData: { files: [], getData: (type: string) => type === 'text/plain' ? '/pics/clip.mp4' : '' } });
  // The highlighted slot is now the object picture, which cannot be a video; the picture to change stays.
  await screen.findByText('A video goes into “Picture to change”; the object to put in must be a picture.');
  expect(screen.getByRole('img', { name: 'My Cat.webp' })).toBeTruthy();
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} handoff={2} outcome={{ n: 2, error: 'Generate cannot use the model the wizard chose.' }}/></I18nProvider>);
  expect(screen.getByText('Generate cannot use the model the wizard chose.')).toBeTruthy();
  await waitFor(() => expect(calls('native_media_describe')).toEqual([{ paths: ['/pics/My Cat.webp'] }, { paths: ['/pics/clip.mp4'] }]));
  expect(calls('native_analysis_frames_open')).toEqual([]);
});

it('runs the prepared draft through Generate with Prepare and run, and keeps that button closed for the mask method without SAM 3.1', async () => {
  const { onPrepare } = ui({ sam: 'SAM 3.1 needs the SAM3_Detect node.' });
  await choosePicture();
  type('With what', 'a blue bicycle'); type('Replace what', 'the red car');
  const run = screen.getByRole('button', { name: 'Prepare and run' }) as HTMLButtonElement;
  expect(run.disabled).toBe(false);
  fireEvent.click(run);
  expect(onPrepare).toHaveBeenCalledTimes(1);
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'reference', source: 'reference', run: true, model: { path: qwen.path } });
  const runSize = onPrepare.mock.calls[0][0].size as { width: number; height: number };
  expect(runSize.width % 32).toBe(0); expect(runSize.height % 32).toBe(0);
  // The wizard itself never submits: only the hand-over leaves this component.
  expect(vi.mocked(invoke).mock.calls.map(([c]) => c).sort()).toEqual(['native_analysis_pick', 'native_media_describe', 'native_models_scan']);
  // Without SAM 3.1 a masked method has no way to get its mask, so it stays a draft the user runs in Generate, with Generate's reason.
  fireEvent.click(screen.getByRole('button', { name: 'Paint a mask (inpaint)' }));
  expect((screen.getByRole('button', { name: 'Prepare and run' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Prepare and run' }).getAttribute('title')).toBe('SAM 3.1 needs the SAM3_Detect node.');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls[1][0]).toMatchObject({ strategy: 'inpaint' });
  expect(onPrepare.mock.calls[1][0].run).toBeUndefined();
});

it('runs the mask method with SAM 3.1: Replace what becomes the mask target, and the masking stage has no Stop of its own', async () => {
  const { onPrepare, view } = ui({ sam: '' });
  await choosePicture(1024, 640);
  fireEvent.click(await screen.findByRole('button', { name: 'Paint a mask (inpaint)' }));
  type('With what', 'a blue bicycle');
  const run = () => screen.getByRole('button', { name: 'Prepare and run' }) as HTMLButtonElement;
  // The mask target is "Replace what", so the run waits for it even though the inpaint prompt only needs "With what".
  expect(run().disabled).toBe(true);
  expect(run().getAttribute('title')).toBe('Name what to replace: SAM 3.1 uses it to find the mask.');
  expect((screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement).disabled).toBe(false);
  type('Replace what', '  the   red car ');
  expect(run().disabled).toBe(false); expect(run().getAttribute('title')).toBeNull();
  fireEvent.click(run());
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'inpaint', source: 'edit', edit: 'inpaint', run: true, mask: 'the red car', positive: 'a blue bicycle', denoise: 1 });
  // A plain prepare never carries a mask target.
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls[1][0].mask).toBeUndefined();
  expect(vi.mocked(invoke).mock.calls.map(([c]) => c).sort()).toEqual(['native_analysis_pick', 'native_media_describe', 'native_models_scan']);
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} sam="" handoff={2} outcome={{ n: 2, run: { state: 'queued', masking: true } }}/></I18nProvider>);
  expect(screen.getByText('Finding the mask with SAM 3.1…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  expect(run().disabled).toBe(true);
  const open = vi.fn();
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} sam="" handoff={2} onOpenGenerate={open} outcome={{ n: 2, run: { state: 'unknown', error: 'SAM 3.1 found no “the red car” in the picture. Draw the mask in Generate and press Run there.' } }}/></I18nProvider>);
  expect(screen.getByText(/SAM 3.1 found no “the red car”/)).toBeTruthy();
  // Nothing was submitted, so the status does not send the user to an unknown queue outcome.
  expect(document.querySelector('[data-wizard-run-status]')?.textContent).toBe('Nothing was drawn.');
  // The prepared draft is in Generate, so the way there is offered with the message.
  fireEvent.click(screen.getByRole('button', { name: 'Show in Generate' }));
  expect(open).toHaveBeenCalledTimes(1);
});

it('follows the wizard run Generate reports: progress, Stop for that one job, then the finished picture', async () => {
  const job: JobStatus = { id: 'wizard-run', baseUrl: 'http://127.0.0.1:7801/', promptId: 'p-wizard', state: 'running', outputs: [], error: null, generationReady: false, progress: { value: 4, max: 20 }, preview: 'data:image/png;base64,prev' };
  const open = vi.fn();
  const { view, onPrepare } = ui({ handoff: 3, outcome: { n: 3, run: { state: 'running', value: 4, max: 20, preview: 'data:image/png;base64,prev', job } } });
  expect(screen.getByText('Drawing… 4/20')).toBeTruthy();
  // Before the first step report there is no count: a plain status, never the raw {value}/{max} template.
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} handoff={3} outcome={{ n: 3, run: { state: 'running', job } }}/></I18nProvider>);
  expect(document.querySelector('[data-wizard-run-status]')?.textContent).toBe('Drawing…');
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} handoff={3} outcome={{ n: 3, run: { state: 'running', value: 4, max: 20, preview: 'data:image/png;base64,prev', job } }}/></I18nProvider>);
  expect(document.querySelector('[data-wizard-run-state="running"] img')?.getAttribute('src')).toBe('data:image/png;base64,prev');
  expect((screen.getByRole('button', { name: 'Prepare and run' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(calls('native_workbench_interrupt_running')).toEqual([{ jobId: 'wizard-run', confirmed: true }]));
  const done: JobStatus = { ...job, state: 'succeeded', progress: undefined, preview: undefined };
  const finished = { n: 3, run: { state: 'succeeded' as const, job: done, picture: { path: '/out/DEAS/replace/done.png', width: 1216, height: 672, seed: 7, checkpoint: 'qwen_image_2.1_turbo.safetensors', ms: 4200 } } };
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} handoff={3} onOpenGenerate={open} outcome={finished}/></I18nProvider>);
  expect(await screen.findByText('1216×672 · qwen_image_2.1_turbo · seed 7 · 4.2 s')).toBeTruthy();
  expect(document.querySelector('[data-wizard-run-state="succeeded"] img')?.getAttribute('src')).toBe('asset:///out/DEAS/replace/done.png');
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show in Generate' }));
  expect(open).toHaveBeenCalledTimes(1);
});

it('names a failed or unstartable wizard run with Generate\'s reason and never shows a picture for it', async () => {
  ui({ handoff: 6, outcome: { n: 6, run: { state: 'failed', error: 'ClipVisionLoader missing', job: { id: 'j', baseUrl: 'http://x/', promptId: null, state: 'failed', outputs: [], error: 'ClipVisionLoader missing', generationReady: false } } } });
  await screen.findByRole('combobox', { name: 'Model' });
  expect(screen.getByText('ClipVisionLoader missing')).toBeTruthy();
  expect(document.querySelector('[data-wizard-run-state="failed"] img')).toBeNull();
  expect((screen.getByRole('button', { name: 'Prepare and run' }) as HTMLButtonElement).disabled).toBe(true); // no picture yet
});

it('uses an object picture A inside picture B: reference edit and masked edit on the same Qwen model, text only elsewhere', async () => {
  picks = ['/pics/street.png', '/pics/dog.png'];
  const { onPrepare } = ui();
  await choosePicture(1920, 1080);
  // After the picture to change, the object slot is highlighted for the next paste.
  expect(document.querySelector('[data-wizard-picture="object"]')!.classList.contains('is-active')).toBe(true);
  await choosePicture(800, 800, 'object to put in', 'dog.png');
  type('Replace what', 'the red car');
  expect(screen.getByText(/becomes image 1 and the object picture image 2/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' })); // "With what" is optional with an object picture
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'reference', source: 'reference', references: [{ name: 'dog.png', path: '/pics/dog.png' }],
    positive: 'Replace the red car in image 1 with the main object from image 2. Keep everything else in image 1 unchanged and match its lighting and perspective.' });
  expect(onPrepare.mock.calls[0][0].picture.path).toBe('/pics/street.png');
  fireEvent.click(screen.getByRole('button', { name: 'Paint a mask (inpaint)' }));
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path);
  // Owner decision: with an object picture the masked method hands over the reference edit on the same Qwen model, and says so.
  expect(screen.getByText(/hands over the reference edit on the same model/)).toBeTruthy();
  expect(screen.getByText(/becomes image 1 and the object picture image 2/)).toBeTruthy();
  expect(screen.queryByText(/This picture is 1920×1080\. Inpaint/)).toBeNull(); // no Inpaint grid: nothing is inpainted
  expect((screen.getByRole('button', { name: 'Prepare and run' }) as HTMLButtonElement).title).toBe(''); // no mask needed
  type('With what', 'the dog');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  const masked = onPrepare.mock.calls[1][0];
  expect(masked).toMatchObject({ strategy: 'reference', source: 'reference', pipeline: 't2i', model: { path: qwen.path }, references: [{ path: '/pics/dog.png' }] });
  expect(masked.edit).toBeUndefined(); expect(masked.maskGrow).toBeUndefined();
  expect(masked.positive).toBe('Replace the red car in image 1 with the dog from image 2. Keep everything else in image 1 unchanged and match its lighting and perspective.');
  expect(masked.size.width % 32).toBe(0);
  // A model without a reference encoder uses only the text and says so.
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: sdxl.path } });
  expect(screen.getByText(/This model uses only the text/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(screen.queryByText(/hands over the reference edit/)).toBeNull(); // SDXL cannot do the reference edit: text-only masked edit
  expect(onPrepare.mock.calls[2][0]).toMatchObject({ strategy: 'inpaint', positive: 'the dog', model: { path: sdxl.path }, maskGrow: 32, maskBlur: 4, denoise: 1 });
  expect(onPrepare.mock.calls[2][0].references).toBeUndefined();
  fireEvent.click(document.querySelector('[data-wizard-remove="object"]')!);
  expect(screen.queryByRole('img', { name: 'dog.png' })).toBeNull(); expect(screen.queryByText(/This model uses only the text/)).toBeNull();
});

it('crops an off-grid picture for a masked method onto the model grid as a new Input file and uses that copy', async () => {
  models = [sdxl];
  const drawn: unknown[][] = [];
  const restore = [vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...a: unknown[]) => drawn.push(a) }) as never),
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback) { done({ arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer } as Blob); /* jsdom Blob has no arrayBuffer */ })];
  const bitmap = { close: vi.fn() };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'native_media_save_derived' ? '/in/street-grid-960x576.png' : base(command, args));
  try {
    const { onPrepare } = ui();
    await choosePicture(1000, 600);
    expect(screen.getByText(/This picture is 1000×600\. Inpaint with this model needs both sides on a multiple of 64 px/)).toBeTruthy();
    expect(screen.getByText(/Saves a centred 960×576 crop as a new picture in the Input folder/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Crop to 960×576' }));
    const img = await screen.findByRole('img', { name: 'street-grid-960x576.png' });
    // Centred: 40 px and 24 px trimmed, split evenly between both edges; nothing is scaled.
    expect(drawn).toEqual([[bitmap, 20, 12, 960, 576, 0, 0, 960, 576]]);
    expect(bitmap.close).toHaveBeenCalled();
    const saved = calls('native_media_save_derived');
    expect(saved).toHaveLength(1); expect(saved[0].name).toBe('street-grid-960x576'); expect(saved[0].bytes).toEqual([0x89, 0x50, 0x4e, 0x47]);
    Object.defineProperties(img, { naturalWidth: { value: 960 }, naturalHeight: { value: 576 } });
    fireEvent.load(img);
    await waitFor(() => expect(document.querySelector('[data-wizard-off-grid]')).toBeNull());
    type('With what', 'a cat');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
    expect(onPrepare.mock.calls[0][0].picture).toMatchObject({ name: 'street-grid-960x576.png', path: '/in/street-grid-960x576.png' });
  } finally { restore.forEach(r => r.mockRestore()); vi.unstubAllGlobals(); }
});

it('says when an off-grid picture is too small to crop onto the grid', async () => {
  models = [sdxl];
  ui();
  await choosePicture(60, 900);
  expect(screen.getByText(/too small to crop onto the grid/)).toBeTruthy();
  expect(document.querySelector('[data-wizard-grid-copy]')).toBeNull();
});

it('says that several targets share the one replacement instead of splitting them', async () => {
  models = [sdxl];
  ui();
  await choosePicture(1024, 576);
  type('Replace what', 'the red car');
  type('With what', 'a blue bicycle');
  expect(document.querySelector('[data-wizard-multi-target]')).toBeNull();
  type('Replace what', 'the red car, the shop sign');
  expect(screen.getByText('All 2 targets (the red car, the shop sign) become a blue bicycle. To give each its own replacement, run the wizard once per target.')).toBeTruthy();
  type('With what', '');
  expect(document.querySelector('[data-wizard-multi-target]')).toBeNull(); // nothing to name yet
});

it('hands the masked method its measured CFG on the full Qwen 2.1 model only', async () => {
  models = [qwenFull, qwen, sdxl];
  const { onPrepare } = ui();
  await choosePicture(1024, 576);
  fireEvent.click(screen.getByRole('button', { name: 'Paint a mask (inpaint)' }));
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwenFull.path);
  type('With what', 'a red apple');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'inpaint', model: { path: qwenFull.path }, cfg: 4, denoise: 1, maskGrow: 32 });
  for (const other of [qwen, sdxl]) {
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: other.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
    expect(onPrepare.mock.calls.at(-1)![0].cfg).toBeUndefined();
  }
  // The reference edit on the same model keeps the family value.
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: qwenFull.path } });
  fireEvent.click(screen.getByRole('button', { name: 'Reference edit (Qwen Image 2.1)' }));
  type('Replace what', 'the phone');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls.at(-1)![0]).toMatchObject({ strategy: 'reference' });
  expect(onPrepare.mock.calls.at(-1)![0].cfg).toBeUndefined();
});

const ltx = { category: 'diffusion_models', name: 'ltx23.safetensors', path: '/m/diffusion_models/ltx23.safetensors', size: 1, info: null, family: 'ltx-2' };
const h3 = { category: 'diffusion_models', name: 'h3.safetensors', path: '/m/diffusion_models/h3.safetensors', size: 1, info: null, family: 'minimax-h3' };
async function chooseClip() {
  picks = ['/clips/street.mp4'];
  fireEvent.click(await screen.findByRole('button', { name: 'Choose… picture to change' }));
  const img = await screen.findByRole('img', { name: 'clip-first.png' });
  Object.defineProperties(img, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
  fireEvent.load(img);
  await screen.findByText('clip-first.png · 1280×720');
}

it('a video as the picture to change edits its first frame, then hands the edited frame to the chosen video method', async () => {
  models = [qwenFull, ltx, h3];
  const onPrepare = vi.fn();
  const props = { active: true, roots: { models: '/m', input: '/in' }, onPrepare };
  const view = render(<I18nProvider><DarkWizards {...props}/></I18nProvider>);
  await chooseClip();
  // The first frame comes from Media Analysis' exact frame path and is copied into Input.
  expect(calls('native_analysis_frames_open')).toEqual([{ path: '/clips/street.mp4' }]);
  expect(calls('native_analysis_frame')).toEqual([{ path: '/clips/street.mp4', index: 0, count: 192 }]);
  expect(calls('native_media_copy_in')).toEqual([{ path: '/runtime/frames/0.png' }]);
  expect(screen.getByText(/Video street\.mp4 · 1280×720 · 8\.0 s/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Edit video (LTX 2.3)', pressed: true })).toBeTruthy();
  expect(screen.getByText(/In strongly moving shots the old object comes back/)).toBeTruthy();
  expect(screen.getByText('Uses the first 5 s of the 8.0 s clip.')).toBeTruthy();
  expect(screen.getByText('Strongly moving shots are not reliable yet with either method.')).toBeTruthy();
  type('Replace what', 'the phone');
  type('With what', 'a red apple');
  fireEvent.click(screen.getByRole('button', { name: 'Run both steps' }));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'reference', source: 'reference', run: true, picture: { path: '/in/clip-first.png' } });
  // Generate reports the frame run (hand-over 1); its picture becomes the edited frame and the video step follows.
  const frameRun = { state: 'succeeded' as const, picture: { path: '/out/raw/edit.png', width: 1568, height: 896, seed: 3, checkpoint: 'q' } };
  view.rerender(<I18nProvider><DarkWizards {...props} handoff={1} outcome={{ n: 1, run: { state: 'running' as const } }}/></I18nProvider>);
  expect(screen.getByText('The video step starts when the edited first frame is done.')).toBeTruthy();
  view.rerender(<I18nProvider><DarkWizards {...props} handoff={1} outcome={{ n: 1, run: frameRun }}/></I18nProvider>);
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2));
  const video = onPrepare.mock.calls[1][0];
  expect(video).toMatchObject({ wizard: 'replace', strategy: 'edit', pipeline: 'v2v', source: 'video', model: { path: ltx.path }, run: true, seconds: 5, sourceStrength: 0.2,
    picture: { name: 'edit.png', path: '/out/raw/edit.png' }, sourceVideo: { name: 'street.mp4', path: '/clips/street.mp4' },
    positive: 'The same shot as the source video, with a red apple instead of the phone. Keep the camera, the motion and everything else unchanged.' });
  expect(video.size.width % 32).toBe(0); expect(video.size.height % 32).toBe(0);
  expect(Math.abs(video.size.width / video.size.height - 16 / 9)).toBeLessThan(0.05);
  expect(screen.getByText('Edited first frame ready: edit.png')).toBeTruthy();
  // The other method reuses the edited frame without editing it again.
  view.rerender(<I18nProvider><DarkWizards {...props} handoff={2} outcome={{ n: 2, run: { state: 'succeeded' as const, picture: { path: '/out/video/a.mp4', width: 1280, height: 704, seed: 3, checkpoint: 'ltx23', video: true } } }}/></I18nProvider>);
  expect(screen.getByText('Done — the video shows here and in Generate’s queue.')).toBeTruthy();
  expect(document.querySelector('[data-wizard-result-video] video')?.getAttribute('src')).toBe('asset:///out/video/a.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Re-animate from the edited frame (MiniMax H3)' }));
  expect(screen.getByText(/the motion is new and does not follow the clip/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Run the video step' }));
  expect(onPrepare).toHaveBeenCalledTimes(3);
  const again = onPrepare.mock.calls[2][0];
  expect(again).toMatchObject({ strategy: 'reanimate', pipeline: 'i2v', source: 'video', model: { path: h3.path }, picture: { path: '/out/raw/edit.png' }, seconds: 5 });
  expect(again.sourceVideo).toBeUndefined(); expect(again.sourceStrength).toBeUndefined();
  // Removing the picture to change drops the clip and its edited frame.
  fireEvent.click(document.querySelector('[data-wizard-remove="target"]')!);
  expect(document.querySelector('[data-wizard-video]')).toBeNull();
});

it('a failed frame run does not start the video step, and a video cannot be the object picture', async () => {
  models = [qwenFull, ltx];
  const onPrepare = vi.fn();
  const props = { active: true, roots: { models: '/m', input: '/in' }, onPrepare };
  const view = render(<I18nProvider><DarkWizards {...props}/></I18nProvider>);
  await chooseClip();
  type('Replace what', 'the phone');
  type('With what', 'a red apple');
  fireEvent.click(screen.getByRole('button', { name: 'Run both steps' }));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  view.rerender(<I18nProvider><DarkWizards {...props} handoff={1} outcome={{ n: 1, run: { state: 'failed' as const, error: 'boom' } }}/></I18nProvider>);
  expect(onPrepare).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Run the video step' })).toBeNull();
  picks = ['/clips/other.mp4'];
  fireEvent.click(screen.getByRole('button', { name: 'Choose… object to put in' }));
  await screen.findByText('A video goes into “Picture to change”; the object to put in must be a picture.');
});

it('without a model for any video method the video step says so and stays closed', async () => {
  models = [qwenFull];
  ui();
  await chooseClip();
  expect(screen.getAllByText('No installed model for this video method.').length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: 'Run both steps' }) as HTMLButtonElement).disabled).toBe(true);
});

it('lists Movie Maker next to Replace and swaps the form without touching Replace state', async () => {
  vi.mocked(invoke).mockImplementation(async (command) => command === 'native_models_scan' ? models : command === 'native_movie_list' ? { movies: [], damaged: 0 } : null);
  render(<I18nProvider><DarkWizards active roots={{ models: '/m' }} onPrepare={() => {}}/></I18nProvider>);
  expect(document.querySelector('[data-wizard-form="replace"]')).toBeTruthy();
  fireEvent.click(document.querySelector('[data-wizard="movie"]')!);
  expect(document.querySelector('[data-wizard-form="movie"]')).toBeTruthy();
  expect(document.querySelector('[data-wizard-form="replace"]')).toBeNull();
  // Unsaved movie work survives switching to another wizard and back (the form stays mounted, hidden).
  fireEvent.change(document.querySelector('[data-movie-title]')!, { target: { value: 'My film' } });
  fireEvent.click(document.querySelector('[data-wizard="replace"]')!);
  expect(document.querySelector('[data-wizard-form="replace"]')).toBeTruthy();
  expect((document.querySelector('[data-movie-host]') as HTMLElement).hidden).toBe(true);
  fireEvent.click(document.querySelector('[data-wizard="movie"]')!);
  expect((document.querySelector('[data-movie-title]') as HTMLInputElement).value).toBe('My film');
});
