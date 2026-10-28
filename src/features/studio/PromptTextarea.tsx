import { forwardRef, useEffect, useId, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { forgeError, tagSearch, type TagSuggestion } from '../../lib/forge';
import { usePromptTools } from '../../lib/promptTools';
import './promptTextarea.css';

export interface PromptTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { root?: string; target?: string }

function replacement(el: HTMLTextAreaElement, tag: string) {
  const start = Math.max(el.value.lastIndexOf(',', el.selectionStart - 1), el.value.lastIndexOf('\n', el.selectionStart - 1)) + 1;
  const tail = el.value.slice(el.selectionStart).search(/[,\n]/);
  const end = tail < 0 ? el.value.length : el.selectionStart + tail;
  const token = el.value.slice(start, end);
  const leading = token.match(/^\s*/)![0];
  const trailing = token.match(/\s*$/)![0];
  return { value: el.value.slice(0, start) + leading + tag + trailing + el.value.slice(end), caret: start + leading.length + tag.length };
}

export const PromptTextarea = forwardRef<HTMLTextAreaElement, PromptTextareaProps>(function PromptTextarea({ root, target, onChange, onSelect, onFocus, onBlur, onKeyDown, onCompositionStart, onCompositionEnd, ...props }, ref) {
  const tools = usePromptTools();
  const { t } = useI18n();
  const id = useId();
  const local = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const composing = useRef(false);
  const focused = useRef(false);
  const dismissed = useRef('');
  const [selection, setSelection] = useState('');
  const [hits, setHits] = useState<TagSuggestion[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState('');
  // Render-time scope also rejects promises resolved before effect cleanup runs.
  const scope = JSON.stringify([root, target, tools.autocomplete, tools.spellcheck, tools.language, props.disabled, props.readOnly, props.value, props.maxLength]);
  const latest = useRef(scope);
  latest.current = scope;
  const fingerprint = () => { const el = local.current; return el ? JSON.stringify([el.value, el.selectionStart, el.selectionEnd, focused.current, composing.current]) : ''; };
  const sync = () => {
    const next = fingerprint();
    if (next !== selection) { generation.current++; setHits([]); setError(''); setSelection(next); }
  };
  const close = () => { generation.current++; dismissed.current = fingerprint(); setHits([]); setError(''); };

  useEffect(() => {
    const request = ++generation.current;
    setHits([]); setError('');
    const el = local.current!;
    const mark = fingerprint();
    const valid = () => generation.current === request && latest.current === scope && fingerprint() === mark;
    if (!tools.autocomplete || !root || !target || props.disabled || props.readOnly || !focused.current || composing.current || el.selectionStart !== el.selectionEnd || dismissed.current === mark) return;
    const prefix = el.value.slice(0, el.selectionStart).split(/[,\n]/).pop()!.trim();
    if (prefix.length < 2) return;
    const timer = setTimeout(() => {
      if (!valid()) return;
      void tagSearch(root, target, prefix).then(result => {
        if (valid()) {
          setHits(result.filter(hit => props.maxLength === undefined || props.maxLength < 0 || replacement(el, hit.tag).value.length <= props.maxLength).slice(0, 8));
          setCursor(0);
        }
      }, e => { if (valid()) setError(forgeError(e)); });
    }, 150);
    return () => { generation.current++; clearTimeout(timer); };
  }, [selection, scope]);

  useEffect(() => {
    document.getElementById(`${id}-${cursor}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, hits, id]);

  const pick = (hit: TagSuggestion) => {
    const el = local.current!;
    const { value, caret } = replacement(el, hit.tag);
    if (props.maxLength !== undefined && props.maxLength >= 0 && value.length > props.maxLength) return;
    close();
    // Use the native input path so controlled and uncontrolled textarea callers behave alike.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    el.setSelectionRange(caret, caret);
    dismissed.current = fingerprint();
    sync();
  };

  return <div className="prompt-textarea">
    <textarea {...props} spellCheck={tools.spellcheck} lang={tools.language} ref={node => {
      local.current = node;
      if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
    }}
      aria-autocomplete={tools.autocomplete ? 'list' : undefined}
      aria-controls={hits.length ? id : undefined}
      aria-expanded={tools.autocomplete ? hits.length > 0 : undefined}
      aria-activedescendant={hits.length ? `${id}-${cursor}` : undefined}
      onChange={e => { sync(); onChange?.(e); }}
      onSelect={e => { sync(); onSelect?.(e); }}
      onFocus={e => { focused.current = true; sync(); onFocus?.(e); }}
      onBlur={e => { focused.current = false; sync(); onBlur?.(e); }}
      onCompositionStart={e => { composing.current = true; sync(); onCompositionStart?.(e); }}
      onCompositionEnd={e => { composing.current = false; sync(); onCompositionEnd?.(e); }}
      onKeyDown={e => {
        if (!composing.current && !e.nativeEvent.isComposing && hits.length) {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setCursor(i => (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length); return; }
          if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); pick(hits[cursor]); return; }
        }
        onKeyDown?.(e);
      }} />
    {hits.length > 0 && <ul id={id} className="prompt-suggestions" role="listbox" aria-label={t('forge.tags.search')}>
      {hits.map((hit, i) => <li id={`${id}-${i}`} key={`${hit.tag}-${i}`} role="option" aria-selected={cursor === i}
        onMouseDown={e => { e.preventDefault(); pick(hit); }}>
        <span>{hit.tag}</span><em>{hit.category} · {hit.count.toLocaleString()}</em>
      </li>)}
    </ul>}
    {error && <p className="error-message prompt-error" role="alert">{t(error)}</p>}
  </div>;
});
