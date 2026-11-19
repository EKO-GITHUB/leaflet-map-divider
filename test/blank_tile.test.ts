import { describe, expect, it } from "vitest";
import { DEFAULT_SKIP_BLANK, is_blank, is_blank_region } from "@/services/blank_tile";

// an RGBA image of size x size pixels, every pixel the same
function flat(size: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return data;
}

describe("is_blank", () => {
  it("is true when every alpha is 0, whatever the colour bytes hold", () => {
    expect(is_blank(new Uint8ClampedArray(128 * 128 * 4))).toBe(true);
    expect(is_blank(flat(16, [255, 40, 7, 0]))).toBe(true);
    expect(is_blank(new Uint8Array(4))).toBe(true);
  });

  it("is false for any pixel with alpha above 0, the faintest included", () => {
    expect(is_blank(flat(4, [0, 0, 0, 255]))).toBe(false);
    for (const index of [0, 7, 63, 64 * 64 - 1]) {
      const data = new Uint8ClampedArray(64 * 64 * 4);
      data[index * 4 + 3] = 1;
      expect(is_blank(data), `pixel ${index}`).toBe(false);
    }
  });

  it("reads only the alpha bytes", () => {
    const data = new Uint8Array(8 * 4);
    for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] = 255;
    expect(is_blank(data)).toBe(true);
    data[3 * 4 + 3] = 128;
    expect(is_blank(data)).toBe(false);
  });

  it("treats an empty buffer as blank and rejects a partial pixel", () => {
    expect(is_blank(new Uint8Array(0))).toBe(true);
    expect(() => is_blank(new Uint8Array(6))).toThrow(RangeError);
  });

  it("is on by default in the cutter", () => {
    expect(DEFAULT_SKIP_BLANK).toBe(true);
  });
});

describe("is_blank_region", () => {
  // an 8x8 image, transparent but for one opaque pixel at (5, 2)
  const image = new Uint8ClampedArray(8 * 8 * 4);
  image[(2 * 8 + 5) * 4 + 3] = 255;

  it("looks only inside its square", () => {
    expect(is_blank_region(image, 8, 0, 0, 4)).toBe(true);
    expect(is_blank_region(image, 8, 4, 0, 4)).toBe(false);
    expect(is_blank_region(image, 8, 0, 4, 4)).toBe(true);
    expect(is_blank_region(image, 8, 4, 4, 4)).toBe(true);
    expect(is_blank_region(image, 8, 0, 0, 2)).toBe(true);
    expect(is_blank_region(image, 8, 4, 2, 2)).toBe(false);
    expect(is_blank_region(image, 8, 6, 2, 2)).toBe(true);
    expect(is_blank_region(image, 8, 0, 0, 8)).toBe(false);
  });

  it("agrees with is_blank on every tile of a level", () => {
    const size = 32;
    const tile = 8;
    const level = new Uint8ClampedArray(size * size * 4);
    // a few faint pixels scattered over some tiles
    for (const [x, y] of [[3, 3], [17, 9], [31, 31], [8, 24]]) level[(y * size + x) * 4 + 3] = 1;
    for (let ty = 0; ty < size / tile; ty++) {
      for (let tx = 0; tx < size / tile; tx++) {
        const copy = new Uint8ClampedArray(tile * tile * 4);
        for (let row = 0; row < tile; row++) {
          const from = ((ty * tile + row) * size + tx * tile) * 4;
          copy.set(level.subarray(from, from + tile * 4), row * tile * 4);
        }
        expect(is_blank_region(level, size, tx * tile, ty * tile, tile), `${tx},${ty}`).toBe(is_blank(copy));
      }
    }
  });

  it("rejects a square that leaves the image, and bad numbers", () => {
    expect(() => is_blank_region(image, 8, 6, 0, 4)).toThrow(RangeError);
    expect(() => is_blank_region(image, 8, 0, 6, 4)).toThrow(RangeError);
    expect(() => is_blank_region(image, 8, -1, 0, 2)).toThrow(RangeError);
    expect(() => is_blank_region(image, 8, 0.5, 0, 2)).toThrow(RangeError);
    expect(() => is_blank_region(image, 0, 0, 0, 0)).toThrow(RangeError);
  });
});
