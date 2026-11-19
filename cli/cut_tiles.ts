import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";
import { DownscaleMode } from "@/services/downscale";
import { plan_preview, PREVIEW_FILE } from "@/services/preview";
import { plan_tiles, TilePlan, TileSizeMode } from "@/services/tile_plan";
import {
  build_tiles_manifest,
  MANIFEST_FILE,
  serialize_tiles_manifest,
  tile_path,
  TilesManifest
} from "@/services/tiles_manifest";
import { OutputFormat } from "@/types/types";
import { is_srgb_profile } from "./icc";
import { create_pyramid_stream } from "./pyramid_stream";

// The command-line cutter (pnpm cut): the browser cutter's pyramid, written straight to a folder. It shares the
// tiling plan, the halvings (pixel and smooth), the blank-tile check, the preview rule and the manifest with the site,
// so both cut the same tiles from the same source pixels. sharp decodes the source and encodes the tiles; the pyramid
// is built from the source's rows one after another (pyramid_stream.ts) and needs only about two bands of the top
// level besides them. The decoded source itself is held once (sharp hands a raw output over as one buffer): peak
// memory is about width * height * 4 bytes plus a few hundred MB (16384 px: 1.3-1.6 GB).
//
// The folder gets {z}/{y}/{x}.<format>, preview.webp and, written last, tiles.json: a folder without tiles.json is an
// unfinished cut.

export interface CutTilesOptions {
  input: string;
  out_dir: string;
  tile_size: TileSizeMode;
  downscale: DownscaleMode;
  skip_blank: boolean;
  format: OutputFormat;
  /** replace an earlier cut in out_dir (its zoom folders, tiles.json and preview.webp); other files make it fail */
  force?: boolean;
  /** encodes in flight at once (default: twice the thread pool) */
  concurrency?: number;
  on_progress?: (progress: CutProgress) => void;
}

export interface CutProgress {
  plan: TilePlan;
  /** tiles handed over so far (written + skipped), of plan.total_tiles */
  processed: number;
  written: number;
  skipped: number;
  /** source rows read, of plan.height */
  rows: number;
}

export interface CutTilesResult {
  manifest: TilesManifest;
  plan: TilePlan;
  seconds: number;
}

/** A source that cannot be cut, an option that does not apply or an output folder in the way: a message for the user. */
export class CutError extends Error {
  name = "CutError";
}

const PREVIOUS_CUT_ENTRY = /^\d+$/;

// every sharp operation here is used once, so libvips's operation cache only holds memory (and, on Windows, the
// source file open). The tiles are encoded in parallel on the thread pool (cut.ts sizes it), one libvips thread each:
// on 32 cores a 16384 px cut took 8.4 s that way and 9.4 s with libvips's default of a thread a core per encode
sharp.cache(false);
sharp.concurrency(1);

// lossless WebP, as the browser's quality 1.0; `exact` keeps transparent pixels 0, 0, 0, 0 as they are given (a canvas
// hands them back that way too)
function encode(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, format: OutputFormat): Promise<Buffer> {
  const image = sharp(rgba, { raw: { width, height, channels: 4 } });
  return format === "webp" ? image.webp({ lossless: true, exact: true }).toBuffer() : image.png().toBuffer();
}

function sha256_file(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", chunk => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// an empty (or missing) folder, or with force one that holds only an earlier cut, which is removed
async function prepare_out_dir(out_dir: string, force: boolean): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(out_dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(out_dir, { recursive: true });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new CutError(`${out_dir} is a file, not a folder`);
    throw error;
  }
  if (entries.length === 0) return;
  const earlier_cut = (name: string) => PREVIOUS_CUT_ENTRY.test(name) || name === MANIFEST_FILE || name === PREVIEW_FILE;
  if (!force) {
    throw new CutError(`${out_dir} is not empty; pass --force to replace an earlier cut there`);
  }
  const others = entries.filter(name => !earlier_cut(name));
  if (others.length > 0) {
    throw new CutError(`${out_dir} holds files that are not an earlier cut (${others.slice(0, 3).join(", ")}); not replacing it`);
  }
  // tiles.json first: from here on the folder is an unfinished cut
  for (const name of [...entries].sort((a, b) => Number(b === MANIFEST_FILE) - Number(a === MANIFEST_FILE))) {
    await rm(join(out_dir, name), { recursive: true, force: true });
  }
}

// encodes and writes run in parallel, at most `limit` at once; the first failure fails the cut
function create_write_pool(limit: number) {
  const pending = new Set<Promise<void>>();
  let failure: { error: unknown } | null = null;
  const check = () => {
    if (failure) throw failure.error;
  };
  return {
    async add(task: () => Promise<void>): Promise<void> {
      check();
      while (pending.size >= limit) {
        await Promise.race(pending);
        check();
      }
      const promise: Promise<void> = task().then(
        () => {
          pending.delete(promise);
        },
        error => {
          failure ??= { error };
          pending.delete(promise);
        }
      );
      pending.add(promise);
    },
    async drain(): Promise<void> {
      await Promise.all(pending);
      check();
    }
  };
}

export async function cut_tiles(options: CutTilesOptions): Promise<CutTilesResult> {
  const { input, out_dir, tile_size, downscale, skip_blank, format, on_progress } = options;
  const started = performance.now();

  try {
    if (!(await stat(input)).isFile()) throw new CutError(`${input} is not a file`);
  } catch (error) {
    if (error instanceof CutError) throw error;
    throw new CutError(`Cannot read ${input}: ${(error as Error).message}`);
  }

  // the image as a browser shows it: EXIF orientation applied (as an <img> does), and an embedded colour profile
  // converted to sRGB unless it is an sRGB profile itself, which a browser treats as no conversion (lcms converting
  // sRGB to sRGB moves a few values by 1)
  let width: number;
  let height: number;
  let ignore_icc: boolean;
  try {
    const metadata = await sharp(input, { autoOrient: true, limitInputPixels: false }).metadata();
    ({ width, height } = metadata.autoOrient);
    ignore_icc = !metadata.icc || is_srgb_profile(metadata.icc);
  } catch (error) {
    throw new CutError(`${input} is not an image sharp can read: ${(error as Error).message}`);
  }
  const source = () =>
    sharp(input, { autoOrient: true, limitInputPixels: false, sequentialRead: true, ignoreIcc: ignore_icc });
  const planned = plan_tiles(width, height, { tile_size });
  if (!planned.is_valid) throw new CutError(`${input} (${width}x${height}): ${planned.error}`);
  const plan = planned.plan;
  const preview = plan_preview(plan);

  await prepare_out_dir(out_dir, options.force ?? false);
  const sha256 = sha256_file(input);
  sha256.catch(() => {});

  const counts = plan.levels.map(() => ({ written: 0, skipped: 0 }));
  let processed = 0;
  let written = 0;
  let rows = 0;
  const report = () => on_progress?.({ plan, processed, written, skipped: processed - written, rows });
  let last_report = 0;
  const pool = create_write_pool(options.concurrency ?? Math.max(4, 2 * Number(process.env.UV_THREADPOOL_SIZE ?? 4)));
  // one mkdir a folder, shared by the tiles written into it while it is being made
  const made_dirs = new Map<string, Promise<unknown>>();
  // the encoding of an all-transparent tile, made once (blank tiles are written when they are not skipped)
  let blank_bytes: Promise<Buffer> | null = null;
  const t = plan.tile_size;

  const write_tile = async (zoom: number, x: number, y: number, bytes: Buffer) => {
    const dir = join(out_dir, String(zoom), String(y));
    let made = made_dirs.get(dir);
    if (!made) {
      made = mkdir(dir, { recursive: true });
      made_dirs.set(dir, made);
    }
    await made;
    await writeFile(join(out_dir, tile_path(zoom, x, y, format)), bytes);
  };

  const pyramid = create_pyramid_stream({
    plan,
    downscale,
    preview,
    on_tile: async (zoom, x, y, rgba) => {
      processed++;
      if (rgba === null && skip_blank) {
        counts[zoom].skipped++;
      } else {
        counts[zoom].written++;
        written++;
        await pool.add(async () => {
          const bytes = rgba
            ? await encode(rgba, t, t, format)
            : await (blank_bytes ??= encode(new Uint8Array(t * t * 4), t, t, format));
          await write_tile(zoom, x, y, bytes);
        });
      }
      const now = performance.now();
      if (now - last_report >= 250) {
        last_report = now;
        report();
      }
    }
  });

  // the source's rows as sRGB RGBA, 8 bits a channel (a grey or palette image is expanded, a profile other than sRGB
  // converted, as a browser draws it); a pixel with alpha 0 is made 0, 0, 0, 0, which is how a canvas holds it
  const row_bytes = width * 4;
  const row = new Uint8Array(row_bytes);
  const row_words = new Uint32Array(row.buffer);
  let filled = 0;
  // set when a tile fails to encode or write while the rows are pushed (the pyramid, not the decode)
  const pyramid_failure: { error?: unknown } = {};
  try {
    const stream = source().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(row_bytes - filled, chunk.length - offset);
        row.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled < row_bytes) continue;
        for (let i = 0; i < row_words.length; i++) {
          // little-endian words: alpha is the top byte
          if (row_words[i] !== 0 && row_words[i] >>> 24 === 0) row_words[i] = 0;
        }
        try {
          await pyramid.push_row(row);
        } catch (error) {
          pyramid_failure.error = error;
          throw error;
        }
        rows++;
        filled = 0;
      }
    }
  } catch (error) {
    await pool.drain().catch(() => {});
    if ("error" in pyramid_failure) throw pyramid_failure.error;
    throw new CutError(`Failed to decode ${input}: ${(error as Error).message}`);
  }
  if (rows !== height || filled !== 0) {
    await pool.drain().catch(() => {});
    throw new CutError(`${input} decoded to ${rows} rows of ${width} px, not ${height}`);
  }

  const preview_image = await pyramid.end();
  await pool.drain();
  report();
  if (!preview_image) throw new Error("The preview was not collected");

  const preview_bytes = await encode(preview_image.data, preview_image.width, preview_image.height, "webp");
  await writeFile(join(out_dir, PREVIEW_FILE), preview_bytes);

  const manifest = build_tiles_manifest({
    plan,
    source: { name: basename(input), sha256: await sha256 },
    format,
    downscale,
    skip_blank,
    counts,
    preview,
    created_at: new Date()
  });
  await writeFile(join(out_dir, MANIFEST_FILE), serialize_tiles_manifest(manifest));

  return { manifest, plan, seconds: (performance.now() - started) / 1000 };
}
