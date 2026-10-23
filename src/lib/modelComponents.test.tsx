import { expect, test } from 'vitest';
import { componentFiles, defaultComponentOverrides, isComponentOverrides } from './modelComponents';
import type { LocalModel } from './models';
const model=(category:string,name:string,component?:string):LocalModel=>({category,name,component,path:'/models/'+category+'/'+name,size:1,info:null});
const family={textEncoders:['qwen_3_600m'],vaes:['wan_2.1_vae'],components:{textEncoders:['qwen3-0.6b'],vaes:['wan-2.1-vae']}};
test('header compatibility survives renaming and rejects a misleading name with a different architecture',()=>{
 const files=[model('text_encoders','dasiwaAnima_luminousLabyrinthV1_txt.safetensors','qwen3-0.6b'),model('clip','qwen_3_600m-wrong.safetensors','qwen3-vl-8b'),model('vae','vae.safetensors','wan-2.1-vae')];
 expect(componentFiles(files,family,'textEncoders')).toEqual(['dasiwaAnima_luminousLabyrinthV1_txt.safetensors']);
 expect(componentFiles(files,family,'vaes')).toEqual(['vae.safetensors']);
 expect(componentFiles(files,family,'textEncoders',true)).toHaveLength(2);
 expect(componentFiles(files,family,'vaes',true)).toEqual(['vae.safetensors']);
});
test('unknown formats keep filename hints, while All files is bounded to the slot category',()=>{
 const files=[model('text_encoders','qwen_3_600m.gguf'),model('clip','renamed.safetensors'),model('checkpoints','not-an-encoder.safetensors'),model('vae','wan_2.1_vae.safetensors')];
 expect(componentFiles(files,family,'textEncoders')).toEqual(['qwen_3_600m.gguf']);
 expect(componentFiles(files,family,'textEncoders',true)).toEqual(['qwen_3_600m.gguf','renamed.safetensors']);
 expect(componentFiles(files,family,'audioVaes',true)).toEqual(['wan_2.1_vae.safetensors']);
});
test('component overrides default off and restored values require every boolean flag',()=>{
 expect(Object.values(defaultComponentOverrides).every(value=>value===false)).toBe(true);
 expect(isComponentOverrides({...defaultComponentOverrides,textEncoders:true})).toBe(true);
 for(const value of [null,{},[],{...defaultComponentOverrides,textEncoders:'true'},{...defaultComponentOverrides,other:true}])expect(isComponentOverrides(value)).toBe(false);
});
