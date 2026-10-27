import { invoke } from '@tauri-apps/api/core';

export interface VideoPostInspection {
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

export async function inspectVideoPost(title: string): Promise<VideoPostInspection | null> {
  const value = await invoke<VideoPostInspection | null>('native_video_post_inspect', { title });
  if (value === null) return null;
  if (!value || typeof value !== 'object'
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
