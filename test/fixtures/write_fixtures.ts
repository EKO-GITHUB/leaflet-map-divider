// pnpm fixtures [N | WxH]...  writes pattern PNGs to test/fixtures/generated/ (gitignored).
// Without arguments: the two fixtures, 1024 px and 1632 px. Rows are streamed, so 16384 px works too.
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PATTERNS, PatternSpec, pattern_spec, render_pattern_row } from "./pattern";
import { write_png_file } from "./png";

const OUT_DIR = join(import.meta.dirname, "generated");

function parse_size(arg: string): PatternSpec {
  const match = /^(\d+)(?:x(\d+))?$/.exec(arg);
  if (!match) throw new Error(`size must be N or WxH, got "${arg}"`);
  return pattern_spec(Number(match[1]), match[2] ? Number(match[2]) : undefined);
}

async function main() {
  const args = process.argv.slice(2);
  const specs = args.length > 0 ? args.map(parse_size) : [...FIXTURE_PATTERNS];
  mkdirSync(OUT_DIR, { recursive: true });
  for (const spec of specs) {
    const path = join(OUT_DIR, `${spec.name}.png`);
    const started = Date.now();
    const row = new Uint8Array(spec.width * 4);
    await write_png_file(path, spec.width, spec.height, (y) => render_pattern_row(spec, y, row));
    const mb = (statSync(path).size / 1024 / 1024).toFixed(1);
    console.log(`${path}  ${spec.width}x${spec.height}, corner ${spec.corner} px  ${mb} MB  ${Date.now() - started} ms`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
