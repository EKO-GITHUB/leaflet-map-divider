import { describe, expect, it } from "vitest";
import { average_2x2, DEFAULT_DOWNSCALE_MODE, DOWNSCALE_MODES, downscale_2x, Rgba } from "@/services/downscale";
import { reference_downscale, seeded_rgba } from "./fixtures/downscale_reference";

const RED: Rgba = [255, 0, 0, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const CLEAR_WHITE: Rgba = [255, 255, 255, 0];

describe("average_2x2", () => {
  it("keeps a flat colour", () => {
    for (const colour of [RED, BLACK, WHITE, [12, 200, 77, 255] as Rgba, [12, 200, 77, 90] as Rgba]) {
      expect(average_2x2(colour, colour, colour, colour)).toEqual(colour);
    }
  });

  it("turns a black and white checkerboard into mid grey (127.5 rounds half up)", () => {
    expect(average_2x2(BLACK, WHITE, WHITE, BLACK)).toEqual([128, 128, 128, 255]);
    expect(average_2x2(WHITE, BLACK, BLACK, WHITE)).toEqual([128, 128, 128, 255]);
  });

  it("rounds an opaque average to the nearest value, halves up", () => {
    // 1 + 1 + 1 + 2 = 5 -> 1.25 -> 1; 1 + 1 + 2 + 2 = 6 -> 1.5 -> 2; 1 + 2 + 2 + 2 = 7 -> 1.75 -> 2
    const px = (v: number): Rgba => [v, v, v, 255];
    expect(average_2x2(px(1), px(1), px(1), px(2))[0]).toBe(1);
    expect(average_2x2(px(1), px(1), px(2), px(2))[0]).toBe(2);
    expect(average_2x2(px(1), px(2), px(2), px(2))[0]).toBe(2);
  });

  it("weights colours by alpha, so transparent pixels at an edge add no colour", () => {
    // half of the block is an opaque red edge, half transparent (its hidden white must not leak in)
    expect(average_2x2(RED, CLEAR_WHITE, RED, CLEAR_WHITE)).toEqual([255, 0, 0, 128]);
    // one opaque pixel of four: its colour at a quarter alpha (63.75 -> 64)
    expect(average_2x2(CLEAR_WHITE, CLEAR_WHITE, CLEAR_WHITE, [10, 20, 30, 255])).toEqual([10, 20, 30, 64]);
    // red, white, red and a clear white: the visible pixels average to (255, 85, 85); a straight average of all four
    // would let the hidden white in and give (255, 128, 128)
    expect(average_2x2(RED, WHITE, RED, CLEAR_WHITE)).toEqual([255, 85, 85, 191]);
  });

  it("averages half-transparent pixels as premultiplied colour", () => {
    // red at alpha 255 and blue at alpha 85: premultiplied (255, 0, 0) + (0, 0, 85), alpha (255 + 85) / 2 = 170
    // colour = premultiplied sum / alpha sum: R = 255 * 255 / 340 = 191.25 -> 191, B = 255 * 85 / 340 = 63.75 -> 64
    const BLUE_85: Rgba = [0, 0, 255, 85];
    expect(average_2x2(RED, BLUE_85, RED, BLUE_85)).toEqual([191, 0, 64, 170]);
    // two half-transparent greys and two clear pixels: the grey stays, alpha halves (128 + 128) / 4 = 64
    expect(average_2x2([100, 100, 100, 128], CLEAR_WHITE, [100, 100, 100, 128], CLEAR_WHITE)).toEqual([100, 100, 100, 64]);
  });

  it("gives fully transparent black when the alpha rounds to 0", () => {
    expect(average_2x2(CLEAR_WHITE, CLEAR_WHITE, CLEAR_WHITE, CLEAR_WHITE)).toEqual([0, 0, 0, 0]);
    // alpha sum 1 -> 0.25 -> 0: no hidden colour is kept
    expect(average_2x2([200, 10, 10, 1], CLEAR_WHITE, CLEAR_WHITE, CLEAR_WHITE)).toEqual([0, 0, 0, 0]);
    // alpha sum 2 -> 0.5 -> 1
    expect(average_2x2([200, 10, 10, 2], CLEAR_WHITE, CLEAR_WHITE, CLEAR_WHITE)).toEqual([200, 10, 10, 1]);
  });

  it("is symmetric in its four pixels", () => {
    const pixels: Rgba[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 10],
      [0, 0, 255, 200],
      [90, 90, 90, 0]
    ];
    const first = average_2x2(pixels[0], pixels[1], pixels[2], pixels[3]);
    expect(average_2x2(pixels[3], pixels[2], pixels[1], pixels[0])).toEqual(first);
    expect(average_2x2(pixels[1], pixels[3], pixels[0], pixels[2])).toEqual(first);
  });

  it("rejects channel values outside 0-255", () => {
    expect(() => average_2x2([256, 0, 0, 255], RED, RED, RED)).toThrow(RangeError);
    expect(() => average_2x2([-1, 0, 0, 255], RED, RED, RED)).toThrow(RangeError);
    expect(() => average_2x2([1.5, 0, 0, 255], RED, RED, RED)).toThrow(RangeError);
  });
});

describe("downscale_2x", () => {
  it("averages each 2x2 block into one pixel", () => {
    // 4x2: a black/white checkerboard block, then a flat red block
    const src = new Uint8Array([...BLACK, ...WHITE, ...RED, ...RED, ...WHITE, ...BLACK, ...RED, ...RED]);
    expect(Array.from(downscale_2x(src, 4, 2))).toEqual([128, 128, 128, 255, ...RED]);
  });

  it("matches a floating-point premultiplied reference on random pixels, exactly", () => {
    for (const [seed, alpha] of [[1, "opaque"], [2, "random"], [3, "sparse"]] as const) {
      const src = seeded_rgba(64, 48, seed, alpha);
      const ours = downscale_2x(src, 64, 48);
      const reference = reference_downscale(src, 64, 48);
      expect(ours.length).toBe(32 * 24 * 4);
      expect(Buffer.from(ours).equals(Buffer.from(reference)), `seed ${seed}, alpha ${alpha}`).toBe(true);
    }
  });

  it("gives the same pixels band by band as in one pass", () => {
    const width = 40;
    const height = 36;
    const src = seeded_rgba(width, height, 7, "random");
    const whole = downscale_2x(src, width, height);

    const banded = new Uint8ClampedArray(whole.length);
    const half = width / 2;
    for (const rows of [2, 4, 6, 10]) {
      banded.fill(0);
      for (let y = 0; y < height; y += rows) {
        const band = Math.min(rows, height - y);
        downscale_2x(
          src.subarray(y * width * 4, (y + band) * width * 4),
          width,
          band,
          banded.subarray((y / 2) * half * 4, ((y + band) / 2) * half * 4)
        );
      }
      expect(Buffer.from(banded).equals(Buffer.from(whole)), `${rows} rows a band`).toBe(true);
    }
  });

  it("writes into the output it is given", () => {
    const out = new Uint8ClampedArray(4);
    const result = downscale_2x(new Uint8Array([...RED, ...RED, ...RED, ...RED]), 2, 2, out);
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([...RED]);
  });

  it("rejects odd, tiny or mismatched sizes", () => {
    const src = new Uint8Array(4 * 4 * 4);
    expect(() => downscale_2x(src, 3, 4)).toThrow(RangeError);
    expect(() => downscale_2x(src, 4, 3)).toThrow(RangeError);
    expect(() => downscale_2x(src, 0, 4)).toThrow(RangeError);
    expect(() => downscale_2x(src, 4.5, 4)).toThrow(RangeError);
    expect(() => downscale_2x(src, 8, 4)).toThrow(RangeError);
    expect(() => downscale_2x(src, 4, 4, new Uint8ClampedArray(15))).toThrow(RangeError);
  });
});

describe("downscale modes", () => {
  it("are pixel and smooth, pixel by default (today's behaviour)", () => {
    expect(DOWNSCALE_MODES).toEqual(["pixel", "smooth"]);
    expect(DEFAULT_DOWNSCALE_MODE).toBe("pixel");
  });
});
