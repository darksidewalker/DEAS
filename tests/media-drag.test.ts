import test from 'node:test';
import assert from 'node:assert/strict';
import { dragItem, draggedItem, MEDIA_DRAG, MEDIA_IMAGE_DRAG } from '../src/lib/media.ts';

test('media drags replace default image URI data so native GTK file-drop handling cannot claim them', () => {
  const data = new Map([['text/uri-list', 'asset://localhost/output/ref.png'], ['text/html', '<img src="asset://localhost/output/ref.png">']]);
  const transfer = {
    effectAllowed: 'uninitialized',
    clearData: () => data.clear(),
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer;
  const item = { name: 'ref.png', path: '/output/ref.png', src: 'asset://localhost/output/ref.png', media: 'image' as const };
  dragItem(transfer, item);
  assert.deepEqual([...data.keys()], [MEDIA_DRAG, MEDIA_IMAGE_DRAG]);
  assert.deepEqual(draggedItem(transfer), item);
  assert.equal(transfer.effectAllowed, 'copy');
});
