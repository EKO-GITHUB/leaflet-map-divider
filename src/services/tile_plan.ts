import { ERROR_MESSAGES, MIN_TILE_SIZE } from "@/constants/constants";

/**
 * The tiling plan: what a source image of a given size is cut into. Pure (no DOM), so the browser cutter, the
 * command-line cutter and the UI read the same numbers.
 *
 * Every pyramid is cut from a square, the padded square: the image sits at its top left and the rest (the pad) is
 * transparent. The image must be at least MIN_TILE_SIZE px wide and high; any shape is accepted.
 *
 * - Tile size "auto" is the original rule. The padded square's side is the image's longest side, made even by one more
 *   pixel when it is odd (so an even-sided square image is not padded at all), and it is halved while its side is even
 *   and at least twice MIN_TILE_SIZE. The number of halvings is the maximum zoom, the side left over is the tile size.
 * - Tile size "256": the padded square is the smallest 256 * 2^n square that holds the image, cut into 256 px tiles at
 *   every zoom; n is the maximum zoom.
 *
 * Every zoom level uses the same tile size.
 */
export const TILE_SIZE_MODES = ["auto", "256"] as const;
export type TileSizeMode = (typeof TILE_SIZE_MODES)[number];
export const DEFAULT_TILE_SIZE_MODE: TileSizeMode = "auto";

/** The side of every tile under tile size "256". */
export const FIXED_TILE_SIZE = 256;

export interface TilePlanOptions {
  tile_size?: TileSizeMode;
}

export interface TileLevel {
  zoom: number;
  /** tiles along each side of this level's square grid */
  tiles_per_side: number;
  tile_count: number;
  /** side of the padded square drawn at this zoom, in px (tiles_per_side * tile_size) */
  level_size: number;
  /** source pixels along one side of a tile of this zoom */
  source_tile_size: number;
  /** source pixels per output pixel at this zoom (1 at the maximum zoom) */
  scale: number;
  /** tile columns and rows that hold image pixels (from the left and the top); the others hold only the pad */
  content_columns: number;
  content_rows: number;
}

export interface TilePlan {
  /** source image size */
  width: number;
  height: number;
  tile_size_mode: TileSizeMode;
  /** side of the square the image is padded to (the image itself for an even-sided square under "auto") */
  padded_size: number;
  /** side of every tile, in px */
  tile_size: number;
  max_zoom: number;
  /** one entry per zoom level, indexed by zoom (0 .. max_zoom) */
  levels: TileLevel[];
  total_tiles: number;
}

export type TilePlanResult =
  | { is_valid: true; plan: TilePlan }
  | { is_valid: false; error: string };

/** Halvings of an even side while it stays at least twice MIN_TILE_SIZE (the original `calculate_max_zoom_level`). */
export function auto_max_zoom(size: number): number {
  let zoom = 0;
  let side = size;

  while (side % 2 === 0 && side >= MIN_TILE_SIZE * 2) {
    side = side / 2;
    zoom++;
  }

  return zoom;
}

/** The smallest n with FIXED_TILE_SIZE * 2^n >= size. */
export function fixed_max_zoom(size: number): number {
  let zoom = 0;
  while (FIXED_TILE_SIZE * 2 ** zoom < size) zoom++;
  return zoom;
}

function build_levels(width: number, height: number, padded_size: number, tile_size: number, max_zoom: number): TileLevel[] {
  return Array.from({ length: max_zoom + 1 }, (_, zoom) => {
    const tiles_per_side = 2 ** zoom;
    const scale = 2 ** (max_zoom - zoom);
    const source_tile_size = padded_size / tiles_per_side;
    return {
      zoom,
      tiles_per_side,
      tile_count: tiles_per_side * tiles_per_side,
      level_size: tiles_per_side * tile_size,
      source_tile_size,
      scale,
      content_columns: Math.ceil(width / source_tile_size),
      content_rows: Math.ceil(height / source_tile_size)
    };
  });
}

export function plan_tiles(width: number, height: number, options: TilePlanOptions = {}): TilePlanResult {
  const tile_size_mode = options.tile_size ?? DEFAULT_TILE_SIZE_MODE;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`Image size must be whole pixels, got ${width}x${height}`);
  }
  if (!TILE_SIZE_MODES.includes(tile_size_mode)) {
    throw new RangeError(`Unknown tile size mode: ${tile_size_mode}`);
  }

  if (width < MIN_TILE_SIZE || height < MIN_TILE_SIZE) {
    return { is_valid: false, error: ERROR_MESSAGES.TOO_SMALL };
  }

  const longest_side = Math.max(width, height);
  let padded_size: number;
  let max_zoom: number;
  if (tile_size_mode === "256") {
    max_zoom = fixed_max_zoom(longest_side);
    padded_size = FIXED_TILE_SIZE * 2 ** max_zoom;
  } else {
    padded_size = longest_side + (longest_side % 2);
    max_zoom = auto_max_zoom(padded_size);
  }
  const tile_size = padded_size / 2 ** max_zoom;
  const levels = build_levels(width, height, padded_size, tile_size, max_zoom);

  return {
    is_valid: true,
    plan: {
      width,
      height,
      tile_size_mode,
      padded_size,
      tile_size,
      max_zoom,
      levels,
      total_tiles: levels.reduce((sum, level) => sum + level.tile_count, 0)
    }
  };
}

/** The plan of an image already known to be valid (at least MIN_TILE_SIZE px each way); throws otherwise. */
export function require_plan(width: number, height: number, options: TilePlanOptions = {}): TilePlan {
  const result = plan_tiles(width, height, options);
  if (!result.is_valid) {
    throw new RangeError(`${width}x${height} cannot be tiled: ${result.error}`);
  }
  return result.plan;
}

/** Whether the image does not fill its padded square (a transparent pad is added at the right or the bottom). */
export function is_padded(plan: TilePlan): boolean {
  return plan.width !== plan.padded_size || plan.height !== plan.padded_size;
}

/** The level of a zoom in the plan; throws for a zoom outside 0 .. max_zoom. */
export function plan_level(plan: TilePlan, zoom: number): TileLevel {
  const level = plan.levels[zoom];
  if (!level) {
    throw new RangeError(`Zoom ${zoom} is outside the plan (0-${plan.max_zoom})`);
  }
  return level;
}
