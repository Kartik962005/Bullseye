'use client';

import { useEffect, useState } from 'react';
import { usePresence } from '@/components/motion/usePresence';

// Cheap liveness endpoint (no market-data work) proxied same-origin through
// /api/backend, so this both wakes a sleeping Render instance and avoids CORS.
// The proxy only forwards /api/v1 paths, which is why the backend exposes
// /api/v1/health alongside the bare /health.
const WARMUP_URL = '/api/backend/api/v1/health';

// The Next proxy (app/api/backend/[...path]/route.ts) answers with 502/503/504
// only when it cannot reach the backend (i.e. Render is cold/asleep). Any other
// status means the backend responded and is awake.
const COLD_STATUSES = new Set([502, 503, 504]);

const SHOW_AFTER_MS = 4000;
// Pages show their own loading states, so the pill is a heads-up, not a
// blocker: it leaves on its own even if the server is still starting.
const HIDE_AFTER_MS = 12000;

/**
 * Wakes the Render free-tier backend on first load (pinging in the background
 * for up to ~2 minutes) and shows a small dismissible pill while it boots.
 */
export default function BackendWarmup() {
  const [waking, setWaking] = useState(false);
  const pill = usePresence(waking, 200);

  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let attempts = 0;
    const maxAttempts = 30;

    // Only show if the backend hasn't answered quickly, so a warm backend
    // never flashes it.
    const showTimer = setTimeout(() => {
      if (!cancelled && !ready) setWaking(true);
    }, SHOW_AFTER_MS);
    const hideTimer = setTimeout(() => {
      if (!cancelled) setWaking(false);
    }, SHOW_AFTER_MS + HIDE_AFTER_MS);

    async function ping() {
      attempts += 1;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(WARMUP_URL, { cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        if (cancelled) return;
        if (!COLD_STATUSES.has(res.status)) {
          ready = true;
          setWaking(false);
          return;
        }
      } catch {
        // network error / timeout => backend still cold, retry
      }
      if (!cancelled && attempts < maxAttempts) setTimeout(ping, 4000);
    }

    ping();
    return () => {
      cancelled = true;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  if (!pill.mounted) return null;

  return (
    <div role="status" aria-live="polite" data-state={pill.state} className="warmup-pill anim-pop">
      <span className="nova-spinner !h-3.5 !w-3.5" aria-hidden />
      <span>
        <span className="sm:hidden">Starting up…</span>
        <span className="hidden sm:inline">Starting up the market engine, data may take a few seconds</span>
      </span>
      <button type="button" onClick={() => setWaking(false)} aria-label="Dismiss" className="warmup-close">
        ×
      </button>
    </div>
  );
}
