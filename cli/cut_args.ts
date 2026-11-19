import { DOWNSCALE_MODES, DownscaleMode } from "@/services/downscale";
import { TILE_SIZE_MODES, TileSizeMode } from "@/services/tile_plan";
import { OutputFormat } from "@/types/types";
import { OUTPUT_FORMATS } from "@/utils/cut_options";

// The command line of pnpm cut. The defaults are the site's (PNG, pixel, auto), except that blank tiles are written
// unless --skip-blank is given.

export const USAGE = `Usage: pnpm cut <image> <out_dir> [options]

Cuts <image> into a Leaflet tile pyramid in <out_dir>: {z}/{y}/{x}.<format>, preview.webp and tiles.json
(written last). The same tiles as the leafletmapdivider site with the same options.

Options:
  --tile auto|256          tile size (default auto)
  --downscale pixel|smooth how the levels below the top are made (default pixel)
  --skip-blank             leave out fully transparent tiles (default: write every tile)
  --format png|webp        tile format, both lossless (default png)
  --force                  replace an earlier cut in <out_dir>
  --quiet                  no progress, only errors
  --json                   print the summary as JSON
  -h, --help               this help`;

export interface CutArgs {
  input: string;
  out_dir: string;
  tile_size: TileSizeMode;
  downscale: DownscaleMode;
  skip_blank: boolean;
  format: OutputFormat;
  force: boolean;
  quiet: boolean;
  json: boolean;
}

export type ParsedCutArgs = { kind: "cut"; args: CutArgs } | { kind: "help" } | { kind: "error"; message: string };

const CHOICES = {
  "--tile": TILE_SIZE_MODES,
  "--downscale": DOWNSCALE_MODES,
  "--format": OUTPUT_FORMATS
} as const;
const FLAGS = ["--skip-blank", "--force", "--quiet", "--json"] as const;

type ChoiceName = keyof typeof CHOICES;
type FlagName = (typeof FLAGS)[number];

/** The arguments after the script name (`--name value` or `--name=value`); unknown or repeated options are errors. */
export function parse_cut_args(argv: readonly string[]): ParsedCutArgs {
  const positional: string[] = [];
  const choices: Partial<Record<ChoiceName, string>> = {};
  const flags = new Set<FlagName>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    // a bare -- (as in pnpm cut -- ...) separates nothing here
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name in CHOICES) {
      const choice = name as ChoiceName;
      let value: string | undefined;
      if (equals !== -1) {
        value = arg.slice(equals + 1);
      } else {
        value = argv[i + 1];
        i++;
      }
      if (value === undefined || value === "") return { kind: "error", message: `${name} needs a value: ${CHOICES[choice].join(" or ")}` };
      if (!(CHOICES[choice] as readonly string[]).includes(value)) {
        return { kind: "error", message: `${name} must be ${CHOICES[choice].join(" or ")}, got "${value}"` };
      }
      if (choices[choice] !== undefined) return { kind: "error", message: `${name} is given twice` };
      choices[choice] = value;
      continue;
    }
    if ((FLAGS as readonly string[]).includes(name)) {
      if (equals !== -1) return { kind: "error", message: `${name} takes no value` };
      if (flags.has(name as FlagName)) return { kind: "error", message: `${name} is given twice` };
      flags.add(name as FlagName);
      continue;
    }
    return { kind: "error", message: `Unknown option ${name}` };
  }

  if (positional.length !== 2) {
    return {
      kind: "error",
      message: positional.length < 2 ? "Give the image and the output folder" : `Too many arguments: ${positional.slice(2).join(" ")}`
    };
  }
  return {
    kind: "cut",
    args: {
      input: positional[0],
      out_dir: positional[1],
      tile_size: (choices["--tile"] ?? "auto") as TileSizeMode,
      downscale: (choices["--downscale"] ?? "pixel") as DownscaleMode,
      format: (choices["--format"] ?? "png") as OutputFormat,
      skip_blank: flags.has("--skip-blank"),
      force: flags.has("--force"),
      quiet: flags.has("--quiet"),
      json: flags.has("--json")
    }
  };
}
