import { invoke } from '@tauri-apps/api/core';
export interface Folders { models?:string; input?:string; output?:string; extraModels?:string[] }
export const readFolders=(root:string)=>invoke<Folders>('native_settings_read',{root});
/** An empty `extraModels` list is the schema default; omit it so saved payloads stay byte-identical to the pre-extras shape. */
const payload=(folders:Folders)=>{const {extraModels,...rest}=folders;const extra=extraModels?.filter(Boolean);return extra&&extra.length?{...rest,extraModels:extra}:rest;};
export const writeFolders=(root:string,folders:Folders)=>invoke<Folders>('native_settings_write',{root,folders:payload(folders)});
export interface FolderMoveReport { folders:Folders; movedFiles:number; warnings:string[] }
export const moveFolders=(root:string,folders:Folders)=>invoke<FolderMoveReport>('native_settings_move',{root,folders:payload(folders),confirmed:true});
export const filesPresent=(paths:string[])=>invoke<boolean[]>('native_files_present',{paths});
