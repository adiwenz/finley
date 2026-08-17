/**
 * The frame every screen sits in: a 62px header over a body that the active screen fills.
 *
 * The header is the only persistent chrome — nothing else in the app is fixed or floating. It
 * carries the wordmark (display type at 800, since no logo mark exists), the save state, and the
 * two controls that are always available. The wordmark is the way home.
 *
 * `narrow` is threaded down rather than read per-component so the whole app agrees on one
 * breakpoint: at 900px the rail moves below the chart and the drawer becomes a bottom sheet, and
 * those must switch together or the layout tears.
 */

import type { ReactNode } from "react";
import { Button } from "../ds";
import moneyTree from "../../assets/money-tree.png";

export interface AppShellProps {
  readonly saveHint: string;
  readonly onSave: () => void;
  readonly onHome: () => void;
  readonly onSettings: () => void;
  readonly narrow: boolean;
  readonly children: ReactNode;
}

export function AppShell({
  saveHint,
  onSave,
  onHome,
  onSettings,
  narrow,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-page font-sans text-body">
      <header className="z-60 flex h-[62px] shrink-0 items-center justify-between border-b border-border-subtle bg-surface-page px-6">
        <button
          type="button"
          onClick={onHome}
          className="flex items-center gap-2.5 rounded-pill"
          aria-label="Go to your plan"
        >
          {/* No logo mark exists in the design system and none was invented: where a mark would
              go, the brand name is set in display type at 800 / -0.03em, paired with the brand
              illustration. 32px is the system's one sanctioned small use of the artwork —
              everywhere else it is presented large. Decorative here, so `alt` stays empty: the
              wordmark beside it already names the brand, and the button carries its own label. */}
          <img src={moneyTree} alt="" className="block h-8 w-8 object-contain" />
          <span className="font-display text-[21px] font-extrabold tracking-[-0.03em] text-leaf-900">
            Project Money Tree
          </span>
        </button>

        <div className="flex items-center gap-1.5">
          <span className="mr-2 text-[13px] text-muted">{saveHint}</span>
          <Button variant="ghost" size="sm" onClick={onSave}>
            Save
          </Button>
          <Button variant="secondary" size="sm" onClick={onSettings}>
            Settings
          </Button>
        </div>
      </header>

      <div
        className={[
          "relative flex min-h-0 flex-1",
          narrow ? "flex-col overflow-y-auto" : "flex-row overflow-visible",
        ].join(" ")}
      >
        {children}
      </div>
    </div>
  );
}
