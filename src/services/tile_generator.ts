import JSZip from "jszip";
import { OutputFormat, TileGenerationProgress, ZoomLevelProgress } from "@/types/types";
import { MIME_TYPES } from "@/constants/constants";
import { TileLevel, TilePlan } from "@/services/tile_plan";

interface TileGeneratorOptions {
  image: HTMLImageElement;
  plan: TilePlan;
  output_format: OutputFormat;
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
  zip: JSZip;
}

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

    return { canvas, ctx, tile_canvas, tile_ctx, zip };
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
  }
): PendingTile {
  const { x, y, zoom_level, tile_size, output_format } = options;
  const label = `tile ${x},${y} at zoom ${zoom_level}`;

  try {
    const start_x = x * tile_size;
    const start_y = y * tile_size;

    state.tile_canvas.width = tile_size;
    state.tile_canvas.height = tile_size;
    state.tile_ctx.imageSmoothingEnabled = false;

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
    image: HTMLImageElement;
    level: TileLevel;
    tile_size: number;
    output_format: OutputFormat;
    on_progress?: (processed_count: number) => void;
    on_tile_progress?: () => void;
    signal?: AbortSignal;
  }
): Promise<void> {
  const { image, level, tile_size, output_format, on_progress, on_tile_progress, signal } = options;
  const { zoom: zoom_level, tiles_per_side, level_size, scale } = level;

  signal?.throwIfAborted();

  // the image sits at the top left of the level's square; under tile size "auto" it fills it exactly
  setup_canvas(state, level_size, level_size);
  draw_scaled_image(state, image, image.naturalWidth / scale, image.naturalHeight / scale, scale);

  let processed_count = 0;
  // encodes in flight, oldest first; they are added to the zip in the order they were started
  const pending: PendingTile[] = [];

  const finish_oldest = async () => {
    const tile = pending.shift();
    if (!tile) return;
    await finish_tile(state, tile, signal);

    processed_count++;
    on_tile_progress?.();

    if (processed_count % PROGRESS_BATCH_SIZE === 0) {
      await next_task(signal);
    }
  };

  for (let x = 0; x < tiles_per_side; x++) {
    for (let y = 0; y < tiles_per_side; y++) {
      signal?.throwIfAborted();

      pending.push(start_tile(state, { x, y, zoom_level, tile_size, output_format }));

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
    const start_time = Date.now();
    let last_update_time = start_time;

    on_progress?.({
      current_zoom_level: max_zoom_level,
      progress: 0,
      total_tiles,
      processed_tiles: 0,
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
        zoom_levels_progress: [...zoom_levels_progress],
        current_stage: "generating"
      });

      await generate_zoom_level(state, {
        image,
        level: plan.levels[z],
        tile_size: plan.tile_size,
        output_format,
        signal,
        on_tile_progress: () => {
          zoom_levels_progress[zoom_index].processed_tiles_in_level++;
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
            zoom_levels_progress: [...zoom_levels_progress],
            current_stage: "generating",
            tiles_per_second: Math.round(tiles_per_second * 10) / 10
          });
        }
      });
    }

    on_progress?.({
      current_zoom_level: 0,
      progress: 100,
      total_tiles,
      processed_tiles: processed_tile_count,
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