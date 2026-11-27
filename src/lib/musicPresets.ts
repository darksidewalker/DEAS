/**
 * Movie Maker music presets: instrumental starting points for the music bed, as data (`src/wizards/musicPresets.json`) so new ones are
 * added without code. Each preset carries its text in two dialects — ACE-Step tags and a YuE2 Style line (which begins with
 * *Instrumental* and ends with *no vocals*, as the DaSiWa YuE2 instrumental writer does) — and a tempo for ACE-Step's BPM control.
 * Invalid entries are dropped, never half-used.
 */
import data from '../wizards/musicPresets.json' with { type: 'json' };

export interface MusicPreset { id: string; name: Record<string, string>; bpm: number; ace: string; yue2: string }
/** ACE-Step's BPM bounds (`aceStepData.json` → `bpm`). */
export const MUSIC_BPM = [10, 300] as const;
const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

/** The preset when it is usable: an id, an English name, both dialect texts and a whole BPM inside ACE-Step's bounds. */
export function musicPresetProblem(p: unknown): string | undefined {
  const v = p as Partial<MusicPreset> | null;
  if (!v || typeof v !== 'object') return 'not an object';
  if (typeof v.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(v.id)) return 'bad id';
  if (!v.name || typeof v.name !== 'object' || !text(v.name.en, 80) || Object.values(v.name).some(n => !text(n, 80))) return `${v.id}: needs a name (at least "en")`;
  if (!Number.isInteger(v.bpm) || (v.bpm as number) < MUSIC_BPM[0] || (v.bpm as number) > MUSIC_BPM[1]) return `${v.id}: bad bpm`;
  if (!text(v.ace, 1000) || !text(v.yue2, 1000)) return `${v.id}: needs "ace" and "yue2" text`;
  return undefined;
}
/** The usable presets, in file order (later duplicates of an id are dropped). */
export function loadMusicPresets(raw: unknown = data): MusicPreset[] {
  const list = (raw as { presets?: unknown[] } | null)?.presets;
  if (!Array.isArray(list)) return [];
  const out: MusicPreset[] = [];
  for (const p of list) if (!musicPresetProblem(p) && !out.some(x => x.id === (p as MusicPreset).id)) out.push(p as MusicPreset);
  return out;
}
export const MUSIC_PRESETS = loadMusicPresets();
export const musicPreset = (id: string | undefined) => (id ? MUSIC_PRESETS.find(p => p.id === id) : undefined);
/** Which dialect a music model reads: YuE2 its Style line, every ACE-Step family the tags. */
export const presetDialect = (family: string | null | undefined): 'ace' | 'yue2' => family === 'yue2' ? 'yue2' : 'ace';
export const presetName = (p: MusicPreset, locale: string) => p.name[locale] ?? p.name[locale.split('-')[0]] ?? p.name.en;
/**
 * The style text for a model: a preset's own text in that model's dialect when the music still reads exactly like the preset (in either
 * dialect), otherwise the user's text unchanged — an edited preset text is never replaced.
 */
export function styleFor(style: string, presetId: string | undefined, family: string | null | undefined): string {
  const p = musicPreset(presetId);
  if (!p) return style;
  const s = style.trim();
  return s === p.ace || s === p.yue2 ? p[presetDialect(family)] : style;
}
