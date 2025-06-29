import React from "react";
import { MapDivider } from "@/components/map-divider/map_divider";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-emerald-900/20 via-transparent to-blue-900/20"></div>
      <div className="relative z-10 grid justify-center items-start text-white gap-8 p-6 lg:p-12 max-w-6xl mx-auto">
        <Header />
        <MapDivider />
        <Footer />
      </div>
    </main>
  );
}