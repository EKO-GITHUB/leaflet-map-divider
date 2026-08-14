import { IBM_Plex_Mono, Instrument_Sans, Michroma } from "next/font/google";
import { InstrumentApp } from "@/components/instrument/instrument_app";

const plex_mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono"
});

const instrument_sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument"
});

const michroma = Michroma({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-michroma"
});

export default function Home() {
  return (
    <main className={`${plex_mono.variable} ${instrument_sans.variable} ${michroma.variable}`}>
      <InstrumentApp />
    </main>
  );
}
