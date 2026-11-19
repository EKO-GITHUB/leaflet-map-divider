# LeafletJS Map Tile Generator

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen.svg)](https://leafletmapdivider.com)

Cuts a large image into a tile pyramid for [Leaflet](https://leafletjs.com) (`L.tileLayer` on `L.CRS.Simple`) and
saves it as one zip. Everything runs in your browser: the image never leaves your device.

## How it works

1. **Load an image** (panel 01 / the viewport): drop it on the viewport or browse for it. Any format the browser can
   decode (PNG, JPEG, WebP, ...), any shape, at least 128 px wide and 128 px high.
2. **Look at the grid** (panel 02): pick a zoom level, or scroll on the viewport, to see how that level is cut. Click a
   cell to view that tile at full size (arrow keys move to the next tile, Escape closes it).
3. **Choose the output** (panel 03): see [Options](#options).
4. **Cut** (panel 04): the panel shows the progress per zoom level, tiles per second, the time left and the blank
   tiles skipped. "Abort cut" stops the cut at once and nothing is downloaded. The archive is saved as
   `<image name>.zip`.

## Options

Panel 03 has four options. They are remembered in this browser (localStorage) for your next visit; where the browser
cannot store them (a private window, blocked site data) they still apply while the page is open.

| Option | Choices (default first) | What it does |
|---|---|---|
| Format | **PNG**, WebP | The tile encoding. Both keep transparency and are lossless (WebP is encoded at quality 1.0, which browsers write losslessly); WebP archives are smaller. |
| Downscale | **Pixel**, Smooth | How the levels below the maximum zoom are made. Pixel samples the source nearest-neighbour (no smoothing), which keeps pixel art sharp. Smooth builds each level from the one above with an exact 2×2 box average weighted by alpha (premultiplied, integer math), for painted, photographic and 3D maps. The maximum zoom is the same in both. |
| Tile size | **Auto**, 256 | Auto: the image is padded to a square of its longest side (plus one pixel when that is odd), and that side is halved while it is even and at least 256 px. The number of halvings is the maximum zoom and the side left is the tile size: 1024 px gives z3 with 128 px tiles, 1632 px z3 with 204 px tiles. 256: tiles of exactly 256 px; the image is padded to the smallest 256·2ⁿ square that holds it, and n is the maximum zoom (1200×800 px is padded to 2048 px, z0 to z3). |
| Blank tiles | **Skip**, Keep | Skip leaves out every tile whose pixels are all fully transparent (alpha 0), such as tiles of padding only; Keep writes every tile. |

The image always sits at the top left of its padded square, and the pad (right and below) is transparent. The
viewport shows the pad hatched.

## The archive

```
<image name>.zip
├── 0/0/0.png              {z}/{y}/{x}: zoom / row (from the top) / column (from the left)
├── 1/0/0.png
├── 1/0/1.png
├── 1/1/0.png
├── 1/1/1.png
├── 2/...
├── preview.webp           the whole image, at most 1024 px on its longest side
└── tiles.json             the manifest
```

- **Layout:** `{z}/{y}/{x}.<format>`, the XYZ scheme Leaflet uses: zoom 0 is one tile, zoom z a grid of 2ᶻ × 2ᶻ
  tiles, x counted from the left and y from the top (not TMS). At the maximum zoom one tile pixel is one source pixel.
- **Order:** the tiles from the maximum zoom down to zoom 0, column by column, then `preview.webp` and `tiles.json`.
  Every entry is stored uncompressed (the tiles are compressed already). With Skip, a missing tile is a blank one.
- **`preview.webp`:** the image without the pad, as a lossless WebP. It is a level of the pyramid (made with the cut's
  downscale mode), so it lines up with the tiles: one preview pixel is `scale` source pixels, a power of two. Its
  longest side is at most 1024 px (between 513 and 1024 px for larger images).

### `tiles.json`

An example: a 1200×800 px image cut to WebP at tile size 256, smooth, with blank tiles skipped (`levels` shortened to
zoom 0 and 3, `sha256` shortened):

```json
{
  "format_version": 1,
  "generator": "leafletmapdivider",
  "created_at": "2026-11-19T12:00:00.000Z",
  "source": { "name": "map.png", "width": 1200, "height": 800, "sha256": "3f9a…" },
  "padded_size": 2048,
  "tile_size_mode": "256",
  "tile_size": 256,
  "min_zoom": 0,
  "max_zoom": 3,
  "format": "webp",
  "layout": "z/y/x",
  "y_origin": "top",
  "path_template": "{z}/{y}/{x}.webp",
  "downscale": "smooth",
  "skip_blank": true,
  "tiles": { "total": 85, "written": 28, "skipped": 57 },
  "levels": [
    { "zoom": 0, "tiles_per_side": 1, "source_tile_size": 2048, "content_columns": 1, "content_rows": 1, "written": 1, "skipped": 0 },
    { "zoom": 3, "tiles_per_side": 8, "source_tile_size": 256, "content_columns": 5, "content_rows": 4, "written": 19, "skipped": 45 }
  ],
  "preview": { "path": "preview.webp", "zoom": 2, "extra_halvings": 0, "scale": 2, "width": 600, "height": 400 }
}
```

| Field | Meaning |
|---|---|
| `format_version` | 1. Raised when a field changes meaning or is removed; added fields keep the version. |
| `generator`, `created_at` | `"leafletmapdivider"`, and when the cut finished (ISO 8601, UTC). |
| `source` | The image's file name, its size in px and the sha256 of the file's bytes (lowercase hex). |
| `padded_size` | The side of the square the image is padded to (image at the top left). |
| `tile_size_mode`, `tile_size` | The Tile size option (`"auto"` or `"256"`) and the side of every tile in px. |
| `min_zoom`, `max_zoom` | 0, and the highest zoom level. |
| `format` | `"png"` or `"webp"`. |
| `layout`, `y_origin`, `path_template` | `"z/y/x"`, `"top"` and `"{z}/{y}/{x}.<format>"`, as above. |
| `downscale`, `skip_blank` | The Downscale (`"pixel"` or `"smooth"`) and Blank tiles (`true` = Skip) options. |
| `tiles` | The tiles of the pyramid (`total`), in the archive (`written`) and left out as blank (`skipped`). |
| `levels` | One entry per zoom, indexed by zoom: tiles per side, the source px one tile covers, the tile columns and rows that hold image pixels (counted from the left and the top; the others hold only pad), and the tiles written and skipped. |
| `preview` | The preview's path, the zoom it was taken from, the halvings after that (only when zoom 0 is larger than 1024 px), `scale` (source px per preview px) and its size. |

`written` always equals the archive's tile entries, in all and per zoom, and `written + skipped` is each level's tile
count.

## Using the tiles in Leaflet

Unzip the archive where your page can load it, then:

```javascript
import L from "leaflet";

const base = "/tiles";
const manifest = await (await fetch(`${base}/tiles.json`)).json();
const { max_zoom, tile_size, path_template } = manifest;

const map = L.map("map", { crs: L.CRS.Simple, minZoom: 0, maxZoom: max_zoom });

// the image without its pad; at max_zoom one map pixel is one source pixel
const bounds = L.latLngBounds(
  map.unproject([0, 0], max_zoom),
  map.unproject([manifest.source.width, manifest.source.height], max_zoom)
);

L.tileLayer(`${base}/${path_template}`, {
  tileSize: tile_size,
  minZoom: 0,
  maxZoom: max_zoom,
  maxNativeZoom: max_zoom,
  noWrap: true,
  bounds,
  // skipped blank tiles are missing files: draw a transparent pixel there
  errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
}).addTo(map);

map.fitBounds(bounds);
```

To zoom in past the source's pixels, raise `maxZoom` and keep `maxNativeZoom` at `max_zoom`.

## Notes

- The archive's source hash uses Web Crypto, which browsers only offer to secure pages: open the tool over https (as
  on leafletmapdivider.com) or from `localhost`.
- Very large images are limited by the browser's canvas size and memory (a 16384 px square is a 1 GiB canvas).
- Browsers keep canvas pixels premultiplied, so partly transparent pixels can come out a step or two off in colour.
  Fully opaque and fully transparent pixels are exact.

## Development

```
pnpm install
pnpm dev                    # the site on http://localhost:3000
pnpm lint                   # eslint src
pnpm exec tsc --noEmit -p .
pnpm test                   # vitest
pnpm fixtures [N | WxH]...  # test pattern PNGs in test/fixtures/generated/ (default 1024 and 1632)
```

The tiling rules are pure modules in `src/services/` (`tile_plan.ts`, `downscale.ts`, `blank_tile.ts`, `preview.ts`,
`tiles_manifest.ts`); `tile_generator.ts` runs them on canvases in the browser. `src/utils/cut_options.ts` remembers
the options.
