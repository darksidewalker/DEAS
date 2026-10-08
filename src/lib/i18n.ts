export interface LanguageManifest {
  id: string;
  name: string;
  kind: 'language';
  version: 1;
}

export interface TranslationCatalog {
  languages: LanguageManifest[];
  dictionaries: Record<string, Record<string, string>>;
  diagnostics: string[];
}

export type TranslationParams = Record<string, string | number>;

const localePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const keyPattern = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Versioned JSON-only plugin contract: no script, entrypoint or executable fields. */
export function validateLanguageManifest(value: unknown): LanguageManifest {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'name', 'kind', 'version'].includes(key))
    || typeof value.id !== 'string' || !localePattern.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
    || /[\u0000-\u001f\u007f]/.test(value.name)
    || value.kind !== 'language' || value.version !== 1) {
    throw new Error('Invalid language manifest: expected id, name, kind=language and version=1 only');
  }
  return { id: value.id, name: value.name, kind: 'language', version: 1 };
}

/** Pure data resolver; deterministic source order, no browser or executable plugins. */
export function createCatalog(
  manifests: Record<string, unknown>,
  modules: Record<string, unknown>,
): TranslationCatalog {
  const languages: LanguageManifest[] = [];
  const diagnostics: string[] = [];
  const dictionaries: TranslationCatalog['dictionaries'] = Object.create(null);
  for (const [path, value] of Object.entries(manifests).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const manifest = validateLanguageManifest(value);
      if (languages.some(({ id }) => id === manifest.id)) {
        diagnostics.push(`Duplicate language ${manifest.id}: ${path}`);
        continue;
      }
      languages.push(manifest);
      dictionaries[manifest.id] = Object.create(null);
    } catch (error) {
      diagnostics.push(`${path}: ${error instanceof Error ? error.message : 'Invalid language manifest'}`);
    }
  }
  for (const [path, data] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const id = path.match(/\/locales\/([^/]+)\.json$/)?.[1];
    if (!id || !Object.hasOwn(dictionaries, id)) {
      diagnostics.push(`Unregistered locale: ${path}`);
      continue;
    }
    if (!isRecord(data)) {
      diagnostics.push(`Invalid translation dictionary: ${path}`);
      continue;
    }
    for (const [key, value] of Object.entries(data)) {
      if (!keyPattern.test(key) || key.split('.').some((part) => unsafeKeys.has(part)) || typeof value !== 'string') {
        diagnostics.push(`Invalid translation ${id}:${key}: ${path}`);
      } else if (Object.hasOwn(dictionaries[id], key)) {
        diagnostics.push(`Duplicate translation ${id}:${key}: ${path}`);
      } else {
        dictionaries[id][key] = value;
      }
    }
  }
  const allKeys = new Set(Object.values(dictionaries).flatMap((dictionary) => Object.keys(dictionary)));
  for (const { id } of languages) {
    for (const key of allKeys) {
      if (!Object.hasOwn(dictionaries[id], key)) diagnostics.push(`Missing translation ${id}:${key}`);
    }
  }
  return { languages, dictionaries, diagnostics };
}

/** Opt-in strict CI validation; runtime still renders with English/key fallback. */
export function assertCatalogValid(catalog: TranslationCatalog): void {
  if (catalog.diagnostics.length) throw new Error(`Invalid localization catalog:\n${catalog.diagnostics.join('\n')}`);
}

export function translate(
  catalog: TranslationCatalog,
  locale: string,
  key: string,
  params?: TranslationParams,
): string {
  const message = catalog.dictionaries[locale]?.[key] ?? catalog.dictionaries.en?.[key] ?? key;
  return message.replace(/\{([^{}]+)\}/g, (token, name: string) =>
    params && Object.hasOwn(params, name) ? String(params[name]) : token,
  );
}
