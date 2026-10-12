import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { STOCKS } from './stocks';
import { SCREENS, SECTOR_INFO } from './screens/screen-data';

// Every public page: the main sections, each screen and sector, the legal
// pages and one page per NSE stock.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (path: string, priority: number, changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });
  const seen = new Set<string>();
  const stocks = STOCKS.filter(stock => {
    if (stock.exchange !== 'NSE' || seen.has(stock.ticker)) return false;
    seen.add(stock.ticker);
    return true;
  });
  return [
    page('/', 1, 'daily'),
    page('/screens', 0.9, 'daily'),
    page('/ask-ai', 0.8, 'weekly'),
    ...SCREENS.map(screen => page(`/screens/${screen.slug}`, 0.7, 'daily')),
    ...Object.keys(SECTOR_INFO).map(sector => page(`/screens/sector/${encodeURIComponent(sector)}`, 0.6, 'daily')),
    page('/privacy', 0.3, 'yearly'),
    page('/terms', 0.3, 'yearly'),
    ...stocks.map(stock => page(`/stock/${encodeURIComponent(stock.ticker)}`, 0.5, 'daily')),
  ];
}
