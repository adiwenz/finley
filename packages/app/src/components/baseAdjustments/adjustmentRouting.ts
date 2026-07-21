/**
 * The "Adjustment" UI verb → existing-primitive router (§18–§20, "UI: Base +
 * Adjustments" of JOBS_HOUSEHOLD_REDESIGN, issue #71).
 *
 * There is deliberately **no `Adjustment` entity** in the model. An adjustment is a
 * single UI affordance — a dated change layered on the *base* budget — that resolves
 * to one of three primitives that already exist (§20's routing table):
 *
 *   1. **one-time** change (refund, bonus)            → a **ledger transaction** (§18)
 *   2. **recurring spend/contribution** change        → a **dated override / span** on
 *      a standing budget line (§19)
 *   3. **income** change (raise, new stream)          → a **job / passive-stream
 *      override** — NOT a budget line (income lives on jobs/streams, §6/§17)
 *
 * The affordance has two navigation modes for the *when* (§UI): a near-term **month**
 * anchor (the monthly scrubber) and a long-horizon **age/milestone** anchor ("at age
 * 50 → …") at annual granularity. Both resolve to the same dated-override month via
 * {@link anchorToMonth} — one primitive, two navigation affordances, no 40-year
 * month-by-month scrubber.
 *
 * Pure: the routing is a total function over `(timing, target)`, so a UI can render
 * one form and let this decide the home the write actually lands on. Mirrors the
 * engine's `routeAllocationWrite` (§13/§20) one home per fact.
 */

import type { BudgetLineOverride } from "@finley/engine";

/** Which standing home an adjustment ultimately edits: the budget, or income. */
export type AdjustmentTarget = "spend" | "income";

/** The one-time-vs-recurring toggle (§UI). One-time is a discrete cash event. */
export type AdjustmentTiming = "oneTime" | "recurring";

/**
 * When the adjustment takes effect. A near-term `month` anchor rides the monthly
 * scrubber; a long-horizon `age` anchor is the age/milestone affordance ("at age
 * 50"), resolved to a month against the household's current age (§UI, AC5).
 */
export type AdjustmentAnchor =
  | { readonly kind: "month"; readonly month: number }
  | { readonly kind: "age"; readonly age: number };

/** The environment an age anchor resolves against — the household's current age. */
export interface AdjustmentContext {
  readonly currentAge: number;
}

/** A proposed adjustment as the UI collects it, before it is routed to a primitive. */
export interface Adjustment {
  readonly target: AdjustmentTarget;
  readonly timing: AdjustmentTiming;
  readonly anchor: AdjustmentAnchor;
  /** The new monthly amount (recurring) or the one-time cash amount. */
  readonly amountCents: number;
  /** The standing budget line a recurring spend adjustment overrides (allocations id). */
  readonly lineId?: string;
}

/**
 * A routed adjustment: the canonical primitive the change lands on. The UI applies
 * exactly one of these — never a fourth "adjustment" record (§20).
 */
export type AdjustmentRoute =
  | { readonly kind: "ledgerTransaction"; readonly month: number; readonly amountCents: number }
  | {
      readonly kind: "lineOverride";
      readonly lineId: string;
      readonly override: BudgetLineOverride;
    }
  | { readonly kind: "incomeOverride"; readonly month: number; readonly amountCents: number };

/**
 * Resolve an {@link AdjustmentAnchor} to an absolute simulation month (0 = "now").
 * A month anchor passes through; an age anchor is `(age − currentAge) × 12`, clamped
 * at 0 so an age at/before today lands at "now" rather than a negative month (§UI/AC5).
 */
export function anchorToMonth(anchor: AdjustmentAnchor, ctx: AdjustmentContext): number {
  if (anchor.kind === "month") return Math.max(0, anchor.month);
  return Math.max(0, (anchor.age - ctx.currentAge) * 12);
}

/**
 * Route an {@link Adjustment} to its canonical primitive (§20, AC4). One-time
 * changes become ledger transactions; recurring *spend* changes a dated
 * `fromHereForward` override on the named standing line; recurring *income* changes a
 * job/stream override (never a budget line). Throws when a recurring spend adjustment
 * names no line — there is nothing to override.
 */
export function routeAdjustment(adjustment: Adjustment, ctx: AdjustmentContext): AdjustmentRoute {
  const month = anchorToMonth(adjustment.anchor, ctx);

  if (adjustment.timing === "oneTime") {
    // Row 1: a one-time refund/bonus is a discrete cash event on the timeline.
    return { kind: "ledgerTransaction", month, amountCents: adjustment.amountCents };
  }

  if (adjustment.target === "income") {
    // Row 3: recurring income (a raise) rides the job/stream, keeping the §13/§17 seam
    // clean — income is never modelled as a budget line.
    return { kind: "incomeOverride", month, amountCents: adjustment.amountCents };
  }

  // Row 2: a recurring spend/contribution change is a dated override on the base line.
  if (adjustment.lineId === undefined) {
    throw new Error("A recurring spend adjustment must name the budget line it overrides.");
  }
  return {
    kind: "lineOverride",
    lineId: adjustment.lineId,
    override: { month, monthlyCents: adjustment.amountCents, scope: "fromHereForward" },
  };
}
