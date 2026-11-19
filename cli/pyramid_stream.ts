import { is_blank_region } from "@/services/blank_tile";
import { DownscaleMode, Halving, halving_of } from "@/services/downscale";
import { halve_image, PreviewPlan, RgbaImage } from "@/services/preview";
import { TileLevel, TilePlan } from "@/services/tile_plan";

// The command-line cutter's pyramid, built while the source is read row by row. Every zoom level is a stream of rows:
// a level keeps one band of tile_size rows (the tiles of one row of the grid) and one pair of rows, so no level is
// ever held whole (about two bands of the top level in all, plus the encodes in flight).
// - Rows pushed into a level fill its band; a full band is cut into tiles, handed to on_tile, and reused.
// - Every second row is halved with the downscale mode's halving (pick_2x or downscale_2x, the browser's own code) into
//   one row of the level below, which is pushed into that level at once.
// - The rows of a level past its content (the image) are the transparent pad: end() finishes them without pushing
//   them one by one, so a large pad costs no work.
// The rows of a level are level_size px wide (the padded square at that zoom); a pushed row may be shorter (the top
// level gets the source's rows), the rest of it is pad.

/**
 * A tile of the pyramid: x from the left, y from the top. `rgba` is a copy the receiver may keep (tile_size x tile_size,
 * RGBA), or null when every pixel of the tile has alpha 0 (a blank tile; its pixels are then all 0, 0, 0, 0 as long as
 * the pushed rows hold no colour under alpha 0). The pyramid waits for the returned promise before it goes on, so the
 * receiver can hold back the cut while its encodes are busy.
 */
export type TileReceiver = (zoom: number, x: number, y: number, rgba: Uint8Array | null) => Promise<void> | void;

export interface PyramidStreamOptions {
  plan: TilePlan;
  downscale: DownscaleMode;
  on_tile: TileReceiver;
  /** collect the preview of this plan (see preview.ts) while its level streams by */
  preview?: PreviewPlan;
}

class LevelStream {
  private readonly band: Uint8ClampedArray;
  private readonly pair: Uint8ClampedArray;
  private readonly half_row: Uint8ClampedArray | null;
  // rows pushed so far, and rows in the current band
  private rows = 0;
  private band_rows = 0;
  private band_index = 0;
  private ended = false;

  constructor(
    private readonly level: TileLevel,
    private readonly tile_size: number,
    private readonly halve: Halving,
    private readonly on_tile: TileReceiver,
    private readonly below: LevelStream | null,
    private readonly preview: { image: RgbaImage } | null
  ) {
    const row_bytes = level.level_size * 4;
    this.band = new Uint8ClampedArray(tile_size * row_bytes);
    this.pair = below ? new Uint8ClampedArray(2 * row_bytes) : new Uint8ClampedArray(0);
    this.half_row = below ? new Uint8ClampedArray(row_bytes / 2) : null;
  }

  /** The next row of the level, at most level_size px (the rest of the row is pad). */
  async push_row(row: Uint8Array | Uint8ClampedArray): Promise<void> {
    const { level_size, zoom } = this.level;
    if (this.ended) throw new Error(`Zoom ${zoom}: a row was pushed after the level ended`);
    if (row.length % 4 !== 0 || row.length > level_size * 4) {
      throw new RangeError(`Zoom ${zoom}: a row of ${row.length} bytes does not fit a ${level_size} px level`);
    }
    if (this.rows >= level_size) throw new RangeError(`Zoom ${zoom}: more than ${level_size} rows were pushed`);
    const y = this.rows++;
    const row_bytes = level_size * 4;

    // the band was cleared when it started, so a short row leaves the pad transparent
    this.band.set(row, this.band_rows * row_bytes);
    this.band_rows++;

    if (this.preview && y < this.preview.image.height) {
      const { image } = this.preview;
      const bytes = image.width * 4;
      const from = (this.band_rows - 1) * row_bytes;
      image.data.set(this.band.subarray(from, from + bytes), y * bytes);
    }

    if (this.below) {
      const half = (y % 2) * row_bytes;
      this.pair.fill(0, half, half + row_bytes);
      this.pair.set(row, half);
      if (y % 2 === 1) await this.push_half_row();
    }

    if (this.band_rows === this.tile_size) await this.cut_band();
  }

  /** The rows not pushed are the pad: the level is finished with them transparent, and the level below ends too. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const { level_size, tiles_per_side } = this.level;

    // a content row waiting for its pair is halved with a transparent row
    if (this.below && this.rows % 2 === 1) {
      const row_bytes = level_size * 4;
      this.pair.fill(0, row_bytes);
      await this.push_half_row();
    }
    // the band in progress, its missing rows transparent (cleared when it started)
    if (this.band_rows > 0) await this.cut_band();
    // whole bands of pad: blank tiles
    for (let y = this.band_index; y < tiles_per_side; y++) {
      for (let x = 0; x < tiles_per_side; x++) await this.on_tile(this.level.zoom, x, y, null);
    }
    this.band_index = tiles_per_side;

    await this.below?.end();
  }

  private async push_half_row(): Promise<void> {
    const half_row = this.half_row!;
    this.halve(this.pair, this.level.level_size, 2, half_row);
    await this.below!.push_row(half_row);
  }

  private async cut_band(): Promise<void> {
    const { zoom, tiles_per_side, level_size } = this.level;
    const t = this.tile_size;
    const y = this.band_index;
    for (let x = 0; x < tiles_per_side; x++) {
      if (is_blank_region(this.band, level_size, x * t, 0, t)) {
        await this.on_tile(zoom, x, y, null);
        continue;
      }
      const tile = new Uint8Array(t * t * 4);
      const row_bytes = t * 4;
      for (let row = 0; row < t; row++) {
        const from = (row * level_size + x * t) * 4;
        tile.set(this.band.subarray(from, from + row_bytes), row * row_bytes);
      }
      await this.on_tile(zoom, x, y, tile);
    }
    this.band.fill(0);
    this.band_rows = 0;
    this.band_index++;
  }
}

export interface PyramidStream {
  /** The source's next row (plan.width px of RGBA, top to bottom). */
  push_row(row: Uint8Array | Uint8ClampedArray): Promise<void>;
  /** After the last row: finishes every level (the pad) and hands back the preview, if one was asked for. */
  end(): Promise<RgbaImage | null>;
}

export function create_pyramid_stream(options: PyramidStreamOptions): PyramidStream {
  const { plan, downscale, on_tile, preview } = options;
  const halve = halving_of(downscale);
  // the content area of the preview's level (more than the preview itself when z0 is halved further)
  const preview_level = preview ? plan.levels[preview.zoom] : null;
  const preview_image: RgbaImage | null =
    preview && preview_level
      ? (() => {
          const width = Math.ceil(plan.width / preview_level.scale);
          const height = Math.ceil(plan.height / preview_level.scale);
          return { data: new Uint8ClampedArray(width * height * 4), width, height };
        })()
      : null;

  // built from z0 up, so every level knows the one below it
  let below: LevelStream | null = null;
  for (const level of plan.levels) {
    below = new LevelStream(
      level,
      plan.tile_size,
      halve,
      on_tile,
      below,
      preview_image && level.zoom === preview?.zoom ? { image: preview_image } : null
    );
  }
  const top = below!;
  let rows = 0;

  return {
    async push_row(row) {
      if (row.length !== plan.width * 4) {
        throw new RangeError(`A source row is ${plan.width * 4} bytes, got ${row.length}`);
      }
      if (rows >= plan.height) throw new RangeError(`The source has ${plan.height} rows, a row more was pushed`);
      rows++;
      await top.push_row(row);
    },
    async end() {
      if (rows !== plan.height) throw new RangeError(`The source has ${plan.height} rows, ${rows} were pushed`);
      await top.end();
      if (!preview || !preview_image) return null;
      let image = preview_image;
      for (let i = 0; i < preview.extra_halvings; i++) image = halve_image(image, downscale);
      if (image.width !== preview.width || image.height !== preview.height) {
        throw new Error(`The preview came out ${image.width}x${image.height}, not ${preview.width}x${preview.height}`);
      }
      return image;
    }
  };
}
