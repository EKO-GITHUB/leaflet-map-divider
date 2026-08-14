import type { Metadata } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";

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
  return (
    <html lang="en">
    <body>{children} <Analytics /></body>
    </html>
  );
}
