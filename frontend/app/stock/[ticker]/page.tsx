import type { Metadata } from 'next';
import { Suspense } from 'react';

import { STOCKS } from '@/app/stocks';
import { HomeContent } from '@/app/page';
import { pageMetadata } from '@/lib/site';

type StockRouteProps = {
  params: Promise<{ ticker: string }>;
};

/**
 * Per-stock page title, so a shared link and a browser tab both say which stock
 * they are. The old `/?ticker=X` form could not do this — every stock rendered
 * under the homepage's own title.
 */
export async function generateMetadata({ params }: StockRouteProps): Promise<Metadata> {
  const { ticker } = await params;
  const decoded = decodeURIComponent(ticker);
  const stock = STOCKS.find(item => item.ticker === decoded);
  const label = !stock ? decoded : stock.name === stock.symbol ? stock.name : `${stock.name} (${stock.symbol})`;
  const symbol = stock?.symbol ?? decoded.replace(/\.(NS|BO)$/, '');
  return {
    ...pageMetadata({
      title: label,
      description: `Price chart, verdict, entry, target, stop loss and financials for ${label} on NSE. Research, not investment advice.`,
      path: `/stock/${encodeURIComponent(decoded)}`,
    }),
    keywords: [symbol, stock?.name ?? symbol, `${symbol} share price`, `${symbol} analysis`],
  };
}

export default async function StockPage({ params }: StockRouteProps) {
  const { ticker } = await params;
  return (
    <Suspense fallback={null}>
      <HomeContent initialTicker={decodeURIComponent(ticker)} />
    </Suspense>
  );
}
