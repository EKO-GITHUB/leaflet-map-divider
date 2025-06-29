import React from "react";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon, XCircleIcon } from "lucide-react";

interface ErrorDisplayProps {
  error: string;
  on_clear_error?: () => void;
}

export function ErrorDisplay({ error, on_clear_error }: ErrorDisplayProps) {
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <AlertCircleIcon className="text-red-400 flex-shrink-0" size={20} />
        <div className="flex-1">
          <h4 className="text-red-300 font-semibold mb-1">Generation Failed</h4>
          <p className="text-red-200 text-sm">{error}</p>
        </div>
        {on_clear_error && (
          <Button
            variant="outline"
            size="sm"
            onClick={on_clear_error}
            className="border-red-500/30 text-red-300 hover:bg-red-500/20"
          >
            <XCircleIcon size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}