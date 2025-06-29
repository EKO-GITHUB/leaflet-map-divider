import React from "react";
import { Switch } from "@/components/ui/switch";
import { SettingsIcon } from "lucide-react";
import { OutputFormat } from "@/types/types";

interface FormatSelectionProps {
  output_format: OutputFormat;
  on_output_format_change: (format: OutputFormat) => void;
  is_generating: boolean;
}

export function FormatSelection({
                                  output_format,
                                  on_output_format_change,
                                  is_generating
                                }: FormatSelectionProps) {
  return (
    <div className="bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-xl p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-full bg-gradient-to-r from-orange-500 to-red-500">
          <SettingsIcon className="text-white" size={20} />
        </div>
        <h3 className="text-xl font-bold bg-gradient-to-r from-orange-400 to-red-400 bg-clip-text text-transparent">
          Export Settings
        </h3>
      </div>

      <div className="flex items-center justify-center gap-6">
        <span className="text-white/90 font-medium">Output Format:</span>
        <div className="flex items-center gap-4 bg-white/10 rounded-xl p-3">
          <span
            className={`font-semibold transition-colors ${output_format === "png" ? "text-emerald-400" : "text-white/60"}`}>
            PNG
          </span>
          <Switch
            checked={output_format === "webp"}
            onCheckedChange={(checked) => {
              on_output_format_change(checked ? "webp" : "png");
            }}
            disabled={is_generating}
            className="data-[state=checked]:bg-gradient-to-r data-[state=checked]:from-emerald-500 data-[state=checked]:to-blue-500"
          />
          <span
            className={`font-semibold transition-colors ${output_format === "webp" ? "text-blue-400" : "text-white/60"}`}>
            WebP
          </span>
        </div>
      </div>

      <div className="mt-4 text-center text-sm text-white/60">
        {output_format === "png" ? "PNG: Lossless compression, larger file size" : "WebP: Better compression, smaller file size"}
      </div>
    </div>
  );
}