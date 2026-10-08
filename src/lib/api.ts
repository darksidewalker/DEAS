export interface ApiNegotiation {
  baseUrl: string;
  protocol: 'classic' | 'v2';
  generationReady: false;
  capabilities: string[];
}

/** Native-owned read-only transport. Never infer a default/cloud endpoint. */
export async function negotiateApi(baseUrl: string): Promise<ApiNegotiation> {
  if (!baseUrl.trim()) throw new Error('An explicit backend endpoint is required.');
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('API negotiation requires the DEAS desktop app; browser preview does not perform this probe.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<ApiNegotiation>('native_negotiate_api', { baseUrl });
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error && 'code' in error) {
      const detail = error as { code: unknown; message: unknown; endpoint?: unknown };
      throw new Error(`${String(detail.code)} · ${String(detail.endpoint ?? '')}: ${String(detail.message)}`);
    }
    throw error;
  }
}
