import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CompiledRecipe, DiagnosticImageIntentV1 } from './execution';
import type { VideoIntentV1 } from './videoIntent';

/** Image recipe or one of the video family recipes; both compile natively. */
export type JobIntent = DiagnosticImageIntentV1 | VideoIntentV1;

export interface DiagnosticJobPlan {
  id: string;
  baseUrl: string;
  intent: JobIntent;
  graph: CompiledRecipe['graph'];
  generationReady: false;
}
export interface JobStatus {
  id: string;
  baseUrl: string;
  promptId: string | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  /** `format` is the MIME type the video combine reports (`video/webm`); image savers omit it. */
  outputs: { filename: string; subfolder: string; type: 'output'; format?: string }[];
  error: string | null;
  generationReady: false;
  /** Immutable native-held intent, never the workbench's current controls. */
  intent?: JobIntent;
  /** Native-captured output directory, omitted if its filesystem identity is no longer valid. */
  outputRoot?: string;
  appVersion?: string;
  metadata?: { startedAt: number; generationMs: number | null } | null;
  /** Native-held delete attempt; even an unknown result must not authorize another delete. */
  pendingCancellationAttempted?: true;
  /** A running-interrupt attempt is never retried merely because its result is unknown. */
  interruptCancellationAttempted?: true;
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
/** Native-held Studio session; oldest job first, independent of the diagnostic slot. */
export interface WorkbenchSnapshot { jobs: JobStatus[]; preparing: number; capacity: number; stopAvailable: boolean; admissionEpoch: number; stopping: boolean; /** Frontend Run IPC still awaiting a reply; not a native reservation count. */ frontendAdmitting?: boolean }
export interface WorkbenchStopResult extends WorkbenchSnapshot { outcome: 'empty'|'settled'|'partial'; discarded: number; issues: {jobId:string;error:string}[] }
const pendingWorkbenchRuns = new Map<number, number>();
let pendingWorkbenchStop: Promise<WorkbenchStopResult> | undefined;
export function runWorkbenchJob(baseUrl: string, intent: VideoIntentV1, admissionEpoch: number): Promise<JobStatus>;
export function runWorkbenchJob(baseUrl: string, intent: JobIntent, admissionEpoch: number): Promise<JobStatus>;
export function runWorkbenchJob(baseUrl: string, intent: DiagnosticImageIntentV1, admissionEpoch: number): Promise<JobStatus>;
export function runWorkbenchJob(baseUrl: string, intent: JobIntent, admissionEpoch: number): Promise<JobStatus> {
  if (!baseUrl.trim()) return Promise.reject(new Error('An explicit backend endpoint is required.'));
  if (pendingWorkbenchStop) return Promise.reject(new Error('Workbench Stop is in progress.'));
  pendingWorkbenchRuns.set(admissionEpoch, (pendingWorkbenchRuns.get(admissionEpoch) ?? 0) + 1);
  return native<JobStatus>('native_workbench_run', { baseUrl, intent, confirmed: true, admissionEpoch }).finally(() => { const left = (pendingWorkbenchRuns.get(admissionEpoch) ?? 1) - 1; if (left) pendingWorkbenchRuns.set(admissionEpoch, left); else pendingWorkbenchRuns.delete(admissionEpoch); });
}
export function stopWorkbench(): Promise<WorkbenchStopResult> {
  if (!pendingWorkbenchStop) pendingWorkbenchStop = native<WorkbenchStopResult>('native_workbench_stop', {confirmed:true}).finally(() => { pendingWorkbenchStop = undefined; });
  return pendingWorkbenchStop;
}
async function observeWorkbench(command: string): Promise<WorkbenchSnapshot> {
  const admitting = [...pendingWorkbenchRuns.keys()];
  const stopping = !!pendingWorkbenchStop;
  const snapshot = await native<WorkbenchSnapshot>(command, {});
  // A reply settling during this read cannot make its earlier idle snapshot authoritative.
  return { ...snapshot, stopping: snapshot.stopping || stopping || !!pendingWorkbenchStop, frontendAdmitting: [...admitting, ...pendingWorkbenchRuns.keys()].some(epoch => epoch >= snapshot.admissionEpoch) };
}
export const readCurrentWorkbench = (): Promise<WorkbenchSnapshot> => observeWorkbench('native_workbench_current');
export const pollWorkbench = (): Promise<WorkbenchSnapshot> => observeWorkbench('native_workbench_poll');
// Overloads: the image signature stays last so `Parameters<>` in existing tests still resolve to the image intent.
export function prepareDiagnosticJob(baseUrl: string, intent: VideoIntentV1): Promise<DiagnosticJobPlan>;
export function prepareDiagnosticJob(baseUrl: string, intent: DiagnosticImageIntentV1): Promise<DiagnosticJobPlan>;
export function prepareDiagnosticJob(baseUrl: string, intent: JobIntent): Promise<DiagnosticJobPlan> {
  if (!baseUrl.trim()) return Promise.reject(new Error('An explicit backend endpoint is required.'));
  return native('native_job_prepare', { baseUrl, intent });
}
/** Inpaint mask PNG → backend input folder; returns its `deas-masks/<uuid>.png` name for `inputMask`. */
export const uploadMask = (baseUrl: string, png: Uint8Array): Promise<string> => native('native_mask_upload', { baseUrl, png: Array.from(png) });
/** Reference image (PNG/JPEG/WebP on disk) → backend input folder; returns its `deas-inputs/<uuid>.<ext>` name for H3 Director references. */
export const uploadInput = (baseUrl: string, path: string): Promise<string> => native('native_input_upload', { baseUrl, path });
export interface H3PreparedVideo { sourceId:string; filename:string; sha256:string; width:number; height:number; fps:number; seconds:number; hasAudio:boolean }
export interface H3ImportedVideo { sourceId:string; width:number; height:number; modeFamily:'fl2va'|'ref2va' }
export const prepareH3Video=(baseUrl:string,filename:string):Promise<H3PreparedVideo>=>native('native_h3_video_prepare',{baseUrl,filename});
export interface H3Clip { importedVideo?:H3ImportedVideo; clipId: string; parent: string | null; frames: number | null; completed: number; export: { filename: string; subfolder: string; type: string } | null }
/** Read-only DaSiWa continuity session listing (clips newest first). */
/** One DaSiWa RefMod library entry (`models/refmods`), read-only. */
export interface RefModEntry { name: string; kinds: ('image' | 'video' | 'audio')[]; description: string }
export const readRefMods = (baseUrl: string): Promise<RefModEntry[]> => native('native_h3_refmods', { baseUrl });
export const readH3Session = (baseUrl: string, session: string): Promise<{ latestId: string | null; clips: H3Clip[] }> => native('native_h3_session', { baseUrl, session });
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
