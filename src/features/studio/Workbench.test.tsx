import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, uploadMask, type JobStatus } from '../../lib/jobs';
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true),convertFileSrc:(p:string)=>`asset://localhost/${p}`,invoke:vi.fn(async()=>({path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[],truncated:false}))}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
vi.mock('../../lib/recipePrerequisites',()=>({checkRecipePrerequisites:vi.fn(async()=>{throw new Error('offline');})}));
vi.mock('../../lib/models',()=>({scanModels:vi.fn()}));
vi.mock('../../lib/jobs',()=>({uploadMask:vi.fn(),prepareDiagnosticJob:vi.fn(),submitDiagnosticJob:vi.fn(),readDiagnosticJobStatus:vi.fn(),loadDiagnosticJobOutput:vi.fn(),exportDiagnosticJobOutput:vi.fn()}));
const evidence={baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic' as const,version:1 as const,missingNodes:[],generationReady:false as const,
 allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['a.safetensors','b.safetensors'],loras:['style.safetensors'],samplers:['euler'],schedulers:['normal']}};
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const dock=(name:string)=>fireEvent.click(screen.getByRole('tab',{name}));
test('seed controls restore submitted seeds, preserve mode on New and wrap exact integer steps',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'seed.safetensors',path:'/m/checkpoints/seed.safetensors',size:1,info:null}]);
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'seed-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(scanModels).toHaveBeenCalled());
 const input=()=>screen.getByRole('spinbutton',{name:'Seed'}) as HTMLInputElement;
 fireEvent.change(input(),{target:{value:'42'}});
 expect(screen.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(submitDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1].seed).toBe(42);
 expect(input().value).toBe('42');
 fireEvent.click(screen.getByRole('button',{name:'New random seed'}));
 expect(screen.getByRole('button',{name:'Fixed',pressed:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Use last seed'}));
 expect(input().value).toBe('42');
 fireEvent.change(input(),{target:{value:'0'}});
 fireEvent.click(screen.getByRole('button',{name:'Decrease seed'}));
 expect(input().value).toBe(String(Number.MAX_SAFE_INTEGER));
 fireEvent.click(screen.getByRole('button',{name:'Increase seed'}));
 expect(input().value).toBe('0');
 fireEvent.click(screen.getByRole('button',{name:'Use seed 42'}));
 expect(input().value).toBe('42');
 fireEvent.click(screen.getByRole('button',{name:'Copy seed 42'}));
 await screen.findByRole('status'); // unavailable clipboard is a visible failure, not a successful copy
 const writeText=vi.fn().mockResolvedValue(undefined);
 Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
 fireEvent.click(screen.getByRole('button',{name:'Copy seed 42'}));
 await waitFor(()=>expect(writeText).toHaveBeenCalledWith('42'));
 expect(screen.getByRole('status').textContent).toBe('Seed copied');
 fireEvent.click(screen.getByRole('button',{name:'Random'}));
 vi.mocked(submitDiagnosticJob).mockResolvedValueOnce({id:'seed-job-2',baseUrl:evidence.baseUrl,promptId:'p2',state:'succeeded',outputs:[],error:null,generationReady:false});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(submitDiagnosticJob).toHaveBeenCalledTimes(2));
 expect(input().value).not.toBe('42');
 view.unmount();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl}/></I18nProvider>);
 expect(screen.getByRole('button',{name:'Random',pressed:true})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Use seed 42'})).toBeTruthy();
});
test('seed history caps at ten, deduplicates submitted values and ignores failed preparation',async()=>{
 localStorage.setItem('deas.pref.studio.run.recentSeeds',JSON.stringify([1,2,3,4,5,6,7,8,9,10]));
 localStorage.setItem('deas.pref.studio.run.seed','12');
 localStorage.setItem('deas.pref.studio.run.seedMode',JSON.stringify('fixed'));
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'seed.safetensors',path:'/m/checkpoints/seed.safetensors',size:1,info:null}]);
 vi.mocked(prepareDiagnosticJob).mockRejectedValueOnce(new Error('prepare failed')).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockImplementation(async()=>({id:String(Math.random()),baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await screen.findByText('prepare failed');
 const history=()=>JSON.parse(localStorage.getItem('deas.pref.studio.run.recentSeeds')!);
 expect(history()).toEqual([1,2,3,4,5,6,7,8,9,10]);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(history()).toEqual([12,1,2,3,4,5,6,7,8,9]));
 fireEvent.change(screen.getByRole('spinbutton',{name:'Seed'}),{target:{value:'3'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(history()).toEqual([3,12,1,2,4,5,6,7,8,9]));
});

test('IPC fixture: Load models → pick LoRA → Run prepares and submits one intent, polls to success and previews the output file',async()=>{
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 const queued:JobStatus={id:'job-1234',baseUrl:evidence.baseUrl,promptId:'p',state:'queued',outputs:[],error:null,generationReady:false};
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue(queued);
 vi.mocked(readDiagnosticJobStatus).mockResolvedValue({...queued,state:'succeeded',outputs:[{filename:'DEAS_0001.png',subfolder:'',type:'output'}]});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{output:'/env/ComfyUI/output'}}/></I18nProvider>);
 expect(screen.getByRole('complementary',{name:'Media'})).toBeTruthy(); // the media dock tab is the default
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // sampler/scheduler lists are read once per endpoint; models still need the explicit Load
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
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // only the sampler/scheduler lists, never the model list
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

test('IPC fixture: floating Upscale on an Output image submits a grid-snapped [output] image-to-image job and splits original | edited',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-up',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputs:[{filename:'DEAS_0001.png',subfolder:'',type:'output'}],error:null,generationReady:false} as JobStatus);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Upscale'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Upscale'}));
 expect(screen.getByRole('button',{name:'Image → Image',pressed:true})).toBeTruthy();
 expect(screen.getByText('Output 1984×1216')).toBeTruthy(); // 2000×1200 snapped per edge to the SDXL 64 grid
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({inputImage:'out.png [output]',denoise:0.35,width:1984,height:1216,inputResize:{width:1984,height:1216,crop:'disabled'}});
 expect(await screen.findByRole('img',{name:'Original'})).toBeTruthy();
 expect(screen.getByRole('slider',{name:'Original / edited divider'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Compare',pressed:true}));
 expect(screen.queryByRole('img',{name:'Original'})).toBeNull();
});

test('IPC fixture: Inpaint paints a mask over the image, uploads it and submits inputMask with the unresized source',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-in',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 vi.mocked(uploadMask).mockResolvedValue('deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png');
 const ctx={arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn()};
 const restore=[vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D),
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb({arrayBuffer:async()=>new Uint8Array([137,80,78,71]).buffer} as Blob)), // jsdom Blob has no arrayBuffer
  vi.spyOn(HTMLCanvasElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:500,height:300} as DOMRect)];
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Inpaint'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true); // nothing painted yet
 const mask=screen.getByLabelText('Inpaint mask',{selector:'canvas'}) as HTMLCanvasElement;
 mask.setPointerCapture=vi.fn(); // absent in jsdom
 expect([mask.width,mask.height]).toEqual([1000,600]); // the source's own pixels
 fireEvent(mask,new MouseEvent('pointerdown',{clientX:250,clientY:150,buttons:1,bubbles:true})); // jsdom has no PointerEvent coordinates
 expect(ctx.arc).toHaveBeenCalledWith(500,300,24,0,Math.PI*2); // 500×300 box shows the 1000×600 bitmap at half scale
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(uploadMask).toHaveBeenCalledWith('http://127.0.0.1:7801',new Uint8Array([137,80,78,71]));
 const intent=vi.mocked(prepareDiagnosticJob).mock.calls[0][1];
 expect(intent).toMatchObject({inputImage:'out.png [output]',inputMask:'deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',denoise:0.8});
 expect(intent.inputResize).toBeUndefined();
 restore.forEach(s=>s.mockRestore());
});

test('IPC fixture: Insert pastes a picked Output image as a movable layer and submits it as inputLayers in source pixels',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/ComfyUI/output/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('src.png'),entry('cat.png')],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-l',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false});
 // jsdom never loads images: report a 2:1 picture.
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'src.png'}));
 const img=screen.getByRole('img',{name:'src.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Insert'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Insert'}));
 expect(screen.getByRole('button',{name:'Insert',pressed:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'cat.png'}));
 const layer=await screen.findByRole('group',{name:'Inserted image cat.png [output]'});
 expect(screen.getByRole('img',{name:'src.png'})).toBeTruthy(); // the source stays selected
 fireEvent.keyDown(layer,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({inputImage:'src.png [output]',inputLayers:[{image:'cat.png [output]',x:342,y:217,width:333,height:167}]}); // centred (334,217) then ArrowRight +8
 vi.unstubAllGlobals();
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
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1); // the backend list is read once when the endpoint is known, so the first click already shows it
 await waitFor(()=>expect(Array.from((screen.getByLabelText('Sampler') as HTMLSelectElement).options,o=>o.value)).toEqual(['euler','er_sde','res_multistep']));
 fireEvent.focus(screen.getByLabelText('Sampler'));expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByLabelText('Sampler'),{target:{value:'res_multistep'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({checkpoint:'k2.safetensors',sampler:'res_multistep',scheduler:'simple',loras:[{name:'k-style.safetensors',strength:1}],diffusion:{textEncoder:'qwen3vl_4b.safetensors',clipType:'krea2',vae:'Q/qwen_image_vae.safetensors'}});
});

test('IPC fixture: a Turbo family locks steps and scheduler to its saved schedule, submits the sigmas and keeps the base family LoRAs',async()=>{
 const m=(category:string,name:string,family?:string)=>({category,name,path:`/m/${category}/${name}`,size:1,info:null,...(family?{family}:{})});
 vi.mocked(scanModels).mockResolvedValue([m('diffusion_models','turbo.safetensors','qwen-image-2.1-turbo'),m('text_encoders','qwen3vl_8b.safetensors'),m('vae','qwen_image_2.1_vae.safetensors'),m('loras','q-style.safetensors','qwen-image-2.1')]);
 vi.mocked(checkRecipePrerequisites).mockResolvedValue(evidence);
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-4',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:'x',generationReady:false});
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');fireEvent.click(await screen.findByRole('button',{name:/turbo\.safetensors/}));
 const steps=screen.getByLabelText('Steps') as HTMLInputElement;expect(steps.value).toBe('8');expect(steps.disabled).toBe(true);
 const scheduler=screen.getByLabelText('Scheduler') as HTMLSelectElement;expect(scheduler.disabled).toBe(true);expect(scheduler.options[scheduler.selectedIndex].text).toBe('CUSTOM');
 expect((screen.getByLabelText('Sampler') as HTMLSelectElement).disabled).toBe(false);
 dock('LoRAs');expect(screen.getByRole('button',{name:/q-style/})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({checkpoint:'turbo.safetensors',steps:8,cfg:1,sampler:'euler',sigmas:[1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0]});
 // A typed schedule in Options overrides the model's own; steps follow it.
 dock('Options');fireEvent.change(screen.getByRole('textbox',{name:'Custom sigmas'}),{target:{value:'1, 0.6, 0.3, 0'}});
 expect((screen.getByLabelText('Steps') as HTMLInputElement).value).toBe('3');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[1][1]).toMatchObject({steps:3,sigmas:[1,0.6,0.3,0]});
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
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1344');
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
 expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1344');
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
