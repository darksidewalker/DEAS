import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useState } from 'react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ProjectBar } from './ProjectBar';
import type { ImageDraft, ProjectSnapshot } from '../../lib/projects';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const closeEvents=vi.hoisted(()=>({listen:vi.fn(),unlisten:vi.fn(),handler:null as null|((event:{preventDefault:()=>void})=>void)}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:closeEvents.listen})}));

test('window close is prevented for unsaved and in-flight project writes, then allowed after saving',async()=>{
 vi.useFakeTimers();const pending=deferred<ProjectSnapshot>();
 vi.mocked(invoke).mockImplementation(async command=>command==='native_project_open'?snapshot(2):command==='native_project_save'?pending.promise:undefined);
 render(<Harness/>);await click('Open project');edit('not yet saved');
 const event={preventDefault:vi.fn()};
 act(()=>closeEvents.handler?.(event));
 expect(event.preventDefault).toHaveBeenCalledOnce();
 expect(screen.getByText('Save the project or explicitly close without saving before closing this window.')).toBeTruthy();
 await tick();const writing={preventDefault:vi.fn()};act(()=>closeEvents.handler?.(writing));expect(writing.preventDefault).toHaveBeenCalledOnce();
 await act(async()=>pending.resolve(snapshot(3,{...draft,positivePrompt:'not yet saved'})));
 const saved={preventDefault:vi.fn()};act(()=>closeEvents.handler?.(saved));expect(saved.preventDefault).not.toHaveBeenCalled();
});

test('close listener registration failure is visible and reaches a fixed native diagnostic',async()=>{
 closeEvents.listen.mockRejectedValueOnce(new Error('SECRET transport internals'));
 vi.mocked(invoke).mockResolvedValue(snapshot());render(<Harness/>);await click('Open project');
 expect(screen.getByText('Window-close protection is unavailable. Wait for Saved and close the project before quitting.')).toBeTruthy();
 expect(invoke).toHaveBeenCalledWith('native_project_close_notice',{reason:'unavailable'});
 expect(document.body.textContent).not.toContain('SECRET');
});
test('window close is guarded during project creation and listener cleanup waits for a late registration',async()=>{
 const pending=deferred<ProjectSnapshot|null>();const registered=deferred<()=>void>();
 closeEvents.listen.mockImplementationOnce((handler:typeof closeEvents.handler)=>{closeEvents.handler=handler;return registered.promise;});
 vi.mocked(invoke).mockImplementation(async command=>command==='native_project_create'?pending.promise:undefined);
 const {unmount}=render(<Harness/>);await click('New project');
 const event={preventDefault:vi.fn()};act(()=>closeEvents.handler?.(event));expect(event.preventDefault).toHaveBeenCalledOnce();
 unmount();await act(async()=>registered.resolve(closeEvents.unlisten));
 expect(closeEvents.unlisten).toHaveBeenCalledOnce();
 await act(async()=>pending.resolve(null));
});

test('a close attempt with a failed save stays blocked until explicit discard releases the project',async()=>{
 vi.useFakeTimers();
 vi.mocked(invoke).mockImplementation(async command=>{
  if(command==='native_project_open')return snapshot();
  if(command==='native_project_save')throw new Error('write failed');
 });
 render(<Harness/>);await click('Open project');edit('failed edit');await tick();
 const event={preventDefault:vi.fn()};act(()=>closeEvents.handler?.(event));expect(event.preventDefault).toHaveBeenCalledOnce();
 await click('Close without saving');expect(closeEvents.unlisten).toHaveBeenCalledOnce();
 expect(restored).toHaveBeenLastCalledWith(null);
});

const draft: ImageDraft = { positivePrompt: 'current', negativePrompt: '', checkpoint: 'exact.safetensors', width: 1024, height: 1024, steps: 20, cfg: 7, sampler: 'euler', scheduler: 'normal', seed: 42, denoise: 1, pipeline: 't2i' };
const snapshot = (revision = 0, value = draft): ProjectSnapshot => ({ id: 'project-1', root: '/projects/映画', revision, draft: value, input: null });
const restored = vi.fn();
function Harness({ busy = false }: { busy?: boolean }) {
 const [value, setValue] = useState(draft);
 return <I18nProvider><input aria-label="prompt" value={value.positivePrompt} onChange={e => setValue({ ...value, positivePrompt: e.target.value })}/><ProjectBar draft={value} busy={busy} onRestore={project => { restored(project); if (project) setValue(project.draft); }}/></I18nProvider>;
}
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };
beforeEach(() => { vi.resetAllMocks(); closeEvents.handler=null;closeEvents.listen.mockImplementation(async(handler:typeof closeEvents.handler)=>{closeEvents.handler=handler;return closeEvents.unlisten;});vi.mocked(isTauri).mockReturnValue(true); localStorage.setItem('deas.locale.v1', 'en'); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const deferred = <T,>() => {
 let resolve!: (value: T) => void;
 let reject!: (reason: Error) => void;
 const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
 return { promise, resolve, reject };
};
const edit = (text: string) => fireEvent.change(screen.getByLabelText('prompt'), { target: { value: text } });
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(600); }); };

test('edits made during initial creation are saved next instead of overwritten by the captured draft', async () => {
 vi.useFakeTimers();
 const pending = deferred<ProjectSnapshot>();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(snapshot(2, { ...draft, positivePrompt: 'newer' }));
 render(<Harness/>); await click('New project'); edit('newer');
 await act(async () => pending.resolve(snapshot(1)));
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'newer');
 expect(restored).not.toHaveBeenCalled();
 await tick();
 expect(invoke).toHaveBeenLastCalledWith('native_project_save', { projectId: 'project-1', expectedRevision: 1, draft: { ...draft, positivePrompt: 'newer' } });
 expect(restored).toHaveBeenCalledExactlyOnceWith(snapshot(2, { ...draft, positivePrompt: 'newer' }));
});

test.each(['New project', 'Open project', 'Import PNG'])('%s cancellation keeps the active project and draft unchanged', async name => {
 vi.useFakeTimers();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(6)).mockResolvedValueOnce(null);
 render(<Harness/>); await click('Open project'); restored.mockClear();
 await click(name); await tick();
 expect(invoke).toHaveBeenCalledTimes(2);
 expect(restored).not.toHaveBeenCalled();
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'current');
 expect(screen.getByText('/projects/映画')).toBeTruthy();
 expect(screen.getByRole('status').textContent).toBe('Saved');
 expect(screen.queryByRole('alert')).toBeNull();
});

test.each(['New project', 'Open project', 'Import PNG', 'Close project'])('%s failure preserves current state without leaking raw errors or retrying', async name => {
 vi.useFakeTimers();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(6)).mockRejectedValueOnce(new Error('SECRET token=private'));
 render(<Harness/>); await click('Open project'); restored.mockClear();
 await click(name); await tick();
 expect(invoke).toHaveBeenCalledTimes(2);
 expect(restored).not.toHaveBeenCalled();
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'current');
 expect(screen.getByText('/projects/映画')).toBeTruthy();
 expect(screen.getByRole('status').textContent).not.toBe('Saved');
 expect(screen.getByRole('alert').textContent).toBe('Project operation failed. Your settings are unchanged.');
});

test.each(['busy', 'browser'])('%s disables all project actions and makes no implicit native calls', async reason => {
 if (reason === 'browser') vi.mocked(isTauri).mockReturnValue(false);
 render(<Harness busy={reason === 'busy'}/>);
 for (const name of ['New project', 'Open project', 'Close project', 'Import PNG']) {
  expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
  await click(name);
 }
 expect(invoke).not.toHaveBeenCalled(); expect(restored).not.toHaveBeenCalled();
});

test('busy cancels pending debounce, then saves once with the latest draft after generation ends', async () => {
 vi.useFakeTimers();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4, { ...draft, positivePrompt: 'latest' }));
 const { rerender } = render(<Harness/>); await click('Open project'); edit('pending');
 rerender(<Harness busy/>); edit('latest'); await tick();
 expect(invoke).toHaveBeenCalledTimes(1);
 for (const name of ['New project', 'Open project', 'Close project', 'Import PNG']) expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
 rerender(<Harness/>); await tick();
 expect(invoke).toHaveBeenNthCalledWith(2, 'native_project_save', { projectId: 'project-1', expectedRevision: 3, draft: { ...draft, positivePrompt: 'latest' } });
});

test('a failed dirty save can explicitly close without saving, then reopen disk without a hidden retry', async () => {
 vi.useFakeTimers();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(2)).mockRejectedValueOnce(new Error('durability uncertain')).mockResolvedValueOnce(undefined).mockResolvedValueOnce(snapshot(3, { ...draft, positivePrompt: 'disk version' }));
 render(<Harness/>); await click('Open project'); edit('unsaved local'); await tick();
 expect(screen.getByRole('button', { name: 'Close project' })).toHaveProperty('disabled', true);
 await click('Close without saving');
 expect(invoke).toHaveBeenNthCalledWith(3, 'native_project_close', { projectId: 'project-1' });
 expect(restored).toHaveBeenLastCalledWith(null);
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'unsaved local');
 await tick(); expect(invoke).toHaveBeenCalledTimes(3);
 await click('Open project'); await tick();
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'disk version');
 expect(screen.getByRole('status').textContent).toBe('Saved');
 expect(invoke).toHaveBeenCalledTimes(4);
});

test('draft equality ignores native JSON field order and still saves subsequent edits', async () => {
 vi.useFakeTimers();
 const reordered = Object.fromEntries(Object.entries(draft).reverse()) as unknown as ImageDraft;
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(4, reordered)).mockResolvedValueOnce(snapshot(5, { ...draft, positivePrompt: 'changed' }));
 const view = (value: ImageDraft) => <I18nProvider><ProjectBar draft={value} busy={false} onRestore={restored}/></I18nProvider>;
 const { rerender } = render(view(draft));
 await click('Open project');
 await tick();
 expect(screen.getByRole('status').textContent).toBe('Saved');
 rerender(view({ ...draft, positivePrompt: 'changed' })); await tick();
 expect(invoke).toHaveBeenNthCalledWith(2, 'native_project_save', { projectId: 'project-1', expectedRevision: 4, draft: { ...draft, positivePrompt: 'changed' } });
});

test.each(['Open project', 'New project', 'Import PNG', 'Close project'])('ignores an outstanding %s reply after unmount', async name => {
 const pending = deferred<ProjectSnapshot | null>();
 if (name === 'Import PNG' || name === 'Close project') vi.mocked(invoke).mockResolvedValueOnce(snapshot());
 vi.mocked(invoke).mockReturnValueOnce(pending.promise);
 const { unmount } = render(<Harness/>);
 if (name === 'Import PNG' || name === 'Close project') await click('Open project');
 restored.mockClear();
 fireEvent.click(screen.getByRole('button', { name }));
 const calls = vi.mocked(invoke).mock.calls.length;
 unmount();
 await act(async () => pending.resolve(snapshot(9)));
 expect(restored).not.toHaveBeenCalled();
 expect(invoke).toHaveBeenCalledTimes(calls);
});

test('locks every action during native operations and prevents duplicate clicks in the same event turn', async () => {
 const pending = deferred<ProjectSnapshot | null>();
 vi.mocked(invoke).mockReturnValueOnce(pending.promise);
 render(<Harness/>);
 act(() => {
  fireEvent.click(screen.getByRole('button', { name: 'Open project' }));
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
 });
 expect(invoke).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('status').textContent).toBe('Project operation in progress…');
 for (const name of ['New project', 'Open project', 'Close project', 'Import PNG']) expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
 await act(async () => pending.resolve(null));
 expect(screen.getByRole('button', { name: 'Open project' })).toHaveProperty('disabled', false);
});

test('open waits for parent hydration before autosave, including a delayed parent update', async () => {
 vi.useFakeTimers();
 const opened = snapshot(7, { ...draft, positivePrompt: 'on disk' });
 vi.mocked(invoke).mockResolvedValue(opened);
 const view = (value: ImageDraft) => <I18nProvider><ProjectBar draft={value} busy={false} onRestore={restored}/></I18nProvider>;
 const { rerender } = render(view(draft));
 await click('Open project');
 await tick(); expect(invoke).toHaveBeenCalledTimes(1);
 rerender(view({ ...opened.draft })); await tick();
 expect(invoke).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('status').textContent).toBe('Saved');
});

test('imports PNG with the current revision and restores only the native receipt', async () => {
 const imported: ProjectSnapshot = { ...snapshot(9, { ...draft, pipeline: 'i2i' }), input: { id: 'input-1', path: '/projects/映画/inputs/source.png', sha256: 'a'.repeat(64), width: 512, height: 768 } };
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(8)).mockResolvedValueOnce(imported);
 const { container } = render(<Harness/>);
 await click('Open project'); await click('Import PNG');
 expect(invoke).toHaveBeenNthCalledWith(2, 'native_project_import_image', { title: 'Import PNG', projectId: 'project-1', expectedRevision: 8 });
 expect(restored).toHaveBeenLastCalledWith(imported);
 expect(screen.getByRole('status').textContent).toBe('Saved');
 for (const action of ['new', 'open', 'close', 'import']) expect(container.querySelector(`[data-project-${action}]`)).toBeTruthy();
 expect(container.querySelector('[data-project-status]')).toBe(screen.getByRole('status'));
});

test.each(['autosave', 'initial'] as const)('%s failure retains ownership and form, requires explicit retry, and keeps revision unchanged', async kind => {
 vi.useFakeTimers();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(2)).mockRejectedValueOnce(new Error('SECRET credentials')).mockResolvedValueOnce(snapshot(3, { ...draft, positivePrompt: 'retained' }));
 render(<Harness/>);
 if (kind === 'initial') { edit('retained'); await click('New project'); }
 else { await click('Open project'); edit('retained'); await tick(); }
 expect(screen.getByRole('alert').textContent).not.toContain('SECRET');
 expect(screen.getByRole('status').textContent).not.toBe('Saved');
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'retained');
 expect(screen.getByText('/projects/映画')).toBeTruthy();
 await tick(); expect(invoke).toHaveBeenCalledTimes(2);
 await click('Retry save');
 expect(invoke).toHaveBeenLastCalledWith('native_project_save', { projectId: 'project-1', expectedRevision: 2, draft: { ...draft, positivePrompt: 'retained' } });
 expect(screen.getByRole('status').textContent).toBe('Saved');
 expect(screen.queryByRole('alert')).toBeNull();
 if (kind === 'initial') expect(restored).toHaveBeenLastCalledWith(snapshot(3, { ...draft, positivePrompt: 'retained' }));
 else expect(restored).toHaveBeenCalledTimes(1);
});

test('debounces edits, serializes revisions, and never restores an older save over newer edits', async () => {
 vi.useFakeTimers();
 const pending = deferred<ProjectSnapshot>();
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(3)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(snapshot(5, { ...draft, positivePrompt: 'latest' }));
 const { rerender } = render(<Harness/>);
 await click('Open project');
 await tick();
 expect(invoke).toHaveBeenCalledTimes(1);
 edit('first'); edit('second');
 expect(screen.getByRole('status').textContent).toBe('Unsaved changes');
 expect(screen.getByRole('button', { name: 'Open project' })).toHaveProperty('disabled', true);
 await tick();
 expect(invoke).toHaveBeenNthCalledWith(2, 'native_project_save', { projectId: 'project-1', expectedRevision: 3, draft: { ...draft, positivePrompt: 'second' } });
 expect(screen.getByRole('status').textContent).toBe('Saving…');
 edit('latest'); rerender(<Harness/>); await tick();
 expect(invoke).toHaveBeenCalledTimes(2);
 await act(async () => pending.resolve(snapshot(4, { ...draft, positivePrompt: 'second' })));
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'latest');
 await tick();
 expect(invoke).toHaveBeenNthCalledWith(3, 'native_project_save', { projectId: 'project-1', expectedRevision: 4, draft: { ...draft, positivePrompt: 'latest' } });
 expect(screen.getByRole('status').textContent).toBe('Saved');
 rerender(<Harness/>); await tick();
 expect(invoke).toHaveBeenCalledTimes(3);
 expect(restored).toHaveBeenCalledTimes(1);
});

test('open hydrates saved settings without writing the previous form, close preserves the form', async () => {
 const opened = snapshot(8, { ...draft, positivePrompt: 'saved prompt' });
 vi.mocked(invoke).mockResolvedValueOnce(opened).mockResolvedValueOnce(undefined);
 render(<Harness/>);
 await click('Open project');
 expect(invoke).toHaveBeenCalledExactlyOnceWith('native_project_open', { title: 'Open project' });
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'saved prompt');
 expect(restored).toHaveBeenCalledExactlyOnceWith(opened);
 await click('Close project');
 expect(invoke).toHaveBeenLastCalledWith('native_project_close', { projectId: 'project-1' });
 expect(restored).toHaveBeenLastCalledWith(null);
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'saved prompt');
});

test('new project durably saves the captured form before restoring, never the native defaults', async () => {
 vi.mocked(invoke).mockResolvedValueOnce(snapshot(0, { ...draft, positivePrompt: '' })).mockResolvedValueOnce(snapshot(1));
 render(<Harness/>);
 expect(invoke).not.toHaveBeenCalled();
 await click('New project');
 expect(invoke).toHaveBeenNthCalledWith(1, 'native_project_create', { title: 'New project' });
 expect(invoke).toHaveBeenNthCalledWith(2, 'native_project_save', { projectId: 'project-1', expectedRevision: 0, draft });
 expect(restored).toHaveBeenCalledExactlyOnceWith(snapshot(1));
 expect(screen.getByRole('status').textContent).toBe('Saved');
 expect(screen.getByLabelText('prompt')).toHaveProperty('value', 'current');
 expect(screen.getByText(/image settings and PNG input only; jobs\/results not restored/i)).toBeTruthy();
});
