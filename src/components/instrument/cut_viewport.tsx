"use client";

import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { MapImage, TileGenerationProgress } from "@/types/types";
import type { TilePlan } from "@/services/tile_plan";

const VIEWPORT_BG = "#070a0f";
const PAD_HATCH = "rgba(150,190,230,0.2)";

// the pad of the padded square (right of and below the image), hatched; content_* are the image's share of the side
function PadHatch({ content_width, content_height }: { content_width: number; content_height: number }) {
  if (content_width >= 1 && content_height >= 1) return null;
  const w = `${content_width * 100}%`;
  const h = `${content_height * 100}%`;
  return (
    <div
      data-pad-hatch=""
      className="pointer-events-none absolute inset-0"
      style={{
        clipPath: `polygon(${w} 0, 100% 0, 100% 100%, 0 100%, 0 ${h}, ${w} ${h})`,
        backgroundColor: "rgba(7,10,15,0.88)",
        backgroundImage: `repeating-linear-gradient(135deg, ${PAD_HATCH} 0 1px, transparent 1px 9px)`
      }}
    />
  );
}

// hatches the pad part of an inspected tile drawn on a size x size canvas; right and bottom are where the image ends,
// in canvas px from the tile's top left
function paint_pad(ctx: CanvasRenderingContext2D, size: number, right: number, bottom: number) {
  if (right >= size && bottom >= size) return;
  const content_right = Math.min(Math.max(right, 0), size);
  const content_bottom = Math.min(Math.max(bottom, 0), size);
  const step = Math.max(6, Math.round(size / 48));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  if (content_right > 0 && content_bottom > 0) ctx.rect(0, 0, content_right, content_bottom);
  ctx.clip("evenodd");
  ctx.fillStyle = VIEWPORT_BG;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = PAD_HATCH;
  ctx.lineWidth = Math.max(1, step / 9);
  ctx.beginPath();
  // rising lines, as the CSS hatch of the grid view
  for (let d = -size; d < size; d += step) {
    ctx.moveTo(d, size);
    ctx.lineTo(d + size, 0);
  }
  ctx.stroke();
  ctx.restore();
}

function CutGrid({ n, filled, hover }: {
  n: number;
  filled: number;
  hover: { x: number; y: number } | null;
}) {
  const make_lines = (prefix: string) => {
    const lines = [];
    for (let i = 1; i < n; i++) {
      lines.push(
        <line key={`${prefix}v${i}`} x1={i} y1={0} x2={i} y2={n} vectorEffect="non-scaling-stroke" />,
        <line key={`${prefix}h${i}`} x1={0} y1={i} x2={n} y2={i} vectorEffect="non-scaling-stroke" />
      );
    }
    return lines;
  };

  const full_columns = Math.floor(filled / n);
  const remainder = filled - full_columns * n;

  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {full_columns > 0 && (
        <rect x={0} y={0} width={full_columns} height={n} fill="#3dffa0" opacity={0.22} />
      )}
      {remainder > 0 && (
        <rect x={full_columns} y={0} width={1} height={remainder} fill="#3dffa0" opacity={0.22} />
      )}
      <g stroke="rgba(0,12,6,0.6)" strokeWidth={3}>
        {make_lines("halo-")}
      </g>
      <g stroke="rgba(140,255,190,0.85)" strokeWidth={1.2}>
        {make_lines("line-")}
      </g>
      <rect
        x={0} y={0} width={n} height={n}
        fill="none" stroke="rgba(140,255,190,0.9)" strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
      {hover && (
        <rect
          x={hover.x} y={hover.y} width={1} height={1}
          fill="rgba(61,255,160,0.14)" stroke="#3dffa0" strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function Readout({ className, children }: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`data pointer-events-none absolute z-10 border border-[var(--c-line)] bg-[#0c1219]/90 px-3 py-1.5 text-[11px] tracking-[0.14em] text-[var(--c-dim)] ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

export function CutViewport({
                              image,
                              plan,
                              upload_error,
                              is_uploading,
                              on_files,
                              input_ref,
                              zoom,
                              on_zoom_change,
                              is_generating,
                              progress
                            }: {
  image: MapImage | null;
  // the image's tiling plan (null without an image): the viewport frame is its padded square
  plan: TilePlan | null;
  upload_error: string | null;
  is_uploading: boolean;
  on_files: (files: FileList | null) => void;
  input_ref: React.RefObject<HTMLInputElement | null>;
  zoom: number;
  on_zoom_change: (zoom: number) => void;
  is_generating: boolean;
  progress: TileGenerationProgress;
}) {
  const [is_dragging, set_is_dragging] = useState(false);
  const [hover_cell, set_hover_cell] = useState<{ x: number; y: number } | null>(null);
  const [inspected_cell, set_inspected_cell] = useState<{ x: number; y: number } | null>(null);
  const [is_expanded, set_is_expanded] = useState(false);
  const section_ref = useRef<HTMLElement>(null);
  const frame_ref = useRef<HTMLDivElement>(null);
  const canvas_ref = useRef<HTMLCanvasElement>(null);
  const close_timer = useRef<number | null>(null);
  const was_open = useRef(false);
  const proxy_ref = useRef<{ canvas: HTMLCanvasElement; is_full_res: boolean } | null>(null);
  const draw_token = useRef(0);
  const blob_promise_ref = useRef<Promise<Blob> | null>(null);

  const displayed_zoom = is_generating ? progress.current_zoom_level : zoom;
  const n = Math.pow(2, displayed_zoom);
  const padded_size = plan?.padded_size ?? 0;
  const tile_px = Math.round(padded_size / n);
  const zoom_row = progress.zoom_levels_progress.find(z => z.zoom_level === displayed_zoom);
  const filled = is_generating && zoom_row ? zoom_row.processed_tiles_in_level : 0;

  // a new zoom, image or run closes the inspected tile (state adjusted while rendering, the timer in an effect)
  const [view_key, set_view_key] = useState({ zoom, image, is_generating });
  if (view_key.zoom !== zoom || view_key.image !== image || view_key.is_generating !== is_generating) {
    set_view_key({ zoom, image, is_generating });
    set_inspected_cell(null);
    set_is_expanded(false);
  }

  useEffect(() => {
    if (close_timer.current !== null) {
      window.clearTimeout(close_timer.current);
      close_timer.current = null;
    }
  }, [zoom, image, is_generating]);

  useEffect(() => {
    blob_promise_ref.current = null;
  }, [image]);

  useEffect(() => {
    return () => {
      if (close_timer.current !== null) {
        window.clearTimeout(close_timer.current);
      }
    };
  }, []);

  // decode the source once into a small proxy of the padded square (the image at its top left, the pad transparent),
  // off the interaction path, so opening a tile never has to re-decode the full-resolution image
  useEffect(() => {
    proxy_ref.current = null;
    if (!image || !padded_size) return;
    let cancelled = false;

    const build = async () => {
      const size = Math.min(2048, padded_size);
      const ratio = size / padded_size;
      const width = Math.max(1, Math.round(image.width * ratio));
      const height = Math.max(1, Math.round(image.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        const bitmap = await createImageBitmap(image.element, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: "high"
        });
        if (cancelled) {
          bitmap.close();
          return;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        ctx.drawImage(image.element, 0, 0, width, height);
      }
      if (!cancelled) {
        proxy_ref.current = { canvas, is_full_res: size === padded_size };
      }
    };

    build();
    return () => {
      cancelled = true;
    };
  }, [image, padded_size]);

  // draw the inspected tile into the overlay canvas: instantly from the proxy,
  // then refined from the full-resolution source decoded off the main thread.
  // The canvas is opaque and painted with the app background first so tiles
  // with transparency show the viewport ground, not the image underneath.
  useEffect(() => {
    if (!inspected_cell || !image || !padded_size) return;
    const canvas = canvas_ref.current;
    const frame = frame_ref.current;
    if (!canvas || !frame) return;

    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(1, Math.round(frame.clientWidth * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    const token = ++draw_token.current;

    // where the image ends inside the tile, in canvas px from its top left (the rest of the tile is pad)
    const full_tile = padded_size / n;
    const image_right = ((image.width - inspected_cell.x * full_tile) / full_tile) * size;
    const image_bottom = ((image.height - inspected_cell.y * full_tile) / full_tile) * size;
    const holds_image = image_right > 0 && image_bottom > 0;

    const paint = (source: CanvasImageSource, source_size: number) => {
      const src_tile = source_size / n;
      ctx.fillStyle = VIEWPORT_BG;
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(
        source,
        Math.round(inspected_cell.x * src_tile),
        Math.round(inspected_cell.y * src_tile),
        Math.round(src_tile),
        Math.round(src_tile),
        0,
        0,
        size,
        size
      );
      paint_pad(ctx, size, image_right, image_bottom);
    };

    const proxy = proxy_ref.current;
    if (proxy) {
      paint(proxy.canvas, proxy.canvas.width);
      if (proxy.is_full_res) return;
    } else {
      ctx.fillStyle = VIEWPORT_BG;
      ctx.fillRect(0, 0, size, size);
      paint_pad(ctx, size, image_right, image_bottom);
    }
    // a tile of the pad alone has nothing to refine
    if (!holds_image) return;

    // refine from the original source, decoded off the main thread: blob
    // sources decode on background threads (element sources decode on the
    // main thread and stall the animation), and crop+resize at decode time
    // keeps the resulting bitmap viewport-sized instead of full-resolution
    if (!blob_promise_ref.current) {
      blob_promise_ref.current = fetch(image.src).then((response) => response.blob());
    }
    // the crop is a tile of the padded square: the part past the image's edge comes back transparent
    const crop = [
      Math.round(inspected_cell.x * full_tile),
      Math.round(inspected_cell.y * full_tile),
      Math.round(full_tile),
      Math.round(full_tile)
    ] as const;

    blob_promise_ref.current
      .then((blob) =>
        createImageBitmap(blob, ...crop, {
          resizeWidth: size,
          resizeHeight: size,
          resizeQuality: full_tile >= size ? "high" : "pixelated"
        }).catch(() => createImageBitmap(blob, ...crop))
      )
      .then((bitmap) => {
        if (draw_token.current === token && canvas_ref.current) {
          ctx.fillStyle = VIEWPORT_BG;
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(bitmap, 0, 0, size, size);
          paint_pad(ctx, size, image_right, image_bottom);
        }
        bitmap.close();
      })
      .catch(() => {});
  }, [inspected_cell, image, n, padded_size]);

  // expand on the frame after the collapsed canvas is committed, so the transition runs
  useEffect(() => {
    if (inspected_cell && !was_open.current) {
      was_open.current = true;
      const id = requestAnimationFrame(() => set_is_expanded(true));
      return () => cancelAnimationFrame(id);
    }
    if (!inspected_cell) {
      was_open.current = false;
    }
  }, [inspected_cell]);

  const close_tile = () => {
    if (close_timer.current !== null) return;
    set_is_expanded(false);
    close_timer.current = window.setTimeout(() => {
      set_inspected_cell(null);
      close_timer.current = null;
    }, 380);
  };

  const move_inspected = (dx: number, dy: number) => {
    if (close_timer.current !== null) return;
    set_inspected_cell((cell) => {
      if (!cell) return cell;
      const x = cell.x + dx;
      const y = cell.y + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) return cell;
      return { x, y };
    });
  };

  // an effect event reads the latest handlers, so the listener is only re-added when a tile opens or closes
  const on_inspect_key = useEffectEvent((e: KeyboardEvent) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    };
    if (moves[e.key]) {
      e.preventDefault();
      move_inspected(...moves[e.key]);
    } else if (e.key === "Escape") {
      close_tile();
    }
  });

  const is_inspecting = inspected_cell !== null;

  useEffect(() => {
    if (!is_inspecting || is_generating) return;

    const handle_key = (e: KeyboardEvent) => on_inspect_key(e);
    window.addEventListener("keydown", handle_key);
    return () => window.removeEventListener("keydown", handle_key);
  }, [is_inspecting, is_generating]);

  useEffect(() => {
    const section = section_ref.current;
    if (!section || !plan) return;

    const handle_wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (is_generating) return;
      const delta = e.deltaY > 0 ? -1 : 1;
      on_zoom_change(Math.min(Math.max(zoom + delta, 0), plan.max_zoom));
    };

    section.addEventListener("wheel", handle_wheel, { passive: false });
    return () => section.removeEventListener("wheel", handle_wheel);
  }, [plan, zoom, is_generating, on_zoom_change]);

  const handle_mouse_move = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!image || inspected_cell) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.floor(((e.clientX - rect.left) / rect.width) * n), n - 1);
    const y = Math.min(Math.floor(((e.clientY - rect.top) / rect.height) * n), n - 1);
    set_hover_cell({ x: Math.max(x, 0), y: Math.max(y, 0) });
  };

  const handle_cell_click = () => {
    if (is_generating) return;
    if (inspected_cell) {
      close_tile();
      return;
    }
    if (hover_cell && n > 1) {
      set_inspected_cell(hover_cell);
    }
  };

  const show_tile_view = !!inspected_cell && is_expanded;

  return (
    <section
      ref={section_ref}
      className="relative flex flex-1 items-center justify-center overflow-hidden p-6 lg:p-12"
      onDragOver={(e) => {
        e.preventDefault();
        set_is_dragging(true);
      }}
      onDragLeave={() => set_is_dragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        set_is_dragging(false);
        on_files(e.dataTransfer.files);
      }}
    >
      {/* graticule */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: [
            "linear-gradient(rgba(150,190,230,0.05) 1px, transparent 1px)",
            "linear-gradient(90deg, rgba(150,190,230,0.05) 1px, transparent 1px)",
            "linear-gradient(rgba(150,190,230,0.08) 1px, transparent 1px)",
            "linear-gradient(90deg, rgba(150,190,230,0.08) 1px, transparent 1px)"
          ].join(","),
          backgroundSize: "36px 36px, 36px 36px, 180px 180px, 180px 180px"
        }}
      />
      {/* vignette + scanlines */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.55) 100%)" }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent 0 2px, rgba(255,255,255,0.015) 2px 3px)"
        }}
      />

      <input
        ref={input_ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => on_files(e.target.files)}
      />

      {image && plan ? (
        <>
          <div
            ref={frame_ref}
            className={`relative z-10 aspect-square overflow-hidden border shadow-[0_0_80px_rgba(0,0,0,0.7)] transition-colors duration-300 ${
              show_tile_view ? "border-[var(--c-acc)]" : "border-transparent"
            }`}
            style={{
              width: "min(72vmin, 100%)",
              cursor: is_generating
                ? "default"
                : inspected_cell
                  ? "zoom-out"
                  : hover_cell && n > 1
                    ? "zoom-in"
                    : "default"
            }}
            onMouseMove={handle_mouse_move}
            onMouseLeave={() => set_hover_cell(null)}
            onClick={handle_cell_click}
          >
            {/* the frame is the padded square; the image sits at its top left, the pad is hatched */}
            <img
              src={image.src}
              alt={`Cut preview of ${image.file_name}`}
              className="absolute left-0 top-0 select-none object-fill"
              style={{ width: `${(image.width / padded_size) * 100}%`, height: `${(image.height / padded_size) * 100}%` }}
              draggable={false}
            />
            <PadHatch content_width={image.width / padded_size} content_height={image.height / padded_size} />
            <div
              className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${
                show_tile_view ? "opacity-0" : "opacity-100"
              }`}
            >
              <CutGrid n={n} filled={filled} hover={is_generating ? null : hover_cell} />
            </div>

            {inspected_cell && (
              <canvas
                ref={canvas_ref}
                className="absolute inset-0 z-10 h-full w-full"
                style={{
                  transform: is_expanded
                    ? "translate(0%, 0%) scale(1)"
                    : `translate(${(inspected_cell.x * 100) / n}%, ${(inspected_cell.y * 100) / n}%) scale(${1 / n})`,
                  transformOrigin: "0 0",
                  transition: "transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1)"
                }}
              />
            )}

            {show_tile_view && !is_generating && (
              <>
                {([
                  { dx: -1, dy: 0, glyph: "←", label: "Previous tile left", position: "left-2 top-1/2 -translate-y-1/2" },
                  { dx: 1, dy: 0, glyph: "→", label: "Next tile right", position: "right-2 top-1/2 -translate-y-1/2" },
                  { dx: 0, dy: -1, glyph: "↑", label: "Tile above", position: "top-2 left-1/2 -translate-x-1/2" },
                  { dx: 0, dy: 1, glyph: "↓", label: "Tile below", position: "bottom-2 left-1/2 -translate-x-1/2" }
                ] as const)
                  .filter(({ dx, dy }) => {
                    const x = inspected_cell.x + dx;
                    const y = inspected_cell.y + dy;
                    return x >= 0 && y >= 0 && x < n && y < n;
                  })
                  .map(({ dx, dy, glyph, label, position }) => (
                    <button
                      key={glyph}
                      aria-label={label}
                      onClick={(e) => {
                        e.stopPropagation();
                        move_inspected(dx, dy);
                      }}
                      className={`boot data absolute z-20 flex h-10 w-10 cursor-pointer items-center justify-center border border-[var(--c-line)] bg-[#0c1219]/85 text-base text-[var(--c-text)] transition-colors hover:border-[var(--c-acc)] hover:bg-[#0c1219] hover:text-[var(--c-acc)] ${position}`}
                      style={{ animationDelay: "150ms" }}
                    >
                      {glyph}
                    </button>
                  ))}
              </>
            )}
          </div>

          <Readout className="left-4 top-4 lg:left-6 lg:top-6">
            {is_generating ? (
              <span className="text-[var(--c-acc)]">
                CUTTING Z{displayed_zoom} · {progress.progress}%
              </span>
            ) : show_tile_view ? (
              <span className="text-[var(--c-acc)]">
                TILE Z{displayed_zoom} · X:{inspected_cell.x} Y:{inspected_cell.y}
              </span>
            ) : (
              <>
                <span className="text-[var(--c-acc)]">Z{displayed_zoom}</span>
                {" · "}{n}×{n} · {(n * n).toLocaleString()} TILES
              </>
            )}
          </Readout>
          <Readout className="right-4 top-4 lg:right-6 lg:top-6">
            TILE {tile_px}PX
          </Readout>
          <Readout className="bottom-4 left-4 lg:bottom-6 lg:left-6">
            {show_tile_view ? (
              <span className="text-[var(--c-text)]">CLICK TO EXIT · ARROWS TO MOVE</span>
            ) : hover_cell && !is_generating && !inspected_cell ? (
              <span className="text-[var(--c-text)]">
                X:{hover_cell.x} Y:{hover_cell.y}{n > 1 ? " · CLICK TO VIEW TILE" : ""}
              </span>
            ) : (
              "X:— Y:—"
            )}
          </Readout>
          <Readout className="bottom-4 right-4 max-w-[45%] truncate lg:bottom-6 lg:right-6">
            {image.file_name.toUpperCase()} · {image.width}×{image.height}
          </Readout>
        </>
      ) : (
        <button
          type="button"
          onClick={() => input_ref.current?.click()}
          disabled={is_uploading}
          className={`relative z-10 aspect-square border border-dashed transition-colors duration-300 ${
            is_dragging
              ? "border-[var(--c-acc)] bg-[#3dffa0]/5"
              : "border-[#3a4a5c] hover:border-[var(--c-dim)]"
          }`}
          style={{ width: "min(58vmin, 92%)" }}
        >
          <div className="absolute bottom-0 left-1/2 top-0 w-px bg-[var(--c-line)]" />
          <div className="absolute left-0 right-0 top-1/2 h-px bg-[var(--c-line)]" />
          {/* corner ticks */}
          <div className="absolute left-0 top-0 h-4 w-4 border-l-2 border-t-2 border-[var(--c-dim)]" />
          <div className="absolute right-0 top-0 h-4 w-4 border-r-2 border-t-2 border-[var(--c-dim)]" />
          <div className="absolute bottom-0 left-0 h-4 w-4 border-b-2 border-l-2 border-[var(--c-dim)]" />
          <div className="absolute bottom-0 right-0 h-4 w-4 border-b-2 border-r-2 border-[var(--c-dim)]" />

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--c-bg)] px-6 py-4 text-center">
            {is_uploading ? (
              <div className="blink text-base font-semibold tracking-[0.3em] text-[var(--c-acc)]">
                READING IMAGE…
              </div>
            ) : (
              <>
                <div className={`text-base font-semibold tracking-[0.3em] transition-colors sm:text-lg ${is_dragging ? "text-[var(--c-acc)]" : "text-[var(--c-text)]"}`}>
                  DROP MAP IMAGE
                </div>
                <div className="mt-3 text-[12px] leading-relaxed tracking-[0.12em] text-[var(--c-dim)]">
                  or click to browse
                  <br />
                  <span className="data text-[11px]">ANY SHAPE · ≥128PX EACH WAY</span>
                </div>
              </>
            )}
            {upload_error && (
              <div className="mt-4 max-w-[42ch] border border-[var(--c-red)]/40 bg-[#ff6f66]/5 px-3 py-2 text-[12px] leading-relaxed text-[var(--c-red)]">
                ⚠ {upload_error}
              </div>
            )}
          </div>
        </button>
      )}
    </section>
  );
}
