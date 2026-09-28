"use client";

export type SignalDeliveryMode = "today" | "next_day";

export type DailySignalPreview = {
  symbol: string;
  direction: "BUY" | "SELL";
  entry_low: number;
  entry_high: number;
  target_price: number;
  stop_loss: number;
  confidence: number;
  risk_reward: number;
  explanation_json?: { reasons?: string[] };
};

export interface DailySignalPreviewCardProps {
  signedIn: boolean;
  userEmail?: string | null;
  signals: DailySignalPreview[];
  isSaving: boolean;
  message?: string;
  error?: string;
  onOpenSettings: () => void;
  onSendNow: (deliveryMode: SignalDeliveryMode) => void;
}

/** Shared surface treatment with the hero signal card: gold hairline, dark glass. */
const CARD_SURFACE = {
  background:
    "linear-gradient(145deg, rgba(20,22,19,0.94) 0%, rgba(8,10,9,0.97) 55%, rgba(16,18,15,0.94) 100%)",
  boxShadow: "0 26px 70px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,79,163,0.16)",
} as const;

export function DailySignalPreviewCard({
  signedIn,
  userEmail,
  signals,
  isSaving,
  message,
  error,
  onOpenSettings,
  onSendNow,
}: DailySignalPreviewCardProps) {
  const destination = signedIn ? userEmail || "your signed-in account" : "your signed-in account";

  return (
    <div
      className="overflow-hidden rounded-[24px] border border-accent/35 p-7 sm:p-9"
      style={CARD_SURFACE}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="inline-flex h-[5px] w-[5px] rounded-full bg-accent" />
        <span className="font-body text-[10px] font-medium uppercase tracking-[0.26em] text-accent">
          Daily signal email
        </span>
      </div>

      <h3 className="mt-5 max-w-[24ch] font-display text-[clamp(1.5rem,2.6vw,2.1rem)] leading-tight text-paper">
        Next-session stocks, packaged like an email preview.
      </h3>
      <p className="mt-3 max-w-[62ch] font-body text-[14px] leading-7 text-paper-muted">
        Signals go to {destination}. Fewer are sent when the market is weak and few names clear the
        quality bar.
      </p>

      {/* Delivery modes */}
      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => (signedIn ? onSendNow("today") : onOpenSettings())}
          disabled={isSaving}
          className="rounded-2xl border border-accent/30 bg-accent/[0.06] px-5 py-5 text-left transition duration-300 hover:border-accent/60 hover:bg-accent/[0.11] disabled:opacity-60"
        >
          <span className="block font-display text-[18px] leading-none text-paper">Today&apos;s stocks</span>
          <span className="mt-2.5 block font-body text-[12px] leading-6 text-paper-muted">
            Same-day intraday email using the latest available data.
          </span>
        </button>
        <button
          type="button"
          onClick={() => (signedIn ? onSendNow("next_day") : onOpenSettings())}
          disabled={isSaving}
          className="rounded-2xl border border-primary/25 bg-primary/[0.06] px-5 py-5 text-left transition duration-300 hover:border-primary/55 hover:bg-primary/[0.11] disabled:opacity-60"
        >
          <span className="block font-display text-[18px] leading-none text-paper">Next-day stocks</span>
          <span className="mt-2.5 block font-body text-[12px] leading-6 text-paper-muted">
            Ranked 10-stock email for the next trading day.
          </span>
        </button>
      </div>

      {(error || message) && (
        <div className="mt-5 space-y-2">
          {error && (
            <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 font-body text-[13px] text-rose-200">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 font-body text-[13px] text-primary">
              {message}
            </div>
          )}
        </div>
      )}

      {/* Signal rows — miniature signal cards */}
      <div className="mt-7 space-y-3">
        {signals.length > 0 ? (
          signals.slice(0, 4).map((signal) => (
            <div
              key={signal.symbol}
              className="rounded-2xl border border-hairline bg-white/[0.03] p-4 transition duration-300 hover:border-accent/30"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-numeric text-[15px] tracking-tight text-paper">{signal.symbol}</div>
                <div
                  className={`font-body text-[10px] font-semibold uppercase tracking-[0.2em] ${
                    signal.direction === "BUY" ? "text-primary" : "text-rose-300"
                  }`}
                >
                  {signal.direction}
                </div>
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-7 gap-y-2">
                {[
                  ["Entry", `${signal.entry_low.toFixed(2)}–${signal.entry_high.toFixed(2)}`],
                  ["Target", signal.target_price.toFixed(2)],
                  ["Stop", signal.stop_loss.toFixed(2)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="font-body text-[9px] uppercase tracking-[0.2em] text-paper-muted">{label}</dt>
                    <dd className="mt-1 font-numeric text-[13px] text-paper">{value}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-3.5 flex items-center gap-3">
                <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.round((signal.confidence ?? 0) * 100)}%` }}
                  />
                </div>
                <span className="font-numeric text-[11px] text-primary">
                  {Math.round((signal.confidence ?? 0) * 100)}
                </span>
                {typeof signal.risk_reward === "number" && (
                  <span className="font-numeric text-[11px] text-paper-muted">
                    R:R {signal.risk_reward.toFixed(2)}
                  </span>
                )}
              </div>

              <p className="mt-2.5 font-body text-[11px] leading-5 text-paper-muted">
                {(signal.explanation_json?.reasons ?? []).slice(0, 2).join(" · ") ||
                  "Model-ranked technical setup"}
              </p>
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-hairline bg-white/[0.02] px-5 py-8 text-center">
            <div className="font-display text-[18px] text-paper">No preview loaded</div>
            <p className="mx-auto mt-2 max-w-[46ch] font-body text-[13px] leading-6 text-paper-muted">
              The latest next-trading-day preview appears once the prediction engine runs for your
              signed-in account.
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        disabled={isSaving}
        className="mt-7 inline-flex h-12 w-full items-center justify-center rounded-full bg-accent px-6 font-body text-[13px] font-semibold text-black transition duration-300 hover:bg-accent-dim disabled:opacity-60"
      >
        {signedIn ? "Configure daily alerts" : "Sign in to configure"}
      </button>
    </div>
  );
}

export default DailySignalPreviewCard;
