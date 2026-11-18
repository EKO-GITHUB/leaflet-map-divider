import { TileGenerationProgress } from "@/types/types";

// The remaining time follows from the run's own tile rate, so it is derived while rendering (no effect, no clock).
export function useEta(is_generating: boolean, progress: TileGenerationProgress) {
  const { tiles_per_second, total_tiles, processed_tiles } = progress;
  if (!is_generating || !tiles_per_second || processed_tiles === 0) return "";

  const remaining = ((total_tiles - processed_tiles) / tiles_per_second) * 1000;
  if (remaining <= 1000) return "";

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
