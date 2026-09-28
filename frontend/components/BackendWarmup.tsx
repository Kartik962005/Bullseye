'use client';

import { useEffect, useState } from 'react';

// Cheap liveness endpoint (no market-data work) proxied same-origin through
// /api/backend, so this both wakes a sleeping Render instance and avoids CORS.
// The proxy only forwards /api/v1 paths, which is why the backend exposes
// /api/v1/health alongside the bare /health.
const WARMUP_URL = '/api/backend/api/v1/health';

// The Next proxy (app/api/backend/[...path]/route.ts) answers with 502/503/504
// only when it cannot reach the backend (i.e. Render is cold/asleep). Any other
// status means the backend responded and is awake.
const COLD_STATUSES = new Set([502, 503, 504]);

/**
 * Wakes the Render free-tier backend on first load and shows a small status
 * pill while it boots, instead of letting the UI render empty tables or stale
 * prices during the ~30-60s cold start.
 */
export default function BackendWarmup() {
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let attempts = 0;
    const maxAttempts = 30; // ~2 minutes of retries

    // Only reveal the banner if the backend hasn't answered within 2.5s, so a
    // warm backend never flashes it.
    const slowTimer = setTimeout(() => {
      if (!cancelled && !ready) setWaking(true);
    }, 2500);

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
        // network error / timeout => backend still cold, fall through to retry
      }
      if (cancelled) return;
      if (attempts < maxAttempts) {
        setTimeout(ping, 4000);
      } else {
        setWaking(false); // give up quietly; per-page error states take over
      }
    }

    ping();
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, []);

  if (!waking) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderRadius: 9999,
        background: 'rgba(9,9,11,0.92)',
        color: '#fafafa',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
        fontSize: 13,
        lineHeight: 1.35,
        fontFamily: 'var(--font-inter), system-ui, sans-serif',
        maxWidth: '92vw',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          flexShrink: 0,
          borderRadius: '50%',
          border: '2px solid rgba(250,250,250,0.35)',
          borderTopColor: '#22c55e',
          display: 'inline-block',
          animation: 'bullseye-warmup-spin 0.8s linear infinite',
        }}
      />
      <span>
        Waking up the live market engine — this takes ~30s after a period of inactivity.
        Prices and scans will refresh automatically.
      </span>
      <style>{`@keyframes bullseye-warmup-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
