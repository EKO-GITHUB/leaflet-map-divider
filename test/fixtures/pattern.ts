// Test images for the tile cutter. Every pixel is a pure function of its position, so any region of a pattern can be
// rendered on its own and compared with a tile cut from the full image.
//
// Layout of a pattern (width x height):
//   - left half (x < noise_width): noise, an RGB hash of (x, y, seed). Incompressible, and every downscale mode gives
//     a different result on it, so it tells averaged and sampled levels apart.
//   - right half: 2x2 blocks. Each block has one colour, the position code of the block (below), so a 2x downscale is
//     the same in every mode and a tile shows where it was cut from.
//   - bottom-right corner (corner x corner px): fully transparent (all four channels 0).
// Every other pixel is opaque.
//
// Position code of block (bx, by) = (x >> 1, y >> 1): R = bx & 255, G = by & 255, B = (bx >> 8 & 15) << 4 | (by >> 8
// & 15). It is exact up to 4096 blocks (8192 px) per side and wraps beyond.

export interface PatternSpec {
  name: string;
  width: number;
  height: number;
  /** Width of the noise half (even), counted from the left edge. */
  noise_width: number;
  /** Side of the transparent bottom-right square. */
  corner: number;
  seed: number;
}

export const DEFAULT_SEED = 1;

export function pattern_spec(width: number, height: number = width, options: { corner?: number; seed?: number } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error(`pattern size must be whole numbers of at least 2 px, got ${width}x${height}`);
  }
  const corner = options.corner ?? Math.floor(Math.min(width, height) / 4);
  if (!Number.isInteger(corner) || corner < 0 || corner > Math.min(width, height)) {
    throw new Error(`corner ${corner} does not fit a ${width}x${height} pattern`);
  }
  const spec: PatternSpec = {
    name: width === height ? `pattern-${width}` : `pattern-${width}x${height}`,
    width,
    height,
    noise_width: Math.floor(width / 4) * 2,
    corner,
    seed: options.seed ?? DEFAULT_SEED,
  };
  return spec;
}

/** The two fixtures of the plan: the 1024 px (z3, 128 px tiles) and 1632 px (z3, 204 px tiles) patterns. */
export const FIXTURE_PATTERNS = [pattern_spec(1024), pattern_spec(1632)] as const;

function hash32(x: number, y: number, seed: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function is_transparent_pixel(spec: PatternSpec, x: number, y: number) {
  return x >= spec.width - spec.corner && y >= spec.height - spec.corner;
}

export function is_noise_pixel(spec: PatternSpec, x: number) {
  return x < spec.noise_width;
}

/** Writes the RGBA of pixel (x, y) into out at offset. */
export function write_pattern_pixel(spec: PatternSpec, x: number, y: number, out: Uint8Array | Uint8ClampedArray, offset: number) {
  if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) {
    throw new Error(`pixel ${x},${y} is outside the ${spec.width}x${spec.height} pattern`);
  }
  if (is_transparent_pixel(spec, x, y)) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  if (is_noise_pixel(spec, x)) {
    const h = hash32(x, y, spec.seed);
    out[offset] = h & 255;
    out[offset + 1] = (h >>> 8) & 255;
    out[offset + 2] = (h >>> 16) & 255;
  } else {
    const bx = x >> 1;
    const by = y >> 1;
    out[offset] = bx & 255;
    out[offset + 1] = by & 255;
    out[offset + 2] = (((bx >> 8) & 15) << 4) | ((by >> 8) & 15);
  }
  out[offset + 3] = 255;
}

export function pattern_pixel(spec: PatternSpec, x: number, y: number): [number, number, number, number] {
  const out = new Uint8Array(4);
  write_pattern_pixel(spec, x, y, out, 0);
  return [out[0], out[1], out[2], out[3]];
}

/** RGBA of the region (left, top, width, height), row by row. Defaults to the whole pattern. */
export function render_pattern(
  spec: PatternSpec,
  region: { left: number; top: number; width: number; height: number } = {
    left: 0,
    top: 0,
    width: spec.width,
    height: spec.height,
  },
) {
  const data = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    for (let col = 0; col < region.width; col++) {
      write_pattern_pixel(spec, region.left + col, region.top + row, data, (row * region.width + col) * 4);
    }
  }
  return data;
}

/** One row of the pattern as RGBA (for streaming writers). */
export function render_pattern_row(spec: PatternSpec, y: number, out = new Uint8Array(spec.width * 4)) {
  for (let x = 0; x < spec.width; x++) write_pattern_pixel(spec, x, y, out, x * 4);
  return out;
}

/** The top-left pixel of the block a block-half pixel belongs to, read back from its colour (modulo 8192). */
export function decode_block_position(r: number, g: number, b: number) {
  const bx = r | ((b >> 4) << 8);
  const by = g | ((b & 15) << 8);
  return { x: bx * 2, y: by * 2 };
}
