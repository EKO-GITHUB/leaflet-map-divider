import { ImageValidationResult } from "@/types/types";
import { ERROR_MESSAGES, MIN_TILE_SIZE } from "@/constants/constants";

export function validate_image_file(file: File): boolean {
  return file.type.startsWith("image");
}

export function get_file_type_error(file: File): string {
  const file_type = file.type || "unknown";
  return `File type: ${file_type} ${ERROR_MESSAGES.NOT_IMAGE}`;
}

export function validate_image_dimensions(img: HTMLImageElement): ImageValidationResult {
  const width = img.naturalWidth;
  const height = img.naturalHeight;

  if (height !== width) {
    return {
      is_valid: false,
      error: ERROR_MESSAGES.NOT_SQUARE
    };
  }

  if (height < MIN_TILE_SIZE || width < MIN_TILE_SIZE) {
    return {
      is_valid: false,
      error: ERROR_MESSAGES.TOO_SMALL
    };
  }


  if (height % 2 > 0 || width % 2 > 0) {
    return {
      is_valid: false,
      error: ERROR_MESSAGES.ODD_DIMENSIONS
    };
  }

  const max_zoom_level = calculate_max_zoom_level(width);

  return {
    is_valid: true,
    width,
    height,
    max_zoom_level
  };
}

export function calculate_max_zoom_level(width: number): number {
  let zoom_level = 0;
  let tmp_width = width;

  while (tmp_width % 2 === 0 && tmp_width >= MIN_TILE_SIZE * 2) {
    tmp_width = tmp_width / 2;
    zoom_level++;
  }

  return zoom_level;
}


export function create_image_from_file(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    let object_url: string | null = null;

    const cleanup = () => {
      if (object_url) {
        URL.revokeObjectURL(object_url);
        object_url = null;
      }
    };

    try {
      const img = new Image();
      object_url = URL.createObjectURL(file);

      img.onload = () => {
        resolve(img);
      };

      img.onerror = () => {
        cleanup();
        reject(new Error("Failed to load image. File may be corrupted or not a valid image."));
      };

      img.src = object_url;
    } catch (error) {
      cleanup();
      reject(new Error(`Failed to process image file: ${error}`));
    }
  });
}