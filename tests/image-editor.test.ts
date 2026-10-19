import assert from 'node:assert/strict';
import test from 'node:test';
import {sourcePoint,zoomAt,stampStroke,visibleImages,maskBounds} from '../src/features/studio/imageEditor.ts';
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
