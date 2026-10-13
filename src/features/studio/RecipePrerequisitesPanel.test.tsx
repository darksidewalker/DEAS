import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites, type RecipePrerequisites } from '../../lib/recipePrerequisites';
import App from '../../App';
import { RecipePrerequisitesPanel } from './RecipePrerequisitesPanel';
vi.mock('../../lib/recipePrerequisites', () => ({ checkRecipePrerequisites: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
function view(endpoint = 'http://127.0.0.1:7801') {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  return <I18nProvider><RecipePrerequisitesPanel endpoint={endpoint} /></I18nProvider>;
}
const fixture: RecipePrerequisites = {
  baseUrl: 'http://127.0.0.1:7801/', recipeId: 'checkpoint-text-to-image-diagnostic', version: 1, generationReady: false,
  allowlist: { nodes: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'], checkpoints: ['observed.safetensors'], samplers: ['unsupported', 'dpmpp_2m'], schedulers: ['unsupported', 'karras'] }, missingNodes: [],
};
test.each([
  [{ ...fixture, missingNodes: ['VAEDecode'], allowlist: { ...fixture.allowlist, nodes: fixture.allowlist.nodes.filter(n => n !== 'VAEDecode') } }, 'VAEDecode'],
  [{ ...fixture, allowlist: { ...fixture.allowlist, checkpoints: [] } }, 'No checkpoints observed. Compilation is blocked.'],
  [{ ...fixture, allowlist: { ...fixture.allowlist, samplers: ['unsupported'] } }, 'No supported sampler or scheduler observed. Compilation is blocked.'],
])('observed missing prerequisites block compilation: %s', async (result, blocker) => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(result);
  render(view()); fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  expect(await screen.findByText(blocker)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Compile diagnostic preview' }).hasAttribute('disabled')).toBe(true);
  expect(document.querySelector('[data-recipe-graph]')).toBeNull();
});
test('pure preview uses only observed selections and explicit DEAS defaults, invalidates on prompt edit', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(fixture);
  render(view()); fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  await screen.findByText(fixture.baseUrl);
  const checkpoint = screen.getByLabelText('Observed checkpoint') as HTMLSelectElement;
  expect(Array.from(checkpoint.options, o => o.value)).toEqual(['observed.safetensors']);
  expect(Array.from((screen.getByLabelText('Sampler') as HTMLSelectElement).options, o => o.value)).toEqual(['dpmpp_2m']);
  expect(Array.from((screen.getByLabelText('Scheduler') as HTMLSelectElement).options, o => o.value)).toEqual(['karras']);
  fireEvent.change(screen.getByLabelText('Positive prompt'), { target: { value: 'diagnostic landscape' } });
  fireEvent.change(screen.getByLabelText('Negative prompt'), { target: { value: 'blur' } });
  expect(document.querySelector('[data-recipe-graph]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Compile diagnostic preview' }));
  const result = JSON.parse(document.querySelector('[data-recipe-graph]')!.textContent!);
  expect(result.generationReady).toBe(false);
  expect(result.graph['1'].inputs.ckpt_name).toBe('observed.safetensors');
  expect(result.graph['2'].inputs.text).toBe('diagnostic landscape');
  expect(result.graph['3'].inputs.text).toBe('blur');
  expect(result.graph['4'].inputs).toEqual({ width: 512, height: 512, batch_size: 1 });
  expect(result.graph['5'].inputs).toMatchObject({ seed: 0, steps: 20, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras' });
  expect(document.querySelector('details')!.open).toBe(false);
  fireEvent.change(screen.getByLabelText('Positive prompt'), { target: { value: 'edited' } });
  expect(document.querySelector('[data-recipe-graph]')).toBeNull();
  expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
});
test('unsafe observed checkpoint identifiers are preserved and rejected by the real compiler', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValue({ ...fixture, allowlist: { ...fixture.allowlist, checkpoints: ['../unsafe.safetensors'] } });
  render(view()); fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  await screen.findByText(fixture.baseUrl);
  expect((screen.getByLabelText('Observed checkpoint') as HTMLSelectElement).value).toBe('../unsafe.safetensors');
  fireEvent.click(screen.getByRole('button', { name: 'Compile diagnostic preview' }));
  expect(screen.getByRole('alert').textContent).toContain('Unsafe model identifier');
  expect(document.querySelector('[data-recipe-graph]')).toBeNull();
});
test('endpoint edits clear evidence and preview and discard stale success without unlocking a newer probe', async () => {
  vi.mocked(checkRecipePrerequisites).mockResolvedValueOnce(fixture);
  const rendered = render(view()); fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  await screen.findByText(fixture.baseUrl);
  fireEvent.click(screen.getByRole('button', { name: 'Compile diagnostic preview' }));
  expect(document.querySelector('[data-recipe-graph]')).toBeTruthy();
  let oldResolve!: (value: RecipePrerequisites) => void;
  let newResolve!: (value: RecipePrerequisites) => void;
  vi.mocked(checkRecipePrerequisites).mockReturnValueOnce(new Promise(r => { oldResolve = r; })).mockReturnValueOnce(new Promise(r => { newResolve = r; }));
  fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  rendered.rerender(view('http://127.0.0.1:8189'));
  expect(document.querySelector('[data-recipe-graph]')).toBeNull();
  expect(screen.queryByText(fixture.baseUrl)).toBeNull();
  expect(checkRecipePrerequisites).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  await act(async () => oldResolve(fixture));
  expect(screen.queryByText(fixture.baseUrl)).toBeNull();
  expect(screen.getByRole('button', { name: 'Checking recipe prerequisites…' }).hasAttribute('disabled')).toBe(true);
  await act(async () => newResolve({ ...fixture, baseUrl: 'http://127.0.0.1:8189/' }));
  expect(screen.getByText('http://127.0.0.1:8189/')).toBeTruthy();
  rendered.rerender(view('http://127.0.0.1:8190'));
  expect(screen.queryByText('http://127.0.0.1:8189/')).toBeNull();
  expect(screen.queryByLabelText('Observed checkpoint')).toBeNull();
});
test('stale errors are discarded and unmount cannot publish pending evidence', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(checkRecipePrerequisites).mockReturnValueOnce(new Promise((_resolve, r) => { reject = r; }));
  const rendered = render(view()); fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  rendered.rerender(view('http://127.0.0.1:8189'));
  await act(async () => reject(new Error('stale failure')));
  expect(screen.queryByRole('alert')).toBeNull();
  let resolve!: (value: RecipePrerequisites) => void;
  vi.mocked(checkRecipePrerequisites).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  rendered.unmount(); await act(async () => resolve(fixture));
  expect(document.querySelector('[data-recipe-prerequisites]')).toBeNull();
  render(view()); expect(screen.queryByText(fixture.baseUrl)).toBeNull();
  expect(checkRecipePrerequisites).toHaveBeenCalledTimes(2);
});
test('Engine mounts the localized diagnostic panel without probing; endpoint edit clears its preview', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(fixture);
  render(<I18nProvider><App /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Explore studio without installing' }));
  fireEvent.click(screen.getByRole('button', { name: 'Engine' }));
  expect(document.querySelector('[data-recipe-prerequisites]')).toBeTruthy();
  expect(checkRecipePrerequisites).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check recipe prerequisites' }));
  await screen.findByText(fixture.baseUrl);
  fireEvent.click(screen.getByRole('button', { name: 'Compile diagnostic preview' }));
  expect(document.querySelector('[data-recipe-graph]')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Backend URL'), { target: { value: 'http://127.0.0.1:8189' } });
  expect(document.querySelector('[data-recipe-graph]')).toBeNull();
  expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
});
test('explicit read-only IPC fixture probe: no mount call or duplicate request, no submission', async () => {
  let resolve!: (value: RecipePrerequisites) => void;
  vi.mocked(checkRecipePrerequisites).mockReturnValue(new Promise(r => { resolve = r; }));
  render(view());
  expect(checkRecipePrerequisites).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'Check recipe prerequisites' });
  fireEvent.click(button); fireEvent.click(button);
  expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
  expect(checkRecipePrerequisites).toHaveBeenCalledWith('http://127.0.0.1:7801');
  await act(async () => resolve(fixture));
  expect(screen.getByText(fixture.baseUrl)).toBeTruthy();
  expect(screen.getByText(/Not Director or model-architecture support/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /run|generate|start|submit/i })).toBeNull();
});
