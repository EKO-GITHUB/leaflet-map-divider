import { useCallback, useState } from "react";
import { MapImage, OutputFormat, TileGenerationProgress } from "@/types/types";
import { download_zip_file, generate_tiles } from "@/services/tile_generator";

export function useTileGeneration() {
  const [is_generating, set_is_generating] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const [progress, set_progress] = useState<TileGenerationProgress>({
    current_zoom_level: 0,
    progress: 0,
    total_tiles: 0,
    processed_tiles: 0,
    zoom_levels_progress: [],
    current_stage: "preparing"
  });
  const [output_format, set_output_format] = useState<OutputFormat>("png");

  const reset_state = useCallback(() => {
    set_progress({
      current_zoom_level: 0,
      progress: 0,
      total_tiles: 0,
      processed_tiles: 0,
      zoom_levels_progress: [],
      current_stage: "preparing"
    });
    set_error(null);
  }, []);

  const generate_tiles_handler = useCallback(async (image: MapImage) => {
    set_is_generating(true);
    set_error(null);

    try {
      const blob = await generate_tiles({
        image: image.element,
        max_zoom_level: image.max_zoom_level,
        output_format,
        file_name: image.file_name,
        on_progress: set_progress,
        on_error: set_error
      });

      await download_zip_file(blob, image.file_name);
    } catch (error) {
      const error_message = error instanceof Error ? error.message : "Failed to generate tiles";
      set_error(error_message);
      console.error("Tile generation failed:", error);
    } finally {
      set_is_generating(false);
      setTimeout(reset_state, 2000);
    }
  }, [output_format, reset_state]);

  const cancel_generation = useCallback(() => {
    set_is_generating(false);
    reset_state();
  }, [reset_state]);

  return {
    is_generating,
    error,
    progress,
    output_format,
    set_output_format,
    generate_tiles: generate_tiles_handler,
    cancel_generation,
    reset_error: () => set_error(null)
  };
}