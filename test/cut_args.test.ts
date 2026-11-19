import { describe, expect, it } from "vitest";
import { parse_cut_args, USAGE } from "../cli/cut_args";

describe("parse_cut_args", () => {
  it("takes the image and the folder, with the site's defaults and blank tiles written", () => {
    expect(parse_cut_args(["map.png", "out"])).toEqual({
      kind: "cut",
      args: {
        input: "map.png",
        out_dir: "out",
        tile_size: "auto",
        downscale: "pixel",
        format: "png",
        skip_blank: false,
        force: false,
        quiet: false,
        json: false
      }
    });
  });

  it("reads every option, as --name value or --name=value, before or after the paths", () => {
    const parsed = parse_cut_args([
      "--tile",
      "256",
      "map.png",
      "--downscale=smooth",
      "--skip-blank",
      "out dir",
      "--format",
      "webp",
      "--force",
      "--quiet",
      "--json"
    ]);
    expect(parsed).toEqual({
      kind: "cut",
      args: {
        input: "map.png",
        out_dir: "out dir",
        tile_size: "256",
        downscale: "smooth",
        format: "webp",
        skip_blank: true,
        force: true,
        quiet: true,
        json: true
      }
    });
  });

  it("ignores a bare -- (pnpm cut -- ...)", () => {
    const parsed = parse_cut_args(["--", "a.png", "b", "--tile", "256"]);
    expect(parsed).toMatchObject({ kind: "cut", args: { input: "a.png", out_dir: "b", tile_size: "256" } });
  });

  it("asks for help", () => {
    expect(parse_cut_args(["--help"])).toEqual({ kind: "help" });
    expect(parse_cut_args(["a.png", "-h"])).toEqual({ kind: "help" });
    expect(USAGE).toContain("pnpm cut <image> <out_dir>");
  });

  it.each([
    [[], "Give the image and the output folder"],
    [["a.png"], "Give the image and the output folder"],
    [["a.png", "b", "c"], "Too many arguments: c"],
    [["a.png", "b", "--tile", "512"], '--tile must be auto or 256, got "512"'],
    [["a.png", "b", "--tile"], "--tile needs a value: auto or 256"],
    [["a.png", "b", "--tile="], "--tile needs a value: auto or 256"],
    [["a.png", "b", "--downscale", "nearest"], '--downscale must be pixel or smooth, got "nearest"'],
    [["a.png", "b", "--format", "jpeg"], '--format must be png or webp, got "jpeg"'],
    [["a.png", "b", "--format", "WEBP"], '--format must be png or webp, got "WEBP"'],
    [["a.png", "b", "--tile", "256", "--tile", "auto"], "--tile is given twice"],
    [["a.png", "b", "--skip-blank", "--skip-blank"], "--skip-blank is given twice"],
    [["a.png", "b", "--skip-blank=yes"], "--skip-blank takes no value"],
    [["a.png", "b", "--keep-blank"], "Unknown option --keep-blank"]
  ])("rejects %j", (argv, message) => {
    expect(parse_cut_args(argv)).toEqual({ kind: "error", message });
  });
});
