"use client";

// Daily picks band: the call to action after the scroll story. Copy on the
// left; on the right, the picks for the current session (today's until the
// close, then the next session's) at a chosen holding period.

import { useEffect, useMemo, useState } from "react";
import {
  type Horizon,
  type Pick,
  type PickRun,
  DEFAULT_HORIZON,
  HORIZONS,
  loadPicks,
  notReadyMessage,
  prettyDate,
  sessionContext,
  sessionTitle,
} from "@/lib/daily-picks";

export interface DailySignalPreviewCardProps {
  signedIn: boolean;
  alertsEnabled: boolean;
  onOpenSettings: () => void;
}

const money = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

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
  const targetDate = run?.target_date ?? session.sessionDate;
  const preview = picks.slice(0, 4);

  return (
    <section className="w-full px-5 py-20 sm:px-10 lg:px-16">
      <div className="mx-auto grid max-w-[1180px] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-16">
        <div className="max-w-[34rem]">
          <div className="flex items-center gap-3">
            <span className="nova-dot" aria-hidden />
            <span className="font-numeric text-[11px] font-medium uppercase tracking-[0.3em] text-[color:var(--ink-2)]">
              Daily picks
            </span>
          </div>
          <h2 className="mt-5 font-display text-[clamp(2.2rem,4.4vw,3.6rem)] font-normal leading-[1] text-paper">
            Get the short list <em className="nova-gradient-text italic">in your inbox.</em>
          </h2>
          <p className="mt-4 max-w-[44ch] font-body text-[15px] leading-7 text-[color:var(--ink-2)]">
            Ranked after each close for the holding period you choose: the next day, 3 days or 5 days. Nothing is sent
            on days when no setup is worth taking.
          </p>
          <button type="button" onClick={onOpenSettings} className="nova-btn nova-btn-primary mt-7">
            {!signedIn ? "Sign in to get picks" : alertsEnabled ? "Manage daily picks" : "Set up daily picks"}
          </button>
        </div>

        <div className="nova-modal rounded-[24px] p-5 font-body sm:p-6" style={{ animation: "none" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-paper">{sessionTitle(targetDate, session.today)}</h3>
            <span className="text-[12px] text-[color:var(--ink-3)]">{prettyDate(targetDate)}</span>
          </div>
          <div className="sx-seg sx-seg-sm mt-3 flex w-full" role="radiogroup" aria-label="How long to hold">
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

          <ul className="mt-4 divide-y divide-white/10" aria-live="polite">
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
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">Couldn&apos;t load the picks right now.</li>
            ) : run?.status === "withheld" ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">
                {run.summary?.withheld_reason || "This holding period publishes no picks."}
              </li>
            ) : !run ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">
                {notReadyMessage(session)}
              </li>
            ) : preview.length === 0 ? (
              <li className="py-4 text-[13px] leading-6 text-[color:var(--ink-2)]">No setup cleared the bar for this session.</li>
            ) : (
              preview.map((pick) => (
                <li key={pick.id ?? pick.symbol} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 truncate font-numeric text-[14px] text-paper">{pick.symbol}</span>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 font-numeric text-[11px] ${
                      pick.direction === "BUY" ? "bg-[color:var(--up)]/12 text-[color:var(--up)]" : "bg-[color:var(--down)]/12 text-[color:var(--down)]"
                    }`}
                  >
                    {pick.direction}
                  </span>
                  <span className="ml-auto shrink-0 font-numeric text-[12.5px] text-[color:var(--ink-2)]">
                    Target {money(pick.target_price)}
                  </span>
                </li>
              ))
            )}
          </ul>

          <button type="button" onClick={onOpenSettings} className="sx-btn-ghost mt-4 w-full justify-center">
            {signedIn ? "See every pick with entry and stop" : "Sign in to see entry and stop"}
          </button>
        </div>
      </div>
    </section>
  );
}

export default DailySignalPreviewCard;
