import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cut_tiles, CutError, CutTilesOptions } from "../cli/cut_tiles";
import { ERROR_MESSAGES } from "@/constants/constants";
import { MANIFEST_FILE, TilesManifest } from "@/services/tiles_manifest";
import { encode_png } from "./fixtures/png";

// The command-line cutter around the pyramid: decoding (any format sharp reads, as a browser shows it), the output
// folder, the files it writes and its errors. Tile-for-tile parity with the browser is in cli_parity.test.ts.

let work_dir: string;
let counter = 0;

beforeAll(async () => {
  work_dir = await mkdtemp(join(tmpdir(), "lmd-cut-"));
});

afterAll(async () => {
  await rm(work_dir, { recursive: true, force: true });
});

async function fresh_dir() {
  const dir = join(work_dir, String(counter++));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function write_input(name: string, bytes: Uint8Array) {
  const dir = await fresh_dir();
  const path = join(dir, name);
  await writeFile(path, bytes);
  return { dir, path };
}

function options(input: string, out_dir: string, extra: Partial<CutTilesOptions> = {}): CutTilesOptions {
  return { input, out_dir, tile_size: "256", downscale: "pixel", skip_blank: false, format: "png", ...extra };
}

async function read_tile(out_dir: string, name: string) {
  const { data, info } = await sharp(await readFile(join(out_dir, name)))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  return new Uint8Array(data);
}

async function files_of(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll("\\", "/"));
  }
  return out.sort();
}

describe("cut_tiles", () => {
  it("writes the tiles, preview.webp and tiles.json into a new folder", async () => {
    const rgba = new Uint8Array(300 * 200 * 4).fill(200);
    const { dir, path } = await write_input("flat.png", encode_png(300, 200, rgba));
    const out_dir = join(dir, "out", "nested");
    const result = await cut_tiles(options(path, out_dir));

    // 300 x 200 at 256: padded to 512, z0-z1
    expect(result.plan).toMatchObject({ padded_size: 512, max_zoom: 1, total_tiles: 5 });
    expect(await files_of(out_dir)).toEqual(["0/0/0.png", "1/0/0.png", "1/0/1.png", "1/1/0.png", "1/1/1.png", "preview.webp", MANIFEST_FILE].sort());
    const manifest = JSON.parse(await readFile(join(out_dir, MANIFEST_FILE), "utf8")) as TilesManifest;
    expect(manifest).toEqual(result.manifest);
    expect(manifest.source).toMatchObject({ name: "flat.png", width: 300, height: 200 });
    expect(manifest.tiles).toEqual({ total: 5, written: 5, skipped: 0 });
    expect(result.seconds).toBeGreaterThan(0);
  });

  it("skips blank tiles only with skip_blank, and writes them transparent otherwise", async () => {
    const rgba = new Uint8Array(300 * 200 * 4).fill(255);
    const { dir, path } = await write_input("white.png", encode_png(300, 200, rgba));
    const kept = await cut_tiles(options(path, join(dir, "keep")));
    expect(kept.manifest.tiles).toEqual({ total: 5, written: 5, skipped: 0 });
    // 1/1/1 is pad only (x >= 256, y >= 256)
    expect((await read_tile(join(dir, "keep"), "1/1/1.png")).every(value => value === 0)).toBe(true);

    const skipped = await cut_tiles(options(path, join(dir, "skip"), { skip_blank: true }));
    expect(skipped.manifest.tiles).toEqual({ total: 5, written: 3, skipped: 2 });
    expect(await files_of(join(dir, "skip"))).toEqual(["0/0/0.png", "1/0/0.png", "1/0/1.png", "preview.webp", MANIFEST_FILE].sort());
  });

  it("holds transparent pixels as 0, 0, 0, 0, as a canvas does, so colour under alpha 0 is no content", async () => {
    // red under alpha 0 on the right half, opaque blue on the left
    const width = 512;
    const rgba = new Uint8Array(width * 256 * 4);
    for (let i = 0; i < width * 256; i++) {
      const left = i % width < 256;
      rgba.set(left ? [0, 0, 255, 255] : [255, 0, 0, 0], i * 4);
    }
    const { dir, path } = await write_input("hidden.png", encode_png(width, 256, rgba));
    for (const format of ["png", "webp"] as const) {
      const out_dir = join(dir, format);
      const result = await cut_tiles(options(path, out_dir, { format, skip_blank: true }));
      // z1 tile 1,0 holds only hidden red: blank and skipped; z0's right half is 0, 0, 0, 0
      expect(existsSync(join(out_dir, `1/0/1.${format}`))).toBe(false);
      expect(result.manifest.tiles.skipped).toBe(3);
      const z0 = await read_tile(out_dir, `0/0/0.${format}`);
      expect(Array.from(z0.subarray(0, 4))).toEqual([0, 0, 255, 255]);
      expect(Array.from(z0.subarray(200 * 4, 200 * 4 + 4))).toEqual([0, 0, 0, 0]);
    }
  });

  it("reads greyscale, palette and JPEG sources as RGBA, as a browser draws them", async () => {
    const grey = await sharp(Buffer.alloc(256 * 256, 90), { raw: { width: 256, height: 256, channels: 1 } })
      .png()
      .toBuffer();
    const palette = await sharp(Buffer.alloc(256 * 256 * 3, 40), { raw: { width: 256, height: 256, channels: 3 } })
      .png({ palette: true })
      .toBuffer();
    const jpeg = await sharp(Buffer.alloc(256 * 256 * 3, 128), { raw: { width: 256, height: 256, channels: 3 } })
      .jpeg({ quality: 100 })
      .toBuffer();
    for (const [name, bytes, value] of [
      ["grey.png", grey, 90],
      ["palette.png", palette, 40],
      ["photo.jpg", jpeg, 128]
    ] as const) {
      const { dir, path } = await write_input(name, bytes);
      await cut_tiles(options(path, join(dir, "out")));
      const tile = await read_tile(join(dir, "out"), "0/0/0.png");
      expect(Array.from(tile.subarray(0, 4)), name).toEqual([value, value, value, 255]);
    }
  });

  it("keeps the pixels of an sRGB-profiled source as they are, and converts another profile to sRGB", async () => {
    const raw = Buffer.alloc(256 * 256 * 3);
    for (let i = 0; i < raw.length; i += 3) raw.set([200, 60, 30], i);
    // withIccProfile stores the sRGB colour (200, 60, 30) in the profile's own numbers
    const cut_with = async (profile: string) => {
      const png = await sharp(raw, { raw: { width: 256, height: 256, channels: 3 } })
        .png()
        .withIccProfile(profile)
        .toBuffer();
      const stored = Array.from((await sharp(png, { ignoreIcc: true }).raw().toBuffer()).subarray(0, 3));
      const { dir, path } = await write_input(`${profile}.png`, png);
      await cut_tiles(options(path, join(dir, "out")));
      return { stored, tile: Array.from((await read_tile(join(dir, "out"), "0/0/0.png")).subarray(0, 4)) };
    };
    // sRGB: the stored numbers, untouched
    const srgb = await cut_with("srgb");
    expect(srgb.stored).toEqual([200, 60, 30]);
    expect(srgb.tile).toEqual([200, 60, 30, 255]);
    // Display P3 stores other numbers for the same colour; the tile is that colour in sRGB again (within rounding)
    const p3 = await cut_with("p3");
    expect(p3.stored).not.toEqual([200, 60, 30]);
    p3.tile.slice(0, 3).forEach((value, c) => expect(Math.abs(value - [200, 60, 30][c])).toBeLessThanOrEqual(2));
    expect(p3.tile[3]).toBe(255);
  });

  it("applies the EXIF orientation, as an <img> does", async () => {
    // 300 x 200 stored, orientation 6 (rotate 90 degrees clockwise): shown 200 x 300
    const jpeg = await sharp(Buffer.alloc(300 * 200 * 3, 128), { raw: { width: 300, height: 200, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { dir, path } = await write_input("rotated.jpg", jpeg);
    const result = await cut_tiles(options(path, join(dir, "out")));
    expect(result.manifest.source).toMatchObject({ width: 200, height: 300 });
  });

  it("replaces an earlier cut with force, and nothing else", async () => {
    const rgba = new Uint8Array(300 * 200 * 4).fill(255);
    const { dir, path } = await write_input("map.png", encode_png(300, 200, rgba));
    const out_dir = join(dir, "out");
    await cut_tiles(options(path, out_dir));

    // a second cut into the same folder needs force
    await expect(cut_tiles(options(path, out_dir, { skip_blank: true }))).rejects.toThrow(
      new CutError(`${out_dir} is not empty; pass --force to replace an earlier cut there`)
    );
    // with force, the earlier tiles go: the blank 1/1/1.png of the first cut does not stay behind
    await cut_tiles(options(path, out_dir, { skip_blank: true, force: true }));
    expect(existsSync(join(out_dir, "1/1/1.png"))).toBe(false);
    expect(await files_of(out_dir)).toEqual(["0/0/0.png", "1/0/0.png", "1/0/1.png", "preview.webp", MANIFEST_FILE].sort());

    // a folder that holds something else is never cleared
    await writeFile(join(out_dir, "notes.txt"), "keep me");
    await expect(cut_tiles(options(path, out_dir, { force: true }))).rejects.toThrow(/not an earlier cut \(notes\.txt\)/);
    expect(existsSync(join(out_dir, "0/0/0.png"))).toBe(true);
  });

  it.each([
    ["a missing file", async () => (await fresh_dir()) + "/missing.png", /^Cannot read .*missing\.png/],
    ["a folder", async () => fresh_dir(), /is not a file$/],
    ["a file that is not an image", async () => (await write_input("notes.png", new TextEncoder().encode("not an image"))).path, /is not an image sharp can read/],
    ["an image under 128 px", async () => (await write_input("small.png", encode_png(127, 300, new Uint8Array(127 * 300 * 4)))).path, new RegExp(`\\(127x300\\): ${ERROR_MESSAGES.TOO_SMALL.replace(/[.!]/g, "\\$&")}`)]
  ])("refuses %s with a CutError and writes nothing", async (_label, make_input, message) => {
    const input = await make_input();
    const out_dir = join(await fresh_dir(), "out");
    const result = cut_tiles(options(input, out_dir));
    await expect(result).rejects.toBeInstanceOf(CutError);
    await expect(result).rejects.toThrow(message);
    expect(existsSync(out_dir)).toBe(false);
  });

  it("refuses an output path that is a file", async () => {
    const rgba = new Uint8Array(256 * 256 * 4).fill(255);
    const { dir, path } = await write_input("map.png", encode_png(256, 256, rgba));
    await writeFile(join(dir, "out"), "a file");
    await expect(cut_tiles(options(path, join(dir, "out")))).rejects.toThrow(/is a file, not a folder/);
  });

  it("reports its progress, ending with every row and tile", async () => {
    const rgba = new Uint8Array(1024 * 1024 * 4).fill(255);
    const { dir, path } = await write_input("big.png", encode_png(1024, 1024, rgba));
    const reports: { processed: number; rows: number }[] = [];
    await cut_tiles(options(path, join(dir, "out"), { on_progress: ({ processed, rows }) => reports.push({ processed, rows }) }));
    expect(reports.at(-1)).toEqual({ processed: 21, rows: 1024 });
  });
});
