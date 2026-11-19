// An independent reference for the smooth downscale: floating-point premultiplied averaging (premultiply, average,
// unpremultiply), rounded per level. It shares no code with src/services/downscale.ts, so the tests compare two
// implementations of the same rule.

export type AlphaMode = "opaque" | "random" | "sparse";

// a 32-bit hash of (x, y, seed), the same kind the pattern's noise uses
function hash32(x: number, y: number, seed: number) {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

// a 3D-render-like source: noise colours; alpha 255 ("opaque"), any value ("random"), or mostly 0 and 255 with some
// partial values ("sparse", like antialiased edges against transparency)
export function noise_pixel(x: number, y: number, seed: number, alpha: AlphaMode, out: Uint8Array | Uint8ClampedArray, o: number) {
  const h = hash32(x, y, seed);
  out[o] = h & 255;
  out[o + 1] = (h >>> 8) & 255;
  out[o + 2] = (h >>> 16) & 255;
  const a = (h >>> 24) & 255;
  out[o + 3] = alpha === "opaque" ? 255 : alpha === "random" ? a : a < 96 ? 0 : a > 160 ? 255 : a;
}

export function seeded_rgba(width: number, height: number, seed: number, alpha: AlphaMode): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) noise_pixel(x, y, seed, alpha, out, (y * width + x) * 4);
  }
  return out;
}

// rounds a non-negative value that is a fraction with a small denominator, halves up; the epsilon keeps a .5 that
// floating point computed as .49999... from rounding down
function round_half_up(value: number) {
  return Math.floor(value + 0.5 + 1e-9);
}

export function reference_downscale(src: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out_width = width / 2;
  const out = new Uint8Array(out_width * (height / 2) * 4);
  for (let y = 0; y < height / 2; y++) {
    for (let x = 0; x < out_width; x++) {
      const offsets = [
        ((2 * y) * width + 2 * x) * 4,
        ((2 * y) * width + 2 * x + 1) * 4,
        ((2 * y + 1) * width + 2 * x) * 4,
        ((2 * y + 1) * width + 2 * x + 1) * 4
      ];
      const alphas = offsets.map(i => src[i + 3] / 255);
      const mean_alpha = alphas.reduce((sum, a) => sum + a, 0) / 4;
      const o = (y * out_width + x) * 4;
      const alpha = round_half_up(mean_alpha * 255);
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c++) {
        const mean_premultiplied = offsets.reduce((sum, i, k) => sum + (src[i + c] / 255) * alphas[k], 0) / 4;
        out[o + c] = round_half_up((mean_premultiplied / mean_alpha) * 255);
      }
      out[o + 3] = alpha;
    }
  }
  return out;
}

// the smooth pyramid of a square source: levels[0] is the source, levels[k] the source halved k times
export function reference_pyramid(
  src: Uint8Array | Uint8ClampedArray,
  size: number,
  steps: number
): { data: Uint8Array | Uint8ClampedArray; size: number }[] {
  const levels: { data: Uint8Array | Uint8ClampedArray; size: number }[] = [{ data: src, size }];
  for (let k = 0; k < steps; k++) {
    const above = levels[levels.length - 1];
    levels.push({ data: reference_downscale(above.data, above.size, above.size), size: above.size / 2 });
  }
  return levels;
}

// the tile (x, y) of a level, tile x tile pixels
export function crop(
  level: { data: Uint8Array | Uint8ClampedArray; size: number },
  x: number,
  y: number,
  tile: number
): Uint8Array {
  const out = new Uint8Array(tile * tile * 4);
  for (let row = 0; row < tile; row++) {
    const from = ((y * tile + row) * level.size + x * tile) * 4;
    out.set(level.data.subarray(from, from + tile * 4), row * tile * 4);
  }
  return out;
}
