import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plan_preview } from "@/services/preview";
import { require_plan } from "@/services/tile_plan";
import {
  build_tiles_manifest,
  MANIFEST_FILE,
  MANIFEST_FORMAT_VERSION,
  ManifestInput,
  serialize_tiles_manifest,
  sha256_hex,
  tile_path
} from "@/services/tiles_manifest";

const SHA = "ab".repeat(32);

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  // 1200 x 800 at 256: 2048 px, z0-z3; the pad and the pattern's corner skip 0 / 2 / 10 / 45 tiles
  const plan = require_plan(1200, 800, { tile_size: "256" });
  return {
    plan,
    source: { name: "map.png", sha256: SHA },
    format: "webp",
    downscale: "smooth",
    skip_blank: true,
    counts: [
      { written: 1, skipped: 0 },
      { written: 2, skipped: 2 },
      { written: 6, skipped: 10 },
      { written: 19, skipped: 45 }
    ],
    preview: plan_preview(plan),
    created_at: new Date(Date.UTC(2026, 10, 19, 12, 30, 0)),
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("build_tiles_manifest", () => {
  it("describes the source, the plan, the options, the counts and the preview", () => {
    expect(MANIFEST_FILE).toBe("tiles.json");
    expect(build_tiles_manifest(input())).toEqual({
      format_version: MANIFEST_FORMAT_VERSION,
      generator: "leafletmapdivider",
      created_at: "2026-11-19T12:30:00.000Z",
      source: { name: "map.png", width: 1200, height: 800, sha256: SHA },
      padded_size: 2048,
      tile_size_mode: "256",
      tile_size: 256,
      min_zoom: 0,
      max_zoom: 3,
      format: "webp",
      layout: "z/y/x",
      y_origin: "top",
      path_template: "{z}/{y}/{x}.webp",
      downscale: "smooth",
      skip_blank: true,
      tiles: { total: 85, written: 28, skipped: 57 },
      levels: [
        { zoom: 0, tiles_per_side: 1, source_tile_size: 2048, content_columns: 1, content_rows: 1, written: 1, skipped: 0 },
        { zoom: 1, tiles_per_side: 2, source_tile_size: 1024, content_columns: 2, content_rows: 1, written: 2, skipped: 2 },
        { zoom: 2, tiles_per_side: 4, source_tile_size: 512, content_columns: 3, content_rows: 2, written: 6, skipped: 10 },
        { zoom: 3, tiles_per_side: 8, source_tile_size: 256, content_columns: 5, content_rows: 4, written: 19, skipped: 45 }
      ],
      preview: { path: "preview.webp", zoom: 2, extra_halvings: 0, scale: 2, width: 600, height: 400 }
    });
    expect(MANIFEST_FORMAT_VERSION).toBe(1);
  });

  it("names the tile format in the path template", () => {
    expect(build_tiles_manifest(input({ format: "png" }))).toMatchObject({ format: "png", path_template: "{z}/{y}/{x}.png" });
  });

  it("rejects counts that do not add up to the plan", () => {
    const counts = input().counts.map(count => ({ ...count }));
    counts[2].written = 7;
    expect(() => build_tiles_manifest(input({ counts }))).toThrow("zoom 2 has 16 tiles");
    expect(() => build_tiles_manifest(input({ counts: counts.slice(0, 3) }))).toThrow("3 level counts for 4 levels");
    counts[2] = { written: -1, skipped: 17 };
    expect(() => build_tiles_manifest(input({ counts }))).toThrow(RangeError);
  });

  it("rejects skipped tiles when blank tiles were kept", () => {
    expect(() => build_tiles_manifest(input({ skip_blank: false }))).toThrow("without skip_blank");
  });

  it("rejects a sha256 that is not 64 lowercase hex digits", () => {
    for (const sha256 of ["", "AB".repeat(32), "ab".repeat(31), "zz".repeat(32)]) {
      expect(() => build_tiles_manifest(input({ source: { name: "map.png", sha256 } })), sha256).toThrow(RangeError);
    }
  });
});

describe("serialize_tiles_manifest", () => {
  it("writes indented JSON with a trailing newline that reads back the same", () => {
    const manifest = build_tiles_manifest(input());
    const text = serialize_tiles_manifest(manifest);
    expect(text.startsWith('{\n  "format_version": 1,\n')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(manifest);
  });
});

describe("tile_path", () => {
  it("is zoom / row / column", () => {
    expect(tile_path(3, 5, 2, "webp")).toBe("3/2/5.webp");
    expect(tile_path(0, 0, 0, "png")).toBe("0/0/0.png");
  });
});

describe("sha256_hex", () => {
  it("hashes bytes, buffers and blobs as lowercase hex", async () => {
    expect(await sha256_hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const abc = new TextEncoder().encode("abc");
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256_hex(abc)).toBe(expected);
    expect(await sha256_hex(abc.buffer as ArrayBuffer)).toBe(expected);
    expect(await sha256_hex(new Blob([abc]))).toBe(expected);
    const big = new Uint8Array(3_000_000).map((_, i) => (i * 31) & 255);
    expect(await sha256_hex(new Blob([big]))).toBe(createHash("sha256").update(big).digest("hex"));
  });

  it("throws at once where Web Crypto is missing", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => sha256_hex(new Uint8Array([1]))).toThrow("Hashing needs Web Crypto");
  });
});
