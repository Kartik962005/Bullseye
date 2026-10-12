import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '@/lib/site';

export const metadata: Metadata = {
  ...pageMetadata({
    title: 'Stock screener',
    description:
      'Screen 2,000+ NSE stocks by valuation, quality, growth, momentum and technicals, or describe a screen in plain English. Ready-made screens and sector pages included.',
    path: '/screens',
  }),
  // The template keeps "· Bullseye" on every screen and sector page below.
  title: { default: 'Stock screener', template: '%s · Bullseye' },
};

export default function ScreensLayout({ children }: { children: ReactNode }) {
  return children;
}
