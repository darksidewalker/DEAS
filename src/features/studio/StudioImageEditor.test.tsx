import {createRef} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {I18nProvider} from '../../i18n/I18nProvider';
import {StudioImageEditor,type EditorHandle} from './StudioImageEditor';
// Behavioral canvas double: coverage is counted from rasterized stamps, not real PNG/browser pixels.
type MockContext={pixels:Set<number>;opaque:boolean;globalCompositeOperation:string;fillStyle:string;canvas:HTMLCanvasElement;save:()=>void;restore:()=>void;beginPath:()=>void;arc:(x:number,y:number,r:number)=>void;fill:()=>void;fillRect:(x:number,y:number,w:number,h:number)=>void;clearRect:()=>void;drawImage:(c:HTMLCanvasElement)=>void;getImageData:()=>{data:Uint8ClampedArray};putImageData:(d:{data:Uint8ClampedArray})=>void};
let contexts:WeakMap<HTMLCanvasElement,MockContext>;
let exports:number[];
function context(canvas:HTMLCanvasElement):MockContext{
 const existing=contexts.get(canvas);if(existing)return existing;
 let circle={x:0,y:0,r:0};const stack:string[]=[];
 const c:MockContext={canvas,pixels:new Set(),opaque:false,globalCompositeOperation:'source-over',fillStyle:'',
 save(){stack.push(c.globalCompositeOperation);},restore(){c.globalCompositeOperation=stack.pop()!;},beginPath(){},arc(x,y,r){circle={x,y,r};},
 fill(){const {x,y,r}=circle;raster(x-r,y-r,2*r,2*r,(px,py)=>(px-x)**2+(py-y)**2<=r*r);},
 fillRect(x,y,w,h){if(c.fillStyle==='#000'){c.opaque=true;c.pixels.clear();}else raster(x,y,w,h,()=>true);},
 clearRect(){c.pixels.clear();c.opaque=false;},
 drawImage(other){for(const n of context(other).pixels)c.pixels.add(n);},
 getImageData(){const data=new Uint8ClampedArray(canvas.width*canvas.height*4);if(c.opaque)for(let i=3;i<data.length;i+=4)data[i]=255;for(const n of c.pixels)data.set([255,255,255,255],n*4);return {data};},
 putImageData({data}){c.pixels.clear();for(let i=0;i<data.length;i+=4)if(data[i])c.pixels.add(i/4);c.opaque=true;}
 };
 function raster(x:number,y:number,w:number,h:number,inside:(x:number,y:number)=>boolean){
 for(let py=Math.max(0,Math.ceil(y));py<Math.min(canvas.height,y+h);py++)for(let px=Math.max(0,Math.ceil(x));px<Math.min(canvas.width,x+w);px++)if(inside(px+.5,py+.5)){const n=py*canvas.width+px;if(c.globalCompositeOperation==='destination-out')c.pixels.delete(n);else c.pixels.add(n);}}
 contexts.set(canvas,c);return c;
}
beforeEach(()=>{
 contexts=new WeakMap();exports=[];localStorage.clear();localStorage.setItem('deas.locale.v1','en');
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function(this:HTMLCanvasElement){return context(this) as unknown as CanvasRenderingContext2D;});
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(this:HTMLCanvasElement,done){
 const count=context(this).pixels.size;exports.push(count);
 queueMicrotask(()=>done({arrayBuffer:async()=>new Uint8Array([count%256]).buffer} as Blob));
 });
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return {left:0,top:0,x:0,y:0,width:this.dataset.testid==='editor-world'?1024:512,height:this.dataset.testid==='editor-world'?640:320,right:1024,bottom:640,toJSON(){}};});
 Object.defineProperty(HTMLElement.prototype,'setPointerCapture',{configurable:true,value:vi.fn()});
 Object.defineProperty(HTMLElement.prototype,'releasePointerCapture',{configurable:true,value:vi.fn()});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const source={src:'data:image/png;base64,AA==',name:'base.png',width:1024,height:640};
function mount(){
  const ref=createRef<EditorHandle>();const onLayers=vi.fn(),onMask=vi.fn();
  render(<I18nProvider><StudioImageEditor ref={ref} source={source} layers={[]} onLayers={onLayers} maskMode onMask={onMask} onInsert={vi.fn()}/></I18nProvider>);
  return {ref,onLayers,onMask};
}
test('brush diameter and shape controls reject invalid preference values',()=>{
  localStorage.setItem('deas.pref.studio.run.brush','-1');mount();
  expect((screen.getByRole('spinbutton',{name:'Brush diameter (px)'}) as HTMLInputElement).value).toBe('48');
  fireEvent.change(screen.getByRole('spinbutton',{name:'Brush diameter (px)'}),{target:{value:'80'}});
  expect((screen.getByRole('slider',{name:'Brush diameter (px)'}) as HTMLInputElement).value).toBe('80');
  fireEvent.click(screen.getByRole('button',{name:'Square'}));
  expect(screen.getByRole('button',{name:'Square',pressed:true})).toBeTruthy();
});

test('brush cursor follows the pointer at screen diameter and inpaint controls stay inpaint-only',()=>{
 const view=controlled();const vp=document.querySelector('[data-editor-viewport]')!;
 fireEvent.click(screen.getByRole('button',{name:'100%'}));pointer(vp,'pointermove',40,30);
 const ring=document.querySelector<HTMLElement>('.sie-cursor')!;
 expect(ring.hidden).toBe(false);expect([ring.style.left,ring.style.top,ring.style.width]).toEqual(['40px','30px','48px']);
 expect(vp.getAttribute('data-tool')).toBe('brush');
 fireEvent.click(screen.getByRole('button',{name:'Square'}));expect(document.querySelector('.sie-cursor.is-square')).toBeTruthy();
 view.rerender(view.ui([],false));
 expect(document.querySelector('.sie-cursor')).toBeNull();
 for(const name of ['Brush','Erase','Add mask','Clear','Square','Mask 1'])expect(screen.queryByRole('button',{name})).toBeNull();
 expect(screen.queryByRole('slider',{name:'Mask overlay (%)'})).toBeNull();
 expect(screen.getByRole('button',{name:'Select',pressed:true})).toBeTruthy();
});
test('independent mask rows can be added hidden deleted and capped',()=>{
 mount();
 for(let i=2;i<=4;i++)fireEvent.click(screen.getByRole('button',{name:'Add mask'}));
 expect(screen.getByRole('button',{name:'Add mask'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Hide Mask 4'}));
 expect(screen.getByRole('button',{name:'Show Mask 4'})).toBeTruthy();
 for(let i=4;i>=1;i--)fireEvent.click(screen.getByRole('button',{name:`Delete Mask ${i}`}));
 fireEvent.click(screen.getByRole('button',{name:'Add mask'}));
 expect(screen.getByRole('button',{name:'Mask 5',pressed:true})).toBeTruthy();
});
test('editor has fit, actual size and a selected mask thumbnail',()=>{
  mount();
  expect(screen.getByRole('button',{name:'Fit'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'100%'}));
  expect(screen.getByTestId('editor-world').style.transform).toContain('scale(1)');
  expect(screen.getByRole('button',{name:'Mask 1',pressed:true})).toBeTruthy();
});


const a={id:'a',name:'a.png',src:'data:image/png;base64,AA==',x:0,y:0,width:32,height:16,visible:true};
const b={...a,id:'b',name:'b.png'};
function controlled(){
 const onLayers=vi.fn(),onMask=vi.fn();
 const ui=(layers:typeof a[],maskMode=true)=><I18nProvider><StudioImageEditor source={source} layers={layers} onLayers={onLayers} maskMode={maskMode} onMask={onMask} onInsert={vi.fn()}/></I18nProvider>;
 const view=render(ui([]));return {...view,onLayers,onMask,ui};
}
test('insert selection and selected-only handles survive reorder and nonselected deletion',()=>{
 const view=controlled();view.rerender(view.ui([a]));view.rerender(view.ui([a,b]));
 expect(screen.getByRole('button',{name:'b.png',pressed:true})).toBeTruthy();
 expect(screen.getAllByRole('button',{name:/Resize/})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'a.png'}));
 view.rerender(view.ui([b,a]));view.rerender(view.ui([a]));
 expect(screen.getByRole('button',{name:'a.png',pressed:true})).toBeTruthy();
 const image=document.querySelector('.sie-image')!;
 fireEvent.keyDown(image,{key:'ArrowRight'});expect(view.onLayers.mock.lastCall![0][0].x).toBe(8);
 fireEvent.keyDown(image,{key:'+'});expect(view.onLayers.mock.lastCall![0][0].width).toBe(40);
 fireEvent.keyDown(image,{key:'Delete'});expect(view.onLayers).toHaveBeenLastCalledWith([]);
});
test('brush paints the selected picture in its own pixels with the chosen colour; mask strokes use the grey value',()=>{
 const view=controlled();view.rerender(view.ui([{...a,x:100,y:50,width:200,height:100}],false));
 fireEvent.click(screen.getByRole('button',{name:'a.png'}));fireEvent.click(screen.getByRole('button',{name:'Brush'}));
 fireEvent.click(screen.getByRole('button',{name:'#007aff'}));
 const vp=document.querySelector('[data-editor-viewport]')!;
 pointer(vp,'pointerdown',200,100);pointer(vp,'pointerup',200,100); // the mocked world is 1:1, so source (200,100) = layer-local (100,50)
 const paint=view.onLayers.mock.lastCall![0][0].paint as HTMLCanvasElement;
 expect([paint.width,paint.height]).toEqual([200,100]);
 const ctx=context(paint);expect(ctx.fillStyle).toBe('#007aff');expect(ctx.pixels.has(50*200+100)).toBe(true);
 fireEvent.change(screen.getByRole('textbox',{name:'Hex'}),{target:{value:'#00FF00'}});
 expect((document.querySelector('input[type=color]') as HTMLInputElement).value).toBe('#00ff00');
 view.rerender(view.ui([a],true));fireEvent.click(screen.getByRole('button',{name:'Mask 1'}));
 fireEvent.change(screen.getByRole('slider',{name:'Mask value (black–white)'}),{target:{value:'128'}});
 pointer(vp,'pointerdown',10,10);pointer(vp,'pointerup',10,10);
 expect(view.onMask).toHaveBeenLastCalledWith(true);
});
test('pointer capture moves and resizes images in source coordinates, cancel stops motion',()=>{
 const view=controlled();view.rerender(view.ui([a]));
 const image=document.querySelector('.sie-image')!,vp=document.querySelector('[data-editor-viewport]')!;
 pointer(image,'pointerdown',10,10);pointer(vp,'pointermove',30,20);
 expect(view.onLayers.mock.lastCall![0][0]).toMatchObject({x:20,y:10});
 expect(vp.setPointerCapture).toHaveBeenCalledWith(1);
 pointer(vp,'pointercancel');view.onLayers.mockClear();pointer(vp,'pointermove',50,30);expect(view.onLayers).not.toHaveBeenCalled();
 pointer(screen.getByRole('button',{name:'Resize a.png'}),'pointerdown',32,16);pointer(vp,'pointermove',48,24);
 expect(view.onLayers.mock.lastCall![0][0]).toMatchObject({width:48,height:24});
 pointer(vp,'lostpointercapture');view.onLayers.mockClear();pointer(vp,'pointermove',70,30);expect(view.onLayers).not.toHaveBeenCalled();
});

test('deleting a nonselected row keeps the selected image',()=>{
 const view=controlled();view.rerender(view.ui([a,b]));fireEvent.click(screen.getByRole('button',{name:'a.png'}));
 fireEvent.click(screen.getByRole('button',{name:'Delete b.png'}));view.rerender(view.ui([a]));
 expect(screen.getByRole('button',{name:'a.png',pressed:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Delete Mask 1'}));
 expect(screen.getByRole('button',{name:'a.png',pressed:true})).toBeTruthy();
});
test('hidden viewport resize notifications preserve the chosen pan and zoom',()=>{
 let resized=()=>{};vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){}});
 try{
 mount();const world=screen.getByTestId('editor-world'),vp=document.querySelector('[data-editor-viewport]')!;
 fireEvent.click(screen.getByRole('button',{name:'100%'}));
 pointer(vp,'pointerdown',20,20,1);pointer(vp,'pointermove',90,60,1);pointer(vp,'pointerup',90,60,1);
 const transform=world.style.transform;
 fireEvent(vp,new WheelEvent('wheel',{bubbles:true,clientX:50,clientY:50,deltaY:0}));
 // Callback also fires when a mounted-hidden editor becomes visible again.
 fireEvent.click(screen.getByRole('button',{name:'Select'}));act(()=>resized());
 expect(world.style.transform).toBe(transform);
 }finally{vi.unstubAllGlobals();}
});
test('clear reports an unavailable mask context without silently discarding its content',async()=>{
 const {ref,onMask}=mount();const vp=document.querySelector('[data-editor-viewport]')!;paint(vp);
 const unavailable=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
 fireEvent.click(screen.getByRole('button',{name:'Clear'}));
 expect(screen.getByRole('alert').textContent).toContain('mask canvas is unavailable');
 expect(onMask).toHaveBeenLastCalledWith(false);
 unavailable.mockImplementation(function(this:HTMLCanvasElement){return context(this) as unknown as CanvasRenderingContext2D;});
 await expect(ref.current!.maskPng()).resolves.toBeInstanceOf(Uint8Array);
});

test('mask coverage survives edit-mode changes and only visible independent masks export',async()=>{
 const ref=createRef<EditorHandle>(),onMask=vi.fn(),onLayers=vi.fn();
 const ui=(maskMode:boolean)=><I18nProvider><StudioImageEditor ref={ref} source={source} layers={[]} onLayers={onLayers} maskMode={maskMode} onMask={onMask} onInsert={vi.fn()}/></I18nProvider>;
 const view=render(ui(true)),vp=document.querySelector('[data-editor-viewport]')!;
 fireEvent.change(screen.getByRole('spinbutton',{name:'Brush diameter (px)'}),{target:{value:'8'}});
 fireEvent.click(screen.getByRole('button',{name:'Square'}));
 paint(vp);fireEvent.click(screen.getByRole('button',{name:'Add mask'}));paint(vp,60,60);
 fireEvent.click(screen.getByRole('button',{name:'Mask 1'}));fireEvent.click(screen.getByRole('button',{name:'Erase'}));paint(vp);
 expect(onMask).toHaveBeenLastCalledWith(true);
 fireEvent.click(screen.getByRole('button',{name:'Hide Mask 2'}));expect(onMask).toHaveBeenLastCalledWith(false);
 fireEvent.click(screen.getByRole('button',{name:'Show Mask 2'}));expect(onMask).toHaveBeenLastCalledWith(true);
 view.rerender(ui(false));view.rerender(ui(true));
 expect(screen.getByRole('button',{name:'Brush',pressed:true})).toBeTruthy();
 fireEvent.change(screen.getByRole('slider',{name:'Mask overlay (%)'}),{target:{value:'73'}});
 expect(screen.getByText('75%')).toBeTruthy(); // snaps to the 75 % stop
 fireEvent.change(screen.getByRole('slider',{name:'Mask overlay (%)'}),{target:{value:'40'}});
 expect(screen.getByText('40%')).toBeTruthy(); // between stops stays free
 fireEvent.change(screen.getByRole('slider',{name:'Mask overlay (%)'}),{target:{value:'0'}});
 await ref.current!.maskPng();expect(exports).toEqual([64]);
 fireEvent.click(screen.getByRole('button',{name:'Mask 2'}));fireEvent.click(screen.getByRole('button',{name:'Clear'}));
 expect(onMask).toHaveBeenLastCalledWith(false);
});
test('wheel zoom anchors at the cursor and paint cancellation stops further stamps',()=>{
 mount();const vp=document.querySelector('[data-editor-viewport]')!,world=screen.getByTestId('editor-world');
 fireEvent.click(screen.getByRole('button',{name:'100%'}));
 fireEvent(vp,new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:100,clientY:80,deltaY:-Math.log(2)*1000}));
 expect(world.style.transform).toBe('translate(-100px, -80px) scale(2)');
 pointer(vp,'pointerdown');pointer(vp,'pointercancel');
 const overlay=document.querySelector('.sie-mask') as HTMLCanvasElement,count=context(overlay).pixels.size;
 pointer(vp,'pointermove',500,400);expect(context(overlay).pixels.size).toBe(count);
});

function pointer(el:Element,type:string,x=20,y=20,button=0){const e=new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button});Object.defineProperty(e,'pointerId',{value:1});fireEvent(el,e);}
function paint(el:Element,x=20,y=20){pointer(el,'pointerdown',x,y);pointer(el,'pointerup',x,y);}
test('painting counts actual mock coverage, exports synchronously and erases to empty',async()=>{
 const {ref,onMask}=mount();const vp=document.querySelector('[data-editor-viewport]')!;
 fireEvent.change(screen.getByRole('spinbutton',{name:'Brush diameter (px)'}),{target:{value:'8'}});
 fireEvent.click(screen.getByRole('button',{name:'Square'}));
 paint(vp);expect(onMask).toHaveBeenLastCalledWith(true);
 const snapshot=ref.current!.maskPng();
 expect(exports).toEqual([64]);
 fireEvent.click(screen.getByRole('button',{name:'Clear'}));
 expect(onMask).toHaveBeenLastCalledWith(false);
 expect(await snapshot).toEqual(new Uint8Array([64]));
 await expect(ref.current!.maskPng()).rejects.toThrow('Paint a visible mask');
 paint(vp);fireEvent.click(screen.getByRole('button',{name:'Erase'}));paint(vp);
 expect(onMask).toHaveBeenLastCalledWith(false);
});

test('Ctrl+wheel resizes the brush while painting; a plain wheel still zooms',()=>{
 render(<I18nProvider><StudioImageEditor source={source} layers={[]} onLayers={()=>{}} maskMode onMask={()=>{}} onInsert={()=>{}}/></I18nProvider>);
 const diameter=()=>(screen.getByRole('spinbutton',{name:'Brush diameter (px)'}) as HTMLInputElement).value;
 const viewport=document.querySelector('[data-editor-viewport]')!;
 act(()=>{viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,ctrlKey:true,cancelable:true}));});
 expect(diameter()).toBe('53'); // 48·e^0.1
 act(()=>{viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:100,cancelable:true}));});
 expect(diameter()).toBe('53');
 expect(screen.getByText('50%')).toBeTruthy(); // overlay opacity shows its value
 fireEvent.click(screen.getByRole('button',{name:'Magic wand'}));
 expect(screen.getByRole('slider',{name:'Tolerance'})).toBeTruthy();
 act(()=>{viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,ctrlKey:true,cancelable:true}));});
 expect(diameter()).toBe('53'); // no brush active: Ctrl+wheel does not resize
});
