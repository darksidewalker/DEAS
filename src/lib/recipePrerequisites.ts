import type { RecipeAllowlist } from './execution';
export interface RecipePrerequisites {
  baseUrl: string;
  recipeId: 'checkpoint-text-to-image-diagnostic';
  version: 1;
  allowlist: RecipeAllowlist;
  missingNodes: string[];
  generationReady: false;
}
/** Native core object_info discovery; separate from optional v2 proxy negotiation. */
export async function checkRecipePrerequisites(baseUrl: string): Promise<RecipePrerequisites> {
  if (!baseUrl.trim()) throw new Error('An explicit backend endpoint is required.');
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Recipe prerequisite checks require the DEAS desktop app; browser preview does not probe.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<RecipePrerequisites>('native_recipe_prerequisites', { baseUrl });
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error && 'code' in error) {
      const detail = error as { code: unknown; message: unknown; endpoint?: unknown };
      throw new Error(`${String(detail.code)} · ${String(detail.endpoint ?? '')}: ${String(detail.message)}`);
    }
    throw error;
  }
}
