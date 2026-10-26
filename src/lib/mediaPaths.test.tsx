import { expect, it } from 'vitest';
import { relativeMediaPath, relocatedJob } from './media';
import type { JobStatus } from './jobs';

it.each([
 ['/work/映画/input/', '/work/映画/input/sub/my image.png', 'sub/my image.png'],
 ['C:\\Work\\映画\\input\\', 'C:\\Work\\映画\\input\\sub\\my image.png', 'sub/my image.png'],
 ['C:/Work/input/', 'C:\\Work\\input\\sub\\a.png', 'sub/a.png'],
 ['\\\\server\\share\\input\\', '\\\\server\\share\\input\\a.png', 'a.png'],
 ['/', '/a.png', 'a.png'],
 ['C:\\', 'C:\\a.png', 'a.png'],
 ['/input', '/input-other/a.png', ''],
 ['C:\\input', 'C:\\input-other\\a.png', ''],
 ['/input', '/input', ''],
 ['/input', '/input/../outside.png', ''],
 ['/input', '/input/sub/./a.png', ''],
 ['/input', '/input/a\0.png', ''],
 ['/input', '/input/a\\b.png', ''],
 ['/input\\literal/', '/input\\literal/a.png', 'a.png'],
])('derives protocol-relative media names without confusing root boundaries (%s)', (root, path, expected) => {
 expect(relativeMediaPath(path, root)).toBe(expected);
});

it('repairs an output relocation with a trailing root separator without changing submitted intent', () => {
 const intent = { checkpoint: 'folder/model.safetensors' };
 const job = { outputs: [{filename:'a.png',subfolder:'raw\\nested',type:'output'}], intent } as unknown as JobStatus;
 const moved = relocatedJob(job, 'C:\\out\\', {oldPath:'C:\\out\\raw\\nested\\a.png',path:'C:\\out\\starred\\a.png'});
 expect(moved.outputs).toEqual([{filename:'a.png',subfolder:'starred',type:'output'}]);
 expect(moved.intent).toBe(intent);
 expect(relocatedJob(job, 'C:\\out\\', {oldPath:'C:\\out\\raw\\a.png',path:'C:\\outside\\a.png'})).toBe(job);
});
