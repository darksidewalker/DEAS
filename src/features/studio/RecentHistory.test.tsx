import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { RecentHistory } from './RecentHistory';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { HistoryRecord, HistorySnapshot, RestoreContext } from './history';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn()}));
const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'historic forest 猫',negativePrompt:'blur',checkpoint:'exact.safetensors',seed:43,width:1216,height:832,steps:17,cfg:4.25,sampler:'euler',scheduler:'normal',outputPrefix:'raw/exact'} as const;
const row=(id:string):HistoryRecord=>({id,clientId:'client',promptId:'prompt',origin:id==='attempt-9'?'diagnostic':'studio',appVersion:'0.1.48',admittedAt:1700000000000,observedAt:1700000001000,revision:2,state:'unknown',intent,outputs:[{filename:'old.png',subfolder:'raw',type:'output'}],outputRoot:'/env/output',backendOrigin:'http://127.0.0.1:7801',error:null});
const context:RestoreContext={endpoint:'http://127.0.0.1:7801',inputRoot:'/env/input',models:[{name:'exact.safetensors',family:'sdxl'}],allow:{nodes:[],checkpoints:['exact.safetensors'],samplers:['euler'],schedulers:['normal']}};
const snapshot=(records=[row('attempt-1')]):HistorySnapshot=>({schemaVersion:1,records,readOnly:false,error:null});
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(invoke).mockResolvedValue(snapshot());});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();});
const mount=(extra:Partial<Parameters<typeof RecentHistory>[0]>={})=>{const onRestore=vi.fn();render(<I18nProvider><RecentHistory liveIds={[]} context={context} projectOpen={false} authoringBusy={false} onRestore={onRestore} {...extra}/></I18nProvider>);return onRestore;};
const historyView=(extra:Partial<Parameters<typeof RecentHistory>[0]>={})=><I18nProvider><RecentHistory liveIds={[]} context={context} projectOpen={false} authoringBusy={false} onRestore={()=>{}} {...extra}/></I18nProvider>;
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const open=async()=>{fireEvent.click(screen.getByRole('button',{name:'Recent generations'}));await waitFor(()=>expect(document.querySelectorAll('[data-history-id]').length).toBeGreaterThan(0));};
test('ten restart-visible rows select as metadata; load/select/restore never invoke execution, network, file checks or probes',async()=>{
 vi.mocked(invoke).mockResolvedValue(snapshot(Array.from({length:10},(_,n)=>row(`attempt-${n}`))));
 const apply=mount();fireEvent.click(screen.getByRole('button',{name:'Recent generations'}));
 await waitFor(()=>expect(document.querySelectorAll('[data-history-id]')).toHaveLength(10));
 fireEvent.click(document.querySelector('[data-history-id="attempt-9"]')!);
 expect(screen.getByText(/not a recovered live job/)).toBeTruthy();expect(screen.getByText(/Diagnostic · 0.1.48/)).toBeTruthy();
 expect(document.querySelector('[data-history-details] pre')).toBeNull();
 const effective=screen.getByText('Effective submitted settings').closest('details')!;effective.open=true;fireEvent(effective,new Event('toggle'));
 await waitFor(()=>expect(document.querySelector('[data-history-details] pre')?.textContent).toContain('exact.safetensors'));
 fireEvent.click(screen.getByRole('button',{name:'Use settings'}));expect(apply).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Apply settings'}));expect(apply).toHaveBeenCalledTimes(1);
 expect(apply.mock.calls[0][0].intent).toEqual(intent);
 expect(vi.mocked(invoke).mock.calls).toEqual([['native_jobs_history',{}]]);
 expect(document.querySelector('[data-job-id]')).toBeNull();expect(document.querySelector('img,video')).toBeNull();
 fireEvent.keyDown(window,{key:'Escape'});expect(document.querySelector('[data-history-panel]')).toBeNull();
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Recent generations'}));
});
test('missing inputs, dependencies, environment and nonreconstructible fields are shown before explicit partial application',async()=>{
 vi.mocked(invoke).mockResolvedValue(snapshot([{...row('partial'),intent:{...intent,checkpoint:'missing.safetensors',inputImage:'missing.png',inputMask:'missing-mask.png',imageReference:{visionModel:'missing-vision.safetensors',images:[{image:'reference.png',strength:0.4}]}}}]));
 const apply=mount({projectOpen:true,context:{...context,endpoint:'http://other:7802'}});await open();
 fireEvent.click(document.querySelector('[data-history-id]')!);fireEvent.click(screen.getByRole('button',{name:'Use settings'}));
 const confirmation=within(document.querySelector<HTMLElement>('[data-history-confirm]')!);
 expect(confirmation.getByText(/active project keeps its autosave/)).toBeTruthy();expect(confirmation.getByText(/clears the current editor input, mask, layers and references/)).toBeTruthy();expect(confirmation.getByText(/missing.safetensors.*missing-vision.safetensors/)).toBeTruthy();expect(confirmation.getByText(/Cannot reconstruct.*inputMask/)).toBeTruthy();
 expect(apply).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Apply partial settings'}));
 expect(apply.mock.calls[0][0].source).toEqual({name:'missing.png',strength:1});
 expect(apply.mock.calls[0][0].unsupported).toContain('inputMask');expect(apply.mock.calls[0][0].references[0].path).toBeUndefined();
});
test('keeps current-session metadata accessible with one historical row per native identity',async()=>{
 vi.mocked(invoke).mockResolvedValue(snapshot([row('same'),row('older'),row('same')]));mount({liveIds:['same']});await open();
 expect(document.querySelectorAll('[data-history-id="same"]')).toHaveLength(1);expect(screen.getByText('Also in current queue')).toBeTruthy();expect(document.querySelector('[data-history-id="older"]')).not.toBeNull();
});
test('explicit output check sends only native identity with matching Windows selected root and reports missing files',async()=>{
 const rec={...row('windows'),outputRoot:'C:\\env\\output',outputs:[{filename:'found.png',subfolder:'raw',type:'output' as const},{filename:'gone.png',subfolder:'raw',type:'output' as const}]};
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?snapshot([rec]):['available','missing']);
 mount({outputRoot:'C:/env/output'});await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 expect(screen.getAllByText('Not checked')).toHaveLength(2);expect(invoke).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));
 await screen.findByText('Available in selected environment');expect(screen.getByText('Missing from selected environment')).toBeTruthy();
 expect(invoke).toHaveBeenLastCalledWith('native_jobs_history_outputs',{jobId:'windows'});
});
test('completed output availability is hidden on root change and switching back requires a fresh explicit check',async()=>{
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?snapshot():['available']);
 const view=render(historyView({outputRoot:'/env/output'}));await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));await screen.findByText('Available in selected environment');
 view.rerender(historyView({outputRoot:'/different/output'}));
 expect(screen.queryByText('Available in selected environment')).toBeNull();expect(screen.queryByText('Missing from selected environment')).toBeNull();expect(screen.getByText('Not checked')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Check files in selected environment'})).toBeNull();
 view.rerender(historyView({outputRoot:'/env/output'}));expect(screen.getByText('Not checked')).toBeTruthy();
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_jobs_history_outputs')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));await screen.findByText('Available in selected environment');
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_jobs_history_outputs')).toEqual([['native_jobs_history_outputs',{jobId:'attempt-1'}],['native_jobs_history_outputs',{jobId:'attempt-1'}]]);
});
test.each([
 {name:'backend namespace',next:{...context,endpoint:'http://127.0.0.1:7801/other-backend/'}},
 {name:'input environment',next:{...context,inputRoot:'/different/input'}},
])('completed output availability is invalidated by a changed $name with the same selected output root',async({next})=>{
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?snapshot():['missing']);
 const view=render(historyView({outputRoot:'/env/output'}));await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));await screen.findByText('Missing from selected environment');
 view.rerender(historyView({outputRoot:'/env/output',context:next}));
 expect(screen.getByText('Not checked')).toBeTruthy();expect(screen.queryByText('Available in selected environment')).toBeNull();expect(screen.queryByText('Missing from selected environment')).toBeNull();
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_jobs_history_outputs')).toHaveLength(1);
});
test('a deferred old-context reply cannot display availability or clear a newer pending check',async()=>{
 const oldCheck=deferred<string[]>(),currentCheck=deferred<string[]>();let checks=0;
 vi.mocked(invoke).mockImplementation(command=>command==='native_jobs_history'?Promise.resolve(snapshot()):(++checks===1?oldCheck.promise:currentCheck.promise));
 const view=render(historyView({outputRoot:'/env/output'}));await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));
 view.rerender(historyView({outputRoot:'/env/output',context:{...context,endpoint:'http://127.0.0.1:7801/backend-B/'}}));
 const check=screen.getByRole<HTMLButtonElement>('button',{name:'Check files in selected environment'});expect(check.disabled).toBe(false);
 fireEvent.click(check);expect(check.disabled).toBe(true);
 await act(async()=>{oldCheck.resolve(['available']);});
 expect(check.disabled).toBe(true);expect(screen.getByText('Not checked')).toBeTruthy();expect(screen.queryByText('Available in selected environment')).toBeNull();expect(screen.queryByText('Missing from selected environment')).toBeNull();
 await act(async()=>{currentCheck.resolve(['missing']);});expect(check.disabled).toBe(false);expect(screen.getByText('Missing from selected environment')).toBeTruthy();
 view.rerender(historyView({outputRoot:'/env/output'}));expect(screen.getByText('Not checked')).toBeTruthy();expect(checks).toBe(2);
});
test('a newly observed record revision invalidates completed output availability without another file check',async()=>{
 vi.useFakeTimers();let current=snapshot();
 vi.mocked(invoke).mockImplementation(async command=>command==='native_jobs_history'?current:['available']);
 mount({outputRoot:'/env/output'});fireEvent.click(screen.getByRole('button',{name:'Recent generations'}));await act(async()=>{});
 fireEvent.click(document.querySelector('[data-history-id]')!);fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));await act(async()=>{});
 expect(screen.getByText('Available in selected environment')).toBeTruthy();
 current=snapshot([{...row('attempt-1'),revision:3}]);await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
 expect(screen.getByText('Not checked')).toBeTruthy();expect(screen.queryByText('Available in selected environment')).toBeNull();
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_jobs_history_outputs')).toHaveLength(1);
});
test('closing history invalidates a pending output check and reopening requires a fresh check',async()=>{
 const oldCheck=deferred<string[]>();
 vi.mocked(invoke).mockImplementation(command=>command==='native_jobs_history'?Promise.resolve(snapshot()):oldCheck.promise);
 mount({outputRoot:'/env/output'});await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));fireEvent.click(screen.getByRole('button',{name:'Close history'}));
 await act(async()=>{oldCheck.resolve(['available']);});await open();
 expect(screen.getByText('Not checked')).toBeTruthy();expect(screen.queryByText('Available in selected environment')).toBeNull();
 expect(screen.getByRole<HTMLButtonElement>('button',{name:'Check files in selected environment'}).disabled).toBe(false);
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_jobs_history_outputs')).toHaveLength(1);
});
test('an unmounted history ignores a pending output-check reply',async()=>{
 const oldCheck=deferred<string[]>();
 vi.mocked(invoke).mockImplementation(command=>command==='native_jobs_history'?Promise.resolve(snapshot()):oldCheck.promise);
 const view=render(historyView({outputRoot:'/env/output'}));await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));view.unmount();await act(async()=>{oldCheck.resolve(['available']);});
 mount({outputRoot:'/env/output'});await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 expect(screen.getByText('Not checked')).toBeTruthy();expect(screen.queryByText('Available in selected environment')).toBeNull();
 expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='native_jobs_history_outputs')).toHaveLength(1);
});
test('a different output root grants no check action and read-only/error state remains usable',async()=>{
 vi.mocked(invoke).mockResolvedValue({...snapshot(),readOnly:true,error:'History persistence unavailable.'});mount({outputRoot:'/other/output'});await open();fireEvent.click(document.querySelector('[data-history-id]')!);
 expect(screen.queryByRole('button',{name:'Check files in selected environment'})).toBeNull();expect(screen.getByText(/History is read only/)).toBeTruthy();expect(screen.getByText(/History storage is degraded/)).toBeTruthy();
});
test('bounded open-panel observation exposes a later persistence failure without endpoint or generation IPC',async()=>{
 vi.useFakeTimers();mount();fireEvent.click(screen.getByRole('button',{name:'Recent generations'}));await act(async()=>{});
 vi.mocked(invoke).mockResolvedValue({...snapshot(),readOnly:true,error:'Late atomic publication failed.'});
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
 expect(screen.getByText(/Late atomic publication failed/)).toBeTruthy();expect(vi.mocked(invoke).mock.calls.every(([command])=>command==='native_jobs_history')).toBe(true);
});
test('output-check failure remains unvalidated and emits a fixed redacted shared log operation',async()=>{
 vi.mocked(invoke).mockImplementation(async command=>{if(command==='native_jobs_history')return snapshot();if(command==='native_jobs_history_outputs')throw Error('private body token=secret');return null;});
 mount({outputRoot:'/env/output'});await open();fireEvent.click(document.querySelector('[data-history-id]')!);fireEvent.click(screen.getByRole('button',{name:'Check files in selected environment'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_logs_history_error',{operation:'outputs'}));
 expect(screen.getByText('Not checked')).toBeTruthy();expect(document.body.textContent).not.toContain('token=secret');
});
