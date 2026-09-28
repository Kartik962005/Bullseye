import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import BackendWarmup from "@/components/BackendWarmup";

// ── Type system ─────────────────────────────────────────────────────────────
// Three families, site-wide: an editorial serif for headings, a clean sans for
// all running text and UI, and a mono for prices and numbers. Self-hosted by
// next/font, so there is no third-party font request at runtime.
const displaySerif = Instrument_Serif({
  variable: "--font-instrument",
  weight: ["400"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
});

const bodySans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const numericMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bullseye AI",
  description: "AI-powered stock analysis and trading research dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${displaySerif.variable} ${bodySans.variable} ${numericMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <BackendWarmup />
      </body>
    </html>
  );
}
