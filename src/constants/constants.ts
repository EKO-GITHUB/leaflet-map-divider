export const MIN_TILE_SIZE = 128;

export const MIME_TYPES = {
  png: "image/png",
  webp: "image/webp"
} as const;

export const ERROR_MESSAGES = {
  NOT_IMAGE: "File type is not supported, select an image instead!",
  TOO_SMALL: `The selected image is too small to process! Width and height must be at least ${MIN_TILE_SIZE}px`,
  CANNOT_DIVIDE: "The selected image is too small to divide into tiles!"
} as const;