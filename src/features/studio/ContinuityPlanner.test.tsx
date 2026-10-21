import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ContinuityPlanner } from './ContinuityPlanner';
import type { ContinuityPlan } from '../../lib/continuity';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const plan:ContinuityPlan={session:'kept-session',outputMode:'segment',steps:[{id:'one',seconds:5,action:''}]};
const mount=(value=plan,running=false)=>{
 localStorage.setItem('deas.locale.v1','en');const onChange=vi.fn();
 render(<I18nProvider><ContinuityPlanner plan={value} running={running} disabled={false} onChange={onChange} onRun={vi.fn()}/></I18nProvider>);
 return onChange;
};
test('named session applies explicitly and keeps authored steps without old clip or job links',()=>{
 const value:ContinuityPlan={...plan,source:{clipId:'old-source',endpoint:'http://127.0.0.1:7801'},overlapFrames:56,steps:[{...plan.steps[0],clipId:'old-clip',jobId:'old-job'}]};
 const onChange=mount(value);
 const input=screen.getByRole('textbox',{name:'Session name'});
 fireEvent.change(input,{target:{value:'Named_session-1'}});expect(onChange).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Use session'}));
 expect(onChange.mock.lastCall![0]).toEqual({...plan,session:'Named_session-1',overlapFrames:56});
 expect(value.steps[0].clipId).toBe('old-clip');expect(value.steps[0].jobId).toBe('old-job');
});

test('invalid session drafts and forced submits cannot mutate the plan',()=>{
 const onChange=mount();const input=screen.getByRole('textbox',{name:'Session name'});
 const apply=screen.getByRole('button',{name:'Use session'}) as HTMLButtonElement;
 expect(apply.disabled).toBe(true);
 for(const name of ['_imports','','a/b','a b','x'.repeat(81)]){
  fireEvent.change(input,{target:{value:name}});expect(input.getAttribute('aria-invalid')).toBe('true');expect(apply.disabled).toBe(true);
  fireEvent.submit(input.closest('form')!);
 }
 expect(onChange).not.toHaveBeenCalled();
});
test('running prevents session changes even after a forced draft and submit',()=>{
 const onChange=mount(plan,true);const input=screen.getByRole('textbox',{name:'Session name'}) as HTMLInputElement;
 expect(input.disabled).toBe(true);fireEvent.change(input,{target:{value:'other'}});fireEvent.submit(input.closest('form')!);
 expect(onChange).not.toHaveBeenCalled();
});
test('external session changes resynchronize the unsubmitted draft',()=>{
 localStorage.setItem('deas.locale.v1','en');const onChange=vi.fn();
 const view=render(<I18nProvider><ContinuityPlanner plan={plan} running={false} disabled={false} onChange={onChange} onRun={vi.fn()}/></I18nProvider>);
 const input=screen.getByRole('textbox',{name:'Session name'}) as HTMLInputElement;
 fireEvent.change(input,{target:{value:'discarded-draft'}});
 view.rerender(<I18nProvider><ContinuityPlanner plan={{...plan,session:'external-session'}} running={false} disabled={false} onChange={onChange} onRun={vi.fn()}/></I18nProvider>);
 expect(input.value).toBe('external-session');expect(onChange).not.toHaveBeenCalled();
});

test('selected source enables the first action but a different endpoint blocks Run',()=>{
 mount({...plan,source:{clipId:'root',endpoint:'http://127.0.0.1:7801'}});
 expect((screen.getByRole('textbox',{name:'Next action'}) as HTMLTextAreaElement).disabled).toBe(false);
 expect((screen.getByRole('button',{name:'Run next'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('Backend changed');
});

test.each(['checkpoint','video'])('Next action Forge applies only to its own step after review (%s)',async(kind)=>{
 const clipId=kind==='video'?'a'.repeat(64):'root-1';
 localStorage.setItem('deas.locale.v1','en');
 const calls:{route:string;body:Record<string,unknown>}[]=[];
 vi.mocked(invoke).mockImplementation(async(_command,args)=>{
  if(_command==='native_llm_read')return {provider:'ollama',baseUrl:'http://localhost:11434'};
  const call=args as {route:string;body:Record<string,unknown>};calls.push(call);
  if(call.route==='models')return {models:[{id:'vision',label:'Local vision'}],errors:{},creativity:['Grounded'],shot_counts:['Auto'],default_shots:'Auto'};
  if(call.route==='h3')return {simple_prompt:'The traveller turns.',warnings:[]};
  throw Error('Unexpected request');
 });
 const value:ContinuityPlan={...plan,overlapFrames:39,source:{clipId,endpoint:'http://127.0.0.1:7801',...(kind==='video'?{kind:'video' as const}:{})}};
 const onChange=vi.fn();
 render(<I18nProvider><ContinuityPlanner endpoint="http://127.0.0.1:7801" root="/env" forgeContext={{mode:'T2VA',duration:10,canvas:{width:768,height:512},references:[],easy:false}} plan={value} running={false} disabled={false} onChange={onChange} onRun={vi.fn()}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 const pop=within(screen.getByRole('dialog',{name:'Prompt Forge'}));
 fireEvent.change(pop.getByRole('textbox',{name:'Next action'}),{target:{value:'turn around'}});
 await pop.findByRole('option',{name:'Local vision'});
 fireEvent.click(pop.getByRole('button',{name:'Write'}));
 await pop.findByRole('textbox',{name:'Result'});
 expect(onChange).not.toHaveBeenCalled();
 expect(calls.find(c=>c.route==='h3')!.body).toMatchObject({duration:5,references:[],easy:false,continuity:{source_kind:kind,session:'kept-session',clip_id:clipId,overlap_frames:39,current_prompt:'',use_references:false}});
 fireEvent.click(pop.getByRole('button',{name:'Apply'}));
 expect(onChange).toHaveBeenLastCalledWith({...value,steps:[{...value.steps[0],action:'The traveller turns.'}]});
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'Prompt Forge'}));
});

test('Forge writing locks the continuity plan and Cancel releases it without applying',async()=>{
 localStorage.setItem('deas.locale.v1','en');let finish!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async(_command,args)=>{
  if(_command==='native_llm_read')return {provider:'ollama',baseUrl:'http://localhost:11434'};
  const call=args as {route:string};
  if(call.route==='models')return {models:[{id:'vision',label:'Local vision'}],errors:{},creativity:['Grounded'],shot_counts:['Auto'],default_shots:'Auto'};
  if(call.route==='h3')return await new Promise(resolve=>{finish=resolve;});
  if(call.route==='cancel')return {cancelled:true};throw Error('Unexpected request');
 });
 const value:ContinuityPlan={...plan,source:{clipId:'root-1',endpoint:'http://127.0.0.1:7801'}};const onChange=vi.fn();
 render(<I18nProvider><ContinuityPlanner endpoint="http://127.0.0.1:7801" root="/env" forgeContext={{mode:'T2VA',duration:5,canvas:{width:768,height:512},references:[],easy:false}} plan={value} running={false} disabled={false} onChange={onChange} onRun={vi.fn()}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));const pop=within(screen.getByRole('dialog',{name:'Prompt Forge'}));
 fireEvent.change(pop.getByRole('textbox',{name:'Next action'}),{target:{value:'turn'}});
 await pop.findByRole('option',{name:'Local vision'});
 fireEvent.click(pop.getByRole('button',{name:'Write'}));await pop.findByRole('button',{name:'Cancel'});
 expect((screen.getByRole('button',{name:'Run all'}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('textbox',{name:'Session name'}) as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(pop.getByRole('button',{name:'Cancel'}));
 expect((screen.getByRole('button',{name:'Run all'}) as HTMLButtonElement).disabled).toBe(false);
 await act(async()=>{finish({simple_prompt:'late draft',warnings:[]});});
 expect(onChange).not.toHaveBeenCalled();expect(pop.queryByRole('textbox',{name:'Result'})).toBeNull();
});

test('using an already selected prepared video preserves completed links and clearing only resets local plan state',async()=>{
 localStorage.setItem('deas.locale.v1','en');const sourceId='a'.repeat(64);const endpoint='http://127.0.0.1:7801';
 vi.mocked(invoke).mockResolvedValue({sourceId,filename:'source.mp4',sha256:'b'.repeat(64),width:1920,height:1080,fps:24,seconds:8,hasAudio:true});
 const value:ContinuityPlan={...plan,source:{clipId:sourceId,endpoint,kind:'video'},steps:[{...plan.steps[0],clipId:'finished',jobId:'job'}]};const onChange=vi.fn();
 render(<I18nProvider><ContinuityPlanner endpoint={endpoint} plan={value} running={false} disabled={false} onChange={onChange} onRun={vi.fn()}/></I18nProvider>);
 fireEvent.change(screen.getByRole('textbox',{name:'Video in ComfyUI input'}),{target:{value:'source.mp4'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare video'}));fireEvent.click(await screen.findByRole('button',{name:'Use video'}));
 expect(onChange).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Clear video source'}));
 expect(onChange).toHaveBeenLastCalledWith(plan);expect(value.steps[0].clipId).toBe('finished');
});

test('continuity overlap defaults to 22 without rewriting an old plan and offers only Director choices',()=>{
 const onChange=mount();const select=screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement;
 expect(select.value).toBe('22');expect(onChange).not.toHaveBeenCalled();
 expect([...select.options].map(o=>o.value)).toEqual(['73','56','39','22','5']);
 for(const n of [73,56,39,22,5]){
  fireEvent.change(select,{target:{value:String(n)}});
  expect(onChange.mock.lastCall![0]).toEqual({...plan,overlapFrames:n});
 }
});
test('selected overlap survives a new session while previous clip identities are cleared',()=>{
 const onChange=mount({...plan,overlapFrames:39,steps:[{...plan.steps[0],clipId:'old-clip',jobId:'old-job'}]});
 expect((screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement).value).toBe('39');
 fireEvent.click(screen.getByRole('button',{name:'New session'}));
 const next=onChange.mock.lastCall![0];expect(next.overlapFrames).toBe(39);expect(next.session).not.toBe(plan.session);
 expect(next.steps).toEqual(plan.steps);
});
test('running locks overlap and unsupported dropdown values do not change the plan',()=>{
 const onChange=mount(plan,true);const select=screen.getByRole('combobox',{name:'Overlap (frames)'}) as HTMLSelectElement;
 expect(select.disabled).toBe(true);fireEvent.change(select,{target:{value:'74'}});expect(onChange).not.toHaveBeenCalled();
});

