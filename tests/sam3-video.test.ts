import test from 'node:test';
import assert from 'node:assert/strict';
import {isSam3Intent,isSam3VideoIntent,sam3VideoNodes,type Sam3VideoMaskIntentV1} from '../src/lib/sam3.ts';
const intent=():Sam3VideoMaskIntentV1=>({recipeId:'sam3-video-mask',version:1,checkpoint:'SAM3/sam3.1.safetensors',sourceVideo:'deas-input-source.mp4',outputPrefix:'DEAS/SAM3/face-mask',threshold:0.5,maxObjects:4,detectInterval:1,startSeconds:0,durationSeconds:2});
test('SAM video analysis has a separate strict contract, never an image mask/generation intent',()=>{
 assert.equal(isSam3VideoIntent(intent()),true);assert.equal(isSam3Intent(intent()),false);
 assert.equal(isSam3VideoIntent({...intent(),checkpoint:'SAM3\\sam3.1.safetensors'}),true);
 assert.equal(isSam3VideoIntent({...intent(),maxObjects:64,detectInterval:2_147_483_647}),true);
 for(const key of Object.keys(intent())){const raw:Record<string,unknown>={...intent()};delete raw[key];assert.equal(isSam3VideoIntent(raw),false,key);}
 for(const [key,value] of [['recipeId','sam3-mask'],['version',2],['prompt','face'],['enabled',true],['maxObjects',0],['maxObjects',65],['maxObjects',1.5],['detectInterval',0],['detectInterval',1.5],['detectInterval',2_147_483_648],['startSeconds',-1],['startSeconds',Infinity],['durationSeconds',0],['durationSeconds',NaN],['threshold',1.01],['threshold',-0.1],['threshold',NaN],['sourceVideo','/source.mp4'],['sourceVideo','folder/source.mp4'],['sourceVideo','source.mp4 [output]'],['sourceVideo','[input]source.mp4'],['sourceVideo','..\\source.mp4'],['sourceVideo','http://host/source.mp4'],['checkpoint','../model'],['outputPrefix','../mask']] as const){assert.equal(isSam3VideoIntent({...intent(),[key]:value}),false,`${key}=${value}`);}
 for(const sceneThreshold of [0.3,1,Number.MIN_VALUE])assert.equal(isSam3VideoIntent({...intent(),sceneThreshold}),true);
 for(const sceneThreshold of [0,-0.1,1.01,NaN,Infinity,-Infinity,undefined,null,'0.3',true])assert.equal(isSam3VideoIntent({...intent(),sceneThreshold}),false,`${sceneThreshold}`);
 assert.equal(isSam3VideoIntent({...intent(),sceneThreshold:0.3,unknown:true}),false);
 assert.equal(isSam3VideoIntent({...intent(),startSeconds:Number.MAX_VALUE,durationSeconds:Number.MAX_VALUE}),false);
 assert.deepEqual(sam3VideoNodes,['CheckpointLoaderSimple','CLIPTextEncode','LoadVideo','DEAS_SAM3VideoWindow','GetVideoComponents','SAM3_VideoTrack','SAM3_TrackToMask','MaskToImage','CreateVideo','SaveVideo']);
});
