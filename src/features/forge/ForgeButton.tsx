import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WildcardRules } from '../../lib/wildcard';
import { useI18n } from '../../i18n/I18nProvider';
import { cancelForge, forgeError, forgeH3, forgeModels, readCast, writePrompt, type ForgeModels, type H3Reference } from '../../lib/forge';
import { isString, usePref } from '../../lib/preferences';
import './forge.css';

/** The node pack's model list for one backend; read once per endpoint/root/LLM setting, on demand. */
export function useForgeModels(endpoint: string, root?: string) {
  const [list, setList] = useState<ForgeModels | null>(null);
  const [error, setError] = useState('');
  const [model, setModel] = usePref('forge.model', '', isString);
  const [rev, setRev] = useState(0);
  const scope = useRef<{ active: boolean; loaded: boolean; pending: boolean } | null>(null);
  useEffect(() => {
    const bump = () => setRev(n => n + 1);
    window.addEventListener('deas:llm-changed', bump);
    return () => window.removeEventListener('deas:llm-changed', bump);
  }, []);
  useEffect(() => {
    const current = { active: true, loaded: false, pending: false };
    scope.current = current;
    setList(null); setError('');
    return () => { current.active = false; };
  }, [endpoint, root, rev]);
  const load = () => {
    const current = scope.current;
    if (!current?.active || current.loaded || current.pending || !root) return;
    current.pending = true;
    setError('');
    forgeModels(endpoint, root).then(result => {
      if (!current.active) return;
      current.pending = false; current.loaded = true;
      setList(result);
    }, e => {
      if (!current.active) return;
      current.pending = false;
      setError(forgeError(e));
    });
  };
  const usable = list?.models.filter(m => !m.disabled) ?? [];
  // A remembered model only counts while the backend still lists it.
  return { list, error, load, rev, usable, model: usable.some(m => m.id === model) ? model : usable[0]?.id ?? '', setModel };
}

export function ModelSelect({ forge }: { forge: ReturnType<typeof useForgeModels> }) {
  const { t } = useI18n();
  return <label className="forge-field"><span>{t('forge.model')}</span>
    <select data-forge-model value={forge.model} disabled={!forge.usable.length} onChange={e => forge.setModel(e.target.value)}>
      {forge.usable.length ? forge.usable.map(m => <option key={m.id} value={m.id}>{m.label}</option>) : <option value="">{t(forge.list ? 'forge.noModels' : 'forge.loading')}</option>}
    </select>
    {forge.list && Object.values(forge.list.errors).map(text => <small key={text} className="forge-warning">{text}</small>)}
    {forge.error && <span className="error-message" role="alert">{t(forge.error)} <button type="button" data-forge-retry onClick={forge.load}>{t('forge.retry')}</button></span>}
  </label>;
}

/** What the Director Forge must know about the run it writes for (MiniMax H3 video). */
export interface H3Context { mode: string; duration: number; canvas: { width: number; height: number }; references: H3Reference[]; /** Every reference is a labelled picture: the Director's picture-label writer applies. */ easy: boolean }
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isShots = (v: unknown): v is string | number => v === 'Auto' || isNumber(v);

/** Hammer in a prompt field: write or enhance that prompt in the selected model's dialect, review, then apply (undoable).
 * With `h3`, it is the Director's Prompt Forge for the current run: Shots, Detail, Creativity, Cancel and the last three drafts. */
export function ForgeButton({ endpoint, root, dialect, value, image, onApply, onWildcards, wildcard, h3 }: { endpoint: string; root?: string; dialect?: string; value: string; /** Image-to-image/inpaint source, read by a vision model. */ image?: string; onApply: (text: string) => void; onWildcards?: () => void; /** Active wildcard rules: the node resolves them and the picks join the idea. */ wildcard?: WildcardRules; h3?: H3Context }) {
  const { t } = useI18n();
  const forge = useForgeModels(endpoint, root);
  const [shots, setShots] = usePref<string | number>('forge.h3.shots', 'Auto', isShots);
  const [shotBriefs, setShotBriefs] = useState<string[]>([]);
  const [detail, setDetail] = usePref('forge.detail', 5, isNumber);
  const [creativity, setCreativity] = usePref('forge.creativity', 5, isNumber);
  const [see, setSee] = usePref('forge.h3.see', false, (v): v is boolean => typeof v === 'boolean');
  const request = useRef<{ id: string; cancelled: boolean } | null>(null);
  // A draft fits only the run it was written for: mode, duration, canvas, references and model (as the Director checks on Apply).
  const seeing = !!h3?.easy && see;
  // Cast & scene cards (labelled REF2VA pictures): one per Character number, place and style the labels name.
  const castKeys = h3?.easy ? [...new Set(h3.references.flatMap(r => r.easy_role?.startsWith('character-') ? [r.easy_role.slice(10)] : r.easy_role === 'place' || r.easy_role === 'style' ? [r.easy_role] : []))].sort((a, b) => (Number(a) || 99) - (Number(b) || 99)) : [];
  const [cards, setCards] = useState<Record<string, string>>({});
  const [reading, setReading] = useState('');
  const readRequest = useRef<object | null>(null);
  const readFit = JSON.stringify([endpoint, root, forge.model, h3?.mode, h3?.easy, h3?.references]);
  useEffect(() => {
    setReading('');
    return () => { readRequest.current = null; };
  }, [readFit]);
  const cast = Object.fromEntries(castKeys.flatMap(k => cards[k]?.trim() ? [[k, cards[k].trim().slice(0, 600)]] : []));
  const fit = h3 ? JSON.stringify([h3, forge.model, seeing, cast]) : '';
  const [drafts, setDrafts] = useState<{ text: string; fit: string }[]>([]);
  const [draftFit, setDraftFit] = useState('');
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [brief, setBrief] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const [blind, setBlind] = useState(false);
  const disabled = !root || !dialect;
  useEffect(() => { if (open && !choosing) forge.load(); }, [open, choosing, endpoint, root, forge.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => {
    if (!open) {
      setBrief(value); setResult(''); setError(''); setChoosing(!!onWildcards);
      // Same resolution the run gets for this reroll; auto-reroll runs pick again.
      if (wildcard) invoke<{ positive: string }>('native_wildcard_build', { baseUrl: endpoint, rules: wildcard }).then(r => setBrief(b => [b, r.positive].filter(s => s.trim()).join(', ')), e => setError(String(e)));
    }
    setOpen(!open);
  };
  const write = async () => {
    const current = request.current = { id: '', cancelled: false };
    setBusy(true); setError(''); setBlind(false);
    if (!h3) setResult(''); // a Director draft stays visible (and in history) while the next one is written or cancelled
    try {
      if (h3) {
        current.id = crypto.randomUUID();
        const count = typeof shots === 'number' ? shots : 0;
        const out = await forgeH3(endpoint, root!, { model: forge.model, mode: h3.mode, brief, duration: h3.duration, shots, shot_briefs: Array.from({ length: count }, (_, i) => shotBriefs[i] ?? ''), detail, creativity: forge.list?.creativity[creativity - 1] ?? '', references: h3.references, easy: h3.easy, see_pictures: seeing, ...(Object.keys(cast).length ? { cast } : {}), output_canvas: h3.canvas, request_id: current.id });
        if (request.current !== current || current.cancelled) return;
        setResult(out.simple_prompt); setDraftFit(fit); setDrafts(d => [{ text: out.simple_prompt, fit }, ...d].slice(0, 3));
      } else {
        const out = await writePrompt(endpoint, root!, { model: forge.model, write_for: dialect!, idea: brief, images: image ? [image] : [] });
        setResult(out.prompt); setBlind(!!image && !out.saw_images);
      }
    }
    catch (e) { if (request.current === current && !current.cancelled) setError(forgeError(e)); }
    finally { if (request.current === current) setBusy(false); }
  };
  const read = async (key: string) => {
    const current = readRequest.current = {};
    setReading(key); setError('');
    try {
      const count = typeof shots === 'number' ? shots : 0;
      const out = await readCast(endpoint, root!, { model: forge.model, mode: h3!.mode, ...(/^\d+$/.test(key) ? { character: Number(key) } : { subject: key as 'place' | 'style' }), references: h3!.references, brief, shots, shot_briefs: Array.from({ length: count }, (_, i) => shotBriefs[i] ?? ''), redo: !!cards[key]?.trim() });
      if (readRequest.current === current) setCards(c => ({ ...c, [key]: out.text }));
    } catch (e) { if (readRequest.current === current) setError(forgeError(e)); }
    finally { if (readRequest.current === current) { setReading(''); readRequest.current = null; } }
  };
  const cancel = () => { const current = request.current; if (!current) return; current.cancelled = true; setBusy(false); cancelForge(endpoint, root!, current.id).catch(e => { if (request.current === current) setError(forgeError(e)); }); };
  const stale = !!h3 && !!result && draftFit !== fit;
  const level = (key: string, v: number, set: (n: number) => void) => <label className="forge-field"><span>{t(key)} {v}</span><input type="range" min={1} max={10} value={v} onChange={e => set(Number(e.target.value))}/></label>;
  return <div className="forge-anchor">
    <button type="button" className="forge-hammer" data-forge-open aria-expanded={open} disabled={disabled && !onWildcards} aria-label={t('forge.button')} title={t(onWildcards ? 'wildcards.choose' : !root ? 'forge.noBackend' : !dialect ? 'forge.noDialect' : 'forge.button')} onClick={toggle}>
      {/* Lucide "hammer" (ISC). */}
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/></svg>
    </button>
    {undo !== null && !open && <button type="button" className="forge-undo" data-forge-undo onClick={() => { onApply(undo); setUndo(null); }}>{t('forge.undo')}</button>}
    {open && <div className="forge-pop" role="dialog" aria-label={t('forge.button')} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      {choosing ? <>
        <button type="button" disabled={disabled} title={disabled ? t(!root ? 'forge.noBackend' : 'forge.noDialect') : undefined} onClick={() => setChoosing(false)}>{t('wildcards.llm')}</button>
        <button type="button" onClick={() => { setOpen(false); onWildcards?.(); }}>{t('wildcards.title')}</button>
      </> : <>
      <p className="forge-dialect">{t('forge.target')}: <strong>{dialect}</strong>{image && <> · {t('forge.picture')}: <strong data-forge-picture>{image}</strong></>}</p>
      {h3 && <p className="forge-dialect" data-forge-run>{h3.mode} · {`${h3.duration} s`} · {`${h3.canvas.width}×${h3.canvas.height}`} · {t('forge.references', { count: String(h3.references.length) })}</p>}
      <ModelSelect forge={forge}/>
      {h3 && <>
        <div className="forge-row">{level('forge.detail', detail, setDetail)}{level('forge.creativity', creativity, setCreativity)}</div>
        <label className="forge-field"><span>{t('forge.shots')}</span><select data-forge-shots value={shots} onChange={e => setShots(e.target.value === 'Auto' ? 'Auto' : Number(e.target.value))}>{(forge.list?.shot_counts ?? ['Auto']).map(s => <option key={s} value={s}>{s === 'Auto' ? t('forge.shotsAuto') : s}</option>)}</select></label>
        {h3.easy && <label className="forge-check"><input type="checkbox" data-forge-see checked={see} onChange={e => setSee(e.target.checked)}/>{t('forge.see')}</label>}
        {castKeys.length > 0 && <fieldset className="forge-cast" data-forge-cast><legend>{t('forge.cast')}</legend>
          {castKeys.map(k => { const name = /^\d+$/.test(k) ? t('forge.role.character', { n: k }) : t(`forge.role.${k}`); return <label key={k} className="forge-field"><span>{name} <button type="button" data-forge-read={k} disabled={!!reading || busy || !forge.model} onClick={() => void read(k)}>{t(reading === k ? 'forge.reading' : cards[k]?.trim() ? 'forge.readAgain' : 'forge.read')}</button></span>
            <textarea rows={2} maxLength={600} aria-label={t('forge.cardOf', { name })} value={cards[k] ?? ''} onChange={e => setCards({ ...cards, [k]: e.target.value })}/></label>; })}
        </fieldset>}
        {typeof shots === 'number' && Array.from({ length: shots }, (_, i) => <label key={i} className="forge-field"><span>{t('forge.shot', { n: String(i + 1) })}</span><textarea data-forge-shot={i + 1} rows={2} maxLength={4000} value={shotBriefs[i] ?? ''} onChange={e => setShotBriefs(Object.assign([...shotBriefs], { [i]: e.target.value }))}/></label>)}
      </>}
      <label className="forge-field"><span>{t('forge.brief')}</span><textarea data-forge-brief value={brief} maxLength={16384} onChange={e => setBrief(e.target.value)}/></label>
      {busy && h3 ? <button type="button" className="action-button" data-forge-cancel onClick={cancel}>{t('forge.cancel')}</button>
        : <button type="button" className="action-button" data-forge-write disabled={busy || !forge.model || (!brief.trim() && !image && !(h3 && shotBriefs.some(s => s.trim())))} onClick={() => void write()}>{t(busy ? 'forge.writing' : result ? 'forge.regenerate' : 'forge.write')}</button>}
      {error && <p className="error-message" role="alert">{t(error)}</p>}
      {blind && <p className="forge-warning">{t('forge.blind')}</p>}
      {result && <>
        <label className="forge-field"><span>{t('forge.result')}</span><textarea data-forge-result value={result} onChange={e => setResult(e.target.value)}/></label>
        {stale && <p className="forge-warning" role="status">{t('forge.stale')}</p>}
        <button type="button" className="action-button" data-forge-apply disabled={stale} onClick={() => { setUndo(value); onApply(result); setOpen(false); }}>{t('forge.apply')}</button>
      </>}
      {drafts.length > 0 && <div className="forge-row" role="group" aria-label={t('forge.history')}>{drafts.map((d, i) => <button key={i} type="button" data-forge-draft={i + 1} title={d.text} aria-pressed={result === d.text && draftFit === d.fit} onClick={() => { setResult(d.text); setDraftFit(d.fit); }}>{t('forge.draft', { n: String(i + 1) })}{d.fit !== fit && ' ⚠'}</button>)}</div>}
      </>}
    </div>}
  </div>;
}
