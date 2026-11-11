import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ContinuityJoin } from './ContinuityJoin';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../lib/videoPost', () => ({ inspectVideoPost: vi.fn(), uploadVideoPostSource: vi.fn() }));
vi.mock('../../lib/jobs', () => ({
  readH3Session: vi.fn(),
  readCurrentWorkbench: vi.fn(async () => ({ admissionEpoch: 4 })),
  runWorkbenchJob: vi.fn(async () => ({ id: 'j1', baseUrl: 'http://127.0.0.1:7801', promptId: 'p', state: 'queued', outputs: [], error: null, generationReady: false })),
  waitForWorkbenchJob: vi.fn(async (job: unknown) => ({ ...(job as object), state: 'succeeded', outputs: [{ filename: 'H3_Joined_ab.mp4', subfolder: '', type: 'output' }] })),
}));
import { readH3Session, runWorkbenchJob, waitForWorkbenchJob } from '../../lib/jobs';
import { inspectVideoPost, uploadVideoPostSource } from '../../lib/videoPost';

const clips = [
  { clipId: 'root', parent: null, frames: 120, completed: 1, export: null },
  { clipId: 'c1', parent: 'root', frames: 239, completed: 1, export: { filename: 'a.mp4', subfolder: '', type: 'output' } },
  { clipId: 'c2', parent: 'c1', frames: 358, completed: 1, export: { filename: 'b.mp4', subfolder: '', type: 'output' } },
];
const settled = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const mount = (running = false) => {
  localStorage.setItem('deas.locale.v1', 'en');
  return render(<I18nProvider><ContinuityJoin endpoint="http://127.0.0.1:7801" session="s" running={running} disabled={false} /></I18nProvider>);
};
beforeEach(() => {
  vi.mocked(readH3Session).mockClear().mockResolvedValue({ latestId: 'c2', clips } as never);
  vi.mocked(runWorkbenchJob).mockClear();
  vi.mocked(waitForWorkbenchJob).mockClear();
  globalThis.fetch = vi.fn(async () => ({ json: async () => ({ ok: true, issues: [], seconds: 14.916, mode: 'copy' }) })) as never;
  vi.mocked(inspectVideoPost).mockClear().mockResolvedValue({ sourceId: '11111111-2222-3333-4444-555555555555', name: 'take a', blockers: [], durationSeconds: 20 } as never);
  vi.mocked(uploadVideoPostSource).mockClear().mockResolvedValue('take_a.mp4');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('chain to here walks parents, preflight gates Join, Join submits the pinned h3-join intent and shows the file', async () => {
  const { container } = mount();
  await settled();
  const rows = [...container.querySelectorAll('[data-cont-join-chain]')];
  expect(rows).toHaveLength(3);
  fireEvent.click(rows[2]); // c2 → chain root→c1→c2
  expect(screen.getByText(/Chain: 3$/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Join now' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check preflight' }));
  await settled();
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:7801/df_h3_continuity/assembly/preflight',
    expect.objectContaining({ method: 'POST' }));
  expect(screen.getByText('copy · 14.9 s')).toBeTruthy();
  const run = screen.getByRole('button', { name: 'Join now' }) as HTMLButtonElement;
  expect(run.disabled).toBe(false);
  fireEvent.click(run);
  await settled();
  expect(runWorkbenchJob).toHaveBeenCalledWith('http://127.0.0.1:7801',
    { recipeId: 'h3-join', version: 1, h3: { join: { kind: 'segments', session: 's', chain: ['root', 'c1', 'c2'] } } }, 4);
  expect(screen.getByText(/H3_Joined_ab\.mp4/)).toBeTruthy();
});

test('copy option rides the preflight body and the intent; failing preflight keeps Join disabled', async () => {
  const { container } = mount();
  await settled();
  fireEvent.click([...container.querySelectorAll('[data-cont-join-chain]')][1]);
  const copy = screen.getByRole('checkbox') as HTMLInputElement;
  fireEvent.click(copy);
  let preflightBody = '';
  globalThis.fetch = vi.fn(async (_u: unknown, init: { body: string }) => { preflightBody = init.body; return { json: async () => ({ ok: false, issues: ['Incomplete export coverage; select the missing prefix/segments.'] }) }; }) as never;
  fireEvent.click(screen.getByRole('button', { name: 'Check preflight' }));
  await settled();
  expect(JSON.parse(preflightBody)).toMatchObject({ copy_video: true, rows: [{ clip_id: 'root' }, { clip_id: 'c1' }] });
  expect(screen.getByRole('alert').textContent).toContain('Incomplete export coverage');
  expect((screen.getByRole('button', { name: 'Join now' }) as HTMLButtonElement).disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('running locks chain selection and Join; a rejected session read reports instead of offering an empty list', async () => {
  const { container } = mount(true);
  await settled();
  for (const button of container.querySelectorAll('[data-cont-join-chain]'))
    expect((button as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  vi.mocked(readH3Session).mockRejectedValueOnce(new Error('gone'));
  mount();
  await settled();
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(container.querySelectorAll('[data-cont-join-chain]')).toHaveLength(0);
});

test('files mode: pick copies into Input, trims and order ride preflight rows and the h3-join files intent', async () => {
  mount();
  await settled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'files' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add video…' }));
  await settled();
  expect(uploadVideoPostSource).toHaveBeenCalledWith('http://127.0.0.1:7801', '11111111-2222-3333-4444-555555555555');
  vi.mocked(inspectVideoPost).mockResolvedValueOnce({ sourceId: '66666666-7777-8888-9999-000000000000', name: 'take b', blockers: [], durationSeconds: 30 } as never);
  vi.mocked(uploadVideoPostSource).mockResolvedValueOnce('take_b.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Add video…' }));
  await settled();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'take a: End (s)' }), { target: { value: '10' } });
  let preflightBody = '';
  globalThis.fetch = vi.fn(async (_u: unknown, init: { body: string }) => { preflightBody = init.body; return { json: async () => ({ ok: true, issues: [], seconds: 27.5, mode: 're-encode' }) }; }) as never;
  fireEvent.click(screen.getByRole('button', { name: 'Check preflight' }));
  await settled();
  expect(JSON.parse(preflightBody)).toMatchObject({ rows: [
    { kind: 'media', filename: 'take_a.mp4', trim_start: 0, trim_end: 10 },
    { kind: 'media', filename: 'take_b.mp4', trim_start: 0, trim_end: null },
  ] });
  fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
  await settled();
  expect(runWorkbenchJob).toHaveBeenCalledWith('http://127.0.0.1:7801',
    { recipeId: 'h3-join', version: 1, h3: { join: { kind: 'files', files: [{ filename: 'take_a.mp4', trimEnd: 10 }, { filename: 'take_b.mp4' }] } } }, 4);
});

test('files mode: a blocked pick reports without adding a row', async () => {
  mount();
  await settled();
  vi.mocked(inspectVideoPost).mockResolvedValueOnce({ sourceId: '11111111-2222-3333-4444-555555555555', name: 'broken', blockers: ['no-decodable-video'], durationSeconds: null } as never);
  fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'files' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add video…' }));
  await settled();
  expect(uploadVideoPostSource).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('blocking issues');
});
