import { invoke, isTauri } from '@tauri-apps/api/core';

let ready = false;
/** Reports a real startup phase to the native splash; never blocks or fails the UI. */
export function startupPhase(phase: 'restore'): void {
  if (isTauri() && !ready) void invoke('native_startup_phase', { phase }).catch(() => {});
}
/** Hands off from the splash to the main window once UI state is restored. Idempotent. */
export function startupReady(): void {
  if (!isTauri() || ready) return;
  ready = true;
  void invoke('native_startup_ready').catch(() => {});
}
