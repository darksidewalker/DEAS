import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { OwnedBackendPanel } from './OwnedBackendPanel';
import AiOSetup from './AiOSetup';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));
beforeEach(()=>{localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.useRealTimers();});
const fixture=(state:'starting'|'running'|'failed'|'stopped',endpoint:string|null=null)=>({state,endpoint,logs:['mock IPC fixture log'],error:null,generationReady:false});
const mount=(succeeded=false,connect=vi.fn())=>render(<I18nProvider><OwnedBackendPanel installSucceeded={succeeded} onConnectExisting={connect}/></I18nProvider>);
describe('owned backend lifecycle — mock IPC fixtures, not real ComfyUI/GPU verification',()=>{
 it('requires successful installation and explicit start, polls readiness and explicitly stops',async()=>{
  vi.useFakeTimers();const connect=vi.fn();
  vi.mocked(invoke).mockImplementation(async command=>fixture(command==='native_backend_start'?'starting':command==='native_backend_stop'?'stopped':'running',command==='native_backend_status'?'http://127.0.0.1:49173':null));
  mount(true,connect);expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));
  await act(async()=>{});
  expect(screen.getByRole('status').textContent).toContain('Starting');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByRole('status').textContent).toContain('Running');
  expect(connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Inspect running backend'}));
  expect(connect).toHaveBeenCalledWith('http://127.0.0.1:49173');
  fireEvent.click(screen.getByRole('button',{name:'Stop owned backend'}));await act(async()=>{});
  expect(screen.getByRole('status').textContent).toContain('Stopped');
  expect(screen.queryByRole('button',{name:'Inspect running backend'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls).toEqual([['native_backend_start'],['native_backend_status'],['native_backend_stop']]);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(invoke).toHaveBeenCalledTimes(3);
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
  if(command==='native_detect_hardware')return {backend:null};
  if(command==='native_install_plan')return {id:'mock-plan',request:{},steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
  if(command==='native_install_start')return {state:result,stepId:null,logs:['mock install fixture'],error:result==='failed'?'fixture install failed':null};
  return fixture('stopped');
 });
 render(<I18nProvider><AiOSetup onConnectExisting={vi.fn()}/></I18nProvider>);
 const click=(name:RegExp)=>fireEvent.click(screen.getByRole('button',{name}));
 const confirm=()=>click(/^Confirm & continue$/);
 click(/AiO installer/);click(/New app-owned install/);confirm();
 fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/data/mock-DEAS'}});confirm();confirm();click(/^CPU/);confirm();
 click(/Prepare native plan/);await screen.findByLabelText(/I confirm this exact plan/);
 fireEvent.click(screen.getByLabelText(/I confirm this exact plan/));click(/Install confirmed plan/);
 await screen.findByText('mock install fixture');
}
describe('AiO integration — mock installation/IPC fixtures only',()=>{
 it('exposes a separate explicit backend start only after succeeded install',async()=>{
  await installFixture('succeeded');
  expect(screen.getByRole('button',{name:'Start owned backend'})).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='native_backend_start')).toBe(false);
  expect(screen.getByLabelText(/I confirm this exact plan/)).toBeTruthy();
  vi.mocked(invoke).mockImplementation(async command=>fixture(command==='native_backend_start'?'starting':command==='native_backend_stop'?'stopped':'running',command==='native_backend_status'?'http://127.0.0.1:49517':null));
  fireEvent.click(screen.getByRole('button',{name:'Start owned backend'}));
  await screen.findByRole('button',{name:'Stop owned backend'});
  await screen.findByRole('button',{name:'Inspect running backend'}, {timeout:2500});
  fireEvent.click(screen.getByRole('button',{name:'Stop owned backend'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Stop owned backend'})).toBeNull());
  const lifecycleCalls=vi.mocked(invoke).mock.calls.filter(([command])=>command.startsWith('native_backend_'));
  expect(lifecycleCalls).toEqual([['native_backend_start'],['native_backend_status'],['native_backend_stop']]);
 });
 it('never exposes backend start for a failed install',async()=>{
  await installFixture('failed');expect(screen.queryByRole('button',{name:'Start owned backend'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='native_backend_start')).toBe(false);
 });
});
