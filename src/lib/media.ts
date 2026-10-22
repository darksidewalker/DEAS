import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { JobStatus } from './jobs';
export type MediaKind = 'image'|'video'|'audio';
export interface MediaEntry {name:string;path:string;kind:'directory'|'file';symlink:boolean;media:MediaKind|null;size:number;modified:number}
export interface MediaListing {path:string;parent:string|null;entries:MediaEntry[];truncated:boolean}
/** What a tab can show: a browsable URL plus its kind. Browser drops use revocable blob URLs. */
export interface MediaItem {name:string;src:string;media:MediaKind;path?:string}
export interface MediaRelocation {oldPath:string;path:string;starred?:boolean}
/** Fired only after native move/reference repair succeeds; hosts repair their retained selections/jobs. */
export async function starMedia(path:string,unstar=false):Promise<MediaRelocation> {
 const result=await invoke<MediaRelocation>(unstar?'native_media_unstar':'native_media_star',{path});
 if(!result||result.oldPath!==path||typeof result.path!=='string')throw new Error('Invalid native media relocation');
 window.dispatchEvent(new CustomEvent<MediaRelocation>('deas-media-relocated',{detail:{...result,starred:!unstar}}));
 return result;
}
export function relocatedMediaItem(item:MediaItem,move:MediaRelocation):MediaItem {
 return item.path===move.oldPath?{...item,path:move.path,name:move.path.split(/[\\/]/).at(-1)??item.name,src:isTauri()?convertFileSrc(move.path):move.path}:item;
}
/** Repair location handles only; submitted intent/provenance stays immutable. */
export function relocatedJob(job:JobStatus,root:string,move:MediaRelocation):JobStatus {
 const normalized=(path:string)=>path.replace(/\\/g,'/').replace(/\/+$/,'');
 const relative=normalized(move.path).slice(normalized(root).length+1);
 if(!normalized(move.path).startsWith(normalized(root)+'/'))return job;
 const outputs=job.outputs.map(output=>normalized([root,output.subfolder,output.filename].filter(Boolean).join('/'))===normalized(move.oldPath)?{...output,filename:relative.split('/').at(-1)!,subfolder:relative.split('/').slice(0,-1).join('/')}:output);
 return outputs.some((output,index)=>output!==job.outputs[index])?{...job,outputs}:job;
}
/** `depth` 1 = this folder only; deeper levels add files from subfolders with relative names. */
export async function listMedia(path:string,depth=1):Promise<MediaListing> {
 const listing=await invoke<MediaListing>('native_media_list',{path,depth});
 if(typeof listing?.path!=='string'||!Array.isArray(listing.entries))throw new Error('Invalid native media listing');
 return listing;
}
export const describeMedia=(paths:string[])=>invoke<MediaEntry[]>('native_media_describe',{paths});
export function itemFromEntry(entry:MediaEntry):MediaItem|null {
 if(entry.kind!=='file'||!entry.media)return null;
 return {name:entry.name,path:entry.path,media:entry.media,src:isTauri()?convertFileSrc(entry.path):entry.path};
}
/** In-app drag of a dock tile (HTML5 DnD); external file drops carry no such entry. */
export const MEDIA_DRAG='application/x-deas-media';
export const dragItem=(dt:DataTransfer,item:MediaItem)=>dt.setData(MEDIA_DRAG,JSON.stringify(item));
export function draggedItem(dt:DataTransfer):MediaItem|null {
 try{const v=JSON.parse(dt.getData(MEDIA_DRAG)||'null');return v&&typeof v.src==='string'&&typeof v.name==='string'&&['image','video','audio'].includes(v.media)?v:null;}catch{return null;}
}
export function itemFromFile(file:File):MediaItem|null {
 const media=file.type.split('/')[0];
 if(media!=='image'&&media!=='video'&&media!=='audio')return null;
 return {name:file.name,media,src:URL.createObjectURL(file)};
}
