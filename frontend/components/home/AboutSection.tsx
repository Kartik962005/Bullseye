"use client";

// Why Bullseye + the risk disclaimer. The disclaimer is a hard requirement for
// a stock-research product: it must stay on the homepage, in plain language,
// right before the footer. Same left-column pattern as the sections above.

const PRINCIPLES = [
  {
    title: "Win rate is not profit",
    body: "A high hit rate with tiny wins and rare huge losses is a trap. Every call carries its own reward-to-risk, and the track record shows both.",
  },
  {
    title: "Some days you sit out",
    body: "When the market is weak, Bullseye returns fewer calls or none, rather than inventing a trade to fill the screen.",
  },
  {
    title: "Every number is checkable",
    body: "Signals come from real price data and a model that is retrained and scored in the open. When data is missing, it says so.",
  },
];

export function AboutSection() {
  return (
    <section className="w-full px-5 pb-16 pt-6 sm:px-10 lg:px-16">
      <div className="mx-auto max-w-[1180px]">
        <div className="max-w-[34rem]">
          <div className="flex items-center gap-3">
            <span className="nova-dot" aria-hidden />
            <span className="font-numeric text-[11px] font-medium uppercase tracking-[0.3em] text-[#cfc9ea]">
              Why Bullseye
            </span>
          </div>
          <h2 className="mt-5 font-display text-[clamp(2.2rem,4.4vw,3.6rem)] font-normal leading-[1] text-paper">
            Honest before it is <em className="nova-gradient-text italic">impressive.</em>
          </h2>
        </div>

        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {PRINCIPLES.map((principle) => (
            <div key={principle.title} className="border-t border-white/12 pt-5">
              <h3 className="font-display text-[22px] leading-snug text-paper">{principle.title}</h3>
              <p className="mt-2 font-body text-[14px] leading-6 text-[#c9c3e6]">{principle.body}</p>
            </div>
          ))}
        </div>

        <aside
          aria-labelledby="disclaimer-heading"
          className="mt-12 rounded-2xl border border-[#ffb547]/30 bg-[#ffb547]/[0.06] p-5 sm:p-6"
        >
          <h3 id="disclaimer-heading" className="font-body text-[13px] font-semibold uppercase tracking-[0.16em] text-[#ffcf85]">
            Disclaimer
          </h3>
          <p className="mt-2 font-body text-[14px] leading-6 text-[#e9e5ff]">
            Bullseye is a research and education tool, not investment advice. It is not registered with SEBI as an
            investment adviser or research analyst. Signals are produced by statistical models and can be wrong;
            past hit rates do not guarantee future results. Trading and investing in equities carries risk,
            including the loss of your capital. Do your own research, or consult a SEBI-registered adviser, before
            acting on anything shown here. You are solely responsible for your investment decisions.
          </p>
        </aside>
      </div>
    </section>
  );
}

export default AboutSection;
