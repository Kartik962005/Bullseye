import Link from 'next/link';
import { StatusPage } from '@/components/StatusPage';

export const metadata = { title: 'Page not found · Bullseye' };

export default function NotFound() {
  return (
    <StatusPage
      code="404"
      title="This page is"
      accent="off the chart."
      body="The link may be old, or the address has a typo. Everything Bullseye does is one tap away from here."
    >
      <Link href="/" className="nova-btn nova-btn-primary !h-11 !text-[14px]">
        Back to home
      </Link>
      <Link href="/screens" className="nova-btn nova-btn-ghost !h-11 !text-[14px]">
        Open the screener
      </Link>
      <Link href="/ask-ai" className="nova-btn nova-btn-ghost !h-11 !text-[14px]">
        Ask AI
      </Link>
    </StatusPage>
  );
}
