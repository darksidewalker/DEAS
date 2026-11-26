import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useI18n } from '../../i18n/I18nProvider';
import { clipFrame, openClip, pickMedia } from '../../lib/analysis';
import { describeMedia, dropCssPoint, itemFromEntry, pastedPaths, pastedPictures, pasteToInput, saveDerived } from '../../lib/media';
import { stopWorkbenchJob } from '../../lib/jobs';
import { scanModels } from '../../lib/models';
import { builtinWizards, editGrid, findInLibrary, gridCopyName, gridCrop, preferredChoice, strategyCfg, wizardTargets, strategyPrompt, usesObject, videoPrompt, videoSeconds, wizardCanvas, wizardChoices, wizardReady, wizardVideoChoices, type WizardField, type WizardHandoff, type WizardModel, type WizardPicture, type WizardRun } from '../../lib/wizards';
import { MovieMaker } from './MovieMaker';
import './darkWizards.css';

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv)$/i;
/** A clip as the picture to change: its first frame is what the image step edits. */
type WizardClip = WizardPicture & { width: number; height: number; seconds: number };
/** PNG of a rectangle of the picture; read through a blob so the asset protocol never taints the canvas. */
async function cropPicture(src: string, r: { x: number; y: number; width: number; height: number }): Promise<Blob> {
  const response = await fetch(src); if (!response.ok) throw new Error(`Image load failed: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
  const ctx = c.getContext('2d'); if (!ctx) { bitmap.close(); throw new Error('canvas'); }
  try { ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height); } finally { bitmap.close(); }
  const blob = await new Promise<Blob | null>(done => c.toBlob(done, 'image/png')); if (!blob) throw new Error('canvas');
  return blob;
}
/** `target` is the picture to change (reference 1 / picture to edit); `object` the optional picture whose content goes in (reference 2). */
type Slot = 'target' | 'object';
export interface DarkWizardsProps {
  active?: boolean;
  roots?: { models?: string; extraModels?: string[]; input?: string };
  /** Hands an ordinary draft to Generate, optionally asking it to run that draft; Generate replies through `outcome` with the same number. */
  onPrepare: (handoff: Omit<WizardHandoff, 'n'>) => void;
  outcome?: { n: number; error?: string; run?: WizardRun };
  /** Opens Generate again to show the finished draft and its job in the queue. */
  onOpenGenerate?: () => void;
  /** Number of the last hand-over, so the outcome of an older one is not shown as current. */
  handoff?: number;
  /** Generate's reason why SAM 3.1 text→mask cannot run (empty when it can; undefined while unknown). */
  sam?: string;
  /** Backend address, for the film assembly of Movie Maker. */
  endpoint?: string;
}

/** Dark Wizards: preset-driven helpers that pick model, pipeline and prompt, then prepare Generate. They never run anything themselves. */
export function DarkWizards({ active = false, roots, onPrepare, outcome, onOpenGenerate, handoff, sam, endpoint }: DarkWizardsProps) {
  const { t } = useI18n();
  const native = isTauri();
  const [wizardId, setWizardId] = useState(builtinWizards[0]?.id ?? '');
  const [movie, setMovie] = useState(false);
  const wizard = builtinWizards.find(w => w.id === wizardId) ?? builtinWizards[0];
  const [models, setModels] = useState<WizardModel[] | null>(null);
  const [scanError, setScanError] = useState('');
  const [pictures, setPictures] = useState<Record<Slot, WizardPicture | null>>({ target: null, object: null });
  const [slot, setSlot] = useState<Slot>('target');
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [fields, setFields] = useState<Partial<Record<WizardField, string>>>({});
  const [strategyId, setStrategyId] = useState('');
  const [modelPath, setModelPath] = useState('');
  const [error, setError] = useState('');
  const [over, setOver] = useState<Slot | null>(null);
  const [cropping, setCropping] = useState(false);
  // Video Replace (UX-22c2): the clip, its edited first frame, the chosen video method and the frame run that should continue into the video step.
  const [clip, setClip] = useState<WizardClip | null>(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [editedFrame, setEditedFrame] = useState<WizardPicture | null>(null);
  const [videoMethodId, setVideoMethodId] = useState('');
  const [videoModelPath, setVideoModelPath] = useState('');
  const [chain, setChain] = useState<number | 'next' | null>(null);
  const tab = useRef<HTMLElement>(null), scan = useRef(0);
  const zones = useRef<Record<Slot, HTMLDivElement | null>>({ target: null, object: null });

  const modelsRoot = roots?.models, extraKey = (roots?.extraModels ?? []).join('\n');
  const look = async (refresh = false) => {
    if (!native || !modelsRoot) { setModels([]); return; }
    const mine = ++scan.current; setScanError('');
    try { const list = await scanModels(modelsRoot, extraKey ? extraKey.split('\n') : [], refresh); if (mine === scan.current) setModels(list); }
    catch (e) { if (mine === scan.current) { setModels([]); setScanError(e instanceof Error ? e.message : String(e)); } }
  };
  // Read-only scan of the models folders (the native index); nothing is hashed, fetched or downloaded.
  useEffect(() => { if (active || models === null) void look(); }, [active, modelsRoot, extraKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const slots: Slot[] = wizard?.object ? ['target', 'object'] : ['target'];
  const picture = pictures.target, object = wizard?.object ? pictures.object : null;
  const choices = wizard && models ? wizardChoices(wizard, models) : [];
  const chosen = choices.find(c => c.strategy.id === strategyId && c.models.length) ?? preferredChoice(choices);
  const model = chosen?.models.find(m => m.path === modelPath) ?? chosen?.models[0];
  // With an object picture a strategy may hand over another one (the masked edit keeps the old object, the reference edit replaces it), on the same model.
  const via = chosen?.strategy.objectVia && object ? wizard?.strategies.find(s => s.id === chosen.strategy.objectVia) : undefined;
  const routed = !!via && usesObject(via, model?.family, true) && via.families.includes(model?.family ?? '');
  const strategy = routed ? via : chosen?.strategy;
  const withObject = !!strategy && usesObject(strategy, model?.family, !!object);
  const pictureSize = picture ? sizes[picture.src] : undefined;
  const ready = !!picture && !!chosen && !!model && wizardReady(strategy!, fields, withObject) && (strategy!.source !== 'reference' || !!pictureSize);
  const pending = !!handoff && outcome?.n !== handoff;
  // The wizard's own run: Generate submits and follows it; the wizard shows its progress and can stop only that job.
  const run = !!handoff && outcome?.n === handoff ? outcome.run : undefined;
  const running = run?.state === 'queued' || run?.state === 'running';
  // A masked method gets its mask from Generate's SAM 3.1 text path with *Replace what* as the target, so it needs both.
  const maskTarget = strategy?.needsMask ? fields.target?.replace(/\s+/g, ' ').trim() ?? '' : '';
  const runBlocked = !native ? t('wizards.run.native') : !strategy?.needsMask ? '' : !maskTarget ? t('wizards.run.maskTarget') : sam ?? t('studio.sam.checking');
  const runnable = !runBlocked;
  // Inpaint keeps the source size, so a picture off the model's grid is first resampled in Generate; say so before the hand-over.
  const grid = strategy?.source === 'edit' && model?.family ? editGrid(model.family, withObject) : 0;
  const offGrid = !!grid && !!pictureSize && (pictureSize.width % grid !== 0 || pictureSize.height % grid !== 0);
  const crop = offGrid && pictureSize ? gridCrop(pictureSize, grid) : undefined;
  // Owner decision: several targets share the one replacement (their grown masks merge); say so instead of splitting.
  const targets = wizard?.fields.includes('target') ? wizardTargets(fields.target ?? '') : [];
  const replacement = fields.replacement?.replace(/\s+/g, ' ').trim() || (withObject ? t('wizards.replace.multiObject') : '');
  const videoChoices = clip && wizard?.video && models ? wizardVideoChoices(wizard.video, models) : [];
  const videoChoice = videoChoices.find(c => c.method.id === videoMethodId && c.models.length) ?? videoChoices.find(c => c.models.length);
  const videoModel = videoChoice?.models.find(m => m.path === videoModelPath) ?? videoChoice?.models[0];
  const clipSeconds = clip && videoChoice ? videoSeconds(clip.seconds, videoChoice.method.maxSeconds) : undefined;
  const videoBlocked = !native ? t('wizards.run.native') : !videoModel ? t('wizards.video.noModel') : '';

  const place = (into: Slot, value: WizardPicture | null) => {
    setPictures(p => ({ ...p, [into]: value }));
    // After the picture to change, the next paste or drop-free Choose goes to the empty object slot.
    if (value && into === 'target' && wizard?.object && !pictures.object) setSlot('object'); else setSlot(into);
  };
  /** `keepClip`: the picture replaces the clip's first frame (a grid crop of it), not the clip itself. */
  const fromPath = async (path: string, into: Slot, keepClip = false) => {
    setError('');
    try {
      const item = (await describeMedia([path])).map(itemFromEntry).find(Boolean);
      if (item?.media === 'image' && item.path) { if (into === 'target' && !keepClip) { setClip(null); setEditedFrame(null); } place(into, { name: item.name, path: item.path, src: item.src }); }
      else if (item?.media === 'video' && item.path && into === 'target' && wizard?.video) await fromClip({ name: item.name, path: item.path, src: item.src });
      else setError(t(item?.media === 'video' && into === 'object' ? 'wizards.picture.videoObject' : 'wizards.picture.unsupported'));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  // A clip's first frame comes from Media Analysis' exact FFmpeg frame path and is copied into Input, like a saved frame.
  const fromClip = async (video: WizardPicture) => {
    setClipBusy(true); setClip(null); setEditedFrame(null); setChain(null); place('target', null);
    try {
      const info = await openClip(video.path);
      const copied = await invoke<string>('native_media_copy_in', { path: await clipFrame(video.path, 0, info.count) });
      const frame = (await describeMedia([copied])).map(itemFromEntry).find(Boolean);
      if (frame?.media !== 'image' || !frame.path) throw new Error(t('wizards.picture.unsupported'));
      setClip({ ...video, width: info.width, height: info.height, seconds: info.duration });
      place('target', { name: frame.name, path: frame.path, src: frame.src });
    } finally { setClipBusy(false); }
  };
  const choose = async (into: Slot) => {
    setSlot(into);
    try { const path = await pickMedia(t('wizards.picture.chooseTitle')); if (path) await fromPath(path, into); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  // Off-grid picture for a masked method: save a centred grid-aligned crop as a new Input file and use that instead.
  const cropToGrid = async () => {
    if (!picture || !crop || cropping) return;
    setError(''); setCropping(true);
    try { await fromPath(await saveDerived(await cropPicture(picture.src, crop), gridCopyName(picture.name, crop)), 'target', true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCropping(false); }
  };
  const live = useRef({ fromPath, slot }); live.current = { fromPath, slot };
  // Ctrl+V on the visible tab fills the highlighted slot: a copied file by its path, copied picture data saved to the Input folder first. Text fields keep their paste.
  useEffect(() => {
    if (!native) return;
    const paste = (e: ClipboardEvent) => {
      const el = tab.current, target = e.target;
      if (e.defaultPrevented || !el || el.closest('[hidden]') || el.querySelector('[data-wizard-form="movie"]')) return;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return;
      const modal = document.querySelector('dialog[open], [aria-modal="true"]');
      if (modal && !modal.contains(el)) return;
      const into = live.current.slot;
      const path = pastedPaths(e.clipboardData).find(p => IMAGE.test(p) || VIDEO.test(p));
      if (path) { e.preventDefault(); void live.current.fromPath(path, into); return; }
      const copied = pastedPictures(e);
      if (!copied.length) return;
      e.preventDefault();
      if (!roots?.input) { setError(t('wizards.picture.noInput')); return; }
      void pasteToInput(copied.slice(0, 1)).then(([saved]) => { if (saved) void live.current.fromPath(saved, into); }, err => setError(String(err)));
    };
    document.addEventListener('paste', paste); return () => document.removeEventListener('paste', paste);
  }, [native, roots?.input]); // eslint-disable-line react-hooks/exhaustive-deps
  // Native webviews deliver OS file drops as paths for the whole window; the zone under the pointer receives it.
  useEffect(() => {
    if (!native || !active) return;
    let alive = true, unlisten: (() => void) | undefined;
    const under = (p: { x: number; y: number }): Slot | null => {
      const { x, y } = dropCssPoint(p);
      for (const s of ['target', 'object'] as Slot[]) { const r = zones.current[s]?.getBoundingClientRect(); if (r && r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s; }
      return null;
    };
    try {
      void getCurrentWebview().onDragDropEvent(e => {
        if (e.payload.type === 'leave') { setOver(null); return; }
        const hit = under(e.payload.position); setOver(e.payload.type !== 'drop' ? hit : null);
        if (e.payload.type !== 'drop' || !hit || !alive) return;
        const path = e.payload.paths[0];
        if (path && (IMAGE.test(path) || VIDEO.test(path))) void live.current.fromPath(path, hit); else setError(t('wizards.picture.unsupported'));
      }).then(stop => { if (alive) unlisten = stop; else stop(); }, () => {});
    } catch { /* partial runtime: Choose and paste still work */ }
    return () => { alive = false; unlisten?.(); };
  }, [native, active]); // eslint-disable-line react-hooks/exhaustive-deps

  /** True when a hand-over was sent. */
  const prepare = (withRun = false): boolean => {
    if (!wizard || !strategy || !model || !picture || !ready || (withRun && !runnable)) return false;
    const s = strategy, family = model.family ?? '';
    const canvas = s.source === 'reference' && pictureSize ? wizardCanvas(family, pictureSize) : undefined;
    const cfg = strategyCfg(s, family);
    if (s.source === 'reference' && !canvas) { setError(t('wizards.picture.size')); return false; }
    setError('');
    onPrepare({ wizard: wizard.id, strategy: s.id, pipeline: s.pipeline, source: s.source, ...(s.edit ? { edit: s.edit } : {}),
      model: { name: model.name, path: model.path }, picture,
      // Reference edits make the picture reference 1 themselves; a masked edit lists it explicitly so the prompt's `image 1` exists there too.
      ...(withObject && object ? { references: s.source === 'reference' ? [object] : [picture, object] } : {}),
      positive: strategyPrompt(s, fields, withObject), ...(canvas ? { size: canvas } : {}), ...(s.denoise !== undefined ? { denoise: s.denoise } : {}),
      ...(cfg !== undefined ? { cfg } : {}), ...(s.maskGrow !== undefined ? { maskGrow: s.maskGrow } : {}), ...(s.maskBlur !== undefined ? { maskBlur: s.maskBlur } : {}), ...(withRun ? { run: true, ...(s.needsMask ? { mask: maskTarget } : {}) } : {})});
    return true;
  };

  // Step 2 of a video Replace: the edited first frame drives an ordinary video draft that Generate runs.
  const sendVideo = (frame: WizardPicture) => {
    if (!wizard || !clip || !videoChoice || !videoModel || videoBlocked) return;
    const m = videoChoice.method;
    const size = videoModel.family ? wizardCanvas(videoModel.family, { width: clip.width, height: clip.height }) : undefined;
    setError('');
    onPrepare({ wizard: wizard.id, strategy: m.id, pipeline: m.pipeline, source: 'video', model: { name: videoModel.name, path: videoModel.path }, picture: frame,
      ...(m.pipeline === 'v2v' ? { sourceVideo: { name: clip.name, path: clip.path, src: clip.src }, sourceStrength: m.sourceStrength } : {}),
      positive: videoPrompt(m, fields), ...(size ? { size } : {}), ...(clipSeconds ? { seconds: clipSeconds } : {}), run: true });
  };
  // A finished frame run in video mode is the edited first frame; when it was started by *Run both steps*, the video step follows.
  useEffect(() => {
    const r = outcome?.run;
    if (!clip || !outcome || !r) return;
    if (r.state === 'succeeded' && r.picture && !r.picture.video) {
      const frame = { name: r.picture.path.split(/[\\/]/).pop() ?? 'frame.png', path: r.picture.path, src: convertFileSrc(r.picture.path) };
      setEditedFrame(frame);
      if (chain === outcome.n) { setChain(null); sendVideo(frame); }
    } else if (chain === outcome.n && r.state !== 'queued' && r.state !== 'running') setChain(null);
  }, [outcome]); // eslint-disable-line react-hooks/exhaustive-deps
  // App numbers hand-overs one after the other, so the frame run sent now is `handoff + 1`.
  const runBoth = () => { if (!ready || !runnable || videoBlocked) return; if (prepare(true)) setChain((handoff ?? 0) + 1); };

  if (!wizard) return null;
  const field = (key: WizardField) => <label className="forge-field" key={key}>
    <span>{t(`wizards.${wizard.id}.${key}`)}</span>
    <input type="text" data-wizard-field={key} value={fields[key] ?? ''} maxLength={300} placeholder={t(`wizards.${wizard.id}.${key}${key === 'replacement' && object ? 'ObjectPlaceholder' : 'Placeholder'}`)}
      onChange={e => setFields(f => ({ ...f, [key]: e.target.value }))}/>
  </label>;
  const zone = (s: Slot) => {
    const shown = pictures[s], size = shown ? sizes[shown.src] : undefined;
    return <div className="wizards-step" key={s} data-wizard-slot={s}>
      <div className="wizards-step-head"><span className="forge-note">{t(`wizards.picture.${s}`)}</span>
        <span className="wizards-row">
          {shown && <button type="button" className="forge-ghost" data-wizard-remove={s} onClick={() => { place(s, null); if (s === 'target') { setClip(null); setEditedFrame(null); setChain(null); } }}>{t('wizards.picture.remove')}</button>}
          <button type="button" className="forge-ghost" data-wizard-choose={s} aria-label={t(`wizards.picture.choose.${s}`)} disabled={!native} onClick={() => void choose(s)}>{t('wizards.picture.choose')}</button>
        </span></div>
      <div ref={el => { zones.current[s] = el; }} className={`wizards-drop${over === s ? ' over' : ''}${shown ? ' filled' : ''}${slots.length > 1 && slot === s ? ' is-active' : ''}`}
        data-wizard-picture={s} tabIndex={0} role="group" aria-label={t(`wizards.picture.${s}`)} onFocus={() => setSlot(s)} onPointerDown={() => setSlot(s)}>
        {shown ? <img key={shown.src} src={shown.src} alt={shown.name} onLoad={e => { const img = e.currentTarget; if (img.naturalWidth > 0 && img.naturalHeight > 0) setSizes(m => ({ ...m, [shown.src]: { width: img.naturalWidth, height: img.naturalHeight } })); }}/>
          : <div className="forge-empty"><strong>{t('wizards.picture.empty')}</strong><span>{t(s === 'object' ? 'wizards.picture.objectBody' : 'wizards.picture.emptyBody')}</span></div>}
      </div>
      {shown && <p className="forge-note wizards-name" title={shown.path}>{shown.name}{size ? ` · ${size.width}×${size.height}` : ''}</p>}
      {s === 'target' && clipBusy && <p className="forge-note" role="status" data-wizard-clip-reading>{t('wizards.video.reading')}</p>}
      {s === 'target' && clip && <p className="forge-note" data-wizard-clip title={clip.path}>{t('wizards.video.clip', { name: clip.name, size: `${clip.width}×${clip.height}`, seconds: clip.seconds.toFixed(1) })}</p>}
    </div>;
  };
  const hint = strategy ? `wizards.${wizard.id}.hint.${strategy.id}${withObject ? 'Object' : ''}` : '';
  return <section ref={tab} className="wizards-tab" aria-label={t('wizards.title')}>
    <nav className="forge-card wizards-list" aria-label={t('wizards.list')}>
      <h2 className="forge-card-title">{t('wizards.title')}</h2>
      <p className="forge-note">{t('wizards.intro')}</p>
      {builtinWizards.map(w => <button type="button" key={w.id} className="forge-ghost wizards-pick" data-wizard={w.id} aria-pressed={!movie && w.id === wizard.id} onClick={() => { setWizardId(w.id); setMovie(false); }}>
        <strong>{t(`wizards.${w.id}.name`)}</strong><span>{t(`wizards.${w.id}.summary`)}</span>
      </button>)}
      <button type="button" className="forge-ghost wizards-pick" data-wizard="movie" aria-pressed={movie} onClick={() => setMovie(true)}>
        <strong>{t('wizards.movie.name')}</strong><span>{t('wizards.movie.summary')}</span>
      </button>
    </nav>
    {movie ? <MovieMaker modelsRoot={roots?.models} endpoint={endpoint} models={models} onPrepare={onPrepare} outcome={outcome} handoff={handoff}/> : <div className="forge-card wizards-form" data-wizard-form={wizard.id}>
      <div className="forge-card-head"><h3 className="forge-card-title">{t(`wizards.${wizard.id}.name`)}</h3></div>
      <div className={`wizards-pictures${slots.length > 1 ? ' is-pair' : ''}`}>{slots.map(zone)}</div>
      <div className="wizards-step wizards-fields">{wizard.fields.map(field)}</div>
      <div className="wizards-step">
        <span className="forge-note">{t('wizards.method.title')}</span>
        {models === null ? <p className="forge-note" role="status">{t('wizards.models.loading')}</p> : <>
          <div className="wizards-methods" role="group" aria-label={t('wizards.method.title')}>
            {choices.map(c => <button type="button" key={c.strategy.id} className="forge-ghost" data-wizard-strategy={c.strategy.id} aria-pressed={chosen?.strategy.id === c.strategy.id}
              disabled={!c.models.length} title={c.models.length ? undefined : t('wizards.method.noModel')} onClick={() => setStrategyId(c.strategy.id)}>
              {t(`wizards.${wizard.id}.method.${c.strategy.id}`)}</button>)}
          </div>
          {chosen && model && <>
            <div className="wizards-row wizards-model-row">
              <label className="forge-field"><span>{t('wizards.model')}</span>
                <select data-wizard-model value={model.path} onChange={e => setModelPath(e.target.value)}>
                  {chosen.models.map(m => <option key={m.path} value={m.path}>{m.name}</option>)}
                </select></label>
              {/* Models added after the first scan (another method's preferred family) appear only after an explicit look. */}
              <button type="button" className="forge-ghost" data-wizard-rescan title={t('wizards.models.rescanHint')} onClick={() => void look(true)}>{t('wizards.models.rescan')}</button>
            </div>
            {routed && <p className="forge-note" data-wizard-object-routed>{t(`wizards.${wizard.id}.objectRouted`)}</p>}
            <p className="forge-note" data-wizard-hint>{t(hint)}</p>
            {targets.length > 1 && replacement && <p className="forge-note" data-wizard-multi-target>{t('wizards.replace.multiTarget', { count: String(targets.length), targets: targets.join(', '), replacement })}</p>}
            {object && !withObject && <p className="forge-note" data-wizard-object-unused>{t('wizards.picture.objectUnused')}</p>}
            {offGrid && pictureSize && <div className="wizards-grid" data-wizard-off-grid>
              <p className="forge-note">{t('wizards.picture.offGrid', { size: `${pictureSize.width}×${pictureSize.height}`, grid: String(grid) })}</p>
              {crop ? <div className="wizards-row">
                <button type="button" className="forge-ghost" data-wizard-grid-copy disabled={!native || !roots?.input || cropping || pending || running}
                  title={!roots?.input ? t('wizards.picture.noInput') : undefined} aria-describedby="wizards-grid-copy-hint" onClick={() => void cropToGrid()}>
                  {t(cropping ? 'wizards.picture.gridCopyBusy' : 'wizards.picture.gridCopy', { size: `${crop.width}×${crop.height}` })}</button>
                <span id="wizards-grid-copy-hint" className="forge-note">{t('wizards.picture.gridCopyHint', { size: `${crop.width}×${crop.height}` })}</span>
              </div> : <p className="forge-note" data-wizard-grid-small>{t('wizards.picture.gridCopySmall')}</p>}
            </div>}
          </>}
          {!chosen && <div className="wizards-missing" data-wizard-missing>
            <p className="forge-note">{t('wizards.models.missing', { name: wizard.library })}</p>
            <div className="wizards-row">
              <button type="button" className="forge-ghost" data-wizard-library onClick={() => findInLibrary(wizard.library)}>{t('wizards.models.library')}</button>
              <button type="button" className="forge-ghost" data-wizard-rescan title={t('wizards.models.rescanHint')} onClick={() => void look(true)}>{t('wizards.models.rescan')}</button>
            </div>
          </div>}
          {scanError && <p className="error-message" role="alert">{scanError}</p>}
        </>}
      </div>
      {clip && wizard.video && <div className="wizards-step" data-wizard-video>
        <span className="forge-note">{t('wizards.video.title')}</span>
        <div className="wizards-methods" role="group" aria-label={t('wizards.video.title')}>
          {videoChoices.map(c => <button type="button" key={c.method.id} className="forge-ghost" data-wizard-video-method={c.method.id} aria-pressed={videoChoice?.method.id === c.method.id}
            disabled={!c.models.length} title={c.models.length ? undefined : t('wizards.video.noModel')} onClick={() => setVideoMethodId(c.method.id)}>{t(`wizards.${wizard.id}.video.${c.method.id}`)}</button>)}
        </div>
        {videoChoice && videoModel && <>
          <label className="forge-field"><span>{t('wizards.video.model')}</span>
            <select data-wizard-video-model value={videoModel.path} onChange={e => setVideoModelPath(e.target.value)}>
              {videoChoice.models.map(m => <option key={m.path} value={m.path}>{m.name}</option>)}
            </select></label>
          <p className="forge-note" data-wizard-video-hint>{t(`wizards.${wizard.id}.video.hint.${videoChoice.method.id}`)}</p>
          {clipSeconds && <p className="forge-note" data-wizard-video-length>{t('wizards.video.length', { seconds: String(clipSeconds), total: clip.seconds.toFixed(1) })}</p>}
        </>}
        {!videoChoice && <p className="forge-note" data-wizard-video-missing>{t('wizards.video.noModel')}</p>}
        <p className="forge-note" data-wizard-video-notice>{t('wizards.video.notice')}</p>
        {editedFrame && <p className="forge-note wizards-name" data-wizard-edited-frame title={editedFrame.path}>{t('wizards.video.frameReady', { name: editedFrame.name })}</p>}
      </div>}
      <div className="wizards-row wizards-actions">
        <button type="button" className="action-button" data-wizard-prepare disabled={!ready || pending || running} onClick={() => prepare()}>{t('wizards.prepare')}</button>
        <button type="button" className="action-button" data-wizard-run disabled={!ready || pending || running || !runnable} title={runBlocked || undefined} onClick={() => prepare(true)}>{t(clip ? 'wizards.video.frameRun' : 'wizards.run')}</button>
        {clip && <button type="button" className="action-button" data-wizard-video-run-both disabled={!ready || pending || running || !runnable || !!videoBlocked || chain !== null} title={videoBlocked || runBlocked || undefined} onClick={runBoth}>{t('wizards.video.runBoth')}</button>}
        {clip && editedFrame && <button type="button" className="action-button" data-wizard-video-run-step disabled={pending || running || !!videoBlocked || chain !== null} title={videoBlocked || undefined} onClick={() => sendVideo(editedFrame)}>{t('wizards.video.runVideo')}</button>}
        {running && run?.job && <button type="button" className="forge-ghost" data-wizard-stop onClick={() => { const job = run?.job; if (job) void stopWorkbenchJob(job).catch(e => setError(e instanceof Error ? e.message : String(e))); }}>{t('wizards.run.stop')}</button>}
        {!running && <span className="forge-note">{t('wizards.prepareNote')}</span>}
      </div>
      {run && <div className="wizards-run" data-wizard-run-state={run.state} role="status">
        <p className="forge-note" data-wizard-run-status>{run.masking ? t('wizards.run.masking') : !run.job && run.error ? t('wizards.run.notRun') : run.state === 'running' ? (run.max ? t('wizards.run.running', { value: String(run.value ?? 0), max: String(run.max) }) : t('wizards.run.drawing')) : t(run.state === 'succeeded' && run.picture?.video ? 'wizards.run.videoSucceeded' : `wizards.run.${run.state}`)}</p>
        {chain !== null && running && <p className="forge-note" data-wizard-chain>{t('wizards.video.chained')}</p>}
        {run.preview && running && <img className="wizards-preview" src={run.preview} alt=""/>}
        {run.picture && <figure className="wizards-result">
          {run.picture.video ? <video src={convertFileSrc(run.picture.path)} controls preload="metadata" data-wizard-result-video/>
            : <img src={convertFileSrc(run.picture.path)} alt={strategy ? strategyPrompt(strategy, fields, withObject).slice(0, 160) : t('wizards.title')}/>}
          <figcaption>{[`${run.picture.width}×${run.picture.height}`, run.picture.checkpoint.replace(/\.(safetensors|gguf|ckpt)$/i, ''), t('wizards.run.seed', { seed: String(run.picture.seed) }), run.picture.ms ? `${(run.picture.ms / 1000).toFixed(1)} s` : ''].filter(Boolean).join(' · ')}</figcaption>
        </figure>}
        {(run.picture || run.error) && onOpenGenerate && <button type="button" className="forge-ghost" data-wizard-open onClick={onOpenGenerate}>{t('wizards.run.open')}</button>}
        {run.error && <p className="error-message" role="alert" data-wizard-run-error>{run.error}</p>}
      </div>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {outcome?.error && outcome.n === handoff && <p className="error-message" role="alert" data-wizard-outcome>{outcome.error}</p>}
    </div>}
  </section>;
}
