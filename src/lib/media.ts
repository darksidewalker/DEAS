import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
export type MediaKind = 'image'|'video'|'audio';
export interface MediaEntry {name:string;path:string;kind:'directory'|'file';symlink:boolean;media:MediaKind|null;size:number;modified:number}
export interface MediaListing {path:string;parent:string|null;entries:MediaEntry[];truncated:boolean}
/** What a tab can show: a browsable URL plus its kind. Browser drops use revocable blob URLs. */
export interface MediaItem {name:string;src:string;media:MediaKind;path?:string}
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
export function itemFromFile(file:File):MediaItem|null {
 const media=file.type.split('/')[0];
 if(media!=='image'&&media!=='video'&&media!=='audio')return null;
 return {name:file.name,media,src:URL.createObjectURL(file)};
}
