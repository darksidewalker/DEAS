import { invoke } from '@tauri-apps/api/core';
export interface Folders { models?:string; input?:string; output?:string }
export const readFolders=(root:string)=>invoke<Folders>('native_settings_read',{root});
export const writeFolders=(root:string,folders:Folders)=>invoke<Folders>('native_settings_write',{root,folders});
export const filesPresent=(paths:string[])=>invoke<boolean[]>('native_files_present',{paths});
