import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('desktop CSP permits dock asset fetches, media blobs and owned backend video without opening arbitrary network access', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const directives = new Map<string, string[]>(config.app.security.csp.split(';').map((entry: string) => {
    const [name, ...sources] = entry.trim().split(/\s+/);
    return [name, sources];
  }));
  const connect = directives.get('connect-src')!;
  const media = directives.get('media-src')!;
  for (const source of ['asset:', 'http://asset.localhost']) assert.ok(connect.includes(source), source);
  for (const source of ['blob:', 'http://127.0.0.1:*']) assert.ok(media.includes(source), source);
  for (const sources of [connect, media]) {
    for (const broad of ['*', 'http:', 'https:']) assert.ok(!sources.includes(broad), broad);
  }
});
