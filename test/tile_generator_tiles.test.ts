import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate_tiles, MAX_PENDING_ENCODES } from "@/services/tile_generator";
import { plan_tiles, TilePlan } from "@/services/tile_plan";
import { OutputFormat } from "@/types/types";
import { compare_rgba } from "./fixtures/compare";
import { FIXTURE_PATTERNS, PatternSpec, render_pattern, write_pattern_pixel } from "./fixtures/pattern";
import { decode_png, encode_png } from "./fixtures/png";

// The checker test: a fake canvas that really holds the pattern's pixels (nearest-neighbour, as the browser draws with
// imageSmoothingEnabled off) and encodes PNG with the fixtures' encoder, so every tile in the zip can be decoded and
// compared with the pattern region it must hold.

type Sampler = (x: number, y: number, out: Uint8Array, offset: number) => void;

const TRANSPARENT: Sampler = (_x, _y, out, offset) => out.fill(0, offset, offset + 4);

interface FakeImage {
  naturalWidth: number;
  naturalHeight: number;
  spec: PatternSpec;
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
    drawImage: (source: FakeImage | FakeCanvas, ...args: number[]) => {
      if ("spec" in source) {
        // drawImage(image, dx, dy, dw, dh) or drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh), always from 0,0
        const [dw, dh] = args.length === 4 ? [args[2], args[3]] : [args[6], args[7]];
        const scale_x = source.naturalWidth / dw;
        const scale_y = source.naturalHeight / dh;
        const spec = source.spec;
        canvas.sampler = (x, y, out, offset) => {
          if (x >= dw || y >= dh) return TRANSPARENT(x, y, out, offset);
          write_pattern_pixel(spec, Math.floor(x * scale_x), Math.floor(y * scale_y), out, offset);
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
  log = { encodes: [], in_flight: 0, max_in_flight: 0 };
  vi.stubGlobal("document", { createElement: () => fake_canvas(log) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function cut(spec: PatternSpec, output_format: OutputFormat = "png") {
  const plan = valid_plan(spec.width, spec.height);
  const image: FakeImage = { naturalWidth: spec.width, naturalHeight: spec.height, spec };
  const on_error = vi.fn();
  const blob = await generate_tiles({
    image: image as unknown as HTMLImageElement,
    plan,
    output_format,
    file_name: `${spec.name}.png`,
    on_error
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
        image: { naturalWidth: 1024, naturalHeight: 1024, spec } as unknown as HTMLImageElement,
        plan,
        output_format: "png",
        file_name: "pattern-1024.png",
        on_error
      })
    ).rejects.toThrow();
    expect(on_error).toHaveBeenCalledWith(expect.stringContaining("the canvas could not be encoded"));
  });
});
