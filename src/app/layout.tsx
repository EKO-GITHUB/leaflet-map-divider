import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Leaflet Map Divider",
  description: "Tile your image to various zoom levels. Perfect for LeafletJS",
  alternates: {
    canonical: "https://leafletmapdivider.com"
  },
  keywords: "map, tiler, maptiler, divide, fantasy map, custom, tilelayer, leafletjs, leaflet, react-leaflet"
};

export default function RootLayout({
                                     children
                                   }: Readonly<{
  children: React.ReactNode;
}>) {
  return (<html lang="en">
  <body className={inter.className}>{children} <Analytics /></body>
  </html>);
}
