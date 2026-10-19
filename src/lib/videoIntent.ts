import type { RunOptions } from './execution';
/** Video recipe intent (native compiler `jobs_video.rs`), one per model family; the TS side only types it and derives frame counts. */
export type VideoFamily='ltx-2'|'wan'|'minimax-h3';
export const videoCodecs=['Auto','AV1','VP9','H.265 (HEVC)','H.264'] as const;
export const videoContainers=['Auto','WebM','MKV','MP4','Animated WebP','Animated AVIF'] as const;
export const bitDepths=['Auto','8-bit','10-bit'] as const;
export const audioCodecs=['Auto','AAC','Opus','MP3'] as const;
export const audioBitrates=['64k','96k','128k','160k','192k','256k','320k'] as const;
/** DaSiWa Enhanced Video Combine settings plus the image saver's format; chosen in the Options tab. */
export interface VideoOutput { codec:typeof videoCodecs[number]; container:typeof videoContainers[number]; bitDepth:typeof bitDepths[number]; quality:number; audioCodec:typeof audioCodecs[number]; audioBitrate:typeof audioBitrates[number]; saveFirstFrame:boolean; saveLastFrame:boolean; imageFormat:'png'|'webp'; imageCompression:number }
export const defaultVideoOutput:VideoOutput={codec:'Auto',container:'Auto',bitDepth:'Auto',quality:20,audioCodec:'Auto',audioBitrate:'192k',saveFirstFrame:false,saveLastFrame:false,imageFormat:'png',imageCompression:44};
const inList=(list:readonly string[],v:unknown)=>typeof v==='string'&&list.includes(v);
export const isVideoOutput=(v:unknown):v is VideoOutput=>{
 const o=v as VideoOutput;
 return !!o&&typeof o==='object'&&inList(videoCodecs,o.codec)&&inList(videoContainers,o.container)&&inList(bitDepths,o.bitDepth)&&Number.isInteger(o.quality)&&o.quality>=0&&o.quality<=51
  &&inList(audioCodecs,o.audioCodec)&&inList(audioBitrates,o.audioBitrate)&&typeof o.saveFirstFrame==='boolean'&&typeof o.saveLastFrame==='boolean'&&inList(['png','webp'],o.imageFormat)&&Number.isInteger(o.imageCompression)&&o.imageCompression>=0&&o.imageCompression<=100;
};
/** A DaSiWa Director REF2VA timeline item; `file` is an uploaded input name. */
export interface H3Media { type:'image'|'video'|'audio'; file:string; slot:number; mediaMode?:'video'|'audio'|'video_audio'; trimStart?:number; trimEnd?:number }
export interface H3Continuity { session:string; sourceId:string; capture:boolean; action:string; outputMode:'full'|'segment' }
interface VideoBase { readonly recipeId:'video-generation'; readonly version:1; readonly positivePrompt:string; readonly negativePrompt:string; readonly model:string; readonly textEncoder:string; readonly vae:string; readonly seed:number; readonly width:number; readonly height:number; readonly frames:number; readonly frameRate:number; readonly steps:number; readonly cfg:number; readonly sampler:string; readonly scheduler:string; readonly outputPrefix:string; readonly output:Omit<VideoOutput,'imageFormat'|'imageCompression'>; readonly firstFrame?:string; readonly lastFrame?:string; readonly sourceVideo?:string; readonly loras?:readonly {name:string;strength:number}[]; readonly options?:RunOptions; readonly chunks?:number }
export type VideoIntentV1=VideoBase&(
 |{readonly family:'ltx-2';readonly ltx:{textProjection:string;audioVae:string;passes:1|2|3;spatialUpscaler?:string;keyframes?:{image:string;frame:number;strength:number}[];sourceStrength?:number}}
 |{readonly family:'wan';readonly wan:{lowModel:string;shiftHigh:number;shiftLow:number;refinerStep:number}}
 |{readonly family:'minimax-h3';readonly h3:{mode:'T2VA'|'I2VA'|'L2VA'|'FL2VA'|'REF2VA';audioVae:string;shiftVideo:number;shiftAudio:number;references:{slot:0|1;image:string}[];media?:H3Media[];continuity?:H3Continuity}});
export const isVideoIntent=(i:{recipeId:string}):i is VideoIntentV1=>i.recipeId==='video-generation';
/** Frame counts as the owner's workflows compute them: LTX/Wan `round(s·fps/8)·8+1`, MiniMax H3 `17k+5` at 24 fps (snapped up). */
export function videoFrames(family:VideoFamily,seconds:number,fps:number):number{
 if(family==='minimax-h3'){const n=Math.max(5,Math.round(seconds*24));return n+(((5-(n%17))%17)+17)%17;}
 return Math.max(family==='wan'?5:9,Math.round(seconds*fps/8)*8+1);
}
/** Feed-forward chunk count from the OmniForge/FastFidelity formula; `headroom` 1 ≈ 24 GB … 4 ≈ 8 GB. Undefined = no chunking. */
export function chunkCount(frames:number,width:number,height:number,headroom:number):number|undefined{
 const n=Math.round(((frames*width*height)/120_000_000)**1.3*0.5*headroom);
 return n>1?Math.min(16,n):undefined;
}
