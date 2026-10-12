'use client';

/**
 * First-touch campaign tags. When someone lands from a link carrying utm_*
 * tags, the tags are kept in local storage (the first set wins) and saved to
 * the account's metadata if they sign up, so we can tell which links bring
 * people in. The tags describe the link, not the person.
 */

const UTM_STORAGE_KEY = 'bullseye-utm';
const UTM_SAVED_KEY = 'bullseye-utm-saved';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

export type FirstTouch = Partial<Record<(typeof UTM_KEYS)[number], string>> & { landing: string; at: string };

export function captureUtm(): void {
  try {
    if (localStorage.getItem(UTM_STORAGE_KEY)) return;
    const params = new URLSearchParams(window.location.search);
    const tags: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
    for (const key of UTM_KEYS) {
      const value = params.get(key)?.trim();
      if (value) tags[key] = value.slice(0, 120);
    }
    if (!Object.keys(tags).length) return;
    const touch: FirstTouch = { ...tags, landing: window.location.pathname, at: new Date().toISOString() };
    localStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(touch));
  } catch {
    // Storage blocked (private mode); tracking is optional.
  }
}

export function readUtm(): FirstTouch | null {
  try {
    const raw = localStorage.getItem(UTM_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FirstTouch) : null;
  } catch {
    return null;
  }
}

/**
 * Saves the first-touch tags to a signed-in user's metadata once. Works for
 * both email sign-up and Google sign-in, which cannot carry extra data itself.
 */
export async function attachUtmToUser(
  sb: { auth: { updateUser: (attrs: { data: Record<string, unknown> }) => Promise<unknown> } },
  user: { user_metadata?: Record<string, unknown> } | null,
): Promise<void> {
  if (!user) return;
  try {
    if (localStorage.getItem(UTM_SAVED_KEY) === '1') return;
    if (user.user_metadata?.first_touch) {
      localStorage.setItem(UTM_SAVED_KEY, '1');
      return;
    }
    const touch = readUtm();
    if (!touch) return;
    await sb.auth.updateUser({ data: { first_touch: touch } });
    localStorage.setItem(UTM_SAVED_KEY, '1');
  } catch {
    // Not worth interrupting sign-in over.
  }
}
