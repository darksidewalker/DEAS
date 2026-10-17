import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CompiledRecipe, DiagnosticImageIntentV1 } from './execution';

export interface DiagnosticJobPlan {
  id: string;
  baseUrl: string;
  intent: DiagnosticImageIntentV1;
  graph: CompiledRecipe['graph'];
  generationReady: false;
}
export interface JobStatus {
  id: string;
  baseUrl: string;
  promptId: string | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  outputs: { filename: string; subfolder: string; type: 'output' }[];
  error: string | null;
  generationReady: false;
  /** Live sampler steps and latest preview data URL, only while queued/running. */
  progress?: { value: number; max: number };
  preview?: string;
}
async function native<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Native job execution requires the DEAS desktop app.');
  try { return await invoke<T>(command, args); }
  catch (error) {
    if (error && typeof error === 'object' && 'message' in error) {
      const detail = error as { code?: unknown; message: unknown };
      throw new Error(`${detail.code ? `${String(detail.code)}: ` : ''}${String(detail.message)}`);
    }
    throw error;
  }
}
export function prepareDiagnosticJob(baseUrl: string, intent: DiagnosticImageIntentV1): Promise<DiagnosticJobPlan> {
  if (!baseUrl.trim()) return Promise.reject(new Error('An explicit backend endpoint is required.'));
  return native('native_job_prepare', { baseUrl, intent });
}
export const submitDiagnosticJob = (planId: string): Promise<JobStatus> => native('native_job_submit', { planId, confirmed: true });
export const readDiagnosticJobStatus = (jobId: string): Promise<JobStatus> => native('native_job_status', { jobId });
export const readCurrentDiagnosticJob = (): Promise<JobStatus | null> => native('native_job_current', {});
export interface JobOutput {
  jobId: string; index: number; mimeType: 'image/png'; width: number; height: number; sha256: string; bytes: number[];
}
export interface JobExport { path: string; sha256: string; size: number }
export async function loadDiagnosticJobOutput(jobId: string, index: number): Promise<JobOutput> {
  const value = await native<JobOutput>('native_job_output', { jobId, index });
  if (!value || value.jobId !== jobId || value.index !== index || value.mimeType !== 'image/png'
    || !Number.isInteger(value.width) || value.width <= 0 || value.width > 8192
    || !Number.isInteger(value.height) || value.height <= 0 || value.height > 8192
    || value.width * value.height > 16_777_216
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Array.isArray(value.bytes) || value.bytes.length === 0 || value.bytes.length > 144 * 1024 * 1024) {
    throw new Error('Invalid native PNG output.');
  }
  for (const byte of value.bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('Invalid native PNG output.');
  }
  return value;
}
export const exportDiagnosticJobOutput = (jobId: string, index: number, title: string): Promise<JobExport | null> => native('native_job_export', { jobId, index, title });
