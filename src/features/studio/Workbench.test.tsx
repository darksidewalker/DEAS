import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { prepareDiagnosticJob, submitDiagnosticJob, readDiagnosticJobStatus, uploadMask, uploadInput, readH3Session, type JobStatus } from '../../lib/jobs';
vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true),convertFileSrc:(p:string)=>`asset://localhost/${p}`,invoke:vi.fn(async()=>({path:'/env/ComfyUI/output',parent:'/env/ComfyUI',entries:[],truncated:false}))}));
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}));
vi.mock('../../lib/recipePrerequisites',()=>({checkRecipePrerequisites:vi.fn(async()=>{throw new Error('offline');})}));
vi.mock('../../lib/models',()=>({scanModels:vi.fn()}));
vi.mock('../../lib/jobs',()=>({uploadMask:vi.fn(),uploadInput:vi.fn(),readH3Session:vi.fn(),prepareDiagnosticJob:vi.fn(),submitDiagnosticJob:vi.fn(),readDiagnosticJobStatus:vi.fn(),loadDiagnosticJobOutput:vi.fn(),exportDiagnosticJobOutput:vi.fn()}));
const evidence={baseUrl:'http://127.0.0.1:7801/',recipeId:'checkpoint-text-to-image-diagnostic' as const,version:1 as const,missingNodes:[],generationReady:false as const,
 allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:['a.safetensors','b.safetensors'],loras:['style.safetensors'],samplers:['euler'],schedulers:['normal']}};
beforeEach(()=>{
 localStorage.clear();localStorage.setItem('deas.locale.v1','en');vi.mocked(isTauri).mockReturnValue(true);
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({save:vi.fn(),restore:vi.fn(),arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([0,0,0,0])}))} as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
const dock=(name:string)=>fireEvent.click(screen.getByRole('tab',{name}));
test('wildcard dock and hammer keep base text, snapshot active rules per run and allow disabling without clearing',async()=>{
 localStorage.setItem('deas.pref.studio.run.wildcard',JSON.stringify({style:'Booru',seed:7,reroll:3,token_budget:200,auto_reroll:true,selection_state:{'Art/Light/wildcards':{enabled:true,weight:1.2}}}));
 vi.mocked(invoke).mockImplementation(async c=>c==='native_wildcard_library'?JSON.stringify({categories:{Art:[{subject:'Light',booru_wildcards:['{red|blue} light']}]}}):{entries:[],truncated:false});
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'m.safetensors',path:'/m/checkpoints/m.safetensors',size:1,info:null}]);
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'wild-plan',baseUrl,intent,graph:{},generationReady:false}));
 let submits=0;
 vi.mocked(submitDiagnosticJob).mockImplementation(async()=>({id:`wild-job-${++submits}`,baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false,intent:vi.mocked(prepareDiagnosticJob).mock.calls.at(-1)![1]}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'manual base'}});
 fireEvent.click(screen.getByRole('button',{name:'Prompt Forge'}));
 fireEvent.click(screen.getByRole('button',{name:'Presets & Wildcards'}));
 expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Presets & Wildcards'}));
 await screen.findByText('Art');
 fireEvent.click(screen.getByRole('checkbox',{name:'Active for generation'}));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1));
 const first=vi.mocked(prepareDiagnosticJob).mock.calls[0][1];
 expect(first.positivePrompt).toBe('manual base');expect(first.wildcard?.auto_reroll).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'New picks'}));
 expect(first.wildcard?.reroll).toBe(3);
 fireEvent.change(screen.getByRole('spinbutton',{name:'Wildcard seed'}),{target:{value:'9'}});
 fireEvent.click(screen.getByRole('button',{name:'Use these settings'}));
 expect((screen.getByRole('spinbutton',{name:'Wildcard seed'}) as HTMLInputElement).value).toBe('7');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Disable wildcards'}));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[1][1].wildcard).toBeUndefined();
 expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('manual base');
 fireEvent.click(screen.getByRole('checkbox',{name:'Active for generation'}));
 fireEvent.click(screen.getByRole('button',{name:'Use these settings'}));
 expect((screen.getByRole('checkbox',{name:'Active for generation'}) as HTMLInputElement).checked).toBe(false);
});
test('Options naming persists and resolves the submitted seed/model, rejecting unsafe templates before preparation',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'folder/My Model.safetensors',path:'/m/checkpoints/folder/My Model.safetensors',size:1,info:null}]);
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'naming-plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'naming-job',baseUrl:evidence.baseUrl,promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false});
 const view=render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 dock('Options');
 const field=screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement;
 expect(field.value).toBe('%type%/%date_yyyy-mm-dd%/%time%-%seed%-%model%');
 fireEvent.change(screen.getByRole('spinbutton',{name:'Seed'}),{target:{value:'42'}});
 fireEvent.change(field,{target:{value:'custom/%type%/%seed%-%model%'}});
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1));
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1].outputPrefix).toBe('custom/image/42-My-Model');
 fireEvent.change(field,{target:{value:'../%seed%'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1);
 expect(field.getAttribute('aria-invalid')).toBe('true');
 view.unmount();
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m'}}/></I18nProvider>);
 dock('Options');expect((screen.getByRole('textbox',{name:'Output naming'}) as HTMLInputElement).value).toBe('../%seed%');
});
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
 expect(intent).toMatchObject({positivePrompt:'a quiet forest',checkpoint:'b.safetensors',width:768,height:1024,loras:[{name:'style.safetensors',strength:0.7}],outputPrefix:expect.stringMatching(new RegExp(`^image/\\d{4}-\\d{2}-\\d{2}/\\d{2}-\\d{2}-\\d{2}-${intent.seed}-b$`))});
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

test('model and LoRA docks get a subfolder tree from the scanned names that filters the tiles per tab',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'sdxl/base.safetensors',path:'/m/checkpoints/sdxl/base.safetensors',size:1,info:null},{category:'checkpoints',name:'sd15/old.safetensors',path:'/m/checkpoints/sd15/old.safetensors',size:1,info:null},{category:'checkpoints',name:'sdxl/anime/pony.safetensors',path:'/m/checkpoints/sdxl/anime/pony.safetensors',size:1,info:null},{category:'loras',name:'grain.safetensors',path:'/m/loras/grain.safetensors',size:1,info:null}]);
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m'}}/></I18nProvider>);
 dock('Models');
 const tree=await screen.findByRole('navigation',{name:'Folders'});
 fireEvent.click(within(tree).getByRole('button',{name:'anime'}));
 expect(screen.getByRole('button',{name:'sdxl/anime/pony.safetensors'})).toBeTruthy();expect(screen.queryByRole('button',{name:'sdxl/base.safetensors'})).toBeNull();
 fireEvent.click(within(tree).getByRole('button',{name:'sdxl'}));
 expect(screen.getByRole('button',{name:'sdxl/base.safetensors'})).toBeTruthy();expect(screen.queryByRole('button',{name:'sd15/old.safetensors'})).toBeNull();
 dock('LoRAs');expect(screen.queryByRole('navigation',{name:'Folders'})).toBeNull();expect(screen.getByRole('button',{name:'grain.safetensors'})).toBeTruthy(); // no subfolders, no tree, unfiltered
 dock('Models');expect(within(screen.getByRole('navigation',{name:'Folders'})).getByRole('button',{name:'sdxl'}).getAttribute('aria-current')).toBe('location');
 fireEvent.click(within(screen.getByRole('navigation',{name:'Folders'})).getByRole('button',{name:'Models'}));
 expect(screen.getByRole('button',{name:'sd15/old.safetensors'})).toBeTruthy();
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

test('IPC fixture: Post-process upscales the shown image alone, then the render; the opt-in tab adds a refine pass to Run',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'out.png',path:'/env/ComfyUI/output/out.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 let n=0;
 vi.mocked(submitDiagnosticJob).mockImplementation(async()=>({id:`job-${++n}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputs:[{filename:`DEAS_000${n}.png`,subfolder:'',type:'output'}],error:null,generationReady:false,intent:vi.mocked(prepareDiagnosticJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 expect(screen.queryByRole('button',{name:'Refine'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Upscale'})).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Post-Processing'}));
 fireEvent.change(screen.getByLabelText('Upscale factor'),{target:{value:'2'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Post-process'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Post-process'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1));
 const first=vi.mocked(prepareDiagnosticJob).mock.calls[0][1];
 expect(first).toMatchObject({inputImage:'out.png [output]',denoise:0.25,width:1984,height:1216,inputResize:{width:1984,height:1216,crop:'disabled'}}); // 2000×1200 snapped per edge to the SDXL 64 grid
 expect(first.refine).toBeUndefined();expect(first.upscaleModel).toBeUndefined();
 // Default: side by side, the still-mounted editor on the source left, the render right.
 expect(await screen.findByRole('img',{name:'DEAS_0001.png'})).toBeTruthy();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 expect(screen.queryByRole('slider',{name:'Original / edited divider'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Slider',pressed:false}));
 expect(screen.getByRole('img',{name:'Original'})).toBeTruthy();
 expect(screen.getByRole('slider',{name:'Original / edited divider'})).toBeTruthy();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Slider',pressed:true}));
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 // Instant again on the shown render: its submitted size is the source.
 fireEvent.click(screen.getByRole('button',{name:'Post-process'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(2));
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[1][1]).toMatchObject({inputImage:'DEAS_0001.png [output]',width:3968,height:2432});
 // Opt-in: every Run gets the refine pass at the upscaled grid size.
 fireEvent.click(screen.getByRole('checkbox',{name:'Refine / Upscale after every run'}));
 expect(screen.getByRole('tab',{name:/Post-Processing/}).textContent).toContain('✓');
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(3));
 const third=vi.mocked(prepareDiagnosticJob).mock.calls[2][1];
 expect(third.refine).toEqual({width:2048,height:2048,denoise:0.25});
 expect(third.inputImage).toBeUndefined();
});

test.each([false,true])('IPC fixture: Inpaint preserves its draft and submits crop/blur only when enabled (%s)',async(cropped)=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/checkpoints/a.safetensors',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/ComfyUI/output/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('out.png'),entry('cat.png')],truncated:false}));
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){setTimeout(()=>this.onload());}});
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockResolvedValue({id:'job-in',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'failed',outputs:[],error:null,generationReady:false});
 vi.mocked(uploadMask).mockResolvedValue('deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png');
 const ctx={canvas:{width:1024,height:640},save:vi.fn(),restore:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([255,255,255,255])})),arc:vi.fn(),fill:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn()};
 const restore=[vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D),
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(cb=>cb({arrayBuffer:async()=>new Uint8Array([137,80,78,71]).buffer} as Blob)), // jsdom Blob has no arrayBuffer
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:512,height:320} as DOMRect)];
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'out.png'}));
 const img=screen.getByRole('img',{name:'out.png'});
 Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Inpaint'}).hasAttribute('disabled')).toBe(false));
 expect(screen.queryByRole('checkbox',{name:'Inpaint only masked'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect((screen.getByRole('spinbutton',{name:'Mask Blur (px)'}) as HTMLInputElement).value).toBe('0');
 if(cropped){fireEvent.click(screen.getByRole('checkbox',{name:'Inpaint only masked'}));fireEvent.change(screen.getByRole('spinbutton',{name:'Mask Shrink Grow (px)'}),{target:{value:'32'}});fireEvent.change(screen.getByRole('spinbutton',{name:'Mask Blur (px)'}),{target:{value:'8'}});}
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true); // nothing painted yet
 const mask=screen.getByLabelText('Inpaint mask',{selector:'canvas'}) as HTMLCanvasElement;
 const viewport=document.querySelector<HTMLElement>('[data-editor-viewport]')!;
 viewport.setPointerCapture=vi.fn();
 expect([mask.width,mask.height]).toEqual([1024,640]);
 fireEvent(viewport,new MouseEvent('pointerdown',{clientX:256,clientY:160,buttons:1,bubbles:true}));
 fireEvent(viewport,new MouseEvent('pointerup',{clientX:256,clientY:160,bubbles:true}));
 expect(ctx.arc).toHaveBeenCalledWith(512,320,24,0,Math.PI*2);
 fireEvent.click(screen.getByRole('button',{name:'Image to Image'}));
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Insert'}));
 fireEvent.click(screen.getByRole('button',{name:'cat.png'}));
 const layer=await screen.findByRole('group',{name:'Inserted image cat.png [output]'});
 await waitFor(()=>{
  expect(layer.classList.contains('is-selected')).toBe(true);
  expect(screen.getByRole('button',{name:'Select',pressed:true})).toBeTruthy();
 });
 fireEvent.keyDown(layer,{key:'ArrowRight'});
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 expect(screen.getByRole('group',{name:'Inserted image cat.png [output]'})).toBe(layer);
 expect(screen.getByLabelText('Inpaint mask',{selector:'canvas'})).toBe(mask);
 expect(document.querySelector('[data-editor-viewport]')).toBe(viewport);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(uploadMask).toHaveBeenCalledWith('http://127.0.0.1:7801',new Uint8Array([137,80,78,71]));
 const intent=vi.mocked(prepareDiagnosticJob).mock.calls[0][1];
 expect(intent).toMatchObject({inputImage:'out.png [output]',inputMask:'deas-masks/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',denoise:0.8,width:1024,height:640});
 expect(intent.inputResize).toBeUndefined();
 if(cropped){expect(intent.maskBlur).toBe(8);expect(intent.inpaintCrop).toEqual({x:0,y:0,width:41,height:41,targetWidth:1024,targetHeight:1024});}
 else{expect(intent.maskBlur).toBeUndefined();expect(intent.inpaintCrop).toBeUndefined();}
 expect(intent.inputLayers).toEqual([{image:'cat.png [output]',x:350,y:235,width:341,height:171}]);
 // The edit job opens side by side: the same editor stays live on the left, no return needed.
 expect(screen.queryByRole('button',{name:'Return to edit draft'})).toBeNull();
 expect(document.querySelector('.wb-editor-host')?.hasAttribute('hidden')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'out.png'}));
 expect(document.querySelector('[data-editor-viewport]')).toBe(viewport);
 expect(screen.getByRole('group',{name:'Inserted image cat.png [output]'})).toBe(layer);
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'cat.png'}));
 const next=screen.getByRole('img',{name:'cat.png'});
 Object.defineProperties(next,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(next);
 expect(screen.queryByRole('group',{name:'Inserted image cat.png [output]'})).toBeNull();
 expect(screen.getByLabelText('Inpaint mask',{selector:'canvas'})).not.toBe(mask);
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 restore.forEach(s=>s.mockRestore());
 vi.unstubAllGlobals();
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
 // Native: the stage video plays a blob of the asset bytes (WebKitGTK rejects asset:// media), fetched once per selection.
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob(['x'],{type:'video/mp4'})})));
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:deas/1')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
 fireEvent.click(screen.getByRole('button',{name:'portrait.mp4'}));
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(false);
 const video=container.querySelector('.wb-stage video')!;
 expect(fetch).toHaveBeenCalledWith('asset://localhost//env/input/portrait.mp4');
 await waitFor(()=>expect(video.getAttribute('src')).toBe('blob:deas/1'));
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

test('Inpaint rejects a source outside the model grid instead of silently rounding its pixels',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'odd.png',path:'/env/out/odd.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/out'}}/></I18nProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'odd.png'}));
 const img=screen.getByRole('img',{name:'odd.png'});
 Object.defineProperties(img,{naturalWidth:{value:1000},naturalHeight:{value:600}});fireEvent.load(img);
 fireEvent.click(screen.getByRole('button',{name:'Inpaint'}));
 expect(screen.getByText('Resample this image to the selected model’s resolution grid before inpainting.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Run'}).hasAttribute('disabled')).toBe(true);
 expect(uploadMask).not.toHaveBeenCalled();
});

test.each(['late','error'])('Insert %s loading cannot create a guessed or stale image layer',async(mode)=>{
 vi.mocked(scanModels).mockResolvedValue([{category:'checkpoints',name:'a.safetensors',path:'/m/a',size:1,info:null,family:'sdxl'}]);
 const entry=(name:string)=>({name,path:`/env/out/${name}`,kind:'file',symlink:false,media:'image',size:1,modified:1});
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[entry('base.png'),entry('cat.png'),entry('other.png')],truncated:false}));
 let loaded=()=>{},failed=()=>{};
 vi.stubGlobal('Image',class{naturalWidth=200;naturalHeight=100;onload=()=>{};onerror=()=>{};set src(_:string){loaded=()=>this.onload();failed=()=>this.onerror();}});
 try{
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{models:'/m',output:'/env/out'}}/></I18nProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'base.png'}));
  const img=screen.getByRole('img',{name:'base.png'});
  Object.defineProperties(img,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(img);
  fireEvent.click(screen.getByRole('button',{name:'Insert'}));
  fireEvent.click(screen.getByRole('button',{name:'cat.png'}));
  if(mode==='late'){
   fireEvent.click(screen.getByRole('button',{name:'other.png'}));
   const other=screen.getByRole('img',{name:'other.png'});
   Object.defineProperties(other,{naturalWidth:{value:1024},naturalHeight:{value:640}});fireEvent.load(other);
   await act(async()=>loaded());
  }
  else{await act(async()=>failed());expect(screen.getByRole('alert').textContent).toBe('This image could not be loaded for insertion.');}
  expect(screen.queryByRole('group',{name:'Inserted image cat.png [output]'})).toBeNull();
 }finally{vi.unstubAllGlobals();}
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

test('IPC fixture: video families enable Image→Video; LTX submits a video intent with frames on the 8k+1 grid and a video output plays in the stage',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'unet',name:'LTX2/ltx.safetensors',path:'/m/unet/LTX2/ltx.safetensors',size:1,info:null,family:'ltx-2'},
  {category:'text_encoders',name:'gemma_3_12B_it_fp8.safetensors',path:'/m/text_encoders/gemma.safetensors',size:1,info:null},
  {category:'text_encoders',name:'ltx-2.3_text_projection_bf16.safetensors',path:'/m/text_encoders/proj.safetensors',size:1,info:null},
  {category:'vae',name:'LTX2/LTX23_video_vae_bf16.safetensors',path:'/m/vae/v.safetensors',size:1,info:null},
  {category:'vae',name:'LTX2/LTX23_audio_vae_bf16.safetensors',path:'/m/vae/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 vi.mocked(submitDiagnosticJob).mockImplementation(async()=>({id:'job-v',baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputs:[{filename:'x_00001.webm',subfolder:'video',type:'output',format:'video/webm'}],error:null,generationReady:false,intent:vi.mocked(prepareDiagnosticJob).mock.lastCall![1]} as JobStatus));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 const i2v=await screen.findByRole('button',{name:'Image → Video'});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Text → Video'}).hasAttribute('disabled')).toBe(false));
 expect(i2v.hasAttribute('disabled')).toBe(true);
 expect(screen.getByRole('button',{name:'Video → Video'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 fireEvent.click(i2v);
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1280},naturalHeight:{value:704}});fireEvent.load(ref);
 fireEvent.change(screen.getByLabelText('Seconds'),{target:{value:'2'}});
 expect(screen.getByText('49 frames · 2.00 s')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalled());
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).toMatchObject({recipeId:'video-generation',family:'ltx-2',model:'LTX2/ltx.safetensors',textEncoder:'gemma_3_12B_it_fp8.safetensors',vae:'LTX2/LTX23_video_vae_bf16.safetensors',frames:49,frameRate:24,firstFrame:'ref.png',output:{codec:'Auto',container:'Auto',quality:20},ltx:{textProjection:'ltx-2.3_text_projection_bf16.safetensors',audioVae:'LTX2/LTX23_audio_vae_bf16.safetensors',passes:1}});
 expect(vi.mocked(prepareDiagnosticJob).mock.calls[0][1]).not.toHaveProperty('imageFormat');
 await waitFor(()=>expect(document.querySelector('.wb-stage video')?.getAttribute('src')).toBe('http://127.0.0.1:7801/view?filename=x_00001.webm&subfolder=video&type=output'));
 expect(screen.queryByRole('tab',{name:'Continuity'})).toBeNull();
});

test('IPC fixture: MiniMax H3 uploads dock references for the Director and the continuity planner pins the clip of each finished step',async()=>{
 vi.mocked(scanModels).mockResolvedValue([
  {category:'diffusion_models',name:'MiniMaxH3/h3.safetensors',path:'/m/diffusion_models/MiniMaxH3/h3.safetensors',size:1,info:null,family:'minimax-h3'},
  {category:'text_encoders',name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',path:'/m/t.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors',path:'/m/v.safetensors',size:1,info:null},
  {category:'vae',name:'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors',path:'/m/a.safetensors',size:1,info:null}]);
 vi.mocked(invoke).mockImplementation(async(_c,args)=>({path:(args as {path:string}).path,parent:'/env',entries:[{name:'ref.png',path:'/env/ComfyUI/input/ref.png',kind:'file',symlink:false,media:'image',size:1,modified:1}],truncated:false}));
 vi.mocked(uploadInput).mockResolvedValue('deas-inputs/u1.png');
 vi.mocked(prepareDiagnosticJob).mockImplementation(async(baseUrl,intent)=>({id:'plan',baseUrl,intent,graph:{},generationReady:false}));
 let n=0;
 vi.mocked(submitDiagnosticJob).mockImplementation(async()=>({id:`h3-${++n}`,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'queued',outputs:[],error:null,generationReady:false}));
 vi.mocked(readDiagnosticJobStatus).mockImplementation(async id=>({id,baseUrl:'http://127.0.0.1:7801/',promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false}));
 vi.mocked(readH3Session).mockImplementation(async()=>({latestId:null,clips:[{clipId:'root1',parent:null,frames:124,completed:1,export:null},{clipId:'kid1',parent:'root1',frames:200,completed:2,export:null}]}));
 render(<I18nProvider><Workbench endpoint="http://127.0.0.1:7801" roots={{models:'/m',input:'/env/ComfyUI/input',output:'/env/ComfyUI/output'}}/></I18nProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Input'}));
 fireEvent.click(await screen.findByRole('button',{name:'ref.png'}));
 fireEvent.click(await screen.findByRole('button',{name:'Image → Video'}));
 const ref=screen.getByRole('img',{name:'ref.png'});
 Object.defineProperties(ref,{naturalWidth:{value:1024},naturalHeight:{value:768}});fireEvent.load(ref);
 expect((screen.getByLabelText('FPS') as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Run'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(1));
 expect(uploadInput).toHaveBeenCalledWith('http://127.0.0.1:7801','/env/ComfyUI/input/ref.png');
 const first=vi.mocked(prepareDiagnosticJob).mock.calls[0][1] as unknown as {frames:number;h3:object;firstFrame?:string};
 expect(first).toMatchObject({family:'minimax-h3',frames:124,frameRate:24,h3:{mode:'I2VA',references:[{slot:0,image:'deas-inputs/u1.png'}]}});
 expect(first.firstFrame).toBeUndefined();
 expect((first.h3 as {continuity?:object}).continuity).toBeUndefined();
 await waitFor(()=>expect(screen.getAllByText('Succeeded').length).toBeGreaterThan(0),{timeout:4000});
 dock('Continuity');
 fireEvent.click(screen.getByRole('button',{name:'Add step'}));fireEvent.click(screen.getByRole('button',{name:'Add step'}));
 fireEvent.change(screen.getAllByLabelText('Next action')[0],{target:{value:'she turns around'}});
 fireEvent.click(screen.getByRole('button',{name:'Run all'}));
 await waitFor(()=>expect(prepareDiagnosticJob).toHaveBeenCalledTimes(3),{timeout:5000});
 const steps=vi.mocked(prepareDiagnosticJob).mock.calls.slice(1).map(c=>(c[1] as unknown as {h3:{continuity:{sourceId:string;action:string;capture:boolean}}}).h3.continuity);
 expect(steps[0]).toMatchObject({sourceId:'',capture:true,action:''});
 expect(steps[1]).toMatchObject({sourceId:'root1',capture:true,action:'she turns around'});
 await waitFor(()=>expect(screen.getByText('kid1')).toBeTruthy(),{timeout:5000});
 expect(readH3Session).toHaveBeenCalledWith('http://127.0.0.1:7801',expect.stringMatching(/^deas-[0-9a-f]{8}$/));
});
