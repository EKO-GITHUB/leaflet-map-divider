import React from "react";
import { CheckCircleIcon } from "lucide-react";

export function SuccessMessage() {
  return (
    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <CheckCircleIcon className="text-emerald-400" size={20} />
        <div>
          <h4 className="text-emerald-300 font-semibold">Generation Complete!</h4>
          <p className="text-emerald-200 text-sm">Your tiled map has been downloaded successfully.</p>
        </div>
      </div>
    </div>
  );
}