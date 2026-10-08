export interface PluginManifest {
  id: string;
  name: string;
  parentId: string | null;
  description: string;
  kind: 'core' | 'feature' | 'plugin';
  requiredNodes: string[];
  nameKey?: string;
  descriptionKey?: string;
  suggests?: string[];
  includes?: string[];
}

/** Validate metadata only. Manifests never load or execute third-party code. */
export function validatePlugins(manifests: readonly PluginManifest[]): void {
  const byId = new Map<string, PluginManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new Error(`Duplicate plugin ID: ${manifest.id}`);
    byId.set(manifest.id, manifest);
  }
  const complete = new Set<string>();
  for (const manifest of manifests) {
    const path = new Set<string>();
    let current: PluginManifest | undefined = manifest;
    while (current && !complete.has(current.id)) {
      if (path.has(current.id)) throw new Error(`Plugin parent cycle at: ${current.id}`);
      path.add(current.id);
      if (current.parentId === null) break;
      const parent: PluginManifest | undefined = byId.get(current.parentId);
      if (!parent) throw new Error(`Missing parent ${current.parentId} for ${current.id}`);
      current = parent;
    }
    for (const id of path) complete.add(id);
  }
}

// Trusted, data-only metadata. name/description are resource references, not display fallbacks.
const manifest = (id: string, parentId: string | null, kind: PluginManifest['kind'], requiredNodes: string[], suggests: string[] = [], includes: string[] = []): PluginManifest => ({
 id, parentId, kind, requiredNodes, suggests, includes,
 name: `studio.plugin.${id}.name`, description: `studio.plugin.${id}.description`,
 nameKey: `studio.plugin.${id}.name`, descriptionKey: `studio.plugin.${id}.description`,
});
export const builtinPlugins: PluginManifest[] = [
 manifest('engine', null, 'core', []),
 manifest('director', 'engine', 'feature', ['MiniMaxH3Director','MiniMaxH3DirectorGuide'], [], ['forge','refmods','continuity','output']),
 manifest('forge', 'director', 'feature', ['MiniMaxH3Director']),
 manifest('refmods', 'director', 'feature', ['MiniMaxH3DirectorGuide']),
 manifest('continuity', 'director', 'feature', ['MiniMaxH3DirectorGuide']),
 manifest('output', 'director', 'feature', ['MiniMaxH3Director']),
 manifest('plugins', 'engine', 'core', []),
];
validatePlugins(builtinPlugins);
