import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { forgeError, forgeModels, writePrompt, type ForgeModels } from '../../lib/forge';
import { isString, usePref } from '../../lib/preferences';
import './forge.css';

/** The node pack's model list for one backend; read once per endpoint/root, on demand. */
export function useForgeModels(endpoint: string, root?: string) {
  const [list, setList] = useState<ForgeModels | null>(null);
  const [error, setError] = useState('');
  const [model, setModel] = usePref('forge.model', '', isString);
  const scope = useRef<{ active: boolean; loaded: boolean; pending: boolean } | null>(null);
  useEffect(() => {
    const current = { active: true, loaded: false, pending: false };
    scope.current = current;
    setList(null); setError('');
    return () => { current.active = false; };
  }, [endpoint, root]);
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
  return { list, error, load, usable, model: usable.some(m => m.id === model) ? model : usable[0]?.id ?? '', setModel };
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

/** Hammer in a prompt field: write or enhance that prompt in the selected model's dialect, review, then apply (undoable). */
export function ForgeButton({ endpoint, root, dialect, value, image, onApply, onWildcards }: { endpoint: string; root?: string; dialect?: string; value: string; /** Image-to-image/inpaint source, read by a vision model. */ image?: string; onApply: (text: string) => void; onWildcards?: () => void }) {
  const { t } = useI18n();
  const forge = useForgeModels(endpoint, root);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [brief, setBrief] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const [blind, setBlind] = useState(false);
  const disabled = !root || !dialect;
  useEffect(() => { if (open && !choosing) forge.load(); }, [open, choosing, endpoint, root]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => { if (!open) { setBrief(value); setResult(''); setError(''); setChoosing(!!onWildcards); } setOpen(!open); };
  const write = async () => {
    setBusy(true); setError(''); setResult(''); setBlind(false);
    try {
      const out = await writePrompt(endpoint, root!, { model: forge.model, write_for: dialect!, idea: brief, images: image ? [image] : [] });
      setResult(out.prompt); setBlind(!!image && !out.saw_images);
    }
    catch (e) { setError(forgeError(e)); }
    finally { setBusy(false); }
  };
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
      <ModelSelect forge={forge}/>
      <label className="forge-field"><span>{t('forge.brief')}</span><textarea data-forge-brief value={brief} maxLength={16384} onChange={e => setBrief(e.target.value)}/></label>
      <button type="button" className="action-button" data-forge-write disabled={busy || !forge.model || (!brief.trim() && !image)} onClick={() => void write()}>{t(busy ? 'forge.writing' : 'forge.write')}</button>
      {error && <p className="error-message" role="alert">{t(error)}</p>}
      {blind && <p className="forge-warning">{t('forge.blind')}</p>}
      {result && <>
        <label className="forge-field"><span>{t('forge.result')}</span><textarea data-forge-result value={result} onChange={e => setResult(e.target.value)}/></label>
        <button type="button" className="action-button" data-forge-apply onClick={() => { setUndo(value); onApply(result); setOpen(false); }}>{t('forge.apply')}</button>
      </>}
      </>}
    </div>}
  </div>;
}
