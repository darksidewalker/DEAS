import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * DEAS's own window. Two separate things:
 * - how the window opens on the next start (windowed / maximized / fullscreen), stored natively because the
 *   choice must be known before the window exists, and never applied to the window you are looking at;
 * - fullscreen right now, through F11 or the operating system.
 * The browser fixture has neither a native store nor a window, so both paths are guarded.
 */
export const START_MODES = ['windowed', 'maximized', 'fullscreen'] as const;
export type StartMode = (typeof START_MODES)[number];
/** A small floating window was the complaint; the whole screen with its frame is the normal case. */
export const DEFAULT_START_MODE: StartMode = 'maximized';

const isMode = (value: unknown): value is StartMode => (START_MODES as readonly unknown[]).includes(value);

/** What this installation will open with; an unreadable store reports the default instead of failing. */
export function readStartMode(): Promise<StartMode> {
 if (!isTauri()) return Promise.resolve(DEFAULT_START_MODE);
 return invoke<StartMode>('native_window_read').then(value => (isMode(value) ? value : DEFAULT_START_MODE));
}

/** Stored for the next start. The current window is deliberately untouched. */
export function writeStartMode(mode: StartMode): Promise<StartMode> {
 if (!isTauri()) return Promise.reject(new Error('WINDOW_NATIVE: the start-window choice needs the DEAS desktop app.'));
 return invoke<StartMode>('native_window_write', { startMode: mode });
}

/** Leaves or enters fullscreen on the running window; a refused change is reported to DEAS Logs. */
export async function toggleFullscreen(): Promise<boolean> {
 if (!isTauri()) return false;
 try {
  const on = await getCurrentWindow().isFullscreen();
  await getCurrentWindow().setFullscreen(!on);
  return !on;
 }
 catch {
  void invoke('native_logs_window_error', { operation: 'fullscreen' }).catch(() => undefined);
  return false;
 }
}
