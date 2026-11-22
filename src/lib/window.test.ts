import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { DEFAULT_START_MODE, readStartMode, toggleFullscreen, writeStartMode } from './window';

const window = vi.hoisted(() => ({ isFullscreen: vi.fn(), setFullscreen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => window }));

beforeEach(() => {
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockReset().mockImplementation(async (command: string, args?: unknown) =>
  command === 'native_window_read' ? 'fullscreen' : (args as { startMode: string })?.startMode);
 window.isFullscreen.mockReset().mockResolvedValue(false);
 window.setFullscreen.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.resetAllMocks());

it('reads the stored start window and refuses an unknown value with the default', async () => {
 await expect(readStartMode()).resolves.toBe('fullscreen');
 vi.mocked(invoke).mockResolvedValue('fullscreenized');
 await expect(readStartMode()).resolves.toBe(DEFAULT_START_MODE);
});

it('stores the mode natively and needs the desktop app for it', async () => {
 await expect(writeStartMode('windowed')).resolves.toBe('windowed');
 expect(invoke).toHaveBeenCalledWith('native_window_write', { startMode: 'windowed' });
 vi.mocked(isTauri).mockReturnValue(false);
 await expect(writeStartMode('maximized')).rejects.toThrow(/WINDOW_NATIVE/);
 await expect(readStartMode()).resolves.toBe(DEFAULT_START_MODE);
 expect(invoke).not.toHaveBeenCalledWith('native_window_read', undefined);
});

it('F11 flips fullscreen against the real window state and logs a refused change once', async () => {
 await expect(toggleFullscreen()).resolves.toBe(true);
 expect(window.setFullscreen).toHaveBeenCalledWith(true);
 window.isFullscreen.mockResolvedValue(true);
 await expect(toggleFullscreen()).resolves.toBe(false);
 expect(window.setFullscreen).toHaveBeenLastCalledWith(false);

 window.isFullscreen.mockRejectedValue(new Error('refused'));
 await expect(toggleFullscreen()).resolves.toBe(false);
 expect(invoke).toHaveBeenCalledWith('native_logs_window_error', { operation: 'fullscreen' });
});
