export type Summary = {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_return_pct: number;
  avg_return_per_trade_pct: number;
  profit_factor?: number;
  max_drawdown_pct?: number;
};

export type Trade = {
  buy_date: string;
  sell_date: string;
  buy_price: number;
  sell_price: number;
  holding_days: number;
  return_pct: number;
  result: string;
};

export type Backtest = {
  buy_expr?: string;
  sell_expr?: string;
  mode?: string;
  current_signal?: string;
  summary?: Summary | null;
  trades?: Trade[];
  buy_and_hold_return_pct?: number;
  alpha_vs_buy_hold_pct?: number;
  warning?: string;
};

export type ScanRow = {
  ticker: string;
  symbol?: string;
  name?: string;
  total_trades: number;
  win_rate: number;
  total_return_pct: number;
  buy_hold_pct: number;
  alpha_pct: number;
};

export type Scan = {
  buy_expr?: string;
  sell_expr?: string;
  scanned: number;
  universe?: number;
  partial?: boolean;
  traded: number;
  profitable: number;
  beat_buy_hold: number;
  avg_total_return_pct: number;
  rows: ScanRow[];
};

export type MoversScan = {
  session_date: string | null;
  direction: string;
  coverage: number;
  universe: number;
  ready: boolean;
  rows: Array<{ ticker: string; symbol?: string; name?: string; date: string; close: number; change_pct: number }>;
};

export type ScreenerResult = {
  rows: Array<{
    stock?: { symbol?: string; ticker?: string; name?: string };
    marketCapCr?: number | null;
    pe?: number | null;
    roe?: number | null;
    debtToEquity?: number | null;
    revenueGrowth3Yr?: number | null;
    technical?: { return1yPct?: number | null };
  }>;
  matchedRules?: string[];
  source?: string;
};

export type AskAiResponse = {
  answer: string;
  mode: string;
  success?: boolean;
  model_used: string;
  target_stock: string | null;
  backtest: Backtest | null;
  scan: Scan | MoversScan | null;
  screener?: ScreenerResult | null;
  suggestions?: string[];
  conversation_id?: string;
  saved?: boolean;
  strategy_json?: Record<string, unknown> | null;
  strategy_alert?: {
    alertable?: boolean;
    quality?: { alertable?: boolean; reason?: string };
    stats?: Record<string, number>;
    disclaimer?: string;
  };
  disclaimer?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  data?: Partial<AskAiResponse>;
  error?: boolean;
  thoughtMs?: number;
  /** The question an error belongs to, so it can be retried. */
  retryPrompt?: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  updated_at: string;
};
