import type { STOCKS } from '../stocks';

export type Stock = typeof STOCKS[number];

/** One stock row as the backend returns it (stock_snapshot_service.frontend_metric_row). */
export type ScreenMetricRow = {
  stock: Stock;
  sector?: string | null;
  priceToBook?: number | null;
  beta?: number | null;
  profitMargin?: number | null;
  cmp: number | null;
  pe: number | null;
  marketCapCr: number | null;
  divYield: number | null;
  qtrProfitVar: number | null;
  revenueGrowth3Yr: number | null;
  profitGrowth3Yr: number | null;
  roe: number | null;
  debtToEquity: number | null;
  operatingMargin: number | null;
  score: number;
  reason: string;
  technical?: {
    latestDate?: string;
    return1wPct?: number | null;
    return1mPct?: number | null;
    return3mPct?: number | null;
    return6mPct?: number | null;
    return1yPct?: number | null;
    todayReturnPct?: number | null;
    gapPct?: number | null;
    rsi14?: number | null;
    mfi14?: number | null;
    sma20?: number | null;
    sma50?: number | null;
    sma200?: number | null;
    ema20?: number | null;
    atr14?: number | null;
    latestVolume?: number | null;
    volumeRatio20?: number | null;
    high52Week?: number | null;
    low52Week?: number | null;
    priceVs52WeekHighPct?: number | null;
    priceVs52WeekLowPct?: number | null;
  };
};

export type ScreenCategory = 'Value' | 'Quality' | 'Growth' | 'Momentum' | 'Technical' | 'Income';

export type ScreenItem = {
  slug: string;
  title: string;
  category: ScreenCategory;
  description: string;
  /** The rules in plain English, shown as chips. */
  rules: string[];
  /** Read-only SELECT over stock_snapshot, run by /api/v1/screener/run. */
  sql: string;
  /** Column ids (see COLUMNS in ResultsTable) to show after the name. */
  columns: string[];
  /** Set when the textbook version needs data Bullseye doesn't have. */
  note?: string;
};

const BASE = 'SELECT symbol, name FROM stock_snapshot';

export const SCREENS: ScreenItem[] = [
  // ── Value ────────────────────────────────────────────────────────────────
  {
    slug: 'low-10-year-average-earnings',
    title: 'Graham value',
    category: 'Value',
    description: 'Cheap on earnings, modest debt and a high return on equity.',
    rules: ['P/E between 0 and 15', 'Debt / equity under 1', 'ROE above 15%', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE trailing_pe > 0 AND trailing_pe < 15 AND debt_to_equity < 1 AND roe > 15 AND market_cap_cr > 500 ORDER BY roe DESC LIMIT 100`,
    columns: ['price', 'pe', 'roe', 'de', 'mcap', 'ret1y'],
    note: 'Graham used 10-year average earnings. Bullseye has the last 12 months of earnings, so this uses the trailing P/E.',
  },
  {
    slug: 'magic-formula',
    title: 'Magic Formula',
    category: 'Value',
    description: "Greenblatt's idea: good businesses at cheap prices. High earnings yield, high returns.",
    rules: ['Earnings yield above 8% (P/E under 12.5)', 'ROE above 20%', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE trailing_pe > 0 AND trailing_pe < 12.5 AND roe > 20 AND market_cap_cr > 500 ORDER BY roe DESC LIMIT 100`,
    columns: ['price', 'pe', 'roe', 'mcap', 'ret1y'],
    note: 'The original uses return on capital (ROCE), which the data source does not provide, so ROE stands in.',
  },
  {
    slug: 'below-book-value',
    title: 'Below book value',
    category: 'Value',
    description: 'Profitable companies the market values at less than their net assets.',
    rules: ['Price / book under 1', 'Profitable (P/E above 0)', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE price_to_book > 0 AND price_to_book < 1 AND trailing_pe > 0 AND market_cap_cr > 500 ORDER BY price_to_book ASC LIMIT 100`,
    columns: ['price', 'pb', 'pe', 'roe', 'mcap', 'ret1y'],
  },
  {
    slug: 'cash-rich',
    title: 'More cash than debt',
    category: 'Value',
    description: 'Companies whose cash pile is larger than everything they owe.',
    rules: ['Total cash above total debt', 'Profitable', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE total_cash > total_debt AND trailing_pe > 0 AND market_cap_cr > 1000 ORDER BY market_cap_cr DESC LIMIT 100`,
    columns: ['price', 'mcap', 'de', 'pe', 'roe', 'ret1y'],
  },

  // ── Quality ──────────────────────────────────────────────────────────────
  {
    slug: 'coffee-can-portfolio',
    title: 'Coffee Can',
    category: 'Quality',
    description: 'Steady compounders: high returns on equity, growing sales, little debt.',
    rules: ['ROE above 15%', 'Revenue growth above 10%', 'Debt / equity under 1', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE roe > 15 AND revenue_growth > 10 AND debt_to_equity < 1 AND market_cap_cr > 1000 ORDER BY market_cap_cr DESC LIMIT 100`,
    columns: ['price', 'roe', 'revg', 'de', 'mcap', 'ret1y'],
    note: 'The book version wants 10 straight years of ROCE and sales growth. Bullseye has the latest figures only.',
  },
  {
    slug: 'debt-free-compounders',
    title: 'Debt-free compounders',
    category: 'Quality',
    description: 'Practically no debt, a high ROE and profits still growing.',
    rules: ['Debt / equity under 0.1', 'ROE above 15%', 'Profit growth above 10%', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE debt_to_equity < 0.1 AND roe > 15 AND profit_growth > 10 AND market_cap_cr > 500 ORDER BY roe DESC LIMIT 100`,
    columns: ['price', 'de', 'roe', 'profg', 'mcap', 'ret1y'],
  },
  {
    slug: 'high-margin-leaders',
    title: 'High-margin leaders',
    category: 'Quality',
    description: 'Businesses that keep a large share of every rupee of sales.',
    rules: ['Operating margin above 25%', 'ROE above 15%', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE operating_margin > 25 AND roe > 15 AND market_cap_cr > 1000 ORDER BY operating_margin DESC LIMIT 100`,
    columns: ['price', 'opm', 'roe', 'pe', 'mcap', 'ret1y'],
  },

  // ── Growth ───────────────────────────────────────────────────────────────
  {
    slug: 'growth-stocks',
    title: 'Growth at a fair price',
    category: 'Growth',
    description: 'Fast-growing companies whose P/E is still under twice their profit growth.',
    rules: ['Revenue and profit growth above 12%', 'ROE above 15%', 'PEG under 2', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE revenue_growth > 12 AND profit_growth > 12 AND roe > 15 AND trailing_pe > 0 AND trailing_pe < 2 * profit_growth AND market_cap_cr > 1000 ORDER BY profit_growth DESC LIMIT 100`,
    columns: ['price', 'pe', 'profg', 'revg', 'roe', 'mcap'],
  },
  {
    slug: 'the-bull-cartel',
    title: 'The Bull Cartel',
    category: 'Growth',
    description: 'Sales and earnings both up more than 15% in the latest reported quarter.',
    rules: ['Quarterly revenue growth above 15%', 'Quarterly earnings growth above 15%', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE revenue_growth > 15 AND earnings_quarterly_growth > 15 AND market_cap_cr > 500 ORDER BY revenue_growth DESC LIMIT 100`,
    columns: ['price', 'revg', 'qeg', 'pe', 'mcap', 'ret3m'],
  },
  {
    slug: 'best-of-latest-quarter',
    title: 'Best of the latest quarter',
    category: 'Growth',
    description: 'The strongest year-on-year jumps in quarterly earnings.',
    rules: ['Quarterly earnings growth above 25%', 'Revenue growth above 15%', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE earnings_quarterly_growth > 25 AND revenue_growth > 15 AND market_cap_cr > 500 ORDER BY earnings_quarterly_growth DESC LIMIT 100`,
    columns: ['price', 'qeg', 'revg', 'pe', 'mcap', 'ret3m'],
  },

  // ── Momentum ─────────────────────────────────────────────────────────────
  {
    slug: 'companies-creating-new-high',
    title: 'Near 52-week high',
    category: 'Momentum',
    description: 'Larger companies trading within 5% of their highest price in a year.',
    rules: ['Price within 5% of the 52-week high', 'Market cap above ₹5,000 cr'],
    sql: `${BASE} WHERE price >= 0.95 * high_52w AND market_cap_cr > 5000 ORDER BY market_cap_cr DESC LIMIT 100`,
    columns: ['price', 'vs52h', 'ret1m', 'ret1y', 'mcap'],
  },
  {
    slug: 'darvas-scan',
    title: 'Darvas box',
    category: 'Momentum',
    description: "Nicolas Darvas's filter: near the yearly high, liquid and not a penny stock.",
    rules: ['Within 10% of the 52-week high', 'Volume above 1 lakh shares', 'Price above ₹10'],
    sql: `${BASE} WHERE price >= 0.9 * high_52w AND latest_volume > 100000 AND price > 10 ORDER BY ret_1m DESC LIMIT 100`,
    columns: ['price', 'vs52h', 'volume', 'ret1m', 'mcap'],
  },
  {
    slug: 'price-volume-action',
    title: 'Volume surge',
    category: 'Momentum',
    description: 'Trading at least twice its usual volume while the price rose this week.',
    rules: ['Volume above 2× its 20-day average', 'Up over the past week', 'Market cap above ₹500 cr'],
    sql: `${BASE} WHERE vol_ratio > 2 AND ret_1w > 0 AND market_cap_cr > 500 ORDER BY vol_ratio DESC LIMIT 100`,
    columns: ['price', 'change', 'volx', 'ret1w', 'mcap'],
  },
  {
    slug: 'top-1y-performers',
    title: 'Top 1-year performers',
    category: 'Momentum',
    description: 'The biggest gainers of the past 12 months among established companies.',
    rules: ['Market cap above ₹1,000 cr', 'Ranked by 1-year return'],
    sql: `${BASE} WHERE market_cap_cr > 1000 ORDER BY ret_1y DESC LIMIT 100`,
    columns: ['price', 'ret1y', 'ret3m', 'pe', 'mcap'],
  },

  // ── Technical ────────────────────────────────────────────────────────────
  {
    slug: 'golden-crossover',
    title: 'Golden crossover',
    category: 'Technical',
    description: 'The 50-day average has just moved above the 200-day average.',
    rules: ['50-DMA above 200-DMA', '…by less than 2%', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE sma50 > sma200 AND sma50 < 1.02 * sma200 AND market_cap_cr > 1000 ORDER BY market_cap_cr DESC LIMIT 100`,
    columns: ['price', 'sma50', 'sma200', 'ret1m', 'mcap'],
    note: "Bullseye stores today's averages, not yesterday's, so a fresh cross is read as the 50-DMA sitting less than 2% above the 200-DMA.",
  },
  {
    slug: 'bearish-crossovers',
    title: 'Death cross',
    category: 'Technical',
    description: 'The 50-day average has just slipped below the 200-day average.',
    rules: ['50-DMA below 200-DMA', '…by less than 2%', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE sma50 < sma200 AND sma50 > 0.98 * sma200 AND market_cap_cr > 1000 ORDER BY market_cap_cr DESC LIMIT 100`,
    columns: ['price', 'sma50', 'sma200', 'ret1m', 'mcap'],
    note: "A fresh cross is read as the 50-DMA sitting less than 2% below the 200-DMA, since only today's averages are stored.",
  },
  {
    slug: 'above-all-averages',
    title: 'Above every average',
    category: 'Technical',
    description: 'Price above its 20, 50 and 200-day averages, with each average stacked in order.',
    rules: ['Price > 20-DMA > 50-DMA > 200-DMA', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE price > sma20 AND sma20 > sma50 AND sma50 > sma200 AND market_cap_cr > 1000 ORDER BY ret_3m DESC LIMIT 100`,
    columns: ['price', 'sma20', 'sma50', 'sma200', 'ret3m', 'mcap'],
  },
  {
    slug: 'rsi-oversold-stocks',
    title: 'RSI oversold',
    category: 'Technical',
    description: 'Sold off hard enough that the 14-day RSI is under 30.',
    rules: ['RSI (14) below 30', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE rsi14 < 30 AND market_cap_cr > 1000 ORDER BY rsi14 ASC LIMIT 100`,
    columns: ['price', 'rsi', 'ret1m', 'vs52h', 'mcap'],
  },
  {
    slug: 'rsi-overbought-stocks',
    title: 'RSI overbought',
    category: 'Technical',
    description: 'Run up hard enough that the 14-day RSI is above 70.',
    rules: ['RSI (14) above 70', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE rsi14 > 70 AND market_cap_cr > 1000 ORDER BY rsi14 DESC LIMIT 100`,
    columns: ['price', 'rsi', 'ret1m', 'vs52h', 'mcap'],
  },
  {
    slug: 'near-52-week-low',
    title: 'Near 52-week low',
    category: 'Technical',
    description: 'Established companies within 5% of their lowest price in a year.',
    rules: ['Price within 5% of the 52-week low', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE price <= 1.05 * low_52w AND market_cap_cr > 1000 ORDER BY market_cap_cr DESC LIMIT 100`,
    columns: ['price', 'vs52l', 'ret1y', 'pe', 'mcap'],
  },

  // ── Income ───────────────────────────────────────────────────────────────
  {
    slug: 'highest-dividend-yield-shares',
    title: 'Highest dividend yield',
    category: 'Income',
    description: 'Profitable companies paying the most dividend for their share price.',
    rules: ['Dividend yield above 2%', 'Profitable', 'Market cap above ₹1,000 cr'],
    sql: `${BASE} WHERE dividend_yield > 2 AND trailing_pe > 0 AND market_cap_cr > 1000 ORDER BY dividend_yield DESC LIMIT 100`,
    columns: ['price', 'dy', 'pe', 'roe', 'mcap', 'ret1y'],
    note: 'Payout history is not in the data, so check that a high yield is not a one-off special dividend.',
  },
  {
    slug: 'steady-dividend-low-beta',
    title: 'Calm dividend payers',
    category: 'Income',
    description: 'Dividend payers that move less than the market.',
    rules: ['Dividend yield above 1.5%', 'Beta under 0.8', 'Market cap above ₹5,000 cr'],
    sql: `${BASE} WHERE dividend_yield > 1.5 AND beta < 0.8 AND market_cap_cr > 5000 ORDER BY dividend_yield DESC LIMIT 100`,
    columns: ['price', 'dy', 'beta', 'pe', 'mcap', 'ret1y'],
  },
];

export const CATEGORIES: Array<{ id: ScreenCategory; blurb: string }> = [
  { id: 'Value', blurb: 'Cheap against earnings, assets or cash' },
  { id: 'Quality', blurb: 'High returns, little debt' },
  { id: 'Growth', blurb: 'Sales and profits rising fast' },
  { id: 'Momentum', blurb: 'Prices and volume moving up' },
  { id: 'Technical', blurb: 'Moving averages and RSI' },
  { id: 'Income', blurb: 'Dividends' },
];

/**
 * Screens that used to be listed but need data Bullseye doesn't have. They
 * showed a fixed, hand-picked list of stocks; their old links now explain
 * that and point to the closest real screen.
 */
export const RETIRED_SCREENS: Record<string, { title: string; needs: string; instead: string }> = {
  'capacity-expansion': { title: 'Capacity expansion', needs: 'fixed-asset and capital work-in-progress history', instead: 'growth-stocks' },
  'debt-reduction': { title: 'Debt reduction', needs: "last year's debt to compare against", instead: 'debt-free-compounders' },
  'growth-without-dilution': { title: 'Growth without dilution', needs: 'ten years of share-count history', instead: 'growth-stocks' },
  'fii-buying': { title: 'FII buying', needs: 'quarterly shareholding patterns', instead: 'price-volume-action' },
  'piotroski-scan': { title: 'Piotroski scan', needs: 'two years of balance sheets to score each test', instead: 'coffee-can-portfolio' },
  'quarterly-growers': { title: 'Quarterly growers', needs: 'four quarters of profit history', instead: 'the-bull-cartel' },
  'all-latest-qtr-results-date-wise': { title: 'Latest results, date-wise', needs: 'a results calendar', instead: 'best-of-latest-quarter' },
  'loss-to-profit-companies': { title: 'Loss to profit', needs: 'the year-ago quarter to compare against', instead: 'best-of-latest-quarter' },
  'fcf-yield': { title: 'FCF yield', needs: 'cash-flow statements', instead: 'cash-rich' },
  'high-ratio-of-market-value-of-investments': { title: 'Market value of investments', needs: 'holdings of listed investments', instead: 'below-book-value' },
  'book-value-over-5-times-price': { title: 'Book value over 5× price', needs: '', instead: 'below-book-value' },
};

export function getScreenBySlug(slug: string) {
  return SCREENS.find(screen => screen.slug === slug);
}

// ── Sectors ────────────────────────────────────────────────────────────────
/** Yahoo's sectors, with the Indian names people search for. */
export const SECTOR_INFO: Record<string, { label: string; examples: string }> = {
  'Financial Services': { label: 'Financial services', examples: 'Banks, NBFCs, insurers, AMCs' },
  Technology: { label: 'Technology', examples: 'IT services, software, electronics' },
  Healthcare: { label: 'Healthcare', examples: 'Pharma, hospitals, diagnostics' },
  'Consumer Defensive': { label: 'Consumer staples', examples: 'FMCG, food, personal care' },
  'Consumer Cyclical': { label: 'Consumer discretionary', examples: 'Autos, retail, textiles, hotels' },
  Industrials: { label: 'Industrials', examples: 'Capital goods, defence, infra' },
  'Basic Materials': { label: 'Materials', examples: 'Metals, cement, chemicals' },
  Energy: { label: 'Energy', examples: 'Oil, gas, refining' },
  Utilities: { label: 'Utilities', examples: 'Power generation and distribution' },
  'Communication Services': { label: 'Communication', examples: 'Telecom, media' },
  'Real Estate': { label: 'Real estate', examples: 'Developers, REITs' },
};

/** Old keyword-guessed sector names that may still be linked somewhere. */
export const LEGACY_SECTORS: Record<string, string> = {
  Banks: 'Financial Services',
  Finance: 'Financial Services',
  'Capital Markets': 'Financial Services',
  Insurance: 'Financial Services',
  'IT - Services': 'Technology',
  Automobiles: 'Consumer Cyclical',
  'Auto Components': 'Consumer Cyclical',
  Retailing: 'Consumer Cyclical',
  'Pharmaceuticals & Biotechnology': 'Healthcare',
  'Healthcare Services': 'Healthcare',
  'Oil & Gas': 'Energy',
  Power: 'Utilities',
  'Metals & Mining': 'Basic Materials',
  'Cement & Construction Materials': 'Basic Materials',
  Chemicals: 'Basic Materials',
  'Aerospace & Defense': 'Industrials',
  Construction: 'Industrials',
  Realty: 'Real Estate',
  'Telecom - Services': 'Communication Services',
  'Media & Entertainment': 'Communication Services',
  'Food & FMCG': 'Consumer Defensive',
  Beverages: 'Consumer Defensive',
};

export const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

// ── API ────────────────────────────────────────────────────────────────────
const BACKEND = '/api/backend';

export type RunResult = {
  rows: ScreenMetricRow[];
  columns?: string[];
  table?: { columns: string[]; rows: (string | number | null)[][] };
  as_of?: string | null;
  universe?: number;
  error?: string;
};

export async function runScreenSql(sql: string, signal?: AbortSignal): Promise<RunResult> {
  const response = await fetch(`${BACKEND}/api/v1/screener/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
    signal,
  });
  if (!response.ok) throw new Error(`Screen failed (${response.status})`);
  return response.json();
}

export type SmartSearchResult = RunResult & {
  mode?: 'nl' | 'sql' | 'answer' | 'unavailable' | string;
  generated_sql?: string;
  explanation?: string;
  summary?: string | null;
  caveat?: string | null;
  answer?: string;
};

export async function runSmartSearch(prompt: string, mode: 'auto' | 'sql', signal?: AbortSignal): Promise<SmartSearchResult> {
  const response = await fetch(`${BACKEND}/api/v1/screener/smart-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, mode, stocks: [], screeners: [], sectors: [] }),
    signal,
  });
  if (response.status === 429) throw new Error('Too many searches in a minute. Wait a moment and try again.');
  if (!response.ok) throw new Error('The screener is not responding. It may be waking up; try again in a few seconds.');
  return response.json();
}

export function median(values: Array<number | null | undefined>): number | null {
  const clean = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}
