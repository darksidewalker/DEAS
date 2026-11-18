import { adopt, choosePipe, collection, dock, dropTile, evidence, heldJob, imageModels, loadVideo, ltxModels, markOf, mediaEntries, menuOf, mossInput, mossNodes, mountMoss, pipe, projectFixture, promptDrop, stopAll, videoEvidence } from './Workbench.testHarness';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { defaultOptions } from './OptionsPanel';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { stopWorkbench, stopWorkbenchJob, runWorkbenchJob, readCurrentWorkbench, pollWorkbench, uploadMask, uploadInput, readRefMods, type JobStatus } from '../../lib/jobs';

test('pending video upload is dropped on unmount before native admission',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>{
  const job={...heldJob('late-upload-job','queued',baseUrl),intent};
  vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
  vi.mocked(pollWorkbench).mockResolvedValue(collection([job]));
  return job;
 });
 const props={endpoint:'http://127.0.0.1:7801',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 view.unmount();localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(readCurrentWorkbench).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 await act(async()=>release('deas-inputs/late.mp4'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
});

test('delayed video upload submits the captured endpoint, settings, naming and source, never a rebuilt draft',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>({...heldJob('captured','failed',baseUrl),intent}));
 localStorage.setItem('deas.pref.studio.run.seed','42');localStorage.setItem('deas.pref.studio.run.seedMode','"fixed"');
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,outputNaming:'saved/%seed%'}));
 const props={endpoint:'http://127.0.0.1:7801',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'/env/ComfyUI/input/clip.mp4'}});
 fireEvent.change(screen.getByLabelText('Source strength'),{target:{value:'0.7'}});
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'new prompt'}});
 fireEvent.change(screen.getByLabelText('Source strength'),{target:{value:'0.2'}});
 fireEvent.change(screen.getByLabelText('Steps'),{target:{value:'35'}});
 view.rerender(<I18nProvider><Workbench {...props} endpoint="http://changed:9999/"/></I18nProvider>);
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 await act(async()=>release('deas-inputs/captured.mp4'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0]).toEqual(['http://127.0.0.1:7801',expect.objectContaining({positivePrompt:'/env/ComfyUI/input/clip.mp4',seed:42,steps:8,outputPrefix:'raw/saved/42',sourceVideo:'deas-inputs/captured.mp4',ltx:expect.objectContaining({sourceStrength:0.7})}),0]);
});

test.each(['Image → Video','Multi-reference → Video'])('every host media action is mirrored in the preview toolbar (%s)',async pipeline=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'MiniMaxH3/h3_ref2va.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'}]);
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/outside',parent:'/',entries:[{name:'pic.png',path:'/outside/pic.png',kind:'file',media:'image',symlink:false,size:1,modified:1}],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/input',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe(pipeline).disabled).toBe(false));choosePipe(pipeline);
 fireEvent.click(await screen.findByRole('button',{name:'pic.png'}));
 const menu=menuOf('pic.png').getAllByRole('menuitem').map(b=>b.firstChild?.textContent??'').filter(label=>!["Open in folder","Delete…"].includes(label));
 fireEvent.keyDown(document.activeElement??document.body,{key:'Escape'});
 const toolbar=screen.getByRole('region',{name:'Preview'}).querySelector<HTMLElement>(':scope > [data-media-tools]')!;
 expect(menu.length).toBeGreaterThan(0);
 expect([...toolbar.querySelectorAll('[data-media-action]')].map(b=>b.textContent)).toEqual(menu);
});

test.each([['video','clip.mp4'],['audio','voice.wav']] as const)('external %s reference preview has one stage toolbar and no figure toolbar',async(media,name)=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([{category:'diffusion_models',name:'MiniMaxH3/h3_ref2va.safetensors',path:'/m/h3.safetensors',size:1,info:null,family:'minimax-h3'}]);
 vi.mocked(invoke).mockImplementation(async command=>command==='native_media_star_status'?{starred:false,unavailable:null}:{path:'/outside',parent:'/',entries:[{name,path:'/outside/'+name,kind:'file',media,symlink:false,size:1,modified:1}],truncated:false});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/input',output:'/out'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Multi-reference → Video').disabled).toBe(false));choosePipe('Multi-reference → Video');
 fireEvent.click(await screen.findByRole('button',{name}));adopt();
 const stage=screen.getByRole('region',{name:'Preview'});
 expect(stage.querySelector('[data-browsed-preview]')).not.toBeNull(); // assigning a reference does not adopt it as a source
 expect(stage.querySelector(`[data-browsed-preview] ${media}`)).not.toBeNull();
 expect(stage.querySelectorAll('[data-media-tools]')).toHaveLength(1);
 expect(stage.querySelector('.wb-current-preview figure [data-media-tools]')).toBeNull();
 const toolbar=stage.querySelector<HTMLElement>(':scope > [data-media-tools]')!;
 expect(within(toolbar).queryByRole('button',{name:'Use as input'})).toBeNull();
 expect(within(stage).getAllByRole('button',{name:`Star ${name}`})).toHaveLength(1);
 expect(within(toolbar).getByRole('button',{name:`Remove reference ${name}`})).toBeTruthy();
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();
});

test.each([
 ['Image → Video','ref.png','clip.mp4','Use as first frame'],
 ['Video → Video','clip.mp4','ref.png','Use as source video'],
])('Media context menu selects the clicked %s input without preview adoption or execution',async(pipeline,name,other,label)=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe(pipeline).disabled).toBe(false));choosePipe(pipeline);
 await screen.findByRole('button',{name});
 expect(menuOf(other).queryByRole('menuitem',{name:label})).toBeNull();
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:other}));
 expect(document.querySelector('[data-browsed-preview]')).not.toBeNull();
 fireEvent.click(menuOf(name).getByRole('menuitem',{name:label}));
 expect(screen.queryByRole('menu')).toBeNull();
 expect(document.querySelector('[data-browsed-preview]')).toBeNull();
 expect([...document.querySelectorAll('.wb-active')].some(el=>el.textContent?.includes(name))).toBe(true);
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['REF2VA','FL2VA'] as const)('HyperFlow %s follows the global pipeline and submits its own reference mode',async mode=>{
 const name=`MiniMaxH3/minimax_h3_${mode.toLowerCase()}_hyperflow_flash_14b-Q8_0.gguf`;
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name,path:'/m/'+name,size:1,info:null,family:'minimax-h3-hyperflow'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t',size:1,info:null},
  {category:'vae',name:'minimax_h3_video_vae_fp16.safetensors',path:'/m/v',size:1,info:null},
  {category:'vae',name:'minimax_h3_audio_vae_fp32.safetensors',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,
  nodes:[...evidence.allowlist.nodes,'HyperFlowGGUFLoader','HyperFlowSigmas','CLIPLoader','VAELoader'],
  ggufDiffusionModels:[name],textEncoders:['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],clipTypes:['minimax'],
  vaes:['minimax_h3_video_vae_fp16.safetensors','minimax_h3_audio_vae_fp32.safetensors']}});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string})?.path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/u.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('hyperflow','failed'),error:'fixture'});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Text → Video').disabled).toBe(false));
 choosePipe('Text → Video');
 // A checkpoint's name is not a request to change the user's data pipeline.
 expect(document.querySelector('[data-open-references]')).not.toBeNull();
 expect(screen.getByLabelText('Pipeline')).toHaveProperty('value','video');
 expect(pipe('Video → Video').disabled).toBe(false);
 choosePipe(mode==='REF2VA'?'Multi-reference → Video':'Image → Video');
 fireEvent.change(screen.getByLabelText('Aspect ratio'),{target:{value:'4:3'}});
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'ref.png'});
 if(mode==='REF2VA'){
  expect(document.querySelector('[data-open-references]')).toBeTruthy();
  expect(menuOf('clip.mp4').getByRole('menuitem',{name:/^Add as reference/})).toHaveProperty('disabled',true);
  fireEvent.keyDown(window,{key:'Escape'});
  fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Add as reference'}));
  fireEvent.click(document.querySelector('[data-open-references]')!);
  const dialog=screen.getByRole('dialog',{name:'References'});
  expect(within(dialog).getByRole('region',{name:'Images'})).toBeTruthy();
  expect(dialog.querySelector('[data-reference-lane="image"] .reference-count')?.textContent).toBe('1 / 9');
  expect(within(dialog).queryByText(/Select images, videos or audio/)).toBeNull();
  expect(dialog.querySelector('[data-reference-lane="video"] [data-ref]')).toBeNull();
  expect(dialog.querySelector('[data-reference-lane="audio"] [data-ref]')).toBeNull();
  for(const [name,media] of [['clip.mp4','video'],['voice.wav','audio']]){
   const item={name,media,path:`/env/ComfyUI/input/${name}`,src:`asset://${name}`};
   fireEvent.drop(document.querySelector('[data-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(item)}});
   expect(within(dialog).getByRole('alert').textContent).toContain('HyperFlow GGUF accepts image references only.');
   expect(document.querySelectorAll('[data-ref]')).toHaveLength(1);
  }
  fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 }else{
  expect(document.querySelector('[data-open-references]')).not.toBeNull();
  fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first and last frame'}));
  const image=screen.getByRole('img',{name:'ref.png'});
  Object.defineProperties(image,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(image);
 }
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'fixed'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'minimax-h3-hyperflow',model:name,h3:mode==='REF2VA'
  ?{mode,references:[],media:[{type:'image',file:'deas-inputs/u.png',slot:0}]}
  :{mode,references:[{slot:0,image:'deas-inputs/u.png'},{slot:1,image:'deas-inputs/u.png'}]}});
});

test('Image → Video media menu assigns first, last or both frame roles',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Video').disabled).toBe(false));choosePipe('Image → Video');
 await screen.findByRole('button',{name:'ref.png'});
 const last=()=>[...document.querySelectorAll('.wb-resolution-hint')].find(el=>el.textContent?.startsWith('Last frame:'))?.textContent??'';
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first and last frame'}));
 expect([...document.querySelectorAll('.wb-active')].some(el=>el.textContent?.includes('ref.png'))).toBe(true);
 expect(last()).toContain('ref.png');
 // The image is now the last frame, so the menu offers removal; "first frame" alone drops the last role.
 expect(menuOf('ref.png').getByRole('menuitem',{name:'Remove last frame'})).toBeTruthy();
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first frame'}));
 expect(last()).toBe('');
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as last frame'}));
 expect(last()).toContain('ref.png');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('MiniMax H3 Image → Video runs a last frame alone (L2VA) and badges frame roles in Media',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/u1.png');
 vi.mocked(runWorkbenchJob).mockResolvedValue({...heldJob('plain','failed'),error:'fixture'});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'ref.png'});
 await waitFor(()=>expect(pipe('Image → Video').disabled).toBe(false));choosePipe('Image → Video');
 const badge=()=>screen.getByRole('button',{name:'ref.png'}).closest('li')!.getAttribute('data-mark');
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as last frame'}));
 expect(badge()).toBe('Last frame');
 expect(document.querySelector('[data-frame-people="first"]')).toBeNull();
 const img=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'fixed'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'1024'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'768'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false));fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({family:'minimax-h3',h3:{mode:'L2VA',references:[{slot:1,image:'deas-inputs/u1.png'}]}});
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first frame'}));
 expect(badge()).toBe('First frame');
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Use as first and last frame'}));
 expect(badge()).toBe('First frame + Last frame');
});

test('IPC fixture: LTX Video → Video uploads the source video; Multi-reference → Video sends image keyframes at their seconds',async()=>{
 // jsdom never loads media: the first reference's size is what Auto aspect waits for.
 vi.stubGlobal('Image',class{naturalWidth=1024;naturalHeight=640;onload?:()=>void;set src(_:string){queueMicrotask(()=>this.onload?.());}});
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
 Object.defineProperty(HTMLVideoElement.prototype,'src',{configurable:true,set(this:HTMLVideoElement){queueMicrotask(()=>{Object.defineProperties(this,{videoWidth:{value:1024},videoHeight:{value:640}});this.onloadedmetadata?.(new Event('loadedmetadata'));});}});
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockImplementation(async(_b,path)=>path.endsWith('.mp4')?'deas-input-u.mp4':'deas-inputs/u.png');
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-v',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 vi.mocked(pollWorkbench).mockImplementation(async()=>collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async result=>({...await result.value,state:'succeeded' as const})))));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));
 expect(pipe('Multi-reference → Video').disabled).toBe(false);
 choosePipe('Video → Video');
 expect(screen.getByLabelText('Pipeline')).toHaveProperty('value','video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'clip.mp4'});
 expect(menuOf('ref.png').queryByRole('menuitem',{name:'Use as source video'})).toBeNull();fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(menuOf('clip.mp4').getByRole('menuitem',{name:'Use as source video'}));
 loadVideo('clip.mp4');
 expect(markOf('clip.mp4')).toBe('Source video');
 expect(document.querySelector('.wb-stage-mark')?.textContent).toBe('Source video');
 fireEvent.change(screen.getByLabelText('Source strength'),{target:{value:'0.7'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledWith('http://127.0.0.1:7801','/env/ComfyUI/input/clip.mp4');
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'ltx-2',sourceVideo:'deas-input-u.mp4',width:1280,height:704,ltx:{sourceStrength:0.7}});
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).not.toHaveProperty('firstFrame');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false),{timeout:5000});
 // Multi-reference: images only for LTX (no reference button on a video), placed at a second with a strength.
 choosePipe('Multi-reference → Video');
 expect(screen.queryByRole('button',{name:'Add as reference'})).toBeNull();
 expect(screen.getByLabelText('Pipeline')).toHaveProperty('value','video');
 const blocked=menuOf('clip.mp4').getByRole('menuitem',{name:/Add as reference/}) as HTMLButtonElement;
 expect(blocked.disabled).toBe(true);expect(blocked.textContent).toContain('LTX takes images as references only.');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'ref.png'}));adopt();
 const img=await screen.findByRole('img',{name:'ref.png'});
 Object.defineProperties(img,{naturalWidth:{value:1280},naturalHeight:{value:704}});fireEvent.load(img);
 fireEvent.click(screen.getAllByRole('button',{name:'Add as reference'})[0]);
 expect(markOf('ref.png')).toBe('@ 0 s');
 fireEvent.click(document.querySelector('[data-open-references]')!);
 expect(screen.getByRole('dialog',{name:'References'})).toBeTruthy();
 // A dock video dropped on the tab is refused with the reason (LTX references are images).
 const clip={name:'clip.mp4',path:'/env/ComfyUI/input/clip.mp4',media:'video',src:'asset://localhost//env/ComfyUI/input/clip.mp4'};
 fireEvent.drop(document.querySelector('[data-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(clip)}});
 expect(within(screen.getByRole('dialog',{name:'References'})).getByRole('alert').textContent).toBe('clip.mp4: LTX takes images as references only.');
 // The References tab button takes dock drops too (the Media tab is the drag source).
 const voice={name:'voice.wav',path:'/env/ComfyUI/input/voice.wav',media:'audio',src:'asset://localhost//env/ComfyUI/input/voice.wav'};
 fireEvent.drop(document.querySelector('[data-references]')!,{dataTransfer:{types:['application/x-deas-media'],getData:()=>JSON.stringify(voice)}});
 expect(within(screen.getByRole('dialog',{name:'References'})).getByRole('alert').textContent).toBe('voice.wav: LTX takes images as references only.');
 fireEvent.change(screen.getByLabelText('Second of ref.png'),{target:{value:'1'}});
 fireEvent.change(screen.getByLabelText('Strength of ref.png'),{target:{value:'0.5'}});
 expect(screen.queryByRole('button',{name:/Insert/})).toBeNull(); // Director labels are H3-only
 dock('Media');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'ref.png'});
 expect(markOf('ref.png')).toBe('@ 1 s');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 const second=vi.mocked(runWorkbenchJob).mock.calls[1][1];
 expect(second).toMatchObject({family:'ltx-2',ltx:{keyframes:[{image:'ref.png',frame:24,strength:0.5}]}});
 expect(second).toHaveProperty('sourceVideo','deas-input-u.mp4'); // source and guides coexist without losing either role
 fireEvent.click(menuOf('ref.png').getByRole('menuitem',{name:'Remove reference ref.png'}));
 expect(markOf('ref.png')).toBe('First frame'); // removing its guide leaves the independently assigned first-frame role
 // Leaving Multi-reference hides the References tab and falls back to Media.
 fireEvent.click(document.querySelector('[data-open-references]')!);dock('Media');choosePipe('Video → Video');
 expect(screen.queryByRole('tab',{name:'References'})).toBeNull();
 await waitFor(()=>expect(screen.getByRole('tab',{name:'Media'}).getAttribute('aria-selected')).toBe('true'));
});

test('IPC fixture: MiniMax H3 runs Video → Video and Multi-reference → Video as REF2VA timeline media',async()=>{
 // jsdom never loads media: the first reference's size is what Auto aspect waits for.
 vi.stubGlobal('Image',class{naturalWidth=1024;naturalHeight=640;onload?:()=>void;set src(_:string){queueMicrotask(()=>this.onload?.());}});
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
 Object.defineProperty(HTMLVideoElement.prototype,'src',{configurable:true,set(this:HTMLVideoElement){queueMicrotask(()=>{Object.defineProperties(this,{videoWidth:{value:1024},videoHeight:{value:640}});this.onloadedmetadata?.(new Event('loadedmetadata'));});}});
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3_ref2va.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3_ref2va.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>_c==='native_forge'?({models:[{id:'m',label:'M'}],errors:{},creativity:['x'],shot_counts:['Auto'],default_shots:'Auto'}):({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(uploadInput).mockImplementation(async(_b,path)=>path.endsWith('.mp4')?'deas-input-v.mp4':path.endsWith('.wav')?'deas-inputs/s.wav':'deas-inputs/i.png');
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-h',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 vi.mocked(pollWorkbench).mockImplementation(async()=>collection(await Promise.all(vi.mocked(runWorkbenchJob).mock.results.map(async result=>({...await result.value,state:'succeeded' as const})))));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" root="/env" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));
 choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();
 loadVideo('clip.mp4');
 dock('References');fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));fireEvent.change(screen.getByLabelText('Use of clip.mp4'),{target:{value:'video_audio'}});fireEvent.click(within(screen.getByRole('dialog',{name:'Edit clip.mp4'})).getByRole('button',{name:'Close'}));dock('Media');
 expect(screen.queryByText('MiniMax H3 runs these as REF2VA; pick a REF2VA checkpoint for best results.')).toBeNull();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toMatchObject({family:'minimax-h3',h3:{mode:'REF2VA',references:[],media:[{type:'video',file:'deas-input-v.mp4',slot:0,mediaMode:'video_audio'}]}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false),{timeout:5000});
 // Multi-reference: the video (sound only), an image and an audio clip; slots count per lane.
 choosePipe('Multi-reference → Video');
 fireEvent.click(screen.getByRole('button',{name:'clip.mp4'}));
 fireEvent.click(document.querySelector('[data-open-references]')!);
 fireEvent.click(screen.getByRole('button',{name:'Edit clip.mp4'}));
 fireEvent.change(screen.getByLabelText('Use of clip.mp4'),{target:{value:'audio'}});
 fireEvent.click(within(screen.getByRole('dialog',{name:'Edit clip.mp4'})).getByRole('button',{name:'Close'}));
 dock('Media');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 await screen.findByRole('button',{name:'voice.wav'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Add as reference'}));
 fireEvent.click(screen.getByRole('button',{name:'ref.png'}));adopt();
 expect(document.querySelector('[data-browsed-preview] img')?.getAttribute('alt')).toBe('ref.png');
 expect(markOf('ref.png')).toBe('<Picture 1>');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls[1][1]).toMatchObject({h3:{mode:'REF2VA',media:[
  {type:'video',file:'deas-input-v.mp4',slot:0,mediaMode:'audio'},{type:'audio',file:'deas-inputs/s.wav',slot:1},{type:'image',file:'deas-inputs/i.png',slot:0}]}});
 // Badges are the Director's prompt labels; the third sound track fills the audio lane, so a fourth is refused with the reason.
 expect([markOf('clip.mp4'),markOf('voice.wav'),markOf('ref.png')]).toEqual(['<Audio 1>','<Audio 2>','<Picture 1>']);
 fireEvent.click(menuOf('a2.wav').getByRole('menuitem',{name:'Add as reference'}));
 const full=menuOf('a3.wav').getByRole('menuitem',{name:/Add as reference/}) as HTMLButtonElement;
 expect(full.disabled).toBe(true);expect(full.textContent).toContain('Director limit reached');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(menuOf('voice.wav').getByRole('menuitem',{name:'Remove reference voice.wav'}));
 expect(markOf('voice.wav')).toBeUndefined();expect(markOf('a2.wav')).toBe('<Audio 2>');
 // References tab: a too-short trim blocks Run with the reason; a valid one reaches h3.media; labels go into the prompt.
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false),{timeout:5000});
 dock('References');
 expect(document.querySelector('.reference-assigned-heading .reference-count')?.getAttribute('title')).toBe('Images 1/9 · Videos 0/3 · Sound 2/3 · Files 3/12');
 fireEvent.click(screen.getByRole('button',{name:'Edit a2.wav'}));
 fireEvent.change(screen.getByLabelText('Start of a2.wav'),{target:{value:'1'}});
 fireEvent.change(screen.getByLabelText('End of a2.wav'),{target:{value:'2'}});
 expect(screen.getByRole('alert').textContent).toBe('A trimmed clip must last 2–15 s (end after start).');
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('End of a2.wav'),{target:{value:'4.5'}});
 fireEvent.click(within(screen.getByRole('dialog',{name:'Edit a2.wav'})).getByRole('button',{name:'Close'}));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'a singer'}});
 fireEvent.click(screen.getByRole('button',{name:'Insert <Audio 2> into the prompt'}));
 // Director input scaling: the default is Fill and crop, and it is always sent (absent also means Fill and crop on older jobs).
 expect((vi.mocked(runWorkbenchJob).mock.calls[1][1] as unknown as {h3:{inputScaling?:string}}).h3.inputScaling).toBe('Fill and crop');
 fireEvent.change(document.querySelector('[data-h3-scaling]')!,{target:{value:'Fit and pad'}});
 // RefMods: read the backend library on demand, add one; it travels as a Director RefMod row.
 vi.mocked(readRefMods).mockResolvedValue([{name:'chars/hero',kinds:['image'],description:'the hero'}]);
 fireEvent.click(screen.getByRole('button',{name:'Read RefMod library'}));
 fireEvent.click(await screen.findByRole('button',{name:'Add RefMod'}));
 expect(readRefMods).toHaveBeenCalledWith('http://127.0.0.1:7801');
 fireEvent.change(screen.getByLabelText('Strength of chars/hero'),{target:{value:'0.6'}});
 expect(screen.getByText('Fit the whole reference and pad to the canvas.')).toBeTruthy();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('a singer <Audio 2>');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 expect(vi.mocked(runWorkbenchJob).mock.calls[2][1]).toMatchObject({h3:{media:[
  {type:'video',slot:0,mediaMode:'audio'},{type:'image',slot:0},{type:'audio',slot:1,trimStart:1,trimEnd:4.5}],inputScaling:'Fit and pad',refmods:[{slot:1,name:'chars/hero',strength:0.6,description:'the hero'}]}});
 expect((vi.mocked(runWorkbenchJob).mock.calls[2][1] as unknown as {h3:{media:object[]}}).h3.media[0]).not.toHaveProperty('trimStart');
 // Director prompt helpers live in the hammer panel: open it, pick the LLM step. Prefill fills the REF2VA sections around the written text (RefMod after the timeline media); [Shot N] numbers on.
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 fireEvent.click(screen.getByRole('button',{name:'LLM · Prompt Forge'}));
 fireEvent.click(screen.getByRole('button',{name:'Prefill labels & summary'}));
 const prompt=()=>(screen.getByLabelText('Prompt') as HTMLTextAreaElement).value;
 expect(prompt()).toMatch(/^subject_definitions:\n<Picture 1> is an image reference.*\n<Audio 1> is the audio track selected from a video.*\n<Audio 2> is an audio reference.*\n<Picture 2> is a saved image reference \(RefMod 1\) User description: the hero\./);
 expect(prompt()).toContain('detailed_description:\na singer <Audio 2>');
 fireEvent.click(screen.getByRole('button',{name:'Insert [Shot N]'}));
 expect(prompt().endsWith('[Shot 1] ')).toBe(true);
});

test('IPC fixture: MiniMax H3 picture edits offer the H3 latent upscale after sampling; Inpaint disables it with a reason',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-u',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 const h3Model='minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors';
 // No video gate: a picture edit has no paired Original/Processed product.
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'LoadImage','DaSiWaH3TiledUpscale'],h3LatentUpscaleModels:[h3Model]}});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 choosePipe('Image → Image');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const img=(await screen.findAllByRole('img',{name:'ref.png'})).find(e=>e.classList.contains('wb-zoomable'))!;
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.click(screen.getByLabelText('Latent upscale after sampling'));
 fireEvent.change(screen.getByLabelText('Latent upscale model'),{target:{value:h3Model}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(intent).toMatchObject({family:'minimax-h3',h3Edit:{shiftVideo:expect.any(Number)},latentUpscale:{model:h3Model,scale:2,steps:1,denoise:0.2}});
 // Inpaint feeds a masked latent, which the node refuses: the card explains instead of sending it.
 fireEvent.click(screen.getByRole('tab',{name:'Media'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 fireEvent.click(document.querySelector('.wb-stage > [data-media-tools] [data-edit="inpaint"]')!);
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 await waitFor(()=>expect(document.querySelector('[data-post-unavailable="latent"]')?.textContent).toContain('masked latents'));
});

test('IPC fixture: MiniMax H3 offers Image → Image as the Director-style edit: shifts, denoise 1 by default, references from <Picture 2>, no refine pass',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 vi.mocked(runWorkbenchJob).mockImplementation(async()=>({id:'job-e',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false} as JobStatus));
 localStorage.setItem('deas.pref.studio.run.post',JSON.stringify(true)); // refine after every run is on, but H3 skips it
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...videoEvidence,allowlist:{...videoEvidence.allowlist,nodes:[...videoEvidence.allowlist.nodes,'LoadImage','MiniMaxH3ReferenceToVideo']}});
 vi.mocked(uploadInput).mockImplementation(async(_endpoint,path)=>`deas-inputs/${path.split('/').at(-1)}`);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));
 choosePipe('Image → Image');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
 const img=(await screen.findAllByRole('img',{name:'ref.png'})).find(e=>e.classList.contains('wb-zoomable'))!;
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(img);
 // Full regeneration by default; below 1 the encoded source is kept (still path).
 expect((screen.getByLabelText('Denoise') as HTMLInputElement).value).toBe('1');
 promptDrop('image','/outside/jacket.png');promptDrop('image','/outside/pose.png');
 // <Picture 1> is the edited picture, so references are numbered from 2.
 expect(Array.from(document.querySelectorAll('[data-reference-controls] .wb-reference-position')).map(e=>e.textContent)).toEqual(['2','3']);
 expect(document.querySelector('[data-reference-chip]')!.textContent).toContain('<Picture 2>');
 expect(document.querySelector<HTMLImageElement>('[data-reference-source] img')!.alt).toBe('ref.png');
 expect(document.querySelector('[data-reference-source] .wb-reference-position')!.textContent).toBe('1');
 // H3 has no refine pass: More keeps the Refine entry, disabled with its reason.
 expect(screen.getByRole('button',{name:'Refine'})).toMatchObject({disabled:true,title:expect.stringContaining('MiniMax H3')});
 fireEvent.change(screen.getByLabelText('Shift video'),{target:{value:'11'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 const intent=vi.mocked(runWorkbenchJob).mock.calls[0][1];
 expect(intent).toMatchObject({recipeId:'checkpoint-text-to-image-diagnostic',checkpoint:'MiniMaxH3/h3.safetensors',inputImage:'ref.png',denoise:1,diffusion:{clipType:'minimax'},h3Edit:{shiftVideo:11,shiftAudio:3},nativeImageReference:{method:'minimax-h3',images:['deas-inputs/jacket.png','deas-inputs/pose.png']}});
 expect(intent).not.toHaveProperty('refine');
 // <Picture 1> is the source card at the head of the bar; clearing it promotes the first reference.
 const source=()=>document.querySelector<HTMLImageElement>('[data-reference-source] img')?.alt;
 const badges=()=>Array.from(document.querySelectorAll('[data-reference-controls] .wb-reference-position')).map(e=>e.textContent);
 fireEvent.click(document.querySelector('[data-reference-source-remove]')!);
 expect(source()).toBe('jacket.png');expect(badges()).toEqual(['2']);
 fireEvent.click(document.querySelector('[data-reference-source-remove]')!);
 fireEvent.click(document.querySelector('[data-reference-source-remove]')!);
 expect(document.querySelector('[data-reference-source]')).toBeNull();
 // Without a source, the first picture added as reference becomes <Picture 1>.
 promptDrop('image','/outside/face.png');
 expect(source()).toBe('face.png');expect(badges()).toEqual([]);
 promptDrop('image','/outside/coat.png');
 expect(badges()).toEqual(['2']);
 // References overlay (image mode): same bar and picker; a picker click adds like the right-click entry.
 const button=document.querySelector<HTMLButtonElement>('[data-open-references]')!;
 expect(button.textContent).toContain('1');
 fireEvent.click(button);
 const dialog=screen.getByRole('dialog',{name:'References'});
 const bar=dialog.querySelector('[data-image-references]')!;
 expect(bar.querySelector<HTMLImageElement>('[data-reference-source] img')!.alt).toBe('face.png');
 fireEvent.click(within(within(dialog).getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await within(dialog).findByRole('button',{name:'ref.png'}));
 expect(bar.querySelectorAll('[data-reference-controls]')).toHaveLength(1);
 fireEvent.click(dialog.querySelector('[data-image-role="reference"]')!);
 expect(Array.from(bar.querySelectorAll('[data-reference-controls] .wb-reference-position')).map(e=>e.textContent)).toEqual(['2','3']);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'Edit <Picture 1>:'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Insert <Picture 3> into the prompt'}));
 expect(screen.getByLabelText('Prompt')).toHaveProperty('value','Edit <Picture 1>: <Picture 3>');
 // A reference card's "Use as picture to edit" swaps it with <Picture 1> (H3 keeps the old picture as that reference).
 const cards=()=>Array.from(bar.querySelectorAll<HTMLElement>('[data-reference-controls]'));
 fireEvent.click(cards()[1].querySelector<HTMLButtonElement>('[data-reference-make-source]')!);
 expect(bar.querySelector<HTMLImageElement>('[data-reference-source] img')!.alt).toBe('ref.png');
 expect(cards().map(c=>c.querySelector('img')!.alt)).toEqual(['coat.png','face.png']);
 // One Image pipeline: no separate Text → Image / Image → Image entries.
 expect(screen.queryByRole('option',{name:'Text → Image'})).toBeNull();expect(screen.queryByRole('option',{name:'Image → Image'})).toBeNull();
 fireEvent(dialog,new Event('cancel',{cancelable:true}));
 expect(screen.queryByRole('dialog',{name:'References'})).toBeNull();expect(document.activeElement).toBe(button);
 expect(button.textContent).toContain('2');
});

test.each(['relocated','deleted'] as const)('H3 image reference picker cannot resurrect a %s selection with Add',async lifecycle=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a',size:1,info:null}]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string})?.path,parent:'/env',entries:mediaEntries,truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/ComfyUI/input'}}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Image → Image').disabled).toBe(false));choosePipe('Image → Image');
 promptDrop('image','/outside/source.png');
 fireEvent.click(document.querySelector('[data-open-references]')!);
 const dialog=screen.getByRole('dialog',{name:'References'});
 fireEvent.click(within(within(dialog).getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await within(dialog).findByRole('button',{name:'ref.png'}));
 const add=within(dialog).getByRole('button',{name:'Add as reference'});
 expect(add).toHaveProperty('disabled',false);
 expect(add.title).toBe('ref.png');
 expect(dialog.querySelectorAll('[data-reference-controls]')).toHaveLength(0);
 const oldPath='/env/ComfyUI/input/ref.png',path='/env/ComfyUI/input/starred/renamed.png';
 if(lifecycle==='relocated'){
  fireEvent(window,new CustomEvent('deas-media-relocated',{detail:{oldPath,path}}));
  expect(add).toHaveProperty('disabled',false);
  expect(add.title).toBe('renamed.png');
  fireEvent.click(add);
  const card=dialog.querySelector('[data-reference-controls]')!;
  expect(dialog.querySelectorAll('[data-reference-controls]')).toHaveLength(1);
  expect(card.querySelector('strong')?.title).toBe(path);
  expect(card.querySelector('img')).toMatchObject({alt:'renamed.png'});
  expect(card.querySelector('img')?.getAttribute('src')).toBe(`asset://localhost/${path}`);
  expect(card.innerHTML).not.toContain(oldPath);
 }else{
  fireEvent(window,new CustomEvent('deas-media-deleted',{detail:{deleted:[oldPath],failed:[]}}));
  expect(add).toHaveProperty('disabled',true);
  expect(add.title).toBe('');
  fireEvent.click(add);
  expect(dialog.querySelectorAll('[data-reference-controls]')).toHaveLength(0);
 }
 expect(dialog.querySelector<HTMLImageElement>('[data-reference-source] img')?.alt).toBe('source.png');
 expect(uploadInput).not.toHaveBeenCalled();expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['image','ltx-2','wan','minimax-h3'] as const)('Run Plan uses the exact next Run intent without preparing, uploading or losing draft state (%s)',async family=>{
 const m=(category:string,name:string,f?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(f?{family:f}:{})});
 const list=family==='image'?[m('checkpoints','base.safetensors','sdxl'),m('loras','style.safetensors','sdxl')]
  :family==='ltx-2'?[m('unet','ltx.safetensors',family),m('text_encoders','gemma_3_12B_it_fp8.safetensors'),m('text_encoders','ltx-2.3_text_projection_bf16.safetensors'),m('vae','LTX23_video_vae_bf16.safetensors'),m('vae','LTX23_audio_vae_bf16.safetensors')]
  :family==='wan'?[m('diffusion_models','wan_high_noise.safetensors',family),m('diffusion_models','wan_low_noise.safetensors',family),m('text_encoders','umt5_xxl_fp8.safetensors'),m('vae','wan_2.1_vae.safetensors')]
  :[m('diffusion_models','h3.safetensors',family),m('text_encoders','qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),m('vae','minimax_h3_video_vae_fp16.safetensors'),m('vae','minimax_h3_audio_vae_fp32.safetensors')];
 vi.mocked(scanModels).mockResolvedValue(list);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,checkpoints:['base.safetensors'],diffusionModels:['ltx.safetensors','wan_high_noise.safetensors','wan_low_noise.safetensors','h3.safetensors'],nodes:[...evidence.allowlist.nodes,'UNETLoader','DEAS_ImagePostprocessGate','DaSiWa_WildcardPresetPromptBuilder']}});
 const options={...defaultOptions,outputNaming:'test/%seed%'};
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify(options));
 localStorage.setItem('deas.pref.studio.run.seed','42');
 localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify('fixed'));
 localStorage.setItem('deas.pref.studio.run.positive',JSON.stringify('live forest'));
 localStorage.setItem('deas.pref.studio.run.post','true');
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 if(family==='image'){
  localStorage.setItem('deas.pref.studio.run.upscale','2');
  localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:'style.safetensors',strength:0.7}]));
  localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 }
 vi.mocked(runWorkbenchJob).mockResolvedValue({id:'same-job',baseUrl:evidence.baseUrl,promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/input',output:'/output'}};
 const view=render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());
 if(family!=='image'){const name=family==='wan'?'Image → Video':'Text → Video';await waitFor(()=>expect(pipe(name).disabled).toBe(false));choosePipe(name);}
 if(family==='wan'){
  fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
  fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));adopt();
  const ref=screen.getByRole('img',{name:'ref.png'});
  Object.defineProperties(ref,{naturalWidth:{value:720},naturalHeight:{value:1280}});fireEvent.load(ref);
 }
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'edited live forest'}});
 const shell=view.container.querySelector('[data-workbench]');
 view.rerender(<I18nProvider><Workbench {...props} planVisible/></I18nProvider>);
 const shown=()=>JSON.parse(view.container.querySelector('[data-plan-intent]')!.textContent!);
 expect(shown()).toMatchObject({positivePrompt:'edited live forest',seed:42,outputPrefix:'raw/test/42'});
 const preview=shown();
 expect(preview).not.toHaveProperty('componentOverrides');
 if(family==='image')expect(preview).toMatchObject({refine:{width:2048,height:2048},loras:[{name:'style.safetensors',strength:0.7}],wildcard:expect.any(Object)});
 else {expect(preview.family).toBe(family);expect(preview.refine).toBeUndefined();expect(preview.wildcard).toBeUndefined();expect(screen.getByRole('region',{name:'Run Plan'}).querySelector('[data-plan-stage="refine"]')).toBeNull();}
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(uploadInput).not.toHaveBeenCalled();expect(uploadMask).not.toHaveBeenCalled();
 view.rerender(<I18nProvider><Workbench {...props}/></I18nProvider>);
 expect(view.container.querySelector('[data-workbench]')).toBe(shell);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][1]).toEqual(preview);
});

test('prompt fields expand into a floating editor that edits the same text and closes with Escape',async()=>{
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801"/></I18nProvider>);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'a castle'}});
 fireEvent.click(screen.getByRole('button',{name:'Expand Prompt into a floating editor'}));
 const big=within(screen.getByRole('dialog',{name:'Prompt'})).getByRole('textbox',{name:'Prompt'}) as HTMLTextAreaElement;
 expect(big.value).toBe('a castle');
 expect(document.querySelector('[data-prompt-count="positive"]')?.textContent).toBe('8 / 16384');
 expect(document.querySelector('[data-prompt-count="negative"]')?.textContent).toBe('0 / 16384');
 expect(big.getAttribute('spellcheck')).toBe('false'); // in the app DEAS checks the text itself; the WebView checker stays off
 fireEvent.change(big,{target:{value:'a castle at dawn'}});
 expect(within(screen.getByRole('dialog',{name:'Prompt'})).getByRole('button',{name:'Prompt Forge'})).toBeTruthy();
 expect((document.querySelector('[data-run-positive]') as HTMLTextAreaElement).value).toBe('a castle at dawn');
 fireEvent.keyDown(window,{key:'Escape'});
 expect(screen.queryByRole('dialog',{name:'Prompt'})).toBeNull();
 // Both directions: the inline field feeds the open editor too.
 fireEvent.click(screen.getByRole('button',{name:'Expand Prompt into a floating editor'}));
 fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:'inline edit'}});
 expect((within(screen.getByRole('dialog',{name:'Prompt'})).getByRole('textbox',{name:'Prompt'}) as HTMLTextAreaElement).value).toBe('inline edit');
 fireEvent.keyDown(window,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'Expand Negative prompt into a floating editor'}));
 fireEvent.change(within(screen.getByRole('dialog',{name:'Negative prompt'})).getByRole('textbox'),{target:{value:'blurry'}});
 expect((document.querySelector('[data-run-negative]') as HTMLTextAreaElement).value).toBe('blurry');
 fireEvent.click(within(screen.getByRole('dialog',{name:'Negative prompt'})).getByRole('button',{name:'Close editor'}));
 expect(screen.queryByRole('dialog')).toBeNull();
});

test.each(['moss.safetensors','a.safetensors'])('image Wildcards block %s until its plugin is available or explicitly disabled',async(checkpoint)=>{
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 await mountMoss([...mossNodes,...evidence.allowlist.nodes]);
 fireEvent.change(screen.getByLabelText('Checkpoint'),{target:{value:checkpoint}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('DaSiWa_WildcardPresetPromptBuilder');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));expect(runWorkbenchJob).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Disable wildcards'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('wildcard');
});

test.each(['moss.safetensors','a.safetensors'])('image Wildcards preserve enabled intent for %s with its plugin available',async(checkpoint)=>{
 localStorage.setItem('deas.pref.studio.run.wildcardEnabled','true');
 await mountMoss([...mossNodes,...evidence.allowlist.nodes,'DaSiWa_WildcardPresetPromptBuilder']);
 fireEvent.change(screen.getByLabelText('Checkpoint'),{target:{value:checkpoint}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toHaveProperty('wildcard');
});

test.each([false,true])('MOSS reference readiness follows the active encoder without CLIPTextEncode (i2i=%s)',async imageToImage=>{
 if(imageToImage)vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss([...mossNodes.filter(n=>n!=='CLIPTextEncode'),'DEAS_ImagePromptEncode']);
 if(imageToImage)await mossInput(512,768);
 const run=screen.getByRole('button',{name:'Run'}) as HTMLButtonElement;
 expect(run.disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('CLIPTextEncode');
 expect(promptDrop().dropEffect).toBe('copy');
 expect(run.disabled).toBe(false);
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/ref.png');
 fireEvent.click(run);await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({
  checkpoint:'moss.safetensors',nativeImageReference:{method:'moss-image',images:['deas-inputs/ref.png']},
  ...(imageToImage?{inputImage:'source.png'}:{}),
 });
 fireEvent.click(document.querySelector('[data-reference-remove]')!);
 expect(run.disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('CLIPTextEncode');
});

test.each([...mossNodes.filter(n=>!['LoadImage','VAEEncode','ImageScale','LoadImageMask','SetLatentNoiseMask','ImageCompositeMasked'].includes(n)), 'moss_image'])('MOSS blocks t2i when emitted capability %s is missing',async(missing)=>{
 await mountMoss(mossNodes.filter(n=>n!==missing),missing==='moss_image'?[]:['moss_image']);
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(missing);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('MOSS model switch preserves empty negative and sends default skip layers; empty omits them',async()=>{
 await mountMoss();
 dock('Models');
 fireEvent.click(await screen.findByRole('button',{name:/moss\.safetensors/}));
 // Family defaults update sampling and keep SLG layers 22, but preserve authored prompts.
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('50');
 expect(document.querySelector<HTMLTextAreaElement>('[data-run-negative]')!.value).toBe('');
 const skip=document.querySelector<HTMLInputElement>('[data-moss-skip-layers]')!;
 expect(skip.value).toBe('22');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({checkpoint:'moss.safetensors',skipLayers:'22',negativePrompt:''});
 // Empty field means the unchanged graph without the SLG node.
 fireEvent.change(skip,{target:{value:''}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('skipLayers');
});

test.each([['SaveImage'],['DaSiWa_MetadataImageSaver','DaSiWa_MetadataConfig']])('MOSS uses the available saver %s without checkpoint diagnostic nodes',async(...saver)=>{
 await mountMoss([...mossNodes.filter(n=>n!=='SaveImage'),...saver]);
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
});

test.each(['off','auto'])('MOSS blocks an unaligned source in %s without hiding its declared size',async(mode)=>{
 localStorage.setItem('deas.pref.studio.run.inputScaling',JSON.stringify(mode));
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!=='EmptyFlux2LatentImage'));
 await mossInput();
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(document.body.textContent).toContain('Choose Target, Fit or Crop');
 expect(screen.getByTestId('editor-world').style.width).toBe('520px');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['fit','crop','target'])('MOSS explicit %s resizes an unaligned source and i2i does not need an empty latent',async(mode)=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!=='EmptyFlux2LatentImage'));await mossInput();
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:mode}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).toMatchObject({inputImage:'source.png',inputResize:{crop:mode==='crop'?'center':'disabled'}});
 expect(screen.getByTestId('editor-world').style.width).toBe('520px');
});

test.each([
 ['attention',{attention:'a:test'},'Attention backend'],
 ['cache',{cache:'EasyCache'},'Step cache'],
 ['compile',{compile:'inductor'},'torch.compile'],
 ['vae',{vae:'tiled'},'VAE processing'],
 ['sigmas',{sigmas:'1, 0.5, 0'},'Custom sigmas'],
] as const)('MOSS blocks remembered %s independently and preserves unrelated options on reset',async(_key,patch,label)=>{
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,...patch,outputNaming:'keep/%seed%'}));
 await mountMoss();
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain('MOSS-Image supports plain generation');
 fireEvent.click(screen.getByRole('button',{name:`Restore ${label} defaults`}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.options')!).outputNaming).toBe('keep/%seed%');
});

test('MOSS ignores a disabled retained LoRA without clearing its draft',async()=>{
 const selected=[{name:'unknown.safetensors',strength:0.5,enabled:false}];
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify(selected));
 await mountMoss();
 expect(screen.getByRole('button',{name:'Run'})).toHaveProperty('disabled',false);
 expect(screen.queryByRole('button',{name:'Restore LoRAs defaults'})).toBeNull();
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.loras')!)).toEqual(selected);
});

test('MOSS blocks an unknown-family LoRA until it is explicitly removed',async()=>{
 localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify([{name:'unknown.safetensors',strength:0.5}]));
 await mountMoss();
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore LoRAs defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
});

test.each(['LoadImage','VAEEncode','ImageScale'])('MOSS i2i blocks its emitted %s capability',async(missing)=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!==missing));await mossInput(512);
 if(missing==='ImageScale'){
  expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'fit'}});
 }
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('alert').textContent).toContain(missing);
});

test('MOSS retains unsupported pad until a visible reset',async()=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss();await mossInput(512);
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'pad'}});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore Input scaling defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 // More stays visible on MOSS images; only its Refine/Upscale passes are unavailable.
 expect(document.querySelector('summary[data-more]')).not.toBeNull();
 for(const pass of ['[data-run-post]','[data-run-upscale]'])expect(document.querySelector<HTMLButtonElement>(pass)).toMatchObject({disabled:true,title:expect.stringContaining('MOSS')});
});

test('MOSS Inpaint is compatible and checks its mask nodes',async()=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 await mountMoss(mossNodes.filter(n=>n!=='SetLatentNoiseMask'));await mossInput(512);
 fireEvent.click(document.querySelector('[data-edit="inpaint"]')!);
 expect(screen.queryByRole('button',{name:'Restore Inpaint defaults'})).toBeNull();
 expect(screen.getByRole('alert').textContent).toContain('SetLatentNoiseMask');
});

test('MOSS disables inserted layers explicitly without deleting the editor draft',async()=>{
 vi.mocked(invoke).mockResolvedValue({path:'/input',parent:'/',entries:[{name:'source.png',path:'/input/source.png',kind:'file',media:'image',size:1,modified:1}],truncated:false});
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 await mountMoss();await mossInput(512);dropTile('source.png');
 await screen.findByRole('group',{name:'Inserted image source.png'});
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore Layers defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 expect(screen.queryByRole('group',{name:'Inserted image source.png'})).toBeNull();
 expect(screen.getByTestId('editor-world').style.width).toBe('512px');
});

test('MOSS retains incompatible options and post on a family switch until explicit per-feature resets',async()=>{
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({...defaultOptions,cache:'EasyCache',outputNaming:'kept/%seed%'}));
 localStorage.setItem('deas.pref.studio.run.post','true');
 await mountMoss([...mossNodes,'EasyCache']);
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 expect(localStorage.getItem('deas.pref.studio.run.post')).toBe('true');
 fireEvent.click(screen.getByRole('tab',{name:/^Options/}));expect((screen.getByLabelText('Step cache') as HTMLSelectElement).value).toBe('EasyCache');
 fireEvent.click(screen.getByRole('button',{name:'Restore Step cache defaults'}));
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore Post-Processing defaults'}));
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.options')!).outputNaming).toBe('kept/%seed%');
 expect((screen.getByRole('button',{name:'Run'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalled());
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('options');
 expect(vi.mocked(runWorkbenchJob).mock.lastCall![1]).not.toHaveProperty('refine');
});

test('three rapid Run presses capture prompts and distinct random seeds while IPC is pending',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a',size:1,info:null}]);
 const replies:((job:JobStatus)=>void)[]=[];
 vi.mocked(runWorkbenchJob).mockImplementation(()=>new Promise(resolve=>replies.push(resolve)));
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 const run=document.querySelector<HTMLButtonElement>('[data-run]')!;
 await waitFor(()=>expect(run.disabled).toBe(false));
 for(const prompt of ['one','two','three']){fireEvent.change(document.querySelector('[data-run-positive]')!,{target:{value:prompt}});fireEvent.click(run);}
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(3));
 const calls=vi.mocked(runWorkbenchJob).mock.calls;
 expect(calls.map(c=>c[1].positivePrompt)).toEqual(['one','two','three']);
 expect(new Set(calls.map(c=>c[1].seed)).size).toBe(3);
 expect(calls.map(c=>c[2])).toEqual([0,0,0]);expect(run.textContent).toContain('Run');
 view.unmount();await act(async()=>replies.forEach((reply,i)=>reply(heldJob('rapid-'+i,'queued'))));
});

test('Stop discards every unsent image preparation without claiming upload cancellation',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',family:'sdxl',path:'/m/a.safetensors',size:1,info:null}]);
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'a.safetensors',pipeline:'i2i'},input:{id:'input-1',path:'/projects/one/assets/input.png',sha256:'a'.repeat(64),width:1024,height:1024}};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_project_open'?saved:{entries:[],truncated:false});
 let release!:(name:string)=>void;const pending=new Promise<string>(yes=>{release=yes;});vi.mocked(uploadInput).mockReturnValue(pending);
 const props={endpoint:evidence.baseUrl,roots:{models:'/m',input:'/env/in'}};
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(2));
 stopAll();
 await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledTimes(1));
 await act(async()=>release('deas-inputs/late.png'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
 expect(document.querySelector('[data-run-stop]')).toBeNull();expect(pollWorkbench).not.toHaveBeenCalled();
});

test('Stop drops delayed video preparation and the next press uses the new native epoch',async()=>{
 vi.mocked(scanModels).mockResolvedValue([...ltxModels]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:mediaEntries,truncated:false}));
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockReturnValueOnce(new Promise(yes=>{release=yes;}));
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>{
  const job={...heldJob('late-upload-job','queued',baseUrl),intent};
  vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job]));
  vi.mocked(pollWorkbench).mockResolvedValue(collection([job]));
  return job;
 });
 const props={endpoint:'http://127.0.0.1:7801',roots:{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}};
 render(<I18nProvider><Workbench {...props}/></I18nProvider>);
 await waitFor(()=>expect(pipe('Video → Video').disabled).toBe(false));choosePipe('Video → Video');
 fireEvent.click(within(screen.getByRole('group',{name:'Environment folders'})).getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'clip.mp4'}));adopt();loadVideo('clip.mp4');
 await waitFor(()=>expect((document.querySelector('[data-run]') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(1));
 stopAll();
 await screen.findByText('No native work remained. Unsent preparations were discarded.');
 await act(async()=>release('deas-inputs/late.mp4'));
 expect(runWorkbenchJob).not.toHaveBeenCalled();
 expect(document.querySelectorAll('[data-job-id]')).toHaveLength(0);
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/new.mp4');fireEvent.click(document.querySelector('[data-run]')!);
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));expect(vi.mocked(runWorkbenchJob).mock.calls[0][2]).toBe(1);
});

test.each(['empty','settled','partial'] as const)('Stop %s preserves native products, stays quiet on partial and frees the queue',async outcome=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const product={...heldJob('product','succeeded'),outputs:[{filename:'keep.png',subfolder:'',type:'output' as const}],outputRoot:'/old/output'};
 const unknown=heldJob('foreign','unknown');
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([product,unknown]));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([product,unknown]),admissionEpoch:1,outcome,discarded:0,issues:outcome==='partial'?[{jobId:unknown.id,error:'Foreign backend: scoped interruption unsupported'}]:[]});
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="foreign"]')).not.toBeNull());
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'1'}});
 expect(document.querySelector<HTMLButtonElement>('[data-run-stop]')!.disabled).toBe(false);
 stopAll();
 await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledTimes(1));
 if(outcome==='partial'){await waitFor(()=>expect(document.querySelector('[data-run-stop]')).toBeNull());expect(document.querySelector('[data-run-stop-status]')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();}
 else await waitFor(()=>expect(document.querySelector('[data-run-stop-status]')!.textContent).toContain(outcome==='empty'?'No native work':'Stop finished'));
 expect(document.querySelector('[data-job-id="foreign"] [data-state]')!.getAttribute('data-state')).toBe('unknown');
 expect(document.querySelector('[data-job-id="product"] img')!.getAttribute('src')).toContain('/old/output/keep.png');
 expect(screen.queryByRole('button',{name:/Running/})).toBeNull();
 // The stopped unknown job no longer holds the Workbench: Stop is gone until new work starts.
 expect(document.querySelector('[data-run-stop]')).toBeNull();
 expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('without backend capabilities Studio shows one calm notice and disables Run, never dependency warnings',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 localStorage.setItem('deas.pref.studio.run.options',JSON.stringify({attention:'sage'}));
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 const run=await screen.findByRole('button',{name:'Run'});
 await waitFor(()=>expect(run.title).toBe('Backend not ready – backend features unavailable.'));
 expect(run.hasAttribute('disabled')).toBe(true);
 expect(screen.getByText('Backend not ready – backend features unavailable.')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
 expect(document.body.textContent).not.toContain('Unavailable or incompatible');
});

test.each(['selected','cancel','escape'] as const)('Stop choice %s preserves a peer upload and admission epoch',async action=>{
 const previous={invoke:vi.mocked(invoke).getMockImplementation(),upload:vi.mocked(uploadInput).getMockImplementation(),run:vi.mocked(runWorkbenchJob).getMockImplementation()};
 try{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(uploadInput).mockReset();vi.mocked(runWorkbenchJob).mockReset();
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const saved={...projectFixture,draft:{...projectFixture.draft,checkpoint:'a.safetensors',pipeline:'i2i'},input:{id:'input-1',path:'/projects/one/assets/input.png',sha256:'a'.repeat(64),width:1024,height:1024}};
 vi.mocked(invoke).mockImplementation(async c=>c==='native_project_open'?saved:{entries:[],truncated:false});
 let release!:(name:string)=>void;
 vi.mocked(uploadInput).mockResolvedValueOnce('deas-inputs/first.png').mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
 let snapshot={...collection(),admissionEpoch:7};
 vi.mocked(readCurrentWorkbench).mockImplementation(async()=>snapshot);vi.mocked(pollWorkbench).mockImplementation(async()=>snapshot);
 vi.mocked(runWorkbenchJob).mockImplementation(async(baseUrl,intent)=>{const job={...heldJob(snapshot.jobs.length?'second':'first','queued',baseUrl),intent};snapshot={...snapshot,jobs:[...snapshot.jobs,job]};return job;});
 vi.mocked(stopWorkbenchJob).mockImplementation(async job=>{const next={...job,state:'cancelled' as const};snapshot={...snapshot,jobs:[next]};return next;});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',input:'/env/in'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Open project'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open project'}));
 await waitFor(()=>expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('saved project prompt'));
 const run=screen.getByRole('button',{name:'Run'});await waitFor(()=>expect(run.hasAttribute('disabled')).toBe(false));
 fireEvent.click(run);await waitFor(()=>expect(document.querySelector('[data-job-id="first"]')).not.toBeNull());
 await waitFor(()=>expect(run.hasAttribute('disabled')).toBe(false),{timeout:2500});
 fireEvent.click(run);await waitFor(()=>expect(uploadInput).toHaveBeenCalledTimes(2));
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 const menu=screen.getByRole('menu',{name:'Stop Workbench work'});
 if(action==='escape')fireEvent.keyDown(document,{key:'Escape'});
 else if(action==='selected')fireEvent.click(within(menu).getByRole('menuitem',{name:'Stop current run'}));
 else fireEvent.mouseDown(document.body);
 if(action==='selected')await waitFor(()=>expect(stopWorkbenchJob).toHaveBeenCalledTimes(1));else expect(stopWorkbenchJob).not.toHaveBeenCalled();
 await act(async()=>release('deas-inputs/second.png'));
 await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(runWorkbenchJob).mock.calls.map(call=>call[2])).toEqual([7,7]);expect(stopWorkbench).not.toHaveBeenCalled();
 await waitFor(()=>expect(document.querySelector('[data-job-id="second"]')).not.toBeNull());
 }finally{cleanup();vi.mocked(invoke).mockImplementation(previous.invoke!);vi.mocked(uploadInput).mockReset().mockImplementation(previous.upload!);vi.mocked(runWorkbenchJob).mockReset().mockImplementation(previous.run!);}
});

test('Stop choice disables a captured item that finishes while the menu is open',async()=>{
 const selected=heldJob('selected','running'),peer=heldJob('peer','queued');
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([peer,selected]));
 vi.mocked(pollWorkbench).mockResolvedValue(collection([peer,{...selected,state:'succeeded'}]));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 const button=screen.getByRole('menuitem',{name:'Stop current run'});
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(true),{timeout:2500});
 expect(button.title).toBe('This run has already finished.');
 fireEvent.click(button);expect(stopWorkbenchJob).not.toHaveBeenCalled();expect(stopWorkbench).not.toHaveBeenCalled();
});

test.each(['running'] as const)('Stop choice pins the %s current run and leaves peers progressing',async state=>{
 const selected=heldJob('selected',state),peer=heldJob('peer','queued');
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([peer,selected]));
 vi.mocked(stopWorkbenchJob).mockResolvedValue({...selected,state:'cancelled'});
 vi.mocked(pollWorkbench).mockResolvedValue(collection([{...peer,state:'running'},{...selected,state:'cancelled'}]));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="selected"]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 const menu=screen.getByRole('menu',{name:'Stop Workbench work'});
 expect(document.activeElement).toBe(within(menu).getByRole('menuitem',{name:'Stop current run'}));
 expect(stopWorkbenchJob).not.toHaveBeenCalled();expect(stopWorkbench).not.toHaveBeenCalled();
 // Selection changes while the menu is open must not retarget the captured item.
 fireEvent.click(document.querySelector('[data-job-id="peer"] .wb-queue-select')!);
 fireEvent.click(within(menu).getByRole('menuitem',{name:'Stop current run'}));
 await waitFor(()=>expect(stopWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({id:'selected',state})));
 expect(stopWorkbench).not.toHaveBeenCalled();
 await waitFor(()=>expect(document.querySelector('[data-job-id="peer"] [data-state]')?.getAttribute('data-state')).toBe('running'),{timeout:2500});
});

test('Stop on a single run stops it directly without a choice menu',async()=>{
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([heldJob('only','running')]));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([heldJob('only','cancelled')]),admissionEpoch:1,outcome:'settled',discarded:0,issues:[]});
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 const trigger=document.querySelector<HTMLButtonElement>('[data-run-stop]')!;
 expect(trigger.hasAttribute('aria-haspopup')).toBe(false);expect(trigger.title).toBe('Stop current run');
 fireEvent.click(trigger);
 expect(screen.queryByRole('menu')).toBeNull();
 await waitFor(()=>expect(stopWorkbench).toHaveBeenCalledTimes(1));expect(stopWorkbenchJob).not.toHaveBeenCalled();
});

test.each(['outside','escape'] as const)('Stop choice %s leaves jobs and preparation untouched and restores focus',async action=>{
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([heldJob('held','running')],1));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 const trigger=document.querySelector<HTMLButtonElement>('[data-run-stop]')!;trigger.focus();fireEvent.click(trigger);
 screen.getByRole('menu',{name:'Stop Workbench work'});
 if(action==='outside'){fireEvent.mouseDown(document.body);trigger.focus();}else fireEvent.keyDown(document,{key:'Escape'});
 expect(screen.queryByRole('menu',{name:'Stop Workbench work'})).toBeNull();expect(document.activeElement).toBe(trigger);
 expect(stopWorkbench).not.toHaveBeenCalled();expect(stopWorkbenchJob).not.toHaveBeenCalled();
 expect(document.querySelector('[data-job-id="held"] [data-state]')?.getAttribute('data-state')).toBe('running');
});

test.each(['missing','succeeded','unknown','unsupported'] as const)('Stop choice explains disabled %s selection',async state=>{
 const selected=heldJob('selected',state==='unsupported'?'running':state==='missing'?'queued':state);
 vi.mocked(readCurrentWorkbench).mockResolvedValue({...collection(state==='missing'?[]:[selected],2),stopAvailable:state!=='unsupported'});
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);
 const menu=screen.getByRole('menu',{name:'Stop Workbench work'}),button=within(menu).getByRole('menuitem',{name:'Stop current run'});
 expect(button.hasAttribute('disabled')).toBe(true);expect(button.getAttribute('title')).toBeTruthy();
 expect(within(menu).getByText(button.getAttribute('title')!)).toBeTruthy();
 fireEvent.click(button);expect(stopWorkbenchJob).not.toHaveBeenCalled();expect(stopWorkbench).not.toHaveBeenCalled();
});

test.each(['rejected','unknown'] as const)('selected Stop keeps %s truthful without global fallback',async outcome=>{
 const job={...heldJob('retained','running'),outputs:[{filename:'keep.png',subfolder:'',type:'output' as const}],outputRoot:'/old/output'};
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job],1));
 if(outcome==='rejected')vi.mocked(stopWorkbenchJob).mockRejectedValue(new Error('Scoped interrupt unsupported'));
 else vi.mocked(stopWorkbenchJob).mockResolvedValue({...job,state:'unknown',error:'Scoped interrupt outcome unknown'});
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);fireEvent.click(screen.getByRole('menuitem',{name:'Stop current run'}));
 await waitFor(()=>expect(document.querySelector('.wb-stage-warning[role="alert"]')?.textContent).toContain(outcome==='rejected'?'Scoped interrupt unsupported':'Scoped interrupt outcome unknown'));
 expect(stopWorkbench).not.toHaveBeenCalled();expect(document.querySelector('[data-job-id="retained"] [data-state]')?.getAttribute('data-state')).toBe(outcome==='rejected'?'running':'unknown');
});

test('selected Stop owns only its H3 Run all sequence',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/h3',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a',size:1,info:null}]);
 localStorage.setItem('deas.pref.studio.run.pipeline','"t2v"');
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(videoEvidence);
 const job=heldJob('continuity-selected-stop','queued');
 vi.mocked(runWorkbenchJob).mockResolvedValue(job);
 vi.mocked(pollWorkbench).mockResolvedValue(collection([job]));
 vi.mocked(stopWorkbenchJob).mockResolvedValue({...job,state:'cancelled'});
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Continuity · off'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'Continuity active'}));
 fireEvent.click(screen.getByRole('button',{name:'Add step'}));fireEvent.click(screen.getByRole('button',{name:'Add step'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run all'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run all'}));
 fireEvent.click(within(screen.getByRole('dialog',{name:'Continuity'})).getByRole('button',{name:'Close'}));
 await waitFor(()=>expect(document.querySelector('[data-job-id="continuity-selected-stop"]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);fireEvent.click(screen.getByRole('menuitem',{name:'Stop current run'}));
 await waitFor(()=>expect(document.querySelector('[data-job-id="continuity-selected-stop"] [data-state]')?.getAttribute('data-state')).toBe('cancelled'));
 expect(stopWorkbench).not.toHaveBeenCalled();expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false);
});

test('late selected Stop cannot overwrite a newer Stop all result',async()=>{
 const job=heldJob('selected','running');let finish!:(job:JobStatus)=>void;
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([job],1));
 vi.mocked(stopWorkbenchJob).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 vi.mocked(stopWorkbench).mockResolvedValue({...collection([{...job,state:'succeeded',outputs:[{filename:'keep.png',subfolder:'',type:'output'}],outputRoot:'/old/output'}]),admissionEpoch:1,outcome:'settled',discarded:0,issues:[]});
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 fireEvent.click(document.querySelector('[data-run-stop]')!);fireEvent.click(screen.getByRole('menuitem',{name:'Stop current run'}));
 await waitFor(()=>expect(stopWorkbenchJob).toHaveBeenCalledTimes(1));stopAll();
 await screen.findByText('Stop finished. Check the retained job states.');
 await act(async()=>finish({...job,state:'unknown',error:'Late unknown'}));
 expect(document.querySelector('[data-job-id="selected"] [data-state]')?.getAttribute('data-state')).toBe('succeeded');
 expect(document.querySelector('[data-job-id="selected"] img')?.getAttribute('src')).toContain('/old/output/keep.png');
});

test('right-click on an active queue entry stops only that generation',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 const running=heldJob('running','running'),done=heldJob('done','succeeded');
 vi.mocked(readCurrentWorkbench).mockResolvedValue(collection([done,running]));
 vi.mocked(pollWorkbench).mockImplementation(async()=>collection([done,vi.mocked(stopWorkbenchJob).mock.calls.length?{...running,state:'cancelled'}:running]));
 vi.mocked(stopWorkbenchJob).mockResolvedValue({...running,state:'cancelled'});
 render(<I18nProvider><Workbench endpoint="" roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-job-id="running"]')).not.toBeNull());
 fireEvent.contextMenu(document.querySelector('[data-job-id="done"] .wb-queue-select')!);
 expect(screen.queryByRole('menuitem',{name:'Stop this generation'})).toBeNull();
 fireEvent.contextMenu(document.querySelector('[data-job-id="running"] .wb-queue-select')!);
 fireEvent.click(screen.getByRole('menuitem',{name:'Stop this generation'}));
 await waitFor(()=>expect(stopWorkbenchJob).toHaveBeenCalledWith(expect.objectContaining({id:'running'})));
 expect(stopWorkbench).not.toHaveBeenCalled();
 await waitFor(()=>expect(document.querySelector('[data-job-id="running"] [data-state]')!.getAttribute('data-state')).toBe('cancelled'));
});

test.each(['unreachable','unsupported'])('Stop %s leaves held states intact and gives a localized standard alert',async failure=>{
 const job=heldJob('retained','running');
 vi.mocked(readCurrentWorkbench).mockResolvedValue({...collection([job]),stopAvailable:failure!=='unsupported'});
 vi.mocked(stopWorkbench).mockRejectedValue(new Error('IPC unavailable'));
 render(<I18nProvider><Workbench endpoint=""/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector('[data-run-stop]')).not.toBeNull());
 stopAll();
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain(failure==='unsupported'?'does not support Workbench Stop':'IPC unavailable'));
 expect(document.querySelector('[data-job-id="retained"] [data-state]')!.getAttribute('data-state')).toBe('running');
 expect(stopWorkbench).toHaveBeenCalledTimes(failure==='unsupported'?0:1);
});

test('Stop fences a sent Run reply, coalesces presses and passes the captured native epoch',async()=>{
 vi.mocked(scanModels).mockResolvedValue(imageModels);
 vi.mocked(readCurrentWorkbench).mockResolvedValue({...collection(),admissionEpoch:7});
 let finishRun!:(job:JobStatus)=>void;let finishStop!:(value:Awaited<ReturnType<typeof stopWorkbench>>)=>void;
 vi.mocked(runWorkbenchJob).mockReturnValue(new Promise(resolve=>{finishRun=resolve;}));
 vi.mocked(stopWorkbench).mockReturnValue(new Promise(resolve=>{finishStop=resolve;}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(false));
 fireEvent.click(document.querySelector('[data-run]')!);await waitFor(()=>expect(runWorkbenchJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(runWorkbenchJob).mock.calls[0][2]).toBe(7);
 const stop=document.querySelector<HTMLButtonElement>('[data-run-stop]')!;
 fireEvent.click(stop);fireEvent.click(stop);fireEvent.click(document.querySelector('[data-run]')!); // a single sent run stops on the button itself
 expect(stopWorkbench).toHaveBeenCalledTimes(1);expect(runWorkbenchJob).toHaveBeenCalledTimes(1);
 await act(async()=>finishStop({...collection([heldJob('stopped','cancelled')]),admissionEpoch:8,outcome:'settled',discarded:0,issues:[]}));
 await act(async()=>finishRun(heldJob('stale-run','running')));
 expect(document.querySelector('[data-job-id="stale-run"]')).toBeNull();
 expect(document.querySelector('[data-job-id="stopped"] [data-state]')!.getAttribute('data-state')).toBe('cancelled');
});
