// Pure numeric / technical-indicator helpers extracted verbatim from
// app/page.tsx during the Phase A foundation refactor. No React, no side effects.

export function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stableMarketShuffle<T extends { ticker: string }>(stocks: T[], salt: string) {
  return [...stocks].sort((left, right) => {
    const leftHash = stableHash(`${salt}:${left.ticker}`);
    const rightHash = stableHash(`${salt}:${right.ticker}`);
    if (leftHash !== rightHash) return leftHash - rightHash;
    return left.ticker.localeCompare(right.ticker);
  });
}

export function asNumber(value: any, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rollingMean(values: number[], period: number) {
  return values.map((_, index) => mean(values.slice(Math.max(0, index - period + 1), index + 1)));
}

export function rollingMin(values: number[], period: number) {
  return values.map((_, index) => Math.min(...values.slice(Math.max(0, index - period + 1), index + 1)));
}

export function rollingMax(values: number[], period: number) {
  return values.map((_, index) => Math.max(...values.slice(Math.max(0, index - period + 1), index + 1)));
}

export function rollingStd(values: number[], period: number) {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - period + 1), index + 1);
    const avg = mean(slice);
    return Math.sqrt(mean(slice.map(value => (value - avg) ** 2)));
  });
}

export function ema(values: number[], period: number) {
  const smoothing = 2 / (period + 1);
  const result: number[] = [];
  values.forEach((value, index) => {
    result[index] = index === 0 ? value : value * smoothing + result[index - 1] * (1 - smoothing);
  });
  return result;
}

export function rsi(values: number[], period = 14) {
  return values.map((value, index) => {
    if (index === 0) return 50;
    const slice = values.slice(Math.max(1, index - period + 1), index + 1);
    let gains = 0;
    let losses = 0;
    slice.forEach((item, sliceIndex) => {
      const previous = values[Math.max(0, index - slice.length + sliceIndex)];
      const diff = item - previous;
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    });
    if (losses === 0) return gains === 0 ? 50 : 100;
    return 100 - 100 / (1 + gains / losses);
  });
}

export function formatIndicatorValue(value: number, name: string) {
  if (!Number.isFinite(value)) return '-';
  if (/rsi|stochastic|williams|volatility|percent|%|index|money flow|aroon|chop/i.test(name)) {
    return `${value.toFixed(2)}%`;
  }
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}K`;
  return value.toFixed(2);
}

export function getIndicatorColor(name: string) {
  if (/macd|momentum|oscillator|rate|trix|tsi/i.test(name)) return '#38bdf8';
  if (/volume|money|accumulation|vwap/i.test(name)) return 'var(--up)';
  if (/volatility|atr|deviation|error|band/i.test(name)) return '#f59e0b';
  if (/rsi|stochastic|williams|cci|aroon/i.test(name)) return 'var(--accent)';
  return 'var(--accent)';
}
