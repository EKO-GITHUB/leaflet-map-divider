"use client";

import React from "react";
import { useImageUpload } from "@/hooks/use_image_upload";
import { useTileGeneration } from "@/hooks/use_tile_generation";
import { ImageUploader } from "./image_uploader";
import { ImageInfo } from "./image_info";
import { ImagePreview } from "./image_preview";
import { TileGeneratorControls } from "./tile_generator_controls";

export function MapDivider() {
  const {
    selected_image,
    error: upload_error,
    is_loading: is_uploading,
    handle_image_upload,
    reset_image
  } = useImageUpload();

  const {
    is_generating,
    error: generation_error,
    progress,
    output_format,
    set_output_format,
    generate_tiles,
    cancel_generation,
    reset_error
  } = useTileGeneration();

  const handle_generate_tiles = () => {
    if (selected_image) {
      generate_tiles(selected_image);
    }
  };

  return (
    <div className="w-full space-y-8">
      <ImageUploader
        on_image_upload={handle_image_upload}
        on_reset={reset_image}
        file_name={selected_image?.file_name || null}
        error={upload_error}
        is_loading={is_uploading}
      />

      {selected_image && (
        <>
          <ImageInfo image={selected_image} />
          <ImagePreview image={selected_image} />
          <TileGeneratorControls
            output_format={output_format}
            on_output_format_change={set_output_format}
            on_generate_tiles={handle_generate_tiles}
            is_generating={is_generating}
            progress={progress}
            can_generate={selected_image.max_zoom_level > 0}
            error={generation_error}
            on_cancel={cancel_generation}
            on_clear_error={reset_error}
          />
        </>
      )}
    </div>
  );
}