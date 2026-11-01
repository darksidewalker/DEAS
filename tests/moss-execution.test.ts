import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe, type DiagnosticImageIntentV1 } from '../src/lib/execution.ts';

const intent: DiagnosticImageIntentV1 = {
 recipeId:'checkpoint-text-to-image-diagnostic', version:1,
 positivePrompt:'forest', negativePrompt:'blur', checkpoint:'moss.safetensors',
 diffusion:{textEncoder:'encoder.safetensors',clipType:'moss_image',vae:'flux2.safetensors'},
 width:512,height:768,seed:42,steps:20,cfg:3,sampler:'euler',scheduler:'normal',outputPrefix:'DEAS',
};
const nodes=['UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode','EmptyFlux2LatentImage','KSampler','VAEDecode','SaveImage'];
const allow={nodes,checkpoints:[],diffusionModels:['moss.safetensors'],textEncoders:['encoder.safetensors'],clipTypes:['moss_image'],vaes:['flux2.safetensors'],samplers:['euler'],schedulers:['normal'],images:['ref.png']};

test('MOSS uses exact Flux2 latent and only emitted t2i prerequisites',()=>{
 const result=compileRecipe(intent,allow);
 assert.deepEqual(result.graph['4'],{class_type:'EmptyFlux2LatentImage',inputs:{width:512,height:768,batch_size:1}});
 assert.deepEqual(result.graph.C.inputs,{clip_name:'encoder.safetensors',type:'moss_image'});
 assert.deepEqual(result.graph['6'].inputs.vae,['V',0]);
 assert.deepEqual(new Set(result.requiredNodes),new Set(nodes));
 assert.deepEqual(result.requiredModels,[{kind:'diffusionModel',identifier:'moss.safetensors'},{kind:'textEncoder',identifier:'encoder.safetensors'},{kind:'vae',identifier:'flux2.safetensors'}]);
});

test('MOSS i2i preserves denoise with ordinary VAEEncode and no empty latent requirement',()=>{
 const result=compileRecipe({...intent,inputImage:'ref.png',denoise:0.37},{...allow,nodes:[...nodes.filter(n=>n!=='EmptyFlux2LatentImage'),'LoadImage','VAEEncode']});
 assert.equal(result.graph['4'],undefined);
 assert.deepEqual(result.graph['9'],{class_type:'VAEEncode',inputs:{pixels:['8',0],vae:['V',0]}});
 assert.deepEqual(result.graph['5'].inputs.latent_image,['9',0]);
 assert.equal(result.graph['5'].inputs.denoise,0.37);
});

test('MOSS verifies each emitted node and exact component choice',()=>{
 for(const node of nodes) assert.throws(()=>compileRecipe(intent,{...allow,nodes:nodes.filter(n=>n!==node)}),new RegExp(node));
 for(const field of ['diffusionModels','textEncoders','clipTypes','vaes'] as const) assert.throws(()=>compileRecipe(intent,{...allow,[field]:[]}),/not in the verified/);
 const image={...intent,inputImage:'ref.png',denoise:0.37};
 const imageNodes=[...nodes.filter(n=>n!=='EmptyFlux2LatentImage'),'LoadImage','VAEEncode'];
 for(const node of imageNodes) assert.throws(()=>compileRecipe(image,{...allow,nodes:imageNodes.filter(n=>n!==node)}),new RegExp(node));
});

test('MOSS rejects /8-only canvases and unproved combinations but accepts aligned resize',()=>{
 for(const image of [false,true]) {
  const base={...intent,...(image?{inputImage:'ref.png',denoise:0.37}:{})};
  for(const size of [{width:520},{height:776}]) assert.throws(()=>compileRecipe({...base,...size},allow),/multiples of 16/);
 }
 const image={...intent,inputImage:'ref.png',denoise:0.37};
 for(const extra of [
  {refine:{width:1024,height:1024,denoise:0.5}},
  {inputLayers:[{image:'ref.png',x:0,y:0,width:512,height:768}]},
  {sigmas:Array.from({length:21},(_,n)=>(20-n)/20)},
  {loras:[{name:'style.safetensors',strength:1}]},
  {options:{vaeTile:512}},
  {inputResize:{width:512,height:768,crop:'disabled',pad:{left:0,right:0,top:0,bottom:0}}},
 ]) assert.throws(()=>compileRecipe({...image,...extra},allow),/MOSS-Image supports plain/);
 const resize={width:512,height:768,crop:'disabled'};
 assert.doesNotThrow(()=>compileRecipe({...image,inputResize:resize},{...allow,nodes:[...nodes,'LoadImage','VAEEncode','ImageScale']}));
 // A painted mask rides the model-independent inpaint graph.
 const mask='deas-masks/4907ef27-6ffc-4fe9-a5af-56bbac500c11.png';
 const masked=compileRecipe({...image,inputMask:mask},{...allow,images:['ref.png',mask],nodes:[...nodes,'LoadImage','VAEEncode','LoadImageMask','SetLatentNoiseMask','ImageCompositeMasked']});
 assert.equal(masked.graph.X.class_type,'SetLatentNoiseMask');
 assert.deepEqual(masked.graph['5'].inputs.latent_image,['X',0]);
 assert.equal(masked.graph.Y.class_type,'ImageCompositeMasked');
});
