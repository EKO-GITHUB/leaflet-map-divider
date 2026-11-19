import { describe, expect, it } from "vitest";
import { create_pyramid_stream } from "../cli/pyramid_stream";
import { DownscaleMode } from "@/services/downscale";
import { plan_preview } from "@/services/preview";
import { require_plan, TilePlan, TileSizeMode } from "@/services/tile_plan";
import { compare_rgba } from "./fixtures/compare";
import { crop, reference_downscale, reference_pyramid, seeded_rgba } from "./fixtures/downscale_reference";
import { pattern_spec, render_pattern } from "./fixtures/pattern";

// The command-line cutter's pyramid (cli/pyramid_stream.ts), fed row by row, against pyramids computed whole: pixel
// mode samples the padded square at the top left of every cell, smooth mode is the independent reference pyramid.

type Pixels = Uint8Array | Uint8ClampedArray;

// the padded square of an image: the image at the top left, alpha 0 elsewhere
function pad_square(image: Pixels, width: number, height: number, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < height; y++) out.set(image.subarray(y * width * 4, (y + 1) * width * 4), y * size * 4);
  return out;
}

function expected_levels(plan: TilePlan, image: Pixels, downscale: DownscaleMode) {
  const padded = pad_square(image, plan.width, plan.height, plan.padded_size);
  if (downscale === "smooth") return reference_pyramid(padded, plan.padded_size, plan.max_zoom);
  return [...plan.levels].reverse().map(level => {
    const size = level.level_size;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = (y * level.scale * plan.padded_size + x * level.scale) * 4;
        data.set(padded.subarray(from, from + 4), (y * size + x) * 4);
      }
    }
    return { data, size };
  });
}

// the width x height rectangle at the top left of a square level size px wide
function crop_rect(data: Pixels, size: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) out.set(data.subarray(y * size * 4, (y * size + width) * 4), y * width * 4);
  return out;
}

const is_blank = (rgba: Pixels) => rgba.every((value, i) => i % 4 !== 3 || value === 0);

async function stream(plan: TilePlan, image: Pixels, downscale: DownscaleMode) {
  const tiles = new Map<string, Uint8Array | null>();
  const order: string[] = [];
  const preview = plan_preview(plan);
  const pyramid = create_pyramid_stream({
    plan,
    downscale,
    preview,
    on_tile: async (zoom, x, y, rgba) => {
      const name = `${zoom}/${y}/${x}`;
      expect(tiles.has(name), `${name} twice`).toBe(false);
      tiles.set(name, rgba);
      order.push(name);
      // the receiver may take its time
      if (order.length % 7 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
  const row_bytes = plan.width * 4;
  for (let y = 0; y < plan.height; y++) {
    // a copy that is then scribbled over: the pyramid must not keep the caller's buffer
    const row = image.slice(y * row_bytes, (y + 1) * row_bytes);
    await pyramid.push_row(row);
    row.fill(77);
  }
  const preview_image = await pyramid.end();
  return { tiles, order, preview, preview_image };
}

async function expect_pyramid(plan: TilePlan, image: Pixels, downscale: DownscaleMode) {
  const { tiles, preview, preview_image } = await stream(plan, image, downscale);
  const levels = expected_levels(plan, image, downscale);
  expect(tiles.size).toBe(plan.total_tiles);
  let blank = 0;
  for (const level of plan.levels) {
    const expected_level = levels[plan.max_zoom - level.zoom];
    expect(expected_level.size).toBe(level.level_size);
    for (let y = 0; y < level.tiles_per_side; y++) {
      for (let x = 0; x < level.tiles_per_side; x++) {
        const name = `${level.zoom}/${y}/${x}`;
        const expected = crop(expected_level, x, y, plan.tile_size);
        const tile = tiles.get(name);
        expect(tile, name).not.toBeUndefined();
        if (is_blank(expected)) {
          // a blank tile is handed over as null
          expect(tile, name).toBeNull();
          blank++;
          continue;
        }
        expect(tile, name).not.toBeNull();
        const result = compare_rgba(tile!, expected, plan.tile_size, { compare_transparent_rgb: true });
        expect(result.first_mismatch, name).toBeNull();
      }
    }
  }

  // the preview: the content area of its level (halved further when z0 is too large)
  expect(preview_image).not.toBeNull();
  expect([preview_image!.width, preview_image!.height]).toEqual([preview.width, preview.height]);
  const level = levels[plan.max_zoom - preview.zoom];
  let width = Math.ceil(plan.width / plan.levels[preview.zoom].scale);
  let height = Math.ceil(plan.height / plan.levels[preview.zoom].scale);
  let content: Pixels = crop_rect(level.data, level.size, width, height);
  for (let i = 0; i < preview.extra_halvings; i++) {
    const half_width = Math.ceil(width / 2);
    const half_height = Math.ceil(height / 2);
    if (downscale === "smooth") {
      // an odd side gets a transparent column or row first
      const even = new Uint8Array(half_width * 2 * half_height * 2 * 4);
      for (let y = 0; y < height; y++) even.set(content.subarray(y * width * 4, (y + 1) * width * 4), y * half_width * 2 * 4);
      content = reference_downscale(even, half_width * 2, half_height * 2);
    } else {
      const halved = new Uint8Array(half_width * half_height * 4);
      for (let y = 0; y < half_height; y++) {
        for (let x = 0; x < half_width; x++) {
          const from = (2 * y * width + 2 * x) * 4;
          halved.set(content.subarray(from, from + 4), (y * half_width + x) * 4);
        }
      }
      content = halved;
    }
    width = half_width;
    height = half_height;
  }
  expect(compare_rgba(preview_image!.data, content, preview.width, { compare_transparent_rgb: true }).first_mismatch).toBeNull();
  return { blank };
}

describe.each(["pixel", "smooth"] as const)("the streamed pyramid (%s)", downscale => {
  const cases: { width: number; height: number; tile_size: TileSizeMode }[] = [
    // even square, not padded: z2 with 128 px tiles
    { width: 512, height: 512, tile_size: "auto" },
    // odd sides: padded by one, 150 px tiles (an even tile side, odd tile count per band)
    { width: 600, height: 401, tile_size: "auto" },
    // auto with an odd tile side (1002 -> z1 of 501 px): bands of an odd number of rows split the row pairs
    { width: 1001, height: 700, tile_size: "auto" },
    // 256 px tiles, wide and tall pads, sizes that are no multiple of the scale (edge pixels of partial cells)
    { width: 700, height: 300, tile_size: "256" },
    { width: 129, height: 517, tile_size: "256" },
    // z0 alone
    { width: 200, height: 130, tile_size: "256" }
  ];

  it.each(cases)("$width x $height at tile size $tile_size equals the pyramid computed whole", async ({ width, height, tile_size }) => {
    const plan = require_plan(width, height, { tile_size });
    const image = seeded_rgba(width, height, width + height, "sparse");
    // the pyramid is fed what the cutter feeds it: alpha 0 pixels as 0, 0, 0, 0
    for (let i = 0; i < image.length; i += 4) if (image[i + 3] === 0) image.fill(0, i, i + 4);
    await expect_pyramid(plan, image, downscale);
  });

  it("hands the pattern's transparent corner and the pad over as blank tiles", async () => {
    const spec = pattern_spec(1200, 800);
    const plan = require_plan(1200, 800, { tile_size: "256" });
    const { blank } = await expect_pyramid(plan, render_pattern(spec), downscale);
    // the same 57 blank tiles the browser cutter skips (z3 45, z2 10, z1 2)
    expect(blank).toBe(57);
  });

  it("halves z0 further for the preview when z0 is larger than 1024 px", async () => {
    // 2062 x 300 -> padded 2062, z1 of 1031 px tiles: z0's content is 1031 x 150, the preview 516 x 75
    const plan = require_plan(2062, 300, { tile_size: "auto" });
    const preview = plan_preview(plan);
    expect(preview).toMatchObject({ zoom: 0, extra_halvings: 1, width: 516, height: 75 });
    const image = seeded_rgba(2062, 300, 5, "opaque");
    await expect_pyramid(plan, image, downscale);
  }, 30_000);
});

describe("the streamed pyramid's order and checks", () => {
  it("cuts a band as soon as its rows are in, every level interleaved", async () => {
    const plan = require_plan(512, 512);
    const { order } = await stream(plan, seeded_rgba(512, 512, 1, "opaque"), "pixel");
    // z2's first row of tiles (4 tiles of 128 px) is cut after 128 source rows, z1's (128 rows of z1) after 256 source
    // rows, long before the source has been read
    expect(order.slice(0, 4)).toEqual(["2/0/0", "2/0/1", "2/0/2", "2/0/3"]);
    expect(order.indexOf("1/0/0")).toBeGreaterThan(order.indexOf("2/0/3"));
    expect(order.indexOf("1/0/0")).toBeLessThan(order.indexOf("2/2/0"));
    // the last source row completes a band in every level, the lowest first
    expect(order.slice(-7)).toEqual(["0/0/0", "1/1/0", "1/1/1", "2/3/0", "2/3/1", "2/3/2", "2/3/3"]);
    expect(order).toHaveLength(21);
  });

  it("rejects rows of the wrong size, too many rows and too few", async () => {
    const plan = require_plan(256, 256);
    const make = () => create_pyramid_stream({ plan, downscale: "pixel", on_tile: () => {} });
    await expect(make().push_row(new Uint8Array(255 * 4))).rejects.toThrow(RangeError);
    const full = make();
    for (let y = 0; y < 256; y++) await full.push_row(new Uint8Array(256 * 4));
    await expect(full.push_row(new Uint8Array(256 * 4))).rejects.toThrow(RangeError);
    const short = make();
    await short.push_row(new Uint8Array(256 * 4));
    await expect(short.end()).rejects.toThrow(RangeError);
  });

  it("finishes a large pad without pushing its rows: 16385 x 128 at 256 is padded to 32768 px", async () => {
    const plan = require_plan(16385, 128, { tile_size: "256" });
    expect(plan.padded_size).toBe(32768);
    let blank = 0;
    let written = 0;
    const pyramid = create_pyramid_stream({
      plan,
      downscale: "smooth",
      on_tile: (_zoom, _x, _y, rgba) => {
        if (rgba) written++;
        else blank++;
      }
    });
    const row = new Uint8Array(16385 * 4).fill(255);
    for (let y = 0; y < 128; y++) await pyramid.push_row(row);
    await pyramid.end();
    expect(blank + written).toBe(plan.total_tiles);
    // the content is one 128 px high strip: at zoom z it spans ceil(16385 / scale) px of the first tile row
    const expected_written = plan.levels.reduce((sum, level) => sum + level.content_columns, 0);
    expect(written).toBe(expected_written);
  }, 60_000);
});
