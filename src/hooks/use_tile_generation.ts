import { useCallback, useEffect, useRef, useState } from "react";
import { MapImage, OutputFormat, TileGenerationProgress } from "@/types/types";
import { download_zip_file, generate_tiles } from "@/services/tile_generator";
import { DEFAULT_DOWNSCALE_MODE, DownscaleMode } from "@/services/downscale";
import { DEFAULT_SKIP_BLANK } from "@/services/blank_tile";

export function useTileGeneration() {
  const [is_generating, set_is_generating] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const [progress, set_progress] = useState<TileGenerationProgress>({
    current_zoom_level: 0,
    progress: 0,
    total_tiles: 0,
    processed_tiles: 0,
    skipped_tiles: 0,
    zoom_levels_progress: [],
    current_stage: "preparing"
  });
  const [output_format, set_output_format] = useState<OutputFormat>("png");
  const [downscale_mode, set_downscale_mode] = useState<DownscaleMode>(DEFAULT_DOWNSCALE_MODE);
  const [skip_blank, set_skip_blank] = useState(DEFAULT_SKIP_BLANK);

  // the running cut's controller; null when no cut runs
  const controller_ref = useRef<AbortController | null>(null);

  // leaving the page stops the cut
  useEffect(() => () => controller_ref.current?.abort(), []);

  const reset_state = useCallback(() => {
    set_progress({
      current_zoom_level: 0,
      progress: 0,
      total_tiles: 0,
      processed_tiles: 0,
      skipped_tiles: 0,
      zoom_levels_progress: [],
      current_stage: "preparing"
    });
    set_error(null);
  }, []);

  const generate_tiles_handler = useCallback(async (image: MapImage) => {
    controller_ref.current?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    controller_ref.current = controller;

    set_is_generating(true);
    set_error(null);

    try {
      const blob = await generate_tiles({
        image: image.element,
        plan: image.plan,
        output_format,
        downscale: downscale_mode,
        skip_blank,
        file_name: image.file_name,
        signal,
        // an aborted cut no longer writes to the panel
        on_progress: next => {
          if (!signal.aborted) set_progress(next);
        },
        on_error: message => {
          if (!signal.aborted) set_error(message);
        }
      });

      signal.throwIfAborted();
      await download_zip_file(blob, image.file_name);
    } catch (error) {
      if (!signal.aborted) {
        const error_message = error instanceof Error ? error.message : "Failed to generate tiles";
        set_error(error_message);
        console.error("Tile generation failed:", error);
      }
    } finally {
      // an aborted run's state was already reset by cancel_generation (and a newer run may own it now)
      if (controller_ref.current === controller) {
        controller_ref.current = null;
        set_is_generating(false);
        setTimeout(reset_state, 2000);
      }
    }
  }, [output_format, downscale_mode, skip_blank, reset_state]);

  const cancel_generation = useCallback(() => {
    controller_ref.current?.abort();
    controller_ref.current = null;
    set_is_generating(false);
    reset_state();
  }, [reset_state]);

  return {
    is_generating,
    error,
    progress,
    output_format,
    set_output_format,
    downscale_mode,
    set_downscale_mode,
    skip_blank,
    set_skip_blank,
    generate_tiles: generate_tiles_handler,
    cancel_generation,
    reset_error: () => set_error(null)
  };
}
