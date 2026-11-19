// How the levels below the top zoom are made.
// - "pixel": every level is drawn from the source with nearest-neighbour sampling (sharp pixel art).
// - "smooth": every level is the level above it shrunk by an exact 2x2 box average, weighted by alpha.
// The math here is pure integer code (no canvas, no DOM), so the browser and the command-line cutter produce the same
// pixels from the same source pixels.
export type DownscaleMode = "pixel" | "smooth";

export const DOWNSCALE_MODES: readonly DownscaleMode[] = ["pixel", "smooth"];

export const DEFAULT_DOWNSCALE_MODE: DownscaleMode = "pixel";

export type Rgba = readonly [r: number, g: number, b: number, a: number];

type Pixels = Uint8Array | Uint8ClampedArray;

// averages the four RGBA pixels at the offsets i0..i3 of src into out at o. Weighting by alpha is averaging the
// premultiplied colours and dividing by the averaged alpha, done exactly: no premultiplied value is rounded on the way.
// - alpha = round(sum of alphas / 4)
// - colour = round(sum of colour * alpha / sum of alphas)
// Rounding is half up. A result whose alpha rounds to 0 is written as 0, 0, 0, 0 (no hidden colour), which is also what
// a canvas hands back for a fully transparent pixel.
function average_into(src: Pixels, i0: number, i1: number, i2: number, i3: number, out: Pixels, o: number): void {
  const a0 = src[i0 + 3];
  const a1 = src[i1 + 3];
  const a2 = src[i2 + 3];
  const a3 = src[i3 + 3];
  const sum_a = a0 + a1 + a2 + a3;

  if (sum_a < 2) {
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    return;
  }

  if (sum_a === 1020) {
    // all four opaque: the weighted formula reduces to round(sum / 4), the common case on a map
    out[o] = (src[i0] + src[i1] + src[i2] + src[i3] + 2) >> 2;
    out[o + 1] = (src[i0 + 1] + src[i1 + 1] + src[i2 + 1] + src[i3 + 1] + 2) >> 2;
    out[o + 2] = (src[i0 + 2] + src[i1 + 2] + src[i2 + 2] + src[i3 + 2] + 2) >> 2;
    out[o + 3] = 255;
    return;
  }

  // round(n / sum_a) half up = floor((2n + sum_a) / (2 sum_a)); every value stays far below 2^53, so the division is
  // exact enough for floor
  const den = 2 * sum_a;
  for (let c = 0; c < 3; c++) {
    const n = src[i0 + c] * a0 + src[i1 + c] * a1 + src[i2 + c] * a2 + src[i3 + c] * a3;
    out[o + c] = Math.floor((2 * n + sum_a) / den);
  }
  out[o + 3] = (sum_a + 2) >> 2;
}

// the 2x2 box average of four RGBA pixels (top left, top right, bottom left, bottom right; channels 0-255)
export function average_2x2(top_left: Rgba, top_right: Rgba, bottom_left: Rgba, bottom_right: Rgba): Rgba {
  const src = new Uint8Array(16);
  [top_left, top_right, bottom_left, bottom_right].forEach((pixel, i) => {
    pixel.forEach((value, c) => {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(`average_2x2: channel values must be integers 0-255, got ${value}`);
      }
      src[i * 4 + c] = value;
    });
  });
  const out = new Uint8Array(4);
  average_into(src, 0, 4, 8, 12, out, 0);
  return [out[0], out[1], out[2], out[3]];
}

// shrinks an RGBA image (row-major, 4 bytes a pixel) of even width and height to half its size with average_2x2 per
// 2x2 block. A band of rows is an image of its own (src.subarray of whole rows, an even row count), so a large level
// can be shrunk band by band into out.subarray of the matching output rows.
export function downscale_2x(
  src: Pixels,
  width: number,
  height: number,
  out: Uint8ClampedArray = new Uint8ClampedArray((width / 2) * (height / 2) * 4)
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new RangeError(`downscale_2x: width and height must be integers of at least 2, got ${width}x${height}`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`downscale_2x: width and height must be even, got ${width}x${height}`);
  }
  if (src.length < width * height * 4) {
    throw new RangeError(`downscale_2x: ${src.length} bytes cannot hold a ${width}x${height} RGBA image`);
  }
  const out_width = width / 2;
  const out_height = height / 2;
  if (out.length < out_width * out_height * 4) {
    throw new RangeError(`downscale_2x: the output (${out.length} bytes) cannot hold ${out_width}x${out_height} pixels`);
  }

  const row_bytes = width * 4;
  for (let y = 0; y < out_height; y++) {
    const top = 2 * y * row_bytes;
    const bottom = top + row_bytes;
    let o = y * out_width * 4;
    for (let x = 0; x < out_width; x++) {
      const left = x * 8;
      average_into(src, top + left, top + left + 4, bottom + left, bottom + left + 4, out, o);
      o += 4;
    }
  }
  return out;
}
