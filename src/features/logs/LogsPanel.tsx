import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import './logs.css';

export type LogSource = 'deas' | 'comfyui' | 'cli';
export type LogLevel = 'error' | 'warning' | 'info' | 'debug';
export interface LogEntry { seq: number; time: number; source: LogSource; text: string }
const sources: LogSource[] = ['deas', 'comfyui', 'cli'];
const levels: LogLevel[] = ['error', 'warning', 'info', 'debug'];
// Same cap as the native store; the view mirrors it so a long session cannot grow the webview.
const MAX_BYTES = 10 * 1024 * 1024;
// shortcut: render only the newest matches to keep the DOM small; Copy/Export always use every match.
const SHOWN = 2000;

/** Level from the text itself: Python logging tags, tracebacks and uv/git/pip `error:`/`warning:` prefixes. */
export function levelOf(text: string): LogLevel {
  if (/\[(ERROR|CRITICAL)\]|\b(ERROR|CRITICAL|FATAL)\b|Traceback \(most recent call last\)|^\s*\w*(Error|Exception)\b:|^error\b/i.test(text)) return 'error';
  if (/\[WARNING\]|\bWARN(ING)?\b|\w*Warning\b:|^warning\b/i.test(text)) return 'warning';
  if (/\[DEBUG\]|\bDEBUG\b/.test(text)) return 'debug';
  return 'info';
}
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const formatLog = (e: LogEntry) => `${stamp(e.time)} [${e.source}] [${levelOf(e.text)}] ${e.text}`;

/** All recent DEAS, ComfyUI and installer CLI output, read incrementally from the native log store. */
export function LogsPanel() {
  const { t } = useI18n();
  const native = isTauri();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [shownSources, setShownSources] = useState<LogSource[]>(sources);
  const [shownLevels, setShownLevels] = useState<LogLevel[]>(levels);
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  const view = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!native) return;
    let alive = true, timer = 0, after = 0;
    const poll = async () => {
      try {
        const next = await invoke<LogEntry[]>('native_logs', { after });
        if (alive && next.length) {
          after = next[next.length - 1].seq;
          setEntries(old => {
            const all = old.concat(next);
            let bytes = all.reduce((n, e) => n + e.text.length, 0), drop = 0;
            while (bytes > MAX_BYTES && drop < all.length) bytes -= all[drop++].text.length;
            return drop ? all.slice(drop) : all;
          });
        }
      } catch (e) { if (alive) setNote(t('logs.error', { error: String(e) })); }
      if (alive) timer = window.setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [native, t]);
  const query = search.trim().toLowerCase();
  const matches = useMemo(() => entries.filter(e => shownSources.includes(e.source) && shownLevels.includes(levelOf(e.text)) && (!query || e.text.toLowerCase().includes(query))), [entries, shownSources, shownLevels, query]);
  const visible = matches.slice(-SHOWN);
  // Follow new output only while the user is already at the bottom.
  const stick = useRef(true);
  useEffect(() => { const el = view.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [visible.length, entries]);
  const text = () => matches.map(formatLog).join('\n');
  const toggle = <T,>(list: T[], value: T) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  const copy = async () => {
    try { await navigator.clipboard.writeText(text()); setNote(t('logs.copied', { count: matches.length })); }
    catch (e) { setNote(t('logs.error', { error: String(e) })); }
  };
  const exportText = async () => {
    try {
      if (native) { if (await invoke<boolean>('native_logs_export', { title: t('logs.exportTitle'), text: text() })) setNote(t('logs.exported')); return; }
      const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }));
      const a = document.createElement('a'); a.href = url; a.download = 'deas-logs.txt'; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setNote(t('logs.error', { error: String(e) })); }
  };
  return <section className="aio-detail logs-panel" aria-label={t('logs.title')}>
    <div className="logs-toolbar">
      <div className="logs-chips" role="group" aria-label={t('logs.sources')}>{sources.map(s => <button key={s} type="button" className="logs-chip" aria-pressed={shownSources.includes(s)} onClick={() => setShownSources(v => toggle(v, s))}>{t(`logs.source.${s}`)}</button>)}</div>
      <div className="logs-chips" role="group" aria-label={t('logs.levels')}>{levels.map(l => <button key={l} type="button" className={`logs-chip log-${l}`} aria-pressed={shownLevels.includes(l)} onClick={() => setShownLevels(v => toggle(v, l))}>{t(`logs.level.${l}`)}</button>)}</div>
      <input type="search" className="logs-search" aria-label={t('logs.search')} placeholder={t('logs.search')} value={search} onChange={e => setSearch(e.target.value)} />
      <button type="button" className="logs-chip logs-action" disabled={!matches.length} onClick={() => void copy()}>{t('logs.copy')}</button>
      <button type="button" className="logs-chip logs-action" disabled={!matches.length} onClick={() => void exportText()}>{t('logs.export')}</button>
    </div>
    <p className="aio-help logs-count" role="status">{!native ? t('logs.browser') : matches.length > SHOWN ? t('logs.limited', { shown: SHOWN, count: matches.length }) : t('logs.count', { shown: matches.length, total: entries.length })}{note && ` · ${note}`}</p>
    <pre ref={view} className="logs-view" tabIndex={0} aria-label={t('logs.lines')} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {visible.length ? visible.map(e => <span key={e.seq} className={`log-line log-${levelOf(e.text)}`}>{formatLog(e)}{'\n'}</span>) : <span className="log-line">{t('logs.empty')}</span>}
    </pre>
  </section>;
}
