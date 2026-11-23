import { expect, test } from 'vitest';
import { generationSettings } from './imageMetadata';
import { aspectOf } from './resolution';
// Literal graphs from a real DEAS 0.3.23 Krea 2 pair (prompt text shortened): the Upscale-alone
// post-process output and the generation it was made from (its `deas-inputs` source upload).
const upscaled={"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "Krea2/DaSiWa-Krea2-Turbo-UC-DarkDesire-v3.safetensors", "weight_dtype": "default"}}, "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L3", 1], "text": "a woman in a void"}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L3", 1], "text": ""}}, "5": {"class_type": "KSampler", "inputs": {"cfg": 1.0, "denoise": 0.0, "latent_image": ["9", 0], "model": ["L3", 0], "negative": ["3", 0], "positive": ["2", 0], "sampler_name": "euler", "scheduler": "simple", "seed": 4155682127, "steps": 8}}, "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["V", 0]}}, "7": {"class_type": "DaSiWa_MetadataImageSaver", "inputs": {"compression": 44, "file_format": "png", "filename_prefix": "raw/image/2026-11-23/12-08-10-4155682127-DaSiWa-Krea2-Turbo-UC-DarkDesire-v3", "images": ["6", 0], "metadata_config": ["M", 0], "save_output": true}}, "8": {"class_type": "LoadImage", "inputs": {"image": "deas-inputs/cfb3ec09-e98e-49e1-8b5d-d2bdbfcd29d4.png"}}, "9": {"class_type": "VAEEncode", "inputs": {"pixels": ["S", 0], "vae": ["V", 0]}}, "C": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_bf16.safetensors", "type": "krea2"}}, "L1": {"class_type": "LoraLoader", "inputs": {"clip": ["C", 0], "lora_name": "Krea2/Ultra_Detailed_krea2.safetensors", "model": ["1", 0], "strength_clip": 0.25, "strength_model": 0.25}}, "L2": {"class_type": "LoraLoader", "inputs": {"clip": ["L1", 1], "lora_name": "Krea2/We_All_Starve.safetensors", "model": ["L1", 0], "strength_clip": 0.15, "strength_model": 0.15}}, "L3": {"class_type": "LoraLoader", "inputs": {"clip": ["L2", 1], "lora_name": "Krea2/DaSiWa_AlluringAbyss_Krea2-v1.safetensors", "model": ["L2", 0], "strength_clip": 0.25, "strength_model": 0.25}}, "M": {"class_type": "DaSiWa_MetadataConfig", "inputs": {"model_hash": "", "node_latent": ["5", 0], "node_model": ["1", 0], "node_negative": ["3", 0], "node_positive": ["2", 0], "save_workflow": true}}, "S": {"class_type": "ImageScale", "inputs": {"crop": "disabled", "height": 2304, "image": ["UM", 0], "upscale_method": "lanczos", "width": 1792}}, "UL": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "2x-AnimeSharpV4_RCAN.safetensors"}}, "UM": {"class_type": "ImageUpscaleWithModel", "inputs": {"image": ["8", 0], "upscale_model": ["UL", 0]}}, "V": {"class_type": "VAELoader", "inputs": {"vae_name": "QwenImage/qwen_image_vae.safetensors"}}};
const generated={"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "Krea2/DaSiWa-Krea2-Turbo-UC-DarkDesire-v3.safetensors", "weight_dtype": "default"}}, "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L3", 1], "text": "a woman in a void"}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L3", 1], "text": ""}}, "4": {"class_type": "EmptyLatentImage", "inputs": {"batch_size": 1, "height": 1152, "width": 896}}, "5": {"class_type": "KSampler", "inputs": {"cfg": 1.0, "denoise": 1.0, "latent_image": ["4", 0], "model": ["L3", 0], "negative": ["3", 0], "positive": ["2", 0], "sampler_name": "euler", "scheduler": "simple", "seed": 122329910, "steps": 8}}, "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["V", 0]}}, "7": {"class_type": "DaSiWa_MetadataImageSaver", "inputs": {"compression": 44, "file_format": "png", "filename_prefix": "raw/image/2026-11-23/12-07-09-122329910-DaSiWa-Krea2-Turbo-UC-DarkDesire-v3", "images": ["6", 0], "metadata_config": ["M", 0], "save_output": true}}, "C": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_bf16.safetensors", "type": "krea2"}}, "L1": {"class_type": "LoraLoader", "inputs": {"clip": ["C", 0], "lora_name": "Krea2/Ultra_Detailed_krea2.safetensors", "model": ["1", 0], "strength_clip": 0.25, "strength_model": 0.25}}, "L2": {"class_type": "LoraLoader", "inputs": {"clip": ["L1", 1], "lora_name": "Krea2/We_All_Starve.safetensors", "model": ["L1", 0], "strength_clip": 0.15, "strength_model": 0.15}}, "L3": {"class_type": "LoraLoader", "inputs": {"clip": ["L2", 1], "lora_name": "Krea2/DaSiWa_AlluringAbyss_Krea2-v1.safetensors", "model": ["L2", 0], "strength_clip": 0.25, "strength_model": 0.25}}, "M": {"class_type": "DaSiWa_MetadataConfig", "inputs": {"model_hash": "", "node_latent": ["5", 0], "node_model": ["1", 0], "node_negative": ["3", 0], "node_positive": ["2", 0], "save_workflow": true}}, "V": {"class_type": "VAELoader", "inputs": {"vae_name": "QwenImage/qwen_image_vae.safetensors"}}};
test('an Upscale-alone output exposes its source upload, model upscale and exact size, and the split-loader components',()=>{
 const s=generationSettings([['prompt',JSON.stringify(upscaled)]]);
 expect(s).toMatchObject({checkpoint:'Krea2/DaSiWa-Krea2-Turbo-UC-DarkDesire-v3.safetensors',width:1792,height:2304,inputImage:'deas-inputs/cfb3ec09-e98e-49e1-8b5d-d2bdbfcd29d4.png',denoise:0,upscaleModel:'2x-AnimeSharpV4_RCAN.safetensors',textEncoder:'qwen3vl_4b_bf16.safetensors',vae:'QwenImage/qwen_image_vae.safetensors'});
 expect(s?.loras).toEqual([{name:'Krea2/Ultra_Detailed_krea2.safetensors',strength:0.25},{name:'Krea2/We_All_Starve.safetensors',strength:0.15},{name:'Krea2/DaSiWa_AlluringAbyss_Krea2-v1.safetensors',strength:0.25}]);
 expect(s?.skipped).toBeUndefined();
});
// The post job recorded the seed then in the controls (4155682127); only the source carries the generation's own.
test('the source generation restores its own canvas and components, with no image-to-image fields',()=>{
 const s=generationSettings([['prompt',JSON.stringify(generated)]]);
 expect(s).toMatchObject({width:896,height:1152,seed:122329910,steps:8,cfg:1,sampler:'euler',scheduler:'simple',textEncoder:'qwen3vl_4b_bf16.safetensors',vae:'QwenImage/qwen_image_vae.safetensors'});
 expect(s?.inputImage).toBeUndefined();expect(s?.denoise).toBeUndefined();expect(s?.upscaleModel).toBeUndefined();
});
test('a fixed canvas names its aspect preset, else a custom reduced ratio within the 100 cap',()=>{
 expect(aspectOf(896,1152)).toEqual({aspect:'7:9'});
 expect(aspectOf(1792,2304)).toEqual({aspect:'7:9'});
 expect(aspectOf(1024,1024)).toEqual({aspect:'1:1'});
 expect(aspectOf(1216,832)).toEqual({aspect:'custom',custom:{width:19,height:13}});
 expect(aspectOf(1000,999)).toEqual({aspect:'custom',custom:{width:100,height:99.9}});
});
// Shape of a real DEAS 0.3.23 MiniMax H3 I2VA video graph (model chain: guider → preview → SigmaShift → Director port 5 → MAIDialRack → UNET).
const h3=(rack:string|null,continuity:object={})=>({
 '1':{class_type:'UNETLoader',inputs:{unet_name:'MiniMaxH3/h3.safetensors',weight_dtype:'default'}},
 '5':{class_type:'SamplerCustomAdvanced',inputs:{guider:['B',0],latent_image:['G',1],noise:['N',0],sampler:['Q',0],sigmas:['Z',0]}},
 B:{class_type:'BasicGuider',inputs:{conditioning:['G',0],model:['VP1',0]}},
 C:{class_type:'CLIPLoader',inputs:{clip_name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',type:'minimax'}},
 D:{class_type:'MiniMaxH3Director',inputs:{duration:5.166666666666667,fl2va_model:[rack?'DR':'1',0],frame_rate:24,height:992,width:768,mode:'I2VA',prompt:'p',timeline_data:JSON.stringify({continuity})}},
 ...(rack?{DR:{class_type:'MAIDialRack',inputs:{model:['1',0],rack}}}:{}),
 G:{class_type:'MiniMaxH3DirectorGuide',inputs:{clip:['C',0],guide:['D',0]}},
 N:{class_type:'RandomNoise',inputs:{noise_seed:3932482046}},Q:{class_type:'KSamplerSelect',inputs:{sampler_name:'res_multistep'}},
 SS:{class_type:'MiniMaxH3SigmaShift',inputs:{model:['D',5],shift_audio:3,shift_video:10}},
 VP1:{class_type:'ModelPreviewOverrideKJ',inputs:{model:['SS',0]}},
 Z:{class_type:'BasicScheduler',inputs:{model:['VP1',0],scheduler:'simple',steps:8,denoise:1}},
});
test('H3 video metadata carries the Dial Rack rows that ran; a rackless H3 graph clears them; a broken rack is disclosed',()=>{
 expect(generationSettings([['prompt',JSON.stringify(h3('[{"dial":"dials/h3_evil_seductive.safetensors","strength":1.25}]'))]])?.dials).toEqual([{dial:'dials/h3_evil_seductive.safetensors',strength:1.25}]);
 const curve='[{"dial":"dials/a.safetensors","strength":1,"time":{"type":"keys","points":[[0,0],[5,1]],"unit":"seconds","steps":6}}]';
 expect(generationSettings([['prompt',JSON.stringify(h3(curve,{session:'deas',source_id:''}))]])?.dials?.[0].time?.points).toEqual([[0,0],[5,1]]);
 expect(generationSettings([['prompt',JSON.stringify(h3(null))]])?.dials).toEqual([]);
 const broken=generationSettings([['prompt',JSON.stringify(h3('[{"dial":"../x.safetensors","strength":1}]'))]]);
 expect(broken?.dials).toBeUndefined();expect(broken?.skipped).toContain('dials');
 // A continued segment's curves are in the clip's own seconds: not restored as authored.
 const continued=generationSettings([['prompt',JSON.stringify(h3(curve,{source_id:'take-1'}))]]);
 expect(continued?.dials).toBeUndefined();expect(continued?.skipped).toContain('dials.time');
 // Image graphs know nothing of dials.
 expect(generationSettings([['prompt',JSON.stringify(generated)]])?.dials).toBeUndefined();
});
