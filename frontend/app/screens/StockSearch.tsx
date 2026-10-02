'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { STOCKS } from '../stocks';
import { NovaSearch } from '@/components/home/NovaSearch';
import { usePresence } from '@/components/motion/usePresence';

function scoreStock(stock: typeof STOCKS[number], query: string) {
  const target = `${stock.name} ${stock.symbol} ${stock.ticker} ${stock.exchange}`.toLowerCase();
  if (stock.symbol.toLowerCase() === query) return 0;
  if (stock.name.toLowerCase().startsWith(query) || stock.symbol.toLowerCase().startsWith(query)) return 1;
  if (target.includes(query)) return 2;
  return 100;
}

const stockHref = (ticker: string) => `/stock/${encodeURIComponent(ticker)}`;

export default function StockSearch({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);

  const suggestions = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return [];
    return STOCKS
      .map(stock => ({ stock, score: scoreStock(stock, query) }))
      .filter(item => item.score < 100)
      .sort((a, b) => a.score - b.score || a.stock.symbol.localeCompare(b.stock.symbol))
      .slice(0, 6)
      .map(item => item.stock);
  }, [value]);

  const first = suggestions[0];
  const list = usePresence(focused && suggestions.length > 0, 160);

  return (
    <div className={`relative w-full ${compact ? 'max-w-xl' : 'max-w-2xl'}`}>
      <NovaSearch>
        <input
          value={value}
          onChange={event => setValue(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 160)}
          onKeyDown={event => {
            if (event.key === 'Enter' && first) {
              window.location.href = stockHref(first.ticker);
            }
          }}
          aria-label="Search any stock"
          placeholder="Search any stock…"
        />
      </NovaSearch>

      {list.mounted && (
        <div
          data-lenis-prevent
          data-state={list.state}
          className="anim-pop nova-auth absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl p-1.5 font-body"
        >
          {suggestions.map(stock => (
            <Link
              key={stock.ticker}
              href={stockHref(stock.ticker)}
              className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.07]"
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px] text-[#e9e5ff]">{stock.name}</span>
                <span className="mt-0.5 block font-numeric text-[12px] text-[#ff79c0]">{stock.symbol}</span>
              </span>
              <span className="shrink-0 rounded-md bg-white/[0.06] px-2 py-0.5 font-numeric text-[11px] text-[#9f99c2]">{stock.exchange}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
