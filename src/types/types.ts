export interface ImageValidationResult {
  is_valid: boolean;
  error?: string;
  width?: number;
  height?: number;
  max_zoom_level?: number;
}

export interface ZoomLevelProgress {
  zoom_level: number;
  total_tiles_in_level: number;
  processed_tiles_in_level: number;
  progress_percentage: number;
  is_complete: boolean;
}

export interface TileGenerationProgress {
  current_zoom_level: number;
  progress: number;
  total_tiles: number;
  processed_tiles: number;
  zoom_levels_progress: ZoomLevelProgress[];
  current_stage: "preparing" | "generating" | "complete" | "error";
  tiles_per_second?: number;
}

export type OutputFormat = "png" | "webp";

export interface MapImage {
  element: HTMLImageElement;
  width: number;
  height: number;
  file_name: string;
  src: string;
  max_zoom_level: number;
}