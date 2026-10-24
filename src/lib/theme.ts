import { oneOf, readPref, usePref } from './preferences';

/**
 * Colour schemes, one per OC (owner, 23 Oct 2026). Each is a `data-theme` block in src/themes.css over the colour
 * tokens in src/styles.css; Default is DEAS's own look and sets no attribute. The swatches are the scheme's background
 * and accent, for the picker only.
 */
export const SCHEMES = [
  { id: 'default', name: 'Default', swatch: ['#171b1e', '#7c9cac'] },
  { id: 'liiti-pink', name: 'Liiti Pink', swatch: ['#0f0c10', '#f29cc6'] },
  { id: 'voud', name: 'VOID', swatch: ['#07070a', '#9d8cff'] }, // Keep the persisted ID for existing selections.
  { id: 'alluring-abyss', name: 'Alluring Abyss', swatch: ['#14090c', '#df6678'] },
  { id: 'slimy-teal', name: 'Slimy Teal', swatch: ['#081414', '#2cc7c0'] },
  { id: 'clawy-grey', name: 'Clawy Grey', swatch: ['#1b1c1e', '#b9bcc2'] },
  { id: 'android-white', name: 'Android White', swatch: ['#eef1f5', '#0a84ff'] },
  { id: 'dragons-hoard', name: "Dragon's Hoard", swatch: ['#16110b', '#e3b341'] },
] as const;
export type SchemeId = typeof SCHEMES[number]['id'];
const KEY = 'appearance.scheme';
const valid = oneOf<SchemeId>(...SCHEMES.map(s => s.id));

export function applyScheme(id: SchemeId) {
  const root = document.documentElement;
  if (id === 'default') delete root.dataset.theme;
  else root.dataset.theme = id;
}

/** Before the first paint, so a saved scheme never flashes the default one. */
export const applySavedScheme = () => applyScheme(readPref(KEY, 'default', valid));

export function useScheme() {
  const [scheme, setScheme] = usePref<SchemeId>(KEY, 'default', valid);
  return [scheme, (id: SchemeId) => { applyScheme(id); setScheme(id); }] as const;
}
