export interface BackendSnapshot {
  baseUrl: string;
  nodeCount: number;
  devices: string[];
  missingRequiredNodes: string[];
  capabilities: string[];
}

export const INSPECTION_TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUIRED_NODES = ['MiniMaxH3Director', 'MiniMaxH3DirectorGuide'];

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Enter an absolute ComfyUI HTTP or HTTPS URL, for example http://127.0.0.1:8188.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('ComfyUI URL must use HTTP or HTTPS without embedded credentials.');
  }
  if (url.search || url.hash) throw new Error('ComfyUI base URL must not contain a query or fragment.');
  return url.toString().replace(/\/+$/, '');
}

function object(value: unknown, endpoint: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ComfyUI ${endpoint} must return a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function getJson(baseUrl: string, endpoint: string, optional = false): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECTION_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/${endpoint}`, {
        method: 'GET', signal: controller.signal, credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(`Cannot reach ComfyUI ${endpoint}. Check the backend URL and connection; use a direct ComfyUI API URL, not a redirecting proxy or login page. In browser preview, enable ComfyUI CORS for this frontend origin (such as --enable-cors-header), or use the desktop app.`, { cause: error });
    }
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return {};
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ComfyUI ${endpoint} returned HTTP ${response.status}. Use a direct ComfyUI API URL, not a redirecting proxy or login page; check backend access settings.`);
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error(`ComfyUI ${endpoint} response exceeds the ${MAX_RESPONSE_BYTES}-byte limit.`);
    }
    if (!response.body) throw new Error(`ComfyUI ${endpoint} returned an empty response.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(`ComfyUI ${endpoint} response exceeds the ${MAX_RESPONSE_BYTES}-byte limit.`);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error(`ComfyUI ${endpoint} returned invalid JSON. Check that the URL points to ComfyUI, not a login page.`); }
    return object(value, endpoint);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`ComfyUI ${endpoint} timed out after ${INSPECTION_TIMEOUT_MS / 1000} seconds.`);
    throw error;
  } finally { clearTimeout(timer); }
}

/** Read-only inspection; importing this module never contacts or starts a backend. */
export async function inspectBackend(baseUrl: string): Promise<BackendSnapshot> {
  const normalized = normalizedBaseUrl(baseUrl);
  // Runtime-only import keeps ordinary browser previews on fetch, not desktop IPC.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<BackendSnapshot>('inspect_backend', { baseUrl: normalized });
  }
  const [nodes, stats, features] = await Promise.all([
    getJson(normalized, 'object_info'),
    getJson(normalized, 'system_stats'),
    getJson(normalized, 'features', true),
  ]);
  if (Object.values(nodes).some(node => !node || typeof node !== 'object' || Array.isArray(node))) {
    throw new Error('ComfyUI object_info contains malformed node definitions. Use a direct ComfyUI API URL.');
  }
  if (!Array.isArray(stats.devices)) throw new Error('ComfyUI system_stats must include a devices array.');
  const devices = stats.devices.map(device => {
    const entry = object(device, 'system_stats device');
    if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('ComfyUI system_stats device must include a nonempty name.');
    return entry.name;
  });
  return {
    baseUrl: normalized,
    nodeCount: Object.keys(nodes).length,
    devices,
    missingRequiredNodes: REQUIRED_NODES.filter(name => !Object.hasOwn(nodes, name)),
    capabilities: Object.entries(features).filter(([, value]) => value !== false && value !== null).map(([name]) => name).sort(),
  };
}
