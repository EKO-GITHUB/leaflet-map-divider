import { DownscaleMode, halving_of } from "@/services/downscale";
import { TilePlan } from "@/services/tile_plan";

// The archive's preview.webp: the image's content area (the top-left width x height of the padded square, never the
// pad) at most PREVIEW_MAX_SIZE px on its longest side. It is a level of the pyramid itself, so it lines up with the
// tiles exactly (one preview pixel is `scale` source pixels, a power of two) and is made with the cut's downscale mode.
// When even z0's content is larger than PREVIEW_MAX_SIZE (tile size "auto" with an odd tile side above it), z0 is
// halved further, the way a lower level would be. Pure code (no canvas, no DOM), shared with the command-line cutter.

export const PREVIEW_FILE = "preview.webp";
export const PREVIEW_MIME_TYPE = "image/webp";
export const PREVIEW_MAX_SIZE = 1024;

type Pixels = Uint8Array | Uint8ClampedArray;

export interface PreviewPlan {
  /** the zoom level the preview is taken from */
  zoom: number;
  /** halvings of that level's content after it is taken (0 unless z0's content is larger than PREVIEW_MAX_SIZE) */
  extra_halvings: number;
  /** source pixels per preview pixel along each side (a power of two; 1 when the image is small enough as it is) */
  scale: number;
  /** the preview's size: ceil(width / scale) x ceil(height / scale) */
  width: number;
  height: number;
}

/** A content-area image: row-major RGBA, width x height. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The size of the content area at `scale` source pixels per pixel (a partly covered edge pixel counts). */
export function content_size(plan: TilePlan, scale: number): { width: number; height: number } {
  return { width: Math.ceil(plan.width / scale), height: Math.ceil(plan.height / scale) };
}

/** Which level the preview comes from: the largest one whose content fits in PREVIEW_MAX_SIZE px each way. */
export function plan_preview(plan: TilePlan): PreviewPlan {
  const longest_side = Math.max(plan.width, plan.height);
  let halvings = 0;
  while (Math.ceil(longest_side / 2 ** halvings) > PREVIEW_MAX_SIZE) halvings++;
  const scale = 2 ** halvings;
  return {
    zoom: Math.max(0, plan.max_zoom - halvings),
    extra_halvings: Math.max(0, halvings - plan.max_zoom),
    scale,
    ...content_size(plan, scale)
  };
}

/** The width x height rectangle at the top left of an RGBA image `source_width` px wide, as its own image. */
export function crop_top_left(source: Pixels, source_width: number, width: number, height: number): RgbaImage {
  if (![source_width, width, height].every(Number.isInteger) || width < 1 || height < 1 || width > source_width) {
    throw new RangeError(`crop_top_left: cannot crop ${width}x${height} from an image ${source_width}px wide`);
  }
  if (source_width * height * 4 > source.length) {
    throw new RangeError(`crop_top_left: the image has fewer than ${height} rows`);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const row_bytes = width * 4;
  for (let y = 0; y < height; y++) {
    const from = y * source_width * 4;
    data.set(source.subarray(from, from + row_bytes), y * row_bytes);
  }
  return { data, width, height };
}

/**
 * The image at half its size, ceil(width / 2) x ceil(height / 2), as the pyramid would make the next level: an odd
 * side is padded with one transparent column or row first (the pad beyond the content is transparent too), then the
 * mode's halving is applied: downscale_2x for "smooth", pick_2x (the top-left pixel of each 2x2 cell) for "pixel".
 */
export function halve_image(image: RgbaImage, mode: DownscaleMode): RgbaImage {
  const { width, height } = image;
  const out_width = Math.ceil(width / 2);
  const out_height = Math.ceil(height / 2);
  const even_width = out_width * 2;
  const even_height = out_height * 2;
  const source =
    even_width === width && even_height === height ? image : pad_image(image, even_width, even_height);
  return { data: halving_of(mode)(source.data, even_width, even_height), width: out_width, height: out_height };
}

function pad_image(image: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const row_bytes = image.width * 4;
  for (let y = 0; y < image.height; y++) {
    data.set(image.data.subarray(y * row_bytes, (y + 1) * row_bytes), y * width * 4);
  }
  return { data, width, height };
}
