import { ERROR_MESSAGES } from "@/constants/constants";
import { plan_tiles, TilePlanResult } from "@/services/tile_plan";

export function validate_image_file(file: File): boolean {
  return file.type.startsWith("image");
}

export function get_file_type_error(file: File): string {
  const file_type = file.type || "unknown";
  return `File type: ${file_type} ${ERROR_MESSAGES.NOT_IMAGE}`;
}

export function validate_image_dimensions(img: HTMLImageElement): TilePlanResult {
  return plan_tiles(img.naturalWidth, img.naturalHeight);
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