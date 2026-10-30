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

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function inspectVideoPost(title: string): Promise<VideoPostInspection | null> {
  return validateInspection(await invoke<VideoPostInspection | null>('native_video_post_inspect', { title }));
}
/** Media-panel selection: the listed file's absolute path goes through the same native source checks as the chooser. */
export async function inspectVideoPostPath(path: string): Promise<VideoPostInspection | null> {
  return validateInspection(await invoke<VideoPostInspection | null>('native_video_post_inspect_path', { path }));
}
function validateInspection(value: VideoPostInspection | null): VideoPostInspection | null {
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

/** Copies the retained inspected source into the backend input folder; returns the LoadVideo file name for a `video-enhance` intent. */
export async function uploadVideoPostSource(baseUrl: string, sourceId: string): Promise<string> {
  const name = await invoke<string>('native_video_post_upload', { baseUrl, sourceId });
  if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('Invalid native video upload result');
  return name;
}
