import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import { readPref } from '../../lib/preferences';

type Pack = { id: string; name: string; lists: Record<string, number> };
type Prompts = { positive: string; negative: string };
const emptyPacks: Pack[] = [];
const legacyKey = 'studio.wildcardPacks';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useWildcardPacks(native: boolean, active: boolean, positive: string, negative: string, seed: number) {
  const [loaded, setPacks] = useState<Pack[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const packs = loaded ?? emptyPacks;
  const hasNames = [positive, negative].some(prompt => /__[^\n]+?__/.test(prompt));
  // Rust decides which groups are valid and preserves literal braces.
  const hasChoices = [positive, negative].some(prompt => prompt.includes('{') && prompt.includes('|') && prompt.includes('}'));
  const needsCatalog = native && (active || hasNames);
  const loading = needsCatalog && !loaded && !loadError;

  useEffect(() => {
    if (!needsCatalog || loaded || loadError) return;
    let cancelled = false;
    const legacy = readPref<unknown[]>(legacyKey, [], Array.isArray);
    void invoke<Pack[]>('native_wildcard_packs', { legacy }).then(
      next => {
        if (cancelled) return;
        setPacks(Array.isArray(next) ? next : []);
        if (legacy.length && Array.isArray(next)) {
          try { localStorage.removeItem(`deas.pref.${legacyKey}`); } catch { /* The native migration is idempotent. */ }
        }
      },
      error => { if (!cancelled) setLoadError(errorText(error)); },
    );
    return () => { cancelled = true; };
  }, [needsCatalog, loaded, loadError]);

  const draft = useMemo(() => native && !(hasNames && loading) && (hasChoices || (hasNames && packs.length > 0))
    ? { positive, negative, seed, packs }
    : null, [native, packs, hasNames, loading, hasChoices, positive, negative, seed]);
  const [resolved, setResolved] = useState<{ draft: NonNullable<typeof draft>; value?: Prompts; error?: string } | null>(null);

  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { positive, negative, seed } = draft;
      void invoke<Prompts>('native_expand_wildcard_packs', { positive, negative, seed }).then(
        value => { if (!cancelled) setResolved({ draft, value }); },
        error => { if (!cancelled) setResolved({ draft, error: errorText(error) }); },
      );
    }, 120);
    return () => { clearTimeout(timer); cancelled = true; };
  }, [draft]);

  async function update(task: () => Promise<Pack[] | null>) {
    setImporting(true);
    setImportError('');
    try {
      const next = await task();
      if (next) {
        setLoadError('');
        setPacks(next);
      }
    } catch (error) {
      setImportError(errorText(error));
    } finally {
      setImporting(false);
    }
  }

  const current = resolved?.draft === draft ? resolved : null;
  return {
    packs, loading, importing, importError: importError || loadError,
    importFolder: (title: string) => update(() => invoke<Pack[] | null>('native_import_wildcard_pack', { title })),
    removePack: (id: string) => update(() => invoke<Pack[]>('native_remove_wildcard_pack', { id })),
    preview: current?.value, error: current?.error || (hasNames ? loadError : ''),
    pending: (!!draft && !current) || (hasNames && loading),
  };
}

export type WildcardPacks = ReturnType<typeof useWildcardPacks>;
