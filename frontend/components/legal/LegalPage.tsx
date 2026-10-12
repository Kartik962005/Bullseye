import Link from 'next/link';
import type { ReactNode } from 'react';
import ScreensShell from '@/app/screens/ScreensShell';
import { LEGAL_LAST_UPDATED } from '@/lib/site';

export type LegalSection = { id: string; title: string; body: ReactNode };

/** Shared frame for the Privacy and Terms pages: summary up top, numbered sections, a contents list on wide screens. */
export function LegalPage({
  eyebrow,
  title,
  summary,
  sections,
  sibling,
}: {
  eyebrow: string;
  title: string;
  summary: ReactNode;
  sections: LegalSection[];
  sibling: { href: string; label: string };
}) {
  return (
    <ScreensShell>
      <div className="mx-auto grid max-w-[1040px] gap-12 lg:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav aria-label="On this page" className="sticky top-28">
            <div className="sx-label">On this page</div>
            <ol className="mt-4 space-y-2 text-[13px]">
              {sections.map((section, index) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="flex gap-2 text-[color:var(--ink-3)] transition hover:text-white">
                    <span className="w-5 shrink-0 font-mono text-[11.5px] leading-5 tabular-nums">{String(index + 1).padStart(2, '0')}</span>
                    <span className="leading-5">{section.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <article className="legal min-w-0 max-w-[68ch]">
          <span className="sx-label">{eyebrow}</span>
          <h1 className="mt-3 text-balance font-display text-[clamp(2.2rem,5vw,3.4rem)] leading-[1.05] tracking-[-0.01em] text-white">{title}</h1>
          <p className="mt-3 text-[13px] text-[color:var(--ink-3)]">
            Last updated <time>{LEGAL_LAST_UPDATED}</time>
          </p>

          <div className="sx-card mt-8 !rounded-2xl p-5 text-[14.5px] leading-7 text-[color:var(--ink-2)] sm:p-6">{summary}</div>

          <div className="mt-10 space-y-10">
            {sections.map((section, index) => (
              <section key={section.id} id={section.id} className="scroll-mt-28">
                <h2 className="flex items-baseline gap-3 text-[19px] font-semibold tracking-[-0.01em] text-white">
                  <span className="font-mono text-[12px] font-normal text-[color:var(--ink-3)] tabular-nums">{String(index + 1).padStart(2, '0')}</span>
                  {section.title}
                </h2>
                <div className="legal-body mt-3 space-y-3 text-[15px] leading-7 text-[color:var(--ink-2)]">{section.body}</div>
              </section>
            ))}
          </div>

          <div className="mt-14 flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-6 text-[14px]">
            <Link href={sibling.href} className="nova-btn nova-btn-ghost !h-10 !px-4 !text-[13.5px]">
              {sibling.label}
            </Link>
            <Link href="/" className="text-[color:var(--ink-3)] transition hover:text-white">
              Back to Bullseye
            </Link>
          </div>
        </article>
      </div>
    </ScreensShell>
  );
}

export default LegalPage;
