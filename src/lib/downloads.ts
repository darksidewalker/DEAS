import { invoke, isTauri } from '@tauri-apps/api/core';

export type DownloadScope = 'user' | 'repo' | 'model' | 'search' | 'index' | 'backend';
export interface DownloadProvider { id:string; kind:string; label:string; origin:string; scopes:DownloadScope[]; anonymousNotice:string }
export interface CatalogEntry { id:string; label:string; providerId:string; scope:DownloadScope; locator:string; kind:string; target:string; license?:string; sha256?:string; preview?:string; media?:'image'|'video'; auth?:boolean; nsfw?:boolean; base?:string }
export interface DownloadCatalog { version:1; providers:DownloadProvider[]; entries:CatalogEntry[] }
export interface DownloadResource { id:string; label:string; kind:string; url?:string; size?:number; sha256?:string; downloadable:boolean; locator?:string; license?:string; preview?:string; category?:string; auth?:boolean; nsfw?:boolean; base?:string }
export interface BrowseRequest { providerId:string; scope:DownloadScope; locator:string; cursor?:string; authenticated:boolean; nsfw?:boolean }
export interface DownloadListing { resources:DownloadResource[]; nextCursor:string|null; warnings:string[] }
export interface PlanRequest { providerId:string; resources:DownloadResource[]; parentPath:string; folderName:string; authenticated:boolean }
export interface DownloadPlan { id:string; target:string; resources:DownloadResource[]; totalKnownBytes:number; unknownSizeCount:number; warnings:string[]; canExecute:boolean }
export interface DownloadStatus { state:'idle'|'running'|'succeeded'|'failed'|'cancelled'; completed:number; total:number; bytesDownloaded:number; error:string|null }
export interface AuthMetadata { providerId:string; configured:boolean; persisted:boolean }
/** Transport is native-only. Catalog validation and credential origin binding belong to native code. */
function native<T>(command:string,args?:Record<string,unknown>):Promise<T> {
 if(!isTauri())return Promise.reject(new Error('Native transport unavailable'));
 return args===undefined?invoke<T>(command):invoke<T>(command,args);
}
export const readDownloadCatalog=()=>native<DownloadCatalog>('native_download_catalog');
export const importDownloadCatalog=(text:string)=>native<DownloadCatalog>('native_download_import_catalog',{text});
export const browseDownloads=(request:BrowseRequest)=>native<DownloadListing>('native_download_browse',{request});
export const pickDownloadParent=(title:string)=>native<string|null>('native_pick_directory',{title});
export const planDownloads=(request:PlanRequest)=>native<DownloadPlan>('native_download_plan',{request});
export const startDownloads=(planId:string)=>native<DownloadStatus>('native_download_start',{planId,confirmed:true});
export const readDownloadStatus=()=>native<DownloadStatus>('native_download_status');
export const cancelDownloads=()=>native<DownloadStatus>('native_download_cancel');
export const readAuthStatus=()=>native<AuthMetadata[]>('native_auth_status');
export const setAuthToken=(providerId:string,token:string,persist=false)=>native<AuthMetadata>('native_auth_set',{providerId,token,persist});
export const restoreAuthToken=(providerId:string)=>native<AuthMetadata>('native_auth_restore',{providerId});
export const removeAuthToken=(providerId:string)=>native<AuthMetadata>('native_auth_remove',{providerId});
/** Where a ComfyUI category lives inside a managed DEAS environment. */
export const comfyFolder=(installTarget:string,category:string)=>`${installTarget}/ComfyUI/${category==='workflows'?'user/default/workflows':`models/${category}`}`;
export const openTokenPage=(providerId:string)=>invoke<void>('native_open_token_page',{providerId});
