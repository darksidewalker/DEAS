import {expect,test} from 'vitest';
import type {LocalModel} from './models';
import type {CatalogEntry} from './downloads';
import {modelCompanionAdvice} from './modelCompanionAdvice';
const model:LocalModel={name:'renamed.safetensors',path:'/m/renamed',category:'diffusion_models',family:'anima',size:1,info:null};
const entry:CatalogEntry={id:'vae',label:'Wan VAE',providerId:'huggingface',scope:'index',locator:'direct:https://huggingface.co/Comfy-Org/models/resolve/main/wan_2.1_vae.safetensors',kind:'file',target:'vae'};
test('split models expose missing family slots, not filename-derived families or self-contained checkpoints',()=>{
 expect(modelCompanionAdvice(model,[]).map(s=>[s.slot,s.target])).toEqual([['textEncoders','text_encoders'],['vaes','vae']]);
 expect(modelCompanionAdvice({...model,family:undefined},[])).toEqual([]);
 expect(modelCompanionAdvice({...model,category:'checkpoints'},[])).toEqual([]);
 expect(modelCompanionAdvice({...model,integrity:'truncated'},[])).toEqual([]);
});
test('existing component matcher honors renamed identities, broken files and conflicting identities',()=>{
 const vae={...model,category:'vae',name:'renamed-vae.safetensors',component:'wan-2.1-vae'};
 expect(modelCompanionAdvice(model,[vae]).map(s=>s.slot)).toEqual(['textEncoders']);
 expect(modelCompanionAdvice(model,[{...vae,integrity:'truncated'}])).toHaveLength(2);
 expect(modelCompanionAdvice(model,[{...vae,name:'wan_2.1_vae.safetensors',component:'flux2-vae'}])).toHaveLength(2);
});
test('dual-loader families expose the missing second encoder using the existing named matcher',()=>{
 const flux={...model,family:'flux'};
 const first={...model,category:'text_encoders',name:'clip_l.safetensors',component:'clip-l'};
 const slots=modelCompanionAdvice(flux,[first]);
 expect(slots.find(s=>s.slot==='textEncoders2')?.patterns).toEqual(['t5xxl']);
 expect(modelCompanionAdvice(flux,[first,{...first,name:'t5xxl.safetensors',component:'t5xxl'}]).some(s=>s.slot==='textEncoders2')).toBe(false);
});

test('only caller-trusted exact file basenames associate; labels, repositories and wrong targets do not',()=>{
 const candidates=[entry,{...entry,id:'label',label:'wan_2.1_vae.safetensors',locator:'direct:https://huggingface.co/unrelated.bin'},{...entry,id:'repo',scope:'repo' as const,locator:'models:wan_2.1_vae'},{...entry,id:'wrong',target:'loras'}];
 expect(modelCompanionAdvice(model,[],candidates).find(s=>s.slot==='vaes')?.entries.map(e=>e.id)).toEqual(['vae']);
 expect(modelCompanionAdvice(model,[]).every(s=>s.entries.length===0)).toBe(true);
});
