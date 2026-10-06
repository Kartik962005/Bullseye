'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BullseyeLogo, BullseyeMark } from '@/components/brand/BullseyeLogo';
import { usePresence } from '@/components/motion/usePresence';
import { Markdown } from './Markdown';
import { BacktestCard, MoversCard, ScanCard, ScreenerCard, StrategyCard } from './ResultCards';
import type { AskAiResponse, ChatMessage, ConversationSummary, MoversScan, Scan } from './types';

const BACKEND = '/api/backend';
// Market-wide scans stop at 20s on the server; past this something is stuck
// (or the server is still waking up), so say so instead of spinning on.
const ANSWER_TIMEOUT_MS = 75_000;

const CAPABILITIES: Array<{ title: string; blurb: string; icon: string; prompts: string[] }> = [
  {
    title: 'Test a strategy',
    blurb: 'Run a rule on years of real prices and compare it with buy-and-hold.',
    icon: 'M4 19V5m0 14h16M8 15l3-4 3 2 5-6',
    prompts: [
      'Backtest: buy RELIANCE when RSI crosses below 30, sell when it crosses 70',
      'If I buy TCS after it falls 5% in a week and sell on a 3% bounce, does it work?',
    ],
  },
  {
    title: 'Scan the market',
    blurb: 'Try one idea on every NSE stock, or find the day’s movers.',
    icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.3-4.3',
    prompts: ['Which NSE stocks do best with a golden cross strategy?', 'Show me the biggest gainers on the last trading day'],
  },
  {
    title: 'Look up a stock',
    blurb: 'Past prices, returns and indicators, straight from the data.',
    icon: 'M4 6h16M4 12h10M4 18h7',
    prompts: ['What was the price of INFY on 15 Oct 2024?', 'Current RSI and 50-day average for HDFCBANK'],
  },
  {
    title: 'Learn a concept',
    blurb: 'Plain-English answers, without the hype.',
    icon: 'M12 6v13m0-13C10.5 4.8 8 4 5 4v13c3 0 5.5.8 7 2m0-13c1.5-1.2 4-2 7-2v13c-3 0-5.5.8-7 2',
    prompts: [
      'Why can a strategy that wins 70% of trades still lose money?',
      'What is a P/E ratio, and what counts as a good one?',
    ],
  },
];

// What the answer is probably waiting on, by elapsed time. Scans can run for
// ~30s; telling people why beats a spinner that looks stuck.
function thinkingLabel(ms: number) {
  if (ms < 2000) return 'Reading your question';
  if (ms < 6000) return 'Pulling the price history';
  if (ms < 15000) return 'Running the numbers';
  return 'Still working, market-wide scans take up to 30 seconds';
}

function duration(ms?: number) {
  if (ms === undefined || ms < 0) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : 'yesterday';
}

type SessionUser = { id: string; email?: string };
type AuthClient = {
  auth: {
    getSession: () => Promise<{ data?: { session?: { access_token?: string; user?: SessionUser } | null } }>;
    onAuthStateChange: (
      cb: (event: string, session: { user?: SessionUser } | null) => void,
    ) => { data?: { subscription?: { unsubscribe?: () => void } } } | undefined;
  };
};

let supabaseClientPromise: Promise<AuthClient> | null = null;

// Shared with the homepage, which creates the same client under this key.
async function getSharedSupabaseClient(url: string, key: string): Promise<AuthClient | null> {
  if (typeof window === 'undefined') return null;
  const globalKey = '__bullseyeSupabaseClient';
  const w = window as unknown as Record<string, AuthClient | undefined>;
  if (w[globalKey]) return w[globalKey];
  if (!supabaseClientPromise) {
    supabaseClientPromise = import('@supabase/supabase-js').then(({ createClient }) => {
      if (!w[globalKey]) w[globalKey] = createClient(url, key) as unknown as AuthClient;
      return w[globalKey] as AuthClient;
    });
  }
  return supabaseClientPromise;
}

function Icon({ d, className = 'h-[18px] w-[18px]' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

export default function AskAiPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [savingAlert, setSavingAlert] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const drawer = usePresence(drawerOpen, 240);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autoOpenedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseAvailable = !!(supabaseUrl && supabaseKey);
  const [authReady, setAuthReady] = useState(!supabaseAvailable);
  const [user, setUser] = useState<SessionUser | null>(null);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (!supabaseAvailable) return {};
    const sb = await getSharedSupabaseClient(supabaseUrl!, supabaseKey!);
    const token = sb ? (await sb.auth.getSession())?.data?.session?.access_token : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [supabaseAvailable, supabaseKey, supabaseUrl]);

  const loadConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      const headers = await authHeaders();
      if (!('Authorization' in headers)) {
        setConversations([]);
        return [];
      }
      const response = await fetch(`${BACKEND}/api/v1/ask-ai/conversations`, { headers, cache: 'no-store' });
      const data = response.ok ? await response.json().catch(() => ({})) : {};
      const rows: ConversationSummary[] = Array.isArray(data.conversations) ? data.conversations : [];
      setConversations(rows);
      return rows;
    } finally {
      setConversationsLoading(false);
    }
  }, [authHeaders]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' }));
  }, []);

  useEffect(() => {
    if (messages.length || loading) scrollToEnd();
  }, [messages, loading, scrollToEnd]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now())), 250);
    return () => window.clearInterval(timer);
  }, [loading]);

  // Grow the composer with its content, up to a cap.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    let active = true;
    let subscription: { unsubscribe?: () => void } | null = null;
    if (!supabaseAvailable) return;
    getSharedSupabaseClient(supabaseUrl!, supabaseKey!).then(async sb => {
      if (!sb || !active) return;
      const session = await sb.auth.getSession();
      if (!active) return;
      setUser(session?.data?.session?.user ?? null);
      setAuthReady(true);
      subscription = sb.auth.onAuthStateChange((_event, next) => {
        setUser(next?.user ?? null);
        setAuthReady(true);
        autoOpenedRef.current = false;
      })?.data?.subscription ?? null;
    });
    return () => {
      active = false;
      subscription?.unsubscribe?.();
    };
  }, [supabaseAvailable, supabaseKey, supabaseUrl]);

  useEffect(() => {
    if (!authReady || !user) return;
    const timer = window.setTimeout(() => loadConversations().catch(() => setConversations([])), 0);
    return () => window.clearTimeout(timer);
  }, [authReady, user, loadConversations]);

  async function openConversation(id: string) {
    if (historyLoading) return;
    setHistoryLoading(true);
    setDrawerOpen(false);
    try {
      const headers = await authHeaders();
      if (!('Authorization' in headers)) return;
      const response = await fetch(`${BACKEND}/api/v1/ask-ai/conversations/${id}`, { headers, cache: 'no-store' });
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(raw?.detail || 'Could not open that chat.');
      const loaded: Array<{ id: string; role: 'user' | 'assistant'; content: string; data?: Partial<AskAiResponse> | null }> =
        Array.isArray(raw.messages) ? raw.messages : [];
      setConversationId(id);
      setMessages(
        loaded.map(m => ({ id: m.id, role: m.role, content: m.content, data: m.role === 'assistant' && m.data ? m.data : undefined })),
      );
    } finally {
      setHistoryLoading(false);
    }
  }

  // Signed-in visitors land back in their latest chat.
  useEffect(() => {
    if (!authReady || !user || autoOpenedRef.current || conversationId || messages.length || !conversations.length) return;
    autoOpenedRef.current = true;
    const timer = window.setTimeout(() => openConversation(conversations[0].id).catch(() => {}), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user, conversations, conversationId, messages.length]);

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || loading) return;
    const history = messages.filter(m => !m.error).slice(-10).map(m => ({ role: m.role, content: m.content }));
    // Arriving from a stock page (/ask-ai?ticker=RELIANCE.NS) gives answers
    // that stock's context.
    const params = new URLSearchParams(window.location.search);
    const context = {
      current_page: 'ask-ai',
      selected_symbol: params.get('symbol') ?? undefined,
      selected_ticker: params.get('ticker') ?? undefined,
    };
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ANSWER_TIMEOUT_MS);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text }]);
    setInput('');
    setLoading(true);
    try {
      const response = await fetch(`${BACKEND}/api/v1/ask-ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        signal: controller.signal,
        body: JSON.stringify({ prompt: text, history, stocks: [], context, conversation_id: conversationId }),
      });
      const raw = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error('That was a lot of questions in a minute. Wait a few seconds and try again.');
      if (!response.ok) throw new Error(raw?.detail || 'The AI could not answer that. Please try again.');
      const data = raw as AskAiResponse;
      if (data.success === false) throw new Error(data.answer || 'The AI is unavailable right now. Please try again shortly.');
      if (data.conversation_id) setConversationId(data.conversation_id);
      const thoughtMs = Date.now() - (startedAtRef.current ?? Date.now());
      setMessages(prev => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: data.answer || 'No answer came back.', data, thoughtMs }]);
      if (data.saved) loadConversations().catch(() => {});
    } catch (err) {
      const stopped = err instanceof Error && err.name === 'AbortError' && !timedOut;
      const message = timedOut
        ? 'That took too long, so I stopped waiting. The server may have been waking up; try again and it should be quicker.'
        : stopped
          ? 'Stopped. Ask something else whenever you like.'
          : err instanceof Error
            ? err.message
            : 'Something went wrong.';
      setMessages(prev => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'assistant', content: message, error: !stopped, retryPrompt: stopped ? undefined : text },
      ]);
    } finally {
      window.clearTimeout(timeout);
      abortRef.current = null;
      startedAtRef.current = null;
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function saveStrategyAlert(message: ChatMessage) {
    const data = message.data;
    if (!data?.strategy_json) return;
    const headers = await authHeaders();
    if (!('Authorization' in headers)) {
      setMessages(prev => [...prev, { id: `e-${Date.now()}`, role: 'assistant', content: 'Sign in on the home page to save daily alerts.', error: true }]);
      return;
    }
    setSavingAlert(message.id);
    const index = messages.findIndex(m => m.id === message.id);
    const question = messages.slice(0, index).reverse().find(m => m.role === 'user')?.content || 'Ask-AI strategy';
    try {
      const response = await fetch(`${BACKEND}/api/v1/strategies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          name: 'Ask-AI strategy alert',
          nl_text: question,
          strategy_json: data.strategy_json,
          quality: data.strategy_alert?.quality,
          enabled: true,
        }),
      });
      const raw = await response.json().catch(() => ({}));
      setMessages(prev => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: response.ok ? 'Saved. You will get an email on days this strategy fires.' : raw?.detail || 'Could not save that alert.',
          error: !response.ok,
        },
      ]);
    } finally {
      setSavingAlert(null);
    }
  }

  async function copyAnswer(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(message.id);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
    setDrawerOpen(false);
    inputRef.current?.focus();
  }

  const isEmpty = messages.length === 0;

  const composer = (
    <form
      className="ai-composer"
      onSubmit={event => {
        event.preventDefault();
        send(input);
      }}
    >
      <label htmlFor="ai-input" className="sr-only">
        Ask Bullseye AI
      </label>
      <textarea
        id="ai-input"
        ref={inputRef}
        rows={1}
        value={input}
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send(input);
          }
        }}
        placeholder={isEmpty ? 'Ask about a stock, a strategy or a concept…' : 'Ask a follow-up…'}
      />
      {loading ? (
        <button type="button" onClick={() => abortRef.current?.abort()} className="ai-send is-stop" aria-label="Stop answering">
          <span className="block h-3 w-3 rounded-[3px] bg-current" />
        </button>
      ) : (
        <button type="submit" disabled={!input.trim()} className="ai-send" aria-label="Send">
          <Icon d="M12 19V5m0 0-6 6m6-6 6 6" />
        </button>
      )}
    </form>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-5 p-4">
      <button type="button" onClick={newChat} className="nova-btn nova-btn-primary !h-11 w-full !text-[14px]">
        <Icon d="M12 5v14M5 12h14" className="h-4 w-4" />
        New chat
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-1">
          <span className="sx-label !text-[10px]">Recent chats</span>
          {user && (
            <button
              type="button"
              onClick={() => loadConversations().catch(() => {})}
              disabled={conversationsLoading}
              className="text-[12px] text-[#9f99c2] hover:text-white disabled:opacity-40"
            >
              Refresh
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-1">
          {conversationsLoading && !conversations.length ? (
            [0, 1, 2].map(i => <div key={i} className="sx-skeleton h-12" />)
          ) : conversations.length ? (
            conversations.slice(0, 20).map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => openConversation(c.id)}
                disabled={historyLoading}
                className={`ai-history ${c.id === conversationId ? 'is-active' : ''}`}
              >
                <span className="block truncate text-[13.5px]">{c.title || 'Untitled chat'}</span>
                <span className="mt-0.5 block text-[11.5px] text-[#7d7799]">{relativeTime(c.updated_at)}</span>
              </button>
            ))
          ) : (
            <p className="rounded-2xl border border-dashed border-white/10 px-3.5 py-4 text-[13px] leading-6 text-[#9f99c2]">
              {user ? (
                'Your chats from the last 48 hours show up here.'
              ) : (
                <>
                  <Link href="/" className="text-white underline underline-offset-4">
                    Sign in
                  </Link>{' '}
                  to keep your chats for 48 hours.
                </>
              )}
            </p>
          )}
        </div>
      </div>
      <p className="px-1 text-[11.5px] leading-5 text-[#7d7799]">
        Research on historical data, not investment advice. Past results don&apos;t predict future returns.
      </p>
    </div>
  );

  return (
    <main className="relative flex h-dvh flex-col overflow-hidden bg-[#070514] font-body text-white">
      <div aria-hidden className="sx-backdrop" />

      <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#070514]/70 px-4 backdrop-blur-xl sm:px-5">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="grid h-10 w-10 place-items-center rounded-full text-[#c9c3e6] hover:bg-white/[0.06] lg:hidden"
          aria-label="Open chat history"
        >
          <Icon d="M4 7h16M4 12h16M4 17h10" />
        </button>
        <Link href="/" aria-label="Bullseye home">
          <BullseyeLogo size={26} wordClassName="text-[20px]" />
        </Link>
        <span className="hidden rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-[#c9c3e6] sm:inline">Ask AI</span>
        <nav className="ml-auto flex items-center gap-2 sm:gap-4">
          {!isEmpty && (
            // The wrapper hides it on desktop: .sx-btn-ghost's own display
            // would override a lg:hidden on the button itself.
            <span className="lg:hidden">
              <button type="button" onClick={newChat} className="sx-btn-ghost !h-9">
                New chat
              </button>
            </span>
          )}
          <Link href="/?alerts=1" className="hdr-icon" aria-label="Daily alerts" title="Daily stock alerts">
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6ZM9.5 19a2.5 2.5 0 0 0 5 0" /></svg>
            <span className="hdr-label">Daily alerts</span>
          </Link>
          <Link href="/screens" className="hidden text-[13px] font-medium text-[#c9c3e6] hover:text-white sm:inline">
            Screener
          </Link>
          <Link href="/" className="hidden text-[13px] font-medium text-[#c9c3e6] hover:text-white sm:inline">
            Home
          </Link>
        </nav>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1">
        <aside className="hidden w-[280px] shrink-0 border-r border-white/[0.06] bg-[#0b0820]/60 lg:block">{sidebar}</aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto" data-lenis-prevent>
            {isEmpty ? (
              <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col px-4 py-10 sm:px-6">
                <div className="ai-rise mt-auto flex flex-col items-center text-center">
                  <span className="ai-orb">
                    <BullseyeMark size={30} className="text-white" />
                  </span>
                  <h1 className="mt-6 font-display text-[clamp(2.2rem,5.5vw,3.6rem)] leading-[1.04] text-white">
                    What do you want to <em className="nova-gradient-text italic">know?</em>
                  </h1>
                  <p className="mt-3 max-w-[48ch] text-[15px] leading-7 text-[#b9b4d6]">
                    Ask about any NSE stock, test a trading rule on real history, or get a concept explained.
                  </p>
                </div>
                <div className="ai-rise mt-8" style={{ animationDelay: '80ms' }}>
                  {composer}
                  <p className="mt-2.5 text-center text-[12px] text-[#7d7799]">Enter to send · Shift + Enter for a new line</p>
                </div>
                <div className="mb-auto mt-10 grid gap-3 sm:grid-cols-2">
                  {CAPABILITIES.map((cap, index) => (
                    <div key={cap.title} className="ai-rise ai-cap" style={{ animationDelay: `${160 + index * 60}ms` }}>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.06] text-[#ff79c0]">
                          <Icon d={cap.icon} className="h-4 w-4" />
                        </span>
                        <span className="text-[15px] font-semibold text-white">{cap.title}</span>
                      </div>
                      <p className="mt-2 text-[13px] leading-6 text-[#9f99c2]">{cap.blurb}</p>
                      <div className="mt-3 flex flex-col gap-1.5">
                        {cap.prompts.map(prompt => (
                          <button key={prompt} type="button" onClick={() => send(prompt)} className="ai-prompt">
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-[800px] flex-col gap-7 px-4 py-8 sm:px-6">
                {messages.map(message =>
                  message.role === 'user' ? (
                    <div key={message.id} className="ai-rise flex justify-end">
                      <div className="ai-bubble">{message.content}</div>
                    </div>
                  ) : (
                    <div key={message.id} className="ai-rise flex gap-3">
                      <span className={`ai-avatar ${message.error ? 'is-error' : ''}`}>
                        <BullseyeMark size={16} className="text-white" />
                      </span>
                      <div className="min-w-0 flex-1 pt-0.5">
                        {message.error ? (
                          <div className="rounded-2xl border border-[#ff5c7a]/30 bg-[#ff5c7a]/[0.07] px-4 py-3">
                            <p className="text-[14.5px] leading-7 text-[#ffc2cf]">{message.content}</p>
                            {message.retryPrompt && (
                              <button type="button" onClick={() => send(message.retryPrompt!)} disabled={loading} className="sx-btn-ghost mt-2 !h-8 !text-[12px]">
                                Try again
                              </button>
                            )}
                          </div>
                        ) : (
                          <>
                            <Markdown text={message.content} onRun={send} />
                            {message.data?.backtest && <BacktestCard data={message.data.backtest} ticker={message.data.target_stock ?? null} />}
                            {message.data?.strategy_alert && (
                              <StrategyCard data={message.data} saving={savingAlert === message.id} onSave={() => saveStrategyAlert(message).catch(() => {})} />
                            )}
                            {message.data?.mode === 'movers' && message.data.scan && <MoversCard data={message.data.scan as MoversScan} />}
                            {message.data?.mode === 'cross_scan' && message.data.scan && <ScanCard data={message.data.scan as Scan} />}
                            {message.data?.mode === 'screener' && message.data.screener && <ScreenerCard data={message.data.screener} />}
                            <div className="mt-3 flex items-center gap-3 text-[12px] text-[#7d7799]">
                              {message.thoughtMs !== undefined && <span>Answered in {duration(message.thoughtMs)}</span>}
                              <button type="button" onClick={() => copyAnswer(message)} className="inline-flex items-center gap-1 hover:text-white">
                                <Icon d="M9 9h10v10H9zM5 15V5h10" className="h-3.5 w-3.5" />
                                {copied === message.id ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                            {message.data?.suggestions && message.data.suggestions.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {message.data.suggestions.slice(0, 4).map(s => (
                                  <button key={s} type="button" onClick={() => send(s)} disabled={loading} className="scr-example disabled:opacity-50">
                                    {s}
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {loading && (
                  <div className="ai-rise flex gap-3" aria-live="polite">
                    <span className="ai-avatar is-thinking">
                      <BullseyeMark size={16} className="text-white" />
                    </span>
                    <div className="flex flex-wrap items-center gap-3 pt-1.5">
                      <span className="ai-shimmer text-[14.5px]">{thinkingLabel(elapsedMs)}</span>
                      <span className="font-numeric text-[12px] text-[#7d7799]">{duration(elapsedMs)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {!isEmpty && (
            <div className="shrink-0 px-4 pb-4 pt-2 sm:px-6">
              <div className="mx-auto w-full max-w-[800px]">
                {composer}
                <p className="mt-2 text-center text-[11.5px] text-[#7d7799]">
                  Research on historical data, not investment advice.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Outside the content layer so it sits above the header. */}
      {drawer.mounted && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div data-state={drawer.state} className="anim-fade absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <div data-state={drawer.state} className="ai-drawer absolute inset-y-0 left-0 w-[86vw] max-w-[320px] border-r border-white/10 bg-[#0d0a1f]">
            {sidebar}
          </div>
        </div>
      )}
    </main>
  );
}
