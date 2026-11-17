import { dock, evidence, h3VideoFiles, heldJob, ltxModels, openHistoryRecord, pipe, recentHistoryRecord, videoEvidence } from './Workbench.testHarness';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { runWorkbenchJob } from '../../lib/jobs';
import { applyStudioSettings, captureStudioSettings } from '../../lib/preferences';
import { isDialRows, type DialRow } from '../../lib/dials';

const motion='dials/h3_motion.safetensors',calm='dials/sub/h3_calm.safetensors';
const curve={type:'keys' as const,points:[[0,0.5],[1.5,1],[4,-2]] as [number,number][],unit:'seconds' as const};
const lora=(name:string)=>({category:'loras',name,path:'/m/loras/'+name,size:1,info:null});
const allow=(nodes:string[]=['MAIDialRack','MAIDialHoldMap'],loras:string[]=[motion,calm,'style.safetensors'])=>({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,...nodes],loras}});
const props={endpoint:evidence.baseUrl,roots:{models:'/m'}};
const planned=()=>JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
async function mount(rows:DialRow[],o:{nodes?:string[];loras?:string[];pipeline?:string;files?:ReturnType<typeof h3VideoFiles>}={}){
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify(o.pipeline??'t2v'));
 localStorage.setItem('deas.pref.studio.run.dials',JSON.stringify(rows));
 vi.mocked(scanModels).mockResolvedValue([...(o.files??h3VideoFiles()),lora(motion),lora(calm),lora('dials/_probes/x.safetensors'),lora('style.safetensors')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow(o.nodes,o.loras));
 vi.mocked(runWorkbenchJob).mockResolvedValue(heldJob('dials','failed',evidence.baseUrl));
 const view=render(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-plan-intent]')?.textContent).toContain('video-generation'));
 return view;
}
const strip=()=>document.querySelector<HTMLElement>('[data-dials]')!;
const row=(dial:string)=>document.querySelector<HTMLElement>(`[data-dial-row="${dial}"]`)!;

test('saved rows enter a MiniMax H3 intent exactly as the native validator reads them, show in the plan and the Dials tab, and transfer with settings',async()=>{
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:-0.5,on:true,time:curve},{dial:'dials/off.safetensors',strength:2,on:false}]);
 const intent=planned();
 expect(intent.family).toBe('minimax-h3');
 // The native fixture `json!([dial_row(1.5), timed_dial()])` byte for byte; the off row is not sent.
 expect(JSON.stringify(intent.dials)).toBe('[{"dial":"dials/h3_motion.safetensors","strength":1.5},{"dial":"dials/sub/h3_calm.safetensors","strength":-0.5,"time":{"type":"keys","points":[[0,0.5],[1.5,1],[4,-2]],"unit":"seconds"}}]');
 expect(isDialRows(intent.dials)).toBe(true);
 expect(Array.from(document.querySelectorAll('[data-plan-dials] li')).map(li=>li.textContent)).toEqual([`${motion} · 1.5`,`${calm} · -0.5 · time curve, 3 points`]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 // The tab sits next to LoRAs and counts the rows that will be sent.
 expect(Array.from(document.querySelectorAll<HTMLElement>('[data-dock-tab]')).map(b=>b.dataset.dockTab)).toEqual(['media','models','loras','dials','notes','presets','wildcards','post','options']);
 expect(document.querySelector('[data-dock-tab="dials"] .wb-dock-badge')?.textContent).toBe('2');
 dock('Dials');
 expect(screen.getByRole('tab',{name:'Dials'}).getAttribute('aria-selected')).toBe('true');
 expect(strip().dataset.dials).toBe('ready');
 expect(document.querySelectorAll('[data-dial-row]')).toHaveLength(3);
 expect(row(calm).querySelector('[data-dial-curve]')).not.toBeNull();
 // The saved off row names a file the backend does not list; it is flagged but does not block Run.
 expect(row('dials/off.safetensors').dataset.dialState).toBe('off');
 expect(Array.from(document.querySelector<HTMLSelectElement>('[data-dial-add]')!.options).map(o=>o.value)).toEqual(['']);
 fireEvent.click(within(row(calm)).getByRole('button',{name:'Remove h3_calm'}));
 expect(captureStudioSettings()['studio.run.dials']).toEqual([{dial:motion,strength:1.5,on:true},{dial:'dials/off.safetensors',strength:2,on:false}]);
 await waitFor(()=>expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.dials')!)).toHaveLength(2));
 // Folders starting with "_" are not offered, as in the pack's own catalog.
 expect(Array.from(document.querySelector<HTMLSelectElement>('[data-dial-add]')!.options).map(o=>o.value)).toEqual(['',calm]);
 act(()=>{expect(applyStudioSettings({'studio.run.dials':[{dial:calm,strength:3}]})).toBe(true);});
 expect(document.querySelectorAll('[data-dial-row]')).toHaveLength(1);
 act(()=>{expect(applyStudioSettings({'studio.run.dials':[{dial:'style.safetensors',strength:1}]})).toBe(false);});
 expect(document.querySelectorAll('[data-dial-row]')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'minimax-h3',dials:[{dial:calm,strength:3}]});
});

test('without an active row the intent carries no dials field',async()=>{
 await mount([{dial:motion,strength:1.5,on:false},{dial:calm,strength:0,on:true}]);
 expect(planned()).not.toHaveProperty('dials');
 expect(document.querySelector('[data-plan-dials]')).toBeNull();
});

test('a missing Dial Rack node or dial file blocks Run by name until the row is switched off',async()=>{
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:'dials/gone.safetensors',strength:1,on:true}],{nodes:[]});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 await waitFor(()=>expect(run().title).toContain('MAIDialRack'));
 expect(run().disabled).toBe(true);
 expect(run().title).toContain('Dial: dials/gone.safetensors');
 expect(run().title).not.toContain(`Dial: ${motion}`);
 dock('Dials');
 expect(strip().dataset.dials).toBe('nodeMissing');
 expect(within(strip()).getByRole('status').textContent).toContain('Dial Rack nodes');
 expect(row('dials/gone.safetensors').dataset.dialState).toBe('missing');
 expect(document.querySelector<HTMLSelectElement>('[data-dial-add]')!.disabled).toBe(true);
 expect(within(row(motion)).getByRole('slider')).toHaveProperty('disabled',true);
 fireEvent.click(within(row(motion)).getByRole('checkbox'));
 fireEvent.click(within(row('dials/gone.safetensors')).getByRole('checkbox'));
 await waitFor(()=>expect(run().disabled).toBe(false));
 expect(document.querySelector('[data-dock-tab="dials"] .wb-dock-badge')).toBeNull();
});

test('rows stay saved but inert on another video family',async()=>{
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(ltxModels[0].name));
 const view=await mount([{dial:motion,strength:1.5,on:true}],{files:ltxModels as unknown as ReturnType<typeof h3VideoFiles>});
 expect(planned().family).toBe('ltx-2');
 expect(planned()).not.toHaveProperty('dials');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 expect(document.querySelector('[data-dock-tab="dials"] .wb-dock-badge')).toBeNull();
 dock('Dials');
 expect(strip().dataset.dials).toBe('h3VideoOnly');
 expect(document.querySelectorAll('[data-dial-row]')).toHaveLength(1);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.dials')!)).toEqual([{dial:motion,strength:1.5,on:true}]);
});

test('the LoRA browser leaves dial files to the Dials tab',async()=>{
 // A dial file that was already selected as a LoRA stays visible, so it can still be removed there.
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:calm,strength:1}]));
 const view=await mount([]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 dock('LoRAs');
 await waitFor(()=>expect(document.querySelector('.wb-loras')?.textContent).toContain('style'));
 expect(document.querySelector('.wb-loras')?.textContent).toContain('h3_calm');
 expect(document.querySelector('.wb-loras')?.textContent).not.toContain('h3_motion');
 expect(document.querySelectorAll('.wb-loras > li')).toHaveLength(2);
 dock('Dials');
 expect(Array.from(document.querySelector<HTMLSelectElement>('[data-dial-add]')!.options).map(o=>o.value)).toEqual(['',motion,calm]);
 fireEvent.change(document.querySelector('[data-dial-add]')!,{target:{value:motion}});
 expect(captureStudioSettings()['studio.run.dials']).toEqual([{dial:motion,strength:1,on:true}]);
});

test('history restores the rows of a MiniMax H3 intent and clears them for an intent without any',async()=>{
 localStorage.setItem('deas.pref.studio.run.dials',JSON.stringify([{dial:'dials/remembered.safetensors',strength:2,on:true}]));
 const files=h3VideoFiles();
 const record=(dials?:DialRow[])=>recentHistoryRecord({recipeId:'video-generation',version:1,family:'minimax-h3',positivePrompt:'historic h3',negativePrompt:'',model:files[0].name,textEncoder:files[1].name,vae:files[2].name,seed:19,width:1344,height:768,frames:124,frameRate:24,steps:8,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'raw/video/old',output:{codec:'Auto',container:'Auto',bitDepth:'Auto',quality:20,audioCodec:'AAC',audioBitrate:'192k',saveFirstFrame:false,saveLastFrame:false},h3:{mode:'T2VA',audioVae:files[3].name,shiftVideo:10,shiftAudio:3,references:[]},...(dials?{dials}:{})});
 let records=[record([{dial:motion,strength:1.5},{dial:calm,strength:-0.5,time:curve}])];
 vi.mocked(scanModels).mockResolvedValue(files);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow());
 vi.mocked(invoke).mockImplementation(async c=>c==='native_jobs_history'?{schemaVersion:1,records,readOnly:false,error:null}:{path:'/env/input',parent:'/env',entries:[],truncated:false});
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 await waitFor(()=>expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.dials')!)).toEqual([{dial:motion,strength:1.5,on:true},{dial:calm,strength:-0.5,time:curve,on:true}]));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 view.unmount();
 records=[record()];
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 await openHistoryRecord();fireEvent.click(document.querySelector('[data-history-apply]')!);
 await waitFor(()=>expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.dials')!)).toEqual([]));
});

test('active rows on a GGUF base block Run with the reason; switched off they do not',async()=>{
 const files=h3VideoFiles().map((m,i)=>i===0?{...m,name:'h3.gguf',path:'/m/h3.gguf'}:m);
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 localStorage.setItem('deas.pref.studio.run.dials',JSON.stringify([{dial:motion,strength:1.5,on:true}]));
 vi.mocked(scanModels).mockResolvedValue([...files,lora(motion)]);
 const base=allow();
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...base,allowlist:{...base.allowlist,nodes:[...base.allowlist.nodes,'UnetLoaderGGUF'],ggufDiffusionModels:['h3.gguf']}});
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 await waitFor(()=>expect(run().title).toContain('Dials on a GGUF base model are not proven'));
 expect(run().disabled).toBe(true);
 expect((document.querySelector('[data-model-picker]') as HTMLSelectElement).value).toContain('h3.gguf');
 dock('Dials');
 expect(strip().dataset.dials).toBe('gguf');
 const before=run().title;
 fireEvent.click(within(row(motion)).getByRole('checkbox'));
 await waitFor(()=>expect(run().title).not.toBe(before));
 expect(run().title).not.toContain('GGUF base model are not proven');
});
