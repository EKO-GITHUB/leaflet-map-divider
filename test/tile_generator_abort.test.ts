import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate_tiles, MAX_PENDING_ENCODES } from "@/services/tile_generator";
import { plan_tiles, TilePlan } from "@/services/tile_plan";

// a 1x1 transparent PNG, the fake canvas's every tile
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// preview.webp is encoded once, after the last tile
const PREVIEW_ENCODES = 1;

// the cut yields to the browser after every 10th tile that reaches the zip
const PROGRESS_BATCH_SIZE = 10;

interface FakeCanvasLog {
  encoded_tiles: number;
  // called when a tile's encode starts, so a test can abort mid-cut
  on_encode?: (count: number) => void;
}

function fake_canvas(log: FakeCanvasLog) {
  // every level below the top is read back from the level canvas and halved in memory, then put on the tile canvas
  const image_data = (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
  const ctx = {
    imageSmoothingEnabled: true,
    drawImage: () => {},
    clearRect: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => image_data(width, height),
    createImageData: image_data,
    putImageData: () => {}
  };
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toBlob: (callback: (blob: Blob | null) => void, type?: string) => {
      log.encoded_tiles++;
      log.on_encode?.(log.encoded_tiles);
      setTimeout(() => callback(new Blob([TILE_PNG], { type })), 0);
    }
  };
}

// a MessageChannel whose messages never arrive: the cut's yield to the browser never ends on its own
class StuckMessageChannel {
  port1 = { onmessage: null as unknown, close: () => {} };
  port2 = { postMessage: () => {} };
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
    source_file: new Blob(["fake source image"]),
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
    const tiles = Object.values(zip.files).filter(entry => /^\d+\/\d+\/\d+\.png$/.test(entry.name));

    expect(log.encoded_tiles).toBe(85 + PREVIEW_ENCODES);
    expect(tiles).toHaveLength(85);
    expect(zip_spy).toHaveBeenCalledTimes(1);
    expect(on_error).not.toHaveBeenCalled();
  });

  it("still works without a signal", async () => {
    const blob = await cut(1024).promise;
    expect(blob.size).toBeGreaterThan(0);
    expect(log.encoded_tiles).toBe(85 + PREVIEW_ENCODES);
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

  it("ends a wait for the browser at once when aborted during it", async () => {
    const zip_spy = vi.spyOn(JSZip.prototype, "generateInternalStream");
    const controller = new AbortController();
    // the cut yields after every 10th tile in the zip; this yield never ends
    vi.stubGlobal("MessageChannel", StuckMessageChannel);
    const { promise } = cut(1024, controller.signal);
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    // stuck after the 10th tile reached the zip, with the encodes after it already started
    expect(log.encoded_tiles).toBe(PROGRESS_BATCH_SIZE + MAX_PENDING_ENCODES - 1);
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
    expect(log.encoded_tiles).toBe(85 + PREVIEW_ENCODES);
    expect(pause_spy).toHaveBeenCalledTimes(1);
  });
});
