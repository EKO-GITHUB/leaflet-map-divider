"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useImageUpload } from "@/hooks/use_image_upload";
import { useTileGeneration } from "@/hooks/use_tile_generation";
import { useEta } from "@/hooks/use_eta";
import { CutViewport } from "./cut_viewport";

function total_tile_count(max_zoom_level: number) {
  return (Math.pow(4, max_zoom_level + 1) - 1) / 3;
}

function RailSection({ index, title, delay, children }: {
  index: string;
  title: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <section
      className="boot border-b border-[var(--c-line)] px-5 py-4"
      style={{ animationDelay: `${delay}ms` }}
    >
      <header className="mb-3 text-[11px] font-medium tracking-[0.22em] text-[var(--c-dim)]">
        {index} / {title}
      </header>
      {children}
    </section>
  );
}

function DataRow({ label, children }: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[13px]">
      <span className="shrink-0 text-[var(--c-dim)]">{label}</span>
      <span className="data truncate text-right text-[var(--c-text)]">{children}</span>
    </div>
  );
}

export function InstrumentApp() {
  const {
    selected_image,
    error: upload_error,
    is_loading: is_uploading,
    handle_image_upload,
    reset_image
  } = useImageUpload();

  const {
    is_generating,
    error: generation_error,
    progress,
    output_format,
    set_output_format,
    generate_tiles,
    cancel_generation,
    reset_error
  } = useTileGeneration();

  const input_ref = useRef<HTMLInputElement>(null);
  const [preview_zoom, set_preview_zoom] = useState(0);
  const [has_saved, set_has_saved] = useState(false);
  const eta = useEta(is_generating, progress.progress);

  useEffect(() => {
    set_preview_zoom(selected_image ? Math.min(1, selected_image.max_zoom_level) : 0);
  }, [selected_image]);

  useEffect(() => {
    if (progress.current_stage === "complete") {
      set_has_saved(true);
    }
  }, [progress.current_stage]);

  const handle_eject = () => {
    if (input_ref.current) {
      input_ref.current.value = "";
    }
    set_has_saved(false);
    reset_image();
  };

  const handle_generate = () => {
    if (!selected_image) return;
    set_has_saved(false);
    generate_tiles(selected_image);
  };

  const can_generate = !!selected_image && selected_image.max_zoom_level > 0;
  const total_tiles = selected_image ? total_tile_count(selected_image.max_zoom_level) : 0;
  const show_saved = has_saved && !is_generating && !generation_error;

  return (
    <div
      className="flex min-h-dvh flex-col bg-[var(--c-bg)] text-[var(--c-text)] antialiased"
      style={{
        "--c-bg": "#070a0f",
        "--c-panel": "#0c1219",
        "--c-line": "#223040",
        "--c-text": "#e4edf4",
        "--c-dim": "#96a9b9",
        "--c-acc": "#3dffa0",
        "--c-amber": "#ffb454",
        "--c-red": "#ff6f66",
        fontFamily: "var(--font-instrument), sans-serif"
      } as React.CSSProperties}
    >
      <style>{`
        .data { font-family: var(--font-plex-mono), monospace; }
        @media (prefers-reduced-motion: no-preference) {
          .boot {
            opacity: 0;
            animation: boot-in 0.55s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
          }
          @keyframes boot-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: none; }
          }
          .blink { animation: inst-blink 1.4s steps(2) infinite; }
          @keyframes inst-blink { 50% { opacity: 0.15; } }
        }
      `}</style>

      <div className="flex flex-1 flex-col lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col border-b border-[var(--c-line)] bg-[var(--c-panel)] lg:w-[330px] lg:border-b-0 lg:border-r">
          {/* wordmark */}
          <div className="boot border-b border-[var(--c-line)] px-5 py-5" style={{ animationDelay: "0ms" }}>
            <div className="flex items-center gap-2.5">
              <span className={`h-2 w-2 rounded-full ${is_generating ? "blink bg-[var(--c-amber)]" : "bg-[var(--c-acc)]"}`} />
              <span
                className="text-[14px] tracking-[0.26em] text-white"
                style={{ fontFamily: "var(--font-michroma), sans-serif" }}
              >
                MAP DIVIDER
              </span>
            </div>
            <div className="mt-2 text-[10px] tracking-[0.24em] text-[var(--c-dim)]">
              LEAFLET TILE CUTTING INSTRUMENT
            </div>
          </div>

          <RailSection index="01" title="SOURCE" delay={80}>
            {selected_image ? (
              <>
                <DataRow label="File">{selected_image.file_name}</DataRow>
                <DataRow label="Size">{selected_image.width} × {selected_image.height} px</DataRow>
                <DataRow label="Max zoom">
                  <span className="text-[var(--c-acc)]">z{selected_image.max_zoom_level}</span>
                </DataRow>
                <DataRow label="Tile at max">
                  {selected_image.width / Math.pow(2, selected_image.max_zoom_level)} px
                </DataRow>
                <button
                  onClick={handle_eject}
                  disabled={is_generating}
                  className="mt-3 w-full border border-[var(--c-line)] py-2 text-[11px] font-semibold tracking-[0.2em] text-[var(--c-dim)] transition-colors hover:border-[var(--c-red)] hover:text-[var(--c-red)] disabled:pointer-events-none disabled:opacity-30"
                >
                  ⏏ EJECT IMAGE
                </button>
              </>
            ) : (
              <>
                <div className="data text-[13px] text-[var(--c-dim)]">
                  Awaiting input<span className="blink">_</span>
                </div>
                <button
                  onClick={() => input_ref.current?.click()}
                  disabled={is_uploading}
                  className="mt-3 w-full border border-[var(--c-line)] py-2 text-[11px] font-semibold tracking-[0.2em] text-[var(--c-text)] transition-colors hover:border-[var(--c-acc)] hover:text-[var(--c-acc)] disabled:pointer-events-none disabled:opacity-30"
                >
                  BROWSE FILES
                </button>
              </>
            )}
          </RailSection>

          <RailSection index="02" title="CUT GRID" delay={160}>
            {selected_image ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: selected_image.max_zoom_level + 1 }, (_, z) => (
                    <button
                      key={z}
                      onClick={() => set_preview_zoom(z)}
                      disabled={is_generating}
                      className={`data border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${
                        z === preview_zoom
                          ? "border-[var(--c-acc)] bg-[var(--c-acc)] font-semibold text-black"
                          : "border-[var(--c-line)] text-[var(--c-dim)] hover:border-[var(--c-dim)] hover:text-[var(--c-text)]"
                      }`}
                    >
                      z{z}
                    </button>
                  ))}
                </div>
                <div className="mt-3 text-[12px] leading-relaxed text-[var(--c-dim)]">
                  {is_generating ? (
                    <span className="text-[var(--c-amber)]">Grid is tracking the cutter</span>
                  ) : (
                    <>
                      <span className="data text-[var(--c-text)]">
                        {Math.pow(2, preview_zoom)}×{Math.pow(2, preview_zoom)}
                      </span>{" "}
                      grid ·{" "}
                      <span className="data text-[var(--c-text)]">
                        {Math.pow(4, preview_zoom).toLocaleString()}
                      </span>{" "}
                      tiles of{" "}
                      <span className="data text-[var(--c-text)]">
                        {selected_image.width / Math.pow(2, preview_zoom)}px
                      </span>
                      <br />
                      Scroll on the viewport to change z · click a cell to
                      view that tile full-size
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="text-[13px] text-[var(--c-dim)]">No grid — load a source first</div>
            )}
          </RailSection>

          <RailSection index="03" title="OUTPUT" delay={240}>
            <div className="grid grid-cols-2 gap-1.5">
              {(["png", "webp"] as const).map((format) => (
                <button
                  key={format}
                  onClick={() => set_output_format(format)}
                  disabled={is_generating}
                  className={`border py-2 text-[12px] font-semibold tracking-[0.18em] transition-colors disabled:opacity-40 ${
                    output_format === format
                      ? "border-[var(--c-acc)] bg-[#3dffa0]/10 text-[var(--c-acc)]"
                      : "border-[var(--c-line)] text-[var(--c-dim)] hover:border-[var(--c-dim)] hover:text-[var(--c-text)]"
                  }`}
                >
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[12px] text-[var(--c-dim)]">
              {output_format === "png" ? "Lossless — larger archive" : "Compressed — smaller archive"}
            </div>
          </RailSection>

          <RailSection index="04" title="EXECUTE" delay={320}>
            {generation_error && (
              <div className="mb-3 border border-[var(--c-red)]/50 bg-[#ff6f66]/5 px-3 py-2 text-[12px] leading-relaxed text-[var(--c-red)]">
                ⚠ {generation_error}
                <button
                  onClick={reset_error}
                  className="mt-1.5 block text-[11px] font-semibold tracking-[0.2em] underline underline-offset-2 hover:text-white"
                >
                  DISMISS
                </button>
              </div>
            )}

            {is_generating ? (
              <>
                <div className="mb-1 flex justify-between text-[12px]">
                  <span className="font-medium text-[var(--c-amber)]">
                    {progress.current_stage === "preparing" ? "Preparing…" : `Cutting z${progress.current_zoom_level}`}
                  </span>
                  <span className="data text-[var(--c-text)]">{progress.progress}%</span>
                </div>
                <div className="h-1 w-full bg-[var(--c-line)]">
                  <div
                    className="h-full bg-[var(--c-acc)] transition-[width] duration-200"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
                <div className="data mt-2 flex justify-between text-[11px] text-[var(--c-dim)]">
                  <span>{progress.processed_tiles.toLocaleString()} / {progress.total_tiles.toLocaleString()}</span>
                  <span>
                    {progress.tiles_per_second ? `${progress.tiles_per_second} t/s` : ""}
                    {eta ? ` · ${eta}` : ""}
                  </span>
                </div>

                <div className="mt-3 space-y-1.5">
                  {progress.zoom_levels_progress.map((zoom_row) => (
                    <div key={zoom_row.zoom_level} className="data flex items-center gap-2 text-[11px]">
                      <span className={`w-7 shrink-0 ${zoom_row.zoom_level === progress.current_zoom_level ? "text-[var(--c-acc)]" : "text-[var(--c-dim)]"}`}>
                        z{zoom_row.zoom_level}
                      </span>
                      <div className="h-[3px] flex-1 bg-[var(--c-line)]">
                        <div
                          className={`h-full ${zoom_row.is_complete ? "bg-[var(--c-dim)]" : "bg-[var(--c-acc)]"}`}
                          style={{ width: `${zoom_row.progress_percentage}%` }}
                        />
                      </div>
                      <span className="w-9 shrink-0 text-right text-[var(--c-dim)]">
                        {zoom_row.progress_percentage}%
                      </span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={cancel_generation}
                  className="mt-4 w-full border border-[var(--c-red)]/60 py-2 text-[11px] font-semibold tracking-[0.25em] text-[var(--c-red)] transition-colors hover:bg-[#ff6f66]/10"
                >
                  ■ ABORT CUT
                </button>
              </>
            ) : (
              <>
                {show_saved && (
                  <div className="mb-3 border border-[var(--c-acc)]/50 bg-[#3dffa0]/5 px-3 py-2 text-[12px] font-medium text-[var(--c-acc)]">
                    ■ Archive saved to downloads
                  </div>
                )}
                <button
                  onClick={handle_generate}
                  disabled={!can_generate}
                  className="w-full border border-[var(--c-acc)] bg-[var(--c-acc)] py-3 text-[13px] font-bold tracking-[0.2em] text-black transition-colors hover:bg-[#8dffc4] disabled:border-[var(--c-line)] disabled:bg-transparent disabled:text-[var(--c-dim)] disabled:opacity-50"
                >
                  {selected_image
                    ? `CUT ${total_tiles.toLocaleString()} TILES → .ZIP`
                    : "CUT → .ZIP"}
                </button>
                {selected_image && !can_generate && (
                  <div className="mt-2 text-[12px] text-[var(--c-red)]">
                    Image too small to divide
                  </div>
                )}
              </>
            )}
          </RailSection>

          <div className="flex-1" />

          <div className="boot px-5 py-4 text-[10px] leading-relaxed tracking-[0.15em] text-[var(--c-dim)]" style={{ animationDelay: "400ms" }}>
            <div>100% LOCAL — YOUR MAP NEVER LEAVES THIS DEVICE</div>
            <div className="mt-2">
              <Link
                href="https://github.com/EKO-GITHUB"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-[var(--c-acc)]"
              >
                M.TOCHIEV / GITHUB ↗
              </Link>
            </div>
          </div>
        </aside>

        <CutViewport
          image={selected_image}
          upload_error={upload_error}
          is_uploading={is_uploading}
          on_files={handle_image_upload}
          input_ref={input_ref}
          zoom={preview_zoom}
          on_zoom_change={set_preview_zoom}
          is_generating={is_generating}
          progress={progress}
        />
      </div>
    </div>
  );
}
