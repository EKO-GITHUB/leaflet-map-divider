import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { OutputFormat, TileGenerationProgress } from "@/types/types";
import { DownloadIcon } from "lucide-react";
import { FormatSelection } from "./format_selection";
import { ErrorDisplay } from "./error_display";
import { ProgressDisplay } from "./progress_display";
import { SuccessMessage } from "./success_message";

interface TileGeneratorControlsProps {
  output_format: OutputFormat;
  on_output_format_change: (format: OutputFormat) => void;
  on_generate_tiles: () => void;
  is_generating: boolean;
  progress: TileGenerationProgress;
  can_generate: boolean;
  error?: string | null;
  on_cancel?: () => void;
  on_clear_error?: () => void;
}

export function TileGeneratorControls({
                                        output_format,
                                        on_output_format_change,
                                        on_generate_tiles,
                                        is_generating,
                                        progress,
                                        can_generate,
                                        error,
                                        on_cancel,
                                        on_clear_error
                                      }: TileGeneratorControlsProps) {
  const [estimated_time, set_estimated_time] = useState<string>("");
  const [start_time, set_start_time] = useState<number | null>(null);

  useEffect(() => {
    if (is_generating && !start_time) {
      set_start_time(Date.now());
    } else if (!is_generating) {
      set_start_time(null);
      set_estimated_time("");
    }
  }, [is_generating, start_time]);

  useEffect(() => {
    if (is_generating && start_time && progress.progress > 0) {
      const elapsed = Date.now() - start_time;
      const estimated_total = (elapsed / progress.progress) * 100;
      const remaining = estimated_total - elapsed;

      if (remaining > 1000) {
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        set_estimated_time(minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`);
      }
    }
  }, [progress.progress, start_time, is_generating]);

  return (
    <div className="w-full max-w-4xl space-y-6">
      <FormatSelection
        output_format={output_format}
        on_output_format_change={on_output_format_change}
        is_generating={is_generating}
      />

      {error && (
        <ErrorDisplay error={error} on_clear_error={on_clear_error} />
      )}

      {is_generating && (
        <ProgressDisplay
          progress={progress}
          estimated_time={estimated_time}
          on_cancel={on_cancel}
        />
      )}

      {!is_generating && progress.progress === 100 && !error && (
        <SuccessMessage />
      )}

      <Button
        onClick={on_generate_tiles}
        disabled={is_generating || !can_generate}
        className={`
          w-full py-4 text-lg font-semibold rounded-2xl transition-all duration-300 transform hover:scale-105
          ${is_generating || !can_generate
          ? "bg-gray-500 cursor-not-allowed opacity-50"
          : "bg-gradient-to-r from-emerald-500 to-blue-500 hover:from-emerald-600 hover:to-blue-600 shadow-lg hover:shadow-xl"
        }
        `}
      >
        <div className="flex items-center justify-center gap-3">
          <DownloadIcon size={24} />
          <span>{is_generating ? "Generating..." : "Download Tiled Map"}</span>
        </div>
      </Button>

      {!can_generate && (
        <div className="text-center text-red-400 text-sm">
          Cannot generate tiles: Image dimensions are too small to divide
        </div>
      )}
    </div>
  );
}