import { useEffect, useRef, useState } from "react";

export function useEta(is_generating: boolean, progress_percent: number) {
  const [eta, set_eta] = useState("");
  const start_ref = useRef<number | null>(null);

  useEffect(() => {
    if (!is_generating) {
      start_ref.current = null;
      set_eta("");
      return;
    }

    if (start_ref.current === null) {
      start_ref.current = Date.now();
    }

    if (progress_percent > 0) {
      const elapsed = Date.now() - start_ref.current;
      const remaining = (elapsed / progress_percent) * (100 - progress_percent);

      if (remaining > 1000) {
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        set_eta(minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`);
      }
    }
  }, [is_generating, progress_percent]);

  return eta;
}
