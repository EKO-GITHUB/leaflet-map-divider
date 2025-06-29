import React, { useCallback, useEffect, useRef, useState } from "react";
import { MapImage } from "@/types/types";
import { ImageIcon, RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImagePreviewProps {
  image: MapImage;
}

export function ImagePreview({ image }: ImagePreviewProps) {
  const [current_zoom_level, set_current_zoom_level] = useState(0);
  const [pan_offset, set_pan_offset] = useState({ x: 0, y: 0 });
  const [is_dragging, set_is_dragging] = useState(false);
  const [drag_start, set_drag_start] = useState({ x: 0, y: 0 });

  const container_ref = useRef<HTMLDivElement>(null);
  const max_zoom_level = image.max_zoom_level;

  const handle_zoom_in = () => {
    set_current_zoom_level(prev => Math.min(prev + 1, max_zoom_level));
  };

  const handle_zoom_out = () => {
    set_current_zoom_level(prev => {
      const new_level = Math.max(prev - 1, 0);
      if (new_level === 0) {
        set_pan_offset({ x: 0, y: 0 });
      }
      return new_level;
    });
  };

  const handle_reset_zoom = () => {
    set_current_zoom_level(0);
    set_pan_offset({ x: 0, y: 0 });
  };

  const get_scale_factor = (zoom_level: number) => {
    return Math.pow(2, zoom_level);
  };


  const handle_mouse_down = useCallback((e: React.MouseEvent) => {
    if (current_zoom_level > 0) {
      e.preventDefault();
      set_is_dragging(true);
      set_drag_start({
        x: e.clientX - pan_offset.x,
        y: e.clientY - pan_offset.y
      });
    }
  }, [current_zoom_level, pan_offset]);

  const handle_mouse_move = useCallback((e: React.MouseEvent) => {
    if (is_dragging && current_zoom_level > 0) {
      e.preventDefault();
      set_pan_offset({
        x: e.clientX - drag_start.x,
        y: e.clientY - drag_start.y
      });
    }
  }, [is_dragging, drag_start, current_zoom_level]);

  const handle_mouse_up = useCallback(() => {
    set_is_dragging(false);
  }, []);

  useEffect(() => {
    const container = container_ref.current;
    if (!container) return;

    const handle_wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY > 0 ? -1 : 1;
      set_current_zoom_level(prev => {
        const new_level = Math.min(Math.max(prev + delta, 0), max_zoom_level);
        if (new_level === 0) {
          set_pan_offset({ x: 0, y: 0 });
        }
        return new_level;
      });
    };

    container.addEventListener("wheel", handle_wheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handle_wheel);
    };
  }, [max_zoom_level]);

  return (
    <div className="w-full max-w-4xl bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-xl p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500">
            <ImageIcon className="text-white" size={20} />
          </div>
          <h3 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            Image Preview
          </h3>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handle_zoom_out}
            disabled={current_zoom_level <= 0}
            className="bg-white/10 hover:bg-white/20 border border-white/20 text-white disabled:opacity-30 disabled:cursor-not-allowed p-2 rounded-lg transition-all duration-200"
            aria-label="Zoom out"
          >
            <ZoomOutIcon size={16} />
          </Button>
          <Button
            size="sm"
            onClick={handle_reset_zoom}
            className="bg-white/10 hover:bg-white/20 border border-white/20 text-white p-2 rounded-lg transition-all duration-200"
            aria-label="Reset zoom"
          >
            <RotateCcwIcon size={16} />
          </Button>
          <Button
            size="sm"
            onClick={handle_zoom_in}
            disabled={current_zoom_level >= max_zoom_level}
            className="bg-white/10 hover:bg-white/20 border border-white/20 text-white disabled:opacity-30 disabled:cursor-not-allowed p-2 rounded-lg transition-all duration-200"
            aria-label="Zoom in"
          >
            <ZoomInIcon size={16} />
          </Button>
        </div>
      </div>

      <div
        ref={container_ref}
        className="relative w-full rounded-xl overflow-hidden border border-white/20 bg-white/5 transition-all duration-300"
        style={{ aspectRatio: `${image.width}/${image.height}` }}
      >
        <div
          className="w-full h-full flex items-center justify-center overflow-hidden"
          onMouseDown={handle_mouse_down}
          onMouseMove={handle_mouse_move}
          onMouseUp={handle_mouse_up}
          onMouseLeave={handle_mouse_up}
          style={{ cursor: current_zoom_level > 0 ? (is_dragging ? "grabbing" : "grab") : "default" }}
        >
          <img
            src={image.src}
            alt={`Map preview: ${image.file_name}`}
            className="w-full h-full object-contain rounded-lg shadow-lg transition-transform duration-150 select-none"
            style={{
              transform: `scale(${get_scale_factor(current_zoom_level)}) translate(${pan_offset.x / get_scale_factor(current_zoom_level)}px, ${pan_offset.y / get_scale_factor(current_zoom_level)}px)`,
              transformOrigin: "center center"
            }}
            loading="lazy"
            draggable={false}
          />
        </div>

        <div
          className="absolute bottom-4 left-4 bg-black/70 text-white text-xs px-3 py-1 rounded-full backdrop-blur-sm border border-white/20">
          Zoom Level: {current_zoom_level}
        </div>

        <div
          className="absolute bottom-4 right-4 bg-black/70 text-white text-xs px-3 py-1 rounded-full backdrop-blur-sm border border-white/20">
          {image.width} × {image.height}px
        </div>
      </div>

      <div className="mt-4 text-center text-sm text-white/60">
        {current_zoom_level > 0
          ? "Click and drag to pan • Scroll to zoom • Use controls above"
          : `Scroll to zoom • Use controls above • Max zoom level: ${max_zoom_level}`
        }
      </div>
    </div>
  );
}