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
