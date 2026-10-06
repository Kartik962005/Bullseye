'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { StatusPage } from '@/components/StatusPage';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      code={error.digest ? `ERROR · ${error.digest}` : 'ERROR'}
      title="Something"
      accent="slipped."
      body="This page hit an unexpected problem. Trying again usually fixes it; if the server was asleep it may need a few seconds to wake up."
    >
      <button type="button" onClick={reset} className="nova-btn nova-btn-primary !h-11 !text-[14px]">
        Try again
      </button>
      <Link href="/" className="nova-btn nova-btn-ghost !h-11 !text-[14px]">
        Back to home
      </Link>
    </StatusPage>
  );
}
