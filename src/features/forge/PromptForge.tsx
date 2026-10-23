import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { H3, dialects as familyDialects, forgeError, forgeH3, nativeTarget, writePrompt, type H3Reference } from '../../lib/forge';
import { NativeForge } from './NativeForge';

/** MOSS has a native writer but no generation family yet. */
const dialects = [...new Set([...familyDialects, 'MOSS'])];
import { isString, oneOf, usePref } from '../../lib/preferences';
import type { MediaItem } from '../../lib/media';
import { MediaLibrary } from '../media/MediaLibrary';
import { ModelSelect, useForgeModels } from './ForgeButton';

const modes = ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'REF2VA'] as const;
/** Frame modes take exactly these keyframes (data/h3_forge.json mode_limits). */
const frames: Record<string, number> = { T2VA: 0, I2VA: 1, FL2VA: 2, L2VA: 1 };
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const roles = ['character-1', 'character-2', 'character-3', 'character-4', 'place', 'style', 'first-frame', 'last-frame'];
/** The Prompt Writer takes at most 8 pictures, REF2VA 9. */
const maxPictures = (target: string, mode: string) => target !== H3 ? 8 : mode === 'REF2VA' ? 9 : frames[mode];
interface Picture { path: string; src: string; role: string }

/** Standalone Prompt Forge: every dialect the families name, H3 with labelled references; the result goes to Generate. */
export function PromptForge({ endpoint, root, inputDir, onSend, active = true }: { active?: boolean; endpoint: string; root?: string; inputDir?: string; onSend: (positive: string, negative: string) => void }) {
  const { t } = useI18n();
  const forge = useForgeModels(endpoint, root, active);
  const [target, setTarget] = usePref('forge.target', dialects[0], oneOf(...dialects));
  const [mode, setMode] = usePref('forge.h3.mode', 'T2VA', oneOf(...modes));
  const [duration, setDuration] = usePref('forge.h3.duration', 5, isNumber);
  const [shots, setShots] = usePref<string | number>('forge.h3.shots', 'Auto', (v): v is string | number => v === 'Auto' || isNumber(v));
  const [detail, setDetail] = usePref('forge.detail', 5, isNumber);
  const [creativity, setCreativity] = usePref('forge.creativity', 5, isNumber);
  const [see, setSee] = useState(false);
  const [brief, setBrief] = usePref('forge.brief', '', isString);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [result, setResult] = useState('');
  const [negative, setNegative] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (active) forge.load(); }, [root, endpoint, forge.rev, active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const open = () => forge.load(); window.addEventListener('deas:forge-open', open); return () => window.removeEventListener('deas:forge-open', open); });
  const h3 = target === H3, limit = maxPictures(target, mode);
  const shown = pictures.slice(0, limit);
  // ComfyUI and the node pack read pictures from the input folder only.
  const add = (item: MediaItem) => {
    const path = item.media === 'image' && inputDir && item.path?.startsWith(inputDir + '/') ? item.path.slice(inputDir.length + 1) : '';
    if (path && shown.length < limit && !shown.some(p => p.path === path)) setPictures([...shown, { path, src: item.src, role: roles[Math.min(shown.length, 3)] }]);
  };
  const missing = h3 && mode !== 'REF2VA' && shown.length !== limit;
  const run = async () => {
    setBusy(true); setError(''); setWarnings([]); setBlind(false);
    try {
      if (h3) {
        const references: H3Reference[] = shown.map(p => mode === 'REF2VA' ? { kind: 'image', role: 'subject', path: p.path, easy_role: p.role } : { kind: 'image', role: 'keyframe', path: p.path });
        const out = await forgeH3(endpoint, root!, { model: forge.model, mode, brief, duration, shots, detail, creativity: forge.list?.creativity[creativity - 1] ?? '', references, easy: mode === 'REF2VA' && references.length > 0, see_pictures: see });
        setResult(out.simple_prompt); setWarnings(out.warnings);
      } else {
        const out = await writePrompt(endpoint, root!, { model: forge.model, write_for: target, idea: brief, detail, creativity, images: shown.map(p => p.path) });
        setResult(out.prompt); setBlind(shown.length > 0 && !out.saw_images);
      }
    } catch (e) { setError(forgeError(e)); }
    finally { setBusy(false); }
  };
  const level = (key: string, value: number, set: (v: number) => void) => <label className="forge-field"><span>{t(key)} {value}</span><input type="range" min={1} max={10} value={value} onChange={e => set(Number(e.target.value))}/></label>;
  const picker = <label className="forge-field"><span>{t('forge.target')}</span><select data-forge-target value={target} onChange={e => setTarget(e.target.value)}>{dialects.map(d => <option key={d} value={d}>{d}</option>)}</select></label>;
  const native = nativeTarget(target);
  if (native) return <section className="forge-tab" aria-label={t('studio.tab.forge')}><NativeForge root={root} target={native} forge={forge} onSend={onSend} header={picker} active={active}/></section>;
  return <section className="forge-tab" aria-label={t('studio.tab.forge')}>
    <div className="forge-controls">
      {picker}
      <ModelSelect forge={forge}/>
      {!root && <p className="field-help">{t('forge.noBackend')}</p>}
      {h3 && <div className="forge-row">
        <label className="forge-field"><span>{t('forge.mode')}</span><select data-forge-mode value={mode} onChange={e => setMode(e.target.value as typeof modes[number])}>{modes.map(m => <option key={m}>{m}</option>)}</select></label>
        <label className="forge-field"><span>{t('forge.duration')}</span><select value={duration} onChange={e => setDuration(Number(e.target.value))}>{(forge.list?.durations ?? [duration]).map(d => <option key={d} value={d}>{`${d} s`}</option>)}</select></label>
        <label className="forge-field"><span>{t('forge.shots')}</span><select value={shots} onChange={e => setShots(e.target.value === 'Auto' ? 'Auto' : Number(e.target.value))}>{(forge.list?.shot_counts ?? ['Auto']).map(s => <option key={s} value={s}>{s === 'Auto' ? t('forge.shotsAuto') : s}</option>)}</select></label>
      </div>}
      <div className="forge-row">{level('forge.detail', detail, setDetail)}{level('forge.creativity', creativity, setCreativity)}</div>
      <label className="forge-field"><span>{t('forge.brief')}</span><textarea data-forge-brief value={brief} maxLength={16384} onChange={e => setBrief(e.target.value)}/></label>
      {limit > 0 && <div className="forge-pictures">
        <p className="field-help">{t('forge.pictures', { count: shown.length, limit })}</p>
        <ul>{shown.map((p, i) => <li key={p.path}>
          <img src={p.src} alt={p.path}/>
          {h3 && mode === 'REF2VA' ? <select data-forge-role aria-label={p.path} value={p.role} onChange={e => setPictures(shown.map((q, j) => j === i ? { ...q, role: e.target.value } : q))}>{roles.map(r => <option key={r} value={r}>{t(`forge.role.${r.replace(/-\d$/, '')}`, { n: r.slice(-1) })}</option>)}</select>
            : <span>{h3 ? t(mode === 'I2VA' || (mode === 'FL2VA' && !i) ? 'forge.role.first-frame' : 'forge.role.last-frame') : p.path}</span>}
          <button type="button" aria-label={t('forge.remove')} onClick={() => setPictures(shown.filter((_, j) => j !== i))}>×</button>
        </li>)}</ul>
        {h3 && mode === 'REF2VA' && shown.length > 0 && <label className="forge-check"><input type="checkbox" checked={see} onChange={e => setSee(e.target.checked)}/>{t('forge.see')}</label>}
      </div>}
      <button type="button" className="action-button" data-forge-write disabled={busy || !root || !forge.model || (!brief.trim() && !shown.length) || missing} onClick={() => void run()}>{t(busy ? 'forge.writing' : 'forge.write')}</button>
      {missing && <p className="field-help">{t('forge.frames', { count: limit })}</p>}
      {error && <p className="error-message" role="alert">{t(error)}</p>}
    </div>
    <div className="forge-output">
      <label className="forge-field"><span>{t('forge.result')}</span><textarea data-forge-result value={result} onChange={e => setResult(e.target.value)}/></label>
      {blind && <p className="forge-warning">{t('forge.blind')}</p>}
      {warnings.map(w => <p key={w} className="forge-warning">{w}</p>)}
      <label className="forge-field"><span>{t('forge.negative')}</span><textarea data-forge-negative className="forge-negative" value={negative} onChange={e => setNegative(e.target.value)}/></label>
      <button type="button" className="action-button" data-forge-send disabled={!result.trim()} onClick={() => onSend(result, negative)}>{t('forge.send')}</button>
      {forge.model && limit > 0 && <div className="forge-media"><p className="field-help">{t('forge.pick')}</p><MediaLibrary selected={null} onSelect={add} roots={{ input: inputDir }}/></div>}
    </div>
  </section>;
}
