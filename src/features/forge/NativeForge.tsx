import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { forgeError, nativeForgeTargets, nativeForgeWrite, nativeModelId, type NativeResult, type NativeTargets } from '../../lib/forge';
import { isString, usePref } from '../../lib/preferences';
import { ModelSelect, type useForgeModels } from './ForgeButton';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * The Prompt Forge editor for the image models: PromptForge's own pipeline run natively — character canon from the local
 * tables, the tag-search and guidance tools, then the mechanical clean-up — with its controls. The result goes to Generate.
 */
export function NativeForge({ root, target, forge, onSend, header, active = true }: { root?: string; target: string; forge: ReturnType<typeof useForgeModels>; onSend: (positive: string, negative: string) => void; /** The Write-for picker, shown first. */ header?: ReactNode; /** A retained, hidden tab reads nothing. */ active?: boolean }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<NativeTargets | null>(null);
  const [loadError, setLoadError] = useState('');
  const [detail, setDetail] = usePref('forge.detail', 5, isNumber);
  const [creativity, setCreativity] = usePref('forge.creativity', 5, isNumber);
  const [brief, setBrief] = usePref('forge.brief', '', isString);
  const [mode, setMode] = usePref(`forge.native.${target}.mode`, '', isString);
  const [quality, setQuality] = usePref(`forge.native.${target}.quality`, 'none', isString);
  const [style, setStyle] = usePref(`forge.native.${target}.style`, 'None', isString);
  const [aspect, setAspect] = usePref(`forge.native.${target}.aspect`, 'N/A', isString);
  const [withNegative, setWithNegative] = usePref('forge.native.negative', true, isBool);
  const [withNotes, setWithNotes] = usePref('forge.native.notes', false, isBool);
  const [keepPositive, setKeepPositive] = useState('');
  const [keepNegative, setKeepNegative] = useState('');
  const [result, setResult] = useState<NativeResult | null>(null);
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Read once the model list is ready, i.e. after the shared LLM readiness check passed.
  const ready = active && !!root && !!forge.model;
  useEffect(() => {
    if (!ready || targets) return;
    let alive = true;
    nativeForgeTargets(root!).then(v => { if (alive) setTargets(v); }, e => { if (alive) setLoadError(forgeError(e)); });
    return () => { alive = false; };
  }, [ready, root]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTargets(null); setLoadError(''); }, [root]);
  // A result belongs to the target it was written for.
  useEffect(() => { setResult(null); setPrompt(''); setNegative(''); setError(''); }, [target]);

  const spec = targets?.targets.find(x => x.key === target);
  const modes = spec?.modes ?? [];
  const activeMode = modes.includes(mode) ? mode : spec?.defaultMode ?? modes[0] ?? '';
  const optional = spec?.optional ?? [];
  const negativeLabel = optional.find(l => /negative/i.test(l));
  const notesLabels = optional.filter(l => !/negative/i.test(l));
  const segmentsOn = [...(withNegative && negativeLabel ? [negativeLabel] : []), ...(withNotes ? notesLabels : [])];

  const run = async () => {
    if (!root || !forge.model) return;
    setBusy(true); setError('');
    try {
      const out = await nativeForgeWrite(root, {
        target, brief, model: nativeModelId(forge.model), mode: activeMode || undefined, segmentsOn,
        controls: {
          detail, creativity,
          qualityPreset: quality, style, aspectRatio: aspect,
          positive: keepPositive.trim() || undefined, negative: keepNegative.trim() || undefined,
        },
      });
      setResult(out); setPrompt(out.prompt); setNegative(out.negative ?? '');
    } catch (e) { setError(forgeError(e)); }
    finally { setBusy(false); }
  };

  const level = (key: string, value: number, set: (v: number) => void, names?: string[]) =>
    <label className="forge-field"><span>{t(key)} {value}{names?.[value - 1] ? ` · ${names[value - 1]}` : ''}</span><input type="range" min={1} max={10} value={value} onChange={e => set(Number(e.target.value))}/></label>;
  const select = (key: string, value: string, set: (v: string) => void, options: string[], none?: [string, string]) =>
    <label className="forge-field"><span>{t(key)}</span><select value={value} onChange={e => set(e.target.value)}>
      {none && <option value={none[0]}>{t(none[1])}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select></label>;
  const meta = result?.segments.filter(s => s.label !== 'Negative prompt' && s.body !== result.prompt) ?? [];

  return <>
    <div className="forge-controls" data-forge-native={target}>
      {header}
      <ModelSelect forge={forge}/>
      {!root && <p className="field-help">{t('forge.noBackend')}</p>}
      {loadError && <p className="error-message" role="alert">{t('forge.native.noData')} {loadError}</p>}
      {modes.length > 0 && select('forge.mode', activeMode, setMode, modes)}
      <div className="forge-row">{level('forge.detail', detail, setDetail)}{level('forge.creativity', creativity, setCreativity, targets?.creativity)}</div>
      <div className="forge-row">
        {spec && spec.qualityPresets.length > 0 && select('forge.quality', quality, setQuality, spec.qualityPresets.filter(p => p !== 'none'), ['none', 'forge.none'])}
        {spec && spec.styles.length > 0 && select('forge.style', style, setStyle, spec.styles, ['None', 'forge.none'])}
        {spec?.aspectRatios && select('forge.aspect', aspect, setAspect, spec.aspectRatios.filter(a => a !== 'N/A'), ['N/A', 'forge.aspectNone'])}
      </div>
      <div className="forge-row">
        {negativeLabel && <label className="forge-check"><input type="checkbox" data-forge-with-negative checked={withNegative} onChange={e => setWithNegative(e.target.checked)}/>{t('forge.withNegative')}</label>}
        {notesLabels.length > 0 && <label className="forge-check"><input type="checkbox" data-forge-with-notes checked={withNotes} onChange={e => setWithNotes(e.target.checked)}/>{t('forge.withNotes')}</label>}
      </div>
      <label className="forge-field"><span>{t('forge.brief')}</span><textarea data-forge-brief value={brief} maxLength={16384} onChange={e => setBrief(e.target.value)}/></label>
      <label className="forge-field"><span>{t('forge.keepPositive')}</span><input type="text" data-forge-keep-positive value={keepPositive} maxLength={2000} onChange={e => setKeepPositive(e.target.value)}/></label>
      {spec?.hasNegative && <label className="forge-field"><span>{t('forge.keepNegative')}</span><input type="text" data-forge-keep-negative value={keepNegative} maxLength={2000} onChange={e => setKeepNegative(e.target.value)}/></label>}
      <button type="button" className="action-button" data-forge-write disabled={busy || !forge.model || !brief.trim()} onClick={() => void run()}>{t(busy ? 'forge.writing' : result ? 'forge.regenerate' : 'forge.write')}</button>
      {error && <p className="error-message" role="alert">{t(error)}</p>}
    </div>
    <div className="forge-output">
      <label className="forge-field"><span>{t('forge.result')}</span><textarea data-forge-result value={prompt} onChange={e => setPrompt(e.target.value)}/></label>
      {spec?.hasNegative && <label className="forge-field"><span>{t('forge.negative')}</span><textarea data-forge-negative className="forge-negative" value={negative} onChange={e => setNegative(e.target.value)}/></label>}
      <div className="forge-row">
        <button type="button" className="action-button" data-forge-send disabled={!prompt.trim()} onClick={() => onSend(prompt, '')}>{t('forge.sendPrompt')}</button>
        {spec?.hasNegative && <button type="button" className="action-button" data-forge-send-both disabled={!prompt.trim() || !negative.trim()} onClick={() => onSend(prompt, negative)}>{t('forge.sendBoth')}</button>}
      </div>
      {result && <div className="forge-report" data-forge-report>
        {result.characters.length > 0 && <p className="field-help">{t('forge.canon', { list: result.characters.join(', ') })}</p>}
        {result.tools.length > 0 && <p className="field-help" title={result.tools.map(x => x.document ?? x.queries.join(', ')).join(' · ')}>{t('forge.toolsUsed', { calls: String(result.tools.length), rounds: String(result.rounds) })}</p>}
        {result.fixes.length > 0 && <p className="field-help">{t('forge.fixes', { list: result.fixes.join('; ') })}</p>}
        {result.warnings.map(w => <p key={w} className="forge-warning">{w}</p>)}
        {meta.map(s => <label key={s.label} className="forge-field"><span>{s.label}</span><textarea readOnly value={s.body}/></label>)}
      </div>}
    </div>
  </>;
}
