import { createHash } from "node:crypto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate_tiles, MAX_PENDING_ENCODES } from "@/services/tile_generator";
import { is_padded, plan_tiles, require_plan, TILE_SIZE_MODES, TilePlan, TileSizeMode } from "@/services/tile_plan";
import { OutputFormat, TileGenerationProgress } from "@/types/types";
import { DownscaleMode } from "@/services/downscale";
import { plan_preview, PREVIEW_FILE, PREVIEW_MAX_SIZE } from "@/services/preview";
import { MANIFEST_FILE, TilesManifest } from "@/services/tiles_manifest";
import { compare_rgba } from "./fixtures/compare";
import { crop, reference_downscale, reference_pyramid } from "./fixtures/downscale_reference";
import { EncodeLog, fake_canvas, FakeImage, noise_image, pattern_image, Sampler, TRANSPARENT } from "./fixtures/fake_canvas";
import { FIXTURE_PATTERNS, pattern_spec, PatternSpec, render_pattern, write_pattern_pixel } from "./fixtures/pattern";
import { decode_png } from "./fixtures/png";

// The checker test: a fake canvas (fixtures/fake_canvas.ts) that really holds the pattern's pixels and encodes PNG with
// the fixtures' encoder, so every tile in the zip can be decoded and compared with the pattern region it must hold.

// every cut hashes its source file for tiles.json; the fake source's bytes do not matter to the tiles
const SOURCE_FILE = new Blob(["fake source image"]);
// preview.webp is encoded once, after the last tile
const PREVIEW_ENCODES = 1;
const TILE_NAME = /^\d+\/\d+\/\d+\.(png|webp)$/;


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

// the tile entries of a zip (no folders, no preview.webp or tiles.json), in file order
function tile_entries(zip: Uint8Array) {
  return local_entries(zip).filter(entry => TILE_NAME.test(entry.name));
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
    source_file: SOURCE_FILE,
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
    const tiles = tile_entries(bytes).filter(entry => !entry.name.endsWith("/"));

    expect(tiles).toHaveLength(plan.total_tiles);
    expect(log.encodes).toHaveLength(plan.total_tiles + PREVIEW_ENCODES);
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
    const names = tile_entries(bytes).map(entry => entry.name).filter(name => !name.endsWith("/"));

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
        source_file: SOURCE_FILE,
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
    const pixel_tiles = tile_entries(pixel.bytes);
    log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
    const smooth = await cut(spec, "png", "smooth");
    const smooth_tiles = tile_entries(smooth.bytes);

    expect(smooth_tiles.map(entry => entry.name)).toEqual(pixel_tiles.map(entry => entry.name));
    const top = pixel.plan.levels[pixel.plan.max_zoom].tile_count;
    const same = (i: number) => Buffer.from(smooth_tiles[i].data).equals(Buffer.from(pixel_tiles[i].data));
    for (let i = 0; i < top; i++) expect(same(i), smooth_tiles[i].name).toBe(true);
    // below it, averages replace single samples
    const changed = smooth_tiles.slice(top).filter((_, k) => !same(top + k));
    expect(changed.length).toBeGreaterThan(0);
  });

  it("uses pixel mode when the option is left out", async () => {
    const spec = FIXTURE_PATTERNS[0];
    const by_default = tile_entries((await cut(spec)).bytes);
    log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
    const pixel = tile_entries((await cut(spec, "png", "pixel")).bytes);
    expect(pixel.map(entry => entry.name)).toEqual(by_default.map(entry => entry.name));
    pixel.forEach((entry, i) => expect(Buffer.from(entry.data).equals(Buffer.from(by_default[i].data))).toBe(true));
    // pixel mode, like smooth, reads the top level back once and halves it in memory (pick_2x, not canvas draws)
    expect(log.reads).toEqual([{ canvas_size: 1024, y: 0, rows: 1024 }]);
  });

  it("reads the canvas once in pixel mode too, and picks the top-left pixel of each cell", async () => {
    const image = noise_image(4096, 4, "random");
    const { plan, bytes } = await cut_image(image, "noise-4096.png", "png", "pixel");

    expect(log.reads.map(read => [read.canvas_size, read.y, read.rows])).toEqual([
      [4096, 0, 1024],
      [4096, 1024, 1024],
      [4096, 2048, 1024],
      [4096, 3072, 1024]
    ]);
    // every pixel of z0-z2 is the source pixel at the top left of its cell (no seams between the bands)
    const tiles = await decoded_tiles(bytes, plan);
    const source = render_image(image);
    const t = plan.tile_size;
    for (const level of plan.levels.slice(0, 3)) {
      for (let y = 0; y < level.tiles_per_side; y++) {
        for (let x = 0; x < level.tiles_per_side; x++) {
          const expected = new Uint8Array(t * t * 4);
          for (let py = 0; py < t; py++) {
            for (let px = 0; px < t; px++) {
              const from = (((y * t + py) * level.scale) * 4096 + (x * t + px) * level.scale) * 4;
              expected.set(source.subarray(from, from + 4), (py * t + px) * 4);
            }
          }
          const name = `${level.zoom}/${y}/${x}.png`;
          expect(compare_rgba(tiles.get(name)!, expected, t).first_mismatch, name).toBeNull();
        }
      }
    }
  }, 60_000);

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
      source_file: SOURCE_FILE,
      on_progress: next => progress.push(structuredClone(next))
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const names = tile_entries(bytes)
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
      expect(log.encodes).toHaveLength(plan.total_tiles - 5 + PREVIEW_ENCODES);

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
      const kept = tile_entries((await cut_skipping(spec, "smooth", false)).bytes);
      expect(kept.filter(entry => !entry.name.endsWith("/"))).toHaveLength(85);
      log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
      const skipping = tile_entries((await cut_skipping(spec, "smooth", true)).bytes);
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
    expect(tile_entries(bytes).filter(entry => !entry.name.endsWith("/"))).toHaveLength(plan.total_tiles);
    // the tile canvas is never read back; the level canvas once, to halve it, not to find blank tiles
    expect(log.reads).toEqual([{ canvas_size: 1024, y: 0, rows: 1024 }]);
  });

  it.each(["pixel", "smooth"] as const)(
    "reads the drawn level once to find its blank tiles, never a tile on its own (%s)",
    async downscale => {
      await cut_skipping(FIXTURE_PATTERNS[0], downscale, true);
      // only the top level is drawn: read for its blank tiles, then to halve it; the levels below are in memory
      expect(log.reads).toEqual([
        { canvas_size: 1024, y: 0, rows: 1024 },
        { canvas_size: 1024, y: 0, rows: 1024 }
      ]);
    }
  );

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
      source_file: SOURCE_FILE,
      on_progress: next => progress.push(structuredClone(next))
    });
    const names = new Set(tile_entries(new Uint8Array(await blob.arrayBuffer())).map(entry => entry.name));

    // the read for the blank tiles, then the read to halve the level
    const top = log.reads.filter(read => read.canvas_size === 4096);
    const bands = [[0, 1024], [1024, 1024], [2048, 1024], [3072, 1024]];
    expect(top.map(read => [read.y, read.rows])).toEqual([...bands, ...bands]);
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
      file_name: "faint.png",
      source_file: SOURCE_FILE,
    });
    const names = tile_entries(new Uint8Array(await blob.arrayBuffer()))
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
      file_name: "transparent.png",
      source_file: SOURCE_FILE,
    });
    const entries = tile_entries(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.filter(entry => !entry.name.endsWith("/"))).toHaveLength(0);
    expect(log.encodes).toHaveLength(PREVIEW_ENCODES);
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
      source_file: SOURCE_FILE,
      on_progress: next => progress.push(structuredClone(next))
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const tiles = new Map<string, Uint8Array>();
    for (const file of Object.values(zip.files)) {
      if (file.dir || !TILE_NAME.test(file.name)) continue;
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
      expect(log.encodes).toHaveLength(plan.total_tiles - blank.length + PREVIEW_ENCODES);
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

describe("tiles.json and preview.webp in the archive", () => {
  const SOURCE_SHA256 = createHash("sha256").update("fake source image").digest("hex");

  interface ArchiveOptions {
    tile_size?: TileSizeMode;
    downscale?: DownscaleMode;
    skip_blank?: boolean;
    output_format?: OutputFormat;
  }

  async function cut_archive(spec: PatternSpec, options: ArchiveOptions = {}) {
    const { tile_size = "auto", downscale = "pixel", skip_blank = false, output_format = "png" } = options;
    const plan = require_plan(spec.width, spec.height, { tile_size });
    const before = Date.now();
    const blob = await generate_tiles({
      image: pattern_image(spec) as unknown as HTMLImageElement,
      plan,
      output_format,
      downscale,
      skip_blank,
      file_name: `${spec.name}.png`,
      source_file: SOURCE_FILE
    });
    const after = Date.now();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    const manifest_file = zip.file(MANIFEST_FILE);
    const preview_file = zip.file(PREVIEW_FILE);
    if (!manifest_file || !preview_file) throw new Error("the archive has no tiles.json or preview.webp");
    const manifest_text = await manifest_file.async("string");
    const manifest = JSON.parse(manifest_text) as TilesManifest;
    // the fake canvas encodes PNG whatever type it is asked for
    const preview = decode_png(await preview_file.async("uint8array"));
    const tile_names = Object.keys(zip.files).filter(name => TILE_NAME.test(name));
    return { plan, bytes, zip, manifest, manifest_text, preview, tile_names, before, after };
  }

  // the top-left width x height of a level, stitched from the archive's tiles (a tile that is not there is blank)
  async function stitched_content(zip: JSZip, plan: TilePlan, zoom: number, width: number, height: number) {
    const t = plan.tile_size;
    const out = new Uint8Array(width * height * 4);
    for (let ty = 0; ty * t < height; ty++) {
      for (let tx = 0; tx * t < width; tx++) {
        const file = zip.file(`${zoom}/${ty}/${tx}.png`);
        if (!file) continue;
        const tile = decode_png(await file.async("uint8array"));
        const columns = Math.min(t, width - tx * t);
        for (let row = 0; row < t && ty * t + row < height; row++) {
          const from = row * t * 4;
          out.set(tile.data.subarray(from, from + columns * 4), ((ty * t + row) * width + tx * t) * 4);
        }
      }
    }
    return out;
  }

  // the padded square of a pattern: the pattern at the top left, alpha 0 elsewhere
  function render_padded_square(spec: PatternSpec, size: number) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < spec.height; y++) {
      for (let x = 0; x < spec.width; x++) write_pattern_pixel(spec, x, y, data, (y * size + x) * 4);
    }
    return data;
  }

  // the top-left width x height of a square image, with a transparent column / row added to make an odd side even
  function crop_even(source: { data: Uint8Array | Uint8ClampedArray; size: number }, width: number, height: number) {
    const even_width = width + (width % 2);
    const even_height = height + (height % 2);
    const out = new Uint8Array(even_width * even_height * 4);
    for (let y = 0; y < height; y++) {
      out.set(source.data.subarray(y * source.size * 4, (y * source.size + width) * 4), y * even_width * 4);
    }
    return { data: out, width: even_width, height: even_height };
  }

  // the preview as the spec defines it, computed without the generator: pixel mode samples the source at the top left
  // of each scale x scale cell; smooth mode is the reference pyramid of the padded square, and a further halving of z0
  // pads its odd side with a transparent column or row first
  function expected_preview(spec: PatternSpec, plan: TilePlan, downscale: DownscaleMode) {
    const { scale, width, height, zoom, extra_halvings } = plan_preview(plan);
    if (downscale === "pixel") {
      const out = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) write_pattern_pixel(spec, x * scale, y * scale, out, (y * width + x) * 4);
      }
      return out;
    }
    const pyramid = reference_pyramid(render_padded_square(spec, plan.padded_size), plan.padded_size, plan.max_zoom - zoom);
    const level = pyramid[pyramid.length - 1];
    if (extra_halvings === 0) return crop_exact(level, width, height);
    if (extra_halvings !== 1) throw new Error("only one extra halving is checked here");
    const level_scale = plan.levels[zoom].scale;
    const content = crop_even(level, Math.ceil(spec.width / level_scale), Math.ceil(spec.height / level_scale));
    return reference_downscale(content.data, content.width, content.height);
  }

  function crop_exact(source: { data: Uint8Array | Uint8ClampedArray; size: number }, width: number, height: number) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      out.set(source.data.subarray(y * source.size * 4, (y * source.size + width) * 4), y * width * 4);
    }
    return out;
  }

  const CASES: { spec: PatternSpec; options: ArchiveOptions }[] = [
    { spec: FIXTURE_PATTERNS[0], options: {} },
    { spec: FIXTURE_PATTERNS[0], options: { skip_blank: true, downscale: "smooth" } },
    { spec: FIXTURE_PATTERNS[1], options: { skip_blank: true } },
    { spec: FIXTURE_PATTERNS[1], options: { downscale: "smooth" } },
    { spec: pattern_spec(1200, 800), options: { tile_size: "256", skip_blank: true } },
    { spec: pattern_spec(1200, 800), options: { tile_size: "256", downscale: "smooth" } },
    { spec: pattern_spec(1001, 700), options: { skip_blank: true, downscale: "smooth" } }
  ];

  describe.each(CASES.map(({ spec, options }) => ({ spec, options, label: `${spec.name} ${JSON.stringify(options)}` })))(
    "$label",
    ({ spec, options }) => {
      it("writes a manifest that describes the cut and counts exactly the tiles in the zip", async () => {
        const { plan, manifest, manifest_text, tile_names, before, after } = await cut_archive(spec, options);
        const { downscale = "pixel", skip_blank = false } = options;

        expect(manifest).toEqual({
          format_version: 1,
          generator: "leafletmapdivider",
          created_at: expect.any(String),
          source: { name: `${spec.name}.png`, width: spec.width, height: spec.height, sha256: SOURCE_SHA256 },
          padded_size: plan.padded_size,
          tile_size_mode: plan.tile_size_mode,
          tile_size: plan.tile_size,
          min_zoom: 0,
          max_zoom: plan.max_zoom,
          format: "png",
          layout: "z/y/x",
          y_origin: "top",
          path_template: "{z}/{y}/{x}.png",
          downscale,
          skip_blank,
          tiles: { total: plan.total_tiles, written: expect.any(Number), skipped: expect.any(Number) },
          levels: plan.levels.map(level => ({
            zoom: level.zoom,
            tiles_per_side: level.tiles_per_side,
            source_tile_size: level.source_tile_size,
            content_columns: level.content_columns,
            content_rows: level.content_rows,
            written: expect.any(Number),
            skipped: expect.any(Number)
          })),
          preview: { path: "preview.webp", ...plan_preview(plan) }
        });
        expect(manifest_text.endsWith("}\n")).toBe(true);
        const created = Date.parse(manifest.created_at);
        expect(created).toBeGreaterThanOrEqual(before);
        expect(created).toBeLessThanOrEqual(after);

        // the counts are the zip's tile entries, in all and per zoom
        expect(manifest.tiles.written).toBe(tile_names.length);
        expect(manifest.tiles.written + manifest.tiles.skipped).toBe(plan.total_tiles);
        for (const level of manifest.levels) {
          const in_zip = tile_names.filter(name => name.startsWith(`${level.zoom}/`)).length;
          expect(level.written, `zoom ${level.zoom}`).toBe(in_zip);
          expect(level.written + level.skipped).toBe(level.tiles_per_side ** 2);
        }
        expect(manifest.levels.reduce((sum, level) => sum + level.skipped, 0)).toBe(manifest.tiles.skipped);
        if (!skip_blank) expect(manifest.tiles.skipped).toBe(0);
        // every tile is where the template says, inside its level's grid
        for (const name of tile_names) {
          const [z, y, x] = name.replace(/\.png$/, "").split("/").map(Number);
          expect(manifest.path_template.replace("{z}", `${z}`).replace("{y}", `${y}`).replace("{x}", `${x}`)).toBe(name);
          expect(Math.max(x, y)).toBeLessThan(manifest.levels[z].tiles_per_side);
        }
      });

      it("writes a preview of the content area that lines up with its level's tiles", async () => {
        const { plan, zip, manifest, preview } = await cut_archive(spec, options);
        const { downscale = "pixel" } = options;
        const { zoom, scale, width, height } = manifest.preview;

        // the content area only (no pad), at most 1024 px on its longest side, at a power-of-two scale
        expect(Math.max(width, height)).toBeLessThanOrEqual(PREVIEW_MAX_SIZE);
        expect([preview.width, preview.height]).toEqual([width, height]);
        expect([width, height]).toEqual([Math.ceil(spec.width / scale), Math.ceil(spec.height / scale)]);
        expect(scale).toBe(plan.levels[zoom].scale);

        // the same pixels as the tiles of its level
        const stitched = await stitched_content(zip, plan, zoom, width, height);
        expect(compare_rgba(preview.data, stitched, width, { compare_transparent_rgb: true }).first_mismatch).toBeNull();
        // and what the spec says they are
        const expected = expected_preview(spec, plan, downscale);
        expect(
          compare_rgba(preview.data, expected, width, { compare_transparent_rgb: downscale === "smooth" }).first_mismatch
        ).toBeNull();

        // encoded last, as lossless WebP
        expect(log.encodes[log.encodes.length - 1]).toMatchObject({ type: "image/webp", quality: 1 });
      });
    }
  );

  it("puts preview.webp and tiles.json at the root, stored, after the tiles", async () => {
    const { bytes, tile_names } = await cut_archive(FIXTURE_PATTERNS[0], { output_format: "webp" });
    const files = local_entries(bytes).filter(entry => !entry.name.endsWith("/"));
    expect(files.map(entry => entry.name).slice(-2)).toEqual(["preview.webp", "tiles.json"]);
    expect(files.slice(0, -2).every(entry => TILE_NAME.test(entry.name))).toBe(true);
    expect(files).toHaveLength(tile_names.length + 2);
    expect(files.every(entry => entry.method === 0)).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(files[files.length - 1].data)) as TilesManifest;
    expect(manifest).toMatchObject({ format: "webp", path_template: "{z}/{y}/{x}.webp" });
    expect(tile_names.every(name => name.endsWith(".webp"))).toBe(true);
  });

  it("counts the pad tiles skipped at tile size 256 per zoom", async () => {
    const { manifest } = await cut_archive(pattern_spec(1200, 800), { tile_size: "256", skip_blank: true });
    expect(manifest.levels.map(level => [level.written, level.skipped])).toEqual([[1, 0], [2, 2], [6, 10], [19, 45]]);
    expect(manifest.tiles).toEqual({ total: 85, written: 28, skipped: 57 });
    expect(manifest).toMatchObject({ padded_size: 2048, tile_size: 256, max_zoom: 3 });
    expect(manifest.preview).toEqual({ path: "preview.webp", zoom: 2, extra_halvings: 0, scale: 2, width: 600, height: 400 });
  });

  it.each(["pixel", "smooth"] as const)(
    "halves z0 further when even its content is larger than 1024 px (%s)",
    async downscale => {
      // 2062 px under auto: 2 x 1031, so z1 with 1031 px tiles; z0's content is 1031 x 150, the preview 516 x 75
      const spec = pattern_spec(2062, 300);
      const { plan, zip, manifest, preview } = await cut_archive(spec, { downscale, skip_blank: true });
      expect(plan).toMatchObject({ padded_size: 2062, tile_size: 1031, max_zoom: 1 });
      expect(manifest.preview).toEqual({ path: "preview.webp", zoom: 0, extra_halvings: 1, scale: 4, width: 516, height: 75 });
      expect([preview.width, preview.height]).toEqual([516, 75]);
      const expected = expected_preview(spec, plan, downscale);
      expect(
        compare_rgba(preview.data, expected, 516, { compare_transparent_rgb: downscale === "smooth" }).first_mismatch
      ).toBeNull();
      expect(zip.file("0/0/0.png")).not.toBeNull();
      expect(manifest.tiles.written).toBe(Object.keys(zip.files).filter(name => TILE_NAME.test(name)).length);
    },
    60_000
  );

  it("hashes the source file's bytes", async () => {
    const source_bytes = new Uint8Array([0, 1, 2, 3, 255]);
    const blob = await generate_tiles({
      image: pattern_image(FIXTURE_PATTERNS[0]) as unknown as HTMLImageElement,
      plan: valid_plan(1024, 1024),
      output_format: "png",
      file_name: "named.png",
      source_file: new Blob([source_bytes])
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file(MANIFEST_FILE)!.async("string")) as TilesManifest;
    expect(manifest.source).toEqual({
      name: "named.png",
      width: 1024,
      height: 1024,
      sha256: createHash("sha256").update(source_bytes).digest("hex")
    });
  });

  it("fails before any tile, through on_error, where Web Crypto is missing", async () => {
    vi.stubGlobal("crypto", undefined);
    const on_error = vi.fn();
    const result = generate_tiles({
      image: pattern_image(FIXTURE_PATTERNS[0]) as unknown as HTMLImageElement,
      plan: valid_plan(1024, 1024),
      output_format: "png",
      file_name: "pattern-1024.png",
      source_file: SOURCE_FILE,
      on_error
    });
    await expect(result).rejects.toThrow("Hashing needs Web Crypto");
    expect(on_error).toHaveBeenCalledWith(expect.stringContaining("Hashing needs Web Crypto"));
    expect(log.encodes).toHaveLength(0);
  });

  it("adds neither file and builds no zip when aborted while the preview is encoded", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const file_spy = vi.spyOn(JSZip.prototype, "file");
    const controller = new AbortController();
    // the preview is the 86th encode of the 1024 pattern (85 tiles first)
    log.fail = index => {
      if (index === 85) controller.abort();
      return false;
    };
    const result = cut_image(pattern_image(FIXTURE_PATTERNS[0]), "pattern-1024.png", "png", undefined, controller.signal);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(log.encodes).toHaveLength(86);
    const names = file_spy.mock.calls.map(([name]) => name);
    expect(names).not.toContain(PREVIEW_FILE);
    expect(names).not.toContain(MANIFEST_FILE);
    expect(zip_spy).not.toHaveBeenCalled();
  });
});
