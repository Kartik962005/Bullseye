import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '@/lib/site';
import { RETIRED_SCREENS, getScreenBySlug } from '../screen-data';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const screen = getScreenBySlug(slug);
  if (!screen) {
    const retired = RETIRED_SCREENS[slug];
    return { title: retired ? `${retired.title} (retired)` : 'Screen not found', robots: { index: false } };
  }
  return pageMetadata({
    title: `${screen.title} stocks`,
    description: `${screen.description} Rules: ${screen.rules.join(', ')}. Live NSE results from the latest market close.`,
    path: `/screens/${screen.slug}`,
  });
}

export default function ScreenLayout({ children }: { children: ReactNode }) {
  return children;
}
