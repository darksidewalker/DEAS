import { invoke } from '@tauri-apps/api/core';
/** Installed models under the ComfyUI models folder; CivitAI metadata is cached natively beside each file. */
export interface ModelSettings { sampler?:string; scheduler?:string; steps?:number; cfgScale?:number; size?:string; clipSkip?:number }
export interface CivitaiInfo { modelId:number; versionId:number; name:string; version:string; modelType:string; category:string; base?:string; nsfw:boolean; trainedWords:string[]; preview?:string; settings?:ModelSettings }
export interface ModelInfo { sha256:string; size:number; fetchedAt:number; civitai:CivitaiInfo|null }
export interface LocalModel { category:string; name:string; path:string; size:number; info:ModelInfo|null }
export const scanModels=(root:string)=>invoke<LocalModel[]>('native_models_scan',{root});
/** Hashes the file once (cached), asks CivitAI by hash and writes `<file>.deas.json`. */
export const fetchModelInfo=(path:string,authenticated:boolean)=>invoke<LocalModel>('native_model_info',{path,authenticated});
