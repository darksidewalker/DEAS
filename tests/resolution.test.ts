import test from 'node:test';
import assert from 'node:assert/strict';
import { aspects, resolutions, canvasSize, scaleInput, validCanvas } from '../src/lib/resolution.ts';
const square={width:1024,height:1024},wide={width:1920,height:1080};
test('Director ratios, added ultrawide/portrait ratios and every resolution snap to a bounded canvas',()=>{
 for(const aspect of aspects.filter(a=>a!=='custom'))for(const resolution of ['model',...Object.keys(resolutions)]){
  const size=canvasSize(aspect,resolution,wide,1,square,square,wide);
  assert.ok(validCanvas(size),`${aspect} ${resolution}: ${JSON.stringify(size)}`);
 }
 assert.deepEqual(canvasSize('1:1','model',wide,1,square,{width:2048,height:2048}),{width:2048,height:2048});
 assert.deepEqual(canvasSize('1:1','model',wide,1,square,{width:512,height:512}),{width:512,height:512});
 assert.deepEqual(canvasSize('auto','fixed',wide,1,{width:768,height:512},square,wide),{width:768,height:512});
 const portrait=canvasSize('custom','custom',{width:2,height:3},1,square,square);
 assert.ok(portrait.height>portrait.width);
 // 1024²-based megapixels on the model grid: SDXL buckets (64), Director/H3 (32), latent×patch (16).
 assert.deepEqual(canvasSize('3:4','1024p',wide,1,square,square,undefined,64),{width:896,height:1152});
 assert.deepEqual(canvasSize('3:4','1024p',wide,1,square,square,undefined,32),{width:896,height:1184});
 assert.deepEqual(canvasSize('3:4','1024p',wide,1,square,square),{width:880,height:1184});
 assert.equal(validCanvas({width:8192,height:8192}),false);
 assert.equal(validCanvas({width:1023,height:1024}),false);
});
test('input scaling resolves concrete resize/crop/pad and actual downstream dimensions',()=>{
 assert.deepEqual(scaleInput('off',wide,square),{size:{width:1920,height:1072}});
 assert.deepEqual(scaleInput('off',wide,square,8),{size:{width:1920,height:1080}});
 assert.deepEqual(scaleInput('auto',wide,square),scaleInput('off',wide,square));
 assert.deepEqual(scaleInput('auto',{width:6000,height:3000},square),{size:{width:4096,height:2048},resize:{width:4096,height:2048,crop:'disabled'}});
 assert.deepEqual(scaleInput('target',wide,square),{size:square,resize:{...square,crop:'disabled'}});
 assert.deepEqual(scaleInput('crop',wide,square),{size:square,resize:{...square,crop:'center'}});
 assert.deepEqual(scaleInput('fit',wide,square),{size:{width:1024,height:576},resize:{width:1024,height:576,crop:'disabled'}});
 assert.deepEqual(scaleInput('pad',wide,square),{size:square,resize:{width:1024,height:576,crop:'disabled',pad:{left:0,right:0,top:224,bottom:224}}});
});
