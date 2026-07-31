/**
 * Where a non-editable obligation is *really* edited. `editable` is false for everything the
 * user did not author as a budget line, so its row here is read-only and points at the surface
 * that owns the number instead — provenance ({@link FinancialObligation.sourceKind}) decides
 * which. There is no router: the app is one scrolling page, so a deep link is an in-page anchor
 * to the card that authors the fact.
 */

import type { FinancialObligation } from "@finley/engine";

/** Anchor ids the deep links target; the owning cards carry these ids (`main.tsx`). */
export const OBLIGATION_SURFACE_ANCHORS = {
  /** The life-events timeline, where event-spawned expenses and loans are authored. */
  timeline: "timeline",
} as const;

export interface ObligationEditLink {
  readonly href: string;
  readonly text: string;
}

/**
 * The deep link for a non-editable obligation, or null when there is nowhere to send the user:
 * an authored budget line is edited in place here (never linked away) — health included, since
 * it is an ordinary line now rather than a plan input — and an `untracked` stream carries no
 * authoring surface at all.
 */
export function obligationEditLink(obligation: FinancialObligation): ObligationEditLink | null {
  switch (obligation.sourceKind) {
    case "event":
      return { href: `#${OBLIGATION_SURFACE_ANCHORS.timeline}`, text: "Edit its event" };
    case "liability":
      return { href: `#${OBLIGATION_SURFACE_ANCHORS.timeline}`, text: "Change the loan" };
    case "budgetLine":
    case "untracked":
      return null;
  }
}
