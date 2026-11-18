import { ERROR_MESSAGES, MIN_TILE_SIZE } from "@/constants/constants";

/**
 * The tiling plan: what a source image of a given size is cut into. Pure (no DOM), so the browser cutter, the
 * command-line cutter and the UI read the same numbers.
 *
 * Tile size "auto" is the original rule: the image must be an even-sided square of at least MIN_TILE_SIZE px, and it
 * is halved while its side is even and at least twice MIN_TILE_SIZE. The number of halvings is the maximum zoom, the
 * side left over is the tile size, and every zoom level uses that same tile size.
 */
export type TileSizeMode = "auto";

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
}

export interface TilePlan {
  /** source image size */
  width: number;
  height: number;
  tile_size_mode: TileSizeMode;
  /** side of the square the image is padded to (the image itself under "auto") */
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

function build_levels(padded_size: number, tile_size: number, max_zoom: number): TileLevel[] {
  return Array.from({ length: max_zoom + 1 }, (_, zoom) => {
    const tiles_per_side = 2 ** zoom;
    const scale = 2 ** (max_zoom - zoom);
    return {
      zoom,
      tiles_per_side,
      tile_count: tiles_per_side * tiles_per_side,
      level_size: tiles_per_side * tile_size,
      source_tile_size: padded_size / tiles_per_side,
      scale
    };
  });
}

export function plan_tiles(width: number, height: number, options: TilePlanOptions = {}): TilePlanResult {
  const tile_size_mode = options.tile_size ?? "auto";

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`Image size must be whole pixels, got ${width}x${height}`);
  }

  if (height !== width) {
    return { is_valid: false, error: ERROR_MESSAGES.NOT_SQUARE };
  }

  if (width < MIN_TILE_SIZE) {
    return { is_valid: false, error: ERROR_MESSAGES.TOO_SMALL };
  }

  if (width % 2 > 0) {
    return { is_valid: false, error: ERROR_MESSAGES.ODD_DIMENSIONS };
  }

  const padded_size = width;
  const max_zoom = auto_max_zoom(padded_size);
  const tile_size = padded_size / 2 ** max_zoom;
  const levels = build_levels(padded_size, tile_size, max_zoom);

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

/** The level of a zoom in the plan; throws for a zoom outside 0 .. max_zoom. */
export function plan_level(plan: TilePlan, zoom: number): TileLevel {
  const level = plan.levels[zoom];
  if (!level) {
    throw new RangeError(`Zoom ${zoom} is outside the plan (0-${plan.max_zoom})`);
  }
  return level;
}
