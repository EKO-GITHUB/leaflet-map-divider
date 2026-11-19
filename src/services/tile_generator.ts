import JSZip from "jszip";
import { OutputFormat, TileGenerationProgress, ZoomLevelProgress } from "@/types/types";
import { MIME_TYPES } from "@/constants/constants";
import { TileLevel, TilePlan } from "@/services/tile_plan";
import { DEFAULT_DOWNSCALE_MODE, DownscaleMode, downscale_2x } from "@/services/downscale";
import { is_blank_region } from "@/services/blank_tile";

interface TileGeneratorOptions {
  image: HTMLImageElement;
  plan: TilePlan;
  output_format: OutputFormat;
  // how the levels below the top zoom are made (see downscale.ts); "pixel" when left out
  downscale?: DownscaleMode;
  // a tile whose pixels all have alpha 0 is not written (it still counts as processed, and as skipped); every tile is
  // written when left out
  skip_blank?: boolean;
  file_name: string;
  on_progress?: (progress: TileGenerationProgress) => void;
  on_error?: (error: string) => void;
  // aborting stops the cut before the next tile (or while the zip is being built) and rejects with the signal's reason
  signal?: AbortSignal;
}

interface TileGeneratorState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tile_canvas: HTMLCanvasElement;
  tile_ctx: CanvasRenderingContext2D;
  // the tile-sized buffer a level held in memory is copied through (smooth downscale)
  tile_image_data: ImageData | null;
  zip: JSZip;
}

// a level held in memory: row-major RGBA, size x size
interface LevelPixels {
  data: Uint8ClampedArray;
  size: number;
}

// where a zoom level's pixels come from: the source image drawn at the level's scale, or a level the smooth
// downscale built from the level above
type LevelSource = { kind: "image"; image: HTMLImageElement } | { kind: "pixels"; pixels: LevelPixels };

// the smooth downscale reads and shrinks a level in bands of about this many source pixels, yielding to the browser
// between bands (the top level of a 16384 px image is 1 GiB of RGBA)
const DOWNSCALE_BAND_PIXELS = 1 << 22;

const PROGRESS_BATCH_SIZE = 10;
// encodes started and not yet in the zip; Chrome encodes WebP off the main thread, so several overlap
export const MAX_PENDING_ENCODES = 16;

// yields to the browser (a task, so it can render and handle input) every PROGRESS_BATCH_SIZE tiles; an abort ends
// the wait at once. A task, not a frame: requestAnimationFrame caps the cut at one batch per frame and never fires in
// a background tab
function next_task(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const on_abort = () => {
      channel.port1.close();
      reject(signal?.reason);
    };
    channel.port1.onmessage = () => {
      channel.port1.close();
      signal?.removeEventListener("abort", on_abort);
      resolve();
    };
    signal?.addEventListener("abort", on_abort, { once: true });
    channel.port2.postMessage(null);
  });
}

// JSZip's generateAsync is generateInternalStream(...).accumulate(); the stream is paused on an abort. Entries are
// stored uncompressed: PNG and WebP tiles are compressed already
function build_zip(zip: JSZip, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const stream = zip.generateInternalStream({ type: "blob", compression: "STORE" });
  if (!signal) return stream.accumulate();

  return new Promise((resolve, reject) => {
    const on_abort = () => {
      stream.pause();
      reject(signal.reason);
    };
    if (signal.aborted) {
      on_abort();
      return;
    }
    signal.addEventListener("abort", on_abort, { once: true });
    stream.accumulate().then(
      blob => {
        signal.removeEventListener("abort", on_abort);
        resolve(blob);
      },
      error => {
        signal.removeEventListener("abort", on_abort);
        reject(error);
      }
    );
  });
}

function create_generator_state(): TileGeneratorState | null {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const tile_canvas = document.createElement("canvas");
    const tile_ctx = tile_canvas.getContext("2d");

    if (!ctx || !tile_ctx) {
      throw new Error("Canvas context not supported");
    }

    const zip = new JSZip();

    return { canvas, ctx, tile_canvas, tile_ctx, tile_image_data: null, zip };
  } catch (error) {
    console.error("Failed to create generator state:", error);
    return null;
  }
}

function cleanup_generator_state(state: TileGeneratorState) {
  state.canvas.width = 0;
  state.canvas.height = 0;
  state.tile_canvas.width = 0;
  state.tile_canvas.height = 0;
}

// the cut runs from the maximum zoom down to z0
function initialize_zoom_levels_progress(plan: TilePlan): ZoomLevelProgress[] {
  return [...plan.levels].reverse().map(level => ({
    zoom_level: level.zoom,
    total_tiles_in_level: level.tile_count,
    processed_tiles_in_level: 0,
    skipped_tiles_in_level: 0,
    progress_percentage: 0,
    is_complete: false
  }));
}


function setup_canvas(state: TileGeneratorState, width: number, height: number) {
  state.canvas.width = width;
  state.canvas.height = height;
  state.ctx.imageSmoothingEnabled = false;
  state.ctx.clearRect(0, 0, width, height);
}

function draw_scaled_image(
  state: TileGeneratorState,
  image: HTMLImageElement,
  scaled_width: number,
  scaled_height: number,
  scale: number
) {
  try {
    if (scale === 1) {
      state.ctx.drawImage(image, 0, 0, scaled_width, scaled_height);
    } else {
      state.ctx.drawImage(
        image,
        0,
        0,
        image.naturalWidth,
        image.naturalHeight,
        0,
        0,
        scaled_width,
        scaled_height
      );
    }
  } catch (error) {
    throw new Error(`Failed to draw scaled image: ${error}`);
  }
}

// an even number of rows of a size px wide level, about DOWNSCALE_BAND_PIXELS pixels
function band_rows(size: number): number {
  const rows = Math.max(2, Math.floor(DOWNSCALE_BAND_PIXELS / size));
  return Math.min(size, rows - (rows % 2));
}

// the smooth downscale of a size x size level, band by band; read_band(y, rows) hands back that band's RGBA. Yields
// to the browser between bands, and an abort stops it there
async function downscale_level(
  size: number,
  read_band: (y: number, rows: number) => Uint8Array | Uint8ClampedArray,
  signal?: AbortSignal
): Promise<LevelPixels> {
  const half = size / 2;
  const data = new Uint8ClampedArray(half * half * 4);
  const rows = band_rows(size);
  for (let y = 0; y < size; y += rows) {
    signal?.throwIfAborted();
    const height = Math.min(rows, size - y);
    downscale_2x(read_band(y, height), size, height, data.subarray((y / 2) * half * 4, ((y + height) / 2) * half * 4));
    await next_task(signal);
  }
  return { data, size: half };
}

// the level below the one the canvas holds. The canvas is read once (the top level); every lower level is made from
// the one above it in memory, so the canvas's premultiplied storage never adds an error that is carried down
function downscale_canvas(state: TileGeneratorState, size: number, signal?: AbortSignal): Promise<LevelPixels> {
  return downscale_level(size, (y, rows) => state.ctx.getImageData(0, y, size, rows).data, signal);
}

function downscale_pixels(level: LevelPixels, signal?: AbortSignal): Promise<LevelPixels> {
  const { data, size } = level;
  return downscale_level(size, (y, rows) => data.subarray(y * size * 4, (y + rows) * size * 4), signal);
}

// copies the tile at (start_x, start_y) of a level held in memory into the tile canvas
function put_level_tile(state: TileGeneratorState, level: LevelPixels, start_x: number, start_y: number, tile_size: number) {
  let image_data = state.tile_image_data;
  if (!image_data || image_data.width !== tile_size || image_data.height !== tile_size) {
    image_data = state.tile_ctx.createImageData(tile_size, tile_size);
    state.tile_image_data = image_data;
  }
  const row_bytes = tile_size * 4;
  for (let row = 0; row < tile_size; row++) {
    const from = ((start_y + row) * level.size + start_x) * 4;
    image_data.data.set(level.data.subarray(from, from + row_bytes), row * row_bytes);
  }
  // putImageData replaces the pixels (no compositing) and copies them, so the buffer is reused for the next tile
  state.tile_ctx.putImageData(image_data, 0, 0);
}

// which tiles of the level the canvas holds are blank (every alpha 0), by y * tiles_per_side + x. The canvas is read
// once, in bands of whole tile rows of about DOWNSCALE_BAND_PIXELS pixels, instead of reading every tile back: a
// read of a GPU canvas is a slow round trip, and the tile canvas stays as it is, so the tiles that are written come out
// exactly as when nothing is skipped. Yields between bands; an abort stops it there
async function blank_tiles_of_canvas(state: TileGeneratorState, level: TileLevel, tile_size: number, signal?: AbortSignal) {
  const { tiles_per_side, level_size } = level;
  const blank = new Uint8Array(tiles_per_side * tiles_per_side);
  const tile_rows = Math.max(1, Math.floor(DOWNSCALE_BAND_PIXELS / (level_size * tile_size)));
  for (let ty = 0; ty < tiles_per_side; ty += tile_rows) {
    signal?.throwIfAborted();
    const rows = Math.min(tile_rows, tiles_per_side - ty);
    const band = state.ctx.getImageData(0, ty * tile_size, level_size, rows * tile_size).data;
    for (let row = 0; row < rows; row++) {
      for (let tx = 0; tx < tiles_per_side; tx++) {
        if (is_blank_region(band, level_size, tx * tile_size, row * tile_size, tile_size)) {
          blank[(ty + row) * tiles_per_side + tx] = 1;
        }
      }
    }
    await next_task(signal);
  }
  return blank;
}

// an encode that has been started but whose bytes are not in the zip yet
interface PendingTile {
  path: string;
  label: string;
  bytes: Promise<ArrayBuffer>;
}

// quality 1.0 makes Chrome's WebP lossless (PNG ignores it), as toDataURL(type, 1.0) did
function encode_canvas(canvas: HTMLCanvasElement, mime_type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error("the canvas could not be encoded"))),
      mime_type,
      1.0
    );
  });
}

// draws the tile and starts encoding it; toBlob copies the canvas when it is called, so the tile canvas can be redrawn
// for the next tile while this one is still encoding
function start_tile(
  state: TileGeneratorState,
  options: {
    x: number;
    y: number;
    zoom_level: number;
    tile_size: number;
    output_format: OutputFormat;
    // a level held in memory; the level canvas when left out
    pixels?: LevelPixels;
  }
): PendingTile {
  const { x, y, zoom_level, tile_size, output_format, pixels } = options;
  const label = `tile ${x},${y} at zoom ${zoom_level}`;

  try {
    const start_x = x * tile_size;
    const start_y = y * tile_size;

    state.tile_canvas.width = tile_size;
    state.tile_canvas.height = tile_size;
    state.tile_ctx.imageSmoothingEnabled = false;

    if (pixels) {
      put_level_tile(state, pixels, start_x, start_y, tile_size);
    } else {
      state.tile_ctx.drawImage(
        state.canvas,
        start_x,
        start_y,
        tile_size,
        tile_size,
        0,
        0,
        tile_size,
        tile_size
      );
    }

    const mime_type = MIME_TYPES[output_format];
    if (!mime_type) {
      throw new Error(`Unsupported output format: ${output_format}`);
    }

    const bytes = encode_canvas(state.tile_canvas, mime_type).then(blob => blob.arrayBuffer());
    // the error is reported when the tile is awaited; an encode left behind by an abort must not be an unhandled
    // rejection
    bytes.catch(() => {});

    return { path: `${zoom_level}/${y}/${x}.${output_format}`, label, bytes };
  } catch (error) {
    throw new Error(`Failed to generate ${label}: ${error}`);
  }
}

// waits for a started encode and adds its bytes to the zip (no base64 round trip)
async function finish_tile(state: TileGeneratorState, tile: PendingTile, signal?: AbortSignal): Promise<void> {
  let bytes: ArrayBuffer;
  try {
    bytes = await tile.bytes;
  } catch (error) {
    throw new Error(`Failed to generate ${tile.label}: ${error}`);
  }
  signal?.throwIfAborted();
  state.zip.file(tile.path, bytes, { binary: true });
}

async function generate_zoom_level(
  state: TileGeneratorState,
  options: {
    source: LevelSource;
    level: TileLevel;
    tile_size: number;
    output_format: OutputFormat;
    skip_blank: boolean;
    on_progress?: (processed_count: number) => void;
    // a tile was written (skipped false) or left out as blank (skipped true)
    on_tile_progress?: (skipped: boolean) => void;
    signal?: AbortSignal;
  }
): Promise<void> {
  const { source, level, tile_size, output_format, skip_blank, on_progress, on_tile_progress, signal } = options;
  const { zoom: zoom_level, tiles_per_side, level_size, scale } = level;

  signal?.throwIfAborted();

  let pixels: LevelPixels | undefined;
  // with skip_blank: is the tile at (x, y) blank, so it is not written
  let is_blank_tile: ((x: number, y: number) => boolean) | null = null;
  if (source.kind === "image") {
    // the image sits at the top left of the level's square; under tile size "auto" it fills it exactly
    const { image } = source;
    setup_canvas(state, level_size, level_size);
    draw_scaled_image(state, image, image.naturalWidth / scale, image.naturalHeight / scale, scale);
    if (skip_blank) {
      const blank = await blank_tiles_of_canvas(state, level, tile_size, signal);
      is_blank_tile = (x, y) => blank[y * tiles_per_side + x] === 1;
    }
  } else {
    const level_pixels = source.pixels;
    pixels = level_pixels;
    if (level_pixels.size !== level_size) {
      throw new Error(`Zoom ${zoom_level} is ${level_size}px, but its downscaled pixels are ${level_pixels.size}px`);
    }
    // a level in memory is checked in place
    if (skip_blank) {
      is_blank_tile = (x, y) => is_blank_region(level_pixels.data, level_size, x * tile_size, y * tile_size, tile_size);
    }
  }

  let processed_count = 0;
  // encodes in flight, oldest first; they are added to the zip in the order they were started
  const pending: PendingTile[] = [];

  // a skipped tile counts at once; it counts towards the yields too, so a long run of blank tiles still lets the
  // browser in
  const count_tile = async (skipped: boolean) => {
    processed_count++;
    on_tile_progress?.(skipped);

    if (processed_count % PROGRESS_BATCH_SIZE === 0) {
      await next_task(signal);
    }
  };

  const finish_oldest = async () => {
    const tile = pending.shift();
    if (!tile) return;
    await finish_tile(state, tile, signal);
    await count_tile(false);
  };

  for (let x = 0; x < tiles_per_side; x++) {
    for (let y = 0; y < tiles_per_side; y++) {
      signal?.throwIfAborted();

      if (is_blank_tile?.(x, y)) {
        await count_tile(true);
        continue;
      }
      pending.push(start_tile(state, { x, y, zoom_level, tile_size, output_format, pixels }));

      if (pending.length >= MAX_PENDING_ENCODES) {
        await finish_oldest();
      }
    }
  }

  while (pending.length > 0) {
    await finish_oldest();
  }

  on_progress?.(processed_count);
}

export async function generate_tiles(options: TileGeneratorOptions): Promise<Blob> {
  const { image, plan, output_format, on_progress, on_error, signal } = options;
  const downscale = options.downscale ?? DEFAULT_DOWNSCALE_MODE;
  const skip_blank = options.skip_blank ?? false;
  const { max_zoom: max_zoom_level, total_tiles } = plan;

  signal?.throwIfAborted();

  const state = create_generator_state();
  if (!state) {
    const error = "Failed to initialize tile generator";
    on_error?.(error);
    throw new Error(error);
  }

  try {
    const zoom_levels_progress = initialize_zoom_levels_progress(plan);
    let processed_tile_count = 0;
    let skipped_tile_count = 0;
    const start_time = Date.now();
    let last_update_time = start_time;
    // smooth: the level below the one just cut, made from it. Pixel (and the top level): drawn from the image
    let below: LevelPixels | null = null;

    on_progress?.({
      current_zoom_level: max_zoom_level,
      progress: 0,
      total_tiles,
      processed_tiles: 0,
      skipped_tiles: 0,
      zoom_levels_progress: [...zoom_levels_progress],
      current_stage: "preparing"
    });

    for (let zoom_index = 0; zoom_index < zoom_levels_progress.length; zoom_index++) {
      const z = zoom_levels_progress[zoom_index].zoom_level;

      on_progress?.({
        current_zoom_level: z,
        progress: Math.floor((processed_tile_count / total_tiles) * 100),
        total_tiles,
        processed_tiles: processed_tile_count,
        skipped_tiles: skipped_tile_count,
        zoom_levels_progress: [...zoom_levels_progress],
        current_stage: "generating"
      });

      const source: LevelSource = below ? { kind: "pixels", pixels: below } : { kind: "image", image };

      await generate_zoom_level(state, {
        source,
        level: plan.levels[z],
        tile_size: plan.tile_size,
        output_format,
        skip_blank,
        signal,
        on_tile_progress: skipped => {
          zoom_levels_progress[zoom_index].processed_tiles_in_level++;
          if (skipped) {
            zoom_levels_progress[zoom_index].skipped_tiles_in_level++;
            skipped_tile_count++;
          }
          zoom_levels_progress[zoom_index].progress_percentage = Math.floor(
            (zoom_levels_progress[zoom_index].processed_tiles_in_level /
              zoom_levels_progress[zoom_index].total_tiles_in_level) * 100
          );

          processed_tile_count++;
          const current_time = Date.now();
          const elapsed_seconds = (current_time - start_time) / 1000;
          const tiles_per_second = processed_tile_count / elapsed_seconds;

          if (current_time - last_update_time >= 100) {
            const overall_progress = Math.floor((processed_tile_count / total_tiles) * 100);

            on_progress?.({
              current_zoom_level: z,
              progress: overall_progress,
              total_tiles,
              processed_tiles: processed_tile_count,
              skipped_tiles: skipped_tile_count,
              zoom_levels_progress: [...zoom_levels_progress],
              current_stage: "generating",
              tiles_per_second: Math.round(tiles_per_second * 10) / 10
            });

            last_update_time = current_time;
          }
        },
        on_progress: () => {
          zoom_levels_progress[zoom_index].is_complete = true;
          zoom_levels_progress[zoom_index].progress_percentage = 100;

          const current_time = Date.now();
          const elapsed_seconds = (current_time - start_time) / 1000;
          const tiles_per_second = processed_tile_count / elapsed_seconds;

          on_progress?.({
            current_zoom_level: z,
            progress: Math.floor((processed_tile_count / total_tiles) * 100),
            total_tiles,
            processed_tiles: processed_tile_count,
            skipped_tiles: skipped_tile_count,
            zoom_levels_progress: [...zoom_levels_progress],
            current_stage: "generating",
            tiles_per_second: Math.round(tiles_per_second * 10) / 10
          });
        }
      });

      if (downscale === "smooth" && z > 0) {
        if (source.kind === "image") {
          below = await downscale_canvas(state, plan.levels[z].level_size, signal);
          // the level canvas is not drawn again in this cut; let its memory go
          setup_canvas(state, 0, 0);
        } else {
          below = await downscale_pixels(source.pixels, signal);
        }
      }
    }

    on_progress?.({
      current_zoom_level: 0,
      progress: 100,
      total_tiles,
      processed_tiles: processed_tile_count,
      skipped_tiles: skipped_tile_count,
      zoom_levels_progress: [...zoom_levels_progress],
      current_stage: "complete",
      tiles_per_second: Math.round((processed_tile_count / ((Date.now() - start_time) / 1000)) * 10) / 10
    });

    return await build_zip(state.zip, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const error_message = error instanceof Error ? error.message : "Unknown error occurred";
    on_error?.(error_message);
    throw error;
  } finally {
    cleanup_generator_state(state);
  }
}

export async function download_zip_file(blob: Blob, file_name: string): Promise<void> {
  try {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);

    a.href = url;
    a.download = `${file_name.replace(/\.[^/.]+$/, "") || "tiles"}.zip`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
  } catch (error) {
    throw new Error(`Failed to download file: ${error}`);
  }
}