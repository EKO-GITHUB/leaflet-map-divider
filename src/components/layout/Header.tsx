import React from "react";

export function Header() {
  return (
    <div
      className="bg-gradient-to-r from-emerald-600 to-blue-600 flex justify-center items-center text-4xl rounded-2xl p-8 gap-4 shadow-xl border border-white/10">
      <div className="relative">
        <img
          src="/leafletmapdivider-60.png"
          width={60}
          height={60}
          alt="leaflet map divider logo"
          className="drop-shadow-lg"
        />
        <div className="absolute inset-0 bg-white/20 rounded-full blur-xl -z-10"></div>
      </div>
      <div className="bg-gradient-to-r from-white to-gray-100 bg-clip-text text-transparent font-bold tracking-wide">
        Leaflet Map Divider
      </div>
    </div>
  );
}