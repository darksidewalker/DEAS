import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { forgeError, nativeForgeRevise, nativeForgeTargets, nativeForgeWrite, nativeModelId, type NativeCameraOption, type NativeResult, type NativeSegment, type NativeTargets, type NativeWrite } from '../../lib/forge';
import { isString, usePref } from '../../lib/preferences';
import { aspects as settingsAspects } from '../../lib/resolution';
import { ModelSelect, type useForgeModels } from './ForgeButton';
import { canonicalForgeAspect, forgeAspectChoices, resolveForgeCanvas, type ForgeCanvasContext, type ForgeSendCanvas } from '../../lib/forgeCanvas';
import type { Size } from '../../lib/resolution';
import { LayoutStudio, applyGenerated, exportLayout, forPrompt, resizeProject, useLayoutProject } from './LayoutStudio';
import { Randomizer } from './Randomizer';
import { Reading, ReferenceImages, type RefPicture } from './ReferenceImages';
import { TagPicker, weighted, type PickedTag } from './TagPicker';
import { Chips, Fold, Ladder, Tiles, aspectIcon, icon, type TileOption } from './tiles';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
/** `high_quality` → `High quality`, as PromptForge shows registry names. */
const pretty = (v: string) => { const s = v.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const FOLDS = ['presets', 'output', 'verbatim', 'camera', 'lighting', 'tags', 'refs'] as const;
/** PromptForge's bounds for the manual length. */
const LENGTH_MIN = 10, LENGTH_MAX = 4000;
interface Association { scope: object; canvas?: Size; contextKey: string; layoutRevision?: number; textRevision: number }
interface Draft { result: NativeResult; prompt: string; negative: string; association: Association | null }

/**
 * The Prompt Forge editor for the image models: PromptForge's own pipeline run natively — character canon from the local
 * tables, the tag-search and guidance tools, then the mechanical clean-up — with PromptForge's builder: named-notch
 * sliders, folding sections that say what is set inside them, and camera/light tiles. The result goes to Generate.
 */
export function NativeForge({ root, canvasContext, target, forge, brief, setBrief, detail, setDetail, creativity, setCreativity, onSend, header, active = true }: { brief: string; setBrief: (value: string) => void; detail: number; setDetail: (value: number) => void; creativity: number; setCreativity: (value: number) => void; root?: string; endpoint?: string; canvasContext?: ForgeCanvasContext; target: string; forge: ReturnType<typeof useForgeModels>; onSend: (positive: string, negative: string, canvas?: ForgeSendCanvas) => void; /** The Write-for picker, shown first. */ header?: ReactNode; /** A retained, hidden tab reads nothing. */ active?: boolean }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<NativeTargets | null>(null);
  const [loadError, setLoadError] = useState('');
  const [lighting, setLighting] = usePref('forge.native.lighting', 0, isNumber);
  const [mode, setMode] = usePref(`forge.native.${target}.mode`, '', isString);
  const [quality, setQuality] = usePref(`forge.native.${target}.quality`, 'none', isString);
  const [style, setStyle] = usePref(`forge.native.${target}.style`, 'None', isString);
  const [aspect, setAspect] = usePref(`forge.native.${target}.aspect`, 'N/A', isString);
  const [customWidth, setCustomWidth] = usePref(`forge.native.${target}.customWidth`, 1, isNumber);
  const [customHeight, setCustomHeight] = usePref(`forge.native.${target}.customHeight`, 1, isNumber);
  const [angle, setAngle] = usePref(`forge.native.${target}.angle`, '', isString);
  const [shot, setShot] = usePref(`forge.native.${target}.shot`, '', isString);
  const [light, setLight] = usePref(`forge.native.${target}.light`, '', isString);
  const [withNegative, setWithNegative] = usePref('forge.native.negative', true, isBool);
  const [withNotes, setWithNotes] = usePref('forge.native.notes', false, isBool);
  const [folds, setFolds] = usePref<string[]>('forge.native.folds', ['presets'], isStrings);
  const [lengthUnit, setLengthUnit] = usePref<'' | 'words' | 'tokens'>('forge.native.lengthUnit', '', (v): v is '' | 'words' | 'tokens' => v === '' || v === 'words' || v === 'tokens');
  const [lengthValue, setLengthValue] = usePref('forge.native.lengthValue', 120, isNumber);
  const [refineText, setRefineText] = useState('');
  const [undo, setUndo] = useState<Draft[]>([]);
  const [randomizer, setRandomizer] = useState(false);
  const [tags, setTags] = useState<PickedTag[]>([]);
  const [pictures, setPictures] = useState<RefPicture[]>([]);
  const pictureCount = useRef(0);
  useEffect(() => {
    if (pictures.length > pictureCount.current) setFolds(current => current.includes('refs') ? current : [...current, 'refs']);
    pictureCount.current = pictures.length;
  }, [pictures.length, setFolds]);
  const studio = useLayoutProject();
  const [step, setStep] = useState<'' | 'prompt' | 'json'>('');
  const [keepPositive, setKeepPositive] = useState('');
  const [keepNegative, setKeepNegative] = useState('');
  const [result, setResult] = useState<NativeResult | null>(null);
  const [association, setAssociation] = useState<Association | null>(null);
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const textRevision = useRef(0);
  const editPrompt = (value: string) => { textRevision.current++; setPrompt(value); };
  const editNegative = (value: string) => { textRevision.current++; setNegative(value); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Read once the model list is ready, i.e. after the shared LLM readiness check passed.
  const ready = active && !!root && !!forge.model;
  useEffect(() => {
    if (!ready || targets) return;
    let alive = true;
    nativeForgeTargets(root!).then(v => { if (alive) setTargets(v); }, e => { if (alive) setLoadError(forgeError(e)); });
    return () => { alive = false; };
  }, [ready, root, targets]);
  useEffect(() => { setTargets(null); setLoadError(''); }, [root]);
  // A result belongs to the target it was written for.
  useEffect(() => { setResult(null); setAssociation(null); setPrompt(''); setNegative(''); setError(''); setUndo([]); }, [target]);

  const spec = targets?.targets.find(x => x.key === target);
  const modes = spec?.modes ?? [];
  const activeMode = modes.includes(mode) ? mode : spec?.defaultMode && modes.includes(spec.defaultMode) ? spec.defaultMode : modes[0] ?? '';
  // MOSS Layout JSON: the studio stands in for the result, and the JSON is the whole prompt.
  const layoutMode = activeMode === 'Layout JSON' && !!spec?.layoutCanvas;
  const optional = spec?.optional ?? [];
  const negativeLabel = optional.find(l => /negative/i.test(l));
  const notesLabels = layoutMode ? [] : optional.filter(l => !/negative/i.test(l));
  const segmentsOn = [...(withNegative && negativeLabel ? [negativeLabel] : []), ...(withNotes ? notesLabels : [])];
  // A pick the current model does not offer is not sent (a stored key from an older pack, say).
  const offered = (list: NativeCameraOption[] | undefined, key: string) => list?.some(o => o.key === key) ? key : '';
  const pick = { angle: offered(spec?.camera?.angle, angle), shot: offered(spec?.camera?.shot, shot), light: offered(spec?.camera?.light, light) };
  const qualities = spec?.qualityPresets.filter(p => p !== 'none') ?? [];
  const styles = spec?.styles.filter(s => s !== 'None') ?? [];
  const selectedAspect = canonicalForgeAspect(aspect);
  const resolved = resolveForgeCanvas(aspect, { width: customWidth, height: customHeight }, canvasContext, layoutMode ? 'layout' : 'image');
  const lightingNotches = spec?.lightingLevels ?? [];
  const lightingOn = lightingNotches.some(([n]) => n === lighting) ? lighting : 0;

  const canvas = resolved.canvas;
  useEffect(() => {
    if (layoutMode && canvas && !resolved.error) studio.set(resizeProject(studio.project, canvas.width, canvas.height));
  }, [layoutMode, canvas?.width, canvas?.height, resolved.error]); // eslint-disable-line react-hooks/exhaustive-deps
  // An identity object changes even across A → B → A. Responses from an older
  // authoring context cannot replace the current text or layout.
  // The native writer never talks to the backend, and a plain text result has no canvas to go stale.
  const scopeKey = JSON.stringify([root, target, activeMode, forge.settledModel, forge.rev, aspect, customWidth, customHeight, canvas || layoutMode ? canvasContext?.key : '', canvas, resolved.error]);
  // Reference pictures can contain large data URLs. Their immutable state
  // identity participates in freshness without serializing their bytes.
  const scope = useMemo(() => ({}), [scopeKey, brief, detail, creativity, lightingOn, quality, style, pick.angle, pick.shot, pick.light, keepPositive, keepNegative, lengthUnit, lengthValue, tags, pictures, withNegative, withNotes]);
  const latestScope = useRef<object | null>(scope);
  latestScope.current = scope;
  useEffect(() => { latestScope.current = scope; return () => { latestScope.current = null; }; }, [scope]);
  const resultFits = !!association && association.scope === scope && (!layoutMode || association.layoutRevision === studio.revision);
  const handoffBlocked = !!association?.canvas && canvasContext?.acceptsCanvas?.(association.canvas) === false;
  const layoutReady = !layoutMode || ((!canvas || (studio.project.w === canvas.width && studio.project.h === canvas.height)) && studio.project.w >= 128 && studio.project.h >= 128 && studio.project.w <= 8192 && studio.project.h <= 8192 && studio.project.w % 16 === 0 && studio.project.h % 16 === 0 && studio.project.w * studio.project.h <= 16_777_216);
  const geometryError = resolved.error || (!layoutReady ? 'forge.canvas.layoutInvalid' : '');
  const consume = (): Association => ({ scope, ...(canvas ? { canvas: { ...canvas } } : {}), contextKey: canvasContext?.key ?? '', textRevision: textRevision.current, ...(layoutMode ? { layoutRevision: studio.revision } : {}) });
  const current = (snapshot: Association) => latestScope.current === snapshot.scope && snapshot.textRevision === textRevision.current && (snapshot.layoutRevision === undefined || studio.isCurrent(snapshot.layoutRevision));
  const send = (positive: string, negativeText: string, textOnly = false) => {
    if (!positive.trim()) return;
    if (textOnly) { onSend(positive, negativeText); return; }
    if (!resultFits || geometryError || handoffBlocked || busy) return;
    if (association?.canvas) onSend(positive, negativeText, { canvas: { ...association.canvas }, contextKey: association.contextKey });
    else onSend(positive, negativeText);
  };
  const lengthOk = Number.isInteger(lengthValue) && lengthValue >= LENGTH_MIN && lengthValue <= LENGTH_MAX;
  const request = (): NativeWrite => ({
    target, brief, model: nativeModelId(forge.model), mode: activeMode || undefined, segmentsOn,
    controls: {
      detail, creativity, lighting: lightingOn || undefined,
      qualityPreset: qualities.includes(quality) ? quality : 'none', style: styles.includes(style) ? style : 'None', aspectRatio: selectedAspect ?? aspect,
      ...(canvas ? { canvas: { ...canvas } } : {}),
      cameraAngle: pick.angle || undefined, cameraShot: pick.shot || undefined, cameraLight: pick.light || undefined,
      positive: keepPositive.trim() || undefined, negative: keepNegative.trim() || undefined,
      maxLength: lengthUnit && lengthOk ? { unit: lengthUnit, value: lengthValue } : undefined,
      tags: tags.length ? tags.map(weighted) : undefined,
      imageReferences: pictures.length ? pictures.map(({ role, fidelity, note, character, image }) => ({ role, fidelity, note, character, image })) : undefined,
    },
  });
  const show = (out: NativeResult, snapshot: Association) => { setResult(out); setAssociation(snapshot); setPrompt(out.prompt); setNegative(out.negative ?? ''); };
  const run = async () => {
    if (!root || !forge.model || busy || geometryError) return;
    const snapshot = consume();
    setBusy(true); setError('');
    try { const out = await nativeForgeWrite(root, request()); if (current(snapshot)) { show(out, snapshot); setUndo([]); } else if (latestScope.current) setError('forge.canvas.replyStale'); }
    catch (e) { if (current(snapshot)) setError(forgeError(e)); }
    finally { setBusy(false); }
  };
  // Layout JSON in PromptForge's two steps. Generate prompt: the brief, written as Natural language writes it, into the
  // Global prompt. Generate JSON: the Global prompt (or the brief while it is empty) into the boxes; drawn boxes stay.
  const generate = async (which: 'prompt' | 'json') => {
    if (!root || !forge.model || busy || geometryError) return;
    const snapshot = consume();
    const base = request();
    const p = studio.project;
    const text = which === 'json' && p.caption.trim() ? p.caption : brief;
    if (!text.trim()) return setError(which === 'prompt' ? 'forge.layout.needBrief' : 'forge.layout.needEither');
    const { positive: _p, tags: _t, imageReferences: _r, ...controls } = base.controls ?? {};
    setBusy(true); setStep(which); setError('');
    try {
      const out = await nativeForgeWrite(root, which === 'prompt'
        ? { ...base, brief: text, mode: 'Natural language', segmentsOn: base.segmentsOn?.filter(l => /negative/i.test(l)), controls }
        : { ...base, brief: text, mode: 'Layout JSON', controls: { ...controls, layout: forPrompt(p) } });
      if (!current(snapshot)) { if (latestScope.current) setError('forge.canvas.replyStale'); return; }
      let published = p;
      if (which === 'prompt') {
        const prose = out.segments.find(x => x.label === 'Enhanced prompt')?.body ?? out.prompt;
        if (prose.trim()) published = { ...p, caption: prose.trim() };
      } else {
        const body = out.segments.find(x => x.label === 'Layout JSON')?.body;
        if (body) {
          // The Global prompt it was written from stays the person's own.
          try { const laid = applyGenerated(p, body); published = p.caption.trim() ? { ...laid, caption: p.caption } : laid; }
          catch { setError('forge.layout.unreadable'); return; }
        }
      }
      studio.set(published);
      setResult(out); setAssociation({ ...snapshot, layoutRevision: snapshot.layoutRevision! + (published === p ? 0 : 1) }); setNegative(out.negative ?? ''); setUndo([]);
    } catch (e) { if (current(snapshot)) setError(forgeError(e)); }
    finally { setBusy(false); setStep(''); }
  };
  // The draft as it stands on screen: the person's edits to the prompt and the negative go back with it.
  const onScreen = (): NativeSegment[] => (result?.segments ?? []).map(s =>
    s.body === result?.prompt && s.label !== 'Negative prompt' ? { ...s, body: prompt } : s.label === 'Negative prompt' ? { ...s, body: negative } : s);
  const revise = async (instruction?: string) => {
    if (!root || !forge.model || !result || !resultFits || busy || geometryError) return;
    const snapshot = consume();
    setBusy(true); setError('');
    try {
      const before: Draft = { result, prompt, negative, association };
      const out = await nativeForgeRevise(root, { ...request(), segments: onScreen(), instruction, referenceAnalysis: result.referenceAnalysis ?? undefined });
      if (!current(snapshot)) { if (latestScope.current) setError('forge.canvas.replyStale'); return; }
      setUndo([...undo, before]); show(out, snapshot);
      if (instruction) setRefineText('');
    } catch (e) { if (current(snapshot)) setError(forgeError(e)); }
    finally { setBusy(false); }
  };
  const back = () => { const last = undo.at(-1); if (!last) return; textRevision.current++; setUndo(undo.slice(0, -1)); setResult(last.result); setAssociation(last.association); setPrompt(last.prompt); setNegative(last.negative); };
  const clear = () => { textRevision.current++; setResult(null); setAssociation(null); setPrompt(''); setNegative(''); setError(''); setUndo([]); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(negative.trim() ? `${prompt}\n\n${t('forge.negativeShort')}: ${negative}` : prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setError('forge.copyFailed'); }
  };

  const toggle = (name: string) => setFolds(folds.includes(name) ? folds.filter(f => f !== name) : [...folds, name]);
  const visible = FOLDS.filter(f => f !== 'camera' || (spec?.camera?.angle.length || spec?.camera?.shot.length))
    .filter(f => f !== 'lighting' || lightingNotches.length || spec?.camera?.light.length)
    .filter(f => f !== 'tags' || !!root)
    .filter(f => f !== 'refs' || (!!root && !!targets?.references?.roles.length))
    // What the studio makes redundant, as in PromptForge: the pictures, the tags and the kept-verbatim fields.
    .filter(f => !layoutMode || !['refs', 'tags', 'verbatim'].includes(f));
  const allOpen = visible.every(f => folds.includes(f));
  const camTiles = (list: NativeCameraOption[] | undefined): TileOption[] => [{ key: '', label: t('forge.any'), icon: icon('any') }, ...(list ?? []).map(o => ({ key: o.key, label: o.label, icon: icon(o.icon), title: o.payload }))];
  const label = (list: NativeCameraOption[] | undefined, key: string) => list?.find(o => o.key === key)?.label ?? '';

  const summary = {
    presets: [qualities.includes(quality) && pretty(quality), styles.includes(style) && style, aspect !== 'N/A' && aspect].filter(Boolean).join(' · ') || t('forge.nothingSet'),
    output: [lengthUnit && lengthOk ? `${lengthValue} ${t(`forge.length.${lengthUnit}`)}` : t('forge.length.default'), [negativeLabel && withNegative && t('forge.segment.negative'), notesLabels.length && withNotes && t('forge.segment.notes')].filter(Boolean).join(', ') || t('forge.promptOnly')].join(' · '),
    verbatim: [keepPositive.trim() && t('forge.customPositive'), keepNegative.trim() && spec?.hasNegative && t('forge.customNegative')].filter(Boolean).join(' + ') || t('forge.empty'),
    camera: [label(spec?.camera?.angle, pick.angle), label(spec?.camera?.shot, pick.shot)].filter(Boolean).join(' · ') || t('forge.any'),
    refs: pictures.length ? t('forge.refs.count', { count: String(pictures.length) }) : t('forge.refs.none'),
    tags: tags.length ? t('forge.tags.count', { count: String(tags.length) }) : t('forge.tags.none'),
    lighting: [lightingOn ? lightingNotches.find(([n]) => n === lightingOn)?.[1] : t('forge.anyBrightness'), pick.light ? t('forge.fromDir', { dir: label(spec?.camera?.light, pick.light).toLowerCase() }) : t('forge.anyDirection')].join(' · '),
  };
  const fold = (name: typeof FOLDS[number], body: ReactNode) => visible.includes(name) && <Fold name={name} title={t(`forge.fold.${name}`)} summary={summary[name]} open={folds.includes(name)} onToggle={toggle}>{body}</Fold>;
  const meta = result?.segments.filter(s => s.label !== 'Negative prompt' && s.body !== result.prompt) ?? [];
  const creativityNotches = (targets?.creativity ?? []).map((c, i) => [i + 1, pretty(c)] as [number, string]);

  return <>
    <div className="forge-card forge-builder" data-forge-native={target}>
      <div className="forge-card-head">
        <h3 className="forge-card-title">{t('forge.build', { label: spec?.label ?? target })}</h3>
        {spec && root && <button type="button" className="forge-ghost forge-head-push" data-forge-randomizer-open title={t('forge.random.open')} onClick={() => setRandomizer(true)}>{t('forge.random.title')}</button>}
        {spec && <button type="button" className="forge-ghost" data-forge-folds onClick={() => setFolds(allOpen ? [] : [...visible])}>{t(allOpen ? 'forge.closeAll' : 'forge.openAll')}</button>}
      </div>
      <div className="forge-pickers">{header}<ModelSelect forge={forge}/></div>
      {!root && <p className="field-help">{t('forge.noBackend')}</p>}
      {loadError && <p className="error-message" role="alert">{t('forge.native.noData')} {loadError}</p>}
      {modes.length > 1 && <div className="forge-group" role="group" aria-label={t('forge.format')}>
        <span className="forge-group-label">{t('forge.format')}</span>
        <div className="forge-seg">{modes.map(m => <button key={m} type="button" data-forge-mode={m} aria-pressed={m === activeMode} onClick={() => setMode(m)}>{m}</button>)}</div>
      </div>}
      <label className="forge-field"><span>{t('forge.brief')}</span><textarea data-forge-brief value={brief} maxLength={16384} placeholder={t('forge.briefPlaceholder')} onChange={e => setBrief(e.target.value)}/></label>
      <div className="forge-ladders">
        <Ladder name="detail" label={t('forge.detail')} notches={spec?.detailLevels ?? []} value={detail} onChange={setDetail}/>
        <Ladder name="creativity" label={t('forge.creativity')} notches={creativityNotches} value={creativity} onChange={setCreativity}/>
      </div>
      {spec && <div className="forge-folds">
        {fold('presets', <>
          {qualities.length > 0 && <Chips name="quality" label={t('forge.quality')} value={qualities.includes(quality) ? quality : 'none'} onChange={setQuality} options={[{ key: 'none', label: t('forge.none') }, ...qualities.map(q => ({ key: q, label: pretty(q) }))]}/>}
          {styles.length > 0 && <Chips name="style" label={t('forge.style')} value={styles.includes(style) ? style : 'None'} onChange={setStyle} options={[{ key: 'None', label: t('forge.none') }, ...styles.map(s => ({ key: s, label: s }))]}/>}
          <Tiles name="aspect" label={t('forge.aspect')} value={selectedAspect ?? aspect} onChange={setAspect} options={forgeAspectChoices.map(a => ({
            key: a, label: a === 'N/A' ? 'N/A' : a === 'auto' ? t('forge.canvas.auto') : a === 'custom' ? t('forge.canvas.custom') : a,
            icon: aspectIcon(a), ...(a === 'N/A' ? { sub: t('forge.aspectNone') } : {}),
          }))}/>
          {selectedAspect === 'custom' && <div className="forge-row forge-custom-ratio">
            <label className="forge-field"><span>{t('forge.canvas.ratioWidth')}</span><input data-forge-custom-width type="number" min={1} max={100} step="any" value={customWidth} onChange={e => setCustomWidth(Number(e.target.value))}/></label>
            <label className="forge-field"><span>{t('forge.canvas.ratioHeight')}</span><input data-forge-custom-height type="number" min={1} max={100} step="any" value={customHeight} onChange={e => setCustomHeight(Number(e.target.value))}/></label>
          </div>}
        </>)}
        {fold('output', <div className="forge-switches">
          <div className="forge-length">
            <label className="forge-field"><span>{t('forge.length')}</span><select data-forge-length-unit value={lengthUnit} onChange={e => setLengthUnit(e.target.value as '' | 'words' | 'tokens')}>
              <option value="">{t('forge.length.default')}</option><option value="words">{t('forge.length.words')}</option><option value="tokens">{t('forge.length.tokens')}</option>
            </select></label>
            {lengthUnit && <label className="forge-field"><span>&nbsp;</span><input type="number" data-forge-length-value min={LENGTH_MIN} max={LENGTH_MAX} step={10} value={lengthValue} aria-invalid={!lengthOk} onChange={e => setLengthValue(Number(e.target.value))}/></label>}
          </div>
          <p className="forge-note">{t(lengthUnit === 'words' ? 'forge.length.wordsNote' : lengthUnit === 'tokens' ? 'forge.length.tokensNote' : 'forge.length.defaultNote', { words: String(Math.round(lengthValue * 0.75)) })}</p>
          {negativeLabel && <label className="forge-switch"><input type="checkbox" data-forge-with-negative checked={withNegative} onChange={e => setWithNegative(e.target.checked)}/><span>{t('forge.withNegative')}</span></label>}
          {notesLabels.length > 0 && <label className="forge-switch"><input type="checkbox" data-forge-with-notes checked={withNotes} onChange={e => setWithNotes(e.target.checked)}/><span>{t('forge.withNotes')}</span></label>}
        </div>)}
        {fold('verbatim', <>
          <label className="forge-field"><span>{t('forge.customPositive')} <em>{t('forge.verbatim')}</em></span><textarea className="forge-short" data-forge-keep-positive value={keepPositive} maxLength={2000} placeholder={t('forge.keepPositive')} onChange={e => setKeepPositive(e.target.value)}/></label>
          {spec.hasNegative && <label className="forge-field"><span>{t('forge.customNegative')} <em>{t('forge.verbatim')}</em></span><textarea className="forge-short" data-forge-keep-negative value={keepNegative} maxLength={2000} placeholder={t('forge.keepNegative')} onChange={e => setKeepNegative(e.target.value)}/></label>}
        </>)}
        {fold('camera', <>
          {!!spec.camera?.angle.length && <Tiles name="angle" label={t('forge.angle')} value={pick.angle} onChange={setAngle} options={camTiles(spec.camera.angle)}/>}
          {!!spec.camera?.shot.length && <Tiles name="shot" label={t('forge.howClose')} value={pick.shot} onChange={setShot} options={camTiles(spec.camera.shot)}/>}
        </>)}
        {fold('lighting', <>
          <Ladder name="lighting" wide label={t('forge.lighting')} notches={lightingNotches} value={lightingOn} onChange={setLighting}/>
          {!!spec.camera?.light.length && <Tiles name="light" label={t('forge.lightFrom')} value={pick.light} onChange={setLight} options={camTiles(spec.camera.light)}/>}
        </>)}
        {fold('tags', root && <TagPicker root={root} target={target} tags={tags} onTags={setTags} weightRange={spec.weightRange}/>)}
        {fold('refs', root && targets?.references && <ReferenceImages root={root} target={target} model={forge.model ? nativeModelId(forge.model) : ''} vocab={targets.references} pictures={pictures}
          onPictures={setPictures}/>)}
      </div>}
      <p className={geometryError ? 'forge-warning' : 'forge-note'} data-forge-canvas role={geometryError ? 'status' : undefined}>
        {geometryError ? `${t(geometryError)}${selectedAspect === null ? ` (${aspect})` : ''}` : canvas ? t('forge.canvas.resolved', { width: String(canvas.width), height: String(canvas.height) }) : t('forge.aspectNone')}
      </p>
      {layoutMode ? <div className="forge-layout-gen">
        <button type="button" className="action-button forge-write" data-forge-generate-prompt disabled={busy || !forge.model || !brief.trim() || !!geometryError} title={t('forge.layout.genPromptHelp')} onClick={() => void generate('prompt')}>{t(step === 'prompt' ? 'forge.writing' : 'forge.layout.genPrompt')}</button>
        <button type="button" className="action-button forge-write" data-forge-generate-json disabled={busy || !forge.model || (!brief.trim() && !studio.project.caption.trim()) || !!geometryError} title={t('forge.layout.genJsonHelp')} onClick={() => void generate('json')}>{t(step === 'json' ? 'forge.writing' : 'forge.layout.genJson')}</button>
      </div> : <>
      <button type="button" className="action-button forge-write" data-forge-write disabled={busy || !forge.model || !brief.trim() || (!!lengthUnit && !lengthOk) || !!geometryError} onClick={() => void run()}>{t(busy ? 'forge.writing' : result ? 'forge.regenerate' : 'forge.write')}</button>
      </>}
      {error && <p className="error-message" role="alert">{t(error)}</p>}
      {randomizer && root && <Randomizer root={root} onClose={() => setRandomizer(false)} onInsert={(text, replace) => setBrief(replace || !brief.trim() ? text : `${brief.trim().replace(/[,\s]+$/, '')}, ${text}`)}/>}
    </div>
    {layoutMode ? <div className="forge-layout-col">
      <LayoutStudio root={root} model={forge.model ? nativeModelId(forge.model) : ''} studio={studio} busy={busy} requestScope={scope} geometryValid={!geometryError}/>
      {(busy || result) && <div className="forge-card" aria-busy={busy} data-forge-layout-result>
        {busy && <p className="forge-note">{t(step === 'prompt' ? 'forge.layout.busyPrompt' : 'forge.layout.busyJson')}</p>}
        {result && <>
          {!resultFits && <p className="forge-warning" data-forge-stale role="status">{t('forge.canvas.stale')}</p>}
          {handoffBlocked && <p className="forge-warning" data-forge-handoff-blocked role="status">{t('forge.canvas.handoffBlocked')}</p>}
          {association?.canvas && <p className="forge-note" data-forge-result-canvas>{t('forge.canvas.consumed', { width: String(association.canvas.width), height: String(association.canvas.height) })}</p>}
          <div className="forge-send"><button type="button" className="action-button" data-forge-send-layout disabled={!resultFits || busy || !!geometryError || handoffBlocked} onClick={() => send(JSON.stringify(exportLayout(studio.project), null, 2), negative)}>{t('forge.canvas.sendLayout')}</button></div>
          {spec?.hasNegative && negative && <label className="forge-field"><span>{t('forge.negativeShort')}</span><textarea data-forge-negative className="forge-negative" value={negative} onChange={e => editNegative(e.target.value)}/></label>}
          {result.characters.length > 0 && <p className="forge-note">{t('forge.canon', { list: result.characters.join(', ') })}</p>}
          {result.fixes.length > 0 && <p className="forge-note">{t('forge.fixes', { list: result.fixes.join('; ') })}</p>}
          {result.warnings.map(w => <p key={w} className="forge-warning">{w}</p>)}
        </>}
      </div>}
    </div> : <div className="forge-card forge-output" aria-busy={busy}>
      <div className="forge-card-head">
        <h3 className="forge-card-title">{t('forge.result')}</h3>
        <div className="forge-actions">
          <button type="button" className="forge-ghost" data-forge-copy disabled={!prompt.trim()} onClick={() => void copy()}>{t(copied ? 'forge.copied' : 'forge.copyAll')}</button>
          <button type="button" className="forge-ghost" data-forge-clear disabled={!prompt && !result} onClick={clear}>{t('forge.clear')}</button>
        </div>
      </div>
      <div className="forge-refine">
        <input type="text" data-forge-refine value={refineText} maxLength={2000} disabled={!result || !resultFits || busy || !!geometryError} placeholder={t('forge.refinePlaceholder')} aria-label={t('forge.refine')} onChange={e => setRefineText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && refineText.trim()) void revise(refineText.trim()); }}/>
        <button type="button" className="forge-ghost" data-forge-refine-run disabled={!result || !resultFits || busy || !refineText.trim() || !!geometryError} onClick={() => void revise(refineText.trim())}>{t('forge.refine')}</button>
        {spec?.secondPass && <button type="button" className="forge-ghost" data-forge-second-pass disabled={!result || !resultFits || busy || !!geometryError} title={t('forge.secondPassHelp')} onClick={() => void revise()}>{t('forge.secondPass')}</button>}
        <button type="button" className="forge-ghost" data-forge-undo disabled={!undo.length || busy} onClick={back}>{t('forge.undo')}</button>
      </div>
      {!prompt && !result ? <div className={`forge-empty${busy ? ' busy' : ''}`} data-forge-empty>
        <strong>{t(busy ? 'forge.writing' : 'forge.emptyTitle')}</strong>
        <span>{t(busy ? pictures.length ? 'forge.refs.busy' : 'forge.emptyBusy' : 'forge.emptyBody')}</span>
      </div> : <>
        <label className="forge-field"><span>{t('forge.positive')}</span><textarea data-forge-result aria-label={t('forge.result')} value={prompt} onChange={e => editPrompt(e.target.value)}/></label>
        {spec?.hasNegative && <label className="forge-field"><span>{t('forge.negativeShort')}</span><textarea data-forge-negative className="forge-negative" value={negative} onChange={e => editNegative(e.target.value)}/></label>}
      </>}
      {result && !resultFits && <p className="forge-warning" data-forge-stale role="status">{t('forge.canvas.stale')}</p>}
      {handoffBlocked && <p className="forge-warning" data-forge-handoff-blocked role="status">{t('forge.canvas.handoffBlocked')}</p>}
      {association?.canvas && <p className="forge-note" data-forge-result-canvas>{t('forge.canvas.consumed', { width: String(association.canvas.width), height: String(association.canvas.height) })}</p>}
      <div className="forge-send">
        <button type="button" className="action-button" data-forge-send disabled={!prompt.trim() || !resultFits || busy || !!geometryError || handoffBlocked} onClick={() => send(prompt, '')}>{t('forge.sendPrompt')}</button>
        {spec?.hasNegative && <button type="button" className="action-button" data-forge-send-both disabled={!prompt.trim() || !negative.trim() || !resultFits || busy || !!geometryError || handoffBlocked} onClick={() => send(prompt, negative)}>{t('forge.sendBoth')}</button>}
        {prompt.trim() && (!resultFits || handoffBlocked) && <button type="button" className="forge-ghost" data-forge-send-text-only onClick={() => send(prompt, negative, true)}>{t('forge.canvas.sendTextOnly')}</button>}
      </div>
      {result && <div className="forge-report" data-forge-report>
        {result.characters.length > 0 && <p className="forge-note">{t('forge.canon', { list: result.characters.join(', ') })}</p>}
        {result.tools.length > 0 && <p className="forge-note" title={result.tools.map(x => x.document ?? x.queries.join(', ')).join(' · ')}>{t('forge.toolsUsed', { calls: String(result.tools.length), rounds: String(result.rounds) })}</p>}
        {result.changed !== undefined && undo.length > 0 && <p className="forge-note" data-forge-changed>{t('forge.changed', { count: String(result.changed) })}</p>}
        {result.fixes.length > 0 && <p className="forge-note">{t('forge.fixes', { list: result.fixes.join('; ') })}</p>}
        {result.warnings.map(w => <p key={w} className="forge-warning">{w}</p>)}
        {result.referenceAnalysis && <details className="forge-readback" data-forge-reading><summary>{t('forge.refs.writtenFrom')}</summary><Reading text={result.referenceAnalysis}/></details>}
        {meta.map(s => <label key={s.label} className="forge-field"><span>{s.label}</span><textarea readOnly value={s.body}/></label>)}
      </div>}
    </div>}
  </>;
}
