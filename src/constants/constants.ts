export const MIN_TILE_SIZE = 128;

export const MIME_TYPES = {
  png: "image/png",
  webp: "image/webp"
} as const;

export const ERROR_MESSAGES = {
  NOT_IMAGE: "File type is not supported, select an image instead!",
  NOT_SQUARE: "The selected image is not a square!",
  TOO_SMALL: `The selected image is too small to process! Width and height must be at least ${MIN_TILE_SIZE}px`,
  ODD_DIMENSIONS: "The image has an odd width or height, it cannot be divided!",
  CANNOT_DIVIDE: "The selected image is too small to divide into tiles!"
} as const;