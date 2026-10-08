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
  setLocale: (locale: string) => void;
  t: (key: string, params?: TranslationParams) => string;
  languages: Array<{ id: string; name: string }>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function defaultLocale(catalog: TranslationCatalog): string {
  return catalog.languages.find(({ id }) => id === 'de')?.id
    ?? catalog.languages.find(({ id }) => id === 'en')?.id
    ?? catalog.languages[0]?.id ?? 'en';
}

function initialLocale(catalog: TranslationCatalog): string {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (catalog.languages.some(({ id }) => id === stored)) return stored!;
  } catch {
    // Webviews, privacy settings and server rendering can deny storage access.
  }
  return defaultLocale(catalog);
}

/** Optional catalog injection accepts already validated data, not plugin code. */
export function I18nProvider({ children, catalog = bundledCatalog }: {
  children: ReactNode;
  catalog?: TranslationCatalog;
}) {
  const [selectedLocale, selectLocale] = useState(() => initialLocale(catalog));
  const locale = catalog.languages.some(({ id }) => id === selectedLocale)
    ? selectedLocale : defaultLocale(catalog);
  const setLocale = useCallback((id: string) => {
    if (catalog.languages.some((language) => language.id === id)) selectLocale(id);
  }, [catalog]);

  useEffect(() => {
    document.documentElement.lang = locale;
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch {
      // Selection remains functional without persistence.
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(catalog, locale, key, params),
    languages: catalog.languages.map(({ id, name }) => ({ id, name })),
  }), [catalog, locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
