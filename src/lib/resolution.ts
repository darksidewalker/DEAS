export const aspects=['auto','1:1','16:9','9:16','2:1','1:2','3:2','2:3','4:3','3:4','4:5','5:4','5:3','3:5','7:4','4:7','21:9','9:21','32:9','9:32','custom'] as const;
export const resolutions:Record<string,number>={
 '144p':.0352,'240p':.0977,'360p':.22,'480p':.391,'540p':.494,'576p':.5625,'720p':.879,'900p':1.373,'1024p':1,'1080p':1.978,'1152p':2.25,'1440p':3.516,'2160p':7.91,'2K':3.906,'4K':7.91,
 ...Object.fromEntries([.26,.36,.52,.65,.83,1,1.05,1.2,1.35,1.55,1.65,1.75,2.1,3.3,4.75,6.5,8.3].map(n=>[`${n.toFixed(2)} MP`,n])),
};
export const scalingModes=['off','auto','target','fit','crop','pad'] as const;
export type ScalingMode=typeof scalingModes[number];
export type Size={width:number;height:number};
export type InputResize=Size&{crop:'disabled'|'center';pad?:{left:number;right:number;top:number;bottom:number}};
const snap=(n:number,grid:number)=>Math.max(grid,Math.round(n/grid)*grid);
export function canvasSize(aspect:string,resolution:string,customAspect:Size,mp:number,fixed:Size,model:Size,source?:Size,grid=16):Size{
 if(resolution==='fixed')return fixed;
 const ratio=aspect==='auto'?(source??model):aspect==='custom'?customAspect:(()=>{const [width,height]=aspect.split(':').map(Number);return {width,height};})();
 const r=ratio.width/ratio.height;
 if(!Number.isFinite(r)||r<=0)return {width:0,height:0};
 const pixels=resolution==='model'?model.width*model.height:(resolution==='custom'?mp:resolutions[resolution])*1024*1024;
 if(!Number.isFinite(pixels)||pixels<=0)return {width:0,height:0};
 const height=Math.sqrt(pixels/r);return {width:snap(height*r,grid),height:snap(height,grid)};
}
export const validCanvas=({width,height}:Size)=>[width,height].every(n=>Number.isInteger(n)&&n>=64&&n<=8192&&n%8===0)&&width*height<=16_777_216;
/** Fit can produce a smaller canvas; crop/pad fill it. Auto only downsizes inputs over the 2048px short-edge cap. Sizes snap down to the model grid. */
export function scaleInput(mode:ScalingMode,source:Size,target:Size,grid=16):{size:Size;resize?:InputResize}{
 const down=(n:number)=>Math.max(grid,Math.floor(n/grid)*grid);
 if(mode==='off')return {size:{width:down(source.width),height:down(source.height)}};
 let width=target.width,height=target.height;
 if(mode==='auto'){
  const scale=Math.min(1,2048/Math.min(source.width,source.height));
  if(scale===1)return scaleInput('off',source,target,grid);
  width=Math.max(64,down(source.width*scale));height=Math.max(64,down(source.height*scale));
 }else if(mode==='fit'||mode==='pad'){
  const scale=Math.min(width/source.width,height/source.height);
  width=Math.min(target.width,down(source.width*scale));height=Math.min(target.height,down(source.height*scale));
 }
 const resize:InputResize={width,height,crop:mode==='crop'?'center':'disabled'};
 if(mode==='pad'){
  const dx=target.width-width,dy=target.height-height;
  const left=Math.floor(dx/16)*8,top=Math.floor(dy/16)*8;
  resize.pad={left,right:dx-left,top,bottom:dy-top};return {size:target,resize};
 }
 return {size:{width,height},resize};
}
