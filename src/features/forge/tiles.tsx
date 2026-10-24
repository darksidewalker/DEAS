/**
 * PromptForge's builder pieces: icon tiles, named-notch sliders, folds and chips. The drawings are PromptForge's own
 * (web/app.js ICONS): a small figure and where the camera stands, a frame closing in, a sun where the light is.
 */
import type { CSSProperties, ReactNode } from 'react';

const FIG = '<circle cx="16" cy="4" r="2.6"/><path d="M11.5 15V9.5Q11.5 7.5 13.5 7.5H18.5Q20.5 7.5 20.5 9.5V15M13.5 15V22M18.5 15V22M13.5 11V15H18.5V11"/>';
const CAM = (x: number, y: number, rot: number) => `<g transform="translate(${x} ${y}) rotate(${rot})"><rect x="-3" y="-2" width="5" height="4" rx="0.8"/><path d="M2 -1.3L4.2 -2.4V2.4L2 1.3"/></g>`;
const sight = (x1: number, y1: number, x2: number, y2: number) => `<path class="sight" d="M${x1} ${y1}L${x2} ${y2}"/>`;
const SMALL_FIG = (x: number, y: number, s: number) => `<g transform="translate(${x} ${y}) scale(${s}) translate(-16 -12)">${FIG}</g>`;
const framed = (vb: string, inner = FIG) => `<rect x="1.5" y="1.5" width="29" height="21" rx="2"/><svg x="2" y="2" width="28" height="20" viewBox="${vb}">${inner}</svg>`;
const SUN = (x: number, y: number) => `<g transform="translate(${x} ${y})"><circle r="1.8"/><path d="M0 -3.4V-2.6M0 2.6V3.4M-3.4 0H-2.6M2.6 0H3.4M-2.4 -2.4L-1.9 -1.9M1.9 1.9L2.4 2.4M-2.4 2.4L-1.9 1.9M1.9 -1.9L2.4 -2.4"/></g>`;
const ICONS: Record<string, string> = {
  any: '<rect class="sight" x="4" y="4" width="24" height="16" rx="2"/>',
  eye: SMALL_FIG(23, 12, 0.75) + CAM(5, 9, 0) + sight(10, 9, 18, 9),
  high: SMALL_FIG(23, 14, 0.68) + CAM(5, 4, 35) + sight(9, 7, 18, 10),
  low: SMALL_FIG(23, 10, 0.68) + CAM(5, 20, -35) + sight(9, 17, 18, 14),
  birds: SMALL_FIG(16, 14.5, 0.6) + CAM(16, 2.5, 90) + sight(16, 6.5, 16, 8.5),
  worms: SMALL_FIG(16, 9, 0.6) + CAM(16, 21.5, -90) + sight(16, 17.5, 16, 15.5),
  dutch: `<g transform="rotate(-14 16 12)"><rect x="5" y="3" width="22" height="18" rx="2"/>${SMALL_FIG(16, 12, 0.7)}</g>`,
  shoulder: SMALL_FIG(23, 12, 0.7) + '<circle cx="7" cy="9" r="4"/><path d="M0 24Q1 15 7 15Q13 15 14 24"/>',
  pov: '<path d="M4 12Q16 2 28 12Q16 22 4 12Z"/><circle cx="16" cy="12" r="3.2"/>',
  xwide: framed('-26 -18 84 60'),
  wide: framed('-9.2 -6 50.4 36'),
  full: framed('-0.8 0 33.6 24'),
  medium: framed('4.1 0.5 23.8 17'),
  mclose: framed('8.3 0.5 15.4 11'),
  close: framed('10.4 0.6 11.2 8'),
  xclose: framed('13.9 2.2 4.2 3', '<circle cx="16" cy="4" r="2.6"/><circle class="dot" cx="15.1" cy="3.6" r="0.35"/><circle class="dot" cx="16.9" cy="3.6" r="0.35"/>'),
  insert: '<rect x="1.5" y="1.5" width="29" height="21" rx="2"/><path d="M9 17V10Q9 8.5 10.5 8.5Q12 8.5 12 10V8Q12 6.5 13.5 6.5Q15 6.5 15 8V8.5Q15 7 16.5 7Q18 7 18 8.5V9.5Q18 8 19.5 8Q21 8 21 9.5V15Q21 19 17 19H12Q9 19 9 17Z"/>',
  l_front: SMALL_FIG(16, 12, 0.72) + SUN(27, 19) + sight(24, 17, 19.5, 14),
  l_left: SMALL_FIG(19, 12, 0.72) + SUN(5, 12) + sight(9, 12, 14, 12),
  l_right: SMALL_FIG(13, 12, 0.72) + SUN(27, 12) + sight(23, 12, 18, 12),
  l_side: SMALL_FIG(16, 12, 0.72) + SUN(4, 12) + SUN(28, 12),
  l_back: '<circle class="sight" cx="16" cy="11" r="8"/>' + SMALL_FIG(16, 12, 0.72),
  l_top: SMALL_FIG(16, 14, 0.62) + SUN(16, 3.5) + sight(16, 7, 16, 8),
  l_below: SMALL_FIG(16, 10, 0.62) + SUN(16, 20.5) + sight(16, 17, 16, 16.5),
  l_rim: `<g class="sight">${SMALL_FIG(16, 12, 0.82)}</g>` + SMALL_FIG(16, 12, 0.72),
  l_sil: '<rect x="5" y="3" width="22" height="18" rx="2"/>' + `<g class="fill">${SMALL_FIG(16, 13, 0.62)}</g>`,
};

/** Static drawings from the table above, never user text. */
const Svg = ({ body }: { body: string }) => <svg viewBox="0 0 32 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: body }}/>;
export const icon = (name?: string | null) => <Svg body={ICONS[name ?? ''] ?? ICONS.any}/>;

/** A box in the aspect's own shape, fitted into the tile's drawing area. */
export function aspectIcon(aspect: string) {
  const m = /(\d+)\s*:\s*(\d+)/.exec(aspect);
  if (!m) return icon('any');
  const r = Number(m[1]) / Number(m[2]);
  const w = r >= 28 / 20 ? 28 : 20 * r, h = r >= 28 / 20 ? 28 / r : 20;
  return <Svg body={`<rect x="${(32 - w) / 2}" y="${(24 - h) / 2}" width="${w}" height="${h}" rx="1.5"/>`}/>;
}

/** Columns that split n tiles into even rows (8 → 4 + 4, 9 → 5 + 4), so a row never looks short of a tile. */
const columns = (n: number) => n <= 5 ? n : [4, 5].find(c => n % c === 0) ?? (n === 6 ? 3 : n === 9 ? 5 : 4);

export interface TileOption { key: string; label: string; icon: ReactNode; sub?: string; title?: string }
export function Tiles({ label, options, value, onChange, name }: { label: string; options: TileOption[]; value: string; onChange: (v: string) => void; name: string }) {
  return <div className="forge-group" role="group" aria-label={label}>
    <span className="forge-group-label">{label}</span>
    <div className="forge-tiles" style={{ '--n-cols': columns(options.length) } as CSSProperties}>
      {options.map(o => <button key={o.key} type="button" className="forge-tile" data-forge-tile={`${name}:${o.key}`} aria-pressed={o.key === value} title={o.title} onClick={() => onChange(o.key)}>
        <span className="forge-tile-icon">{o.icon}</span>
        <span className="forge-tile-label">{o.label}</span>
        {o.sub && <span className="forge-tile-sub">{o.sub}</span>}
      </button>)}
    </div>
  </div>;
}

export function Chips({ label, options, value, onChange, name }: { label: string; options: { key: string; label: string }[]; value: string; onChange: (v: string) => void; name: string }) {
  return <div className="forge-group" role="group" aria-label={label}>
    <span className="forge-group-label">{label}</span>
    <div className="forge-chips">{options.map(o => <button key={o.key} type="button" className="forge-chip" data-forge-chip={`${name}:${o.key}`} aria-pressed={o.key === value} onClick={() => onChange(o.key)}>{o.label}</button>)}</div>
  </div>;
}

/** A ladder with a name on every notch: the readout says which, the ends say which way is which. */
export function Ladder({ label, notches, value, onChange, wide, name }: { label: string; notches: [number, string][]; value: number; onChange: (v: number) => void; wide?: boolean; name: string }) {
  if (!notches.length) return null;
  const at = Math.max(0, notches.findIndex(([n]) => n === value));
  const [level, title] = notches[at];
  return <label className={`forge-ladder${wide ? ' wide' : ''}`}>
    <span className="forge-ladder-head"><span>{label}</span><output className="forge-ladder-readout">{level} · {title}</output></span>
    <input type="range" data-forge-ladder={name} aria-label={label} min={0} max={notches.length - 1} value={at} onChange={e => onChange(notches[Number(e.target.value)][0])}/>
    <span className="forge-ladder-ends"><i>{notches[0][1]}</i><i>{notches[notches.length - 1][1]}</i></span>
  </label>;
}

/** A section that folds; closed, its header says what is set inside. Closed is display:none, so nothing is lost. */
export function Fold({ name, title, summary, open, onToggle, children }: { name: string; title: string; summary: string; open: boolean; onToggle: (name: string) => void; children: ReactNode }) {
  return <section className={`forge-fold${open ? ' open' : ''}`} data-forge-fold={name}>
    <button type="button" className="forge-fold-head" aria-expanded={open} onClick={() => onToggle(name)}>
      <span className="forge-fold-title">{title}</span>
      {!open && <span className="forge-fold-summary">{summary}</span>}
    </button>
    <div className="forge-fold-body">{children}</div>
  </section>;
}
