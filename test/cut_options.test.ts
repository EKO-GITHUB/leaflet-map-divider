import { describe, expect, it, vi } from "vitest";
import {
  create_cut_options_store,
  CUT_OPTIONS_STORAGE_KEY,
  CutOptions,
  DEFAULT_CUT_OPTIONS,
  OptionsStorage,
  parse_cut_options,
  serialize_cut_options
} from "@/utils/cut_options";
import { DEFAULT_DOWNSCALE_MODE } from "@/services/downscale";
import { DEFAULT_SKIP_BLANK } from "@/services/blank_tile";
import { DEFAULT_TILE_SIZE_MODE } from "@/services/tile_plan";

function memory_storage(initial: Record<string, string> = {}): OptionsStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    }
  };
}

const CHANGED: CutOptions = { format: "webp", downscale: "smooth", tile_size: "256", skip_blank: false };

describe("parse_cut_options", () => {
  it("gives the defaults when nothing is stored", () => {
    expect(parse_cut_options(null)).toEqual({
      format: "png",
      downscale: DEFAULT_DOWNSCALE_MODE,
      tile_size: DEFAULT_TILE_SIZE_MODE,
      skip_blank: DEFAULT_SKIP_BLANK
    });
    expect(DEFAULT_CUT_OPTIONS).toEqual({ format: "png", downscale: "pixel", tile_size: "auto", skip_blank: true });
  });

  it("reads back what serialize_cut_options wrote, for every combination", () => {
    for (const format of ["png", "webp"] as const) {
      for (const downscale of ["pixel", "smooth"] as const) {
        for (const tile_size of ["auto", "256"] as const) {
          for (const skip_blank of [true, false]) {
            const options = { format, downscale, tile_size, skip_blank };
            expect(parse_cut_options(serialize_cut_options(options))).toEqual(options);
          }
        }
      }
    }
  });

  it("serializes only the four options", () => {
    const extra = { ...CHANGED, other: 1 } as CutOptions;
    expect(JSON.parse(serialize_cut_options(extra))).toEqual(CHANGED);
  });

  it("falls back to the defaults for text that is not an options object", () => {
    for (const raw of ["", "not json", "{", "null", "42", '"webp"', "[]", '["webp"]', "true"]) {
      expect(parse_cut_options(raw)).toEqual(DEFAULT_CUT_OPTIONS);
    }
  });

  it("falls back field by field for unknown or missing values", () => {
    expect(parse_cut_options('{"format":"webp"}')).toEqual({ ...DEFAULT_CUT_OPTIONS, format: "webp" });
    expect(parse_cut_options('{"format":"jpeg","downscale":"smooth"}')).toEqual({
      ...DEFAULT_CUT_OPTIONS,
      downscale: "smooth"
    });
    expect(parse_cut_options('{"tile_size":256,"skip_blank":"false"}')).toEqual(DEFAULT_CUT_OPTIONS);
    expect(parse_cut_options('{"tile_size":"512","skip_blank":false}')).toEqual({
      ...DEFAULT_CUT_OPTIONS,
      skip_blank: false
    });
    expect(parse_cut_options('{"format":"WEBP","downscale":"Smooth"}')).toEqual(DEFAULT_CUT_OPTIONS);
  });
});

describe("create_cut_options_store", () => {
  it("reads the stored options once and keeps one snapshot object until they change", () => {
    const storage = memory_storage({ [CUT_OPTIONS_STORAGE_KEY]: serialize_cut_options(CHANGED) });
    const get_item = vi.spyOn(storage, "getItem");
    const store = create_cut_options_store(() => storage);
    const first = store.get_snapshot();
    expect(first).toEqual(CHANGED);
    expect(store.get_snapshot()).toBe(first);
    expect(get_item).toHaveBeenCalledTimes(1);
  });

  it("uses the defaults for the server snapshot, whatever is stored", () => {
    const storage = memory_storage({ [CUT_OPTIONS_STORAGE_KEY]: serialize_cut_options(CHANGED) });
    const store = create_cut_options_store(() => storage);
    expect(store.get_server_snapshot()).toBe(DEFAULT_CUT_OPTIONS);
    store.update({ format: "png" });
    expect(store.get_server_snapshot()).toBe(DEFAULT_CUT_OPTIONS);
  });

  it("stores each change, notifies the listeners and gives a new snapshot", () => {
    const storage = memory_storage();
    const store = create_cut_options_store(() => storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.get_snapshot();
    expect(before).toEqual(DEFAULT_CUT_OPTIONS);

    store.update({ downscale: "smooth" });
    const after = store.get_snapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual({ ...DEFAULT_CUT_OPTIONS, downscale: "smooth" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(parse_cut_options(storage.items.get(CUT_OPTIONS_STORAGE_KEY) ?? null)).toEqual(after);

    store.update({ format: "webp", tile_size: "256", skip_blank: false });
    expect(store.get_snapshot()).toEqual(CHANGED);
    expect(listener).toHaveBeenCalledTimes(2);

    // a new page over the same storage starts from the stored options
    expect(create_cut_options_store(() => storage).get_snapshot()).toEqual(CHANGED);

    unsubscribe();
    store.update({ format: "png" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get_snapshot().format).toBe("png");
  });

  it("changes nothing for an update that keeps every option", () => {
    const storage = memory_storage();
    const set_item = vi.spyOn(storage, "setItem");
    const store = create_cut_options_store(() => storage);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.get_snapshot();
    store.update({ format: before.format, skip_blank: before.skip_blank });
    store.update({});
    expect(store.get_snapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(set_item).not.toHaveBeenCalled();
  });

  it("works without storage: blocked, missing, or failing on read and write", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    const failing: OptionsStorage = {
      getItem: () => {
        throw new Error("read failed");
      },
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
    };
    for (const get_storage of [blocked, () => null, () => undefined, () => failing]) {
      const store = create_cut_options_store(get_storage);
      const listener = vi.fn();
      store.subscribe(listener);
      expect(store.get_snapshot()).toEqual(DEFAULT_CUT_OPTIONS);
      expect(() => store.update({ format: "webp", downscale: "smooth" })).not.toThrow();
      // the page keeps the choice even though nothing was stored
      expect(store.get_snapshot()).toEqual({ ...DEFAULT_CUT_OPTIONS, format: "webp", downscale: "smooth" });
      expect(listener).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores a stored value it cannot read", () => {
    const storage = memory_storage({ [CUT_OPTIONS_STORAGE_KEY]: "{broken" });
    const store = create_cut_options_store(() => storage);
    expect(store.get_snapshot()).toEqual(DEFAULT_CUT_OPTIONS);
    store.update({ skip_blank: false });
    expect(storage.items.get(CUT_OPTIONS_STORAGE_KEY)).toBe(
      serialize_cut_options({ ...DEFAULT_CUT_OPTIONS, skip_blank: false })
    );
  });
});
