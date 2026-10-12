import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '@/lib/site';
import { LEGACY_SECTORS, SECTOR_INFO } from '../../screen-data';

export async function generateMetadata({ params }: { params: Promise<{ sector: string }> }): Promise<Metadata> {
  const { sector: raw } = await params;
  const decoded = decodeURIComponent(raw);
  const sector = LEGACY_SECTORS[decoded] ?? decoded;
  const info = SECTOR_INFO[sector];
  const label = info?.label ?? sector;
  return pageMetadata({
    title: `${label} stocks`,
    description: `Every NSE ${label.toLowerCase()} stock${info ? ` (${info.examples})` : ''} with price, P/E, ROE, dividend yield and returns, largest first.`,
    path: `/screens/sector/${encodeURIComponent(sector)}`,
  });
}

export default function SectorLayout({ children }: { children: ReactNode }) {
  return children;
}
