// The checker: compares decoded tile pixels with the pattern region they should hold.

export type Rgba = [number, number, number, number];

export interface RgbaMismatch {
  x: number;
  y: number;
  actual: Rgba;
  expected: Rgba;
}

export interface RgbaComparison {
  mismatched_pixels: number;
  first_mismatch: RgbaMismatch | null;
}

/**
 * Counts the pixels of two RGBA images of one size that differ by more than `tolerance` in a channel. Fully
 * transparent pixels match whatever their RGB (canvases and encoders drop it), unless `compare_transparent_rgb`.
 */
export function compare_rgba(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  width: number,
  options: { tolerance?: number; compare_transparent_rgb?: boolean } = {},
): RgbaComparison {
  if (actual.length !== expected.length) {
    throw new Error(`sizes differ: ${actual.length} bytes against ${expected.length}`);
  }
  const tolerance = options.tolerance ?? 0;
  let mismatched_pixels = 0;
  let first_mismatch: RgbaMismatch | null = null;
  for (let i = 0; i < actual.length; i += 4) {
    if (actual[i + 3] === 0 && expected[i + 3] === 0 && !options.compare_transparent_rgb) continue;
    let differs = false;
    for (let c = 0; c < 4; c++) {
      if (Math.abs(actual[i + c] - expected[i + c]) > tolerance) differs = true;
    }
    if (!differs) continue;
    mismatched_pixels++;
    if (!first_mismatch) {
      const p = i / 4;
      const pixel = (data: ArrayLike<number>): Rgba => [data[i], data[i + 1], data[i + 2], data[i + 3]];
      first_mismatch = { x: p % width, y: Math.floor(p / width), actual: pixel(actual), expected: pixel(expected) };
    }
  }
  return { mismatched_pixels, first_mismatch };
}
