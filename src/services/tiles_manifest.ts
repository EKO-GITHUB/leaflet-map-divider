import { OutputFormat } from "@/types/types";
import { DownscaleMode } from "@/services/downscale";
import { TilePlan, TileSizeMode } from "@/services/tile_plan";
import { PREVIEW_FILE, PreviewPlan } from "@/services/preview";

// tiles.json, the manifest at the root of every archive: what was cut (the source, by name, size and sha256), how
// (tile size, downscale, blank tiles) and what came out (the layout, the levels and the tiles written per level). Pure
// code, shared with the command-line cutter, so both write the same manifest for the same cut (apart from created_at).

export const MANIFEST_FILE = "tiles.json";
/** Raised when a field changes meaning or is removed; adding a field keeps the version. */
export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_GENERATOR = "leafletmapdivider";

/** A tile's path in the archive: zoom / row (y, counted from the top) / column (x). */
export function tile_path(zoom: number, x: number, y: number, format: OutputFormat): string {
  return `${zoom}/${y}/${x}.${format}`;
}

export interface ManifestLevel {
  zoom: number;
  tiles_per_side: number;
  /** source pixels along one side of a tile of this zoom */
  source_tile_size: number;
  /** tile columns and rows that hold image pixels (from the left and the top); the others hold only the pad */
  content_columns: number;
  content_rows: number;
  /** tiles in the archive */
  written: number;
  /** blank tiles left out (all 0 unless skip_blank) */
  skipped: number;
}

export interface TilesManifest {
  format_version: number;
  generator: string;
  /** when the cut finished (ISO 8601, UTC) */
  created_at: string;
  source: {
    name: string;
    /** the source image's size in px; at the maximum zoom one pixel is one source pixel */
    width: number;
    height: number;
    /** sha256 of the source file's bytes, lowercase hex */
    sha256: string;
  };
  /** the square the image is padded to (image at the top left, transparent pad right and below) */
  padded_size: number;
  tile_size_mode: TileSizeMode;
  /** side of every tile, in px */
  tile_size: number;
  min_zoom: 0;
  max_zoom: number;
  format: OutputFormat;
  /** tiles are `{z}/{y}/{x}.<format>` with x from the left and y from the top (XYZ, not TMS) */
  layout: "z/y/x";
  y_origin: "top";
  path_template: string;
  downscale: DownscaleMode;
  skip_blank: boolean;
  tiles: { total: number; written: number; skipped: number };
  /** indexed by zoom, 0 .. max_zoom */
  levels: ManifestLevel[];
  preview: {
    path: string;
    /** the pyramid level it was taken from, and the halvings of that level after it (see preview.ts) */
    zoom: number;
    extra_halvings: number;
    /** source pixels per preview pixel along each side */
    scale: number;
    width: number;
    height: number;
  };
}

export interface ManifestInput {
  plan: TilePlan;
  source: { name: string; sha256: string };
  format: OutputFormat;
  downscale: DownscaleMode;
  skip_blank: boolean;
  /** the tiles written and skipped at each zoom, indexed by zoom */
  counts: readonly { written: number; skipped: number }[];
  preview: PreviewPlan;
  created_at: Date;
}

export function build_tiles_manifest(input: ManifestInput): TilesManifest {
  const { plan, source, format, downscale, skip_blank, counts, preview, created_at } = input;
  if (!/^[0-9a-f]{64}$/.test(source.sha256)) {
    throw new RangeError(`build_tiles_manifest: sha256 must be 64 lowercase hex digits, got "${source.sha256}"`);
  }
  if (counts.length !== plan.levels.length) {
    throw new RangeError(`build_tiles_manifest: ${counts.length} level counts for ${plan.levels.length} levels`);
  }

  const levels = plan.levels.map((level, zoom): ManifestLevel => {
    const { written, skipped } = counts[zoom];
    if (![written, skipped].every(Number.isInteger) || written < 0 || skipped < 0) {
      throw new RangeError(`build_tiles_manifest: bad counts at zoom ${zoom}: ${written} written, ${skipped} skipped`);
    }
    if (written + skipped !== level.tile_count) {
      throw new RangeError(
        `build_tiles_manifest: zoom ${zoom} has ${level.tile_count} tiles, but ${written} written + ${skipped} skipped`
      );
    }
    if (!skip_blank && skipped > 0) {
      throw new RangeError(`build_tiles_manifest: ${skipped} tiles skipped at zoom ${zoom} without skip_blank`);
    }
    return {
      zoom,
      tiles_per_side: level.tiles_per_side,
      source_tile_size: level.source_tile_size,
      content_columns: level.content_columns,
      content_rows: level.content_rows,
      written,
      skipped
    };
  });
  const written = levels.reduce((sum, level) => sum + level.written, 0);
  const skipped = levels.reduce((sum, level) => sum + level.skipped, 0);

  return {
    format_version: MANIFEST_FORMAT_VERSION,
    generator: MANIFEST_GENERATOR,
    created_at: created_at.toISOString(),
    source: { name: source.name, width: plan.width, height: plan.height, sha256: source.sha256 },
    padded_size: plan.padded_size,
    tile_size_mode: plan.tile_size_mode,
    tile_size: plan.tile_size,
    min_zoom: 0,
    max_zoom: plan.max_zoom,
    format,
    layout: "z/y/x",
    y_origin: "top",
    path_template: `{z}/{y}/{x}.${format}`,
    downscale,
    skip_blank,
    tiles: { total: plan.total_tiles, written, skipped },
    levels,
    preview: { path: PREVIEW_FILE, ...preview }
  };
}

/** The manifest as written to tiles.json: two-space indented, a trailing newline. */
export function serialize_tiles_manifest(manifest: TilesManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * sha256 of some bytes as lowercase hex (Web Crypto: the browser and Node 24 alike). Throws at once, not when awaited,
 * where Web Crypto is missing (a page served over plain http from another host), so a cut fails before it starts.
 */
export function sha256_hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Hashing needs Web Crypto: open the page over https or from localhost");
  }
  const bytes = data instanceof Blob ? data.arrayBuffer() : Promise.resolve(data);
  return bytes
    .then(buffer => subtle.digest("SHA-256", buffer as BufferSource))
    .then(digest => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
}
