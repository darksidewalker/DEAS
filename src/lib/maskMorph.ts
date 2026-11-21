/**
 * Grows a mask outward by `radius` pixels (approximately round: a 3-4 chamfer distance transform, within ~8 % of the
 * Euclidean distance). `alpha` is one coverage value 0..255 per pixel; pixels at or above `threshold` are the seed.
 * Grown pixels become fully covered; existing soft values inside the original mask are kept. Pure and allocation-bounded
 * (one Uint16 distance buffer per call), so it runs on the editor's mask before the soft edge is applied downstream.
 */
export function growAlpha(alpha: Uint8ClampedArray | Uint8Array, width: number, height: number, radius: number, threshold = 128): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alpha);
  if (!(radius > 0) || width <= 0 || height <= 0 || alpha.length !== width * height) return out;
  const far = 0xffff, d = new Uint16Array(width * height).fill(far);
  for (let i = 0; i < d.length; i++) if (alpha[i] >= threshold) d[i] = 0;
  const step = (i: number, j: number, cost: number) => { const v = d[j] + cost; if (v < d[i]) d[i] = v; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x; if (!d[i]) continue;
    if (x > 0) step(i, i - 1, 3);
    if (y > 0) { step(i, i - width, 3); if (x > 0) step(i, i - width - 1, 4); if (x < width - 1) step(i, i - width + 1, 4); }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x; if (!d[i]) continue;
    if (x < width - 1) step(i, i + 1, 3);
    if (y < height - 1) { step(i, i + width, 3); if (x < width - 1) step(i, i + width + 1, 4); if (x > 0) step(i, i + width - 1, 4); }
  }
  const limit = radius * 3;
  for (let i = 0; i < d.length; i++) if (d[i] && d[i] <= limit) out[i] = 255;
  return out;
}
