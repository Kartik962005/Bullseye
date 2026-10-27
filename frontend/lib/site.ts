/** Site-wide facts used by metadata, the sitemap and the legal pages. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.bullseye.help').replace(/\/$/, '');
export const SITE_NAME = 'Bullseye';
export const SITE_DESCRIPTION =
  'Screen NSE stocks in plain English, test trading rules on real price history and read a plain verdict on any stock. Research, not investment advice.';
/** Shown on the Privacy and Terms pages. Update when the policies change. */
export const LEGAL_LAST_UPDATED = '12 October 2026';

/**
 * Complete metadata for one page. A page that sets openGraph replaces the
 * site-wide object entirely, so the preview image and X card are repeated
 * here or shared links would lose their picture.
 */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }) {
  const full = `${title} · ${SITE_NAME}`;
  const image = { url: '/opengraph-image', width: 1200, height: 630, alt: `${SITE_NAME} · Research for Indian stocks` };
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website' as const, siteName: SITE_NAME, locale: 'en_IN', url: path, title: full, description, images: [image] },
    twitter: { card: 'summary_large_image' as const, title: full, description, images: [image.url] },
  };
}
