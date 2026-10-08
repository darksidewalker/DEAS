import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { builtinPlugins, validatePlugins, type PluginManifest } from '../src/lib/plugins.ts';

import { inspectBackend } from '../src/lib/comfy.ts';

const manifest = (id: string, parentId: string | null = null): PluginManifest => ({ id, parentId, name: id, description: '', kind: 'plugin', requiredNodes: [] });

test('trusted builtin hierarchy has director features and no invalid parents', () => {
  assert.doesNotThrow(() => validatePlugins(builtinPlugins));
  const parents = Object.fromEntries(builtinPlugins.map(p => [p.id, p.parentId]));
  assert.deepEqual(parents, { engine: null, director: 'engine', forge: 'director', refmods: 'director', continuity: 'director', output: 'director', plugins: 'engine' });
  assert.deepEqual(builtinPlugins.find(p => p.id === 'director')?.requiredNodes, ['MiniMaxH3Director', 'MiniMaxH3DirectorGuide']);
});

test('Director includes original feature IDs without recommending its own parts', () => {
  const director = builtinPlugins.find(p => p.id === 'director')!;
  assert.deepEqual(director.includes, ['forge', 'refmods', 'continuity', 'output']);
  assert.deepEqual(director.suggests, []);
  for (const id of director.includes!) {
    const part = builtinPlugins.find(p => p.id === id)!;
    assert.equal(part.parentId, 'director');
    assert.ok(part.requiredNodes.length > 0);
  }
});

test('registry rejects duplicate IDs, missing parents and cycles', () => {
  assert.throws(() => validatePlugins([manifest('x'), manifest('x')]), /duplicate/i);
  assert.throws(() => validatePlugins([manifest('x', 'missing')]), /parent/i);
  assert.throws(() => validatePlugins([manifest('x', 'y'), manifest('y', 'x')]), /cycle/i);
  assert.throws(() => validatePlugins([manifest('x', 'x')]), /cycle/i);
});

function mockFetch(t: TestContext, handler: typeof fetch) {
  t.mock.method(globalThis, 'fetch', handler);
}

test('browser inspection uses only GET and reports real node, device and feature metadata', async t => {
  const calls: string[] = [];
  mockFetch(t, async (input, options) => {
    calls.push(String(input));
    assert.equal(options?.method, 'GET');
    assert.equal(options?.credentials, 'omit');
    const data = String(input).endsWith('object_info') ? { MiniMaxH3Director: {}, Other: {} }
      : String(input).endsWith('system_stats') ? { devices: [{ name: 'GPU 0' }, { name: 'CPU' }] }
      : { preview_metadata: true, disabled: false, max_upload: 100, zero_limit: 0, unset: null };
    return Response.json(data);
  });
  assert.deepEqual(await inspectBackend(' http://localhost:8188/comfy/ '), {
    baseUrl: 'http://localhost:8188/comfy', nodeCount: 2,
    devices: ['GPU 0', 'CPU'], missingRequiredNodes: ['MiniMaxH3DirectorGuide'],
    capabilities: ['max_upload', 'preview_metadata', 'zero_limit'],
  });
  assert.deepEqual(calls.sort(), ['http://localhost:8188/comfy/features', 'http://localhost:8188/comfy/object_info', 'http://localhost:8188/comfy/system_stats']);
});

function goodResponse(input: RequestInfo | URL): Response {
  return Response.json(String(input).endsWith('object_info')
    ? { MiniMaxH3Director: {}, MiniMaxH3DirectorGuide: {} }
    : String(input).endsWith('system_stats') ? { devices: [] } : {});
}

test('older ComfyUI without features is supported only on feature 404', async t => {
  mockFetch(t, async input => String(input).endsWith('features') ? new Response(null, { status: 404 }) : goodResponse(input));
  const result = await inspectBackend('https://example.com/');
  assert.deepEqual(result.capabilities, []);
  assert.deepEqual(result.missingRequiredNodes, []);
});

test('invalid and credentialed URLs are rejected before any network request', async t => {
  mockFetch(t, async () => { assert.fail('must not fetch'); });
  for (const url of ['relative', 'file:///data', 'ftp://example.com', 'http://user:secret@example.com', 'http://example.com?token=secret', 'http://example.com/#route']) {
    await assert.rejects(inspectBackend(url), /URL|HTTP/i);
  }
});

test('feature errors other than 404 are not hidden', async t => {
  mockFetch(t, async input => String(input).endsWith('features') ? new Response(null, { status: 503 }) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /features.*503/i);
});

test('required endpoints cannot be missing', async t => {
  mockFetch(t, async input => String(input).endsWith('system_stats') ? new Response(null, { status: 404 }) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /system_stats.*404/i);
});

test('HTML and malformed metadata are reported as incompatible, not connected', async t => {
  for (const invalid of ['<!doctype html><title>Login</title>', '[]', 'null']) {
    mockFetch(t, async input => String(input).endsWith('object_info') ? new Response(invalid) : goodResponse(input));
    await assert.rejects(inspectBackend('http://localhost:8188'), /object_info.*JSON/i);
  }
  mockFetch(t, async input => String(input).endsWith('system_stats') ? Response.json({ server: 'Kestrel' }) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /system_stats.*devices/i);
  mockFetch(t, async input => String(input).endsWith('object_info') ? Response.json({ server: 'Kestrel' }) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /object_info.*node/i);
  mockFetch(t, async input => String(input).endsWith('system_stats') ? Response.json({ devices: [{ name: ' ' }] }) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /system_stats.*name/i);
});

test('HTTP redirects clearly identify a non-direct ComfyUI endpoint', async t => {
  mockFetch(t, async (input, options) => {
    assert.equal(options?.redirect, 'error');
    return String(input).endsWith('system_stats') ? new Response(null, { status: 302, headers: { Location: '/Error/404' } }) : goodResponse(input);
  });
  await assert.rejects(inspectBackend('http://127.0.0.1:7801'), /302.*direct ComfyUI/i);
});

test('browser network failure includes an actionable CORS remedy', async t => {
  mockFetch(t, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(inspectBackend('http://localhost:8188'), /CORS.*--enable-cors-header.*desktop/i);
});

test('oversized responses are rejected before allocation and while streaming', async t => {
  const { MAX_RESPONSE_BYTES } = await import('../src/lib/comfy.ts');
  mockFetch(t, async input => String(input).endsWith('object_info') ? new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /object_info.*limit/i);
  let cancelled = false;
  mockFetch(t, async input => String(input).endsWith('object_info') ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; },
  })) : goodResponse(input));
  await assert.rejects(inspectBackend('http://localhost:8188'), /object_info.*limit/i);
  assert.equal(cancelled, true);
});

test('requests time out and abort with an actionable error', async t => {
  const { INSPECTION_TIMEOUT_MS } = await import('../src/lib/comfy.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockFetch(t, async (_input, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const inspection = inspectBackend('http://localhost:8188');
  const rejected = assert.rejects(inspection, /timed out/i);
  t.mock.timers.tick(INSPECTION_TIMEOUT_MS);
  await rejected;
});

test('Tauri inspection delegates to Rust without browser fetch', async t => {
  const snapshot = { baseUrl: 'http://localhost:8188', nodeCount: 1, devices: ['CPU'], missingRequiredNodes: ['MiniMaxH3DirectorGuide'], capabilities: [] };
  const calls: unknown[] = [];
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: unknown) => { calls.push([command, args]); return snapshot; },
  } } });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  mockFetch(t, async () => { assert.fail('desktop must not fetch'); });
  assert.deepEqual(await inspectBackend('http://localhost:8188/'), snapshot);
  assert.deepEqual(calls, [['inspect_backend', { baseUrl: 'http://localhost:8188' }]]);
});
