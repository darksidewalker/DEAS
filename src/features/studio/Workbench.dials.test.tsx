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

test('the LoRA browser hides dial files by path until the pack\'s catalog is read, then only the files the catalog lists; a real LoRA kept in dials/ comes back',async()=>{
 const real='dials/real_lora.safetensors',probe='dials/_probes/x.safetensors';
 const bare={version:2,description:'',negative:'',positive:'',pipeline:'',notes:'',neg:{useful:null,overcook:null},pos:{useful:null,overcook:null},evidence:null};
 // The pack lists the two dial files; real_lora.safetensors holds LoRA tensors, so the pack's catalog does not list it.
 const listed={dials:[{dial:motion,family:'MiniMax H3',mode:'post',info:bare},{dial:calm,family:'MiniMax H3',mode:'post',info:bare}],dropped:0,truncated:false};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_dial_catalog'?listed:{path:'/env/input',parent:'/env',entries:[],truncated:false});
 vi.mocked(scanModels).mockResolvedValue([...h3VideoFiles(),lora(motion),lora(calm),lora(probe),lora(real),lora('style.safetensors')]);
 localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2v'));
 localStorage.setItem('deas.pref.studio.run.dials',JSON.stringify([]));
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(allow(undefined,[motion,calm,real,'style.safetensors']));
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const tiles=()=>Array.from(document.querySelectorAll('.wb-loras > li')).map(li=>li.textContent);
 const has=(name:string)=>tiles().some(text=>text?.includes(name));
 dock('LoRAs');
 // State 1, no catalog read yet: the path rule. The real LoRA in dials/ is hidden with the dial files.
 await waitFor(()=>expect(has('style')).toBe(true));
 expect([has('h3_motion'),has('h3_calm'),has('real_lora'),tiles().length]).toEqual([false,false,false,1]);
 expect(vi.mocked(invoke).mock.calls.filter(c=>c[0]==='native_dial_catalog')).toHaveLength(0);
 // State 2, the Dials tab was opened and the catalog read: only what the catalog lists is hidden.
 dock('Dials');
 await waitFor(()=>expect(vi.mocked(invoke).mock.calls.filter(c=>c[0]==='native_dial_catalog')).toHaveLength(1));
 dock('LoRAs');
 await waitFor(()=>expect(has('real_lora')).toBe(true));
 expect([has('h3_motion'),has('h3_calm'),has('style'),tiles().length]).toEqual([false,false,true,2]);
 // A folder starting with "_" is never in the catalog: its files stay hidden by path.
 expect(document.querySelector('.wb-dock-panel')?.textContent).not.toContain('_probes');
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

test('the rack dialog opens from the strip, edits the saved rows that Run sends, and returns focus to its button',async()=>{
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:-0.5,on:true,time:curve}]);
 // The planned graph input: an authored blend-step count travels in the row's time object.
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 dock('Dials');
 const open=within(strip()).getByRole('button',{name:'Open rack'});
 expect(open.getAttribute('aria-haspopup')).toBe('dialog');
 expect(document.querySelector('[data-dial-rack]')).toBeNull();
 fireEvent.click(open);
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'}) as HTMLDialogElement;
 expect(dialog.open).toBe(true);
 // The lanes span the clip the job renders, not the typed seconds: the default 5 s is 124 frames on MiniMax H3.
 expect(dialog.querySelector('[data-dial-timeline]')!.getAttribute('data-dial-timeline')).toBe('clip');
 expect(dialog.querySelector('[data-dial-timeline] h3')!.textContent).toBe('Timeline · 5.167 s');
 expect(Array.from(dialog.querySelectorAll<HTMLElement>('[data-dial-lane]')).map(l=>l.dataset.dialLane)).toEqual([motion,calm]);
 expect(dialog.querySelector('[data-dial-conflicts]')).toBeNull();
 // First lane: a preset gives the constant row a curve; then an authored blend-step count.
 fireEvent.click(dialog.querySelector('[data-dial-tool="preset.rampIn"]')!);
 const steps=dialog.querySelector<HTMLInputElement>('[data-dial-steps]')!;
 expect([steps.placeholder,steps.max]).toEqual(['7','20']);
 fireEvent.change(steps,{target:{value:'5'}});
 await waitFor(()=>expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.dials')!)[0]).toEqual({dial:motion,strength:1.5,on:true,time:{type:'keys',points:[[0,0],[1.5,1]],unit:'seconds',interp:'linear',steps:5}}));
 expect(captureStudioSettings()['studio.run.dials']).toHaveLength(2);
 expect(isDialRows(captureStudioSettings()['studio.run.dials'])).toBe(true);
 // The dock strip behind the dialog shows the same rows.
 expect(row(motion).querySelector('[data-dial-curve]')).not.toBeNull();
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(document.querySelector('[data-dial-rack]')).toBeNull();
 expect(document.activeElement).toBe(within(strip()).getByRole('button',{name:'Open rack'}));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {steps:number;dials:DialRow[]};
 expect(sent.steps).toBe(20);
 expect(JSON.stringify(sent.dials)).toBe('[{"dial":"dials/h3_motion.safetensors","strength":1.5,"time":{"type":"keys","points":[[0,0],[1.5,1]],"unit":"seconds","interp":"linear","steps":5}},{"dial":"dials/sub/h3_calm.safetensors","strength":-0.5,"time":{"type":"keys","points":[[0,0.5],[1.5,1],[4,-2]],"unit":"seconds"}}]');
});

test.each([['t2v','6.583'],['ref2v','5.875']])('the lanes of a Continuity piece end where the compiler ends it in %s: a 1 s step after a 5 s clip',async(pipeline,seconds)=>{
 // T2VA: the continued step gets its 39-frame clip (frames / 24) and adds 34 frames, 124 + 34 = 158. REF2VA carries durationSeconds 1 and adds 17, 141.
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'deas-dials2',outputMode:'full',steps:[{id:'a',seconds:5,action:''},{id:'b',seconds:1,action:''}]}));
 const view=await mount([{dial:calm,strength:1,on:true,time:curve}],{pipeline});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-dock-tab="dials"]')).not.toBeNull());
 dock('Dials');
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(dialog.querySelector('[data-dial-timeline]')!.getAttribute('data-dial-timeline')).toBe('plan');
 expect(dialog.querySelector('[data-dial-timeline] h3')!.textContent).toBe(`Timeline · ${seconds} s`);
});

test('a plan that continues an existing clip holds time curves: the compiler would move them by a length Studio does not hold',async()=>{
 // Pinned clip of 243 frames, context 22: a ramp over 0 to 1.5 s would be emitted at -9.2 s and the model would get level 1 everywhere.
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'deas-dials3',outputMode:'full',source:{clipId:'pinned-clip',endpoint:evidence.baseUrl},steps:[{id:'a',seconds:5,action:''}]}));
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:1,on:true,time:curve}]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 const reason='This Continuity plan continues an existing clip.';
 await waitFor(()=>expect(run().title).toContain(reason));
 expect(run().disabled).toBe(true);
 dock('Dials');
 expect(strip().querySelector('[data-dial-conflict="pieceStart"]')!.textContent).toContain(reason);
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(dialog.querySelector('[data-dial-timeline]')!.getAttribute('data-dial-timeline')).toBe('planSource');
 expect(dialog.querySelector('[data-dial-conflict="pieceStart"]')!.textContent).toContain(reason);
 fireEvent.click(within(dialog.querySelector<HTMLElement>(`[data-dial-lane="${calm}"]`)!).getByRole('button',{pressed:false}));
 expect(dialog.querySelector('[data-dial-frames]')).toBeNull();
 expect(dialog.querySelectorAll('[data-dial-tick]')).toHaveLength(0);
 expect(dialog.querySelector('[data-dial-rack-locked]')!.textContent).toContain(reason);
 // Removing the curve is the way out: the constant row runs on every segment.
 fireEvent.click(dialog.querySelector('[data-dial-tool="removeCurve"]')!);
 await waitFor(()=>expect(run().disabled).toBe(false));
 expect(dialog.querySelector('[data-dial-conflicts]')).toBeNull();
 expect(run().title).not.toContain(reason);
});

test('a plan that continues a clip whose frame count the plan holds lays the curves out over the whole piece, runs, and sends that count for native to confirm',async()=>{
 // The same plan as above with the picked clip's 243 frames kept: 243 + 119 = 362 frames, 15.083 s; the next clip's window starts at frame 221.
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'deas-dials4',outputMode:'full',source:{clipId:'pinned-clip',endpoint:evidence.baseUrl,frames:243},steps:[{id:'a',seconds:5,action:'she turns'}]}));
 const late={type:'keys' as const,points:[[10.5,0],[12,1]] as [number,number][],unit:'seconds' as const};
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:1,on:true,time:late}]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 await waitFor(()=>expect(run().disabled).toBe(false));
 expect(run().title).not.toContain('This Continuity plan continues an existing clip.');
 dock('Dials');
 expect(strip().querySelector('[data-dial-conflicts]')).toBeNull();
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(dialog.querySelector('[data-dial-timeline]')!.getAttribute('data-dial-timeline')).toBe('planContinued');
 expect(dialog.querySelector('[data-dial-timeline] h3')!.textContent).toBe('Timeline · 15.083 s');
 expect(dialog.querySelector('[data-dial-rack-locked]')).toBeNull();
 expect(dialog.querySelectorAll('[data-dial-rendered]')).toHaveLength(2);
 fireEvent.click(within(dialog.querySelector<HTMLElement>(`[data-dial-lane="${calm}"]`)!).getByRole('button',{pressed:false}));
 expect(dialog.querySelector('[data-dial-frames]')).not.toBeNull();
 expect(dialog.querySelectorAll('[data-dial-tick]')).toHaveLength(43);
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 // The plan's step is run from the Continuity dialog: the intent pins the clip and carries the count the lanes were drawn with.
 fireEvent.click(document.querySelector('[data-continuity-open]')!);
 const next=await waitFor(()=>{const b=document.querySelector<HTMLButtonElement>('[data-cont-run]')!;expect(b.disabled).toBe(false);return b;});
 await act(async()=>{fireEvent.click(next);});
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {h3:{continuity:Record<string,unknown>};dials:DialRow[]};
 expect(sent.h3.continuity).toMatchObject({sourceId:'pinned-clip',sourceFrames:243});
 // The curve travels in whole-piece seconds; native shifts it by the window start.
 expect(sent.dials[1].time!.points).toEqual([[10.5,0],[12,1]]);
});

test('a later step of such a plan sends the count of the clip it pins as the lanes have it: the picked clip plus the finished step',async()=>{
 // The first step (5 s, 119 new frames) has its clip; the second pins it. 243 + 119 = 362 frames before the second step.
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'deas-dials6',outputMode:'full',source:{clipId:'pinned-clip',endpoint:evidence.baseUrl,frames:243},steps:[{id:'a',seconds:5,action:'she turns',clipId:'made-clip'},{id:'b',seconds:3,action:'she walks off'}]}));
 const late={type:'keys' as const,points:[[15.5,0],[17,1]] as [number,number][],unit:'seconds' as const};
 const view=await mount([{dial:calm,strength:1,on:true,time:late}]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(document.querySelector('[data-continuity-open]')!);
 const next=await waitFor(()=>{const b=document.querySelector<HTMLButtonElement>('[data-cont-run]')!;expect(b.disabled).toBe(false);return b;});
 await act(async()=>{fireEvent.click(next);});
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {h3:{continuity:Record<string,unknown>}};
 expect(sent.h3.continuity).toMatchObject({sourceId:'made-clip',sourceFrames:362});
});

test('without a time curve the continued step carries no frame count, as before',async()=>{
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'deas-dials5',outputMode:'full',source:{clipId:'pinned-clip',endpoint:evidence.baseUrl,frames:243},steps:[{id:'a',seconds:5,action:'she turns'}]}));
 const view=await mount([{dial:motion,strength:1.5,on:true}]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(document.querySelector('[data-continuity-open]')!);
 const next=await waitFor(()=>{const b=document.querySelector<HTMLButtonElement>('[data-cont-run]')!;expect(b.disabled).toBe(false);return b;});
 await act(async()=>{fireEvent.click(next);});
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {h3:{continuity:Record<string,unknown>}};
 expect(sent.h3.continuity.sourceId).toBe('pinned-clip');
 expect('sourceFrames' in sent.h3.continuity).toBe(false);
});

test('a time-curve refusal blocks Run with its reason in the strip and the dialog until the curve is off; rows without a curve are not held',async()=>{
 // More blend steps than the job samples (20): native "time.steps (blend steps) cannot exceed the job's 20 sampler steps".
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:1,on:true,time:{...curve,steps:21}}]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 const reason='A time curve asks for more blend steps than the job has sampler steps.';
 await waitFor(()=>expect(run().title).toContain(reason));
 expect(run().disabled).toBe(true);
 dock('Dials');
 expect(strip().querySelector('[data-dial-conflict="blendSteps"]')!.textContent).toContain(reason);
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(dialog.querySelector('[data-dial-conflict="blendSteps"]')!.textContent).toContain(reason);
 fireEvent.click(within(dialog.querySelector<HTMLElement>(`[data-dial-lane="${calm}"]`)!).getByRole('button',{pressed:false}));
 fireEvent.change(dialog.querySelector('[data-dial-steps]')!,{target:{value:'20'}});
 await waitFor(()=>expect(run().disabled).toBe(false));
 expect(dialog.querySelector('[data-dial-conflicts]')).toBeNull();
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(strip().querySelector('[data-dial-conflicts]')).toBeNull();
 expect(run().title).not.toContain(reason);
});

test('face refinement with a time curve is refused before Run; the same rows without the curve run',async()=>{
 localStorage.setItem('deas.pref.studio.run.faceRefine',JSON.stringify({auto:true,denoise:0.3,cropFactor:2.5,feather:6,prompt:''}));
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:1,on:true,time:curve}]);
 expect(planned()).toHaveProperty('faceRefine');
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 const reason='A dial time curve cannot run with face refinement';
 await waitFor(()=>expect(run().title).toContain(reason));
 dock('Dials');
 expect(strip().querySelector('[data-dial-conflict="faceRefine"]')!.textContent).toContain(reason);
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 fireEvent.click(within(dialog.querySelector<HTMLElement>(`[data-dial-lane="${calm}"]`)!).getByRole('button',{pressed:false}));
 expect(dialog.querySelector('[data-dial-rack-locked]')!.textContent).toContain(reason);
 expect(dialog.querySelector<HTMLButtonElement>('[data-dial-tool="preset.pulse"]')!.disabled).toBe(true);
 fireEvent.click(dialog.querySelector('[data-dial-tool="removeCurve"]')!);
 await waitFor(()=>expect(run().title).not.toContain(reason));
 expect(dialog.querySelector('[data-dial-conflicts]')).toBeNull();
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.dials')!)[1]).toEqual({dial:calm,strength:1,on:true});
});

test('join transitions are not offered while a row with a time curve is on, and the Continuity dialog says why',async()=>{
 const reason='Join transitions are generated on their own window and cannot run with a dial time curve.';
 // The join panel belongs to an enabled Continuity plan.
 localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:true,session:'deas-dials1',outputMode:'full',steps:[]}));
 const view=await mount([{dial:motion,strength:1.5,on:true},{dial:calm,strength:1,on:true,time:curve}]);
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-continuity-open]')).not.toBeNull());
 const openJoin=()=>{
  fireEvent.click(document.querySelector('[data-continuity-open]')!);
  const dialog=screen.getByRole('dialog',{name:'Continuity'});
  fireEvent.change(dialog.querySelector<HTMLSelectElement>('[data-cont-join-mode]')!,{target:{value:'files'}});
  return dialog;
 };
 let dialog=openJoin();
 expect(within(dialog).getByText(reason,{exact:false})).toBeTruthy();
 expect(dialog.querySelector('[data-cont-join-transitions]')).toBeNull();
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 // Switched off, the curve asks for nothing: the option is back and the notice is gone.
 dock('Dials');
 fireEvent.click(within(row(calm)).getByRole('checkbox'));
 dialog=openJoin();
 expect(within(dialog).queryByText(reason,{exact:false})).toBeNull();
 expect(dialog.querySelector('[data-cont-join-transitions]')).not.toBeNull();
});

// What `native_dial_catalog` hands Studio for the two dial files of these tests (shape of the pack's catalog; the per-pipeline steps are a schema example).
const look='dials/h3_look.safetensors';
const dialCatalog={dials:[
 {dial:motion,family:'MiniMax H3',mode:'post',info:{version:2,description:'More or less movement.',negative:'still',positive:'lively',pipeline:'6-step, time rows k = 6',notes:'On a curve it needs the blend on every step.',neg:{useful:1.5,overcook:null},pos:{useful:1.5,overcook:2.25},evidence:'one-seed',
  pipelines:{t2v:{useful:1.5,overcook:2.25,steps:6,evidence:'one-seed',notes:''}}}},
 {dial:look,family:'MiniMax H3',mode:'post',info:{version:2,description:'',negative:'plain',positive:'inked',pipeline:'',notes:'',neg:{useful:null,overcook:null},pos:{useful:4.5,overcook:8},evidence:'multi-seed'}},
],dropped:0,truncated:false};
const other={path:'/env/input',parent:'/env',entries:[],truncated:false};
const catalogCalls=()=>vi.mocked(invoke).mock.calls.filter(c=>c[0]==='native_dial_catalog');
async function mountTab(rows:DialRow[],o:Parameters<typeof mount>[1]={}){
 const view=await mount(rows,{loras:[motion,calm,look,'style.safetensors'],...o});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 return view;
}

test('opening the Dials tab reads the dial catalog once; side labels, marks, a new row\'s strength, a new curve\'s blend steps and the audio mode reach what Run sends',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_dial_catalog'?dialCatalog:other);
 await mountTab([{dial:motion,strength:1.5,on:true}]);
 // Not before the tab is open.
 expect(catalogCalls()).toHaveLength(0);
 dock('Dials');
 await waitFor(()=>expect(row(motion).dataset.dialInfo).toBe('known'));
 expect(catalogCalls()).toEqual([['native_dial_catalog',{baseUrl:evidence.baseUrl}]]);
 expect(Array.from(row(motion).querySelectorAll<HTMLElement>('[data-dial-side]')).map(s=>s.textContent)).toEqual(['still','lively']);
 expect(Array.from(row(motion).querySelectorAll<HTMLElement>('[data-dial-mark]')).map(m=>m.dataset.dialMark)).toEqual(['neg-useful','pos-useful','pos-overcook']);
 expect(row(motion).querySelector('[data-dial-facts]')!.textContent).toBe('+ side: useful 1.5, overcook 2.25 · − side: useful 1.5 · one seed');
 expect(document.querySelector('[data-dial-info-state]')).toBeNull();
 // A new row starts at the file's positive useful strength, and its slider reaches the overcook strength.
 fireEvent.change(document.querySelector('[data-dial-add]')!,{target:{value:look}});
 expect(row(look).querySelector<HTMLInputElement>('[data-dial="strength"]')!.value).toBe('4.5');
 expect(row(look).querySelector<HTMLInputElement>('[data-dial="slider"]')!.max).toBe('8');
 // The rack: the tab is still open, so nothing is read again. Text to video is the pack's t2v.
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(catalogCalls()).toHaveLength(1);
 expect(dialog.querySelector('[data-dial-rack-info-part="notes"]')!.textContent).toBe('Notes: On a curve it needs the blend on every step.');
 fireEvent.click(dialog.querySelector('[data-dial-tool="addCurve"]')!);
 expect(dialog.querySelector<HTMLInputElement>('[data-dial-steps]')!.value).toBe('6');
 expect(dialog.querySelector('[data-dial-steps-file]')!.textContent).toBe('The dial file records 6 blend steps for text to video.');
 fireEvent.change(dialog.querySelector('[data-dial-audio]')!,{target:{value:'protect'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {steps:number;dials:DialRow[]};
 expect(sent.steps).toBe(20);
 expect(JSON.stringify(sent.dials)).toBe('[{"dial":"dials/h3_motion.safetensors","strength":1.5,"time":{"type":"keys","points":[[0,1],[5.1666,1]],"unit":"seconds","steps":6,"audio":"protect"}},{"dial":"dials/h3_look.safetensors","strength":4.5}]');
 expect(isDialRows(sent.dials)).toBe(true);
 // Reload reads again; leaving and reopening the tab does too.
 fireEvent.click(within(strip()).getByRole('button',{name:'Reload dial info'}));
 await waitFor(()=>expect(catalogCalls()).toHaveLength(2));
 dock('LoRAs');dock('Dials');
 await waitFor(()=>expect(catalogCalls()).toHaveLength(3));
 await waitFor(()=>expect(row(motion).dataset.dialInfo).toBe('known'));
});

test('with the catalog read, a dial of another model family is not offered and a pre-refiner dial takes no time curve; without it nothing changes',async()=>{
 const pre='dials/h3_motion_lora.safetensors',krea='dials/krea2_example_hook.safetensors',moss='dials/moss_example.safetensors';
 const bare={version:2,description:'',negative:'',positive:'',pipeline:'',notes:'',neg:{useful:null,overcook:null},pos:{useful:null,overcook:null},evidence:null};
 const families={dials:[...dialCatalog.dials,{dial:pre,family:'MiniMax H3',mode:'pre',info:bare},{dial:krea,family:'Krea 2',mode:'post',info:bare},{dial:moss,family:'MOSS-Image',mode:'post',info:bare}],dropped:0,truncated:false};
 let answer:()=>unknown=()=>{throw 'DIAL_INFO_UNAVAILABLE: This backend has no dial catalog route.';};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_dial_catalog'?answer():other);
 const offered=()=>Array.from(document.querySelector<HTMLSelectElement>('[data-dial-add]')!.options).map(o=>o.value);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 // A pre-refiner row that already has a curve, and a post-refiner row with one.
 await mountTab([{dial:pre,strength:1.5,on:true,time:curve},{dial:look,strength:2,on:true,time:curve}],{loras:[motion,calm,look,pre,krea,moss,'style.safetensors']});
 dock('Dials');
 // No catalog: every dial file is offered and nothing is held, as before.
 await waitFor(()=>expect(document.querySelector('[data-dial-info-state="unavailable"]')).not.toBeNull());
 expect(offered()).toEqual(['',motion,krea,moss,calm]);
 expect(strip().querySelector('[data-dial-conflicts]')).toBeNull();
 expect(run().disabled).toBe(false);
 // The catalog is read: the other families leave the list; the pre-refiner row's curve is refused before Run.
 answer=()=>families;
 fireEvent.click(within(strip()).getByRole('button',{name:'Reload dial info'}));
 await waitFor(()=>expect(offered()).toEqual(['',motion,calm]));
 const reason='A row with a time curve uses a pre-refiner dial.';
 expect(strip().querySelector('[data-dial-conflict="preDial"]')!.textContent).toContain(reason);
 await waitFor(()=>expect(run().title).toContain(reason));
 expect(run().disabled).toBe(true);
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(dialog.querySelector('[data-dial-rack-locked]')!.textContent).toContain('h3_motion_lora is a pre-refiner dial.');
 expect(dialog.querySelector<HTMLButtonElement>('[data-dial-tool="preset.rampIn"]')!.disabled).toBe(true);
 fireEvent.click(dialog.querySelector('[data-dial-tool="removeCurve"]')!);
 await waitFor(()=>expect(run().disabled).toBe(false));
 expect(dialog.querySelector('[data-dial-conflicts]')).toBeNull();
 expect(dialog.querySelector<HTMLButtonElement>('[data-dial-tool="addCurve"]')!.disabled).toBe(true);
 // The row is still sent, at its constant strength; the post-refiner row keeps its curve.
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 fireEvent.click(run());
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const sent=vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {dials:DialRow[]};
 expect(sent.dials).toEqual([{dial:pre,strength:1.5},{dial:look,strength:2,time:curve}]);
});

test('a row of another model family that is already in the rack is flagged and blocks Run once the catalog says so; switched off it does not, and without the catalog nothing changes',async()=>{
 const krea='dials/krea2_example_hook.safetensors';
 const bare={version:2,description:'',negative:'',positive:'',pipeline:'',notes:'',neg:{useful:null,overcook:null},pos:{useful:null,overcook:null},evidence:null};
 const families={dials:[...dialCatalog.dials,{dial:krea,family:'Krea 2',mode:'post',info:bare}],dropped:0,truncated:false};
 let answer:()=>unknown=()=>{throw 'DIAL_INFO_UNAVAILABLE: This backend has no dial catalog route.';};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_dial_catalog'?answer():other);
 const run=()=>screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 // The Krea 2 row came from a preset, history or an older session: it is in the rack and on.
 await mountTab([{dial:motion,strength:1.5,on:true},{dial:krea,strength:1,on:true}],{loras:[motion,calm,look,krea,'style.safetensors']});
 dock('Dials');
 await waitFor(()=>expect(document.querySelector('[data-dial-info-state="unavailable"]')).not.toBeNull());
 expect(row(krea).querySelector('[data-dial-other-family]')).toBeNull();
 expect(run().disabled).toBe(false);
 answer=()=>families;
 fireEvent.click(within(strip()).getByRole('button',{name:'Reload dial info'}));
 await waitFor(()=>expect(row(krea).querySelector('[data-dial-other-family]')!.textContent).toContain('Made for Krea 2, not MiniMax H3'));
 const reason='Dial made for Krea 2, not MiniMax H3: dials/krea2_example_hook.safetensors';
 await waitFor(()=>expect(run().title).toContain(reason));
 expect(run().disabled).toBe(true);
 expect(row(motion).querySelector('[data-dial-other-family]')).toBeNull();
 // The row is kept; switched off it no longer blocks, and only the H3 row is sent.
 fireEvent.click(row(krea).querySelector('[data-dial="on"]')!);
 await waitFor(()=>expect(run().disabled).toBe(false));
 expect(run().title).not.toContain(reason);
 expect(row(krea).querySelector('[data-dial-other-family]')).not.toBeNull();
 fireEvent.click(run());
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect((vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {dials:DialRow[]}).dials).toEqual([{dial:motion,strength:1.5}]);
});

test('a failed catalog read never blocks the strip: it keeps its fallbacks, says dial info is unavailable and Run stays usable',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>{if(c==='native_dial_catalog')throw 'DIAL_INFO_UNAVAILABLE: This backend has no dial catalog route.';return other;});
 await mountTab([{dial:motion,strength:1.5,on:true}]);
 dock('Dials');
 await waitFor(()=>expect(document.querySelector('[data-dial-info-state="unavailable"]')).not.toBeNull());
 expect(strip().dataset.dials).toBe('ready');
 expect(row(motion).dataset.dialInfo).toBeUndefined();
 expect(row(motion).querySelector('[data-dial-side], [data-dial-mark], [data-dial-facts]')).toBeNull();
 const slider=row(motion).querySelector<HTMLInputElement>('[data-dial="slider"]')!;
 expect([slider.min,slider.max,slider.disabled]).toEqual(['-3','3',false]);
 fireEvent.change(document.querySelector('[data-dial-add]')!,{target:{value:look}});
 expect(row(look).querySelector<HTMLInputElement>('[data-dial="strength"]')!.value).toBe('1');
 // The rack works on DEAS's own default: no blend steps are authored.
 fireEvent.click(within(strip()).getByRole('button',{name:'Open rack'}));
 const dialog=screen.getByRole('dialog',{name:'Dial rack (experimental)'});
 expect(within(dialog).getByText('Dial info unavailable: side labels and strength marks are not shown. The rows work as before.')).toBeTruthy();
 expect(dialog.querySelector('[data-dial-rack-info]')).toBeNull();
 fireEvent.click(dialog.querySelector('[data-dial-tool="addCurve"]')!);
 expect(dialog.querySelector<HTMLInputElement>('[data-dial-steps]')!.value).toBe('');
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(JSON.stringify((vi.mocked(runWorkbenchJob).mock.calls[0][1] as unknown as {dials:DialRow[]}).dials)).toBe('[{"dial":"dials/h3_motion.safetensors","strength":1.5,"time":{"type":"keys","points":[[0,1],[5.1666,1]],"unit":"seconds"}},{"dial":"dials/h3_look.safetensors","strength":1}]');
 // A later read that works brings the info in.
 vi.mocked(invoke).mockImplementation(async c=>c==='native_dial_catalog'?dialCatalog:other);
 fireEvent.click(within(strip()).getByRole('button',{name:'Reload dial info'}));
 await waitFor(()=>expect(row(motion).dataset.dialInfo).toBe('known'));
 expect(document.querySelector('[data-dial-info-state]')).toBeNull();
});

test('the catalog is not asked for where dials cannot run: without the Dial Rack nodes or on another video family',async()=>{
 vi.mocked(invoke).mockImplementation(async c=>c==='native_dial_catalog'?dialCatalog:other);
 const view=await mount([{dial:motion,strength:1.5,on:false}],{nodes:[]});
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 dock('Dials');
 await waitFor(()=>expect(strip().dataset.dials).toBe('nodeMissing'));
 expect(catalogCalls()).toHaveLength(0);
 expect(document.querySelector('[data-dial-info-state], [data-dial-info-refresh]')).toBeNull();
 view.unmount();
 localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify(ltxModels[0].name));
 const ltx=await mount([{dial:motion,strength:1.5,on:true}],{files:ltxModels as unknown as ReturnType<typeof h3VideoFiles>});
 ltx.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 dock('Dials');
 expect(strip().dataset.dials).toBe('h3VideoOnly');
 expect(catalogCalls()).toHaveLength(0);
});
