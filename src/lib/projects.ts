import { invoke } from '@tauri-apps/api/core';

export interface ImageDraft {
 positivePrompt: string; negativePrompt: string; checkpoint: string;
 width: number; height: number; steps: number; cfg: number;
 sampler: string; scheduler: string; seed: number; denoise: number; pipeline: 't2i' | 'i2i';
}
export interface ProjectInput { id: string; path: string; sha256: string; width: number; height: number }
export interface ProjectSnapshot { id: string; root: string; revision: number; draft: ImageDraft; input: ProjectInput | null }
export const importProjectImage = (title: string, projectId: string, expectedRevision: number) => invoke<ProjectSnapshot | null>('native_project_import_image', { title, projectId, expectedRevision });
export const openProject = (title: string) => invoke<ProjectSnapshot | null>('native_project_open', { title });
export const closeProject = (projectId: string) => invoke<void>('native_project_close', { projectId });
export const createProject = (title: string) => invoke<ProjectSnapshot | null>('native_project_create', { title });
export const saveProject = (projectId: string, expectedRevision: number, draft: ImageDraft) => invoke<ProjectSnapshot>('native_project_save', { projectId, expectedRevision, draft });
