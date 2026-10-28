import { invoke } from '@tauri-apps/api/core';

export interface VideoPostInspection {
  sourceId?: string;
  name: string;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  durationSeconds: number | null;
  pixelFormat: string;
  fieldOrder: string;
  colorTransfer: string;
  audioStreams: number;
  subtitleStreams: number;
  blockers: string[];
  timingVerified: false;
  processingReady: false;
}

export type VideoPostSource = Pick<VideoPostInspection, 'name' | 'width' | 'height' | 'fpsNumerator' | 'fpsDenominator' | 'audioStreams' | 'subtitleStreams' | 'blockers'>;
export interface VideoPostSettings { scale: 1 | 2 | 4; profile: 'mp4-h264' | 'mkv-h264' | 'webm-vp9' }
export interface VideoPostDraft {
  kind: 'deas-video-post-draft';
  version: 1;
  source: VideoPostSource;
  settings: VideoPostSettings;
  output: { filename: string; width: number; height: number; fpsNumerator: number; fpsDenominator: number; container: string; videoEncoder: string; pixelFormat: string; audioEncoder?: string; audioBitrate?: number };
  blockers: string[];
  processingReady: false;
  timingVerified: false;
  encoderVerified: false;
}
const positiveInteger = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
const nonNegativeInteger = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(code => typeof code === 'string');
function validSource(v: VideoPostSource | undefined): boolean {
  return !!v && typeof v.name === 'string' && [v.width, v.height, v.fpsDenominator].every(positiveInteger)
    && [v.fpsNumerator, v.audioStreams, v.subtitleStreams].every(nonNegativeInteger) && stringList(v.blockers);
}

export async function checkVideoPostDraft(inspection: VideoPostInspection, settings: VideoPostSettings): Promise<VideoPostDraft> {
  const { name, width, height, fpsNumerator, fpsDenominator, audioStreams, subtitleStreams, blockers } = inspection;
  const source: VideoPostSource = { name, width, height, fpsNumerator, fpsDenominator, audioStreams, subtitleStreams, blockers };
  const value = await invoke<VideoPostDraft>('native_video_post_draft', { source, settings });
  const output = value?.output;
  if (!value || value.kind !== 'deas-video-post-draft' || value.version !== 1 || !validSource(value.source)
    || !value.settings || ![1, 2, 4].includes(value.settings.scale) || !['mp4-h264', 'mkv-h264', 'webm-vp9'].includes(value.settings.profile)
    || !output || !['filename', 'container', 'videoEncoder', 'pixelFormat'].every(key => typeof output[key as keyof typeof output] === 'string')
    || ![output.width, output.height, output.fpsDenominator].every(positiveInteger) || !nonNegativeInteger(output.fpsNumerator)
    || !(output.audioEncoder === undefined || typeof output.audioEncoder === 'string')
    || !(output.audioBitrate === undefined || positiveInteger(output.audioBitrate)) || !stringList(value.blockers)
    || value.processingReady !== false || value.timingVerified !== false || value.encoderVerified !== false) {
    throw new Error('Invalid native video output draft');
  }
  return value;
}

export interface VideoPostPrepared {
  id: string;
  sourceId: string;
  sourceName: string;
  outputName: string;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  settings: { scale: VideoPostSettings['scale']; profile: 'mp4-h264' };
  modelBound: false;
  timingVerified: false;
  encoderVerified: false;
  processingReady: false;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function validatePrepared(value: VideoPostPrepared): VideoPostPrepared {
  if (!value || !uuid(value.id) || !uuid(value.sourceId)
    || typeof value.sourceName !== 'string' || !value.sourceName || typeof value.outputName !== 'string' || !value.outputName
    || ![value.width, value.height, value.fpsNumerator, value.fpsDenominator].every(positiveInteger)
    || !value.settings || ![1, 2, 4].includes(value.settings.scale) || value.settings.profile !== 'mp4-h264'
    || value.modelBound !== false || value.timingVerified !== false || value.encoderVerified !== false || value.processingReady !== false) {
    throw new Error('Invalid native video output preparation');
  }
  return value;
}
export async function prepareVideoPost(sourceId: string, settings: VideoPostSettings, title: string): Promise<VideoPostPrepared | null> {
  const value = await invoke<VideoPostPrepared | null>('native_video_post_prepare', { sourceId, settings: { scale: settings.scale, profile: settings.profile }, title });
  if (value === null) return null;
  validatePrepared(value);
  if (value.sourceId !== sourceId || value.settings.scale !== settings.scale || value.settings.profile !== settings.profile) throw new Error('Invalid native video output preparation');
  return value;
}
export async function recheckVideoPost(prepared: VideoPostPrepared): Promise<VideoPostPrepared> {
  const value = validatePrepared(await invoke<VideoPostPrepared>('native_video_post_prepared_status', { id: prepared.id }));
  if (value.id !== prepared.id || value.sourceId !== prepared.sourceId || value.sourceName !== prepared.sourceName || value.outputName !== prepared.outputName
    || value.width !== prepared.width || value.height !== prepared.height || value.fpsNumerator !== prepared.fpsNumerator || value.fpsDenominator !== prepared.fpsDenominator
    || value.settings.scale !== prepared.settings.scale || value.settings.profile !== prepared.settings.profile) throw new Error('Invalid native video output preparation');
  return value;
}

export interface VideoPostBinding { id: string; runtimeName: string; modelName: string; dependencyName?: string }
export interface VideoPostJob {
  id: string;
  state: 'starting' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
  sourceName: string;
  outputName: string;
  frames?: number;
  width?: number;
  height?: number;
  error?: string;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v: object, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const named = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export async function videoPostCapabilities(): Promise<boolean> {
  const value = await invoke<unknown>('native_video_post_capabilities');
  if (!record(value) || !onlyKeys(value, ['available']) || typeof value.available !== 'boolean') throw new Error('Invalid native video capabilities');
  return value.available;
}
export async function bindVideoPost(titles: { runtime: string; model: string; dependency: string }): Promise<VideoPostBinding | null> {
  const value = await invoke<VideoPostBinding | null>('native_video_post_bind', { titles });
  if (value === null) return null;
  if (!record(value) || !onlyKeys(value, ['id', 'runtimeName', 'modelName', 'dependencyName']) || !uuid(value.id)
    || !named(value.runtimeName) || !named(value.modelName) || ('dependencyName' in value && !named(value.dependencyName))) throw new Error('Invalid native video binding');
  return value;
}
function validateJob(value: VideoPostJob, id?: string): VideoPostJob {
  if (!record(value) || !onlyKeys(value, ['id', 'state', 'sourceName', 'outputName', 'frames', 'width', 'height', 'error'])
    || !uuid(value.id) || (id !== undefined && value.id !== id)
    || !['starting', 'running', 'stopping', 'succeeded', 'failed', 'cancelled'].includes(value.state)
    || !named(value.sourceName) || !named(value.outputName)
    || ('frames' in value && !nonNegativeInteger(value.frames))
    || ['width', 'height'].some(key => key in value && !positiveInteger(value[key as keyof VideoPostJob]))
    || ('error' in value && !named(value.error))) throw new Error('Invalid native video job');
  return value;
}
export async function runVideoPost(preparationId: string, profileId: string): Promise<VideoPostJob> {
  if (!uuid(preparationId) || !uuid(profileId)) throw new Error('Invalid native video job authority');
  return validateJob(await invoke<VideoPostJob>('native_video_post_run', { preparationId, profileId }));
}
export async function videoPostJobCommand(command: 'status' | 'stop', id: string): Promise<VideoPostJob> {
  if (!['status', 'stop'].includes(command) || !uuid(id)) throw new Error('Invalid native video job authority');
  return validateJob(await invoke<VideoPostJob>(`native_video_post_${command}`, { id }), id);
}

export async function inspectVideoPost(title: string): Promise<VideoPostInspection | null> {
  const value = await invoke<VideoPostInspection | null>('native_video_post_inspect', { title });
  if (value === null) return null;
  if (!value || typeof value !== 'object'
    || !(value.sourceId === undefined || uuid(value.sourceId))
    || !['name', 'pixelFormat', 'fieldOrder', 'colorTransfer'].every(key => typeof value[key as keyof VideoPostInspection] === 'string')
    || !Number.isSafeInteger(value.fpsDenominator) || value.fpsDenominator <= 0
    || ![value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0)
    || ![value.fpsNumerator, value.fpsDenominator, value.audioStreams, value.subtitleStreams].every(n => Number.isSafeInteger(n) && n >= 0)
    || !(value.durationSeconds === null || (Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0))
    || !Array.isArray(value.blockers) || !value.blockers.every(code => typeof code === 'string')
    || value.timingVerified !== false || value.processingReady !== false) {
    throw new Error('Invalid native video inspection');
  }
  return value;
}
