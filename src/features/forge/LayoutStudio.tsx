import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { forgeError, layoutRewrite } from '../../lib/forge';
import { isString, usePref } from '../../lib/preferences';

/**
 * The MOSS Layout Studio (after Azmagane's MOSS Layout Studio, as PromptForge embeds it): boxes on a canvas, each with
 * what it holds, written out as MOSS's Layout JSON — centred `yxyx` coordinates on the canvas the picture will be made
 * at. Boxes drawn here are kept exactly by Generate JSON; the model only writes their captions.
 */

export interface LayoutItem { id: string; name: string; label: 'object' | 'text'; caption: string; text: string; color: string; x: number; y: number; w: number; h: number }
export interface LayoutProject { w: number; h: number; caption: string; meta: string; items: LayoutItem[] }

const PALETTE = ['#52e0c4', '#bb9aff', '#ffc16e', '#80b7ff', '#ff8aa7', '#e3e5ec', '#759378', '#ad846d'];
const MAX_ITEMS = 100;
const MEDIA = ['illustration', 'poster', 'photo'];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const uid = () => crypto.randomUUID();
export const blankProject = (w = 1024, h = 1024): LayoutProject => ({ w, h, caption: '', meta: 'illustration', items: [] });

function fit(b: { x: number; y: number; w: number; h: number }, W: number, H: number) {
  const x = clamp(Math.round(b.x), 0, W - 1), y = clamp(Math.round(b.y), 0, H - 1);
  return { x, y, w: clamp(Math.round(b.w), 1, W - x), h: clamp(Math.round(b.h), 1, H - y) };
}
function resized(o: LayoutItem, edge: string, dx: number, dy: number, W: number, H: number) {
  let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
  if (edge.includes('w')) l = clamp(o.x + dx, 0, r - 1);
  if (edge.includes('e')) r = clamp(o.x + o.w + dx, l + 1, W);
  if (edge.includes('n')) t = clamp(o.y + dy, 0, b - 1);
  if (edge.includes('s')) b = clamp(o.y + o.h + dy, t + 1, H);
  return { x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t) };
}

/** MOSS's Layout JSON for the project: centred coordinates, `[y0, x0, y1, x1]`. */
export function exportLayout(p: LayoutProject) {
  return {
    summary: { meta: p.meta.split(',').map(t => t.trim()).filter(Boolean), canvas: 'single', caption: p.caption.trim() },
    items: p.items.map(i => {
      const b = fit(i, p.w, p.h);
      return { label: i.label, caption: i.caption.trim(), bbox: [b.y - p.h / 2, b.x - p.w / 2, b.y + b.h - p.h / 2, b.x + b.w - p.w / 2], ...(i.label === 'text' ? { text: i.text } : {}) };
    }),
    bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
  };
}

/** The boxes as Generate JSON sends them: the names say what each box is for. */
export const forPrompt = (p: LayoutProject) => {
  const o = exportLayout(p);
  return { width: p.w, height: p.h, items: o.items.map((i, n) => ({ name: p.items[n].name, ...i })) };
};

/** A written Layout JSON back onto the canvas. Same boxes: only the words change; otherwise the boxes are replaced. */
export function applyGenerated(p: LayoutProject, raw: string): LayoutProject {
  const o = JSON.parse(raw);
  if (!o || !Array.isArray(o.items)) throw new Error('not a layout');
  const items: LayoutItem[] = o.items.slice(0, MAX_ITEMS).filter((i: { bbox?: unknown }) => Array.isArray(i?.bbox) && i.bbox.length === 4).map((i: { label?: string; caption?: string; text?: string; bbox: number[] }, n: number) => {
    const [y1, x1, y2, x2] = i.bbox.map(Number);
    const label = i.label === 'text' ? 'text' : 'object';
    const caption = String(i.caption ?? '');
    const name = label === 'text' && i.text ? `Text · ${String(i.text).slice(0, 24)}` : caption.split(/\s+/).slice(0, 4).join(' ').replace(/[,.;:]$/, '') || `Box ${n + 1}`;
    return { id: uid(), name, label, caption, text: String(i.text ?? ''), color: PALETTE[n % PALETTE.length], ...fit({ x: x1 + p.w / 2, y: y1 + p.h / 2, w: x2 - x1, h: y2 - y1 }, p.w, p.h) };
  });
  const same = items.length === p.items.length && items.every((n, k) => { const o2 = p.items[k]; return o2.label === n.label && (['x', 'y', 'w', 'h'] as const).every(d => Math.abs(o2[d] - n[d]) <= 1); });
  const meta = Array.isArray(o.summary?.meta) ? o.summary.meta.join(', ') : typeof o.summary?.meta === 'string' ? o.summary.meta : p.meta;
  const caption = typeof o.summary?.caption === 'string' ? o.summary.caption : p.caption;
  return same
    ? { ...p, caption, meta, items: p.items.map((it, k) => ({ ...it, caption: items[k].caption, ...(it.label === 'text' ? { text: items[k].text } : {}) })) }
    : { ...p, caption, meta, items };
}

/** A new canvas size with the boxes scaled to match. */
export function resizeProject(p: LayoutProject, w: number, h: number): LayoutProject {
  if (p.w === w && p.h === h) return p;
  const sx = w / p.w, sy = h / p.h;
  return { ...p, w, h, items: p.items.map(i => ({ ...i, ...fit({ x: i.x * sx, y: i.y * sy, w: i.w * sx, h: i.h * sy }, w, h) })) };
}

const isProject = (v: unknown): v is LayoutProject => {
  const p = v as LayoutProject;
  return !!p && typeof p === 'object' && Number.isFinite(p.w) && Number.isFinite(p.h) && typeof p.caption === 'string' && typeof p.meta === 'string' && Array.isArray(p.items) && p.items.length <= MAX_ITEMS
    && p.items.every(i => i && typeof i.id === 'string' && typeof i.caption === 'string' && ['x', 'y', 'w', 'h'].every(k => Number.isFinite((i as unknown as Record<string, number>)[k])));
};

/** The project, remembered per browser, with undo and redo. Typing groups into one step. */
export function useLayoutProject() {
  const [project, setProject] = usePref<LayoutProject>('forge.layout.project', blankProject(), isProject);
  const [past, setPast] = useState<LayoutProject[]>([]);
  const [future, setFuture] = useState<LayoutProject[]>([]);
  const typing = useRef<number | null>(null);
  const set = useCallback((next: LayoutProject, group = false) => {
    if (next === project) return;
    if (!group || typing.current === null) setPast(p => [...p.slice(-39), project]);
    if (group) { if (typing.current !== null) clearTimeout(typing.current); typing.current = window.setTimeout(() => { typing.current = null; }, 600); }
    setFuture([]); setProject(next);
  }, [project, setProject]);
  const undo = () => { const last = past.at(-1); if (!last) return; setPast(past.slice(0, -1)); setFuture([project, ...future]); setProject(last); };
  const redo = () => { const next = future[0]; if (!next) return; setFuture(future.slice(1)); setPast([...past, project]); setProject(next); };
  return { project, set, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}

type Gesture = { kind: 'move' | 'resize' | 'draw'; ax: number; ay: number; before: LayoutProject; original?: LayoutItem; edge?: string; id?: string; bx?: number; by?: number };

export function LayoutStudio({ root, model, studio, busy }: { root?: string; model: string; studio: ReturnType<typeof useLayoutProject>; busy: boolean }) {
  const { t } = useI18n();
  const { project: p, set } = studio;
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'box'>('select');
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [live, setLive] = useState<LayoutProject | null>(null);
  const [full, setFull] = usePref('forge.layout.full', false, (v): v is boolean => typeof v === 'boolean');
  const [rewriting, setRewriting] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [metaOther, setMetaOther] = usePref('forge.layout.metaOther', '', isString);
  const svg = useRef<SVGSVGElement>(null);
  const shown = live ?? p;
  const item = shown.items.find(i => i.id === selected);
  const json = JSON.stringify(exportLayout(shown), null, 2);

  const point = (e: { clientX: number; clientY: number }) => {
    const b = svg.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - b.left) / b.width * p.w, 0, p.w), y: clamp((e.clientY - b.top) / b.height * p.h, 0, p.h) };
  };
  const newItem = (label: 'object' | 'text', b?: { x: number; y: number; w: number; h: number }): LayoutItem => ({
    id: uid(), name: `${t(label === 'text' ? 'forge.layout.text' : 'forge.layout.box')} ${p.items.length + 1}`, label, caption: '', text: '',
    color: PALETTE[p.items.length % PALETTE.length], ...fit(b ?? { x: p.w * .15, y: p.h * .15, w: p.w * .3, h: p.h * .3 }, p.w, p.h),
  });
  const add = (label: 'object' | 'text') => {
    if (p.items.length >= MAX_ITEMS) return setError(t('forge.layout.max'));
    const i = newItem(label); set({ ...p, items: [...p.items, i] }); setSelected(i.id); setTool('select');
  };
  const change = (id: string, patch: Partial<LayoutItem>, group = false) => set({ ...p, items: p.items.map(i => i.id === id ? { ...i, ...patch } : i) }, group);
  const remove = () => { if (!selected) return; set({ ...p, items: p.items.filter(i => i.id !== selected) }); setSelected(null); };

  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const a = point(e);
    try { svg.current?.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks: the gesture still works inside the canvas */ }
    if (tool === 'box') { if (p.items.length < MAX_ITEMS) setGesture({ kind: 'draw', ax: a.x, ay: a.y, before: p, bx: a.x, by: a.y }); return; }
    const target = e.target as Element;
    const g = target.closest('[data-layout-id]');
    if (!g) { setSelected(null); return; }
    const id = g.getAttribute('data-layout-id')!;
    setSelected(id);
    const original = p.items.find(i => i.id === id)!;
    const edge = target.getAttribute('data-handle') ?? '';
    setGesture({ kind: edge ? 'resize' : 'move', ax: a.x, ay: a.y, before: p, original, edge, id });
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!gesture) return;
    const a = point(e), dx = a.x - gesture.ax, dy = a.y - gesture.ay;
    if (gesture.kind === 'draw') { setGesture({ ...gesture, bx: a.x, by: a.y }); return; }
    const o = gesture.original!;
    const next = gesture.kind === 'move'
      ? { x: Math.round(clamp(o.x + dx, 0, p.w - o.w)), y: Math.round(clamp(o.y + dy, 0, p.h - o.h)) }
      : resized(o, gesture.edge!, dx, dy, p.w, p.h);
    setLive({ ...p, items: p.items.map(i => i.id === o.id ? { ...i, ...next } : i) });
  };
  const up = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!gesture) return;
    try { if (svg.current?.hasPointerCapture(e.pointerId)) svg.current.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (gesture.kind === 'draw') {
      const a = point(e);
      if (Math.abs(a.x - gesture.ax) >= 4 && Math.abs(a.y - gesture.ay) >= 4) {
        const i = newItem('object', { x: Math.min(a.x, gesture.ax), y: Math.min(a.y, gesture.ay), w: Math.abs(a.x - gesture.ax), h: Math.abs(a.y - gesture.ay) });
        set({ ...p, items: [...p.items, i] }); setSelected(i.id); setTool('select');
      }
    } else if (live) set(live);
    setLive(null); setGesture(null);
  };

  // Keys act on the canvas only, never while typing in a field.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element)?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!(e.target as Element)?.closest?.('[data-layout-studio]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) studio.redo(); else studio.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); studio.redo(); return; }
      if (!item) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); change(item.id, { x: clamp(item.x + d[0], 0, p.w - item.w), y: clamp(item.y + d[1], 0, p.h - item.h) }, true); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const rewrite = async (task: 'scene' | 'item') => {
    if (!root) return;
    const description = task === 'item' ? (item?.caption || item?.name || '') : p.caption;
    if (!description.trim()) return setError(t('forge.layout.rewriteEmpty'));
    setRewriting(task); setError('');
    const layout = exportLayout(p);
    const index = item ? p.items.indexOf(item) : -1;
    try {
      const text = await layoutRewrite(root, model, { task, width: p.w, height: p.h, layout, description,
        element: task === 'item' && item ? { name: item.name, label: item.label, caption: item.caption, text: item.text, bbox: layout.items[index].bbox } : null });
      if (task === 'scene') set({ ...p, caption: text });
      else if (item) change(item.id, { caption: text });
    } catch (e) { setError(forgeError(e)); }
    finally { setRewriting(''); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError('forge.copyFailed'); } };

  const metaListed = MEDIA.includes(p.meta.trim());
  const draft = gesture?.kind === 'draw' ? { x: Math.min(gesture.ax, gesture.bx!), y: Math.min(gesture.ay, gesture.by!), w: Math.abs(gesture.bx! - gesture.ax), h: Math.abs(gesture.by! - gesture.ay) } : null;
  const handle = 10 * Math.max(p.w, p.h) / 700;
  const missing = shown.items.filter(i => !i.caption.trim()).length;

  return <div className={`forge-card forge-layout${full ? ' full' : ''}`} data-layout-studio tabIndex={-1}>
    <div className="forge-card-head">
      <h3 className="forge-card-title">{t('forge.layout.title')}</h3>
      <span className="forge-note">{`${p.w} × ${p.h} · ${t('forge.layout.count', { count: String(p.items.length) })}`}</span>
      <div className="forge-actions">
        <button type="button" className="forge-ghost" data-layout-undo disabled={!studio.canUndo} title="Ctrl+Z" onClick={studio.undo}>↶</button>
        <button type="button" className="forge-ghost" data-layout-redo disabled={!studio.canRedo} title="Ctrl+Y" onClick={studio.redo}>↷</button>
        <button type="button" className="forge-ghost" data-layout-full onClick={() => setFull(!full)}>{t(full ? 'forge.layout.exitFull' : 'forge.layout.full')}</button>
      </div>
    </div>
    <label className="forge-field"><span>{t('forge.layout.global')} <em>{t('forge.layout.globalHint')}</em></span>
      <textarea className="forge-layout-caption" data-layout-caption value={p.caption} maxLength={30000} onChange={e => set({ ...p, caption: e.target.value }, true)}/></label>
    <div className="forge-layout-row">
      <label className="forge-field"><span>{t('forge.layout.medium')}</span>
        <select data-layout-meta value={metaListed ? p.meta.trim() : 'other'} onChange={e => set({ ...p, meta: e.target.value === 'other' ? metaOther : e.target.value })}>
          {MEDIA.map(m => <option key={m} value={m}>{t(`forge.layout.media.${m}`)}</option>)}
          <option value="other">{t('forge.layout.media.other')}</option>
        </select></label>
      {!metaListed && <label className="forge-field"><span>{t('forge.layout.mediumOther')}</span><input type="text" data-layout-meta-other value={p.meta} placeholder="comic, 3d render" onChange={e => { setMetaOther(e.target.value); set({ ...p, meta: e.target.value }, true); }}/></label>}
      <button type="button" className="forge-ghost" data-layout-rewrite-scene disabled={!!rewriting || busy || !root} onClick={() => void rewrite('scene')}>{t(rewriting === 'scene' ? 'forge.layout.rewriting' : 'forge.layout.rewriteScene')}</button>
    </div>
    <div className="forge-layout-tools">
      <div className="forge-seg">
        <button type="button" aria-pressed={tool === 'select'} data-layout-tool="select" onClick={() => setTool('select')}>{t('forge.layout.select')}</button>
        <button type="button" aria-pressed={tool === 'box'} data-layout-tool="box" onClick={() => setTool('box')}>{t('forge.layout.draw')}</button>
      </div>
      <button type="button" className="forge-ghost" data-layout-add="object" onClick={() => add('object')}>＋ {t('forge.layout.box')}</button>
      <button type="button" className="forge-ghost" data-layout-add="text" onClick={() => add('text')}>＋ {t('forge.layout.text')}</button>
    </div>
    <div className="forge-layout-stage" style={{ aspectRatio: `${p.w} / ${p.h}` }}>
      <svg ref={svg} viewBox={`0 0 ${p.w} ${p.h}`} className={tool === 'box' ? 'drawing' : ''} aria-label={t('forge.layout.canvas')} data-layout-canvas
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setLive(null); setGesture(null); }}>
        <rect className="forge-layout-bg" x={0} y={0} width={p.w} height={p.h}/>
        {shown.items.map(i => {
          const on = i.id === selected;
          const handles: [string, number, number][] = [['nw', i.x, i.y], ['n', i.x + i.w / 2, i.y], ['ne', i.x + i.w, i.y], ['e', i.x + i.w, i.y + i.h / 2], ['se', i.x + i.w, i.y + i.h], ['s', i.x + i.w / 2, i.y + i.h], ['sw', i.x, i.y + i.h], ['w', i.x, i.y + i.h / 2]];
          return <g key={i.id} data-layout-id={i.id}>
            <rect className={`forge-layout-box${on ? ' on' : ''}`} x={i.x} y={i.y} width={i.w} height={i.h} fill={`${i.color}22`} stroke={i.color} strokeWidth={on ? handle / 3 : handle / 5}/>
            <text x={i.x + handle / 2} y={i.y + handle * 1.6} fontSize={handle * 1.2} className="forge-layout-label">{i.label === 'text' ? 'T · ' : ''}{i.name}</text>
            {on && tool === 'select' && handles.map(([edge, x, y]) => <rect key={edge} data-handle={edge} className="forge-layout-handle" style={{ cursor: `${edge}-resize` }} x={x - handle / 2} y={y - handle / 2} width={handle} height={handle}/>)}
          </g>;
        })}
        {draft && <rect className="forge-layout-draft" {...draft}/>}
      </svg>
      {!shown.items.length && <p className="forge-layout-empty">{t('forge.layout.empty')}</p>}
    </div>
    <div className="forge-layout-panels">
      <div className="forge-layout-list" role="listbox" aria-label={t('forge.layout.items')}>
        {p.items.map(i => <button key={i.id} type="button" role="option" aria-selected={i.id === selected} data-layout-item={i.name} onClick={() => setSelected(i.id)}>
          <i style={{ background: i.color }}/><span>{i.name}</span><small>{i.label === 'text' ? 'T' : '▢'}{i.caption.trim() ? '' : ' ·'}</small>
        </button>)}
        {!p.items.length && <p className="forge-note">{t('forge.layout.noItems')}</p>}
      </div>
      {item ? <div className="forge-layout-inspector" data-layout-inspector>
        <div className="forge-length">
          <label className="forge-field"><span>{t('forge.layout.name')}</span><input type="text" data-layout-name value={item.name} maxLength={200} onChange={e => change(item.id, { name: e.target.value }, true)}/></label>
          <label className="forge-field"><span>{t('forge.layout.kind')}</span><select data-layout-kind value={item.label} onChange={e => change(item.id, { label: e.target.value as 'object' | 'text' })}>
            <option value="object">{t('forge.layout.kindObject')}</option><option value="text">{t('forge.layout.kindText')}</option></select></label>
        </div>
        <label className="forge-field"><span>{t('forge.layout.caption')}</span><textarea data-layout-item-caption value={item.caption} maxLength={20000} placeholder={t('forge.layout.captionHint')} onChange={e => change(item.id, { caption: e.target.value }, true)}/></label>
        {item.label === 'text' && <label className="forge-field"><span>{t('forge.layout.exactText')}</span><input type="text" data-layout-item-text value={item.text} maxLength={20000} onChange={e => change(item.id, { text: e.target.value }, true)}/></label>}
        <div className="forge-layout-coords">{(['x', 'y', 'w', 'h'] as const).map(k => <label key={k} className="forge-field"><span>{k.toUpperCase()}</span>
          <input type="number" data-layout-coord={k} value={item[k]} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) change(item.id, fit({ ...item, [k]: v }, p.w, p.h), true); }}/></label>)}</div>
        <div className="forge-actions">
          <button type="button" className="forge-ghost" data-layout-rewrite-item disabled={!!rewriting || busy || !root} onClick={() => void rewrite('item')}>{t(rewriting === 'item' ? 'forge.layout.rewriting' : 'forge.layout.rewriteItem')}</button>
          <button type="button" className="forge-ghost" data-layout-duplicate onClick={() => { if (p.items.length >= MAX_ITEMS) return; const c = { ...item, id: uid(), name: `${item.name} · 2`, x: Math.min(item.x + 20, p.w - item.w), y: Math.min(item.y + 20, p.h - item.h) }; set({ ...p, items: [...p.items, c] }); setSelected(c.id); }}>{t('forge.layout.duplicate')}</button>
          <button type="button" className="forge-ghost danger" data-layout-delete onClick={remove}>{t('forge.layout.delete')}</button>
        </div>
      </div> : <p className="forge-note forge-layout-inspector">{t('forge.layout.pick')}</p>}
    </div>
    {(missing > 0 || !p.caption.trim()) && <p className="forge-note">{[missing > 0 && t('forge.layout.missing', { count: String(missing) }), !p.caption.trim() && t('forge.layout.noGlobal')].filter(Boolean).join(' ')}</p>}
    <details className="forge-readback" data-layout-json>
      <summary>{t('forge.layout.json')}</summary>
      <pre>{json}</pre>
    </details>
    <div className="forge-actions">
      <button type="button" className="forge-ghost" data-layout-copy onClick={() => void copy()}>{t(copied ? 'forge.copied' : 'forge.layout.copy')}</button>
      <button type="button" className="forge-ghost" data-layout-clear disabled={!p.items.length && !p.caption} onClick={() => { set(blankProject(p.w, p.h)); setSelected(null); }}>{t('forge.layout.new')}</button>
    </div>
    {error && <p className="error-message" role="alert">{t(error)}</p>}
  </div>;
}
