import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate_tiles, MAX_PENDING_ENCODES } from "@/services/tile_generator";
import { is_padded, plan_tiles, require_plan, TILE_SIZE_MODES, TilePlan, TileSizeMode } from "@/services/tile_plan";
import { OutputFormat, TileGenerationProgress } from "@/types/types";
import { DownscaleMode } from "@/services/downscale";
import { compare_rgba } from "./fixtures/compare";
import { AlphaMode, crop, noise_pixel, reference_pyramid } from "./fixtures/downscale_reference";
import { FIXTURE_PATTERNS, pattern_spec, PatternSpec, render_pattern, write_pattern_pixel } from "./fixtures/pattern";
import { decode_png, encode_png } from "./fixtures/png";

// The checker test: a fake canvas that really holds the pattern's pixels (nearest-neighbour, as the browser draws with
// imageSmoothingEnabled off) and encodes PNG with the fixtures' encoder, so every tile in the zip can be decoded and
// compared with the pattern region it must hold.

type Sampler = (x: number, y: number, out: Uint8Array | Uint8ClampedArray, offset: number) => void;

const TRANSPARENT: Sampler = (_x, _y, out, offset) => out.fill(0, offset, offset + 4);

// a source image: its size and its pixel at (x, y)
interface FakeImage {
  naturalWidth: number;
  naturalHeight: number;
  write: Sampler;
}

function pattern_image(spec: PatternSpec): FakeImage {
  return {
    naturalWidth: spec.width,
    naturalHeight: spec.height,
    write: (x, y, out, offset) => write_pattern_pixel(spec, x, y, out, offset)
  };
}

function noise_image(size: number, seed: number, alpha: AlphaMode): FakeImage {
  return {
    naturalWidth: size,
    naturalHeight: size,
    write: (x, y, out, offset) => noise_pixel(x, y, seed, alpha, out, offset)
  };
}

interface FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface FakeCanvas {
  width: number;
  height: number;
  sampler: Sampler;
  getContext: () => unknown;
  toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

interface EncodeLog {
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

function fake_canvas(log: EncodeLog): FakeCanvas {
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

function valid_plan(width: number, height: number): TilePlan {
  const result = plan_tiles(width, height);
  if (!result.is_valid) throw new Error(result.error);
  return result.plan;
}

// what the tile (x, y) of a zoom level must hold: the region itself at the top zoom, the top-left pixel of each source
// cell below it
function expected_tile(spec: PatternSpec, plan: TilePlan, zoom: number, x: number, y: number) {
  const t = plan.tile_size;
  const scale = plan.levels[zoom].scale;
  if (scale === 1) return render_pattern(spec, { left: x * t, top: y * t, width: t, height: t });
  const expected = new Uint8Array(t * t * 4);
  for (let py = 0; py < t; py++) {
    for (let px = 0; px < t; px++) {
      write_pattern_pixel(spec, (x * t + px) * scale, (y * t + py) * scale, expected, (py * t + px) * 4);
    }
  }
  return expected;
}

// the entries of a zip in file order, read from the local headers (JSZip writes the sizes there, no data descriptors)
function local_entries(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: { name: string; method: number; compressed: number; uncompressed: number; data: Uint8Array }[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const uncompressed = view.getUint32(offset + 22, true);
    const name_length = view.getUint16(offset + 26, true);
    const extra_length = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + name_length));
    const start = offset + 30 + name_length + extra_length;
    entries.push({ name, method, compressed, uncompressed, data: zip.subarray(start, start + compressed) });
    offset = start + compressed;
  }
  return entries;
}

let log: EncodeLog;

beforeEach(() => {
  log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
  vi.stubGlobal("document", { createElement: () => fake_canvas(log) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function cut(spec: PatternSpec, output_format: OutputFormat = "png", downscale?: DownscaleMode) {
  return cut_image(pattern_image(spec), `${spec.name}.png`, output_format, downscale);
}

async function cut_image(
  image: FakeImage,
  file_name: string,
  output_format: OutputFormat = "png",
  downscale?: DownscaleMode,
  signal?: AbortSignal
) {
  const plan = valid_plan(image.naturalWidth, image.naturalHeight);
  const on_error = vi.fn();
  const blob = await generate_tiles({
    image: image as unknown as HTMLImageElement,
    plan,
    output_format,
    downscale,
    file_name,
    on_error,
    signal
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { plan, bytes, on_error };
}

describe.each(FIXTURE_PATTERNS)("the tiles of $name", spec => {
  it("hold their pattern region, pixel for pixel", async () => {
    const { plan, bytes } = await cut(spec);
    const zip = await JSZip.loadAsync(bytes);
    let checked = 0;

    for (const level of plan.levels) {
      for (let y = 0; y < level.tiles_per_side; y++) {
        for (let x = 0; x < level.tiles_per_side; x++) {
          const file = zip.file(`${level.zoom}/${y}/${x}.png`);
          expect(file, `${level.zoom}/${y}/${x}.png`).not.toBeNull();
          const tile = decode_png(await file!.async("uint8array"));
          expect(tile.width).toBe(plan.tile_size);
          expect(tile.height).toBe(plan.tile_size);
          const result = compare_rgba(tile.data, expected_tile(spec, plan, level.zoom, x, y), plan.tile_size);
          expect(result.first_mismatch, `${level.zoom}/${y}/${x}.png`).toBeNull();
          checked++;
        }
      }
    }
    expect(checked).toBe(plan.total_tiles);
  });

  it("are stored uncompressed, byte for byte as encoded, in the order they were cut", async () => {
    const { plan, bytes } = await cut(spec);
    const tiles = local_entries(bytes).filter(entry => !entry.name.endsWith("/"));

    expect(tiles).toHaveLength(plan.total_tiles);
    expect(log.encodes).toHaveLength(plan.total_tiles);
    // the cut runs from the top zoom down, column by column
    const order = [...plan.levels].reverse().flatMap(level =>
      Array.from({ length: level.tile_count }, (_, i) => {
        const x = Math.floor(i / level.tiles_per_side);
        const y = i % level.tiles_per_side;
        return `${level.zoom}/${y}/${x}.png`;
      })
    );
    expect(tiles.map(entry => entry.name)).toEqual(order);
    tiles.forEach((entry, i) => {
      expect(entry.method).toBe(0);
      expect(entry.compressed).toBe(entry.uncompressed);
      expect(Buffer.from(entry.data).equals(Buffer.from(log.encodes[i].bytes))).toBe(true);
    });
  });
});

describe("tile encoding", () => {
  it("overlaps encodes, never more than MAX_PENDING_ENCODES at once", async () => {
    await cut(FIXTURE_PATTERNS[0]);
    expect(log.max_in_flight).toBeGreaterThan(1);
    expect(log.max_in_flight).toBeLessThanOrEqual(MAX_PENDING_ENCODES);
    expect(log.in_flight).toBe(0);
  });

  it("asks for lossless WebP (quality 1) and names the tiles .webp", async () => {
    const { plan, bytes } = await cut(FIXTURE_PATTERNS[0], "webp");
    const names = local_entries(bytes).map(entry => entry.name).filter(name => !name.endsWith("/"));

    expect(names).toHaveLength(plan.total_tiles);
    expect(names.every(name => /^\d+\/\d+\/\d+\.webp$/.test(name))).toBe(true);
    expect(log.encodes.every(encode => encode.type === "image/webp" && encode.quality === 1)).toBe(true);
  });

  it("rejects and reports the tile when an encode fails", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    // the 4th tile of the top zoom of the 1024 pattern (8 x 8 tiles of 128 px, column by column) is 0,3
    log.fail = index => index === 3;

    const result = cut(FIXTURE_PATTERNS[0]);
    await expect(result).rejects.toThrow("Failed to generate tile 0,3 at zoom 3");
    expect(zip_spy).not.toHaveBeenCalled();

    // tiles 0-2 went into the zip, 3 and the next MAX_PENDING_ENCODES - 1 were started; nothing after the failure
    expect(log.encodes.length).toBe(3 + MAX_PENDING_ENCODES);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log.encodes.length).toBe(3 + MAX_PENDING_ENCODES);
  });

  it("reports a failed encode through on_error", async () => {
    log.fail = index => index === 0;
    const plan = valid_plan(1024, 1024);
    const on_error = vi.fn();
    const spec = FIXTURE_PATTERNS[0];

    await expect(
      generate_tiles({
        image: pattern_image(spec) as unknown as HTMLImageElement,
        plan,
        output_format: "png",
        file_name: "pattern-1024.png",
        on_error
      })
    ).rejects.toThrow();
    expect(on_error).toHaveBeenCalledWith(expect.stringContaining("the canvas could not be encoded"));
  });
});

// every tile of a cut, decoded, by its zip path
async function decoded_tiles(bytes: Uint8Array, plan: TilePlan) {
  const zip = await JSZip.loadAsync(bytes);
  const tiles = new Map<string, Uint8Array>();
  for (const level of plan.levels) {
    for (let y = 0; y < level.tiles_per_side; y++) {
      for (let x = 0; x < level.tiles_per_side; x++) {
        const name = `${level.zoom}/${y}/${x}.png`;
        const file = zip.file(name);
        if (!file) throw new Error(`${name} is missing`);
        const tile = decode_png(await file.async("uint8array"));
        expect(tile.width).toBe(plan.tile_size);
        tiles.set(name, tile.data);
      }
    }
  }
  return tiles;
}

function render_image(image: FakeImage) {
  const size = image.naturalWidth;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) image.write(x, y, data, (y * size + x) * 4);
  }
  return data;
}

// every tile of a smooth cut against the reference pyramid; returns the number of tiles checked
async function expect_reference_pyramid(image: FakeImage, bytes: Uint8Array, plan: TilePlan) {
  const tiles = await decoded_tiles(bytes, plan);
  const pyramid = reference_pyramid(render_image(image), plan.padded_size, plan.max_zoom);
  let checked = 0;
  for (const level of plan.levels) {
    const reference = pyramid[plan.max_zoom - level.zoom];
    expect(reference.size).toBe(level.level_size);
    for (let y = 0; y < level.tiles_per_side; y++) {
      for (let x = 0; x < level.tiles_per_side; x++) {
        const name = `${level.zoom}/${y}/${x}.png`;
        const result = compare_rgba(tiles.get(name)!, crop(reference, x, y, plan.tile_size), plan.tile_size, {
          compare_transparent_rgb: true
        });
        expect(result.first_mismatch, name).toBeNull();
        checked++;
      }
    }
  }
  return checked;
}

describe("smooth downscale", () => {
  it.each(FIXTURE_PATTERNS)("builds every level of $name from the one above with the 2x2 average", async spec => {
    const { plan, bytes } = await cut(spec, "png", "smooth");
    expect(await expect_reference_pyramid(pattern_image(spec), bytes, plan)).toBe(plan.total_tiles);
  });

  it.each(["opaque", "sparse", "random"] as const)(
    "gives the reference z0 of a 3D-style noise source (alpha %s), within 0",
    async alpha => {
      const image = noise_image(1024, 11, alpha);
      const { plan, bytes } = await cut_image(image, "noise-1024.png", "png", "smooth");
      const z0 = (await decoded_tiles(bytes, plan)).get("0/0/0.png")!;
      const reference = reference_pyramid(render_image(image), 1024, plan.max_zoom)[plan.max_zoom];
      const result = compare_rgba(z0, crop(reference, 0, 0, plan.tile_size), plan.tile_size, {
        compare_transparent_rgb: true
      });
      expect(result.mismatched_pixels).toBe(0);
      expect(await expect_reference_pyramid(image, bytes, plan)).toBe(plan.total_tiles);
    }
  );

  it("averages noise to near its 8x8 mean at z0, where pixel mode keeps single samples", async () => {
    const image = noise_image(1024, 5, "opaque");
    const source = render_image(image);
    const mean_8x8 = (x: number, y: number, c: number) => {
      let sum = 0;
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) sum += source[((8 * y + dy) * 1024 + 8 * x + dx) * 4 + c];
      }
      return sum / 64;
    };
    const max_error = async (downscale: DownscaleMode) => {
      log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
      const { plan, bytes } = await cut_image(image, "noise-1024.png", "png", downscale);
      const z0 = (await decoded_tiles(bytes, plan)).get("0/0/0.png")!;
      let error = 0;
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          for (let c = 0; c < 3; c++) error = Math.max(error, Math.abs(z0[(y * 128 + x) * 4 + c] - mean_8x8(x, y, c)));
        }
      }
      return error;
    };
    // z0 is three 2x2 averages, each rounded half up, so it is within 0.5 + 0.5 + 0.5 of the exact 8x8 mean (this
    // source: 1.3125); a single noise sample is anywhere in 0-255
    expect(await max_error("smooth")).toBeLessThan(1.5);
    expect(await max_error("pixel")).toBeGreaterThan(100);
  });

  it("cuts the top zoom exactly as pixel mode does, in the same order", async () => {
    const spec = FIXTURE_PATTERNS[1];
    const pixel = await cut(spec, "png", "pixel");
    const pixel_tiles = local_entries(pixel.bytes);
    log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
    const smooth = await cut(spec, "png", "smooth");
    const smooth_tiles = local_entries(smooth.bytes);

    expect(smooth_tiles.map(entry => entry.name)).toEqual(pixel_tiles.map(entry => entry.name));
    const top = pixel.plan.levels[pixel.plan.max_zoom].tile_count;
    const same = (i: number) => Buffer.from(smooth_tiles[i].data).equals(Buffer.from(pixel_tiles[i].data));
    for (let i = 0; i < top; i++) expect(same(i), smooth_tiles[i].name).toBe(true);
    // below it, averages replace single samples
    const changed = smooth_tiles.slice(top).filter((_, k) => !same(top + k));
    expect(changed.length).toBeGreaterThan(0);
  });

  it("leaves pixel mode as it was when the option is left out", async () => {
    const spec = FIXTURE_PATTERNS[0];
    const by_default = local_entries((await cut(spec)).bytes);
    log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
    const pixel = local_entries((await cut(spec, "png", "pixel")).bytes);
    expect(pixel.map(entry => entry.name)).toEqual(by_default.map(entry => entry.name));
    pixel.forEach((entry, i) => expect(Buffer.from(entry.data).equals(Buffer.from(by_default[i].data))).toBe(true));
    // pixel mode never reads the canvas back
    expect(log.reads).toHaveLength(0);
  });

  it("reads the canvas once, the top level, in even bands", async () => {
    const image = noise_image(4096, 3, "opaque");
    const { plan, bytes } = await cut_image(image, "noise-4096.png", "png", "smooth");

    // 4096 px is 16M pixels, so it is read in bands of 1024 rows (4M pixels)
    expect(log.reads.map(read => read.y)).toEqual([0, 1024, 2048, 3072]);
    expect(log.reads.every(read => read.canvas_size === 4096 && read.rows === 1024)).toBe(true);

    // the band seams do not show: z0 (and every other level) is the reference pyramid
    const tiles = await decoded_tiles(bytes, plan);
    const reference = reference_pyramid(render_image(image), 4096, plan.max_zoom);
    for (const level of plan.levels.slice(0, 3)) {
      for (let y = 0; y < level.tiles_per_side; y++) {
        for (let x = 0; x < level.tiles_per_side; x++) {
          const name = `${level.zoom}/${y}/${x}.png`;
          const expected = crop(reference[plan.max_zoom - level.zoom], x, y, plan.tile_size);
          expect(compare_rgba(tiles.get(name)!, expected, plan.tile_size).first_mismatch, name).toBeNull();
        }
      }
    }
  }, 60_000);

  it("stops at an abort while a level is being downscaled: no tile below, no zip", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const controller = new AbortController();
    log.on_read = () => controller.abort();

    const result = cut_image(pattern_image(FIXTURE_PATTERNS[0]), "pattern-1024.png", "png", "smooth", controller.signal);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });

    // the 64 top-zoom tiles were cut, then the read of the top level aborted the cut
    expect(log.reads).toHaveLength(1);
    expect(log.encodes).toHaveLength(64);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log.encodes).toHaveLength(64);
    expect(zip_spy).not.toHaveBeenCalled();
  });
});

describe("skip blank tiles", () => {
  // the pattern's transparent bottom-right corner is a quarter of the side: 2x2 tiles at z3, 1 tile at z2, part of a
  // tile above. Paths are z/y/x
  const EXPECTED_SKIPPED = ["3/6/6", "3/7/6", "3/6/7", "3/7/7", "2/3/3"];

  async function cut_skipping(spec: PatternSpec, downscale: DownscaleMode, skip_blank: boolean) {
    const plan = valid_plan(spec.width, spec.height);
    const progress: TileGenerationProgress[] = [];
    const blob = await generate_tiles({
      image: pattern_image(spec) as unknown as HTMLImageElement,
      plan,
      output_format: "png",
      downscale,
      skip_blank,
      file_name: `${spec.name}.png`,
      on_progress: next => progress.push(structuredClone(next))
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const names = local_entries(bytes)
      .map(entry => entry.name)
      .filter(name => !name.endsWith("/"));
    return { plan, bytes, names, final: progress[progress.length - 1] };
  }

  describe.each(FIXTURE_PATTERNS)("on $name", spec => {
    it.each(["pixel", "smooth"] as const)("leaves out 4 tiles at z3, 1 at z2 and none above (%s)", async downscale => {
      const { plan, names, final } = await cut_skipping(spec, downscale, true);

      const all = [...plan.levels].reverse().flatMap(level =>
        Array.from({ length: level.tile_count }, (_, i) => {
          const x = Math.floor(i / level.tiles_per_side);
          const y = i % level.tiles_per_side;
          return `${level.zoom}/${y}/${x}`;
        })
      );
      // the written tiles keep the cut's order; exactly the corner's tiles are missing
      expect(names).toEqual(all.filter(name => !EXPECTED_SKIPPED.includes(name)).map(name => `${name}.png`));
      expect(log.encodes).toHaveLength(plan.total_tiles - 5);

      // the progress panel counts them: per zoom and in all, as processed tiles too
      expect(final.current_stage).toBe("complete");
      expect(final.processed_tiles).toBe(plan.total_tiles);
      expect(final.skipped_tiles).toBe(5);
      const skipped_by_zoom = Object.fromEntries(
        final.zoom_levels_progress.map(row => [row.zoom_level, row.skipped_tiles_in_level])
      );
      expect(skipped_by_zoom).toEqual({ 3: 4, 2: 1, 1: 0, 0: 0 });
      expect(final.zoom_levels_progress.every(row => row.processed_tiles_in_level === row.total_tiles_in_level)).toBe(
        true
      );
    });

    it("writes the same bytes for every tile it keeps", async () => {
      const kept = local_entries((await cut_skipping(spec, "smooth", false)).bytes);
      expect(kept.filter(entry => !entry.name.endsWith("/"))).toHaveLength(85);
      log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
      const skipping = local_entries((await cut_skipping(spec, "smooth", true)).bytes);
      const by_name = new Map(kept.map(entry => [entry.name, entry.data]));
      const tiles = skipping.filter(entry => !entry.name.endsWith("/"));
      expect(tiles).toHaveLength(80);
      for (const entry of tiles) {
        expect(Buffer.from(entry.data).equals(Buffer.from(by_name.get(entry.name)!)), entry.name).toBe(true);
      }
    });
  });

  it("writes every tile and counts none skipped when it is off or left out", async () => {
    const spec = FIXTURE_PATTERNS[0];
    const off = await cut_skipping(spec, "pixel", false);
    expect(off.names).toHaveLength(off.plan.total_tiles);
    expect(off.final.skipped_tiles).toBe(0);
    expect(off.final.zoom_levels_progress.every(row => row.skipped_tiles_in_level === 0)).toBe(true);

    log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
    const { plan, bytes } = await cut(spec);
    expect(local_entries(bytes).filter(entry => !entry.name.endsWith("/"))).toHaveLength(plan.total_tiles);
    // the tile canvas is never read back
    expect(log.reads).toHaveLength(0);
  });

  it("reads each drawn level once to find its blank tiles, never a tile on its own", async () => {
    const spec = FIXTURE_PATTERNS[0];
    await cut_skipping(spec, "pixel", true);
    // pixel mode draws every level from the image: one read of each whole level (1024 px levels fit in one band)
    expect(log.reads).toEqual([1024, 512, 256, 128].map(size => ({ canvas_size: size, y: 0, rows: size })));

    log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
    await cut_skipping(spec, "smooth", true);
    // smooth draws only the top level: read for its blank tiles, then for the downscale; the levels below are in memory
    expect(log.reads).toEqual([
      { canvas_size: 1024, y: 0, rows: 1024 },
      { canvas_size: 1024, y: 0, rows: 1024 }
    ]);
  });

  it("finds blank tiles across the bands of a large level", async () => {
    // opaque noise with a transparent stripe over the tile rows 7 and 8 of z5 (source rows 896-1151), across the
    // seam of the first two bands (1024 rows each: 8 rows of 128 px tiles)
    const noise = noise_image(4096, 9, "opaque");
    const image: FakeImage = {
      ...noise,
      write: (x, y, out, offset) => (y >= 896 && y < 1152 ? TRANSPARENT(x, y, out, offset) : noise.write(x, y, out, offset))
    };
    const plan = valid_plan(4096, 4096);
    const progress: TileGenerationProgress[] = [];
    const blob = await generate_tiles({
      image: image as unknown as HTMLImageElement,
      plan,
      output_format: "png",
      skip_blank: true,
      file_name: "stripe-4096.png",
      on_progress: next => progress.push(structuredClone(next))
    });
    const names = new Set(local_entries(new Uint8Array(await blob.arrayBuffer())).map(entry => entry.name));

    const top = log.reads.filter(read => read.canvas_size === 4096);
    expect(top.map(read => [read.y, read.rows])).toEqual([[0, 1024], [1024, 1024], [2048, 1024], [3072, 1024]]);
    const final = progress[progress.length - 1];
    // only z5 has whole tiles inside the stripe: 2 rows of 32
    expect(final.skipped_tiles).toBe(64);
    expect(final.zoom_levels_progress.find(row => row.zoom_level === 5)!.skipped_tiles_in_level).toBe(64);
    for (let x = 0; x < 32; x++) {
      for (const y of [6, 7, 8, 9]) expect(names.has(`5/${y}/${x}.png`), `5/${y}/${x}`).toBe(y === 6 || y === 9);
    }
    expect(names.size - [...names].filter(name => name.endsWith("/")).length).toBe(plan.total_tiles - 64);
  }, 60_000);

  it("keeps a tile that holds a single faint pixel", async () => {
    // a transparent 1024 px image with one pixel of alpha 1 inside the tile 5,2 of z3
    const image: FakeImage = {
      naturalWidth: 1024,
      naturalHeight: 1024,
      write: (x, y, out, offset) => {
        out.fill(0, offset, offset + 4);
        if (x === 5 * 128 + 77 && y === 2 * 128 + 3) out[offset + 3] = 1;
      }
    };
    const plan = valid_plan(1024, 1024);
    const blob = await generate_tiles({
      image: image as unknown as HTMLImageElement,
      plan,
      output_format: "png",
      skip_blank: true,
      file_name: "faint.png"
    });
    const names = local_entries(new Uint8Array(await blob.arrayBuffer()))
      .map(entry => entry.name)
      .filter(name => !name.endsWith("/"));
    // pixel mode samples the top left of each cell below z3, so the faint pixel is gone there
    expect(names).toEqual(["3/2/5.png"]);
  });

  it("cuts a fully transparent image to an archive without tiles, yielding to the browser on the way", async () => {
    const transparent: FakeImage = { naturalWidth: 1024, naturalHeight: 1024, write: TRANSPARENT };
    const channel_spy = vi.spyOn(globalThis, "MessageChannel");
    const plan = valid_plan(1024, 1024);
    const blob = await generate_tiles({
      image: transparent as unknown as HTMLImageElement,
      plan,
      output_format: "png",
      downscale: "smooth",
      skip_blank: true,
      file_name: "transparent.png"
    });
    const entries = local_entries(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.filter(entry => !entry.name.endsWith("/"))).toHaveLength(0);
    expect(log.encodes).toHaveLength(0);
    // a yield every 10 tiles (85 tiles: 8), plus one per downscale band (3 levels)
    expect(channel_spy.mock.calls.length).toBeGreaterThanOrEqual(8);
  });
});

describe("non-square images and tile size 256", () => {
  // 1200 x 800: the transparent corner (200 px) is at the image's own bottom right, inside the content
  const SPEC = pattern_spec(1200, 800);

  // the padded square as the generator sees it: the pattern at the top left, alpha 0 everywhere else
  function padded_sampler(spec: PatternSpec): Sampler {
    return (x, y, out, offset) =>
      x < spec.width && y < spec.height ? write_pattern_pixel(spec, x, y, out, offset) : TRANSPARENT(x, y, out, offset);
  }

  function render_padded(spec: PatternSpec, size: number) {
    const sample = padded_sampler(spec);
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) sample(x, y, data, (y * size + x) * 4);
    }
    return data;
  }

  // every tile of the plan as it must come out: pixel mode samples the top left of each source cell (the whole region
  // at the top zoom), smooth mode is the reference pyramid of the padded square
  function expected_tiles(spec: PatternSpec, plan: TilePlan, downscale: DownscaleMode) {
    const t = plan.tile_size;
    const tiles = new Map<string, Uint8Array>();
    const pyramid = downscale === "smooth" ? reference_pyramid(render_padded(spec, plan.padded_size), plan.padded_size, plan.max_zoom) : null;
    const sample = padded_sampler(spec);
    for (const level of plan.levels) {
      for (let y = 0; y < level.tiles_per_side; y++) {
        for (let x = 0; x < level.tiles_per_side; x++) {
          let tile: Uint8Array;
          if (pyramid) {
            tile = crop(pyramid[plan.max_zoom - level.zoom], x, y, t);
          } else {
            tile = new Uint8Array(t * t * 4);
            for (let py = 0; py < t; py++) {
              for (let px = 0; px < t; px++) {
                sample((x * t + px) * level.scale, (y * t + py) * level.scale, tile, (py * t + px) * 4);
              }
            }
          }
          tiles.set(`${level.zoom}/${y}/${x}`, tile);
        }
      }
    }
    return tiles;
  }

  const is_all_transparent = (rgba: Uint8Array) => rgba.every((value, i) => i % 4 !== 3 || value === 0);

  async function cut_padded(spec: PatternSpec, tile_size: TileSizeMode, downscale: DownscaleMode, skip_blank: boolean) {
    const plan = require_plan(spec.width, spec.height, { tile_size });
    const progress: TileGenerationProgress[] = [];
    const blob = await generate_tiles({
      image: pattern_image(spec) as unknown as HTMLImageElement,
      plan,
      output_format: "png",
      downscale,
      skip_blank,
      file_name: `${spec.name}.png`,
      on_progress: next => progress.push(structuredClone(next))
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const tiles = new Map<string, Uint8Array>();
    for (const file of Object.values(zip.files)) {
      if (file.dir) continue;
      const tile = decode_png(await file.async("uint8array"));
      expect(tile.width, file.name).toBe(plan.tile_size);
      expect(tile.height, file.name).toBe(plan.tile_size);
      tiles.set(file.name.replace(/\.png$/, ""), tile.data);
    }
    return { plan, tiles, final: progress[progress.length - 1] };
  }

  describe.each(["pixel", "smooth"] as const)("%s downscale", downscale => {
    it.each(TILE_SIZE_MODES)("cuts 1200x800 at tile size %s with the image at the top left of the pad", async tile_size => {
      const { plan, tiles } = await cut_padded(SPEC, tile_size, downscale, false);
      const expected = expected_tiles(SPEC, plan, downscale);

      // every tile is written when nothing is skipped, and holds its part of the padded square
      expect(tiles.size).toBe(plan.total_tiles);
      for (const [name, tile] of expected) {
        const result = compare_rgba(tiles.get(name)!, tile, plan.tile_size, { compare_transparent_rgb: downscale === "smooth" });
        expect(result.first_mismatch, name).toBeNull();
      }
      // tiles past the image's columns and rows are pad alone: fully transparent
      for (const level of plan.levels) {
        for (let y = 0; y < level.tiles_per_side; y++) {
          for (let x = 0; x < level.tiles_per_side; x++) {
            if (x < level.content_columns && y < level.content_rows) continue;
            expect(is_all_transparent(tiles.get(`${level.zoom}/${y}/${x}`)!), `${level.zoom}/${y}/${x}`).toBe(true);
          }
        }
      }
    });

    it.each(TILE_SIZE_MODES)("skips the blank pad tiles of 1200x800 at tile size %s", async tile_size => {
      const { plan, tiles, final } = await cut_padded(SPEC, tile_size, downscale, true);
      const expected = expected_tiles(SPEC, plan, downscale);
      const blank = [...expected].filter(([, tile]) => is_all_transparent(tile)).map(([name]) => name);

      expect([...tiles.keys()].sort()).toEqual([...expected.keys()].filter(name => !blank.includes(name)).sort());
      for (const [name, tile] of tiles) {
        const result = compare_rgba(tile, expected.get(name)!, plan.tile_size, { compare_transparent_rgb: downscale === "smooth" });
        expect(result.first_mismatch, name).toBeNull();
      }
      expect(final.skipped_tiles).toBe(blank.length);
      expect(final.processed_tiles).toBe(plan.total_tiles);
      expect(log.encodes).toHaveLength(plan.total_tiles - blank.length);
    });
  });

  it("leaves out exactly the pad tiles and the corner tile at tile size 256", async () => {
    // 2048 px square, 256 px tiles. z3: the image spans 5 x 4 tiles, and the tile 4,3 (x 1024-1279, y 768-1023) holds
    // only the transparent corner (x >= 1000, y >= 600) and pad, so 19 of 64 are written; z2: 3 x 2; z1: 2 x 1; z0: 1
    const { plan, tiles, final } = await cut_padded(SPEC, "256", "pixel", true);
    expect(plan.padded_size).toBe(2048);
    const by_zoom = (zoom: number) => [...tiles.keys()].filter(name => name.startsWith(`${zoom}/`)).length;
    expect([0, 1, 2, 3].map(by_zoom)).toEqual([1, 2, 6, 19]);
    expect(tiles.has("3/3/4")).toBe(false);
    expect(tiles.has("3/3/3")).toBe(true);
    expect(tiles.has("3/2/4")).toBe(true);
    const skipped_by_zoom = Object.fromEntries(
      final.zoom_levels_progress.map(row => [row.zoom_level, row.skipped_tiles_in_level])
    );
    expect(skipped_by_zoom).toEqual({ 3: 45, 2: 10, 1: 2, 0: 0 });
    expect(final.skipped_tiles).toBe(57);
  });

  it("cuts an even square at tile size auto exactly as before", async () => {
    // the 1024 fixture is not padded: the same plan, so the same tiles as every earlier cut
    const spec = FIXTURE_PATTERNS[0];
    const plan = require_plan(spec.width, spec.height, { tile_size: "auto" });
    expect(plan).toEqual(valid_plan(spec.width, spec.height));
    expect(is_padded(plan)).toBe(false);
  });

  it("cuts the 1024 fixture into 256 px tiles at tile size 256 (z0-z2, no pad)", async () => {
    const spec = FIXTURE_PATTERNS[0];
    const { plan, tiles } = await cut_padded(spec, "256", "pixel", false);
    expect(plan).toMatchObject({ padded_size: 1024, tile_size: 256, max_zoom: 2, total_tiles: 21 });
    expect(tiles.size).toBe(21);
    for (const [name, tile] of expected_tiles(spec, plan, "pixel")) {
      expect(compare_rgba(tiles.get(name)!, tile, 256).first_mismatch, name).toBeNull();
    }
  });

  it("pads an odd-sized image (1001x700 at 256 and auto)", async () => {
    const spec = pattern_spec(1001, 700);
    for (const tile_size of TILE_SIZE_MODES) {
      log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
      const { plan, tiles } = await cut_padded(spec, tile_size, "pixel", false);
      expect(plan.padded_size).toBe(tile_size === "256" ? 1024 : 1002);
      for (const [name, tile] of expected_tiles(spec, plan, "pixel")) {
        expect(compare_rgba(tiles.get(name)!, tile, plan.tile_size).first_mismatch, `${tile_size} ${name}`).toBeNull();
      }
    }
  });
});
