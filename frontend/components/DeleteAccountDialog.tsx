'use client';

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '@/components/motion/usePresence';
import { BACKEND } from '@/lib/client-cache';

const CONFIRM_WORD = 'DELETE';

type Props = {
  open: boolean;
  email?: string | null;
  onClose: () => void;
  getAccessToken: () => Promise<string | null>;
  /** Runs after the server has removed the account; sign the user out here. */
  onDeleted: () => void | Promise<void>;
};

/**
 * Confirmation step for permanently removing an account. The user types
 * DELETE so a stray tap cannot wipe their alerts and history.
 */
export function DeleteAccountDialog({ open, email, onClose, getAccessToken, onDeleted }: Props) {
  const presence = usePresence(open, 220);
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const close = () => {
    if (busy) return;
    setTyped('');
    setError('');
    setDone(false);
    onClose();
  };

  const confirm = async () => {
    if (typed.trim().toUpperCase() !== CONFIRM_WORD || busy) return;
    setBusy(true);
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Your session has expired. Sign in again, then delete your account.');
      const response = await fetch(`${BACKEND}/api/v1/account`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || 'Your account could not be deleted right now. Please try again in a minute.');
      setDone(true);
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your account could not be deleted right now.');
    } finally {
      setBusy(false);
    }
  };

  if (!presence.mounted || typeof document === 'undefined') return null;

  const ready = typed.trim().toUpperCase() === CONFIRM_WORD;

  return createPortal(
    <div
      onClick={close}
      role="presentation"
      data-state={presence.state}
      style={{ isolation: 'isolate', transform: 'translateZ(0)' }}
      className="anim-fade nova-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        onClick={event => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${inputId}-title`}
        aria-describedby={`${inputId}-body`}
        data-lenis-prevent
        data-state={presence.state}
        className="anim-dialog nova-auth w-full max-w-[400px] rounded-2xl p-7 font-body"
      >
        {done ? (
          <>
            <h2 id={`${inputId}-title`} className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-white">
              Your account is deleted
            </h2>
            <p id={`${inputId}-body`} className="mt-2 text-[14px] leading-6 text-[color:var(--ink-2)]">
              Your alerts, saved strategies, Ask AI history and email settings have been removed, and you have been signed out.
            </p>
            <button type="button" onClick={close} className="nova-btn nova-btn-primary mt-6 !h-11 w-full !text-[14px]">
              Done
            </button>
          </>
        ) : (
          <>
            <h2 id={`${inputId}-title`} className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-white">
              Delete your account?
            </h2>
            <div id={`${inputId}-body`} className="mt-2 space-y-3 text-[14px] leading-6 text-[color:var(--ink-2)]">
              <p>
                This permanently removes {email ? <span className="text-white">{email}</span> : 'your account'} and everything saved with it:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-[13.5px]">
                <li>price alerts and their history</li>
                <li>saved strategies and their signals</li>
                <li>Ask AI conversations</li>
                <li>daily email settings and the record of emails sent</li>
              </ul>
              <p>It cannot be undone. You can sign up again later with the same email.</p>
            </div>

            <label htmlFor={inputId} className="mt-5 block text-[13px] font-medium text-[color:var(--ink-2)]">
              Type <span className="font-mono text-white">{CONFIRM_WORD}</span> to confirm
            </label>
            <input
              id={inputId}
              value={typed}
              onChange={event => setTyped(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && confirm()}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="nova-field mt-1.5"
            />

            {error && <p role="alert" className="mt-3 text-[13px] text-[color:var(--down)]">{error}</p>}

            <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row">
              <button type="button" onClick={close} disabled={busy} className="nova-btn nova-btn-ghost !h-11 flex-1 !text-[14px]">
                Keep my account
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={!ready || busy}
                className="h-11 flex-1 rounded-xl bg-[color:var(--down)] text-[14px] font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default DeleteAccountDialog;
