// pnpm cut <image> <out_dir> [--tile auto|256] [--downscale pixel|smooth] [--skip-blank] [--format webp|png]
// The command-line tile cutter; see cut_tiles.ts and the README's "Command line" section.
import { availableParallelism } from "node:os";
import { parse_cut_args, USAGE } from "./cut_args";

// sharp encodes on libuv's thread pool (4 threads unless set): one thread a core, 4 to 32 (a 16384 px cut on 32 cores:
// 25.6 s with 4, 11.1 s with 16, 9.4 s with 32). It must be set before the pool first runs, so sharp and the cutter
// are loaded afterwards; a UV_THREADPOOL_SIZE in the shell wins
process.env.UV_THREADPOOL_SIZE ??= String(Math.min(32, Math.max(4, availableParallelism())));

function format_count(value: number): string {
  return value.toLocaleString("en-US");
}

async function main(): Promise<number> {
  const parsed = parse_cut_args(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { args } = parsed;
  const { cut_tiles, CutError } = await import("./cut_tiles");
  const show_progress = !args.quiet && !args.json && process.stderr.isTTY;

  try {
    const result = await cut_tiles({
      ...args,
      on_progress: show_progress
        ? progress => {
            const { plan, processed, skipped, rows } = progress;
            process.stderr.write(
              `\r${format_count(rows)} / ${format_count(plan.height)} rows · ` +
                `${format_count(processed)} / ${format_count(plan.total_tiles)} tiles` +
                (skipped > 0 ? ` (${format_count(skipped)} blank skipped)` : "")
            );
          }
        : undefined
    });
    if (show_progress) process.stderr.write("\n");

    const { manifest, seconds } = result;
    const peak_mb = Math.round(process.resourceUsage().maxRSS / 1024);
    if (args.json) {
      console.log(JSON.stringify({ out_dir: args.out_dir, seconds, peak_rss_mb: peak_mb, manifest }));
    } else if (!args.quiet) {
      const { source, tiles } = manifest;
      console.log(
        [
          `${source.name} ${source.width}x${source.height} -> ${args.out_dir}`,
          `  padded to ${manifest.padded_size} px, ${manifest.tile_size} px tiles, z0-z${manifest.max_zoom}, ` +
            `${manifest.format}, ${manifest.downscale}`,
          `  ${format_count(tiles.written)} tiles written` +
            (manifest.skip_blank ? `, ${format_count(tiles.skipped)} blank skipped` : "") +
            `, preview ${manifest.preview.width}x${manifest.preview.height}`,
          `  ${seconds.toFixed(1)} s, ${format_count(Math.round(tiles.total / seconds))} tiles/s, peak memory ${format_count(peak_mb)} MB`
        ].join("\n")
      );
    }
    return 0;
  } catch (error) {
    if (show_progress) process.stderr.write("\n");
    if (error instanceof CutError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

main().then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(error);
    process.exitCode = 1;
  }
);
