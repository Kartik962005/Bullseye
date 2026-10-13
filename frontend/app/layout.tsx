import type { Metadata, Viewport } from "next";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import BackendWarmup from "@/components/BackendWarmup";
import { StorageNotice } from "@/components/StorageNotice";
import { ScrollAids } from "@/components/ScrollAids";
import { Analytics } from "@vercel/analytics/next";
import { DEFAULT_THEME, THEME_BAR_COLOR, THEME_BOOT_SCRIPT } from "@/lib/theme-boot";

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
  metadataBase: new URL(SITE_URL),
  title: { default: "Bullseye · Research for Indian stocks", template: "%s · Bullseye" },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_IN",
    url: "/",
    title: "Bullseye · Research for Indian stocks",
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Bullseye · Research for Indian stocks",
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  // Light by default; the boot script and the theme switch update it for dark.
  themeColor: THEME_BAR_COLOR.light,
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
      data-theme={DEFAULT_THEME}
      suppressHydrationWarning
    >
      <head>
        {/* Sets the saved or OS theme before first paint, so it never flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
        <ScrollAids />
        <BackendWarmup />
        <StorageNotice />
        <Analytics />
      </body>
    </html>
  );
}
