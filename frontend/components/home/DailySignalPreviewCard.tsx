"use client";

// Daily-signals band: the one call to action after the scroll story. Same
// left-column pattern as the story beats (copy left, content right) and kept
// compact: two delivery buttons and a three-line preview, not a full email.

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
  const preview = signals.slice(0, 3);

  return (
    <section className="w-full px-5 py-20 sm:px-10 lg:px-16">
      <div className="mx-auto grid max-w-[1180px] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
        <div className="max-w-[34rem]">
          <div className="flex items-center gap-3">
            <span className="nova-dot" aria-hidden />
            <span className="font-numeric text-[11px] font-medium uppercase tracking-[0.3em] text-[#cfc9ea]">
              Daily signals
            </span>
          </div>
          <h2 className="mt-5 font-display text-[clamp(2.2rem,4.4vw,3.6rem)] font-normal leading-[1] text-paper">
            Get the short list <em className="nova-gradient-text italic">in your inbox.</em>
          </h2>
          <p className="mt-4 max-w-[44ch] font-body text-[15px] leading-7 text-[#d6d0f0]">
            Ranked picks after the close, sent to {signedIn && userEmail ? userEmail : "your account"}. Nothing
            is sent on days when no setup is worth taking.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            disabled={isSaving}
            className="nova-btn nova-btn-primary mt-7 disabled:opacity-60"
          >
            {signedIn ? "Set up daily alerts" : "Sign in to get alerts"}
          </button>
        </div>

        <div className="nova-modal rounded-[24px] p-5 font-body sm:p-6" style={{ animation: "none" }}>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["today", "Today's list", "Intraday, latest data"],
                ["next_day", "Next-day list", "Top 10 for tomorrow"],
              ] as const
            ).map(([mode, title, sub]) => (
              <button
                key={mode}
                type="button"
                onClick={() => (signedIn ? onSendNow(mode) : onOpenSettings())}
                disabled={isSaving}
                className="rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 text-left transition hover:border-[#ff4fa3]/60 hover:bg-[#ff4fa3]/10 disabled:opacity-60"
              >
                <span className="block text-[14px] font-semibold text-paper">{title}</span>
                <span className="mt-0.5 block text-[12px] text-[#b9b4d6]">{sub}</span>
              </button>
            ))}
          </div>

          {(error || message) && (
            <p className={`mt-3 text-[13px] ${error ? "text-[#ff7a93]" : "text-[#6ff0b5]"}`}>{error || message}</p>
          )}

          <div className="mt-5 flex items-center justify-between">
            <span className="text-[12px] font-medium uppercase tracking-[0.18em] text-[#b9b4d6]">Preview</span>
            <span className="text-[12px] text-[#8f89ad]">Target · Confidence</span>
          </div>
          <ul className="mt-2 divide-y divide-white/10">
            {preview.length > 0 ? (
              preview.map((signal) => (
                <li key={signal.symbol} className="flex items-center gap-3 py-2.5">
                  <span className="font-numeric text-[14px] text-paper">{signal.symbol}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 font-numeric text-[11px] ${
                      signal.direction === "BUY" ? "bg-[#3dffa2]/12 text-[#6ff0b5]" : "bg-[#ff4d6d]/12 text-[#ff7a93]"
                    }`}
                  >
                    {signal.direction}
                  </span>
                  <span className="ml-auto font-numeric text-[13px] text-[#d6d0f0]">
                    ₹{signal.target_price.toFixed(2)}
                  </span>
                  <span className="w-10 text-right font-numeric text-[13px] text-paper">
                    {Math.round((signal.confidence ?? 0) * 100)}%
                  </span>
                </li>
              ))
            ) : (
              <li className="py-4 text-[13px] leading-6 text-[#b9b4d6]">
                The preview fills in after tonight&apos;s engine run.
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default DailySignalPreviewCard;
