import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "@/constants/constants";
import { auto_max_zoom, plan_level, plan_tiles, TilePlan } from "@/services/tile_plan";
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
      { zoom: 0, tiles_per_side: 1, tile_count: 1, level_size: 204, source_tile_size: 1632, scale: 8 },
      { zoom: 1, tiles_per_side: 2, tile_count: 4, level_size: 408, source_tile_size: 816, scale: 4 },
      { zoom: 2, tiles_per_side: 4, tile_count: 16, level_size: 816, source_tile_size: 408, scale: 2 },
      { zoom: 3, tiles_per_side: 8, tile_count: 64, level_size: 1632, source_tile_size: 204, scale: 1 }
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
      for (const level of original) {
        const planned = plan_level(plan, level.z);
        expect(planned.level_size).toBe(level.scaled_width);
        expect(planned.tiles_per_side).toBe(level.tiles_per_side);
        expect(plan.tile_size).toBe(level.tile_size);
        expect(Number.isInteger(planned.level_size)).toBe(true);
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

describe("plan_tiles errors (today's messages)", () => {
  it.each([
    [1023, 1023],
    [1633, 1633],
    [129, 129],
    [16383, 16383]
  ])("rejects the odd size %ix%i", (width, height) => {
    expect(plan_tiles(width, height)).toEqual({ is_valid: false, error: ERROR_MESSAGES.ODD_DIMENSIONS });
  });

  it.each([
    [127, 127],
    [126, 126],
    [64, 64],
    [1, 1],
    [0, 0]
  ])("rejects %ix%i as under 128 px", (width, height) => {
    expect(plan_tiles(width, height)).toEqual({ is_valid: false, error: ERROR_MESSAGES.TOO_SMALL });
  });

  it("rejects non-square images before the size checks", () => {
    expect(plan_tiles(1200, 800)).toEqual({ is_valid: false, error: ERROR_MESSAGES.NOT_SQUARE });
    expect(plan_tiles(100, 50)).toEqual({ is_valid: false, error: ERROR_MESSAGES.NOT_SQUARE });
    expect(plan_tiles(1025, 1024)).toEqual({ is_valid: false, error: ERROR_MESSAGES.NOT_SQUARE });
  });

  it("throws for sizes that are not whole pixels", () => {
    expect(() => plan_tiles(1024.5, 1024.5)).toThrow(RangeError);
    expect(() => plan_tiles(Number.NaN, Number.NaN)).toThrow(RangeError);
    expect(() => plan_tiles(-2, -2)).toThrow(RangeError);
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
