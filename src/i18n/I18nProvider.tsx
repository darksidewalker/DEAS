import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createCatalog, translate } from '../lib/i18n';
import type { TranslationCatalog, TranslationParams } from '../lib/i18n';

export const LOCALE_STORAGE_KEY = 'deas.locale.v1';

// Bundled JSON discovery is intentionally separate from the pure Node-testable resolver.
// Adding a language is a manifest plus component-owned dictionaries, never executable code.
export const bundledCatalog = createCatalog(
  import.meta.glob('/src/languages/*/manifest.json', { eager: true, import: 'default' }),
  import.meta.glob('/src/**/locales/*.json', { eager: true, import: 'default' }),
);

if (import.meta.env.DEV && bundledCatalog.diagnostics.length) {
  console.warn('Localization diagnostics:', bundledCatalog.diagnostics);
}

interface I18nContextValue {
  locale: string;
  /** Explicit user choice; persisted and shown as custom. */
  setLocale: (locale: string) => void;
  /** True while an explicit choice overrides the detected system language. */
  custom: boolean;
  /** The bundled language matching the system, used whenever there is no custom choice. */
  systemLocale: string;
  /** Drops the custom choice and follows the system language again. */
  followSystemLocale: () => void;
  t: (key: string, params?: TranslationParams) => string;
  languages: Array<{ id: string; name: string }>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** First system language (e.g. `de-DE` → `de`) that is bundled; English when none matches. */
function systemLocale(catalog: TranslationCatalog): string {
  const has = (id: string) => catalog.languages.some((language) => language.id === id);
  const wanted = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of wanted) {
    const base = tag?.toLowerCase().split(/[-_]/)[0];
    if (base && has(base)) return base;
  }
  return has('en') ? 'en' : catalog.languages[0]?.id ?? 'en';
}

/** Only an explicit choice is stored; a missing or invalid entry means "follow the system". */
function storedLocale(catalog: TranslationCatalog): string | null {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (catalog.languages.some(({ id }) => id === stored)) return stored;
    if (stored !== null) window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // Webviews, privacy settings and server rendering can deny storage access.
  }
  return null;
}

/** Optional catalog injection accepts already validated data, not plugin code. */
export function I18nProvider({ children, catalog = bundledCatalog }: {
  children: ReactNode;
  catalog?: TranslationCatalog;
}) {
  const system = useMemo(() => systemLocale(catalog), [catalog]);
  const [choice, setChoice] = useState(() => storedLocale(catalog));
  const custom = choice !== null && catalog.languages.some(({ id }) => id === choice);
  const locale = custom ? choice! : system;
  const setLocale = useCallback((id: string) => {
    if (!catalog.languages.some((language) => language.id === id)) return;
    setChoice(id);
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, id); } catch {
      // Selection remains functional without persistence.
    }
  }, [catalog]);
  const followSystemLocale = useCallback(() => {
    setChoice(null);
    try { window.localStorage.removeItem(LOCALE_STORAGE_KEY); } catch {
      // Nothing persisted to remove.
    }
  }, []);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    custom,
    systemLocale: system,
    followSystemLocale,
    t: (key, params) => translate(catalog, locale, key, params),
    languages: catalog.languages.map(({ id, name }) => ({ id, name })),
  }), [catalog, locale, setLocale, custom, system, followSystemLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
