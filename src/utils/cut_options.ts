import { OutputFormat } from "@/types/types";
import { DEFAULT_DOWNSCALE_MODE, DOWNSCALE_MODES, DownscaleMode } from "@/services/downscale";
import { DEFAULT_SKIP_BLANK } from "@/services/blank_tile";
import { DEFAULT_TILE_SIZE_MODE, TILE_SIZE_MODES, TileSizeMode } from "@/services/tile_plan";

// The cut options chosen in panel 03, remembered in this browser's localStorage. Storage is a convenience only: it can
// be missing, blocked or full (private windows, blocked site data), so every access is wrapped and the options still
// work for the open page when nothing can be stored. A stored value that is unknown (an older or newer version, a hand
// edit) falls back to that option's default, field by field.

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["png", "webp"];
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "png";

export interface CutOptions {
  format: OutputFormat;
  downscale: DownscaleMode;
  tile_size: TileSizeMode;
  skip_blank: boolean;
}

export const DEFAULT_CUT_OPTIONS: CutOptions = Object.freeze({
  format: DEFAULT_OUTPUT_FORMAT,
  downscale: DEFAULT_DOWNSCALE_MODE,
  tile_size: DEFAULT_TILE_SIZE_MODE,
  skip_blank: DEFAULT_SKIP_BLANK
});

export const CUT_OPTIONS_STORAGE_KEY = "leafletmapdivider.cut_options";

function pick<T>(choices: readonly T[], value: unknown, fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}

/** The options stored as `raw` (JSON); anything missing or unknown takes its default. */
export function parse_cut_options(raw: string | null): CutOptions {
  if (raw === null) return DEFAULT_CUT_OPTIONS;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return DEFAULT_CUT_OPTIONS;
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return DEFAULT_CUT_OPTIONS;
  const fields = stored as Record<string, unknown>;
  return {
    format: pick(OUTPUT_FORMATS, fields.format, DEFAULT_CUT_OPTIONS.format),
    downscale: pick(DOWNSCALE_MODES, fields.downscale, DEFAULT_CUT_OPTIONS.downscale),
    tile_size: pick(TILE_SIZE_MODES, fields.tile_size, DEFAULT_CUT_OPTIONS.tile_size),
    skip_blank: typeof fields.skip_blank === "boolean" ? fields.skip_blank : DEFAULT_CUT_OPTIONS.skip_blank
  };
}

export function serialize_cut_options(options: CutOptions): string {
  const { format, downscale, tile_size, skip_blank } = options;
  return JSON.stringify({ format, downscale, tile_size, skip_blank });
}

/** The part of the Web Storage API the store uses. */
export type OptionsStorage = Pick<Storage, "getItem" | "setItem">;

export interface CutOptionsStore {
  /** the current options (the same object until they change, as useSyncExternalStore needs) */
  get_snapshot: () => CutOptions;
  /** the options before the browser's storage is read: the defaults, for the server render and hydration */
  get_server_snapshot: () => CutOptions;
  subscribe: (listener: () => void) => () => void;
  /** changes some options and stores them; the page keeps them even when storing fails */
  update: (changes: Partial<CutOptions>) => void;
}

/**
 * A store of the cut options over `get_storage`, which may throw (reading `window.localStorage` itself throws where
 * site data is blocked). The storage is read once, on the first snapshot.
 */
export function create_cut_options_store(get_storage: () => OptionsStorage | null | undefined): CutOptionsStore {
  let current: CutOptions | null = null;
  const listeners = new Set<() => void>();

  const load = (): CutOptions => {
    try {
      return parse_cut_options(get_storage()?.getItem(CUT_OPTIONS_STORAGE_KEY) ?? null);
    } catch {
      return DEFAULT_CUT_OPTIONS;
    }
  };

  const get_snapshot = () => (current ??= load());

  return {
    get_snapshot,
    get_server_snapshot: () => DEFAULT_CUT_OPTIONS,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: changes => {
      const previous = get_snapshot();
      const next = { ...previous, ...changes };
      if (
        next.format === previous.format &&
        next.downscale === previous.downscale &&
        next.tile_size === previous.tile_size &&
        next.skip_blank === previous.skip_blank
      ) {
        return;
      }
      current = next;
      try {
        get_storage()?.setItem(CUT_OPTIONS_STORAGE_KEY, serialize_cut_options(next));
      } catch {
        // not stored (blocked or full storage): the options still apply to this page
      }
      listeners.forEach(listener => listener());
    }
  };
}

/** The page's store, over this browser's localStorage. */
export const cut_options_store = create_cut_options_store(() =>
  typeof window === "undefined" ? null : window.localStorage
);
