import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { WindowSetting } from './WindowSetting';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));

beforeEach(() => {
 localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
 vi.mocked(isTauri).mockReturnValue(true);
 vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) =>
  command === 'native_window_read' ? 'maximized' : (args as { startMode: string }).startMode);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const select = async () => (await screen.findByLabelText('Start window')) as HTMLSelectElement;

it('shows the stored choice and stores a change for the next start without touching this window', async () => {
 render(<I18nProvider><WindowSetting/></I18nProvider>);
 const box = await select();
 await waitFor(() => expect(box.value).toBe('maximized'));
 fireEvent.change(box, { target: { value: 'fullscreen' } });
 await waitFor(() => expect(invoke).toHaveBeenCalledWith('native_window_write', { startMode: 'fullscreen' }));
 await screen.findByText('Saved. It applies when DEAS starts again.');
 expect((await select()).value).toBe('fullscreen');
 expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'native_window_read' || command === 'native_window_write')).toBe(true);
});

it('keeps the documented default visible when the native store is unreadable', async () => {
 vi.mocked(invoke).mockRejectedValue(new Error('disk full'));
 render(<I18nProvider><WindowSetting/></I18nProvider>);
 const box = await select();
 await waitFor(() => expect(box.value).toBe('maximized'));
 expect(box.disabled).toBe(false);
});

it('reports a refused save instead of pretending the choice was kept', async () => {
 vi.mocked(invoke).mockImplementation(async (command: string) => { if (command === 'native_window_write') throw new Error('read-only'); return 'maximized'; });
 render(<I18nProvider><WindowSetting/></I18nProvider>);
 const box = await select();
 await waitFor(() => expect(box.value).toBe('maximized'));
 fireEvent.change(box, { target: { value: 'windowed' } });
 const alert = await screen.findByRole('alert');
 expect(alert.textContent).toContain('read-only');
 expect((await select()).value).toBe('maximized');
});
