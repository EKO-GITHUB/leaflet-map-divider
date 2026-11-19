// Blank tiles: a tile whose pixels all have alpha 0 holds nothing to show, so the cutter can leave it out of the
// archive (a map viewer shows nothing where a tile is missing). Pure code (no canvas, no DOM), shared by the browser and
// the command-line cutter.

type Pixels = Uint8Array | Uint8ClampedArray;

// the "Blank tiles" option starts on Skip in the UI; generate_tiles itself writes every tile unless skip_blank is set
export const DEFAULT_SKIP_BLANK = true;

// true when every pixel of an RGBA buffer (4 bytes a pixel) has alpha 0; colour bytes are ignored, since a canvas
// hands back 0, 0, 0, 0 for a fully transparent pixel anyway. An empty buffer is blank.
export function is_blank(rgba: Pixels): boolean {
  if (rgba.length % 4 !== 0) {
    throw new RangeError(`is_blank: an RGBA buffer has a multiple of 4 bytes, got ${rgba.length}`);
  }
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return false;
  }
  return true;
}

// is_blank for the size x size square at (left, top) of an RGBA image width pixels wide, read in place (no copy)
export function is_blank_region(rgba: Pixels, width: number, left: number, top: number, size: number): boolean {
  if (![width, left, top, size].every(Number.isInteger) || width < 1 || left < 0 || top < 0 || size < 0) {
    throw new RangeError(`is_blank_region: bad region ${size}px at ${left},${top} of a ${width}px wide image`);
  }
  if (left + size > width || (top + size) * width * 4 > rgba.length) {
    throw new RangeError(`is_blank_region: the ${size}px region at ${left},${top} leaves the image`);
  }
  for (let y = top; y < top + size; y++) {
    const end = (y * width + left + size) * 4;
    for (let i = (y * width + left) * 4 + 3; i < end; i += 4) {
      if (rgba[i] !== 0) return false;
    }
  }
  return true;
}
