'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { STOCKS } from '../stocks';

function scoreStock(stock: typeof STOCKS[number], query: string) {
  const target = `${stock.name} ${stock.symbol} ${stock.ticker} ${stock.exchange}`.toLowerCase();
  if (stock.symbol.toLowerCase() === query) return 0;
  if (stock.name.toLowerCase().startsWith(query) || stock.symbol.toLowerCase().startsWith(query)) return 1;
  if (target.includes(query)) return 2;
  return 100;
}

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

  return (
    <div className={`relative w-full ${compact ? 'max-w-xl' : 'max-w-2xl'}`}>
      <input
        value={value}
        onChange={event => setValue(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 160)}
        onKeyDown={event => {
          if (event.key === 'Enter' && first) {
            window.location.href = `/?ticker=${encodeURIComponent(first.ticker)}`;
          }
        }}
        placeholder="SEARCH ASSETS, NOT HOPE."
        className="h-11 w-full rounded-2xl border border-cyan-200 bg-white/95 px-4 pr-11 font-numeric text-xs font-bold uppercase tracking-wider text-slate-900 outline-none shadow-[0_12px_34px_rgba(15,23,42,0.08)] transition placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 sm:h-12 sm:px-5 sm:text-sm"
      />
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-cyan-600">
        <svg className="h-4 w-4 sm:h-5 sm:w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>

      {focused && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.20)]">
          {suggestions.map(stock => (
            <Link
              key={stock.ticker}
              href={`/?ticker=${encodeURIComponent(stock.ticker)}`}
              className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-cyan-50"
            >
              <span className="min-w-0">
                <span className="block truncate font-body text-sm font-black text-slate-950">{stock.name}</span>
                <span className="mt-0.5 block font-numeric text-[10px] font-bold uppercase tracking-widest text-slate-400">{stock.symbol}</span>
              </span>
              <span className="shrink-0 rounded-lg bg-slate-100 px-2 py-1 font-numeric text-[10px] font-bold text-slate-500">{stock.exchange}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
