// How the levels below the top zoom are made. Each level is the level above it halved:
// - "pixel": pick_2x keeps the top-left pixel of each 2x2 cell, so a pixel of a level is the source pixel at the top
//   left of the cell it covers, (x * scale, y * scale): nearest-neighbour sampling that keeps pixel art sharp.
// - "smooth": downscale_2x, an exact 2x2 box average weighted by alpha.
// The math here is pure integer code (no canvas, no DOM), so the browser and the command-line cutter produce the same
// pixels from the same source pixels. (A canvas drawImage with smoothing off is not used for the lower levels: its
// nearest-neighbour picks follow no fixed rule.)
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
  check_halving("downscale_2x", src, width, height, out.length);
  const out_width = width / 2;
  const out_height = height / 2;

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

function check_halving(name: string, src: Pixels, width: number, height: number, out_length: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new RangeError(`${name}: width and height must be integers of at least 2, got ${width}x${height}`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`${name}: width and height must be even, got ${width}x${height}`);
  }
  if (src.length < width * height * 4) {
    throw new RangeError(`${name}: ${src.length} bytes cannot hold a ${width}x${height} RGBA image`);
  }
  if (out_length < (width / 2) * (height / 2) * 4) {
    throw new RangeError(`${name}: the output (${out_length} bytes) cannot hold ${width / 2}x${height / 2} pixels`);
  }
}

// the "pixel" halving: an RGBA image of even width and height at half its size, keeping the top-left pixel of each
// 2x2 block. Repeated, it keeps the source pixel at the top left of every scale x scale cell, so a pyramid can be built
// level by level (or band by band, like downscale_2x) and still sample the source directly
export function pick_2x(
  src: Pixels,
  width: number,
  height: number,
  out: Uint8ClampedArray = new Uint8ClampedArray((width / 2) * (height / 2) * 4)
): Uint8ClampedArray {
  check_halving("pick_2x", src, width, height, out.length);
  const out_width = width / 2;
  const out_height = height / 2;
  const row_bytes = width * 4;
  // the pixels as 32-bit words where the buffers are aligned (a subarray may not be)
  if (src.byteOffset % 4 === 0 && out.byteOffset % 4 === 0) {
    const src32 = new Uint32Array(src.buffer, src.byteOffset, width * height);
    const out32 = new Uint32Array(out.buffer, out.byteOffset, out_width * out_height);
    for (let y = 0; y < out_height; y++) {
      const top = 2 * y * width;
      const o = y * out_width;
      for (let x = 0; x < out_width; x++) out32[o + x] = src32[top + 2 * x];
    }
    return out;
  }
  for (let y = 0; y < out_height; y++) {
    const top = 2 * y * row_bytes;
    let o = y * out_width * 4;
    for (let x = 0; x < out_width; x++) {
      const i = top + x * 8;
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = src[i + 3];
      o += 4;
    }
  }
  return out;
}

export type Halving = (src: Pixels, width: number, height: number, out?: Uint8ClampedArray) => Uint8ClampedArray;

// the halving that makes a level from the one above in a downscale mode
export function halving_of(mode: DownscaleMode): Halving {
  switch (mode) {
    case "pixel":
      return pick_2x;
    case "smooth":
      return downscale_2x;
    default:
      throw new RangeError(`Unknown downscale mode: ${mode as string}`);
  }
}
