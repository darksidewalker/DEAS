import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiOSetup from './AiOSetup';
import { defaultLlmConfig } from '../../lib/llm';
import { I18nProvider } from '../../i18n/I18nProvider';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { NativeInstallRequest } from '../../lib/setup';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>false)}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.pref.backend.autostart','false');localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(false);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const mount=(connect=vi.fn(),installed=vi.fn())=>render(<I18nProvider><AiOSetup onConnectExisting={connect} onInstalled={installed}/></I18nProvider>);
const open=()=>fireEvent.click(screen.getByRole('button',{name:'AiO installer'}));
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const request:NativeInstallRequest={storagePath:'/app/deas-environment',backend:'cpu',features:['director','forge','refmods','continuity'],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'};
const defaults={storagePath:request.storagePath,backend:'cpu',hardware:null,warnings:['CPU fallback fixture']};
const plan=(r=request)=>({id:'fixture-plan',request:r,steps:[],warnings:[],unsupportedOptions:[],canExecute:true});
function nativeFixture(){
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockImplementation(async(command,args)=>{
  if(command==='native_install_defaults')return defaults;
  if(command==='native_install_plan')return plan((args as {request:NativeInstallRequest}).request);
  if(command==='native_detect_hardware')return {backend:null};
  return {state:'running',stepId:'python',logs:['native fixture log'],error:null};
 });
}
async function ready(){mount();open();await waitFor(()=>expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe(request.storagePath));await screen.findByRole('button',{name:'Start install'});}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
describe('automatic-first installation — read-only mock IPC fixtures',()=>{
 it('autostarts after successful fresh provisioning but never before install consent',async()=>{
  nativeFixture();localStorage.removeItem('deas.pref.backend.autostart');
  vi.mocked(invoke).mockImplementation(async(c,args)=>{
   if(c==='native_install_defaults')return defaults;
   if(c==='native_install_plan')return plan((args as {request:NativeInstallRequest}).request);
   if(c==='native_install_start')return {state:'succeeded',stepId:null,logs:[],error:null};
   return {state:c==='native_backend_start'?'starting':'stopped',endpoint:null,logs:[],error:null,generationReady:false};
  });
  mount();open();await screen.findByRole('button',{name:'Start install'});
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_backend_start')).toBe(false);
  click('Start install');await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_backend_start'));
  expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_backend_start')).toHaveLength(1);
 });
 it('restores and autostarts a checked remembered environment by default',async()=>{
  nativeFixture();localStorage.removeItem('deas.pref.backend.autostart');localStorage.setItem('deas.pref.install.root','"/custom/env"');
  vi.mocked(invoke).mockImplementation(async c=>{
   if(c==='native_files_present')return [true];
   if(c==='native_install_defaults')return defaults;
   if(c==='native_install_plan')return {...plan({...request,storagePath:'/custom/env'}),id:'reopen',reopenId:'reopen'};
   if(c==='native_settings_read')return {};
   if(c==='native_install_open')return {state:'succeeded',stepId:null,logs:[],error:null};
   return {state:c==='native_backend_start'?'starting':'stopped',endpoint:null,logs:[],error:null,generationReady:false};
  });
  mount();await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_backend_start'));
  expect(invoke).toHaveBeenCalledWith('native_install_open',{planId:'reopen',confirmed:true});
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_install_start')).toBe(false);
 });
 it('defaults backend autostart on and remembers the Settings switch being disabled',async()=>{
  localStorage.removeItem('deas.pref.backend.autostart');const first=mount();click('Settings & Backend');
  const toggle=screen.getByRole('switch',{name:'Auto-start backend'});expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);await waitFor(()=>expect(localStorage.getItem('deas.pref.backend.autostart')).toBe('false'));
  first.unmount();mount();click('Settings & Backend');expect(screen.getByRole('switch',{name:'Auto-start backend'}).getAttribute('aria-checked')).toBe('false');
 });
 it('recognizes a chosen environment root without nesting another environment directory',async()=>{
  nativeFixture();
  vi.mocked(invoke).mockImplementation(async(c,args)=>{
   if(c==='native_install_defaults')return defaults;
   if(c==='native_pick_directory')return '/chosen/env';
   if(c==='native_files_present')return [true,true];
   if(c==='native_install_plan'){const r=(args as {request:NativeInstallRequest}).request;return {...plan(r),...(r.storagePath==='/chosen/env'?{reopenId:'fixture-plan'}:{})};}
   return {};
  });
  mount();open();await screen.findByRole('button',{name:'Start install'});click('Choose parent folder…');
  await screen.findByRole('button',{name:'Use existing environment'});expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/chosen/env');
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_install_start'||c==='native_install_open')).toBe(false);
 });
 it('does not autostart an unverified remembered folder or turn it into a new install',async()=>{
  nativeFixture();localStorage.removeItem('deas.pref.backend.autostart');localStorage.setItem('deas.pref.install.root','"/invalid/env"');
  vi.mocked(invoke).mockImplementation(async c=>c==='native_files_present'?[true]:plan());
  mount();await screen.findByText(/Saved environment is not a complete DEAS installation/);
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_install_open'||c==='native_install_start'||c==='native_backend_start')).toBe(false);
 });
 it('opens a validated existing environment instead of reinstalling the selected folder',async()=>{
  nativeFixture();const installed=vi.fn();const existing={...plan({...request,storagePath:'/real/existing-env',features:[]}),id:'reopen-preview',reopenId:'reopen-preview'};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
   if(command==='native_install_defaults')return defaults;
   if(command==='native_install_plan')return (args as {request:NativeInstallRequest}).request.storagePath==='/alias/existing-env'?existing:plan();
   if(command==='native_settings_read')return {models:'/saved/models'};
   if(command==='native_install_open')return {state:'succeeded',stepId:null,logs:['opened existing fixture'],error:null};
   return {state:'stopped',endpoint:null,logs:[],error:null,generationReady:false};
  });
  mount(vi.fn(),installed);open();await screen.findByRole('button',{name:'Start install'});
  change('Storage directory','/alias/existing-env');await screen.findByRole('button',{name:'Use existing environment'});
  expect(installed).not.toHaveBeenCalled();expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_install_open')).toBe(false);
  click('Use existing environment');await waitFor(()=>expect(installed).toHaveBeenCalledWith([]));
  expect(invoke).toHaveBeenCalledWith('native_install_open',{planId:'reopen-preview',confirmed:true});
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_install_start'||c==='native_backend_start')).toBe(false);
  expect(JSON.parse(localStorage.getItem('deas.pref.install.root')!)).toBe('/real/existing-env');
 });
 it('hands off exact successful native features once, without starting or inspecting a backend',async()=>{
  nativeFixture();const installed=vi.fn();let prepared=plan();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
   if(command==='native_install_defaults')return defaults;
   if(command==='native_install_plan'){prepared=plan((args as {request:NativeInstallRequest}).request);return prepared;}
   return {state:'succeeded',stepId:null,logs:['installed fixture'],error:null};
  });
  const view=mount(vi.fn(),installed);open();await screen.findByText('CPU fallback fixture');
  await screen.findByRole('button',{name:'Start install'});expect(installed).not.toHaveBeenCalled();
  click('Start install');await waitFor(()=>expect(installed).toHaveBeenCalledTimes(1));
  expect(installed.mock.calls[0][0]).toBe(prepared.request.features);
  expect(installed.mock.calls[0][0]).toEqual(['director','forge','refmods','continuity']);
  view.rerender(<I18nProvider><AiOSetup onConnectExisting={vi.fn()} onInstalled={features=>installed(features)}/></I18nProvider>);
  expect(installed).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command).filter(c=>c!=='native_auth_status'&&c!=='native_repo_stars')).toEqual(['native_install_defaults','native_install_plan','native_install_start']);
 });
 it.each(['idle','failed','cancelled'] as const)('does not hand off a native %s install',async state=>{
  nativeFixture();const installed=vi.fn();
  vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?defaults:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):{state,stepId:null,logs:['not succeeded'],error:null});
  mount(vi.fn(),installed);open();await screen.findByText('CPU fallback fixture');await screen.findByRole('button',{name:'Start install'});click('Start install');await screen.findByText('not succeeded');
  expect(installed).not.toHaveBeenCalled();
 });
 it('hands off only when a running actual install polls succeeded',async()=>{
  nativeFixture();const installed=vi.fn();const completion=deferred<unknown>();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
   if(command==='native_install_defaults')return defaults;
   if(command==='native_install_plan')return plan((args as {request:NativeInstallRequest}).request);
   if(command==='native_install_status')return completion.promise;
   return {state:'running',stepId:null,logs:['running install'],error:null};
  });
  mount(vi.fn(),installed);open();await screen.findByText('CPU fallback fixture');await screen.findByRole('button',{name:'Start install'});click('Start install');await screen.findByText('running install');
  expect(installed).not.toHaveBeenCalled();await act(async()=>completion.resolve({state:'succeeded',stepId:null,logs:[],error:null}));
  expect(installed).toHaveBeenCalledExactlyOnceWith(['director','forge','refmods','continuity']);
 });
 it('does not replay a previous success when the installer is reopened',async()=>{
  nativeFixture();const installed=vi.fn();let id=0;
  vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?defaults:command==='native_install_plan'?{...plan((args as {request:NativeInstallRequest}).request),id:`plan-${++id}`}:{state:'succeeded',stepId:null,logs:[],error:null});
  mount(vi.fn(),installed);open();await screen.findByText('CPU fallback fixture');await screen.findByRole('button',{name:'Start install'});click('Start install');await waitFor(()=>expect(installed).toHaveBeenCalledTimes(1));
  expect(JSON.parse(localStorage.getItem('deas.pref.install.root')!)).toBe(request.storagePath);expect(screen.queryByLabelText('Director')).toBeNull();open();open();
  // Re-runs moved to Settings & Backend: reopening the installer neither shows the review nor replays success.
  expect(screen.queryByLabelText('Director')).toBeNull();expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
  await new Promise(r=>setTimeout(r,300));expect(installed).toHaveBeenCalledTimes(1);
 });
 it('remembers a successful install root and reopens the Studio while its manifest exists',async()=>{
  nativeFixture();localStorage.setItem('deas.pref.install.root','"/custom/env"');
  vi.mocked(invoke).mockImplementation(async command=>command==='native_files_present'?[true]:command==='native_settings_read'?{models:'/custom/models'}:command==='native_install_plan'?{...plan({...request,storagePath:'/custom/env'}),id:'reopen',reopenId:'reopen'}:command==='native_install_open'?{state:'succeeded',stepId:null,logs:[],error:null}:defaults);
  mount();await screen.findByRole('tab',{name:'Studio',selected:true});
  expect(invoke).toHaveBeenCalledWith('native_files_present',{paths:['/custom/env/deas-install.json']});
  open();await screen.findByRole('button',{name:'Start owned backend'});expect(invoke).toHaveBeenCalledWith('native_install_open',{planId:'reopen',confirmed:true});expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_backend_start'||c==='native_install_start')).toBe(false);expect(screen.queryByRole('button',{name:'Run install again'})).toBeNull();
 });
 it('forgets a vanished install root and keeps the first run',async()=>{
  nativeFixture();localStorage.setItem('deas.pref.install.root','"/gone/env"');
  vi.mocked(invoke).mockImplementation(async command=>command==='native_files_present'?[false]:defaults);
  mount();await waitFor(()=>expect(localStorage.getItem('deas.pref.install.root')).toBeNull());
  expect(screen.getByRole('button',{name:'AiO installer'}).getAttribute('aria-pressed')).toBe('true');expect(screen.queryByText(/Installed in/)).toBeNull();
 });
 it('opens every editable field without inventing a browser path or hardware',()=>{
  mount();open();expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('');
  expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();
  expect((screen.getByLabelText('Director') as HTMLInputElement).checked).toBe(true);
  for(const label of ['SageAttention (opt-in)','Radial attention (opt-in)','FlashAttention (opt-in)','FFmpeg (opt-in)'])expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('button',{name:'Confirm & continue'})).toBeNull();expect(invoke).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
 });
 it('reads defaults only on open; automatic planning never starts installation; final click confirms once',async()=>{
  nativeFixture();mount();expect(vi.mocked(invoke).mock.calls.filter(([c])=>c!=='native_auth_status'&&c!=='native_repo_stars')).toEqual([]);open();await screen.findByText('CPU fallback fixture');
  expect(invoke).toHaveBeenCalledWith('native_install_defaults',{});
  await screen.findByRole('button',{name:'Start install'});
  expect(vi.mocked(invoke).mock.calls.map(([c])=>c).filter(c=>c!=='native_auth_status'&&c!=='native_repo_stars')).toEqual(['native_install_defaults','native_install_plan']);expect(invoke).toHaveBeenCalledWith('native_install_plan',{request});expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());
  const button=screen.getByRole('button',{name:'Start install'});fireEvent.click(button);fireEvent.click(button);
  await screen.findByText('native fixture log');expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_start')).toEqual([['native_install_start',{planId:'fixture-plan',confirmed:true}]]);
  expect(screen.getByLabelText('Storage directory').matches(':disabled')).toBe(true);
 });
 it('preserves all edited options and expands Director in the immutable request',async()=>{
  nativeFixture();await ready();fireEvent.click(screen.getByLabelText('Director'));
  expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
  for(const label of ['SageAttention (opt-in)','Radial attention (opt-in)','FlashAttention (opt-in)','FFmpeg (opt-in)'])fireEvent.click(screen.getByLabelText(label));
  change('ComfyUI Git ref','v0.3.50');change('Storage directory','/other/new');change('Backend','nvidia');
  await screen.findByRole('button',{name:'Start install'});
  expect(invoke).toHaveBeenLastCalledWith('native_install_plan',{request:{storagePath:'/other/new',backend:'nvidia',features:[],options:{sage:true,radial:true,flash:true,ffmpeg:true},comfyRef:'v0.3.50'}});
 });
 it('invalid text is visible, disables review, and invalidates the previous plan',async()=>{
  nativeFixture();await ready();change('Storage directory','relative');expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
  change('Storage directory','/new');change('ComfyUI Git ref','bad ref');await new Promise(r=>setTimeout(r,400));expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_plan')).toHaveLength(1);
 });
 it('late defaults prefill only untouched fields, never overwrite even a cleared manual field',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async()=>late.promise);
  mount();open();change('Storage directory','/manual');change('Storage directory','');change('Backend','amd');
  await act(async()=>late.resolve(defaults));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('amd');
 });
 it('late defaults do not replace a prepared request',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?late.promise:plan((args as {request:NativeInstallRequest}).request));
  mount();open();change('Storage directory','/manual');change('Backend','cpu');await screen.findByRole('button',{name:'Start install'});
  await act(async()=>late.resolve({...defaults,storagePath:'/late',backend:'nvidia'}));expect(screen.getByLabelText('Storage directory')).toHaveProperty('value','/manual');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('cpu');
 });
 it('failed defaults leave manual editing available without guessing',async()=>{
  nativeFixture();vi.mocked(invoke).mockRejectedValue('probe unavailable');mount();open();await screen.findByRole('alert');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('');expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('');change('Storage directory','/manual');change('Backend','cpu');await waitFor(()=>expect(screen.getAllByRole('alert')).toHaveLength(2));expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
 });
 it('shows blockers and original native errors without permitting start',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:{...plan(),canExecute:false,unsupportedOptions:['sage unsupported'],warnings:['target collision']});await ready();expect(screen.getByText('target collision')).toBeTruthy();expect(screen.getByText('sage unsupported')).toBeTruthy();expect((screen.getByRole('button',{name:'Start install'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('refuses mismatched returned requests even when canExecute is true',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:plan({...request,storagePath:'/unexpected'}));await ready();
  expect((screen.getByRole('button',{name:'Start install'}) as HTMLButtonElement).disabled).toBe(true);click('Start install');expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());
 });
 it('blocks unsupported options even when canExecute is true',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:{...plan(),unsupportedOptions:['sage unsupported']});await ready();expect((screen.getByRole('button',{name:'Start install'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('plans once per request and locks edits until the native plan returns',async()=>{
  nativeFixture();const late=deferred<ReturnType<typeof plan>>();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:late.promise);
  mount();open();await screen.findByText('CPU fallback fixture');await waitFor(()=>expect(screen.getByLabelText('Backend').matches(':disabled')).toBe(true));await new Promise(r=>setTimeout(r,400));
  expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_plan')).toHaveLength(1);
  await act(async()=>late.resolve(plan()));expect(screen.getByLabelText('Backend').matches(':disabled')).toBe(false);
 });
 it('late defaults cannot change or unlock a running request',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?late.promise:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):{state:'running',stepId:'python',logs:['running fixture'],error:null});
  mount();open();change('Storage directory','/manual/new');change('Backend','cpu');await screen.findByRole('button',{name:'Start install'});click('Start install');await screen.findByText('running fixture');
  await act(async()=>late.resolve({...defaults,storagePath:'/late',backend:'nvidia'}));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/manual/new');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('cpu');expect(screen.getByLabelText('Backend').matches(':disabled')).toBe(true);
 });
 it('names the detected device in the one-line plan summary before authorization',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:{...plan(),hardware:{name:'GPU fixture',uuid:'GPU-fixture'},torch:{packages:['torch==fixture'],indexUrl:'https://index.fixture',cuda:'fixture'}});await ready();expect(screen.getByText(/GPU fixture/)).toBeTruthy();
 });
 it('uses a native parent chooser without writing and preserves values on cancellation',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?defaults:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):null);mount();open();await screen.findByText('CPU fallback fixture');change('Storage directory','/manual/new');click('Choose parent folder…');await waitFor(()=>expect((screen.getByRole('button',{name:'Choose parent folder…'}) as HTMLButtonElement).disabled).toBe(false));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/manual/new');expect(invoke).toHaveBeenCalledWith('native_pick_directory',{title:'Choose an existing parent folder'});
 });
 it('joins a native parent into a new target and lets the user edit it before review',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?defaults:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):'/selected');mount();open();await screen.findByText('CPU fallback fixture');click('Choose parent folder…');await waitFor(()=>expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/selected/deas-environment'));change('Storage directory','/selected/custom-new');expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/selected/custom-new');expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());
 });
 it('includes optional folder choices in a fresh immutable install plan without saving or moving data',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?defaults:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):command==='native_pick_directory'?'/real/models':null);
  await ready();click('Choose Models folder');await waitFor(()=>expect(screen.getByText('/real/models')).toBeTruthy());
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('native_install_plan',{request:{...request,folders:{models:'/real/models'}}}));
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==='native_settings_write'||c==='native_settings_move'||c==='native_install_start')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Settings & Backend'}));expect(screen.getAllByText('/real/models')).toHaveLength(1);expect(screen.queryByRole('button',{name:'Save folders'})).toBeNull();
 });
 it('saving installed folders preserves successful install state without replanning an existing environment',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?defaults:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):command==='native_settings_read'?{}:command==='native_llm_read'?defaultLlmConfig:command==='native_llm_models'?{models:[],warnings:[]}:command==='native_pick_directory'?'/new/models':command==='native_settings_write'?(args as {folders:unknown}).folders:{state:'succeeded',stepId:null,logs:[],error:null});
  await ready();click('Start install');await screen.findByText('Installed');
  const before=vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_plan').length;
  fireEvent.click(screen.getByRole('button',{name:'Settings & Backend'}));
  const settings=screen.getByRole('region',{name:'Settings'});
  await waitFor(()=>expect((settings.querySelector('button') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(settings.querySelector('button')!);await screen.findByText('/new/models');click('Save folders');
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_settings_write',{root:request.storagePath,folders:{models:'/new/models'}}));
  await new Promise(r=>setTimeout(r,350));expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_plan')).toHaveLength(before);
  expect(screen.getByText('Installed')).toBeTruthy();
 });
 it('cancels only the native installation and shows returned status, not simulated progress',async()=>{
  nativeFixture();await ready();click('Start install');await screen.findByText('native fixture log');
  vi.mocked(invoke).mockImplementation(async command=>command==='native_install_cancel'?null:{state:'cancelled',stepId:null,logs:['native cancellation fixture'],error:null});click('Cancel installation');await screen.findByText('native cancellation fixture');expect(invoke).toHaveBeenCalledWith('native_install_cancel');expect(screen.getByRole('status').textContent).toBe('Cancelled');
 });
 it('discards defaults after unmount and reuses one request during StrictMode replay',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async()=>late.promise);
  const first=mount();open();first.unmount();await act(async()=>late.resolve(defaults));
  vi.mocked(invoke).mockResolvedValue(defaults);render(<StrictMode><I18nProvider><AiOSetup onConnectExisting={vi.fn()}/></I18nProvider></StrictMode>);open();await screen.findByText('CPU fallback fixture');expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_defaults')).toHaveLength(2);
 });
 it('connects an existing backend only through an explicit valid address and never installs',()=>{
  const connect=vi.fn();mount(connect);open();
  change('Existing backend address','not a url');click('Inspect existing backend');expect(connect).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeTruthy();
  change('Existing backend address','http://127.0.0.1:8188');click('Inspect existing backend');expect(connect).toHaveBeenCalledWith('http://127.0.0.1:8188',true);expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:/Manual|Save local draft|Restore/})).toBeNull();
 });
});
