import React from "react";
import { MapImage } from "@/types/types";
import { ERROR_MESSAGES } from "@/constants/constants";
import { GridIcon, ImageIcon, InfoIcon, ZoomInIcon } from "lucide-react";

interface ImageInfoProps {
  image: MapImage;
}

export function ImageInfo({ image }: ImageInfoProps) {
  const tile_size = image.width / Math.pow(2, image.max_zoom_level);

  const info_items = [
    {
      icon: <ImageIcon size={16} className="text-blue-400" />,
      label: "Dimensions",
      value: `${image.width} × ${image.height} px`
    },
    {
      icon: <ZoomInIcon size={16} className="text-emerald-400" />,
      label: "Max Zoom Level",
      value: image.max_zoom_level === 0 ? (
        <span className="text-red-400 text-sm">
          {ERROR_MESSAGES.CANNOT_DIVIDE}
        </span>
      ) : (
        <span className="text-emerald-300 font-semibold">{image.max_zoom_level}</span>
      )
    },
    {
      icon: <GridIcon size={16} className="text-purple-400" />,
      label: "Tile Size (Max Zoom)",
      value: `${tile_size} × ${tile_size} px`
    }
  ];

  return (
    <div className="w-full max-w-4xl bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-xl p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-full bg-gradient-to-r from-blue-500 to-purple-500">
          <InfoIcon className="text-white" size={20} />
        </div>
        <h3 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
          Image Information
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {info_items.map((item, index) => (
          <div
            key={index}
            className="bg-white/5 rounded-xl p-4 border border-white/10 hover:bg-white/10 transition-all duration-300"
          >
            <div className="flex items-center gap-3 mb-2">
              {item.icon}
              <span className="text-sm font-medium text-white/70">{item.label}</span>
            </div>
            <div className="text-lg font-semibold text-white">
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}