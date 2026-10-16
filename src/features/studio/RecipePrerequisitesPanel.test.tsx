import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, readCurrentDiagnosticJob, loadDiagnosticJobOutput, exportDiagnosticJobOutput, type DiagnosticJobPlan, type JobStatus } from '../../lib/jobs';
import { compileRecipe } from '../../lib/execution';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock('../../lib/jobs', () => ({ prepareDiagnosticJob: vi.fn(), submitDiagnosticJob: vi.fn(), readDiagnosticJobStatus: vi.fn(), readCurrentDiagnosticJob: vi.fn(), loadDiagnosticJobOutput: vi.fn(), exportDiagnosticJobOutput: vi.fn() }));
beforeEach(() => vi.mocked(isTauri).mockReturnValue(false));
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
  fireEvent.click(screen.getByRole('tab',{name:'Studio'}));
  fireEvent.click(screen.getByRole('tab', { name: 'Workspace map' }));
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


const status: JobStatus = { id: 'job-native', baseUrl: fixture.baseUrl, promptId: 'prompt-native', state: 'queued', outputs: [], error: null, generationReady: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
async function compileView() {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(fixture);
  vi.mocked(prepareDiagnosticJob).mockImplementation(async (baseUrl, intent) => ({ id: 'plan-native', baseUrl, intent, graph: compileRecipe(intent, fixture.allowlist).graph, generationReady: false }));
  const rendered = render(view());
  expect(prepareDiagnosticJob).not.toHaveBeenCalled();
  click('Check recipe prerequisites'); await screen.findByText(fixture.baseUrl);
  click('Compile diagnostic preview');
  expect(submitDiagnosticJob).not.toHaveBeenCalled();
  return rendered;
}
async function prepareView() {
  const rendered = await compileView();
  click('Prepare diagnostic run');
  await screen.findByLabelText('I authorize this exact diagnostic plan and its resource use.');
  return rendered;
}
function authorize() { fireEvent.click(screen.getByRole('checkbox')); }
afterEach(() => vi.useRealTimers());

test('native preparation uses the frozen compiled intent; exact returned plan and unchecked separate consent precede explicit-only submission', async () => {
  await compileView();
  const preparation = deferred<DiagnosticJobPlan>();
  vi.mocked(prepareDiagnosticJob).mockReturnValue(preparation.promise);
  click('Prepare diagnostic run'); click('Prepare diagnostic run');
  expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('Positive prompt') as HTMLTextAreaElement).disabled).toBe(true);
  const [baseUrl, intent] = vi.mocked(prepareDiagnosticJob).mock.calls[0];
  expect(baseUrl).toBe('http://127.0.0.1:7801');
  expect(Object.isFrozen(intent)).toBe(true);
  expect(intent).toEqual({ recipeId: fixture.recipeId, version: 1, positivePrompt: '', negativePrompt: '', checkpoint: 'observed.safetensors', sampler: 'dpmpp_2m', scheduler: 'karras', width: 512, height: 512, steps: 20, cfg: 7, seed: 0, outputPrefix: 'DEAS_diagnostic' });
  const exact: DiagnosticJobPlan = { id: 'immutable-native-plan', baseUrl: fixture.baseUrl, intent, graph: { native: { class_type: 'NativeReturnedGraph', inputs: {} } }, generationReady: false };
  await act(async () => preparation.resolve(exact));
  expect(JSON.parse(document.querySelector('[data-job-plan]')!.textContent!)).toEqual(exact);
  expect(document.querySelector('[data-job-plan]')!.closest('details')!.open).toBe(false);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: 'Run diagnostic job' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/checkpoint architecture and model loading are unverified/)).toBeTruthy();
  authorize(); expect(submitDiagnosticJob).not.toHaveBeenCalled();
  const submission = deferred<JobStatus>(); vi.mocked(submitDiagnosticJob).mockReturnValue(submission.promise);
  click('Run diagnostic job'); click('Run diagnostic job');
  expect(submitDiagnosticJob).toHaveBeenCalledExactlyOnceWith('immutable-native-plan');
  expect((screen.getByLabelText('Positive prompt') as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => submission.resolve({ ...status, state: 'succeeded', outputs: [{ filename: 'real-output.png', subfolder: '', type: 'output' }] }));
  expect(document.querySelector('[data-job-state]')!.getAttribute('data-state')).toBe('succeeded');
  expect(screen.getByText('prompt-native')).toBeTruthy();
  expect(document.querySelector('[data-job-outputs]')!.textContent).toContain('real-output.png');
  expect(document.querySelector('[data-diagnostic-jobs] img, [data-diagnostic-jobs] a')).toBeNull();
  expect((screen.getByRole('button', { name: 'Run diagnostic job' }) as HTMLButtonElement).disabled).toBe(true);
});

test.each(['Positive prompt', 'Negative prompt', 'Observed checkpoint', 'Sampler', 'Scheduler'])('editing %s invalidates native plan and consent; recompile never reuses consent', async label => {
  await prepareView(); authorize();
  fireEvent.change(screen.getByLabelText(label), { target: { value: label.includes('prompt') ? 'changed' : 'other-choice' } });
  expect(document.querySelector('[data-job-plan]')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Run diagnostic job' })).toBeNull();
  expect(submitDiagnosticJob).not.toHaveBeenCalled();
  if (label.includes('prompt')) {
    click('Compile diagnostic preview'); click('Prepare diagnostic run');
    const checkbox = await screen.findByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  }
});

test('endpoint changes discard pending preparation, but keep its lock until settlement', async () => {
  const rendered = await compileView();
  const preparation = deferred<DiagnosticJobPlan>(); vi.mocked(prepareDiagnosticJob).mockReturnValue(preparation.promise);
  click('Prepare diagnostic run');
  const intent = vi.mocked(prepareDiagnosticJob).mock.calls[0][1];
  rendered.rerender(view('http://127.0.0.1:8199'));
  expect((screen.getByRole('button', { name: 'Check recipe prerequisites' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => preparation.resolve({ id: 'stale-plan', baseUrl: fixture.baseUrl, intent, graph: {}, generationReady: false }));
  expect(document.querySelector('[data-job-plan]')).toBeNull();
  expect((screen.getByRole('button', { name: 'Check recipe prerequisites' }) as HTMLButtonElement).disabled).toBe(false);
  expect(submitDiagnosticJob).not.toHaveBeenCalled();
});

test('pending submission and subsequent polling retain native identity across endpoint edits', async () => {
  const rendered = await prepareView();
  const submission = deferred<JobStatus>(); vi.mocked(submitDiagnosticJob).mockReturnValue(submission.promise);
  authorize(); click('Run diagnostic job');
  rendered.rerender(view('http://127.0.0.1:8199'));
  expect(document.querySelector('[data-job-plan]')).toBeNull();
  vi.useFakeTimers();
  await act(async () => submission.resolve(status));
  expect(screen.getByText(/Job job-native · original endpoint:/).textContent).toContain(fixture.baseUrl);
  expect(screen.getByText(/draft endpoint changed/)).toBeTruthy();
  const poll = deferred<JobStatus>(); vi.mocked(readDiagnosticJobStatus).mockReturnValue(poll.promise);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(readDiagnosticJobStatus).toHaveBeenCalledExactlyOnceWith('job-native');
  await act(async () => vi.advanceTimersByTime(5000));
  expect(readDiagnosticJobStatus).toHaveBeenCalledTimes(1);
  rendered.rerender(view('http://127.0.0.1:8200'));
  await act(async () => poll.resolve({ ...status, state: 'succeeded' }));
  expect(document.querySelector('[data-job-state]')!.getAttribute('data-state')).toBe('succeeded');
  await act(async () => vi.advanceTimersByTime(5000));
  expect(readDiagnosticJobStatus).toHaveBeenCalledTimes(1);
  expect(submitDiagnosticJob).toHaveBeenCalledTimes(1);
});

test.each(['failed', 'unknown'] as const)('%s stops polling, shows native error and offers status refresh without resubmission', async state => {
  await prepareView(); vi.useFakeTimers();
  vi.mocked(submitDiagnosticJob).mockResolvedValue({ ...status, state, error: 'native diagnostic detail' });
  authorize(); await act(async () => click('Run diagnostic job'));
  expect(document.querySelector('[data-job-state]')!.getAttribute('data-state')).toBe(state);
  expect(screen.getByText('native diagnostic detail')).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(5000));
  expect(readDiagnosticJobStatus).not.toHaveBeenCalled();
  vi.mocked(readDiagnosticJobStatus).mockResolvedValue({ ...status, state: 'succeeded' });
  await act(async () => click('Refresh status'));
  expect(readDiagnosticJobStatus).toHaveBeenCalledExactlyOnceWith('job-native');
  expect(submitDiagnosticJob).toHaveBeenCalledTimes(1);
});

test('poll transport failure preserves identity as unknown; refresh is serialized and recovers native state', async () => {
  await prepareView(); vi.useFakeTimers();
  vi.mocked(submitDiagnosticJob).mockResolvedValue(status);
  vi.mocked(readDiagnosticJobStatus).mockRejectedValueOnce(new Error('IPC disconnected'));
  authorize(); await act(async () => click('Run diagnostic job'));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(document.querySelector('[data-job-state]')!.getAttribute('data-state')).toBe('unknown');
  expect(screen.getByText(/IPC disconnected/)).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(5000));
  expect(readDiagnosticJobStatus).toHaveBeenCalledTimes(1);
  const refresh = deferred<JobStatus>(); vi.mocked(readDiagnosticJobStatus).mockReturnValue(refresh.promise);
  click('Refresh status'); click('Refresh status');
  expect(readDiagnosticJobStatus).toHaveBeenCalledTimes(2);
  await act(async () => refresh.resolve({ ...status, state: 'failed', error: 'Model load failed' }));
  expect(screen.getByText('Model load failed')).toBeTruthy();
  expect(screen.queryByText(/IPC disconnected/)).toBeNull();
});

test('ambiguous submit failure cannot retry or prepare another job', async () => {
  const rendered = await prepareView();
  vi.mocked(submitDiagnosticJob).mockRejectedValue(new Error('IPC lost after send'));
  authorize(); await act(async () => click('Run diagnostic job'));
  expect(screen.getByText(/Submission outcome is unknown/)).toBeTruthy();
  expect(screen.getByText(/IPC lost after send/)).toBeTruthy();
  click('Run diagnostic job'); click('Prepare diagnostic run');
  expect(submitDiagnosticJob).toHaveBeenCalledTimes(1);
  expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1);
  rendered.rerender(view('http://127.0.0.1:8200'));
  expect(screen.getByText(/Submission outcome is unknown/)).toBeTruthy();
});

test('browser compile-only preview cannot prepare or submit', async () => {
  await compileView(); vi.mocked(isTauri).mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('Positive prompt'), { target: { value: 'browser' } });
  click('Compile diagnostic preview');
  expect(screen.getByText(/Browser preview cannot prepare/)).toBeTruthy();
  click('Prepare diagnostic run');
  expect(prepareDiagnosticJob).not.toHaveBeenCalled(); expect(submitDiagnosticJob).not.toHaveBeenCalled();
});

test('prepare failure is visible, and pending job responses/timers cannot update after unmount', async () => {
  const rendered = await compileView();
  vi.mocked(prepareDiagnosticJob).mockRejectedValueOnce(new Error('Native prerequisite changed'));
  await act(async () => click('Prepare diagnostic run'));
  expect(screen.getByText(/Native prerequisite changed/)).toBeTruthy();
  click('Prepare diagnostic run'); await screen.findByRole('checkbox');
  vi.useFakeTimers(); vi.mocked(submitDiagnosticJob).mockResolvedValue(status);
  authorize(); await act(async () => click('Run diagnostic job'));
  const poll = deferred<JobStatus>(); vi.mocked(readDiagnosticJobStatus).mockReturnValue(poll.promise);
  await act(async () => vi.advanceTimersByTime(1000));
  rendered.unmount();
  await act(async () => poll.resolve({ ...status, state: 'running' }));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(readDiagnosticJobStatus).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-diagnostic-jobs]')).toBeNull();
});


test.each(['prepare', 'submit'] as const)('unmount during %s cannot publish a stale response into a new panel', async operation => {
  const rendered = await compileView();
  const preparation = deferred<DiagnosticJobPlan>();
  const submission = deferred<JobStatus>();
  if (operation === 'prepare') vi.mocked(prepareDiagnosticJob).mockReturnValue(preparation.promise);
  click('Prepare diagnostic run');
  const intent = vi.mocked(prepareDiagnosticJob).mock.calls[0][1];
  if (operation === 'submit') {
    await screen.findByRole('checkbox');
    vi.mocked(submitDiagnosticJob).mockReturnValue(submission.promise);
    authorize(); click('Run diagnostic job');
  }
  rendered.unmount();
  render(view('http://127.0.0.1:9999'));
  await act(async () => {
    if (operation === 'prepare') preparation.resolve({ id: 'stale-plan', baseUrl: fixture.baseUrl, intent, graph: {}, generationReady: false });
    else submission.resolve(status);
  });
  expect(document.querySelector('[data-job-plan]')).toBeNull();
  expect(document.querySelector('[data-job-state]')).toBeNull();
  expect(readCurrentDiagnosticJob).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Recover session job' }) as HTMLButtonElement).disabled).toBe(false);
});

test('succeeded recovery lists explicit PNG previews without downloading on render or endpoint edits', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(readCurrentDiagnosticJob).mockResolvedValue({ ...status, state: 'succeeded', outputs: [{ filename: 'actual.png', subfolder: '', type: 'output' }] });
  const rendered = render(view());
  await act(async () => click('Recover session job'));
  expect(document.querySelector('[data-job-output-load="0"]')).toBeTruthy();
  expect(loadDiagnosticJobOutput).not.toHaveBeenCalled();
  expect(exportDiagnosticJobOutput).not.toHaveBeenCalled();
  rendered.rerender(view('http://127.0.0.1:9999'));
  expect(document.querySelector('[data-job-output-load="0"]')).toBeTruthy();
  expect(loadDiagnosticJobOutput).not.toHaveBeenCalled();
});

test('session recovery is explicit and survives panel unmount/remount without probing or resubmitting', async () => {
  const rendered = await prepareView();
  vi.mocked(submitDiagnosticJob).mockResolvedValue(status);
  authorize(); await act(async () => click('Run diagnostic job'));
  rendered.unmount();
  vi.useFakeTimers();
  const remounted = render(view('http://127.0.0.1:9999'));
  expect(readCurrentDiagnosticJob).not.toHaveBeenCalled();
  expect(document.querySelector('[data-job-state]')).toBeNull();
  const current = deferred<JobStatus | null>(); vi.mocked(readCurrentDiagnosticJob).mockReturnValue(current.promise);
  click('Recover session job'); click('Recover session job');
  expect(readCurrentDiagnosticJob).toHaveBeenCalledTimes(1);
  await act(async () => current.resolve(status));
  expect(document.querySelector('[data-job-state]')!.getAttribute('data-state')).toBe('queued');
  expect(screen.getByText(/Job job-native · original endpoint:/).textContent).toContain(fixture.baseUrl);
  expect(screen.getByText(/draft endpoint changed/)).toBeTruthy();
  vi.mocked(readDiagnosticJobStatus).mockResolvedValue({ ...status, state: 'succeeded' });
  await act(async () => vi.advanceTimersByTime(1000));
  expect(readDiagnosticJobStatus).toHaveBeenCalledExactlyOnceWith('job-native');
  expect(submitDiagnosticJob).toHaveBeenCalledTimes(1);
  expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1);
  remounted.unmount();
});

test('recovering an ambiguous IPC submission restores native identity, not permission to retry', async () => {
  await prepareView();
  vi.mocked(submitDiagnosticJob).mockRejectedValue(new Error('IPC lost'));
  authorize(); await act(async () => click('Run diagnostic job'));
  vi.mocked(readCurrentDiagnosticJob).mockResolvedValue(null);
  await act(async () => click('Recover session job'));
  expect(screen.getByText('No native job is stored in this app session.')).toBeTruthy();
  expect(screen.getByText(/Submission outcome is unknown/)).toBeTruthy();
  vi.mocked(readCurrentDiagnosticJob).mockResolvedValue({ ...status, state: 'unknown' });
  await act(async () => click('Recover session job'));
  expect(screen.queryByText(/Submission outcome is unknown/)).toBeNull();
  expect(document.querySelector('[data-job-state]')!.getAttribute('data-state')).toBe('unknown');
  click('Run diagnostic job');
  expect(submitDiagnosticJob).toHaveBeenCalledTimes(1);
});

test('session recovery has visible empty/error results, is desktop-only and ignores unmounted responses', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const rendered = render(view());
  click('Recover session job'); expect(readCurrentDiagnosticJob).not.toHaveBeenCalled();
  vi.mocked(isTauri).mockReturnValue(true); rendered.rerender(view());
  vi.mocked(readCurrentDiagnosticJob).mockRejectedValueOnce(new Error('Native recovery unavailable'));
  await act(async () => click('Recover session job'));
  expect(screen.getByText(/Native recovery unavailable/)).toBeTruthy();
  vi.mocked(readCurrentDiagnosticJob).mockResolvedValueOnce(null);
  await act(async () => click('Recover session job'));
  expect(screen.getByText('No native job is stored in this app session.')).toBeTruthy();
  expect(screen.queryByText(/Native recovery unavailable/)).toBeNull();
  const current = deferred<JobStatus | null>(); vi.mocked(readCurrentDiagnosticJob).mockReturnValue(current.promise);
  click('Recover session job'); rendered.unmount();
  await act(async () => current.resolve(status));
  render(view());
  expect(document.querySelector('[data-job-state]')).toBeNull();
  expect(readCurrentDiagnosticJob).toHaveBeenCalledTimes(3);
});
