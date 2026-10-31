import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../i18n/I18nProvider';
import { TveBackendEnhance } from './TveBackendEnhance';
import { defaultTve, describeVideoPost, fromVideoPost, isTvePref, toVideoPost } from './TvePostControls';
import type { VideoPostInspection } from '../../lib/videoPost';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
beforeEach(() => { localStorage.setItem(LOCALE_STORAGE_KEY, 'en'); vi.mocked(isTauri).mockReturnValue(true); });
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
const source: VideoPostInspection = { sourceId: 'src-1', name: 'clip.mp4', width: 1280, height: 720, fpsNumerator: 24, fpsDenominator: 1, durationSeconds: 3, pixelFormat: 'yuv420p', fieldOrder: 'progressive', colorTransfer: 'bt709', audioStreams: 1, subtitleStreams: 0, blockers: [], timingVerified: false, processingReady: false };

test('controls round-trip through the intent block and omit disabled stages', () => {
  expect(toVideoPost(defaultTve)).toBeUndefined();
  const pref = { ...defaultTve, denoise: true, denoiseQuality: 'High' as const, frameGen: true, engine: 'rtx' as const, multiplier: 3, mode: 'LOW' as const };
  const post = toVideoPost(pref)!;
  expect(post).toEqual({ rtx: { denoise: 'High' }, frameGeneration: { engine: 'rtx', multiplier: 3, mode: 'LOW' } });
  expect(fromVideoPost(post)).toEqual(pref);
  expect(fromVideoPost(undefined)).toEqual(defaultTve);
  expect(describeVideoPost(post)).toBe('Denoise High → RTX FrameGen LOW ×3');
});

test('RTX memory options reach the intent only when a stage is selected', () => {
  const pref = { ...defaultTve, rtxUpscale: true, chunkFrames: 8, useMmap: true, frameGen: true, engine: 'rtx' as const };
  const post = toVideoPost(pref)!;
  expect(post).toEqual({ rtx: { upscale: { mode: 'VSR', quality: 'Ultra', scale: 2 }, chunkFrames: 8 }, useMmap: true, frameGeneration: { engine: 'rtx', multiplier: 2, mode: 'HIGH' } });
  expect(fromVideoPost(post)).toEqual(pref);
  // Node default chunk size and no RTX stage leave the intent unchanged.
  expect(toVideoPost({ ...defaultTve, rtxUpscale: true })).toEqual({ rtx: { upscale: { mode: 'VSR', quality: 'Ultra', scale: 2 } } });
  expect(toVideoPost({ ...defaultTve, useMmap: true, frameGen: true, engine: 'rife' as const, rifeModel: 'rife.safetensors' })).toEqual({ frameGeneration: { engine: 'rife', multiplier: 2, model: 'rife.safetensors' } });
});

test('a preference saved before the RTX memory controls keeps its defaults', () => {
  const legacy = { upscaleModel: '', denoise: true, denoiseQuality: 'High', deblur: false, deblurQuality: 'Ultra', rtxUpscale: false, rtxMode: 'VSR', rtxQuality: 'Ultra', rtxScale: 2, frameGen: false, engine: 'rtx', multiplier: 2, mode: 'HIGH', rifeModel: '' };
  expect(isTvePref(legacy)).toBe(true);
  expect(toVideoPost(legacy as Parameters<typeof toVideoPost>[0])).toEqual({ rtx: { denoise: 'High' } });
});

test('the TVE panel polls its own job and shows the backend failure', async () => {
  vi.useFakeTimers();
  const job = { id: 'j1', baseUrl: 'http://127.0.0.1:7801/', promptId: 'p', outputs: [], error: null, generationReady: false };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'native_recipe_prerequisites') return { baseUrl: 'http://127.0.0.1:7801/', recipeId: 'checkpoint-text-to-image-diagnostic', version: 1, allowlist: { nodes: ['DaSiWa_RTX_UpscalerRefiner'], checkpoints: [], loras: [], images: [], samplers: [], schedulers: [], upscaleModels: [] }, missingNodes: [], generationReady: false };
    if (command === 'native_workbench_current') return { jobs: [], preparing: 0, capacity: 1, stopAvailable: false, admissionEpoch: 4, stopping: false };
    if (command === 'native_video_post_upload') return 'deas-input-1.mp4';
    if (command === 'native_workbench_run') return { ...job, state: 'queued' };
    if (command === 'native_workbench_poll') return { jobs: [{ ...job, state: 'failed', error: 'RTX output requires 22.91 GiB; available RAM=14.50 GiB' }], preparing: 0, capacity: 1, stopAvailable: true, admissionEpoch: 4, stopping: false };
    throw new Error(`unexpected ${command}`);
  });
  render(<I18nProvider><TveBackendEnhance endpoint="http://127.0.0.1:7801/" source={source}/></I18nProvider>);
  fireEvent.click(document.querySelector('[data-tve-post="denoise"]')!);
  await act(async () => { fireEvent.click(document.querySelector('[data-tve-enhance]')!); });
  expect(document.querySelector('[data-tve-enhance-job]')?.getAttribute('data-state')).toBe('queued');
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(document.querySelector('[data-tve-enhance-job]')?.getAttribute('data-state')).toBe('failed');
  expect(screen.getByText(/RTX output requires 22\.91 GiB/)).toBeTruthy();
  vi.useRealTimers();
});

test('enhance uploads the retained source natively and submits a video-enhance job to the shared session', async () => {
  const calls: [string, unknown][] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    calls.push([command, args]);
    if (command === 'native_recipe_prerequisites') return { baseUrl: 'http://127.0.0.1:7801/', recipeId: 'checkpoint-text-to-image-diagnostic', version: 1, allowlist: { nodes: ['DaSiWa_RTX_UpscalerRefiner'], checkpoints: [], loras: [], images: [], samplers: [], schedulers: [], upscaleModels: ['2x.safetensors'] }, missingNodes: [], generationReady: false };
    if (command === 'native_workbench_current') return { jobs: [], preparing: 0, capacity: 1, stopAvailable: false, admissionEpoch: 4, stopping: false };
    if (command === 'native_video_post_upload') return 'deas-input-1.mp4';
    if (command === 'native_workbench_run') return { id: 'j1', baseUrl: 'http://127.0.0.1:7801/', promptId: 'p', state: 'queued', outputs: [], error: null, generationReady: false };
    throw new Error(`unexpected ${command}`);
  });
  render(<I18nProvider><TveBackendEnhance endpoint="http://127.0.0.1:7801/" source={source}/></I18nProvider>);
  const run = document.querySelector('[data-tve-enhance]') as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(screen.getByText('Enable at least one TVE stage.')).toBeTruthy();
  fireEvent.click(document.querySelector('[data-tve-post="denoise"]')!);
  expect(run.disabled).toBe(false);
  fireEvent.change(document.querySelector('[data-tve-output="codec"]')!, { target: { value: 'AV1' } });
  await act(async () => { fireEvent.click(run); });
  const submitted = calls.find(([c]) => c === 'native_workbench_run')![1] as { baseUrl: string; intent: Record<string, unknown>; admissionEpoch: number };
  expect(calls.find(([c]) => c === 'native_video_post_upload')![1]).toEqual({ baseUrl: 'http://127.0.0.1:7801/', sourceId: 'src-1' });
  expect(submitted.admissionEpoch).toBe(4);
  expect(submitted.intent).toMatchObject({ recipeId: 'video-enhance', version: 1, sourceVideo: 'deas-input-1.mp4', frameRate: 24, videoPost: { rtx: { denoise: 'Ultra' } }, output: { codec: 'AV1', container: 'Auto' } });
  expect(submitted.intent).not.toHaveProperty('outputPrefix');
  expect(document.querySelector('[data-tve-enhance-job]')?.getAttribute('data-state')).toBe('queued');
});
