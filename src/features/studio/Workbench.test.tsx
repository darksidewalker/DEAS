import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, type JobStatus } from '../../lib/jobs';
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true),convertFileSrc:(p:string)=>`asset://localhost/${p}`,invoke:vi.fn(async()=>({path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[],truncated:false}))}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
vi.mock('../../lib/recipePrerequisites',()=>({checkRecipePrerequisites:vi.fn()}));
vi.mock('../../lib/models',()=>({scanModels:vi.fn()}));
vi.mock('../../lib/jobs',()=>({prepareDiagnosticJob:vi.fn(),submitDiagnosticJob:vi.fn(),readDiagnosticJobStatus:vi.fn(),loadDiagnosticJobOutput:vi.fn(),exportDiagnosticJobOutput:vi.fn()}));
const evidence={baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic' as const,version:1 as const,missingNodes:[],generationReady:false as const,
 allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['a.safetensors','b.safetensors'],loras:['style.safetensors'],samplers:['euler'],schedulers:['normal']}};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const dock=(name:string)=>fireEvent.click(screen.getByRole('tab',{name}));
test('IPC fixture: Load models → pick LoRA → Run prepares and submits one intent, polls to success and previews the output file',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const queued:JobStatus={id:'job-1234',baseUrl:evidence.baseUrl,promptId:'p',state:'queued',outputs:[],error:null,generationReady:false};
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue(queued);
 vi.mocked(readDiagnosticJobStatus).mockResolvedValue({...queued,state:'succeeded',outputs:[{filename:'DEAS_0001.png',subfolder:'',type:'output'}]});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{output:'/env/ComfyUI/output'}}/></I18nProvider>);
 expect(screen.getByRole('complementary',{name:'Media'})).toBeTruthy(); // the media dock tab is the default
 expect(checkRecipePrerequisites).not.toHaveBeenCalled(); // explicit load only; no auto-inspection on mount
 dock('Models');fireEvent.click(screen.getByRole('button',{name:'Load models'}));
 fireEvent.click(await screen.findByRole('button',{name:'b.safetensors'}));
 expect(screen.getByRole('button',{name:'b.safetensors'}).getAttribute('aria-pressed')).toBe('true');
 dock('LoRAs');fireEvent.click(screen.getByRole('button',{name:'style.safetensors'}));
 fireEvent.change(screen.getByLabelText('Strength of style.safetensors'),{target:{value:'0.7'}});
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'a quiet forest'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'768'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(submitDiagnosticJob).toHaveBeenCalledWith('plan'));
 const [baseUrl,intent]=vi.mocked(prepareDiagnosticJob).mock.calls[0];
 expect(baseUrl).toBe('http://127.0.0.1:7801');
 expect(intent).toMatchObject({positivePrompt:'a quiet forest',checkpoint:'b.safetensors',width:768,height:1024,loras:[{name:'style.safetensors',strength:0.7}],outputPrefix:'DEAS'});
 expect(Object.isFrozen(intent)).toBe(true);
 expect(screen.getByRole('button',{name:/Queued/})).toBeTruthy();
 await waitFor(()=>expect((screen.getByRole('img',{name:'DEAS_0001.png'}) as HTMLImageElement).src).toBe('asset://localhost//env/ComfyUI/output/DEAS_0001.png'),{timeout:3000});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.loras')!)).toEqual([{name:'style.safetensors',strength:0.7}]);
});

test('IPC fixture: with an environment the models folder is scanned on mount instead of probing the backend',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null},{category:'loras',name:'grain.safetensors',path:'/m/loras/grain.safetensors',size:1,info:null},{category:'vae',name:'x.safetensors',path:'/m/vae/x.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 expect((await screen.findByRole('button',{name:'sdxl/base.safetensors'})).getAttribute('aria-pressed')).toBe('true');
 dock('LoRAs');expect(screen.getByRole('button',{name:'grain.safetensors'}).getAttribute('aria-pressed')).toBe('false');
 expect(scanModels).toHaveBeenCalledExactlyOnceWith('/m');
 expect(checkRecipePrerequisites).not.toHaveBeenCalled();
});

test('IPC fixture: pipelines are gated — Image→Image needs an Input-folder image and submits inputImage+denoise; video pipelines stay disabled',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-2',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 vi.mocked(readDiagnosticJobStatus).mockResolvedValue({id:'job-2',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 await screen.findByRole('button',{name:'Text → Image',pressed:true});
 const i2i=screen.getByRole('button',{name:'Image → Image'});
 expect(i2i.hasAttribute('disabled')).toBe(true);
 for(const name of ['Text → Video','Image → Video','Video → Video','Multi-reference → Video'])expect(screen.getByRole('button',{name}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 expect(i2i.hasAttribute('disabled')).toBe(false);
 fireEvent.click(i2i);
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(ref);
 fireEvent.change(screen.getByLabelText('Denoise'),{target:{value:'0.4'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({inputImage:'ref.png',denoise:0.4,checkpoint:'a.safetensors'});
});

test('IPC fixture: families gate models and LoRAs, picking applies the family defaults and a diffusion model submits its encoder and VAE',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints','ill.safetensors','sdxl'),m('diffusion_models','k2.safetensors','krea-2'),m('diffusion_models','h3.safetensors','minimax-h3'),m('unet','odd.safetensors'),
  m('text_encoders','qwen3vl_4b.safetensors'),m('vae','Q/qwen_image_vae.safetensors'),m('loras','k-style.safetensors','krea-2'),m('loras','ill-style.safetensors','sdxl'),m('loras','mystery.safetensors')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue({...evidence,allowlist:{...evidence.allowlist,samplers:['euler','er_sde','res_multistep'],schedulers:['normal','simple','beta']}});
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-3',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 expect((await screen.findByRole('button',{name:/h3\.safetensors/})).hasAttribute('disabled')).toBe(true); // video family: no image recipe
 expect(screen.getByRole('button',{name:/odd\.safetensors/}).hasAttribute('disabled')).toBe(true); // unknown diffusion model
 fireEvent.click(screen.getByRole('button',{name:/k2\.safetensors/}));
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('8');
 expect((screen.getByLabelText('CFG') as HTMLInputElement).value).toBe('1');
 expect((screen.getByLabelText('Text encoder') as HTMLSelectElement).value).toBe('qwen3vl_4b.safetensors');
 dock('LoRAs');
 expect(screen.queryByRole('button',{name:/ill-style/})).toBeNull(); // other family hidden, unknown kept
 fireEvent.click(screen.getByRole('button',{name:/k-style/}));expect(screen.getByRole('button',{name:/mystery/})).toBeTruthy();
 expect(checkRecipePrerequisites).not.toHaveBeenCalled();
 fireEvent.focus(screen.getByLabelText('Sampler')); // the picker reads the backend's full list on first use
 await waitFor(()=>expect(Array.from((screen.getByLabelText('Sampler') as HTMLSelectElement).options,o=>o.value)).toEqual(['euler','er_sde','res_multistep']));
 fireEvent.change(screen.getByLabelText('Sampler'),{target:{value:'res_multistep'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({checkpoint:'k2.safetensors',sampler:'res_multistep',scheduler:'simple',loras:[{name:'k-style.safetensors',strength:1}],diffusion:{textEncoder:'qwen3vl_4b.safetensors',clipType:'krea2',vae:'Q/qwen_image_vae.safetensors'}});
});

test('automatic aspect is confined to media pipelines and text pipelines ignore image and video previews',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[
  {name:'wide.png',path:'/env/input/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1},
  {name:'portrait.mp4',path:'/env/input/portrait.mp4',kind:'file',symlink:false,media:'video',size:1,modified:2},
 ],truncated:false}));
 const {container}=render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 await screen.findByRole('button',{name:'Text → Image',pressed:true});
 fireEvent.click(screen.getByRole('button',{name:'Input'}));
 const aspectPicker=screen.getByLabelText('Aspect ratio') as HTMLSelectElement;
 expect(Array.from(aspectPicker.options,o=>o.value)).not.toContain('auto');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'model'}});
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));
 const image=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(image,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(image);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 fireEvent.click(screen.getByRole('button',{name:'Image → Image'}));
 expect(Array.from(aspectPicker.options,o=>o.value)).toContain('auto');
 expect(aspectPicker.value).toBe('auto');
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'target'}});
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1368');
 fireEvent.click(screen.getByRole('button',{name:'Text → Image'}));
 expect(Array.from(aspectPicker.options,o=>o.value)).not.toContain('auto');
 expect(aspectPicker.value).toBe('1:1');
 fireEvent.click(screen.getByRole('button',{name:'portrait.mp4'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 const video=container.querySelector('.wb-stage video')!;
 Object.defineProperties(video,{videoWidth:{value:1080},videoHeight:{value:1920}});fireEvent.loadedMetadata(video);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('1024');
 expect(container.querySelector('.wb-resolution-summary')).toBeNull();
 expect(container.querySelector('.wb-aspect-picker .wb-aspect-swatch')).not.toBeNull();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(screen.getByRole('button',{name:'Image → Video'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'640'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'480'}});
 fireEvent.click(screen.getByRole('button',{name:'wide.png'}));
 const nextImage=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(nextImage,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(nextImage);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('640');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('480');
 expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('fixed');
});

test('native resolution is one model-driven choice and migrates the removed 768px preference',async()=>{
 localStorage.setItem('deas.pref.studio.run.resolution',JSON.stringify('auto'));
 localStorage.setItem('deas.pref.studio.run.width','768');
 localStorage.setItem('deas.pref.studio.run.height','768');
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('checkpoints','base.safetensors','sdxl'),m('diffusion_models','qwen.safetensors','qwen-image-2.1'),m('text_encoders','qwen3vl_8b.safetensors'),m('vae','qwen_image_2.1_vae.safetensors')]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 await screen.findByRole('button',{name:/base.safetensors/});
 const picker=screen.getByLabelText('Resolution') as HTMLSelectElement;
 expect(Array.from(picker.options,o=>o.value)).not.toContain('auto');
 expect(Array.from(picker.options).filter(o=>o.textContent==='Native')).toHaveLength(1);
 expect(picker.value).toBe('model');
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1024');
 fireEvent.click(screen.getByRole('button',{name:/qwen.safetensors/}));
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('2048');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('2048');
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.resolution')!)).toBe('model');
});

test('resolution picker follows reference metadata, forwards padded pixels to the model and remembers settings',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'wide.png',path:'/env/input/wide.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'resolution-job',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'fixture',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/input'}}/></I18nProvider>);
 await screen.findByRole('button',{name:'Text → Image',pressed:true});
 fireEvent.click(screen.getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'wide.png'}));
 fireEvent.click(screen.getByRole('button',{name:'Image → Image'}));
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'model'}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 const ref=screen.getByRole('img',{name:'wide.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(ref);
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1368');
 expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('768');
 fireEvent.change(screen.getByLabelText('Aspect ratio'),{target:{value:'1:1'}});
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'1024p'}});
 fireEvent.change(screen.getByLabelText('Input scaling'),{target:{value:'pad'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({width:1024,height:1024,inputImage:'wide.png',inputResize:{width:1024,height:576,crop:'disabled',pad:{left:0,right:0,top:224,bottom:224}}});
 expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.inputScaling')!)).toBe('pad');
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'fixed'}});
 fireEvent.change(screen.getByLabelText('Width'),{target:{value:'8192'}});
 fireEvent.change(screen.getByLabelText('Height'),{target:{value:'8192'}});
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
});
