"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { usePresence } from "@/components/motion/usePresence";

export type ModalSize = "sm" | "md" | "lg";

const SIZE: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  size?: ModalSize;
  children?: ReactNode;
}

/** Overlay dialog. Closes on Escape and backdrop click. */
export function Modal({ open, onClose, title, size = "md", children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const presence = usePresence(open, 220);
  if (!presence.mounted) return null;

  return (
    <>
      <div data-state={presence.state} className="anim-fade nova-modal-backdrop fixed inset-0 z-[72]" onClick={onClose} />
      <div data-lenis-prevent className="fixed inset-0 z-[73] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          data-state={presence.state}
          className={cn(
            "anim-dialog nova-auth my-4 w-full rounded-3xl p-5 text-white sm:p-6",
            SIZE[size],
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {title != null && (
            <h3 className="mb-4 font-body text-xl font-bold text-white">{title}</h3>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
