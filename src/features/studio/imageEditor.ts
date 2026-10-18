export function zoomAt(v:View,p:Point,wanted:number):View{
 const scale=Math.max(.05,Math.min(16,wanted)),ratio=scale/v.scale;
 return {scale,x:p.x-(p.x-v.x)*ratio,y:p.y-(p.y-v.y)*ratio};
}
export function stampStroke(ctx:CanvasRenderingContext2D,a:Point,b:Point,diameter:number,shape:BrushShape,erase:boolean){
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
 try{ctx.globalCompositeOperation=erase?'destination-out':'source-over';ctx.fillStyle='#fff';
  for(let i=0;i<=count;i++){
   const x=a.x+(b.x-a.x)*i/count,y=a.y+(b.y-a.y)*i/count;
   if(shape==='square')ctx.fillRect(x-diameter/2,y-diameter/2,diameter,diameter);
   else{ctx.beginPath();ctx.arc(x,y,diameter/2,0,Math.PI*2);ctx.fill();}
  }
 }finally{ctx.restore();}
}
export function visibleImages(layers:readonly ImageLayer[]){
 return layers.filter(l=>l.visible).map(({name,x,y,width,height})=>({image:name,x,y,width,height}));
}
export type Point={x:number;y:number};
export type View={scale:number;x:number;y:number};
export type ImageLayer={id:string;name:string;src:string;x:number;y:number;width:number;height:number;visible:boolean};
export type BrushShape='round'|'square';
export function sourcePoint(clientX:number,clientY:number,r:{left:number;top:number;width:number;height:number},width:number,height:number):Point{
 return {x:(clientX-r.left)*width/r.width,y:(clientY-r.top)*height/r.height};
}
