import { useEffect, useRef, useState } from 'react';
import { bundledCatalog, useI18n } from '../../i18n/I18nProvider';
import { translate } from '../../lib/i18n';
import { matchEntries, revealTarget, searchIndex, type SearchEntry } from '../../lib/search';
import './search.css';

/** Magnifier entry for every tab: Ctrl+K opens it; a hit switches tab, reveals and flashes the control. */
export function GlobalSearch({ onNavigate }: { onNavigate: (entry: SearchEntry) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const english = (key: string) => translate(bundledCatalog, 'en', key);
  const results = matchEntries(searchIndex, query, (key) => `${t(key)} ${english(key)}`);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    input.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const choose = async (entry: SearchEntry) => {
    close();
    onNavigate(entry);
    // Studio and backend panes mount lazily after the tab switch; retry a few frames instead of guessing a delay.
    // A dock card exists only on its dock tab: select that tab first (the tab button is the user's own switch).
    const dock = () => entry.dockTab && document.querySelector<HTMLButtonElement>(`[data-dock-tab="${entry.dockTab}"]:not([aria-selected="true"])`)?.click();
    dock();
    let outcome = revealTarget(entry.target);
    for (let frame = 0; frame < 20 && outcome.state === 'missing'; frame++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      dock();
      outcome = revealTarget(entry.target);
    }
    // A disabled control keeps its own explanation; the entry reason is the fallback.
    setNotice(outcome.state === 'missing' ? t(entry.reason ?? 'search.notAvailable') : outcome.state === 'disabled' ? outcome.title ?? t(entry.reason ?? 'search.disabled') : '');
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((index) => Math.min(results.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter' && results[cursor]) {
      event.preventDefault();
      void choose(results[cursor]);
    }
  };
  return (
    <div className="global-search">
      <button
        ref={button}
        type="button"
        className="repo-button search-open"
        aria-label={t('search.title')}
        title={`${t('search.title')} · Ctrl+K`}
        aria-expanded={open}
        aria-controls="global-search-panel"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
          <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 10 L14.5 14.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div id="global-search-panel" className="search-panel" role="dialog" aria-label={t('search.title')}>
          <input
            ref={input}
            type="search"
            aria-label={t('search.title')}
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {results.length ? (
            <ul className="search-results" role="listbox" aria-label={t('search.results')}>
              {results.map((entry, index) => (
                <li key={`${entry.label}:${entry.target}`} role="option" aria-selected={index === cursor}>
                  <button type="button" onMouseEnter={() => setCursor(index)} onClick={() => void choose(entry)}>
                    <span className="search-crumb">{t(entry.tab)} › {t(entry.section)} › {t(entry.label)}</span>
                    {entry.reason && <small>{t(entry.reason)}</small>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="search-empty" role="status">{t('search.empty')}</p>
          )}
        </div>
      )}
      {notice && <p className="search-notice" role="status">{notice}</p>}
    </div>
  );
}
