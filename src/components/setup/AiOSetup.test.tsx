import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiOSetup from './AiOSetup';
import { I18nProvider } from '../../i18n/I18nProvider';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { initialSetupState, transitionSetup, serializeSetup, SETUP_DRAFT_KEY, type NativeInstallRequest } from '../../lib/setup';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>false)}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(false);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
const mount=(connect=vi.fn())=>render(<I18nProvider><AiOSetup onConnectExisting={connect}/></I18nProvider>);
const open=()=>click('AiO installer');
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
const request:NativeInstallRequest={storagePath:'/app/deas-environment',backend:'cpu',features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'};
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
async function ready(){mount();open();await waitFor(()=>expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe(request.storagePath));click('Prepare native plan');await screen.findByRole('button',{name:'Start install'});}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
describe('automatic-first installation — read-only mock IPC fixtures',()=>{
 it('opens every editable field without inventing a browser path or hardware',()=>{
  mount();open();expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('');
  expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();
  for(const label of ['Director','SageAttention (opt-in)','Radial attention (opt-in)','FlashAttention (opt-in)','FFmpeg (opt-in)'])expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('button',{name:'Confirm & continue'})).toBeNull();expect(invoke).not.toHaveBeenCalled();
  expect((screen.getByRole('button',{name:'Prepare native plan'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('reads defaults only on open; planning never starts installation; final click confirms once',async()=>{
  nativeFixture();mount();expect(invoke).not.toHaveBeenCalled();open();await screen.findByText('CPU fallback fixture');
  expect(invoke).toHaveBeenCalledWith('native_install_defaults',{});expect(invoke).toHaveBeenCalledTimes(1);
  click('Prepare native plan');await screen.findByRole('button',{name:'Start install'});
  expect(invoke).toHaveBeenCalledWith('native_install_plan',{request});expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());
  const button=screen.getByRole('button',{name:'Start install'});fireEvent.click(button);fireEvent.click(button);
  await screen.findByText('native fixture log');expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_start')).toEqual([['native_install_start',{planId:'fixture-plan',confirmed:true}]]);
  expect(screen.getByLabelText('Storage directory').matches(':disabled')).toBe(true);
 });
 it('preserves all edited options and expands Director in the immutable request',async()=>{
  nativeFixture();await ready();fireEvent.click(screen.getByLabelText('Director'));
  expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();
  for(const label of ['SageAttention (opt-in)','Radial attention (opt-in)','FlashAttention (opt-in)','FFmpeg (opt-in)'])fireEvent.click(screen.getByLabelText(label));
  change('ComfyUI Git ref','v0.3.50');change('Storage directory','/other/new');change('Backend','nvidia');
  click('Prepare native plan');await screen.findByRole('button',{name:'Start install'});
  expect(invoke).toHaveBeenLastCalledWith('native_install_plan',{request:{storagePath:'/other/new',backend:'nvidia',features:['director','forge','refmods','continuity'],options:{sage:true,radial:true,flash:true,ffmpeg:true},comfyRef:'v0.3.50'}});
 });
 it('invalid text is visible, disables review, and invalidates the previous plan',async()=>{
  nativeFixture();await ready();change('Storage directory','relative');expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();expect((screen.getByRole('button',{name:'Prepare native plan'}) as HTMLButtonElement).disabled).toBe(true);
  change('Storage directory','/new');change('ComfyUI Git ref','bad ref');expect((screen.getByRole('button',{name:'Prepare native plan'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('late defaults prefill only untouched fields, never overwrite even a cleared manual field',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async()=>late.promise);
  mount();open();change('Storage directory','/manual');change('Storage directory','');change('Backend','amd');
  await act(async()=>late.resolve(defaults));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('amd');
 });
 it('late defaults do not replace a prepared request',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?late.promise:plan((args as {request:NativeInstallRequest}).request));
  mount();open();change('Storage directory','/manual');change('Backend','cpu');click('Prepare native plan');await screen.findByRole('button',{name:'Start install'});
  await act(async()=>late.resolve({...defaults,storagePath:'/late',backend:'nvidia'}));expect(screen.getByLabelText('Exact native request').textContent).toContain('/manual');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('cpu');
 });
 it('late defaults never overwrite a restored automatic draft',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async()=>late.promise);
  let s=transitionSetup(initialSetupState(),{type:'automatic'});s=transitionSetup(s,{type:'select',step:'storage',value:'/saved/new'});s=transitionSetup(s,{type:'select',step:'acceleration',value:'amd'});localStorage.setItem(SETUP_DRAFT_KEY,serializeSetup(s));
  mount();open();click('Restore saved draft');await act(async()=>late.resolve(defaults));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/saved/new');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('amd');
 });
 it('supports saved older guided drafts without replacing their backend or options',()=>{
  let s=transitionSetup(initialSetupState(),{type:'open'});for(const [step,value] of [['route','managed'],['storage','/saved'],['pack','complete'],['acceleration','amd']] as const)s=transitionSetup(s,{type:'choose',step,value});
  s=transitionSetup(s,{type:'option',id:'ffmpeg',enabled:true});localStorage.setItem(SETUP_DRAFT_KEY,serializeSetup(s));mount();click('Restore saved draft');expect((screen.getByLabelText('FFmpeg (opt-in)') as HTMLInputElement).checked).toBe(true);expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();
 });
 it('failed defaults leave manual editing available without guessing',async()=>{
  nativeFixture();vi.mocked(invoke).mockRejectedValue('probe unavailable');mount();open();await screen.findByRole('alert');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('');expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('');change('Storage directory','/manual');change('Backend','cpu');expect((screen.getByRole('button',{name:'Prepare native plan'}) as HTMLButtonElement).disabled).toBe(false);
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
 it('serializes review clicks and locks edits until the native plan returns',async()=>{
  nativeFixture();const late=deferred<ReturnType<typeof plan>>();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:late.promise);
  mount();open();await screen.findByText('CPU fallback fixture');const button=screen.getByRole('button',{name:'Prepare native plan'});fireEvent.click(button);fireEvent.click(button);
  expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_plan')).toHaveLength(1);expect(screen.getByLabelText('Backend').matches(':disabled')).toBe(true);
  await act(async()=>late.resolve(plan()));expect(screen.getByLabelText('Backend').matches(':disabled')).toBe(false);
 });
 it('late defaults cannot change or unlock a running request',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async(command,args)=>command==='native_install_defaults'?late.promise:command==='native_install_plan'?plan((args as {request:NativeInstallRequest}).request):{state:'running',stepId:'python',logs:['running fixture'],error:null});
  mount();open();change('Storage directory','/manual/new');change('Backend','cpu');click('Prepare native plan');await screen.findByRole('button',{name:'Start install'});click('Start install');await screen.findByText('running fixture');
  await act(async()=>late.resolve({...defaults,storagePath:'/late',backend:'nvidia'}));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/manual/new');expect((screen.getByLabelText('Backend') as HTMLSelectElement).value).toBe('cpu');expect(screen.getByLabelText('Backend').matches(':disabled')).toBe(true);
 });
 it('shows exact hardware and Torch profile before authorization',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:{...plan(),hardware:{name:'GPU fixture',uuid:'GPU-fixture'},torch:{packages:['torch==fixture'],indexUrl:'https://index.fixture',cuda:'fixture'}});await ready();expect(screen.getByLabelText('Native hardware and exact runtime profile').textContent).toContain('GPU-fixture');expect(screen.getByLabelText('Native hardware and exact runtime profile').textContent).toContain('torch==fixture');
 });
 it('uses a native parent chooser without writing and preserves values on cancellation',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:null);mount();open();await screen.findByText('CPU fallback fixture');change('Storage directory','/manual/new');click('Choose parent folder…');await waitFor(()=>expect((screen.getByRole('button',{name:'Choose parent folder…'}) as HTMLButtonElement).disabled).toBe(false));expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/manual/new');expect(invoke).toHaveBeenCalledWith('native_pick_directory',{title:'Choose an existing parent folder'});
 });
 it('joins a native parent into a new target and lets the user edit it before review',async()=>{
  nativeFixture();vi.mocked(invoke).mockImplementation(async command=>command==='native_install_defaults'?defaults:'/selected');mount();open();await screen.findByText('CPU fallback fixture');click('Choose parent folder…');await waitFor(()=>expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/selected/deas-environment'));change('Storage directory','/selected/custom-new');expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/selected/custom-new');expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());
 });
 it('cancels only the native installation and shows returned status, not simulated progress',async()=>{
  nativeFixture();await ready();click('Start install');await screen.findByText('native fixture log');
  vi.mocked(invoke).mockImplementation(async command=>command==='native_install_cancel'?null:{state:'cancelled',stepId:null,logs:['native cancellation fixture'],error:null});click('Cancel installation');await screen.findByText('native cancellation fixture');expect(invoke).toHaveBeenCalledWith('native_install_cancel');expect(screen.getByRole('status').textContent).toBe('Cancelled');
 });
 it('restores the saved automatic selections without authorization or installation status',()=>{
  const first=mount();open();change('Storage directory','/saved/new');change('Backend','nvidia');fireEvent.click(screen.getByLabelText('FFmpeg (opt-in)'));change('ComfyUI Git ref','v0.3.50');click('Save local draft');first.unmount();mount();click('Restore saved draft');expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/saved/new');expect((screen.getByLabelText('FFmpeg (opt-in)') as HTMLInputElement).checked).toBe(true);expect((screen.getByLabelText('ComfyUI Git ref') as HTMLInputElement).value).toBe('v0.3.50');expect(screen.queryByRole('button',{name:'Start install'})).toBeNull();expect(invoke).not.toHaveBeenCalled();
 });
 it('keeps manual guided fallback with per-step confirmation',()=>{
  mount();open();click('Manual step-by-step');click('New app-owned install');expect(screen.queryByLabelText('Storage directory')).toBeNull();click('Confirm & continue');change('Storage directory','/new');click('Confirm & continue');click('Confirm & continue');click('CPU — explicit baseline');expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();click('Confirm & continue');expect(screen.getByLabelText('Exact local plan')).toBeTruthy();
 });
 it('keeps existing-backend inspection separate and explicitly read-only',()=>{
  const connect=vi.fn();mount(connect);open();click('Connect existing backend');change('Backend URL','http://127.0.0.1:8188');click('Confirm & continue');expect(connect).not.toHaveBeenCalled();click('Inspect existing backend');expect(connect).toHaveBeenCalledWith('http://127.0.0.1:8188');expect(invoke).not.toHaveBeenCalled();
 });
 it('discards defaults after unmount and reuses one request during StrictMode replay',async()=>{
  nativeFixture();const late=deferred<typeof defaults>();vi.mocked(invoke).mockImplementation(async()=>late.promise);
  const first=mount();open();first.unmount();await act(async()=>late.resolve(defaults));
  vi.mocked(invoke).mockResolvedValue(defaults);render(<StrictMode><I18nProvider><AiOSetup onConnectExisting={vi.fn()}/></I18nProvider></StrictMode>);open();await screen.findByText('CPU fallback fixture');expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==='native_install_defaults')).toHaveLength(2);
 });
});
