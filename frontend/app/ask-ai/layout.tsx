import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Ask AI',
  description:
    'Ask about any NSE stock, backtest a trading rule on years of real prices, scan the market for a strategy, or get a market concept explained in plain English.',
  path: '/ask-ai',
});

export default function AskAiLayout({ children }: { children: ReactNode }) {
  return children;
}
