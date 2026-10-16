import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { OwnedBackendPanel } from './OwnedBackendPanel';
import AiOSetup from './AiOSetup';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.pref.backend.autostart','false');localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.useRealTimers();});
const fixture=(state:'starting'|'running'|'failed'|'stopped',endpoint:string|null=null)=>({state,endpoint,logs:['mock IPC fixture log'],error:null,generationReady:false});
const mount=(succeeded=false,connect=vi.fn())=>render(<I18nProvider><OwnedBackendPanel installSucceeded={succeeded} onConnectExisting={connect}/></I18nProvider>);
describe('owned backend lifecycle — mock IPC fixtures, not real ComfyUI/GPU verification',()=>{
 it('autostarts once after checking native status and never restarts after explicit stop',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>fixture(command==='native_backend_start'?'starting':'stopped'));
  const view=render(<StrictMode><I18nProvider><OwnedBackendPanel installSucceeded autoStart onConnectExisting={vi.fn()}/></I18nProvider></StrictMode>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_backend_start'));
  expect(vi.mocked(invoke).mock.calls.slice(0,2)).toEqual([['native_backend_status'],['native_backend_start']]);
  fireEvent.click(screen.getByRole('button',{name:'Stop owned backend'}));await act(async()=>{});
  view.rerender(<StrictMode><I18nProvider><OwnedBackendPanel installSucceeded autoStart onConnectExisting={vi.fn()}/></I18nProvider></StrictMode>);
  await act(async()=>{});expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_backend_start')).toHaveLength(1);
 });
 it('background status polls do not toggle the buttons disabled (no flicker)',async()=>{
  vi.useFakeTimers();let release=()=>{};
  vi.mocked(invoke).mockImplementation(command=>command==='native_backend_status'?new Promise(r=>{release=()=>r(fixture('running','http://127.0.0.1:49188'));}):Promise.resolve(fixture('running','http://127.0.0.1:49188')));
  mount(true);fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));await act(async()=>{});
  await act(async()=>{vi.advanceTimersByTime(1000);});
  expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_backend_status')).toHaveLength(1);
  expect((screen.getByRole('button',{name:'Stop owned backend'}) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button',{name:'Refresh backend status'}) as HTMLButtonElement).disabled).toBe(false);
  await act(async()=>{release();});
 });
 it('does not duplicate an already running owned backend',async()=>{
  vi.mocked(invoke).mockResolvedValue(fixture('running','http://127.0.0.1:49312'));
  const connect=vi.fn();render(<I18nProvider><OwnedBackendPanel installSucceeded autoStart onConnectExisting={connect}/></I18nProvider>);
  await waitFor(()=>expect(connect).toHaveBeenCalledWith('http://127.0.0.1:49312'));
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_backend_start')).toBe(false);
 });
 it('requires successful installation and explicit start, polls readiness and explicitly stops',async()=>{
  vi.useFakeTimers();const connect=vi.fn();
  vi.mocked(invoke).mockImplementation(async command=>fixture(command==='native_backend_start'?'starting':command==='native_backend_stop'?'stopped':'running',command==='native_backend_status'?'http://127.0.0.1:49173':null));
  mount(true,connect);expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));
  await act(async()=>{});
  expect(screen.getByRole('status').textContent).toContain('Starting');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByRole('status').textContent).toContain('Running');
  expect(connect).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:49173');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Inspect running backend'}));
  expect(connect).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button',{name:'Stop owned backend'}));await act(async()=>{});
  expect(screen.getByRole('status').textContent).toContain('Stopped');
  expect(screen.queryByRole('button',{name:'Inspect running backend'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls).toEqual([['native_backend_start'],['native_backend_status'],['native_backend_status'],['native_backend_stop']]);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(invoke).toHaveBeenCalledTimes(4);
  expect(screen.getByText(/Generation readiness is not verified/)).toBeTruthy();
 });
 it('rehydrates native session status without starting or adopting a draft environment',async()=>{
  vi.mocked(invoke).mockResolvedValue(fixture('running','http://127.0.0.1:49312'));
  mount(false);expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:'Start owned backend'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
  await screen.findByRole('button',{name:'Stop owned backend'});
  expect(vi.mocked(invoke).mock.calls).toEqual([['native_backend_status']]);
 });
 it('shows failed-start native technical errors without inventing running',async()=>{
  vi.mocked(invoke).mockResolvedValue({...fixture('failed'),error:'owned launch hash mismatch'});
  mount(true);fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));
  expect((await screen.findByRole('alert')).textContent).toContain('owned launch hash mismatch');
  expect(screen.getByRole('status').textContent).toBe('Failed');
  expect(screen.queryByRole('button',{name:'Inspect running backend'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Stop owned backend'})).toBeNull();
 });
 it('shows rejected IPC errors and can explicitly refresh without claiming running',async()=>{
  vi.mocked(invoke).mockRejectedValue('fixture launch denied');mount(true);
  fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));
  expect((await screen.findByRole('alert')).textContent).toContain('fixture launch denied');
  expect(screen.queryByRole('status')).toBeNull();
  vi.mocked(invoke).mockResolvedValue(fixture('stopped'));
  fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
  await screen.findByRole('status');expect(screen.queryByRole('alert')).toBeNull();
 });
 it('serializes double clicks and slow polls, and discards pending results after unmount',async()=>{
  vi.useFakeTimers();let resolve!: (value:ReturnType<typeof fixture>)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const view=mount(true);const button=screen.getByRole('button',{name:'Start owned backend'});
  fireEvent.click(button);fireEvent.click(button);
  fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>{resolve(fixture('starting'));});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(invoke).toHaveBeenCalledTimes(2);
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(invoke).toHaveBeenCalledTimes(2);
  view.unmount();await act(async()=>{resolve(fixture('running','http://127.0.0.1:49423'));});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(invoke).toHaveBeenCalledTimes(2);
  mount(false);expect(screen.queryByRole('button',{name:'Inspect running backend'})).toBeNull();
 });
 it('does not expose endpoint inspection for running without an endpoint',async()=>{
  vi.mocked(invoke).mockResolvedValue(fixture('running'));mount(false);
  fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
  await screen.findByRole('button',{name:'Stop owned backend'});
  expect(screen.queryByRole('button',{name:'Inspect running backend'})).toBeNull();
 });
 it.each(['starting','failed','stopped'] as const)('does not hand off a %s backend even with endpoint metadata',async state=>{
  const connect=vi.fn();vi.mocked(invoke).mockResolvedValue(fixture(state,'http://127.0.0.1:49312'));
  mount(false,connect);fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
  await screen.findByRole('status');expect(connect).not.toHaveBeenCalled();
 });
 it('hands off a restarted or changed native endpoint but not repeated running polls',async()=>{
  const connect=vi.fn();const view=mount(true,connect);
  for(const [state,endpoint,count] of [
   ['running','http://127.0.0.1:49312',1],['running','http://127.0.0.1:49312',1],
   ['stopped',null,1],['running','http://127.0.0.1:49312',2],['running','http://127.0.0.1:49313',3],
  ] as const){
   vi.mocked(invoke).mockResolvedValue(fixture(state,endpoint));
   fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
   await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh backend status'})).toHaveProperty('disabled',false));
   expect(connect).toHaveBeenCalledTimes(count);
  }
  expect(connect).toHaveBeenLastCalledWith('http://127.0.0.1:49313');
  view.rerender(<I18nProvider><OwnedBackendPanel installSucceeded onConnectExisting={endpoint=>connect(endpoint)}/></I18nProvider>);
  expect(connect).toHaveBeenCalledTimes(3);
 });
 it('cannot invoke native lifecycle commands in browser preview',()=>{
  vi.mocked(isTauri).mockReturnValue(false);mount(true);
  expect(screen.queryByRole('button',{name:'Start owned backend'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Refresh backend status'}));
  expect(invoke).not.toHaveBeenCalled();expect(screen.getByText(/Browser preview cannot start/)).toBeTruthy();
 });
 it('localizes lifecycle controls in German',()=>{
  localStorage.setItem('deas.locale.v1','de');mount(true);
  expect(screen.getByRole('button',{name:'App-eigenes Backend starten'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Backend-Status aktualisieren'})).toBeTruthy();
 });
});

async function installFixture(result:'succeeded'|'failed') {
 vi.mocked(invoke).mockImplementation(async command=>{
  if(command==='native_install_defaults')return {storagePath:'/data/mock-DEAS',backend:'cpu',hardware:null,warnings:[]};
  if(command==='native_install_plan')return {id:'mock-plan',request:{storagePath:'/data/mock-DEAS',backend:'cpu',features:['director','forge','refmods','continuity'],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'},steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
  if(command==='native_install_start')return {state:result,stepId:null,logs:['mock install fixture'],error:result==='failed'?'fixture install failed':null};
  return fixture('stopped');
 });
 render(<I18nProvider><AiOSetup onConnectExisting={vi.fn()}/></I18nProvider>);
 const click=(name:RegExp)=>fireEvent.click(screen.getByRole('button',{name}));
 fireEvent.click(screen.getByRole('button',{name:'AiO installer'}));await screen.findByRole('button',{name:'Start install'});click(/^Start install$/);
 await screen.findByText('mock install fixture');
}
describe('AiO integration — mock installation/IPC fixtures only',()=>{
 it('exposes a separate explicit backend start only after succeeded install',async()=>{
  await installFixture('succeeded');
  // Success moves to the Studio tab; a second installer click no longer reopens the review: re-runs live in Settings & Backend.
  const installer=()=>fireEvent.click(screen.getByRole('button',{name:'AiO installer'}));
  await screen.findByRole('tab',{name:'Studio',selected:true});
  installer();expect(screen.getByRole('button',{name:'Start owned backend'})).toBeTruthy();installer();expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='native_backend_start')).toBe(false);
  vi.mocked(invoke).mockImplementation(async command=>fixture(command==='native_backend_start'?'starting':command==='native_backend_stop'?'stopped':'running',command==='native_backend_status'?'http://127.0.0.1:49517':null));
  fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));
  await screen.findByRole('button',{name:'Stop owned backend'});
  await screen.findByRole('button',{name:'Inspect running backend'}, {timeout:2500});
  fireEvent.click(screen.getByRole('button',{name:'Stop owned backend'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Stop owned backend'})).toBeNull());
  const lifecycleCalls=vi.mocked(invoke).mock.calls.filter(([command])=>command.startsWith('native_backend_'));
  expect(lifecycleCalls).toEqual([['native_backend_start'],['native_backend_status'],['native_backend_stop']]);
 });
 it('upgrades directly and re-runs the installation only after the overwrite warning',async()=>{
  await installFixture('succeeded');
  const base=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_update'?{state:'succeeded',stepId:null,logs:['mock update fixture'],error:null}:base(command,args));
  fireEvent.click(screen.getByRole('button',{name:'Settings & Backend'}));
  expect(screen.getByRole('switch',{name:'Auto-start backend'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Re-run installation'}));
  expect(screen.getByRole('alertdialog').textContent).toMatch(/overwrites the installation/);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_install_update')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Re-run installation'}));fireEvent.click(screen.getByRole('button',{name:'Overwrite and reinstall'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_install_update',{reinstall:true,confirmed:true}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Upgrade'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Upgrade'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_install_update',{reinstall:false,confirmed:true}));
 });
 it('never exposes backend start for a failed install',async()=>{
  await installFixture('failed');expect(screen.queryByRole('button',{name:'Start owned backend'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='native_backend_start')).toBe(false);
 });
});
