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
 // SwarmUI reference table scaled to the 1024 side = SDXL training buckets at every grid; area-exact rounding alone gave 1280×832 (3:2) and 880×1184 (3:4).
 for(const grid of [64,32,16]){
  assert.deepEqual(canvasSize('3:4','1024p',wide,1,square,square,undefined,grid),{width:896,height:1152});
  assert.deepEqual(canvasSize('3:2','1024p',wide,1,square,square,undefined,grid),{width:1216,height:832});
  assert.deepEqual(canvasSize('16:9','1024p',wide,1,square,square,undefined,grid),{width:1344,height:768});
  assert.deepEqual(canvasSize('21:9','1024p',wide,1,square,square,undefined,grid),{width:1536,height:640});
 }
 // Non-square model size uses its area side (SwarmUI sqrt(w*h)); ratios outside the table stay area-exact on the grid.
 assert.deepEqual(canvasSize('16:9','model',wide,1,square,{width:1280,height:720}),{width:1264,height:720});
 assert.deepEqual(canvasSize('2:1','1024p',wide,1,square,square),{width:1456,height:720});
 assert.equal(validCanvas({width:8192,height:8192}),false);
 assert.equal(validCanvas({width:1023,height:1024}),false);
});
test('7:9 and 9:7 use area-exact sizing on each pipeline grid, not a shared bucket',()=>{
 for(const aspect of ['7:9','9:7']){
  assert.ok((aspects as readonly string[]).includes(aspect));
  for(const [grid,w,h] of [[8,904,1160],[16,896,1168],[32,896,1152],[64,896,1152]]){
   const expected=aspect==='7:9'?{width:w,height:h}:{width:h,height:w};
   assert.deepEqual(canvasSize(aspect,'1024p',wide,1,square,square,undefined,grid),expected,`${aspect} /${grid}`);
   assert.deepEqual(canvasSize('custom','custom',aspect==='7:9'?{width:7,height:9}:{width:9,height:7},1,square,square,undefined,grid),expected);
  }
 }
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
test('the generic canvas wall floors at one latent cell; the family grid is a separate law (PLAN D-15)',()=>{
 // 8 is one latent-grid cell (`VAEEncode`/`EmptyLatentImage` divide by 8); the old 64 floor
 // was SDXL's grid mistaken for a universal law. What bounds an edge now is the family's own
 // `multiple`, applied by the Workbench (`requiredCanvasGrid`) and natively
 // (`jobs::family_grid_refusal`) - this wall cannot see the family, so it stays generic.
 assert.ok(validCanvas({width:8,height:8}));
 assert.ok(validCanvas({width:56,height:56}));
 assert.ok(validCanvas({width:24,height:24}));
 assert.equal(validCanvas({width:7,height:8}),false);
 assert.equal(validCanvas({width:8200,height:64}),false);
 // Input scaling floors at the model grid, not a hardcoded 64: an 8-grid family keeps a
 // small input's own size instead of having it inflated to another family's grid.
 assert.deepEqual(scaleInput('off',{width:60,height:24},{width:1024,height:1024},8),{size:{width:56,height:24}});
 assert.deepEqual(scaleInput('off',{width:60,height:24},{width:1024,height:1024},16),{size:{width:48,height:16}});
});
