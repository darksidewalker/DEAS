import assert from 'node:assert/strict';
import test from 'node:test';
import {sourcePoint,zoomAt,stampStroke,visibleImages,maskBounds,floodRegion} from '../src/features/studio/imageEditor.ts';
test('magic wand selects only the connected area within tolerance and stops at edges',()=>{
 // 5×3: left block dark (10), a bright wall (200) at x=2, right block dark again (12); one near-dark pixel (40) at (1,1).
 const w=5,h=3,data=new Uint8ClampedArray(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const v=x===2?200:x>2?12:x===1&&y===1?40:10;data.set([v,v,v,255],(y*w+x)*4);}
 const pick=(t:number)=>[...floodRegion(data,w,h,0,0,t)].map((v,i)=>v?i:-1).filter(i=>i>=0);
 assert.deepEqual(pick(0),[0,1,5,10,11]); // (1,1)=40 is outside tolerance 0
 assert.deepEqual(pick(30),[0,1,5,6,10,11]); // now included; the bright wall still blocks the right block
 assert.equal(pick(255).length,15);
 assert.equal(floodRegion(data,w,h,-1,0,10).some(Boolean),false);
});
test('mask bounds include disconnected pixels, context and blur support, clipped at image edges',()=>{
 const data=new Uint8ClampedArray(10*8*4);
 const paint=(x:number,y:number)=>{data[(y*10+x)*4]=255;};
 assert.equal(maskBounds(data,10,8,0),null);
 paint(3,2);paint(5,4);
 assert.deepEqual(maskBounds(data,10,8,0),{x:3,y:2,width:3,height:3});
 assert.deepEqual(maskBounds(data,10,8,2),{x:1,y:0,width:7,height:7});
 assert.deepEqual(maskBounds(data,10,8,3),{x:0,y:0,width:9,height:8});
 paint(9,7);assert.deepEqual(maskBounds(data,10,8,1024),{x:0,y:0,width:10,height:8});
});
test('zoomAt keeps cursor anchored and clamps scale',()=>{
 assert.deepEqual(zoomAt({scale:.5,x:20,y:30},{x:120,y:80},1),{scale:1,x:-80,y:-20});
 assert.equal(zoomAt({scale:1,x:0,y:0},{x:0,y:0},99).scale,16);
 assert.equal(zoomAt({scale:1,x:0,y:0},{x:0,y:0},0).scale,.05);
});
test('square strokes fill the path and restore erasing state',()=>{
 const calls:unknown[][]=[];const ctx={canvas:{width:100,height:100},save(){calls.push(['save']);},restore(){calls.push(['restore']);},fillRect(...a:number[]){calls.push(a);},globalCompositeOperation:'source-over',fillStyle:''};
 stampStroke(ctx as unknown as CanvasRenderingContext2D,{x:10,y:10},{x:18,y:10},8,'square',true);
 assert.deepEqual(calls[1],[6,6,8,8]);assert.deepEqual(calls.at(-2),[14,6,8,8]);assert.deepEqual(calls.at(-1),['restore']);
});
test('strokes take a colour, white by default',()=>{
 const ctx={canvas:{width:100,height:100},save(){},restore(){},fillRect(){},globalCompositeOperation:'source-over',fillStyle:''};
 stampStroke(ctx as unknown as CanvasRenderingContext2D,{x:10,y:10},{x:10,y:10},8,'square',false);assert.equal(ctx.fillStyle,'#fff');
 stampStroke(ctx as unknown as CanvasRenderingContext2D,{x:10,y:10},{x:10,y:10},8,'square',false,'rgb(128,128,128)');assert.equal(ctx.fillStyle,'rgb(128,128,128)');
});
test('visibleImages omits hidden images and UI fields',()=>{
 assert.deepEqual(visibleImages([{id:'a',name:'cat.png',src:'x',x:4,y:8,width:32,height:16,visible:true},{id:'b',name:'dog.png',src:'y',x:0,y:0,width:8,height:8,visible:false}]),[{image:'cat.png',x:4,y:8,width:32,height:16}]);
});
test('strokes clip extreme outside pointer coordinates before iterating',()=>{
 let count=0;const ctx={canvas:{width:100,height:100},save(){},restore(){},fillRect(){if(++count>300)throw Error('unbounded stamps');},globalCompositeOperation:'source-over',fillStyle:''};
 stampStroke(ctx as unknown as CanvasRenderingContext2D,{x:-1e9,y:50},{x:1e9,y:50},8,'square',false);
 assert.ok(count>0&&count<=60);
 count=0;stampStroke(ctx as unknown as CanvasRenderingContext2D,{x:-1e9,y:-1e9},{x:-2e9,y:-2e9},8,'square',false);assert.equal(count,0);
});
test('sourcePoint uses the transformed image box',()=>{
 assert.deepEqual(sourcePoint(250,170,{left:50,top:70,width:400,height:200},800,400),{x:400,y:200});
});
