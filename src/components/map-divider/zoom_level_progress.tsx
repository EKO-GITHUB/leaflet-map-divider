import React from "react";
import { Progress } from "@/components/ui/progress";
import { CheckCircleIcon } from "lucide-react";
import { ZoomLevelProgress } from "@/types/types";

interface ZoomLevelProgressProps {
  zoom_progress: ZoomLevelProgress;
  is_current: boolean;
}

export function ZoomLevelProgressItem({ zoom_progress, is_current }: ZoomLevelProgressProps) {
  return (
    <div
      className={`p-2 rounded transition-all duration-200 ${
        is_current
          ? "bg-blue-500/20 border border-blue-400/30"
          : zoom_progress.is_complete
            ? "bg-green-500/20 border border-green-400/30"
            : "bg-white/5 border border-white/10"
      }`}
    >
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-medium text-white/90">
          Zoom {zoom_progress.zoom_level}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70">
            {zoom_progress.processed_tiles_in_level} / {zoom_progress.total_tiles_in_level}
          </span>
          <span className="text-xs font-medium text-white/90">
            {zoom_progress.progress_percentage}%
          </span>
          {zoom_progress.is_complete && (
            <CheckCircleIcon className="text-green-400" size={12} />
          )}
        </div>
      </div>
      <Progress
        value={zoom_progress.progress_percentage}
        className={`w-full h-2 ${
          is_current
            ? "bg-blue-900/50"
            : zoom_progress.is_complete
              ? "bg-green-900/50"
              : "bg-gray-900/50"
        }`}
      />
    </div>
  );
}