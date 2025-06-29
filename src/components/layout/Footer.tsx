import React from "react";
import Link from "next/link";
import { GithubIcon } from "lucide-react";

export function Footer() {
  return (
    <div className="w-full max-w-4xl bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-xl p-6">
      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="text-center md:text-left">

          <div className="text-white/60 text-sm">
            100% open source • Privacy-first • Client-side processing
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Link
            className="flex items-center gap-3 bg-white/10 hover:bg-white/20 rounded-xl p-3 transition-all duration-300 transform hover:scale-105"
            href="https://github.com/EKO-GITHUB"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              className="rounded-full border-2 border-white/20"
              width={32}
              height={32}
              src="https://avatars.githubusercontent.com/u/25434461?v=4"
              alt="Murad Tochiev profile"
            />
            <div className="text-left">
              <div className="text-white font-semibold text-sm">Murad Tochiev</div>
              <div className="text-white/60 text-xs">@EKO-GITHUB</div>
            </div>
            <GithubIcon className="text-white/80" size={20} />
          </Link>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-white/10">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-white/50">
          <span>© 2025 Leaflet Map Divider. All rights reserved.</span>
        </div>
      </div>
    </div>);
}