'use client';

import type { ReactNode } from 'react';

// A backticked snippet that reads like a question or command becomes a
// tap-to-ask chip, so a suggested prompt in an answer can be run directly.
function looksRunnable(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 8 || t.length > 220 || !t.includes(' ')) return false;
  const verb = /^(backtest|back test|scan|screen|show|find|which|what|explain|analyze|analyse|compare|buy|sell|test|rank|list)\b/.test(t);
  const phrase = /\b(crosses?|golden cross|death cross|gap up|gap down|moving average|stop[- ]?loss|breakout|mean[- ]reversion|momentum|rsi|macd|buy and hold|buy-and-hold)\b/.test(t);
  return verb || phrase;
}

function inline(text: string, key: string, onRun?: (prompt: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${key}-b${i}`} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const code = token.slice(1, -1);
      nodes.push(
        onRun && looksRunnable(code) ? (
          <button key={`${key}-r${i}`} type="button" onClick={() => onRun(code)} title="Ask this" className="ai-runnable">
            {code}
            <span aria-hidden> ↵</span>
          </button>
        ) : (
          <code key={`${key}-c${i}`} className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-numeric text-[0.86em] text-[#ffb3d9]">
            {code}
          </code>
        ),
      );
    }
    last = regex.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim());

/** Paragraphs, headings, bullet and numbered lists, and pipe tables. */
export function Markdown({ text, onRun }: { text: string; onRun?: (prompt: string) => void }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let k = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(cells(lines[i]));
        i += 1;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={`t${k++}`} className="scr-scroll my-3 rounded-2xl border border-white/[0.08]">
          <table className="scr-table ai-md-table">
            <thead>
              <tr>{head?.map((c, j) => <th key={j}>{inline(c, `th${k}${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `td${k}${ri}${j}`, onRun)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(lines[i].replace(pattern, ''));
        i += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={`l${k++}`} className={`my-2 space-y-1.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-[#ff79c0]`}>
          {items.map((item, j) => (
            <li key={j}>{inline(item, `li${k}${j}`, onRun)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(
      heading ? (
        <p key={`h${k++}`} className="mb-1 mt-4 text-[15px] font-semibold text-white">
          {inline(heading[1], `h${k}`, onRun)}
        </p>
      ) : (
        <p key={`p${k++}`} className="my-2">
          {inline(line, `p${k}`, onRun)}
        </p>
      ),
    );
    i += 1;
  }
  return <div className="ai-md">{blocks}</div>;
}
