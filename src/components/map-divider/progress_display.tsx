import React from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ClockIcon } from "lucide-react";
import { TileGenerationProgress } from "@/types/types";
import { ZoomLevelProgressItem } from "./zoom_level_progress";

interface ProgressDisplayProps {
  progress: TileGenerationProgress;
  estimated_time?: string;
  on_cancel?: () => void;
}

export function ProgressDisplay({ progress, estimated_time, on_cancel }: ProgressDisplayProps) {
  return (
    <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="animate-spin w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full"></div>
          <span className="text-blue-300 font-semibold">
            {progress.current_stage === "preparing" ? "Preparing..." : "Generating Tiles..."}
          </span>
        </div>
        <div className="flex items-center gap-4 text-blue-300 text-sm">
          {progress.tiles_per_second && (
            <div className="flex items-center gap-1">
              <span>{progress.tiles_per_second} tiles/sec</span>
            </div>
          )}
          {estimated_time && (
            <div className="flex items-center gap-2">
              <ClockIcon size={16} />
              <span>{estimated_time} remaining</span>
            </div>
          )}
        </div>
      </div>

      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-blue-200 text-sm font-medium">Overall Progress</span>
          <span className="text-blue-200 text-sm">{progress.progress}%</span>
        </div>
        <Progress
          value={progress.progress}
          className="w-full h-4 bg-blue-900/50"
        />
        <div className="flex justify-between items-center mt-2 text-xs text-blue-300">
          <span>Current Zoom: {progress.current_zoom_level}</span>
          <span>{progress.processed_tiles} / {progress.total_tiles} tiles</span>
        </div>
      </div>

      {progress.zoom_levels_progress && progress.zoom_levels_progress.length > 0 && (
        <div className="space-y-3">
          <span className="text-blue-200 text-sm font-medium">Zoom Level Progress</span>
          <div className="overflow-y-auto space-y-2 bg-black/20 rounded-lg p-3">
            {progress.zoom_levels_progress.map((zoom_progress) => (
              <ZoomLevelProgressItem
                key={zoom_progress.zoom_level}
                zoom_progress={zoom_progress}
                is_current={zoom_progress.zoom_level === progress.current_zoom_level}
              />
            ))}
          </div>
        </div>
      )}

      {on_cancel && (
        <Button
          variant="outline"
          onClick={on_cancel}
          className="mt-4 w-full border-red-500/30 text-red-300 hover:bg-red-500/20"
        >
          Cancel Generation
        </Button>
      )}
    </div>
  );
}