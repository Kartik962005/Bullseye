'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePresence } from '@/components/motion/usePresence';
import { getSharedSupabaseClient } from '@/lib/supabase-browser';
import { attachUtmToUser, captureUtm, readUtm } from '@/lib/utm';

const NOTICE_KEY = 'bullseye-storage-notice';
// Waits a moment so the notice never competes with the first paint.
const SHOW_AFTER_MS = 1500;

/**
 * A one-time note about browser storage. Bullseye sets no advertising or
 * tracking cookies, so there is nothing to opt in to; this just says what is
 * stored and links to the privacy policy. Also records campaign tags from the
 * landing URL and saves them to the account once someone signs in.
 */
export function StorageNotice() {
  const [show, setShow] = useState(false);
  const presence = usePresence(show, 220);

  useEffect(() => {
    captureUtm();

    let seen = false;
    try {
      seen = localStorage.getItem(NOTICE_KEY) === '1';
    } catch {
      seen = true;
    }
    const timer = seen ? 0 : window.setTimeout(() => setShow(true), SHOW_AFTER_MS);

    // Only load the sign-in client when there are tags waiting to be saved.
    let unsubscribe: (() => void) | undefined;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key && readUtm()) {
      getSharedSupabaseClient(url, key).then(async sb => {
        if (!sb) return;
        const { data } = await sb.auth.getSession();
        await attachUtmToUser(sb, data?.session?.user ?? null);
        const listener = sb.auth.onAuthStateChange((event: string, session: { user?: { user_metadata?: Record<string, unknown> } } | null) => {
          if (event === 'SIGNED_IN') void attachUtmToUser(sb, session?.user ?? null);
        });
        unsubscribe = () => listener?.data?.subscription?.unsubscribe();
      });
    }

    return () => {
      if (timer) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      // Shows again next visit; harmless.
    }
  };

  if (!presence.mounted) return null;

  return (
    <div role="region" aria-label="Storage notice" data-state={presence.state} className="anim-pop storage-notice print:hidden">
      <p className="text-[13px] leading-5 text-[color:var(--ink-2)]">
        Bullseye uses no ad or tracking cookies. Your browser keeps your theme and sign-in, and visits are counted
        anonymously.{' '}
        <Link href="/privacy" className="text-[color:var(--fg)] underline underline-offset-2 hover:text-[color:var(--accent-text)]">
          Privacy policy
        </Link>
      </p>
      <button type="button" onClick={dismiss} className="nova-btn nova-btn-primary !h-9 shrink-0 !px-4 !text-[13px]">
        Got it
      </button>
    </div>
  );
}

export default StorageNotice;
