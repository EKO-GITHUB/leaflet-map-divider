import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compare_rgba } from "./fixtures/compare";
import {
  FIXTURE_PATTERNS,
  decode_block_position,
  pattern_pixel,
  pattern_spec,
  render_pattern,
  render_pattern_row,
} from "./fixtures/pattern";
import { decode_png, encode_png, write_png_file } from "./fixtures/png";

const [PATTERN_1024, PATTERN_1632] = FIXTURE_PATTERNS;

/** Indices (x, y) of the tiles of side `tile` whose pixels are all transparent. */
function transparent_tiles(rgba: Uint8ClampedArray, size: number, tile: number) {
  const tiles: string[] = [];
  for (let ty = 0; ty < size / tile; ty++) {
    for (let tx = 0; tx < size / tile; tx++) {
      let clear = true;
      for (let y = ty * tile; y < (ty + 1) * tile && clear; y++) {
        for (let x = tx * tile; x < (tx + 1) * tile && clear; x++) clear = rgba[(y * size + x) * 4 + 3] === 0;
      }
      if (clear) tiles.push(`${tx},${ty}`);
    }
  }
  return tiles;
}

describe("pattern fixtures", () => {
  it("are the 1024 px and 1632 px patterns with a quarter-size transparent corner", () => {
    expect(PATTERN_1024).toMatchObject({ name: "pattern-1024", width: 1024, height: 1024, noise_width: 512, corner: 256 });
    expect(PATTERN_1632).toMatchObject({ name: "pattern-1632", width: 1632, height: 1632, noise_width: 816, corner: 408 });
    expect(pattern_spec(1200, 800)).toMatchObject({ name: "pattern-1200x800", noise_width: 600, corner: 200 });
  });

  it("render the same pixels every time, and a region equals that part of the whole", () => {
    const whole = render_pattern(PATTERN_1024);
    expect(render_pattern(PATTERN_1024)).toEqual(whole);

    const region = { left: 384, top: 640, width: 128, height: 128 };
    const part = render_pattern(PATTERN_1024, region);
    for (let row = 0; row < region.height; row++) {
      const start = ((region.top + row) * 1024 + region.left) * 4;
      expect(part.subarray(row * 512, (row + 1) * 512)).toEqual(whole.subarray(start, start + 512));
    }
    expect(render_pattern_row(PATTERN_1024, 7)).toEqual(new Uint8Array(whole.subarray(7 * 4096, 8 * 4096)));
  });

  it.each(FIXTURE_PATTERNS)("$name: the corner is transparent and every other pixel opaque", (spec) => {
    const rgba = render_pattern(spec);
    const alphas = new Map<number, number>();
    for (let i = 3; i < rgba.length; i += 4) alphas.set(rgba[i], (alphas.get(rgba[i]) ?? 0) + 1);
    expect([...alphas.keys()].sort((a, b) => a - b)).toEqual([0, 255]);
    expect(alphas.get(0)).toBe(spec.corner * spec.corner);
    expect(pattern_pixel(spec, spec.width - 1, spec.height - 1)).toEqual([0, 0, 0, 0]);
    expect(pattern_pixel(spec, spec.width - spec.corner - 1, spec.height - 1)[3]).toBe(255);
  });

  it.each(FIXTURE_PATTERNS)("$name: the corner covers exactly 2 x 2 full-zoom tiles (z3)", (spec) => {
    const tile = spec.width / 8;
    expect(transparent_tiles(render_pattern(spec), spec.width, tile)).toEqual(["6,6", "7,6", "6,7", "7,7"]);
  });

  it.each(FIXTURE_PATTERNS)("$name: the right half is 2 x 2 blocks coloured by their position", (spec) => {
    const rgba = render_pattern(spec);
    const at = (x: number, y: number) => rgba.subarray((y * spec.width + x) * 4, (y * spec.width + x) * 4 + 4).join();
    let blocks = 0;
    const bad: string[] = [];
    for (let y = 0; y < spec.height - spec.corner; y += 2) {
      for (let x = spec.noise_width; x < spec.width; x += 2) {
        blocks++;
        const block = at(x, y);
        const [r, g, b] = block.split(",").map(Number);
        const position = decode_block_position(r, g, b);
        const uniform = at(x + 1, y) === block && at(x, y + 1) === block && at(x + 1, y + 1) === block;
        if (!uniform || position.x !== x || position.y !== y) bad.push(`${x},${y}`);
      }
    }
    expect(blocks).toBe(((spec.width - spec.noise_width) / 2) * ((spec.height - spec.corner) / 2));
    expect(bad).toEqual([]);
  });

  it.each(FIXTURE_PATTERNS)("$name: the left half is noise", (spec) => {
    const rgba = render_pattern(spec, { left: 0, top: 0, width: spec.noise_width, height: spec.height });
    const sums = [0, 0, 0];
    let same_as_left = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) sums[c] += rgba[i + c];
      if (i % (spec.noise_width * 4) !== 0 && rgba[i] === rgba[i - 4] && rgba[i + 1] === rgba[i - 3]) same_as_left++;
    }
    const pixels = rgba.length / 4;
    for (const sum of sums) expect(Math.abs(sum / pixels - 127.5)).toBeLessThan(1);
    // two random bytes match with chance 1/65536
    expect(same_as_left / pixels).toBeLessThan(0.001);
  });

  it("change with the seed", () => {
    const other = pattern_spec(1024, 1024, { seed: 2 });
    expect(pattern_pixel(other, 10, 10)).not.toEqual(pattern_pixel(PATTERN_1024, 10, 10));
    expect(pattern_pixel(other, 900, 10)).toEqual(pattern_pixel(PATTERN_1024, 900, 10));
  });
});

describe("png codec", () => {
  const dir = mkdtempSync(join(tmpdir(), "lmd-fixtures-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each([0, 1, 2, 3, 4, "cycle"] as const)("round-trips the 1024 px pattern with filter %s", (filter) => {
    const rgba = render_pattern(PATTERN_1024);
    const decoded = decode_png(encode_png(1024, 1024, rgba, { filter }));
    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(1024);
    expect(compare_rgba(decoded.data, rgba, 1024, { compare_transparent_rgb: true }).mismatched_pixels).toBe(0);
  });

  it("streams the 1632 px fixture to a file that decodes to the pattern", async () => {
    const path = join(dir, "pattern-1632.png");
    const row = new Uint8Array(1632 * 4);
    await write_png_file(path, 1632, 1632, (y) => render_pattern_row(PATTERN_1632, y, row));
    const decoded = decode_png(readFileSync(path));
    expect(compare_rgba(decoded.data, render_pattern(PATTERN_1632), 1632).mismatched_pixels).toBe(0);
  });
});

describe("compare_rgba", () => {
  const expected = render_pattern(PATTERN_1024, { left: 704, top: 704, width: 128, height: 128 });

  it("finds no difference between equal tiles", () => {
    expect(compare_rgba(new Uint8ClampedArray(expected), expected, 128)).toEqual({
      mismatched_pixels: 0,
      first_mismatch: null,
    });
  });

  it("reports the first differing pixel and honours the tolerance", () => {
    const actual = new Uint8ClampedArray(expected);
    const i = (5 * 128 + 3) * 4;
    actual[i + 1] = expected[i + 1] ^ 1;
    actual[i + 4 * 10] = expected[i + 4 * 10] ^ 4;
    const result = compare_rgba(actual, expected, 128);
    expect(result.mismatched_pixels).toBe(2);
    expect(result.first_mismatch).toMatchObject({ x: 3, y: 5 });
    expect(compare_rgba(actual, expected, 128, { tolerance: 4 }).mismatched_pixels).toBe(0);
  });

  it("ignores the colour of pixels both sides leave transparent", () => {
    // the region (704-831) reaches into the transparent corner (x >= 768, y >= 768)
    const actual = new Uint8ClampedArray(expected);
    const i = (127 * 128 + 127) * 4;
    expect(expected[i + 3]).toBe(0);
    actual[i] = 200;
    expect(compare_rgba(actual, expected, 128).mismatched_pixels).toBe(0);
    expect(compare_rgba(actual, expected, 128, { compare_transparent_rgb: true }).mismatched_pixels).toBe(1);
  });
});
