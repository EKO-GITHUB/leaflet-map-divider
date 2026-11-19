import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cut_tiles } from "../cli/cut_tiles";
import { DownscaleMode } from "@/services/downscale";
import { generate_tiles } from "@/services/tile_generator";
import { require_plan, TileSizeMode } from "@/services/tile_plan";
import { MANIFEST_FILE, TilesManifest } from "@/services/tiles_manifest";
import { PREVIEW_FILE } from "@/services/preview";
import { OutputFormat } from "@/types/types";
import { compare_rgba } from "./fixtures/compare";
import { EncodeLog, fake_canvas, pattern_image } from "./fixtures/fake_canvas";
import { FIXTURE_PATTERNS, pattern_spec, PatternSpec, render_pattern } from "./fixtures/pattern";
import { decode_png, encode_png } from "./fixtures/png";

// Parity: the command-line cutter (sharp, written to a folder) and the browser cutter (generate_tiles on the fake
// canvas, which holds pixels exactly) cut the same tiles from the same source, tile for tile, in both downscale modes,
// with blank tiles skipped or kept, and write the same tiles.json apart from created_at. The real browser is compared
// with the CLI outside the tests (see the README); a browser canvas stores premultiplied colour, so partly transparent
// pixels can differ there.

const TILE_NAME = /^(\d+)\/(\d+)\/(\d+)\.(png|webp)$/;

let work_dir: string;
let log: EncodeLog;

beforeAll(async () => {
  work_dir = await mkdtemp(join(tmpdir(), "lmd-parity-"));
});

afterAll(async () => {
  await rm(work_dir, { recursive: true, force: true });
});

beforeEach(() => {
  log = { encodes: [], in_flight: 0, max_in_flight: 0, reads: [] };
  vi.stubGlobal("document", { createElement: () => fake_canvas(log) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Case {
  spec: PatternSpec;
  tile_size: TileSizeMode;
  downscale: DownscaleMode;
  skip_blank: boolean;
  format: OutputFormat;
}

// decoded RGBA by tile name without the extension, z/y/x
type Tiles = Map<string, Uint8Array>;

async function decode_any(bytes: Uint8Array): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

async function browser_cut(c: Case, source: Buffer) {
  const plan = require_plan(c.spec.width, c.spec.height, { tile_size: c.tile_size });
  const blob = await generate_tiles({
    image: pattern_image(c.spec) as unknown as HTMLImageElement,
    plan,
    output_format: c.format,
    downscale: c.downscale,
    skip_blank: c.skip_blank,
    file_name: `${c.spec.name}.png`,
    source_file: new Blob([new Uint8Array(source)])
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const tiles: Tiles = new Map();
  for (const file of Object.values(zip.files)) {
    const match = TILE_NAME.exec(file.name);
    if (file.dir || !match) continue;
    expect(match[4]).toBe(c.format);
    // the fake canvas encodes PNG whatever type it is asked for
    tiles.set(file.name.replace(/\.\w+$/, ""), decode_png(await file.async("uint8array")).data);
  }
  const manifest = JSON.parse(await zip.file(MANIFEST_FILE)!.async("string")) as TilesManifest;
  const preview = decode_png(await zip.file(PREVIEW_FILE)!.async("uint8array"));
  return { plan, tiles, manifest, preview };
}

async function cli_cut(c: Case, input: string, out_dir: string) {
  const result = await cut_tiles({
    input,
    out_dir,
    tile_size: c.tile_size,
    downscale: c.downscale,
    skip_blank: c.skip_blank,
    format: c.format
  });
  const tiles: Tiles = new Map();
  for (const zoom of await readdir(out_dir)) {
    if (!/^\d+$/.test(zoom)) continue;
    for (const row of await readdir(join(out_dir, zoom))) {
      for (const file of await readdir(join(out_dir, zoom, row))) {
        const name = `${zoom}/${row}/${file}`;
        const match = TILE_NAME.exec(name);
        expect(match, name).not.toBeNull();
        expect(match![4]).toBe(c.format);
        const tile = await decode_any(await readFile(join(out_dir, name)));
        expect([tile.width, tile.height], name).toEqual([result.plan.tile_size, result.plan.tile_size]);
        tiles.set(name.replace(/\.\w+$/, ""), tile.data);
      }
    }
  }
  const manifest = JSON.parse(await readFile(join(out_dir, MANIFEST_FILE), "utf8")) as TilesManifest;
  expect(result.manifest).toEqual(manifest);
  const preview_bytes = await readFile(join(out_dir, PREVIEW_FILE));
  const preview = await decode_any(preview_bytes);
  expect((await sharp(preview_bytes).metadata()).format).toBe("webp");
  return { tiles, manifest, preview };
}

const without_time = (manifest: TilesManifest) => ({ ...manifest, created_at: "" });

const [P1024, P1632] = FIXTURE_PATTERNS;
const P1200x800 = pattern_spec(1200, 800);
const P1001x700 = pattern_spec(1001, 700);

const CASES: Case[] = [
  { spec: P1024, tile_size: "auto", downscale: "pixel", skip_blank: true, format: "png" },
  { spec: P1024, tile_size: "auto", downscale: "smooth", skip_blank: true, format: "png" },
  { spec: P1024, tile_size: "auto", downscale: "pixel", skip_blank: false, format: "webp" },
  { spec: P1024, tile_size: "auto", downscale: "smooth", skip_blank: false, format: "webp" },
  { spec: P1632, tile_size: "auto", downscale: "pixel", skip_blank: true, format: "png" },
  { spec: P1632, tile_size: "auto", downscale: "smooth", skip_blank: true, format: "webp" },
  { spec: P1632, tile_size: "auto", downscale: "pixel", skip_blank: false, format: "png" },
  { spec: P1200x800, tile_size: "256", downscale: "pixel", skip_blank: true, format: "webp" },
  { spec: P1200x800, tile_size: "256", downscale: "smooth", skip_blank: true, format: "png" },
  { spec: P1001x700, tile_size: "auto", downscale: "pixel", skip_blank: false, format: "png" },
  { spec: P1001x700, tile_size: "256", downscale: "smooth", skip_blank: true, format: "webp" }
];

describe.each(CASES.map((c, i) => ({ ...c, i, label: `${c.spec.name} ${c.tile_size} ${c.downscale} ${c.skip_blank ? "skip" : "keep"} ${c.format}` })))(
  "$label",
  c => {
    it("cuts the same tiles in the CLI and the browser, with the same tiles.json", async () => {
      const source = encode_png(c.spec.width, c.spec.height, render_pattern(c.spec));
      const case_dir = join(work_dir, String(c.i));
      const input = join(case_dir, `${c.spec.name}.png`);
      await rm(case_dir, { recursive: true, force: true });
      await mkdir(case_dir, { recursive: true });
      await writeFile(input, source);

      const browser = await browser_cut(c, source);
      const cli = await cli_cut(c, input, join(case_dir, "tiles"));

      // the same tiles exist, and each holds the same pixels (transparent pixels are 0, 0, 0, 0 in both)
      expect([...cli.tiles.keys()].sort()).toEqual([...browser.tiles.keys()].sort());
      for (const [name, tile] of browser.tiles) {
        const result = compare_rgba(cli.tiles.get(name)!, tile, browser.plan.tile_size, { compare_transparent_rgb: true });
        expect(result.first_mismatch, name).toBeNull();
      }
      if (c.skip_blank) expect(cli.tiles.size).toBeLessThan(browser.plan.total_tiles);
      else expect(cli.tiles.size).toBe(browser.plan.total_tiles);

      // the same manifest apart from the time, and the same preview
      expect(without_time(cli.manifest)).toEqual(without_time(browser.manifest));
      expect(cli.manifest.tiles.written).toBe(cli.tiles.size);
      expect([cli.preview.width, cli.preview.height]).toEqual([browser.preview.width, browser.preview.height]);
      expect(
        compare_rgba(cli.preview.data, browser.preview.data, browser.preview.width, { compare_transparent_rgb: true })
          .first_mismatch
      ).toBeNull();
    }, 60_000);
  }
);
