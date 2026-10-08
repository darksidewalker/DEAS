import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiOSetup from './AiOSetup';
import { I18nProvider } from '../../i18n/I18nProvider';
import { invoke, isTauri } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>false)}));
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(false);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const click=(name:RegExp)=>fireEvent.click(screen.getByRole('button',{name}));
const mount=()=>render(<I18nProvider><AiOSetup onConnectExisting={vi.fn()}/></I18nProvider>);
const confirm=()=>click(/^Confirm & continue$/);
function core(){click(/AiO installer/);click(/New app-owned install/);confirm();fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/data/DEAS'}});confirm();}
function review(){core();confirm();click(/^CPU/);confirm();}
describe('AiO capability planner',()=>{
 it('anchors one persistent confirmation footer to the selection workspace outside input forms',()=>{
  mount();click(/AiO installer/);
  const button=screen.getByRole('button',{name:'Confirm & continue'});
  expect(button.closest('.aio-confirm-rail')).not.toBeNull();
  expect(button.closest('.aio-detail')).toBeNull();
  const workspace=button.closest('.aio-decision-area')!;
  expect(workspace).not.toBeNull();
  expect(workspace.querySelector('.neural-graph')).not.toBeNull();
  expect(workspace.lastElementChild).toBe(button.closest('.aio-confirm-rail'));
  expect((button as HTMLButtonElement).disabled).toBe(true);
  click(/New app-owned install/);confirm();
  expect(screen.getByRole('button',{name:'Confirm & continue'})).toBe(button);
  expect(button.getAttribute('form')).toBe('aio-step-input-form');
  expect((button as HTMLButtonElement).form).toBe(screen.getByLabelText('Storage directory').closest('form'));
  expect(button.closest('form')).toBeNull();
  fireEvent.submit((button as HTMLButtonElement).form!);
  expect(screen.getByRole('alert').textContent).toContain('absolute');
  expect(screen.queryByRole('button',{name:/^Director/})).toBeNull();
  fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/data/DEAS'}});
  fireEvent.submit((button as HTMLButtonElement).form!);
  expect(screen.getByRole('button',{name:'Confirm & continue'})).toBe(button);
  expect(button.getAttribute('form')).toBeNull();
  confirm();click(/^CPU/);
  expect(screen.getByRole('button',{name:'Confirm & continue'})).toBe(button);
  expect(workspace.contains(screen.getByLabelText('ComfyUI Git ref'))).toBe(true);
  expect(workspace.lastElementChild).toBe(button.closest('.aio-confirm-rail'));
  expect(workspace.querySelector('.aio-detail')!.nextElementSibling).toBe(button.closest('.aio-confirm-rail'));
  fireEvent.click(screen.getByLabelText('FFmpeg (opt-in)'));
  expect(screen.getByRole('button',{name:'Confirm & continue'})).toBe(button);
  expect(screen.queryByLabelText('Exact local plan')).toBeNull();
  confirm();
  expect(JSON.parse(screen.getByLabelText('Exact local plan').textContent!).options.ffmpeg).toBe(true);
 });
 it('selects route without advancing and uses the same explicit confirmation at every decision',()=>{
  mount();click(/AiO installer/);click(/New app-owned install/);
  expect(screen.queryByLabelText('Storage directory')).toBeNull();confirm();
  fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/data/DEAS'}});confirm();
  click(/^Director/);expect(screen.queryByRole('button',{name:/^Prompt Forge/})).toBeNull();
  expect(screen.queryByRole('button',{name:/^NVIDIA/})).toBeNull();confirm();click(/^CPU/);
  expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();expect(screen.queryByLabelText('Exact local plan')).toBeNull();
  fireEvent.click(screen.getByLabelText('FFmpeg (opt-in)'));fireEvent.change(screen.getByLabelText('ComfyUI Git ref'),{target:{value:'v0.3.50'}});confirm();
  const plan=JSON.parse(screen.getByLabelText('Exact local plan').textContent!);
  expect(plan.features).toEqual(['director','forge','refmods','continuity']);expect(plan.options.ffmpeg).toBe(true);expect(plan.comfyRef).toBe('v0.3.50');
  expect(screen.getByText(/Native installer is available only/)).toBeTruthy();expect(invoke).not.toHaveBeenCalled();
 });
 it('uses the shared German confirmation label for route, storage, capabilities and architecture',()=>{
  localStorage.setItem('deas.locale.v1','de');mount();click(/AiO-Installer/);click(/Neue App-eigene Installation/);click(/^Bestätigen & weiter$/);
  fireEvent.change(screen.getByLabelText('Speicherverzeichnis'),{target:{value:'/data/DEAS'}});click(/^Bestätigen & weiter$/);click(/^Bestätigen & weiter$/);click(/^CPU/);
  expect(screen.getByLabelText('ComfyUI-Git-Referenz')).toBeTruthy();click(/^Bestätigen & weiter$/);expect(screen.getByLabelText('Exakter lokaler Plan')).toBeTruthy();
 });
 it('requires explicit immutable native plan confirmation before start',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async(command)=>command==='native_install_plan'?{id:'plan-1',request:{storagePath:'/data/DEAS',backend:'cpu',features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'},steps:[],warnings:[],unsupportedOptions:[],canExecute:true}:{state:'running',stepId:'python',logs:[],error:null});
  mount();review();expect(invoke).toHaveBeenCalledWith('native_detect_hardware',{});expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());click(/Prepare native plan/);
  await screen.findByLabelText(/I confirm this exact plan/);
  expect((screen.getByRole('button',{name:'Install confirmed plan'}) as HTMLButtonElement).disabled).toBe(true);
  expect(invoke).toHaveBeenCalledWith('native_install_plan',{request:{storagePath:'/data/DEAS',backend:'cpu',features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'}});
  fireEvent.click(screen.getByLabelText(/I confirm this exact plan/));click(/Install confirmed plan/);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_install_start',{planId:'plan-1',confirmed:true}));
 });
 it('shows native hardware and exact framework identities before consent',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue({id:'profile',request:{},steps:[],warnings:[],unsupportedOptions:[],canExecute:true,hardware:{vendor:'NVIDIA',name:'RTX fixture',uuid:'GPU-fixture',driverVersion:'test',computeCapability:'12.0'},torch:{packages:['torch==2.14.1','torchvision==0.29.1','torchaudio==2.11.0'],indexUrl:'https://download.pytorch.org/whl/cu130',cuda:'13.0'}});
  mount();review();click(/Prepare native plan/);
  const profile=await screen.findByLabelText('Native hardware and exact runtime profile');
  expect(profile.textContent).toContain('GPU-fixture');
  expect(profile.textContent).toContain('torch==2.14.1');
  expect((screen.getByRole('button',{name:'Install confirmed plan'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('blocks unsupported plans and shows original technical detail',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue({id:'blocked',request:{},steps:[],warnings:['warning detail'],unsupportedOptions:['sage'],canExecute:false});
  mount();review();click(/Prepare native plan/);await screen.findByText('sage');
  expect((screen.getByRole('button',{name:'Install confirmed plan'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('warning detail')).toBeTruthy();expect(invoke).toHaveBeenCalledTimes(2);
 });
 it('edits invalidate a prepared plan and consent',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue({id:'plan',request:{},steps:[],warnings:[],unsupportedOptions:[],canExecute:true});
  mount();review();click(/Prepare native plan/);await screen.findByLabelText(/I confirm this exact plan/);
  click(/^Choose optional capabilities/);click(/^Director/);expect(screen.queryByLabelText(/I confirm this exact plan/)).toBeNull();
 });
 it('renders real status logs and sends narrow cancellation without claiming readiness',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  let cancelled=false;
  vi.mocked(invoke).mockImplementation(async(command)=>{
   if(command==='native_install_plan')return {id:'run',request:{},steps:[],warnings:[],unsupportedOptions:[],canExecute:true};
   if(command==='native_install_cancel')cancelled=true;
   return {state:cancelled?'cancelled':'running',stepId:'python',logs:['original runtime log'],error:null};
  });
  mount();review();click(/Prepare native plan/);await screen.findByLabelText(/I confirm this exact plan/);
  fireEvent.click(screen.getByLabelText(/I confirm this exact plan/));click(/Install confirmed plan/);
  await screen.findByText('original runtime log');
  expect((screen.getByRole('button',{name:/^Choose optional capabilities/}) as HTMLButtonElement).disabled).toBe(true);
  click(/Cancel installation/);await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('Cancelled'));
  expect(invoke).toHaveBeenCalledWith('native_install_cancel');
  expect(screen.queryByText(/Installation succeeded/)).toBeNull();
 });
 it('keeps native exception detail original under a translated heading',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockImplementation(async(command)=>{if(command==='native_detect_hardware')return {backend:null};throw 'target already exists: /data/DEAS';});
  mount();review();click(/Prepare native plan/);
  expect((await screen.findByRole('alert')).textContent).toBe('Technical error: target already exists: /data/DEAS');
  expect(screen.queryByRole('button',{name:'Install confirmed plan'})).toBeNull();
 });
 it('hands existing address off only after explicit action',()=>{
  const connect=vi.fn();render(<I18nProvider><AiOSetup onConnectExisting={connect}/></I18nProvider>);
  click(/AiO installer/);click(/Connect existing backend/);confirm();fireEvent.change(screen.getByLabelText('Backend URL'),{target:{value:'http://127.0.0.1:8188'}});confirm();
  expect(connect).not.toHaveBeenCalled();click(/Inspect existing backend/);expect(connect).toHaveBeenCalledWith('http://127.0.0.1:8188');expect(invoke).not.toHaveBeenCalled();
 });
});

describe('native hardware detection',()=>{
 const delayed=()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  let resolve!:(result:{backend:'nvidia';warnings?:string[]})=>void;
  const detection=new Promise(r=>{resolve=r;});
  vi.mocked(invoke).mockImplementation(async command=>command==='native_detect_hardware'?detection:{id:'fixture-plan',request:{backend:'cpu'},steps:[],warnings:[],unsupportedOptions:[],canExecute:true});
  return resolve;
 };
 it('late detection retains a user backend override and prepared consent',async()=>{
  const resolve=delayed();mount();review();click(/Prepare native plan/);
  await screen.findByLabelText(/I confirm this exact plan/);fireEvent.click(screen.getByLabelText(/I confirm this exact plan/));
  resolve({backend:'nvidia'});await screen.findByText('NVIDIA detected');
  expect(screen.getByLabelText('Exact local plan').textContent).toContain('"backend": "cpu"');
  expect((screen.getByLabelText(/I confirm this exact plan/) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('button',{name:'Install confirmed plan'}) as HTMLButtonElement).disabled).toBe(false);
  click(/^Choose backend/);click(/^AMD/);
  expect(screen.queryByLabelText(/I confirm this exact plan/)).toBeNull();
 });
 it('lets the user override a detected prefill without automatically restoring it',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue({backend:'nvidia'});
  mount();await screen.findByText('NVIDIA detected');core();confirm();
  await waitFor(()=>expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('true'));click(/^CPU/);confirm();
  expect(screen.getByLabelText('Exact local plan').textContent).toContain('"backend": "cpu"');
  click(/^Choose storage/);fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/data/other'}});confirm();confirm();
  expect(screen.queryByLabelText('Exact local plan')).toBeNull();
  expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('false');
 });
 it('late detection never switches an existing-backend route or creates an installed feature',async()=>{
  const resolve=delayed();mount();core();click(/^Choose your setup/);click(/Connect existing backend/);confirm();
  resolve({backend:'nvidia'});await screen.findByText('NVIDIA detected');
  expect(screen.getByLabelText('Backend URL')).toBeTruthy();
  expect(screen.queryByLabelText('Exact local plan')).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
 });
 it('preserves a restored chosen backend when detection resolves late',async()=>{
  const resolve=delayed();const first=mount();review();click(/Save local draft/);first.unmount();
  mount();click(/Restore saved draft/);resolve({backend:'nvidia'});await screen.findByText('NVIDIA detected');
  expect(screen.getByLabelText('Exact local plan').textContent).toContain('"backend": "cpu"');
 });
 it('ignores results from an unmounted setup rather than selecting in a later mount',async()=>{
  const oldResolve=delayed();const first=mount();first.unmount();
  const newResolve=delayed();mount();core();confirm();
  oldResolve({backend:'nvidia'});await Promise.resolve();
  expect(screen.queryByText('NVIDIA detected')).toBeNull();
  expect(screen.queryByLabelText('Exact local plan')).toBeNull();
  newResolve({backend:'nvidia'});await screen.findByText('NVIDIA detected');await waitFor(()=>expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('true'));confirm();
  expect(screen.getByLabelText('Exact local plan').textContent).toContain('"backend": "nvidia"');
 });
 it('late detection cannot alter a running request or unlock its choices',async()=>{
  const resolve=delayed();mount();review();click(/Prepare native plan/);await screen.findByLabelText(/I confirm this exact plan/);
  vi.mocked(invoke).mockResolvedValue({state:'running',stepId:'python',logs:['running fixture'],error:null});
  fireEvent.click(screen.getByLabelText(/I confirm this exact plan/));click(/Install confirmed plan/);await screen.findByText('running fixture');
  resolve({backend:'nvidia'});await screen.findByText('NVIDIA detected');
  expect(screen.getByLabelText('Exact local plan').textContent).toContain('"backend": "cpu"');
  expect((screen.getByRole('button',{name:/^Choose backend/}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('reopening and repeating an unchanged choice retains plan consent; actual edits clear it',async()=>{
  delayed();mount();review();click(/Prepare native plan/);await screen.findByLabelText(/I confirm this exact plan/);
  fireEvent.click(screen.getByLabelText(/I confirm this exact plan/));click(/^Choose your setup/);click(/New app-owned install/);
  expect((screen.getByLabelText(/I confirm this exact plan/) as HTMLInputElement).checked).toBe(true);
  click(/^Choose optional capabilities/);click(/^Director/);
  expect(screen.queryByLabelText(/I confirm this exact plan/)).toBeNull();
 });
 it('reuses the read-only request during StrictMode effect replay',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue({backend:'nvidia'});
  render(<StrictMode><I18nProvider><AiOSetup onConnectExisting={vi.fn()}/></I18nProvider></StrictMode>);
  await screen.findByText('NVIDIA detected');expect(invoke).toHaveBeenCalledTimes(1);
 });
 it('does not guess a backend after failed discovery and leaves manual choices available',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockRejectedValue('probe unavailable');mount();
  expect((await screen.findByRole('alert')).textContent).toBe('Hardware detection unavailable: probe unavailable');
  core();confirm();
  expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByLabelText('Exact local plan')).toBeNull();
 });
 it('prefilled hardware does not bypass unsupported native plan gates',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async command=>command==='native_detect_hardware'?{backend:'nvidia'}:{id:'blocked',request:{backend:'nvidia'},steps:[],warnings:[],unsupportedOptions:['platform unsupported'],canExecute:false});
  mount();await screen.findByText('NVIDIA detected');core();confirm();await waitFor(()=>expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('true'));confirm();click(/Prepare native plan/);
  await screen.findByText('platform unsupported');
  expect((screen.getByLabelText(/I confirm this exact plan/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'Install confirmed plan'}) as HTMLButtonElement).disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalledWith('native_install_start',expect.anything());
 });
 it('queries read-only detection once and prefills NVIDIA without claiming installation or support',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue({backend:'nvidia',hardware:{name:'fixture GPU'},warnings:['compatibility remains unverified']});
  mount();await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_detect_hardware',{}));
  core();confirm();
  await waitFor(()=>expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('true'));
  expect(screen.queryByLabelText('Exact local plan')).toBeNull();expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();confirm();
  expect(screen.getByLabelText('Exact local plan').textContent).toContain('"backend": "nvidia"');
  expect(screen.getByText('NOT INSTALLED')).toBeTruthy();
  click(/^Choose backend/);
  expect(screen.getByRole('button',{name:/^NVIDIA/}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button',{name:/^NVIDIA/}).querySelector('[data-flag="suggested"]')?.textContent).toBe('Suggested');
  expect(screen.getByRole('button',{name:/^NVIDIA/}).querySelector('[data-flag="detected"]')?.textContent).toBe('Detected');
  expect(screen.getByText('NVIDIA detected')).toBeTruthy();
  expect(screen.getByText('compatibility remains unverified')).toBeTruthy();
  expect(invoke).toHaveBeenCalledTimes(1);
 });
});

describe('native directory selection',()=>{
 it('saves a selected native target before confirmation and restores it without skipping storage',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockImplementation(async command=>command==='native_detect_hardware'?{backend:null}:'/data');
  const first=mount();click(/AiO installer/);click(/New app-owned install/);confirm();click(/Choose parent folder/);
  await waitFor(()=>expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/data/deas-environment'));
  click(/Save local draft/);first.unmount();mount();click(/Restore saved draft/);
  expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/data/deas-environment');expect(screen.queryByRole('button',{name:/^Director/})).toBeNull();
 });
 it('does not allow history to bypass pending backend options and restores unchecked step confirmation',()=>{
  const first=mount();review();click(/^Choose backend/);fireEvent.click(screen.getByLabelText('FFmpeg (opt-in)'));
  click(/Save local draft/);click(/^Choose your setup/);click(/New app-owned install/);confirm();confirm();confirm();
  expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();expect(screen.queryByLabelText('Exact local plan')).toBeNull();
  first.unmount();mount();click(/Restore saved draft/);expect((screen.getByLabelText('FFmpeg (opt-in)') as HTMLInputElement).checked).toBe(true);expect(screen.queryByLabelText('Exact local plan')).toBeNull();confirm();expect(screen.getByLabelText('Exact local plan')).toBeTruthy();
 });
 function storage(){mount();click(/AiO installer/);click(/New app-owned install/);confirm();}
 it('is truthfully unavailable in browser while allowing an absolute manual target',()=>{
  storage();expect((screen.getByRole('button',{name:/Choose parent folder/}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Browser preview cannot browse native folders/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/manual/new'}});confirm();
  expect(invoke).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:/^Confirm & continue$/})).toBeTruthy();
 });
 it('chooses an existing parent, fills a named new child, supports edits and never starts installation',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue('C:\\Models');storage();click(/Choose parent folder/);
  await waitFor(()=>expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('C:\\Models\\deas-environment'));
  expect(invoke).toHaveBeenCalledWith('native_pick_directory',{title:'Choose an existing parent folder'});
  fireEvent.change(screen.getByLabelText('New subfolder name'),{target:{value:'my-environment'}});
  expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('C:\\Models\\my-environment');
  confirm();expect(invoke).toHaveBeenCalledTimes(2);
 });
 it('cancellation preserves the manual draft and a pending picker cannot open twice',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);let resolve:(v:null)=>void=()=>{};
  vi.mocked(invoke).mockImplementation(()=>new Promise(r=>{resolve=r;}));storage();
  fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/keep/draft'}});
  click(/Choose parent folder/);click(/Please wait/);expect(invoke).toHaveBeenCalledTimes(2);resolve(null);
  await waitFor(()=>expect((screen.getByRole('button',{name:/Choose parent folder/}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/keep/draft');
 });
 it('shows a translated heading with original native picker errors and preserves the draft',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockImplementation(async(command)=>{if(command==='native_detect_hardware')return {backend:null};throw 'portal unavailable';});storage();
  fireEvent.change(screen.getByLabelText('Storage directory'),{target:{value:'/keep/new'}});click(/Choose parent folder/);
  expect((await screen.findByRole('alert')).textContent).toBe('Technical error: portal unavailable');
  expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/keep/new');
 });
 it('rejects unsafe child names and keeps a previous native selection on cancel',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValueOnce({backend:null}).mockResolvedValueOnce('/data').mockResolvedValueOnce(null);storage();click(/Choose parent folder/);
  await screen.findByLabelText('New subfolder name');
  fireEvent.change(screen.getByLabelText('New subfolder name'),{target:{value:'../escape'}});confirm();
  expect(screen.getByRole('alert').textContent).toContain('safe single new folder name');
  expect(screen.queryByRole('button',{name:/^Director/})).toBeNull();
  fireEvent.change(screen.getByLabelText('New subfolder name'),{target:{value:'safe-new'}});click(/Choose parent folder/);
  await waitFor(()=>expect((screen.getByRole('button',{name:/Choose parent folder/}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Storage directory') as HTMLInputElement).value).toBe('/data/safe-new');
  expect((screen.getByLabelText('New subfolder name') as HTMLInputElement).value).toBe('safe-new');
 });
 it('technical disclosures start closed while exact native choices and consent remain visible',async()=>{
  vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue({id:'plan',request:{storagePath:'/data/DEAS',backend:'cpu',features:[],options:{sage:false,radial:false,flash:false,ffmpeg:false},comfyRef:'master'},steps:[],warnings:[],unsupportedOptions:[],canExecute:true});
  mount();review();expect(screen.getByText('Exact local plan',{selector:'summary'}).closest('details')?.open).toBe(false);click(/Prepare native plan/);
  await screen.findByLabelText(/I confirm this exact plan/);
  expect(screen.getByLabelText('Exact native request').textContent).toContain('/data/DEAS');
  expect(screen.getByText('Technical request JSON',{selector:'summary'}).closest('details')?.open).toBe(false);
  expect(screen.getByText('Planned downloads and installation steps',{selector:'summary'}).closest('details')?.open).toBe(false);
 });
 it('reopens a saved route without erasing the downstream path until a different choice is made',()=>{
  mount();review();click(/^Choose your setup/);
  expect(screen.getByRole('button',{name:/^Choose storage/})).toBeTruthy();
  click(/New app-owned install/);confirm();expect(screen.getByLabelText('Storage directory')).toBeTruthy();confirm();expect(screen.getByRole('button',{name:/^Director/})).toBeTruthy();confirm();expect(screen.getByLabelText('ComfyUI Git ref')).toBeTruthy();confirm();expect(screen.getByRole('button',{name:/Prepare native plan/})).toBeTruthy();
  click(/^Choose your setup/);click(/Connect existing backend/);confirm();
  expect(screen.queryByRole('button',{name:/^Choose storage/})).toBeNull();expect(screen.getByLabelText('Backend URL')).toBeTruthy();
 });
});
