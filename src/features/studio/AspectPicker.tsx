import type { SelectHTMLAttributes } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { aspects } from '../../lib/resolution';

export type AspectChoice = (typeof aspects)[number];
/** Ratio of a `w:h` choice for the swatch; 1 for `auto`/`custom`/unknown. */
export const aspectRatio = (aspect: string) => { const [w, h] = aspect.split(':').map(Number); return w > 0 && h > 0 ? w / h : 1; };

/**
 * Generate's aspect control (swatch + select over the shared `aspects` list from Settings → resolution). Every surface that asks for an
 * aspect uses this one list; `omit` hides choices a surface cannot honour (e.g. `auto` without a picture, `custom` without size inputs).
 */
export function AspectPicker({ value, onChange, omit = [], ratio, ...select }: { value: string; onChange: (aspect: AspectChoice) => void; omit?: readonly AspectChoice[]; ratio?: number } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const { t } = useI18n();
  const r = ratio ?? aspectRatio(value);
  return <span className="wb-aspect-picker"><span className="wb-aspect-swatch" aria-hidden="true"><span style={{ width: 18 * Math.min(1, r), height: 18 * Math.min(1, 1 / r) }}/></span>
    <select {...select} value={value} onChange={e => onChange(e.target.value as AspectChoice)}>{aspects.filter(a => !omit.includes(a)).map(a => <option key={a} value={a}>{a === 'auto' || a === 'custom' ? t(`studio.run.resolution.${a}`) : a}</option>)}</select></span>;
}
