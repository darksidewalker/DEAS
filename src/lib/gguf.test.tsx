import { expect, test } from 'vitest';
import { compileRecipe } from './execution';
import { componentFiles } from './modelComponents';
const intent={recipeId:'checkpoint-text-to-image-diagnostic',version:1,positivePrompt:'forest',negativePrompt:'',checkpoint:'base.gguf',seed:42,width:512,height:768,steps:20,cfg:7,sampler:'euler',scheduler:'normal',outputPrefix:'raw/test',diffusion:{textEncoder:'umt5.gguf',clipType:'wan',vae:'vae.safetensors'}};
const allow={nodes:['UnetLoaderGGUF','CLIPLoaderGGUF','VAELoader','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage'],checkpoints:[],diffusionModels:[],ggufDiffusionModels:['base.gguf'],textEncoders:[],ggufTextEncoders:['umt5.gguf'],ggufClipTypes:['wan'],clipTypes:[],vaes:['vae.safetensors'],samplers:['euler'],schedulers:['normal']};
test('GGUF diagnostic preview uses quantized loader catalogs and preserves exact identifiers',()=>{
 const graph=compileRecipe(intent,allow).graph;
 expect(graph['1']).toEqual({class_type:'UnetLoaderGGUF',inputs:{unet_name:'base.gguf'}});
 expect(graph.C.class_type).toBe('CLIPLoaderGGUF');
 expect(()=>compileRecipe(intent,{...allow,nodes:allow.nodes.filter(n=>n!=='CLIPLoaderGGUF')})).toThrow(/node is unavailable/);
 expect(()=>compileRecipe(intent,{...allow,ggufTextEncoders:[]})).toThrow(/not in/);
});
test('GGUF is not a self-contained checkpoint, VAE or LoRA format',()=>{
 const {diffusion,...checkpoint}=intent;
 expect(()=>compileRecipe(checkpoint,allow)).toThrow(/GGUF requires a diffusion recipe/);
 expect(()=>compileRecipe({...intent,diffusion:{...diffusion,vae:'vae.gguf'}},allow)).toThrow(/GGUF VAE/);
 for(const name of ['style.gguf','style.ckpt'])expect(()=>compileRecipe({...intent,checkpoint:'base.safetensors',loras:[{name,strength:1}]},allow)).toThrow(/safetensors/);
 expect(()=>compileRecipe({...intent,loras:[{name:'style.safetensors',strength:1}]},allow)).toThrow(/LoRA on a GGUF base/);
});
test('GGUF remains an encoder choice but is excluded from VAE and projection slots even with All files',()=>{
 const files=['text_encoders','vae'].map(category=>({category,name:'companion.gguf',path:`/m/${category}/companion.gguf`,size:1,info:null}));
 const family={textEncoders:['companion'],vaes:['companion'],audioVaes:['companion'],textProjections:['companion']};
 expect(componentFiles(files,family,'textEncoders',true)).toEqual(['companion.gguf']);
 for(const slot of ['vaes','audioVaes','textProjections'] as const)expect(componentFiles(files,family,slot,true)).toEqual([]);
});
