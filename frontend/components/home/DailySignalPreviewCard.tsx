"use client";

// Daily calls band: the call to action after the scroll story. Copy on the
// left; on the right, the calls for the current session (today's until the
// close, then the next trading session's) at a chosen horizon.

import { useEffect, useMemo, useState } from "react";
import {
  type Horizon,
  type Pick,
  type PickRun,
  DEFAULT_HORIZON,
  HORIZONS,
  callChance,
  loadPicks,
  notReadyMessage,
  sessionContext,
  windowLabel,
} from "@/lib/daily-picks";

export interface DailySignalPreviewCardProps {
  signedIn: boolean;
  alertsEnabled: boolean;
  onOpenSettings: () => void;
}

function CallRow({ pick }: { pick: Pick }) {
  const forecast = pick.explanation_json?.forecast;
  const buy = pick.direction === "BUY";
  const chance = forecast ? callChance(forecast, pick.direction) : pick.confidence;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className={`w-10 shrink-0 rounded-md py-0.5 text-center font-numeric text-[10.5px] font-semibold ${
          buy ? "bg-[color:var(--up)]/12 text-[color:var(--up)]" : "bg-[color:var(--down)]/12 text-[color:var(--down)]"
        }`}
      >
        {buy ? "BUY" : "SELL"}
      </span>
      <span className="min-w-0 truncate font-numeric text-[14px] text-paper">{pick.symbol}</span>
      <span className="ml-auto shrink-0 font-numeric text-[12.5px] text-[color:var(--ink-2)]">
        {Math.round(chance * 100)}% to {buy ? "beat" : "lag"}
      </span>
    </li>
  );
}

export function DailySignalPreviewCard({ signedIn, alertsEnabled, onOpenSettings }: DailySignalPreviewCardProps) {
  const [horizon, setHorizon] = useState<Horizon>(DEFAULT_HORIZON);
  // Results are keyed by what they were loaded for; anything else is still loading.
  const key = `${horizon}:${signedIn}`;
  const [result, setResult] = useState<{ key: string; state: "ready" | "error"; run: PickRun | null; picks: Pick[] } | null>(null);
  const [slowKey, setSlowKey] = useState<string | null>(null);
  const session = useMemo(() => sessionContext(), []);

  useEffect(() => {
    let cancelled = false;
    loadPicks({ horizon, risk: "Balanced", signedIn }, () => !cancelled && setSlowKey(key))
      .then((loaded) => !cancelled && setResult({ key, state: "ready", ...loaded }))
      .catch(() => !cancelled && setResult({ key, state: "error", run: null, picks: [] }));
    return () => {
      cancelled = true;
    };
  }, [horizon, signedIn, key]);

  const current = result?.key === key ? result : null;
  const state = current ? current.state : slowKey === key ? "slow" : "loading";
  const run = current?.run ?? null;
  const picks = current?.picks ?? [];
  const firstSession = run?.target_date ?? session.sessionDate;
  const preview = [
    ...picks.filter((p) => p.direction === "BUY").slice(0, horizon === 1 ? 3 : 4),
    ...picks.filter((p) => p.direction === "SELL").slice(0, horizon === 1 ? 2 : 0),
  ];

  return (
    <section className="w-full px-5 py-20 sm:px-10 lg:px-16">
      <div className="mx-auto grid max-w-[1180px] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-16">
        <div className="max-w-[34rem]">
          <div className="flex items-center gap-3">
            <span className="nova-dot" aria-hidden />
            <span className="font-numeric text-[11px] font-medium uppercase tracking-[0.3em] text-[color:var(--ink-2)]">
              Daily calls
            </span>
          </div>
          <h2 className="mt-5 font-display text-[clamp(2.2rem,4.4vw,3.6rem)] font-normal leading-[1] text-paper">
            Buy and sell calls <em className="nova-gradient-text italic">every evening.</em>
          </h2>
          <p className="mt-4 max-w-[44ch] font-body text-[15px] leading-7 text-[color:var(--ink-2)]">
            After each close the model ranks the Nifty 200: intraday buy and sell calls for the next session, and buy
            calls for 3 and 5 trading days, each with its expected price, likely range and how often calls like it
            were right in testing.
          </p>
          <button type="button" onClick={onOpenSettings} className="nova-btn nova-btn-primary mt-7">
            {!signedIn ? "Sign in to see every call" : alertsEnabled ? "Open daily calls" : "See every call"}
          </button>
        </div>

        <div className="nova-modal rounded-[24px] p-5 font-body sm:p-6" style={{ animation: "none" }}>
          <div className="sx-seg sx-seg-sm flex w-full" role="radiogroup" aria-label="Horizon">
            {HORIZONS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={horizon === item.value}
                onClick={() => setHorizon(item.value)}
                className="min-w-0 flex-1 !px-2"
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-paper">{windowLabel(firstSession, horizon)}</h3>
            <span className="text-[12px] text-[color:var(--ink-3)]">
              {horizon === 1 ? "open to close" : `${horizon} trading sessions`}
            </span>
          </div>

          <ul className="mt-2 divide-y divide-white/10" aria-live="polite">
            {state === "loading" || state === "slow" ? (
              <>
                {[0, 1, 2].map((i) => (
                  <li key={i} className="py-2.5">
                    <div className="sx-skeleton h-[22px] rounded-lg" />
                  </li>
                ))}
                {state === "slow" && (
                  <li className="pt-3 text-[12.5px] text-[color:var(--ink-3)]">Waking the server, this can take up to a minute…</li>
                )}
              </>
            ) : state === "error" ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">Couldn&apos;t load the calls right now.</li>
            ) : run?.status === "withheld" ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">
                {run.summary?.withheld_reason || "No calls for this horizon yet."}
              </li>
            ) : !run ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">{notReadyMessage(session)}</li>
            ) : preview.length === 0 ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">No calls for this session.</li>
            ) : (
              preview.map((pick) => <CallRow key={pick.id ?? `${pick.direction}-${pick.symbol}`} pick={pick} />)
            )}
          </ul>

          <button type="button" onClick={onOpenSettings} className="sx-btn-ghost mt-4 w-full justify-center">
            {signedIn ? "See every call with price and range" : "Sign in to see prices and ranges"}
          </button>
        </div>
      </div>
    </section>
  );
}

export default DailySignalPreviewCard;
