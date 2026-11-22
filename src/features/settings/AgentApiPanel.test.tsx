import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { AgentApiPanel } from './AgentApiPanel';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}));

const secret='super-secret-standing-key';
const settings=()=>({enabled:false,port:8790,standingKey:secret,originAllowlist:['http://localhost:3000'],exists:true,sourcePath:'C:/appx/deas-agent-settings.json'});
const guard=()=>({unloadCommand:'strata runtime stop',restoreCommand:'strata runtime start',readyUrl:'http://127.0.0.1:18500/health',autoCycleVram:true,freeOnQueueEnd:true,watchdog:{windowSec:90},configured:true,exists:true,sourcePath:'C:/appx/deas-agent-guard.json'});
const defaults=()=>({configured:true,sourcePath:'C:/appx/deas-agent-defaults.json',sheet:{version:1,global:{steps:30},families:{anima:{cfg:4.5}},combos:{'anima:t2i':{steps:25,seedMode:'fixed'}}}} as {configured:boolean;sourcePath:string;sheet:{version:number;global:Record<string,unknown>;families:Record<string,Record<string,unknown>>;combos:Record<string,Record<string,unknown>>}});
const fixture:(command:string,args?:unknown)=>Promise<unknown>=async(command,args)=>{
 const a=args as {patch?:Record<string,unknown>;confirm?:boolean;key?:string;dials?:Record<string,unknown>}|undefined;
 if(command==='native_agent_settings_read')return settings();
 if(command==='native_agent_guard_read')return guard();
 if(command==='native_agent_defaults_read')return defaults();
 if(command==='native_agent_settings_write'){const before=settings(),after={...before,...a?.patch};
  if(a?.confirm!==true)return {applied:false,changes:Object.keys(a?.patch??{}),before,after};
  return {applied:true,changes:Object.keys(a?.patch??{}),settings:after};}
 if(command==='native_agent_guard_write'){const before=guard(),after={...before,...a?.patch};
  if(a?.confirm!==true)return {applied:false,changes:Object.keys(a?.patch??{}),before,after};
  return {applied:true,changes:Object.keys(a?.patch??{}),guard:after};}
 if(command==='native_agent_defaults_write'){const sheet=defaults().sheet,before=sheet.combos[a!.key!]??{},after={...before,...a!.dials};
  for(const [k,v] of Object.entries(after))if(v===null)delete after[k];
  const merged={...sheet,combos:{...sheet.combos,[a!.key!]:after}};
  if(a?.confirm!==true)return {applied:false,key:a!.key,changes:Object.keys(a?.dials??{}),before,after,configurable:merged};
  return {applied:true,key:a!.key,changes:Object.keys(a?.dials??{}),after,configurable:merged};}
 throw Error('Unexpected fixture IPC '+command);
};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockImplementation(fixture as never);});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const mount=()=>render(<I18nProvider><AgentApiPanel/></I18nProvider>);
const loaded=async()=>{await screen.findByRole('checkbox',{name:'Enable the agent API'});};
const click=(selector:string)=>fireEvent.click(document.querySelector(selector) as HTMLElement);
const confirmTrue=(command:string)=>vi.mocked(invoke).mock.calls.some(([c,a])=>c===command&&(a as {confirm?:boolean}).confirm===true);

it('renders the loading posture first, then the loaded reads',async()=>{
 let resolve!:() => void;const gate=new Promise<void>(r=>{resolve=r;});
 vi.mocked(invoke).mockImplementation((async(command:string)=>{await gate;return fixture(command);}) as never);
 mount();
 expect(screen.getByText('Reading agent settings…')).toBeTruthy();
 await act(async()=>{resolve();});
 await loaded();
 for(const command of ['native_agent_settings_read','native_agent_guard_read','native_agent_defaults_read'])expect(invoke).toHaveBeenCalledWith(command);
});

it('runs the confirm wall in two steps: preview first, nothing applies until the explicit confirm',async()=>{
 mount();await loaded();
 fireEvent.change(screen.getByLabelText('Port'),{target:{value:'9911'}});
 const apply=document.querySelector('[data-agentapi-apply="settings"]') as HTMLButtonElement;
 expect(apply.disabled).toBe(false);
 fireEvent.click(apply);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_settings_write',{patch:{port:9911},confirm:false}));
 expect(confirmTrue('native_agent_settings_write')).toBe(false);
 await screen.findByText(/Confirm these changes/);
 expect(screen.getByText(/8790 → 9911/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Confirm apply'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_settings_write',{patch:{port:9911},confirm:true}));
 await screen.findByText('Applied: port');
 expect(screen.queryByText('Confirm these changes')).toBeNull();
});

it('cancelling the preview applies nothing',async()=>{
 mount();await loaded();
 fireEvent.change(screen.getByLabelText('Port'),{target:{value:'9911'}});
 click('[data-agentapi-apply="settings"]');
 await screen.findByText(/Confirm these changes/);
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(screen.queryByText('Confirm these changes')).toBeNull();
 expect(confirmTrue('native_agent_settings_write')).toBe(false);
});

it('masks the standing key until reveal, and masks it in the preview diff too',async()=>{
 mount();await loaded();
 expect(document.body.textContent).not.toContain(secret);
 const box=screen.getByLabelText('Standing key') as HTMLInputElement;
 expect(box.type).toBe('password');
 fireEvent.click(screen.getByRole('button',{name:'Reveal'}));
 expect((screen.getByLabelText('Standing key') as HTMLInputElement).type).toBe('text');
 expect((screen.getByLabelText('Standing key') as HTMLInputElement).value).toBe(secret);
 fireEvent.change(box,{target:{value:'rotated-key'}});
 click('[data-agentapi-apply="settings"]');
 await screen.findByText(/Confirm these changes/);
 const row=document.querySelector('[data-agentapi-change="standingKey"]') as HTMLElement;
 expect(row.textContent).toContain('"••••••"');
 expect(row.textContent).not.toContain('rotated-key');
});

it('the guard section mirrors the snapshot: commands, switches and the resolved watchdog numbers',async()=>{
 mount();await loaded();
 expect((screen.getByLabelText('Unload command') as HTMLTextAreaElement).value).toBe('strata runtime stop');
 expect((screen.getByLabelText('Restore command') as HTMLTextAreaElement).value).toBe('strata runtime start');
 expect((screen.getByLabelText('Ready URL') as HTMLTextAreaElement).value).toBe('http://127.0.0.1:18500/health');
 expect((screen.getByRole('checkbox',{name:'Auto-cycle VRAM'}) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByRole('checkbox',{name:'Free VRAM at queue end'}) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText('Window (seconds, 30–1800)') as HTMLInputElement).value).toBe('90');
 expect((screen.getByLabelText('Utilization median (%)') as HTMLInputElement).value).toBe('20');
 expect((screen.getByLabelText('Grace (seconds)') as HTMLInputElement).value).toBe('120');
 expect((screen.getByRole('checkbox',{name:'Guard only API-owned runs'}) as HTMLInputElement).checked).toBe(true);
});

it('a mid-cycle guard refusal surfaces honestly in the alert and the status strip, and nothing lands',async()=>{
 vi.mocked(invoke).mockImplementation((async(command:string,args?:unknown)=>{
  if(command==='native_agent_guard_write'){
   if((args as {confirm?:boolean}).confirm===true)return Promise.reject("a VRAM cycle is live (phase 'drain', cycle 'c-1'); guard writes are refused until the cycle answers idle");
   return {applied:false,changes:['readyUrl'],before:guard(),after:{...guard(),readyUrl:'http://127.0.0.1:9/health'}};
  }
  return fixture(command,args);
}) as never);
 mount();await loaded();
 fireEvent.change(screen.getByLabelText('Ready URL'),{target:{value:'http://127.0.0.1:9/health'}});
 click('[data-agentapi-apply="guard"]');
 await screen.findByText(/Confirm these changes/);
 fireEvent.click(screen.getByRole('button',{name:'Confirm apply'}));
 const alert=await screen.findByRole('alert');
 expect(alert.textContent).toContain("a VRAM cycle is live (phase 'drain', cycle 'c-1')");
 expect(await screen.findByText(/Last refusal: a VRAM cycle is live/)).toBeTruthy();
 expect(confirmTrue('native_agent_guard_write')).toBe(true);
 expect((screen.getByLabelText('Ready URL') as HTMLTextAreaElement).value).toBe('http://127.0.0.1:9/health'); // draft kept: the operator repairs, nothing half-landed
});

it('the mode selector mirrors the native 13-word MODES vocabulary in order (defaults.rs mirror pin)',async()=>{
 mount();await loaded();
 // Byte-mirror of src-tauri/src/agent_api/defaults.rs MODES: [&str; 13]; if the native vocabulary moves, this pin moves with it.
 const expected=['t2i','i2i','inpaint','refine','upscale','refmod','ref2va','video','music','t2v','i2v','v2v','t2m'];
 const options=[...(document.querySelector('[data-agentapi-mode]') as HTMLSelectElement).options];
 expect(options.map(o=>o.value)).toEqual(expected);
 // Family:mode combos for the grown words render through the same closed vocabulary: pick a video-mode combo and save one dial.
 fireEvent.change(screen.getByPlaceholderText('Family'),{target:{value:'h3'}});
 fireEvent.change(document.querySelector('[data-agentapi-mode]') as HTMLSelectElement,{target:{value:'t2v'}});
 fireEvent.click(screen.getByRole('button',{name:'Add combo'}));
 await screen.findByText('h3:t2v');
 fireEvent.change(document.querySelector('[data-agentapi-add-dial="h3:t2v"]') as HTMLSelectElement,{target:{value:'steps'}});
 fireEvent.change(screen.getByLabelText('steps for h3:t2v'),{target:{value:'30'}});
 click('[data-agentapi-combo-save="h3:t2v"]');
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_defaults_write',{key:'h3:t2v',dials:{steps:30},confirm:false}));
});

it('the defaults editor adds a combo and calls write with the right patch arms',async()=>{
 mount();await loaded();
 await screen.findByText('anima:t2i');
 fireEvent.change(screen.getByPlaceholderText('Family'),{target:{value:'flux2'}});
 fireEvent.change(document.querySelector('[data-agentapi-mode]') as HTMLSelectElement,{target:{value:'i2i'}});
 fireEvent.click(screen.getByRole('button',{name:'Add combo'}));
 await screen.findByText('flux2:i2i');
 fireEvent.change(document.querySelector('[data-agentapi-add-dial="flux2:i2i"]') as HTMLSelectElement,{target:{value:'steps'}});
 fireEvent.change(screen.getByLabelText('steps for flux2:i2i'),{target:{value:'42'}});
 click('[data-agentapi-combo-save="flux2:i2i"]');
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_defaults_write',{key:'flux2:i2i',dials:{steps:42},confirm:false}));
 await screen.findByText(/Confirm these changes/);
 fireEvent.click(screen.getByRole('button',{name:'Confirm apply'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_defaults_write',{key:'flux2:i2i',dials:{steps:42},confirm:true}));
 await waitFor(()=>expect((screen.getByLabelText('steps for flux2:i2i') as HTMLInputElement).value).toBe('42'));
});

it('the defaults editor removes one dial with three-state null arms and clears an entry with all-null arms',async()=>{
 mount();await loaded();
 await screen.findByText('anima:t2i');
 click('[data-agentapi-dial-remove="anima:t2i:seedMode"]');
 click('[data-agentapi-combo-save="anima:t2i"]');
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_defaults_write',{key:'anima:t2i',dials:{seedMode:null},confirm:false}));
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 click('[data-agentapi-combo-clear="anima:t2i"]');
 await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('native_agent_defaults_write',{key:'anima:t2i',dials:{steps:null,seedMode:null},confirm:false}));
});

it('the status strip states the configured posture from the reads alone',async()=>{
 mount();await loaded();
 await waitFor(()=>expect(document.querySelector('[data-agentapi-status]')?.textContent).toContain('8790'));
 const line=document.querySelector('[data-agentapi-status]')!.textContent!;
 expect(line).toContain('disabled');expect(line).toContain('set');expect(line).toContain('configured');expect(line).toContain('1 combo');
 expect(document.body.textContent).not.toContain('sourcePath'); // reads land as posture only, not raw operator paths
});

// M16 FIX-B: the guard card's three cap fields ride the same confirm wall as the watchdog block.
it('the cap fields start blank with the shipped defaults as placeholders, and a typed bound lands a caps patch',async()=>{
 mount();await loaded();
 const upload=screen.getByLabelText('One upload (MiB, 1–8192)') as HTMLInputElement;
 expect(upload.value).toBe('');expect(upload.placeholder).toBe('50');
 expect((screen.getByLabelText('One batch budget (MiB, 1–8192)') as HTMLInputElement).placeholder).toBe('100');
 expect((screen.getByLabelText('One byte-door read (MiB, 1–8192)') as HTMLInputElement).placeholder).toBe('500');
 fireEvent.change(upload,{target:{value:'75'}});
 click('[data-agentapi-apply="guard"]');
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_guard_write',{patch:{caps:{uploadSingleMiB:75}},confirm:false}));
});
it('out-of-bounds and fractional cap numbers are refused client-side: no patch, apply stays disabled',async()=>{
 mount();await loaded();
 const upload=screen.getByLabelText('One upload (MiB, 1–8192)');
 fireEvent.change(upload,{target:{value:'9000'}}); // over the 8192 ceiling
 fireEvent.change(upload,{target:{value:'0'}});    // under the 1 floor
 fireEvent.change(upload,{target:{value:'1.5'}});  // not a whole MiB number
 expect((document.querySelector('[data-agentapi-apply="guard"]') as HTMLButtonElement).disabled).toBe(true);
 expect(invoke).not.toHaveBeenCalledWith('native_agent_guard_write',expect.anything());
});
it('a set cap clears back to the shipped default with one three-state null arm via the Remove chip',async()=>{
 vi.mocked(invoke).mockImplementation((async(command:string,args?:unknown)=>
  command==='native_agent_guard_read'?{...guard(),caps:{uploadSingleMiB:75}}:fixture(command,args)) as never);
 mount();await loaded();
 expect((screen.getByLabelText('One upload (MiB, 1–8192)') as HTMLInputElement).value).toBe('75');
 click('[data-agentapi-cap-remove="uploadSingleMiB"]');
 expect((screen.getByLabelText('One upload (MiB, 1–8192)') as HTMLInputElement).value).toBe('');
 click('[data-agentapi-apply="guard"]');
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('native_agent_guard_write',{patch:{caps:null},confirm:false}));
});
