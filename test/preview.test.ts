import { describe, expect, it } from "vitest";
import { downscale_2x } from "@/services/downscale";
import { crop_top_left, halve_image, plan_preview, PREVIEW_MAX_SIZE, RgbaImage } from "@/services/preview";
import { require_plan, TileSizeMode } from "@/services/tile_plan";
import { seeded_rgba } from "./fixtures/downscale_reference";

function preview_of(width: number, height: number, tile_size: TileSizeMode = "auto") {
  return plan_preview(require_plan(width, height, { tile_size }));
}

describe("plan_preview", () => {
  it.each([
    // width, height, tile size -> zoom, extra halvings, scale, preview size
    [1024, 1024, "auto", 3, 0, 1, 1024, 1024],
    [1632, 1632, "auto", 2, 0, 2, 816, 816],
    [1200, 800, "256", 2, 0, 2, 600, 400],
    [1200, 800, "auto", 2, 0, 2, 600, 400],
    [16384, 16384, "auto", 3, 0, 16, 1024, 1024],
    [13824, 13824, "256", 2, 0, 16, 864, 864],
    [4000, 2828, "256", 2, 0, 4, 1000, 707],
    [15616, 15616, "auto", 2, 0, 16, 976, 976],
    [1001, 700, "256", 2, 0, 1, 1001, 700],
    [1025, 130, "auto", 0, 0, 2, 513, 65],
    [128, 128, "auto", 0, 0, 1, 128, 128],
    // auto with 1031 px tiles: z0's content (1031 x 150) is still too big, so z0 is halved once more
    [2062, 300, "auto", 0, 1, 4, 516, 75],
    // 2 x 4095 = 8190 under auto: z1 with 4095 px tiles; z0 halved twice more
    [8190, 8190, "auto", 0, 2, 8, 1024, 1024]
  ] as const)("%ix%i at tile size %s -> zoom %i (+%i), scale %i, %ix%i", (w, h, tile, zoom, extra, scale, pw, ph) => {
    expect(preview_of(w, h, tile)).toEqual({ zoom, extra_halvings: extra, scale, width: pw, height: ph });
  });

  it("is the largest level whose content fits, for any shape and both tile sizes", () => {
    let state = 12345;
    const random = (max: number) => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state % max;
    };
    for (let i = 0; i < 2000; i++) {
      const width = 128 + random(20000);
      const height = 128 + random(20000);
      for (const tile_size of ["auto", "256"] as const) {
        const plan = require_plan(width, height, { tile_size });
        const preview = plan_preview(plan);
        const label = `${width}x${height} ${tile_size}`;
        expect(Math.max(preview.width, preview.height), label).toBeLessThanOrEqual(PREVIEW_MAX_SIZE);
        // one halving fewer would not fit
        if (preview.scale > 1) {
          expect(Math.ceil(Math.max(width, height) / (preview.scale / 2)), label).toBeGreaterThan(PREVIEW_MAX_SIZE);
        }
        expect(preview.scale).toBe(2 ** (plan.max_zoom - preview.zoom + preview.extra_halvings));
        expect(preview.extra_halvings === 0 || preview.zoom === 0, label).toBe(true);
        expect([preview.width, preview.height]).toEqual([Math.ceil(width / preview.scale), Math.ceil(height / preview.scale)]);
      }
    }
  });
});

describe("crop_top_left", () => {
  it("copies the top-left rectangle row by row", () => {
    const source = seeded_rgba(10, 6, 3, "random");
    const crop = crop_top_left(source, 10, 7, 4);
    expect([crop.width, crop.height]).toEqual([7, 4]);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 7; x++) {
        expect([...crop.data.subarray((y * 7 + x) * 4, (y * 7 + x) * 4 + 4)]).toEqual([
          ...source.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)
        ]);
      }
    }
  });

  it("rejects a rectangle outside the image", () => {
    const source = new Uint8Array(10 * 6 * 4);
    expect(() => crop_top_left(source, 10, 11, 2)).toThrow(RangeError);
    expect(() => crop_top_left(source, 10, 5, 7)).toThrow(RangeError);
    expect(() => crop_top_left(source, 10, 0, 2)).toThrow(RangeError);
    expect(() => crop_top_left(source, 10, 2.5, 2)).toThrow(RangeError);
  });
});

describe("halve_image", () => {
  function image(width: number, height: number, seed: number): RgbaImage {
    return { data: new Uint8ClampedArray(seeded_rgba(width, height, seed, "random")), width, height };
  }

  it("is downscale_2x for even sizes (smooth)", () => {
    const source = image(12, 8, 1);
    const half = halve_image(source, "smooth");
    expect([half.width, half.height]).toEqual([6, 4]);
    expect([...half.data]).toEqual([...downscale_2x(source.data, 12, 8)]);
  });

  it("pads an odd side with transparent pixels before averaging (smooth)", () => {
    const source = image(7, 5, 2);
    const half = halve_image(source, "smooth");
    expect([half.width, half.height]).toEqual([4, 3]);
    const padded = new Uint8ClampedArray(8 * 6 * 4);
    for (let y = 0; y < 5; y++) padded.set(source.data.subarray(y * 7 * 4, (y + 1) * 7 * 4), y * 8 * 4);
    expect([...half.data]).toEqual([...downscale_2x(padded, 8, 6)]);
    // an opaque edge pixel averaged with the pad keeps its colour at a quarter or half of its alpha
    const opaque: RgbaImage = { data: new Uint8ClampedArray([200, 100, 50, 255]), width: 1, height: 1 };
    expect([...halve_image(opaque, "smooth").data]).toEqual([200, 100, 50, 64]);
  });

  it("keeps the top-left pixel of each 2x2 cell (pixel), odd sides included", () => {
    const source = image(7, 5, 3);
    const half = halve_image(source, "pixel");
    expect([half.width, half.height]).toEqual([4, 3]);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        const from = (2 * y * 7 + 2 * x) * 4;
        expect([...half.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]).toEqual([
          ...source.data.subarray(from, from + 4)
        ]);
      }
    }
  });
});
