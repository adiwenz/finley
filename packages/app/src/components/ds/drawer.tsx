/**
 * The slide-in drawer every editor and summary opens in.
 *
 * One surface for all of them, because the app's editing model is "the plan stays on screen
 * while you change one thing about it" — the drawer is narrow and left-anchored so the
 * projection it is about remains visible and updates as the reader types.
 *
 * Wide: enters from the left edge with `fin-slide`. Narrow: becomes a bottom sheet and enters
 * with `fin-rise`, since a 412px rail has nowhere to go on a phone. Both are the system's
 * 220ms settle; nothing scales in from zero.
 *
 * The scrim is green-tinted (`--scrim-overlay`), never black — one of only two places the
 * system permits transparency.
 */

import { useEffect, type ReactNode } from "react";
import { IconButton } from "./button";

export interface DrawerProps {
  readonly title: string;
  readonly sub?: string;
  readonly onClose: () => void;
  /** True below the 900px breakpoint, where the drawer becomes a bottom sheet. */
  readonly narrow: boolean;
  readonly children: ReactNode;
  /** The sticky action bar. Absent for read-only summary drawers, which have nothing to commit. */
  readonly footer?: ReactNode;
}

export function Drawer({ title, sub, onClose, narrow, children, footer }: DrawerProps) {
  // Escape closes. Bound on the document rather than the panel so it works before anything
  // inside has taken focus — the drawer opens from a click elsewhere on the page.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <div
        onClick={onClose}
        className="pointer-events-auto absolute inset-0 bg-[rgba(15,61,40,0.16)]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={[
          "pointer-events-auto absolute bottom-0 left-0 flex flex-col bg-surface-card shadow-lg",
          narrow
            ? "top-[22%] right-0 rounded-t-[28px] animate-fin-rise"
            : "top-0 w-[412px] border-r border-border-subtle animate-fin-slide",
        ].join(" ")}
      >
        <header className="flex items-center gap-2 border-b border-border-subtle px-4.5 pt-4 pb-3">
          <IconButton name="arrow-left" label="Close" size="sm" onClick={onClose} />
          <div className="min-w-0 flex-1">
            <div className="font-display text-[19px] font-bold tracking-tight text-leaf-900">
              {title}
            </div>
            {sub ? <div className="text-[13px] text-muted">{sub}</div> : null}
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-4.5 overflow-y-auto px-4.5 py-5">{children}</div>

        {footer ? (
          <footer className="flex items-center gap-2.5 border-t border-border-subtle bg-surface-page px-4.5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}
