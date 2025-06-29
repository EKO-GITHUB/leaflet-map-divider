import JSZip from "jszip";
import { OutputFormat, TileGenerationProgress, ZoomLevelProgress } from "@/types/types";
import { MIME_TYPES } from "@/constants/constants";

interface TileGeneratorOptions {
  image: HTMLImageElement;
  max_zoom_level: number;
  output_format: OutputFormat;
  file_name: string;
  on_progress?: (progress: TileGenerationProgress) => void;
  on_error?: (error: string) => void;
}

interface TileGeneratorState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tile_canvas: HTMLCanvasElement;
  tile_ctx: CanvasRenderingContext2D;
  zip: JSZip;
}

const PROGRESS_BATCH_SIZE = 10;

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

function calculate_total_tiles(max_zoom_level: number): number {
  let total = 0;
  for (let z = max_zoom_level; z >= 0; z--) {
    const tiles_per_side = Math.pow(2, z);
    total += tiles_per_side * tiles_per_side;
  }
  return total;
}

function initialize_zoom_levels_progress(max_zoom_level: number): ZoomLevelProgress[] {
  const zoom_levels: ZoomLevelProgress[] = [];
  for (let z = max_zoom_level; z >= 0; z--) {
    const tiles_per_side = Math.pow(2, z);
    const total_tiles_in_level = tiles_per_side * tiles_per_side;
    zoom_levels.push({
      zoom_level: z,
      total_tiles_in_level,
      processed_tiles_in_level: 0,
      progress_percentage: 0,
      is_complete: false
    });
  }
  return zoom_levels;
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

async function generate_tile(
  state: TileGeneratorState,
  options: {
    x: number;
    y: number;
    zoom_level: number;
    tile_size: number;
    output_format: OutputFormat;
  }
): Promise<void> {
  const { x, y, zoom_level, tile_size, output_format } = options;

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

    const data_url = state.tile_canvas.toDataURL(mime_type, 1.0);
    const base64_data = data_url.replace(/^data:image\/(png|jpg|webp);base64,/, "");

    state.zip.file(
      `${zoom_level}/${y}/${x}.${output_format}`,
      base64_data,
      { base64: true }
    );
  } catch (error) {
    throw new Error(`Failed to generate tile ${x},${y} at zoom ${zoom_level}: ${error}`);
  }
}

async function generate_zoom_level(
  state: TileGeneratorState,
  options: {
    image: HTMLImageElement;
    zoom_level: number;
    max_zoom_level: number;
    output_format: OutputFormat;
    on_progress?: (processed_count: number) => void;
    on_tile_progress?: (x: number, y: number) => void;
  }
): Promise<void> {
  const { image, zoom_level, max_zoom_level, output_format, on_progress, on_tile_progress } = options;

  const scale = Math.pow(2, max_zoom_level - zoom_level);
  const scaled_width = image.naturalWidth / scale;
  const scaled_height = image.naturalHeight / scale;

  setup_canvas(state, scaled_width, scaled_height);
  draw_scaled_image(state, image, scaled_width, scaled_height, scale);

  const tiles_per_side = Math.pow(2, zoom_level);
  const tile_size = scaled_width / tiles_per_side;
  let processed_count = 0;

  for (let x = 0; x < tiles_per_side; x++) {
    for (let y = 0; y < tiles_per_side; y++) {
      await generate_tile(state, {
        x,
        y,
        zoom_level,
        tile_size,
        output_format
      });

      processed_count++;
      on_tile_progress?.(x, y);

      if (processed_count % PROGRESS_BATCH_SIZE === 0) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }
  }

  on_progress?.(processed_count);
}

export async function generate_tiles(options: TileGeneratorOptions): Promise<Blob> {
  const { image, max_zoom_level, output_format, on_progress, on_error } = options;

  const state = create_generator_state();
  if (!state) {
    const error = "Failed to initialize tile generator";
    on_error?.(error);
    throw new Error(error);
  }

  try {
    const total_tiles = calculate_total_tiles(max_zoom_level);
    const zoom_levels_progress = initialize_zoom_levels_progress(max_zoom_level);
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
        zoom_level: z,
        max_zoom_level,
        output_format,
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

    return await state.zip.generateAsync({ type: "blob" });
  } catch (error) {
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