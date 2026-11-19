import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "@/constants/constants";
import {
  auto_max_zoom,
  DEFAULT_TILE_SIZE_MODE,
  FIXED_TILE_SIZE,
  is_padded,
  plan_level,
  plan_tiles,
  require_plan,
  TILE_SIZE_MODES,
  TilePlan,
  TileSizeMode
} from "@/services/tile_plan";
import { FIXTURE_PATTERNS } from "./fixtures/pattern";

function valid_plan(width: number, height = width): TilePlan {
  const result = plan_tiles(width, height);
  if (!result.is_valid) {
    throw new Error(`expected a plan for ${width}x${height}, got "${result.error}"`);
  }
  return result.plan;
}

// the rule the cutter used before the plan existed (calculate_max_zoom_level + the generator's per-level math)
function original_pyramid(width: number) {
  let max_zoom = 0;
  let side = width;
  while (side % 2 === 0 && side >= 256) {
    side /= 2;
    max_zoom++;
  }
  return Array.from({ length: max_zoom + 1 }, (_, z) => {
    const scale = Math.pow(2, max_zoom - z);
    const scaled_width = width / scale;
    const tiles_per_side = Math.pow(2, z);
    return { z, scaled_width, tiles_per_side, tile_size: scaled_width / tiles_per_side };
  });
}

describe("plan_tiles, tile size auto (today's rule)", () => {
  it.each([
    // [side, max zoom, tile size]
    [1024, 3, 128],
    [1632, 3, 204],
    [6528, 5, 204],
    [16384, 7, 128],
    [13824, 6, 216]
  ])("%i px -> z%i, %i px tiles", (side, max_zoom, tile_size) => {
    const plan = valid_plan(side);
    expect(plan.max_zoom).toBe(max_zoom);
    expect(plan.tile_size).toBe(tile_size);
    expect(plan.padded_size).toBe(side);
    expect(plan.tile_size_mode).toBe("auto");
    expect(plan.levels).toHaveLength(max_zoom + 1);
  });

  // PokeDB's region maps as they are tiled today (region_area.csv: stitched_map_width, max_native_zoom, tilesize)
  it.each([
    ["alola", 4160, 5, 130],
    ["blueberry-academy", 6912, 5, 216],
    ["galar", 8320, 6, 130],
    ["hisui", 8960, 6, 140],
    ["hoenn", 12800, 6, 200],
    ["johto", 14080, 6, 220],
    ["kalos", 1280, 3, 160],
    ["kanto", 6528, 5, 204],
    ["kitakami", 6912, 5, 216],
    ["paldea", 15616, 6, 244],
    ["sevii-islands", 10240, 6, 160],
    ["sinnoh", 16384, 7, 128],
    ["unova", 256, 1, 128]
  ])("keeps the existing %s pyramid (%i px -> z%i, %i px tiles)", (_, side, max_zoom, tile_size) => {
    expect(valid_plan(side)).toMatchObject({ max_zoom, tile_size, padded_size: side });
  });

  it("builds one level per zoom with the same tile size", () => {
    const plan = valid_plan(1632);
    expect(plan.levels).toEqual([
      { zoom: 0, tiles_per_side: 1, tile_count: 1, level_size: 204, source_tile_size: 1632, scale: 8, content_columns: 1, content_rows: 1 },
      { zoom: 1, tiles_per_side: 2, tile_count: 4, level_size: 408, source_tile_size: 816, scale: 4, content_columns: 2, content_rows: 2 },
      { zoom: 2, tiles_per_side: 4, tile_count: 16, level_size: 816, source_tile_size: 408, scale: 2, content_columns: 4, content_rows: 4 },
      { zoom: 3, tiles_per_side: 8, tile_count: 64, level_size: 1632, source_tile_size: 204, scale: 1, content_columns: 8, content_rows: 8 }
    ]);
    expect(plan.total_tiles).toBe(85);
  });

  it("counts every tile of the pyramid", () => {
    expect(valid_plan(1024).total_tiles).toBe(85);
    expect(valid_plan(8192).total_tiles).toBe(5461);
    expect(valid_plan(16384).total_tiles).toBe((Math.pow(4, 8) - 1) / 3);
  });

  it("matches the original generator's numbers for every even side from 128 to 4096 and the large maps", () => {
    const sides = [...Array.from({ length: (4096 - 128) / 2 + 1 }, (_, i) => 128 + i * 2), 6528, 8192, 8320, 13824, 16384];
    for (const side of sides) {
      const plan = valid_plan(side);
      const original = original_pyramid(side);
      expect(plan.max_zoom).toBe(original.length - 1);
      expect(auto_max_zoom(side)).toBe(original.length - 1);
      expect(plan.padded_size).toBe(side);
      for (const level of original) {
        const planned = plan_level(plan, level.z);
        expect(planned.level_size).toBe(level.scaled_width);
        expect(planned.tiles_per_side).toBe(level.tiles_per_side);
        expect(plan.tile_size).toBe(level.tile_size);
        expect(Number.isInteger(planned.level_size)).toBe(true);
        // a square that is not padded has image pixels in every tile
        expect(planned.content_columns).toBe(planned.tiles_per_side);
        expect(planned.content_rows).toBe(planned.tiles_per_side);
      }
    }
  });

  it("keeps small or odd-halving sides at a low zoom", () => {
    expect(valid_plan(128)).toMatchObject({ max_zoom: 0, tile_size: 128, total_tiles: 1 });
    expect(valid_plan(254)).toMatchObject({ max_zoom: 0, tile_size: 254 });
    expect(valid_plan(256)).toMatchObject({ max_zoom: 1, tile_size: 128 });
    expect(valid_plan(1002)).toMatchObject({ max_zoom: 1, tile_size: 501 });
    expect(valid_plan(1000)).toMatchObject({ max_zoom: 2, tile_size: 250 });
  });

  it("plans the test fixtures", () => {
    for (const spec of FIXTURE_PATTERNS) {
      expect(valid_plan(spec.width, spec.height)).toMatchObject({ max_zoom: 3, total_tiles: 85 });
    }
  });
});

describe("plan_tiles, non-square and odd images under auto", () => {
  it("pads a non-square image to a square of its longest side, the image at the top left", () => {
    const plan = valid_plan(1200, 800);
    expect(plan).toMatchObject({ width: 1200, height: 800, padded_size: 1200, max_zoom: 3, tile_size: 150 });
    expect(is_padded(plan)).toBe(true);
    // z3: 8 x 8 tiles of 150 px; the image covers 8 columns and 6 rows (800 / 150 = 5.33)
    expect(plan.levels.map(level => [level.zoom, level.content_columns, level.content_rows])).toEqual([
      [0, 1, 1],
      [1, 2, 2],
      [2, 4, 3],
      [3, 8, 6]
    ]);
    expect(valid_plan(800, 1200)).toMatchObject({ padded_size: 1200, max_zoom: 3, tile_size: 150 });
  });

  it("pads an odd side by one pixel, then halves as before", () => {
    expect(valid_plan(1023)).toMatchObject({ padded_size: 1024, max_zoom: 3, tile_size: 128 });
    expect(valid_plan(16383)).toMatchObject({ padded_size: 16384, max_zoom: 7, tile_size: 128 });
    expect(valid_plan(129)).toMatchObject({ padded_size: 130, max_zoom: 0, tile_size: 130 });
    // 1634 halves once, to the odd 817
    expect(valid_plan(1633)).toMatchObject({ padded_size: 1634, max_zoom: 1, tile_size: 817 });
    expect(valid_plan(1025, 1024)).toMatchObject({ padded_size: 1026, max_zoom: 1, tile_size: 513 });
    expect(valid_plan(1024, 1023)).toMatchObject({ padded_size: 1024, max_zoom: 3, tile_size: 128 });
  });

  it("does not pad an even-sided square", () => {
    for (const side of [128, 1024, 1632, 13824, 16384]) {
      expect(is_padded(valid_plan(side))).toBe(false);
    }
    expect(is_padded(valid_plan(1023))).toBe(true);
  });
});

describe("plan_tiles, tile size 256", () => {
  function plan_256(width: number, height = width): TilePlan {
    return require_plan(width, height, { tile_size: "256" });
  }

  it("pads 1200x800 to 2048 px, z0 to z3", () => {
    const plan = plan_256(1200, 800);
    expect(plan).toMatchObject({
      width: 1200,
      height: 800,
      tile_size_mode: "256",
      padded_size: 2048,
      tile_size: 256,
      max_zoom: 3,
      total_tiles: 85
    });
    expect(plan.levels).toEqual([
      { zoom: 0, tiles_per_side: 1, tile_count: 1, level_size: 256, source_tile_size: 2048, scale: 8, content_columns: 1, content_rows: 1 },
      { zoom: 1, tiles_per_side: 2, tile_count: 4, level_size: 512, source_tile_size: 1024, scale: 4, content_columns: 2, content_rows: 1 },
      { zoom: 2, tiles_per_side: 4, tile_count: 16, level_size: 1024, source_tile_size: 512, scale: 2, content_columns: 3, content_rows: 2 },
      { zoom: 3, tiles_per_side: 8, tile_count: 64, level_size: 2048, source_tile_size: 256, scale: 1, content_columns: 5, content_rows: 4 }
    ]);
    expect(is_padded(plan)).toBe(true);
  });

  it("pads a 13824 px square to 16384 px, z0 to z6", () => {
    const plan = plan_256(13824);
    expect(plan).toMatchObject({ padded_size: 16384, tile_size: 256, max_zoom: 6, total_tiles: (Math.pow(4, 7) - 1) / 3 });
    expect(plan_level(plan, 6)).toMatchObject({ tiles_per_side: 64, level_size: 16384, content_columns: 54, content_rows: 54 });
    expect(plan.levels.map(level => level.zoom)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it.each([
    // [width, height, padded size, max zoom]
    [128, 128, 256, 0],
    [255, 200, 256, 0],
    [256, 256, 256, 0],
    [257, 256, 512, 1],
    [1024, 1024, 1024, 2],
    [1025, 128, 2048, 3],
    [128, 4096, 4096, 4],
    [6528, 6528, 8192, 5],
    [15616, 15616, 16384, 6],
    [16384, 16384, 16384, 6],
    [16385, 300, 32768, 7]
  ])("%ix%i -> %i px, z%i", (width, height, padded_size, max_zoom) => {
    expect(plan_256(width, height)).toMatchObject({ padded_size, max_zoom, tile_size: 256 });
  });

  it("always picks the smallest 256 * 2^n square that holds the image", () => {
    for (let width = 128; width <= 5000; width += 7) {
      const height = 128 + ((width * 37) % 4000);
      const plan = plan_256(width, height);
      const longest = Math.max(width, height);
      expect(plan.padded_size).toBe(256 * Math.pow(2, plan.max_zoom));
      expect(plan.padded_size).toBeGreaterThanOrEqual(longest);
      if (plan.max_zoom > 0) expect(plan.padded_size / 2).toBeLessThan(longest);
    }
  });
});

describe("plan_tiles, invariants of every plan", () => {
  it.each(TILE_SIZE_MODES)("tile size %s", tile_size => {
    for (let width = 128; width <= 3000; width += 13) {
      for (const height of [128, 129, 301, width, 2999]) {
        const plan = require_plan(width, height, { tile_size });
        expect(plan.tile_size_mode).toBe(tile_size);
        expect(plan.padded_size).toBeGreaterThanOrEqual(Math.max(width, height));
        expect(plan.padded_size % 2).toBe(0);
        expect(plan.tile_size * Math.pow(2, plan.max_zoom)).toBe(plan.padded_size);
        expect(plan.tile_size).toBeGreaterThanOrEqual(128);
        for (const level of plan.levels) {
          expect(level.level_size).toBe(level.tiles_per_side * plan.tile_size);
          expect(level.source_tile_size * level.tiles_per_side).toBe(plan.padded_size);
          expect(level.scale * level.level_size).toBe(plan.padded_size);
          // the content tiles reach the image's right and bottom edge, and no further
          expect(level.content_columns * level.source_tile_size).toBeGreaterThanOrEqual(width);
          expect((level.content_columns - 1) * level.source_tile_size).toBeLessThan(width);
          expect(level.content_rows * level.source_tile_size).toBeGreaterThanOrEqual(height);
          expect((level.content_rows - 1) * level.source_tile_size).toBeLessThan(height);
          expect(level.content_columns).toBeLessThanOrEqual(level.tiles_per_side);
          expect(level.content_rows).toBeLessThanOrEqual(level.tiles_per_side);
          // levels below the top are downscaled 2x from the one above (smooth mode), which needs an even side
          if (level.zoom > 0) expect(level.level_size % 2).toBe(0);
        }
      }
    }
  });
});

describe("plan_tiles errors", () => {
  it.each([
    [127, 127],
    [126, 126],
    [64, 64],
    [1, 1],
    [0, 0],
    [100, 50],
    [4096, 127],
    [127, 4096]
  ])("rejects %ix%i as under 128 px", (width, height) => {
    for (const tile_size of TILE_SIZE_MODES) {
      expect(plan_tiles(width, height, { tile_size })).toEqual({ is_valid: false, error: ERROR_MESSAGES.TOO_SMALL });
    }
    expect(() => require_plan(width, height)).toThrow(RangeError);
  });

  it("accepts every shape of at least 128 px each way", () => {
    const sizes = [[128, 128], [1200, 800], [128, 4096], [1025, 1024], [1633, 1633]];
    for (const [width, height] of sizes) {
      for (const tile_size of TILE_SIZE_MODES) expect(plan_tiles(width, height, { tile_size }).is_valid).toBe(true);
    }
  });

  it("throws for sizes that are not whole pixels and for unknown tile sizes", () => {
    expect(() => plan_tiles(1024.5, 1024.5)).toThrow(RangeError);
    expect(() => plan_tiles(Number.NaN, Number.NaN)).toThrow(RangeError);
    expect(() => plan_tiles(-2, -2)).toThrow(RangeError);
    expect(() => plan_tiles(1024, 1024, { tile_size: "512" as TileSizeMode })).toThrow(RangeError);
  });
});

describe("plan_level", () => {
  it("returns the level of a zoom and rejects zooms outside the plan", () => {
    const plan = valid_plan(1024);
    expect(plan_level(plan, 2)).toMatchObject({ zoom: 2, tiles_per_side: 4, level_size: 512, source_tile_size: 256 });
    expect(() => plan_level(plan, 4)).toThrow(RangeError);
    expect(() => plan_level(plan, -1)).toThrow(RangeError);
  });
});

describe("tile size modes", () => {
  it("are auto (the default) and 256", () => {
    expect(TILE_SIZE_MODES).toEqual(["auto", "256"]);
    expect(DEFAULT_TILE_SIZE_MODE).toBe("auto");
    expect(FIXED_TILE_SIZE).toBe(256);
    expect(valid_plan(1024).tile_size_mode).toBe("auto");
  });
});
