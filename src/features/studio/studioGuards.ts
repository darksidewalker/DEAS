/** Small pure guards shared by Generate's preferences and the wizard hand-over. */
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isMaskGrow = (v: unknown): v is number => isNumber(v) && Number.isInteger(v) && v >= 0 && v <= 512;
export const isMaskBlur = (v: unknown): v is number => isMaskGrow(v) && v <= 31;
export const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
