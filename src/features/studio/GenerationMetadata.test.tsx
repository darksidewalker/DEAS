import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GenerationMetadata } from './GenerationMetadata';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { JobStatus } from '../../lib/jobs';
import { OpenComfyWorkflow } from '../../lib/comfyWorkflow';
import { readImageMetadata } from '../../lib/imageMetadata';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true}));
vi.mock('../../lib/imageMetadata',async importOriginal=>({...await importOriginal<typeof import('../../lib/imageMetadata')>(),readImageMetadata:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const job:JobStatus={id:'a',baseUrl:'http://127.0.0.1',promptId:'p',state:'succeeded',outputs:[],error:null,generationReady:false,appVersion:'0.1.14',metadata:{startedAt:1700000000000,generationMs:13310},intent:{recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'<img src=x onerror=alert(1)> forest',negativePrompt:'blur',checkpoint:'Krea2/model.safetensors',width:896,height:1152,seed:940563189,steps:8,cfg:1,sampler:'euler',scheduler:'simple',outputPrefix:'DEAS',diffusion:{textEncoder:'qwen3vl_4b.safetensors',clipType:'krea2',vae:'qwen_vae.safetensors'},loras:[{name:'style.safetensors',strength:0.7}]}};
test('renders native generation settings as text and switches with the selected job without stale metadata',()=>{
 localStorage.setItem('deas.locale.v1','en');
 const {container,rerender}=render(<I18nProvider><GenerationMetadata job={job}/></I18nProvider>);
 for(const value of ['<img src=x onerror=alert(1)> forest','blur','Krea2/model.safetensors','896 × 1152','940563189','13.31 s','0.1.14','qwen3vl_4b.safetensors','qwen_vae.safetensors','style.safetensors (0.7)'])expect(screen.getByText(value)).toBeTruthy();
 expect(container.querySelector('img')).toBeNull();
 rerender(<I18nProvider><GenerationMetadata job={{...job,id:'b',metadata:null,intent:{...job.intent!,positivePrompt:'second',checkpoint:'second.safetensors'}}}/></I18nProvider>);
 expect(screen.queryByText('13.31 s')).toBeNull();expect(screen.queryByText('Krea2/model.safetensors')).toBeNull();expect(screen.getByText('second')).toBeTruthy();
 rerender(<I18nProvider><GenerationMetadata job={null}/></I18nProvider>);
 expect(screen.queryByText('second')).toBeNull();expect(screen.getByText('Select an image or generated job to see its metadata.')).toBeTruthy();
});

test('an explicit apply button hands reusable settings back and reports what was skipped; absent for metadata without generation data',async()=>{
 localStorage.setItem('deas.locale.v1','en');
 const onApply=vi.fn((s:{checkpoint?:string})=>s.checkpoint==='m'?['Model: m']:[]);
 render(<I18nProvider><GenerationMetadata job={job} onApply={onApply}/></I18nProvider>);
 (await screen.findByRole('button',{name:'Use these settings'})).click();
 expect(onApply).toHaveBeenCalledWith({positive:'<img src=x onerror=alert(1)> forest',negative:'blur',checkpoint:'Krea2/model.safetensors',seed:940563189,steps:8,cfg:1,sampler:'euler',scheduler:'simple',width:896,height:1152,loras:[{name:'style.safetensors',strength:0.7}]});
 expect(await screen.findByText('All settings applied.')).toBeTruthy();
 cleanup();
 const media=(name:string,kind:'image'|'video'='image')=>({name,path:`/images/${name}`,src:`asset:///${name}`,media:kind});
 vi.mocked(readImageMetadata).mockResolvedValueOnce([['parameters','cat\nSteps: 4, Sampler: Euler a, CFG scale: 2, Seed: 9, Size: 64x64, Model: m']]);
 const {rerender}=render(<I18nProvider><GenerationMetadata job={null} media={media('a.png')} onApply={onApply}/></I18nProvider>);
 (await screen.findByRole('button',{name:'Use these settings'})).click();
 expect(onApply).toHaveBeenLastCalledWith({positive:'cat',checkpoint:'m',seed:9,steps:4,cfg:2,sampler:'euler_ancestral',width:64,height:64});
 expect(await screen.findByText('Not carried over: Model: m')).toBeTruthy();
 // Videos carry only the ComfyUI prompt/workflow container tags.
 vi.mocked(readImageMetadata).mockResolvedValueOnce([['prompt',JSON.stringify({'5':{class_type:'KSampler',inputs:{seed:5,steps:3,cfg:1,sampler_name:'euler',scheduler:'simple'}}})],['workflow','{}']]);
 rerender(<I18nProvider><GenerationMetadata job={null} media={media('clip.mp4','video')} onApply={onApply}/></I18nProvider>);
 (await screen.findByRole('button',{name:'Use these settings'})).click();
 expect(onApply).toHaveBeenLastCalledWith({seed:5,steps:3,cfg:1,sampler:'euler',scheduler:'simple'});
 vi.mocked(readImageMetadata).mockResolvedValueOnce([['Description','plain']]);
 rerender(<I18nProvider><GenerationMetadata job={null} media={media('b.png')} onApply={onApply}/></I18nProvider>);
 expect(await screen.findByText('plain')).toBeTruthy();expect(screen.queryByRole('button',{name:'Use these settings'})).toBeNull();
});

test('offers editor workflows only, disables without the owned backend, and reports import failures',async()=>{
 localStorage.setItem('deas.locale.v1','en');
 const workflow={nodes:[{id:1,type:'CLIPTextEncode'}],links:[],version:0.4};
 const media={name:'clip.mp4',path:'/images/clip.mp4',src:'asset:///clip.mp4',media:'video' as const};
 vi.mocked(readImageMetadata).mockResolvedValue([['workflow',JSON.stringify(workflow)]]);
 const onOpen=vi.fn().mockResolvedValue(undefined);
 const {rerender}=render(<I18nProvider><GenerationMetadata job={null} media={media}/></I18nProvider>);
 expect((await screen.findByRole('button',{name:'Open in Comfy'}) as HTMLButtonElement).disabled).toBe(true);
 rerender(<I18nProvider><OpenComfyWorkflow.Provider value={onOpen}><GenerationMetadata job={null} media={media}/></OpenComfyWorkflow.Provider></I18nProvider>);
 const openButton=await screen.findByRole('button',{name:'Open in Comfy'});
 await act(async()=>openButton.click());
 expect(onOpen).toHaveBeenCalledWith(workflow,'clip.mp4');
 onOpen.mockRejectedValueOnce(new Error('unsupported'));
 await act(async()=>openButton.click());
 expect(await screen.findByRole('alert')).toBeTruthy();
 vi.mocked(readImageMetadata).mockResolvedValueOnce([['workflow','{}']]);
 rerender(<I18nProvider><GenerationMetadata job={null} media={{...media,src:'asset:///bad.mp4',path:'/images/bad.mp4'}}/></I18nProvider>);
 await screen.findByText('{}');expect(screen.queryByRole('button',{name:'Open in Comfy'})).toBeNull();
});

test('reads selected local images, clears stale values, ignores late replies and reports empty/error states',async()=>{
 localStorage.setItem('deas.locale.v1','en');
 let finishOld!:(value:[string,string][])=>void;
 vi.mocked(readImageMetadata).mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;}));
 const media=(name:string)=>({name,path:`/images/${name}`,src:`asset:///${name}`,media:'image' as const});
 const {container,rerender}=render(<I18nProvider><GenerationMetadata job={null} media={media('old.png')}/></I18nProvider>);
 expect(screen.getByText('Reading image metadata…')).toBeTruthy();
 vi.mocked(readImageMetadata).mockResolvedValueOnce([['parameters',JSON.stringify({sui_image_params:{prompt:'<img src=x> imported',model:'old-model',seed:42}})]]);
 rerender(<I18nProvider><GenerationMetadata job={null} media={media('new.png')}/></I18nProvider>);
 expect(await screen.findByText('<img src=x> imported')).toBeTruthy();expect(container.querySelector('img')).toBeNull();
 await act(async()=>finishOld([['parameters','late old image']]));
 expect(screen.queryByText('late old image')).toBeNull();
 vi.mocked(readImageMetadata).mockResolvedValueOnce([]);
 rerender(<I18nProvider><GenerationMetadata job={null} media={media('empty.png')}/></I18nProvider>);
 expect(screen.queryByText('old-model')).toBeNull();expect(await screen.findByText('No embedded metadata found.')).toBeTruthy();
 vi.mocked(readImageMetadata).mockRejectedValueOnce(new Error('bad chunk'));
 rerender(<I18nProvider><GenerationMetadata job={null} media={media('bad.png')}/></I18nProvider>);
 expect(await screen.findByText('Image metadata could not be read.')).toBeTruthy();
 rerender(<I18nProvider><GenerationMetadata job={job}/></I18nProvider>);
 expect(screen.getByText('Krea2/model.safetensors')).toBeTruthy();
});
