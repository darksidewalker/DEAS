import { afterEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { stopWorkbench, runWorkbenchJob, readCurrentWorkbench, pollWorkbench, prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, readCurrentDiagnosticJob, loadDiagnosticJobOutput, exportDiagnosticJobOutput } from './jobs';
import { compileRecipe, type DiagnosticImageIntentV1 } from './execution';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
const intent: DiagnosticImageIntentV1 = {
  recipeId: 'checkpoint-text-to-image-diagnostic', version: 1, positivePrompt: 'test', negativePrompt: '',
  checkpoint: 'observed.safetensors', seed: 0, width: 512, height: 512, steps: 20, cfg: 7,
  sampler: 'euler', scheduler: 'normal', outputPrefix: 'DEAS_diagnostic',
};
// Qwen Image 2.1 Turbo: the checkpoint's saved 8-step schedule (official ComfyUI template) replaces KSampler — same graph as jobs.rs.
test('fixed sigmas compile to ManualSigmas → SamplerCustomAdvanced in place of KSampler', () => {
  const nodes = ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage', 'VAEEncode', 'RandomNoise', 'CFGGuider', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced'];
  const allow = { nodes, checkpoints: [intent.checkpoint], images: ['in.png'], samplers: ['euler'], schedulers: ['normal'] };
  const sigmas = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0];
  const g = compileRecipe({ ...intent, steps: 8, sigmas }, allow).graph;
  expect(g.Z.inputs.sigmas).toBe('1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0');
  expect(g['5']).toEqual({ class_type: 'SamplerCustomAdvanced', inputs: { noise: ['N', 0], guider: ['G', 0], sampler: ['Q', 0], sigmas: ['Z', 0], latent_image: ['4', 0] } });
  expect(g.G.inputs).toEqual({ model: ['1', 0], positive: ['2', 0], negative: ['3', 0], cfg: 7 });
  expect(g.Q.inputs).toEqual({ sampler_name: 'euler' });
  const i2i = compileRecipe({ ...intent, steps: 4, sigmas: sigmas.slice(-5), inputImage: 'in.png', denoise: 0.5 }, allow).graph;
  expect(i2i['5'].inputs).toEqual({ noise: ['N', 0], guider: ['G', 0], sampler: ['Q', 0], sigmas: ['Z', 0], latent_image: ['9', 0] });
  expect(() => compileRecipe({ ...intent, steps: 8, sigmas }, { ...allow, nodes: nodes.filter(n => n !== 'ManualSigmas') })).toThrow(/ManualSigmas/);
  for (const bad of [[1, 0.5], [1, 0.5, 0.5, 0.2, 0], [1, 0.8, 0.6, 0.4, 0.2], [1, 0.8, 0.6, '0.4', 0], '1, 0']) {
    expect(() => compileRecipe({ ...intent, steps: 4, sigmas: bad }, allow)).toThrow(/sigmas/);
  }
});
test('native-only commands preserve exact intent, explicit consent and job identity', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const response = { id: 'native-id' };
  vi.mocked(invoke).mockResolvedValue(response);
  expect(await prepareDiagnosticJob('http://127.0.0.1:7801/prefix/', intent)).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_prepare', { baseUrl: 'http://127.0.0.1:7801/prefix/', intent });
  expect(await submitDiagnosticJob('plan-id')).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_submit', { planId: 'plan-id', confirmed: true });
  expect(await readDiagnosticJobStatus('job-id')).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_status', { jobId: 'job-id' });
  expect(await readCurrentDiagnosticJob()).toBe(response);
  expect(invoke).toHaveBeenLastCalledWith('native_job_current', {});
  vi.mocked(invoke).mockResolvedValue(null);
  expect(await readCurrentDiagnosticJob()).toBeNull();
});
test('Studio uses independent native collection commands with consent and no diagnostic calls', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const snapshot = {jobs: [], preparing: 2, capacity: 20, stopAvailable: true, admissionEpoch:0, stopping:false};
  vi.mocked(invoke).mockResolvedValue(snapshot);
  expect(await readCurrentWorkbench()).toEqual({...snapshot,frontendAdmitting:false});
  expect(invoke).toHaveBeenLastCalledWith('native_workbench_current', {});
  expect(await pollWorkbench()).toEqual({...snapshot,frontendAdmitting:false});
  expect(invoke).toHaveBeenLastCalledWith('native_workbench_poll', {});
  await runWorkbenchJob('http://localhost:7801/prefix/', intent, 0);
  expect(invoke).toHaveBeenLastCalledWith('native_workbench_run', {baseUrl:'http://localhost:7801/prefix/', intent, confirmed:true, admissionEpoch:0});
  expect(invoke).toHaveBeenCalledTimes(3);
});
test.each([readCurrentWorkbench, pollWorkbench])('collection reads bracket pending Run IPC without changing native counts (%s)', async read => {
  vi.mocked(isTauri).mockReturnValue(true);
  const snapshot = {jobs: [], preparing: 0, capacity: 20, stopAvailable: true, admissionEpoch:0, stopping:false};
  let finish!: (value: never) => void;
  let finishRead!: (value: typeof snapshot) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'native_workbench_run'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(snapshot));
  const run = runWorkbenchJob('http://original/', intent, 0);
  expect(await read()).toEqual({...snapshot,frontendAdmitting:true});
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
  const staleRead = read();
  finish({id:'admitted'} as never); await run;
  finishRead(snapshot);
  expect(await staleRead).toEqual({...snapshot,frontendAdmitting:true});
  vi.mocked(invoke).mockResolvedValue(snapshot);
  expect(await read()).toEqual({...snapshot,frontendAdmitting:false});

  vi.mocked(invoke).mockImplementation(command => command === 'native_workbench_run'
    ? new Promise(resolve => { finish = resolve; }) : new Promise(resolve => { finishRead = resolve; }));
  const earlierRead = read();
  const laterRun = runWorkbenchJob('http://original/', intent, 0);
  finishRead(snapshot);
  expect(await earlierRead).toEqual({...snapshot,frontendAdmitting:true});
  finish({id:'later'} as never); await laterRun;
});
test('Run registers before invoke and clears only settled calls, including a lost reply', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const snapshot = {jobs: [], preparing: 0, capacity: 20, stopAvailable: true, admissionEpoch:0, stopping:false};
  let nestedRead!: ReturnType<typeof readCurrentWorkbench>;
  let finishNested!: (value: typeof snapshot) => void;
  const pending: {resolve:(value:never)=>void;reject:(reason:unknown)=>void}[] = [];
  vi.mocked(invoke).mockImplementation(command => {
    if(command !== 'native_workbench_run') return new Promise(resolve => { finishNested = resolve; });
    nestedRead = readCurrentWorkbench();
    return new Promise((resolve,reject) => { pending.push({resolve,reject}); });
  });
  const immediate = runWorkbenchJob('http://original/', intent, 0);
  pending[0].resolve({id:'immediate'} as never); await immediate;
  finishNested(snapshot);
  expect((await nestedRead).frontendAdmitting).toBe(true);
  vi.mocked(invoke).mockImplementation(command => command === 'native_workbench_run'
    ? new Promise((resolve,reject) => { pending.push({resolve,reject}); }) : Promise.resolve(snapshot));
  const first = runWorkbenchJob('http://original/', intent, 0);
  const second = runWorkbenchJob('http://original/', intent, 0);
  const rejected = expect(second).rejects.toThrow('IPC response lost');
  pending[2].reject(new Error('IPC response lost')); await rejected;
  expect((await readCurrentWorkbench()).frontendAdmitting).toBe(true);
  pending[1].resolve({id:'first'} as never); await first;
  expect(await readCurrentWorkbench()).toEqual({...snapshot,frontendAdmitting:false});
  await expect(runWorkbenchJob(' ', intent, 0)).rejects.toThrow('explicit backend endpoint');
  expect((await readCurrentWorkbench()).frontendAdmitting).toBe(false);
});
test('browser fails closed for all job commands without IPC or browser fetch', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const request of [runWorkbenchJob('http://127.0.0.1:7801', intent, 0), readCurrentWorkbench(), pollWorkbench(), stopWorkbench(), prepareDiagnosticJob('http://127.0.0.1:7801', intent), submitDiagnosticJob('plan'), readDiagnosticJobStatus('job'), readCurrentDiagnosticJob(), loadDiagnosticJobOutput('job', 0), exportDiagnosticJobOutput('job', 0, 'Save')]) {
    await expect(request).rejects.toThrow('desktop app');
  }
  expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
test('output transfer and Save As are explicit native commands', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const output = { jobId: 'job', index: 0, mimeType: 'image/png', width: 512, height: 512, sha256: 'a'.repeat(64), bytes: [137, 80, 78, 71] };
  vi.mocked(invoke).mockResolvedValue(output);
  expect(await loadDiagnosticJobOutput('job', 0)).toEqual(output);
  expect(invoke).toHaveBeenLastCalledWith('native_job_output', { jobId: 'job', index: 0 });
  vi.mocked(invoke).mockResolvedValue(null);
  expect(await exportDiagnosticJobOutput('job', 0, 'Save PNG')).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('native_job_export', { jobId: 'job', index: 0, title: 'Save PNG' });
});
test.each([{ mimeType: 'image/jpeg' }, { jobId: 'foreign' }, { index: 1 }, { bytes: [] }, { bytes: [256] }, { bytes: [-1] }, { bytes: [0.5] }, { width: 8193 }, { width: 8192, height: 8192 }, { height: 0 }, { sha256: 'A'.repeat(64) }])('rejects malformed output before Blob allocation: %s', async invalid => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue({ jobId: 'job', index: 0, mimeType: 'image/png', width: 512, height: 512, sha256: 'a'.repeat(64), bytes: [137], ...invalid });
  await expect(loadDiagnosticJobOutput('job', 0)).rejects.toThrow('Invalid native PNG output');
});
test('rejects oversized and sparse byte arrays before allocating a typed buffer', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  for (const bytes of [new Array(144 * 1024 * 1024 + 1), new Array(1)]) {
    vi.mocked(invoke).mockResolvedValue({ jobId: 'job', index: 0, mimeType: 'image/png', width: 1, height: 1, sha256: 'a'.repeat(64), bytes });
    await expect(loadDiagnosticJobOutput('job', 0)).rejects.toThrow('Invalid native PNG output');
  }
});
test('4K PNG metadata passes the same dimension and pixel bounds as native output',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 const output={jobId:'job',index:0,mimeType:'image/png',width:3840,height:2160,sha256:'a'.repeat(64),bytes:[137,80,78,71]};
 vi.mocked(invoke).mockResolvedValue(output);
 expect(await loadDiagnosticJobOutput('job',0)).toEqual(output);
});
test('empty endpoints are rejected before IPC, native errors retain code and message', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  await expect(runWorkbenchJob('  ', intent, 0)).rejects.toThrow('explicit backend endpoint');
  await expect(prepareDiagnosticJob('  ', intent)).rejects.toThrow('explicit backend endpoint');
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockRejectedValue({ code: 'MODEL_ERROR', message: 'Checkpoint failed to load' });
  await expect(submitDiagnosticJob('plan')).rejects.toThrow('MODEL_ERROR: Checkpoint failed to load');
});
test('Stop coalesces confirmed native calls and closes cross-mount admission until settled', async () => {
 vi.mocked(isTauri).mockReturnValue(true);
 let finish!: (value: never)=>void;
 const snapshot={jobs:[],preparing:0,capacity:20,stopAvailable:true,admissionEpoch:1,stopping:false};
 vi.mocked(invoke).mockImplementation(command=>command==='native_workbench_stop'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(snapshot));
 const first=stopWorkbench();const second=stopWorkbench();
 expect(invoke).toHaveBeenCalledTimes(1);
 expect(invoke).toHaveBeenCalledWith('native_workbench_stop',{confirmed:true});
 expect((await readCurrentWorkbench()).stopping).toBe(true);
 finish({...snapshot,outcome:'empty',discarded:0,issues:[]} as never);
 expect(await first).toEqual(await second);
 expect((await readCurrentWorkbench()).stopping).toBe(false);
});

test('a completed Stop fence releases obsolete pending Run ownership without clearing newer calls',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 let finish!:(job:never)=>void;
 const snapshot={jobs:[],preparing:0,capacity:20,stopAvailable:true,admissionEpoch:4,stopping:false};
 vi.mocked(invoke).mockImplementation(command=>command==='native_workbench_run'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({...snapshot,outcome:'settled',discarded:1,issues:[]}));
 const old=runWorkbenchJob('http://original/',intent,3);
 await stopWorkbench();
 expect((await readCurrentWorkbench()).frontendAdmitting).toBe(false);
 const finishOld=finish;const newer=runWorkbenchJob('http://original/',intent,4);
 finishOld({id:'obsolete'} as never);await old;
 expect((await readCurrentWorkbench()).frontendAdmitting).toBe(true);
 finish({id:'new'} as never);await newer;
 expect((await readCurrentWorkbench()).frontendAdmitting).toBe(false);
});

test('a failed Stop can be explicitly retried; a pending Stop refuses Run without IPC',async()=>{
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC unreachable'));
 await expect(stopWorkbench()).rejects.toThrow('IPC unreachable');
 let finish!:(value:never)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const stop=stopWorkbench();await expect(runWorkbenchJob('http://original/',intent,0)).rejects.toThrow('Stop is in progress');
 expect(invoke).toHaveBeenCalledTimes(2);
 finish({jobs:[],preparing:0,capacity:20,stopAvailable:true,admissionEpoch:1,stopping:false,outcome:'empty',discarded:0,issues:[]} as never);await stop;
});
