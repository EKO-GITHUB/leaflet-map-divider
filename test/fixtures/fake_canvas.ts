// A fake canvas for the browser cutter's tests (vi.stubGlobal("document", { createElement: () => fake_canvas(log) })):
// it really holds pixels (a nearest-neighbour model of drawImage with smoothing off, from a source image's own pixel
// function), copies regions, reads and puts ImageData exactly (a browser canvas stores premultiplied colour) and
// encodes PNG with the fixtures' encoder, so every tile the generator writes can be decoded and checked.
import { AlphaMode, noise_pixel } from "./downscale_reference";
import { PatternSpec, write_pattern_pixel } from "./pattern";
import { encode_png } from "./png";

export type Sampler = (x: number, y: number, out: Uint8Array | Uint8ClampedArray, offset: number) => void;

export const TRANSPARENT: Sampler = (_x, _y, out, offset) => out.fill(0, offset, offset + 4);

// a source image: its size and its pixel at (x, y)
export interface FakeImage {
  naturalWidth: number;
  naturalHeight: number;
  write: Sampler;
}

export function pattern_image(spec: PatternSpec): FakeImage {
  return {
    naturalWidth: spec.width,
    naturalHeight: spec.height,
    write: (x, y, out, offset) => write_pattern_pixel(spec, x, y, out, offset)
  };
}

export function noise_image(size: number, seed: number, alpha: AlphaMode): FakeImage {
  return {
    naturalWidth: size,
    naturalHeight: size,
    write: (x, y, out, offset) => noise_pixel(x, y, seed, alpha, out, offset)
  };
}

export interface FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FakeCanvas {
  width: number;
  height: number;
  sampler: Sampler;
  getContext: () => unknown;
  toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

export interface EncodeLog {
  // every encode in call order: its bytes, mime type and quality
  encodes: { bytes: Uint8Array; type?: string; quality?: number }[];
  in_flight: number;
  max_in_flight: number;
  // returns true to make that encode fail (toBlob hands back null)
  fail?: (index: number) => boolean;
  // every getImageData call: the canvas size and the band read
  reads: { canvas_size: number; y: number; rows: number }[];
  // called on each getImageData, so a test can abort while a level is being downscaled
  on_read?: (count: number) => void;
}

export function fake_canvas(log: EncodeLog): FakeCanvas {
  let width = 0;
  let height = 0;
  const canvas: FakeCanvas = {
    // a size change clears the canvas, as in the browser
    get width() {
      return width;
    },
    set width(value: number) {
      width = value;
      canvas.sampler = TRANSPARENT;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      height = value;
      canvas.sampler = TRANSPARENT;
    },
    sampler: TRANSPARENT,
    getContext: () => ctx,
    toBlob: (callback, type, quality) => {
      const index = log.encodes.length;
      // toBlob copies the bitmap when it is called: render now, deliver later
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) canvas.sampler(x, y, rgba, (y * width + x) * 4);
      }
      const bytes = new Uint8Array(encode_png(width, height, rgba));
      log.encodes.push({ bytes, type, quality });
      log.in_flight++;
      log.max_in_flight = Math.max(log.max_in_flight, log.in_flight);
      const failed = log.fail?.(index) ?? false;
      // uneven delays, so the encodes finish out of order
      setTimeout(() => {
        log.in_flight--;
        callback(failed ? null : new Blob([bytes], { type }));
      }, (index * 7) % 5);
    }
  };

  const ctx = {
    imageSmoothingEnabled: true,
    clearRect: () => {
      canvas.sampler = TRANSPARENT;
    },
    // getImageData(x, y, w, h): the pixels as the canvas holds them (this fake stores them exactly, a browser canvas
    // stores premultiplied colour)
    getImageData: (sx: number, sy: number, w: number, h: number): FakeImageData => {
      log.reads.push({ canvas_size: width, y: sy, rows: h });
      log.on_read?.(log.reads.length);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) canvas.sampler(sx + x, sy + y, data, (y * w + x) * 4);
      }
      return { width: w, height: h, data };
    },
    createImageData: (w: number, h: number): FakeImageData => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4)
    }),
    // putImageData(data, 0, 0): replaces the pixels with a copy (later changes to the ImageData do not show)
    putImageData: (image_data: FakeImageData, dx: number, dy: number) => {
      if (dx !== 0 || dy !== 0) throw new Error("the fake only puts image data at 0, 0");
      const copy = image_data.data.slice();
      const w = image_data.width;
      const h = image_data.height;
      canvas.sampler = (x, y, out, offset) => {
        if (x >= w || y >= h) return TRANSPARENT(x, y, out, offset);
        const i = (y * w + x) * 4;
        out[offset] = copy[i];
        out[offset + 1] = copy[i + 1];
        out[offset + 2] = copy[i + 2];
        out[offset + 3] = copy[i + 3];
      };
    },
    drawImage: (source: FakeImage | FakeCanvas, ...args: number[]) => {
      if ("write" in source) {
        // drawImage(image, dx, dy, dw, dh) or drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh), always from 0,0
        const [dw, dh] = args.length === 4 ? [args[2], args[3]] : [args[6], args[7]];
        const scale_x = source.naturalWidth / dw;
        const scale_y = source.naturalHeight / dh;
        const write = source.write;
        canvas.sampler = (x, y, out, offset) => {
          if (x >= dw || y >= dh) return TRANSPARENT(x, y, out, offset);
          write(Math.floor(x * scale_x), Math.floor(y * scale_y), out, offset);
        };
      } else {
        // drawImage(canvas, sx, sy, w, h, 0, 0, w, h): a 1:1 copy of a region
        const [sx, sy] = args;
        const from = source.sampler;
        canvas.sampler = (x, y, out, offset) => from(sx + x, sy + y, out, offset);
      }
    }
  };
  return canvas;
}
