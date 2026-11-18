import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate_tiles } from "@/services/tile_generator";
import { plan_tiles, TilePlan } from "@/services/tile_plan";

// a 1x1 transparent PNG, the fake canvas's every tile
const TILE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface FakeCanvasLog {
  encoded_tiles: number;
  // called after each encoded tile, so a test can abort mid-cut
  on_encode?: (count: number) => void;
}

function fake_canvas(log: FakeCanvasLog) {
  const ctx = { imageSmoothingEnabled: true, drawImage: () => {}, clearRect: () => {} };
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => {
      log.encoded_tiles++;
      log.on_encode?.(log.encoded_tiles);
      return TILE_DATA_URL;
    }
  };
}

function valid_plan(size: number): TilePlan {
  const result = plan_tiles(size, size);
  if (!result.is_valid) throw new Error(result.error);
  return result.plan;
}

function fake_image(size: number) {
  return { naturalWidth: size, naturalHeight: size } as HTMLImageElement;
}

let log: FakeCanvasLog;

beforeEach(() => {
  log = { encoded_tiles: 0 };
  vi.stubGlobal("document", { createElement: () => fake_canvas(log) });
  // frames come from a timer, as in a page; cancelling one is a clearTimeout
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cut(size: number, signal?: AbortSignal) {
  const on_error = vi.fn();
  const on_progress = vi.fn();
  const promise = generate_tiles({
    image: fake_image(size),
    plan: valid_plan(size),
    output_format: "png",
    file_name: `pattern-${size}.png`,
    signal,
    on_error,
    on_progress
  });
  return { promise, on_error, on_progress };
}

describe("generate_tiles with an AbortSignal", () => {
  it("cuts every tile and builds the zip when it is not aborted", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const { promise, on_error } = cut(1024, new AbortController().signal);

    const blob = await promise;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const tiles = Object.values(zip.files).filter(entry => !entry.dir);

    expect(log.encoded_tiles).toBe(85);
    expect(tiles).toHaveLength(85);
    expect(zip_spy).toHaveBeenCalledTimes(1);
    expect(on_error).not.toHaveBeenCalled();
  });

  it("still works without a signal", async () => {
    const blob = await cut(1024).promise;
    expect(blob.size).toBeGreaterThan(0);
    expect(log.encoded_tiles).toBe(85);
  });

  it("stops after the tile it was aborted on and rejects with no zip", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const controller = new AbortController();
    log.on_encode = count => {
      if (count === 5) controller.abort();
    };
    const { promise, on_error, on_progress } = cut(1024, controller.signal);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(log.encoded_tiles).toBe(5);
    expect(zip_spy).not.toHaveBeenCalled();
    expect(on_error).not.toHaveBeenCalled();
    expect(on_progress.mock.calls.some(([progress]) => progress.current_stage === "complete")).toBe(false);

    // the loop really ended: nothing more is encoded after the rejection
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(log.encoded_tiles).toBe(5);
  });

  it("ends a frame wait at once when aborted during it", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const controller = new AbortController();
    // the cut waits for a frame after every 10th tile; this frame never comes
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    log.on_encode = count => {
      if (count === 10) setTimeout(() => controller.abort(), 5);
    };

    await expect(cut(1024, controller.signal).promise).rejects.toMatchObject({ name: "AbortError" });
    expect(log.encoded_tiles).toBe(10);
    expect(zip_spy).not.toHaveBeenCalled();
  });

  it("rejects before any tile when the signal is already aborted", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const controller = new AbortController();
    controller.abort();
    const { promise, on_progress } = cut(1024, controller.signal);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(log.encoded_tiles).toBe(0);
    expect(on_progress).not.toHaveBeenCalled();
    expect(zip_spy).not.toHaveBeenCalled();
  });

  it("rejects with the abort reason and pauses the zip stream when aborted while zipping", async () => {
    const controller = new AbortController();
    const original = JSZip.prototype.generateInternalStream;
    let pause_spy: ReturnType<typeof vi.fn> | undefined;
    vi.spyOn(JSZip.prototype, "generateInternalStream").mockImplementation(function (this: JSZip, options) {
      const stream = original.call(this, options);
      pause_spy = vi.spyOn(stream, "pause");
      controller.abort(new Error("stopped while zipping"));
      return stream;
    });

    await expect(cut(1024, controller.signal).promise).rejects.toThrow("stopped while zipping");
    expect(log.encoded_tiles).toBe(85);
    expect(pause_spy).toHaveBeenCalledTimes(1);
  });
});
