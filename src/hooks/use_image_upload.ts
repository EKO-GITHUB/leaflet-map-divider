import { useCallback, useEffect, useState } from "react";
import { MapImage } from "@/types/types";
import {
  create_image_from_file,
  get_file_type_error,
  validate_image_dimensions,
  validate_image_file
} from "@/utils/image_validation";

export function useImageUpload() {
  const [selected_image, set_selected_image] = useState<MapImage | null>(null);
  const [error, set_error] = useState<string | null>(null);
  const [is_loading, set_is_loading] = useState(false);

  const cleanup_image = useCallback((image: MapImage | null) => {
    if (image?.src) {
      try {
        URL.revokeObjectURL(image.src);
      } catch (error) {
        console.warn("Failed to cleanup object URL:", error);
      }
    }
  }, []);

  const handle_image_upload = useCallback(async (files: FileList | null) => {
    const file = files?.[0];

    if (!file) {
      return;
    }

    set_is_loading(true);
    set_error(null);

    try {
      if (!validate_image_file(file)) {
        set_error(get_file_type_error(file));
        set_selected_image(null);
        return;
      }


      const img = await create_image_from_file(file);
      const validation = validate_image_dimensions(img);

      if (!validation.is_valid) {
        set_error(validation.error || "Invalid image");
        set_selected_image(null);
        URL.revokeObjectURL(img.src);
        return;
      }

      const new_image: MapImage = {
        element: img,
        width: validation.width!,
        height: validation.height!,
        file_name: file.name,
        src: img.src,
        max_zoom_level: validation.max_zoom_level!
      };

      set_selected_image(new_image);
      set_error(null);
    } catch (err) {
      const error_message = err instanceof Error ? err.message : "Failed to load image";
      set_error(error_message);
      set_selected_image(null);
    } finally {
      set_is_loading(false);
    }
  }, []);

  const reset_image = useCallback(() => {
    cleanup_image(selected_image);
    set_selected_image(null);
    set_error(null);
  }, [selected_image, cleanup_image]);

  useEffect(() => {
    return () => {
      cleanup_image(selected_image);
    };
  }, [selected_image, cleanup_image]);

  return {
    selected_image,
    error,
    is_loading,
    handle_image_upload,
    reset_image
  };
}