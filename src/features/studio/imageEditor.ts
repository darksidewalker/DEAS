export function zoomAt(v:View,p:Point,wanted:number):View{
 const scale=Math.max(.05,Math.min(16,wanted)),ratio=scale/v.scale;
 return {scale,x:p.x-(p.x-v.x)*ratio,y:p.y-(p.y-v.y)*ratio};
}
export function stampStroke(ctx:CanvasRenderingContext2D,a:Point,b:Point,diameter:number,shape:BrushShape,erase:boolean,color='#fff'){
 // Clip the segment, not each endpoint: outside drags must not loop over off-canvas miles.
 const dx=b.x-a.x,dy=b.y-a.y,r=diameter/2;
 if(![a.x,a.y,b.x,b.y,dx,dy,diameter].every(Number.isFinite)||diameter<2||diameter>1024)return;
 let lo=0,hi=1;
 for(const [p,q] of [[-dx,a.x+r],[dx,ctx.canvas.width+r-a.x],[-dy,a.y+r],[dy,ctx.canvas.height+r-a.y]]){
  if(p===0){if(q<0)return;continue;}
  const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
  if(lo>hi)return;
 }
 b={x:a.x+dx*hi,y:a.y+dy*hi};a={x:a.x+dx*lo,y:a.y+dy*lo};
 const count=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/Math.max(1,diameter/4)));
 ctx.save();
 try{ctx.globalCompositeOperation=erase?'destination-out':'source-over';ctx.fillStyle=color;
  for(let i=0;i<=count;i++){
   const x=a.x+(b.x-a.x)*i/count,y=a.y+(b.y-a.y)*i/count;
   if(shape==='square')ctx.fillRect(x-diameter/2,y-diameter/2,diameter,diameter);
   else{ctx.beginPath();ctx.arc(x,y,diameter/2,0,Math.PI*2);ctx.fill();}
  }
 }finally{ctx.restore();}
}
/** Bounding box of the black-backed exported mask, including finite blur support and context. */
export function maskBounds(data:Uint8ClampedArray,width:number,height:number,padding:number){
 let left=width,top=height,right=-1,bottom=-1;
 for(let i=0;i<data.length;i+=4)if(data[i]){const p=i/4,x=p%width,y=Math.floor(p/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
 if(right<0)return null;
 left=Math.max(0,left-padding);top=Math.max(0,top-padding);right=Math.min(width,right+1+padding);bottom=Math.min(height,bottom+1+padding);
 return {x:left,y:top,width:right-left,height:bottom-top};
}
export function visibleImages(layers:readonly ImageLayer[]){
 return layers.filter(l=>l.visible).map(({name,x,y,width,height})=>({image:name,x,y,width,height}));
}
export type Point={x:number;y:number};
export type View={scale:number;x:number;y:number};
/** `paint` holds brush strokes at the picture's own pixel size; the run flattens them over the picture. */
export type ImageLayer={id:string;name:string;src:string;x:number;y:number;width:number;height:number;visible:boolean;paint?:HTMLCanvasElement};
export const hasPaint=(c?:HTMLCanvasElement)=>{const d=c?.getContext('2d')?.getImageData(0,0,c.width,c.height).data;if(!d)return false;for(let i=3;i<d.length;i+=4)if(d[i])return true;return false;};
/** PNG of the layer picture with its strokes on top, or null when nothing was painted. */
export async function flattenLayer(l:ImageLayer):Promise<Uint8Array|null>{
 if(!l.paint||!hasPaint(l.paint))return null;
 const img=new Image();img.src=l.src;await img.decode();
 const c=document.createElement('canvas');c.width=l.paint.width;c.height=l.paint.height;
 const ctx=c.getContext('2d');if(!ctx)throw new Error('canvas');
 ctx.drawImage(img,0,0,c.width,c.height);ctx.drawImage(l.paint,0,0);
 const blob=await new Promise<Blob|null>(done=>c.toBlob(done,'image/png'));if(!blob)throw new Error('canvas');
 return new Uint8Array(await blob.arrayBuffer());
}
export type BrushShape='round'|'square';
export function sourcePoint(clientX:number,clientY:number,r:{left:number;top:number;width:number;height:number},width:number,height:number):Point{
 return {x:(clientX-r.left)*width/r.width,y:(clientY-r.top)*height/r.height};
}
