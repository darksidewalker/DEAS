import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { JobStatus } from './jobs';
export type MediaKind = 'image'|'video'|'audio';
export interface MediaEntry {name:string;path:string;kind:'directory'|'file';symlink:boolean;media:MediaKind|null;size:number;modified:number}
export interface MediaListing {path:string;parent:string|null;entries:MediaEntry[];truncated:boolean}
/** What a tab can show: a browsable URL plus its kind. Browser drops use revocable blob URLs. */
export interface MediaItem {name:string;src:string;media:MediaKind;path?:string}
export interface MediaDeletion {deleted:string[];failed:string[];errors?:string[];deletedVideoSourceIds?:string[]}
/** Explicit confirmation is owned by the caller. Native code authorizes every path. */
export async function deleteMedia(paths:string[]):Promise<MediaDeletion> {
 // Windows keeps a played file's name blocked (even after a successful native delete)
 // while a live <video>/<audio> still holds its stream; release matching previews first.
 const urls=paths.map(p=>convertFileSrc(p));
 for(const el of document.querySelectorAll<HTMLMediaElement>('video,audio')){
  const src=el.getAttribute('src');
  if(src&&urls.some(url=>src===url||src.startsWith(`${url}?`))){el.pause();el.removeAttribute('src');el.load();}
 }
 const report=await invoke<MediaDeletion>('native_media_delete',{paths});
 if(!report||!Array.isArray(report.deleted)||!Array.isArray(report.failed)||
  (report.deletedVideoSourceIds!==undefined&&(!Array.isArray(report.deletedVideoSourceIds)||report.deletedVideoSourceIds.length>report.deleted.length||report.deletedVideoSourceIds.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))))||
  (report.errors!==undefined&&(!Array.isArray(report.errors)||report.errors.length>report.failed.length||report.errors.some(error=>typeof error!=='string'||error.length>131072)))||
  [...report.deleted,...report.failed].length!==paths.length||
  new Set([...report.deleted,...report.failed]).size!==paths.length||
  [...report.deleted,...report.failed].some(path=>typeof path!=='string'||!paths.includes(path)))throw new Error('Invalid native media deletion response');
 if(report.deleted.length)window.dispatchEvent(new CustomEvent<MediaDeletion>('deas-media-deleted',{detail:report}));
 return report;
}
export interface MediaRelocation {oldPath:string;path:string;starred?:boolean}
/** Fired only after native move/reference repair succeeds; hosts repair their retained selections/jobs. */
export async function starMedia(path:string,unstar=false):Promise<MediaRelocation> {
 const result=await invoke<MediaRelocation>(unstar?'native_media_unstar':'native_media_star',{path});
 if(!result||result.oldPath!==path||typeof result.path!=='string')throw new Error('Invalid native media relocation');
 window.dispatchEvent(new CustomEvent<MediaRelocation>('deas-media-relocated',{detail:{...result,starred:!unstar}}));
 return result;
}
export interface CleanExport {path:string;size:number}
/** Native Save As strips metadata; replacing an existing file (including the source) needs separate confirmation. Null means cancelled. */
export const exportWithoutMetadata=(path:string,title:string,replace?:{title:string;message:string})=>invoke<CleanExport|null>('native_media_export_clean',{path,title,...(replace?{replaceTitle:replace.title,replaceMessage:replace.message}:{})});
export function relocatedMediaItem(item:MediaItem,move:MediaRelocation):MediaItem {
 return item.path===move.oldPath?{...item,path:move.path,name:move.path.split(/[\\/]/).at(-1)??item.name,src:isTauri()?convertFileSrc(move.path):move.path}:item;
}
/** Lexical display/matching only; native code owns canonical identity and containment. */
export const normalizedMediaPath=(path:string)=>(/^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(path)?path.replace(/\\/g,'/'):path).replace(/\/+$/,'');
/** Convert a native location to a ComfyUI-relative name, never a sibling or traversal. */
export function relativeMediaPath(path:string,root:string):string {
 const prefix=normalizedMediaPath(root)+'/';const value=normalizedMediaPath(path);
 const relative=root&&value.startsWith(prefix)?value.slice(prefix.length):'';
 return relative&&!/[\\\x00-\x1f]/.test(relative)&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..')?relative:'';
}
/** Repair location handles only; submitted intent/provenance stays immutable. */
export function relocatedJob(job:JobStatus,root:string,move:MediaRelocation):JobStatus {
 const relative=relativeMediaPath(move.path,root);
 if(!relative)return job;
 const oldRelative=relativeMediaPath(move.oldPath,root);
 const outputs=job.outputs.map(output=>oldRelative&&relativeMediaPath(normalizedMediaPath(root)+'/'+[output.subfolder,output.filename].filter(Boolean).join('/'),root)===oldRelative?{...output,filename:relative.split('/').at(-1)!,subfolder:relative.split('/').slice(0,-1).join('/')}:output);
 return outputs.some((output,index)=>output!==job.outputs[index])?{...job,outputs}:job;
}
/** `depth` 1 = this folder only; deeper levels add files from subfolders with relative names. */
export async function listMedia(path:string,depth=1):Promise<MediaListing> {
 const listing=await invoke<MediaListing>('native_media_list',{path,depth});
 if(typeof listing?.path!=='string'||!Array.isArray(listing.entries))throw new Error('Invalid native media listing');
 return listing;
}
export const describeMedia=(paths:string[])=>invoke<MediaEntry[]>('native_media_describe',{paths});
/** Pasted pictures (clipboard content has no path) saved as new files in the owned Input folder; returns their paths. */
export async function pasteToInput(pictures:Blob[]):Promise<string[]> {
 const d=new Date(),p=(n:number)=>String(n).padStart(2,'0');
 const stamp=`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
 const paths:string[]=[];
 for(const picture of pictures)paths.push(await invoke<string>('native_media_paste',{bytes:Array.from(new Uint8Array(await picture.arrayBuffer())),stamp}));
 return paths;
}
/** A picture DEAS derived from another one (PNG bytes) is saved as a new file in Input; the native side never overwrites. */
export const saveDerived=async(picture:Blob,name:string)=>invoke<string>('native_media_save_derived',{bytes:Array.from(new Uint8Array(await picture.arrayBuffer())),name});
/** Picture files of a paste event; text fields keep their own paste. */
export const pastedPictures=(event:ClipboardEvent)=>event.target instanceof Element&&event.target.closest('input, textarea, [contenteditable="true"]')?[]:[...(event.clipboardData?.files??[])].filter(f=>f.type.startsWith('image/'));
/** Local paths of files copied in a file manager: `text/uri-list` (file:// URIs) or a plain-text list made only of absolute paths. Ordinary text yields []. */
export function pastedPaths(data:DataTransfer|null|undefined):string[] {
 if(!data)return [];
 const fromUri=(uri:string)=>{try{const u=new URL(uri);if(u.protocol!=='file:')return null;const p=decodeURIComponent(u.pathname);return u.host&&u.host!=='localhost'?`//${u.host}${p}`:/^\/[A-Za-z]:\//.test(p)?p.slice(1):p;}catch{return null;}};
 for(const type of ['text/uri-list','text/plain']){
  let raw='';try{raw=data.getData(type)??'';}catch{/* unavailable type */}
  const lines=raw.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  if(!lines.length)continue;
  const paths=lines.map(l=>/^file:/i.test(l)?fromUri(l):/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(l)&&!/[\x00-\x1f]/.test(l)?l:null);
  if(paths.every(Boolean))return paths as string[];
 }
 return [];
}
export function itemFromEntry(entry:MediaEntry):MediaItem|null {
 if(entry.kind!=='file'||!entry.media)return null;
 return {name:entry.name,path:entry.path,media:entry.media,src:isTauri()?convertFileSrc(entry.path):entry.path};
}
/** In-app drag of a dock tile (HTML5 DnD); external file drops carry no such entry. */
export const MEDIA_DRAG='application/x-deas-media';
// wry reports OS drop positions in physical pixels on Windows WebView2 but already-logical pixels on Linux WebKitGTK; scaling both by devicePixelRatio misses targets on Linux.
export const dropCssPoint=(p:{x:number;y:number})=>/Windows/i.test(navigator.userAgent)?{x:p.x/window.devicePixelRatio,y:p.y/window.devicePixelRatio}:p;
export const MEDIA_IMAGE_DRAG='application/x-deas-image';
export function dragItem(dt:DataTransfer,item:MediaItem){
 // Default image URIs are intercepted as native file drops by WebKitGTK/Wry.
 dt.clearData();
 dt.setData(MEDIA_DRAG,JSON.stringify(item));
 // Payloads are protected during dragover; the MIME marker keeps image eligibility readable.
 if(item.media==='image'&&item.path)dt.setData(MEDIA_IMAGE_DRAG,'1');
 dt.effectAllowed='copy';
}
export function draggedItem(dt:DataTransfer):MediaItem|null {
 try{const v=JSON.parse(dt.getData(MEDIA_DRAG)||'null');return v&&typeof v.src==='string'&&typeof v.name==='string'&&['image','video','audio'].includes(v.media)?v:null;}catch{return null;}
}
export function itemFromFile(file:File):MediaItem|null {
 const media=file.type.split('/')[0];
 if(media!=='image'&&media!=='video'&&media!=='audio')return null;
 return {name:file.name,media,src:URL.createObjectURL(file)};
}
