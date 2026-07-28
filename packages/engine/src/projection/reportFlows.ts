/**
 * Diagnostic cash-flow capture for a single simulated month. The simulator attaches
 * {@link buildFlows}'s result to the month's snapshot as {@link ProjectionMonthFlows};
 * `report.ts` reads it back out.
 *
 * Its own file because, alone among the per-month builders in `simulate.ts`, its output the
 * *simulation never consumes* — so sim (producer) and report (consumer) depend on a neutral
 * module instead of each other.
 *
 * Pure: it buckets the very same resolved figures the waterfall consumed, so the flow view
 * can never drift from the sim.
 */

import type { Cents } from "../money";
import type { IncomeSourceMonth } from "./waterfall";
import type { ProjectionIncomeSource, ProjectionMonthFlows } from "./simulate.types";
import { sumSpendingItems, type SpendingItem } from "./spendingItems";

export const SAVINGS_DRAWDOWN_SOURCE_ID = "savings-drawdown";
const SAVINGS_DRAWDOWN_LABEL = "Savings drawdown";

/**
 * Two income views from one pass: the `incomeByCategoryCents` tax-category rollup (kept for
 * compatibility) and the finer per-source `incomeSources`. `sourceId`/`label` ride through;
 * a source lacking them falls back to its tax category.
 *
 * `liquidDrawdownCents` (the gap cash savings covered) is appended as its own
 * `savingsDrawdown` source but stays OUT of the rollup and total: a drawdown is spending an
 * asset, not income.
 *
 * `taxByCategoryCents`, `taxBySourceCents` and `deferralBySourceCents` ride through
 * pre-computed — attribution is the jurisdiction's call. The per-source maps are keyed by
 * the SAME `sourceId ?? taxCategory` the income side bands on.
 */
export function buildFlows(
  incomeSources: readonly IncomeSourceMonth[],
  taxCents: Cents,
  expensesCents: Cents,
  liabilityPaymentsCents: Cents,
  spendingItems: readonly SpendingItem[],
  liquidDrawdownCents: Cents = 0,
  taxByCategoryCents: Readonly<Record<string, Cents>> = {},
  taxBySourceCents: Readonly<Record<string, Cents>> = {},
  deferralBySourceCents?: Readonly<Record<string, Cents>>,
): ProjectionMonthFlows {
  const incomeByCategoryCents: Record<string, Cents> = {};
  let totalIncomeCents = 0;
  // Bands on `cashInflowCents`, the realized cash paid: for accrued interest that is the
  // interest itself (`waterfallInflowCents` 0, but real household cash), else the gross —
  // so interest appears rather than being dropped.
  const bySource = new Map<
    string,
    { cashInflowCents: Cents; label: string; category: string; ownerId?: string }
  >();
  const order: string[] = [];
  for (const src of incomeSources) {
    const cashInflow = src.cashInflowCents ?? src.waterfallInflowCents;
    incomeByCategoryCents[src.taxCategory] =
      (incomeByCategoryCents[src.taxCategory] ?? 0) + cashInflow;
    totalIncomeCents += cashInflow;
    // No realized cash → nothing to band (a placeholder booking, or unrealized growth).
    if (cashInflow === 0) continue;
    const sourceId = src.sourceId ?? src.taxCategory;
    const existing = bySource.get(sourceId);
    if (existing !== undefined) {
      existing.cashInflowCents += cashInflow;
    } else {
      order.push(sourceId);
      bySource.set(sourceId, {
        cashInflowCents: cashInflow,
        label: src.label ?? src.taxCategory,
        // The display axis, kept distinct from the tax axis without the UI parsing ids:
        // explicit `reportCategory` (savings interest → "savingsInterest") else tax category.
        category: src.reportCategory ?? src.taxCategory,
        // A source id is opaque and two members' benefits share a label, so the owner is
        // what tells them apart.
        ownerId: src.ownerId,
      });
    }
  }
  // Net per banded source: cash inflow minus its pre-tax deferral and the tax it bore, keyed
  // by the SAME id the waterfall attributed those on (re-deriving it dropped interest's tax).
  // SIGNED and NOT clamped — a source taxed on more than it paid in cash has a genuinely
  // negative net; a consumer needing a nonnegative stacked band clamps at render. Absent
  // breakdown maps → no haircut, so net equals cash inflow (null jurisdiction's fallback).
  const netCashFlow = (sourceId: string, cashInflowCents: Cents): Cents => {
    const haircut = (deferralBySourceCents?.[sourceId] ?? 0) + (taxBySourceCents[sourceId] ?? 0);
    return cashInflowCents - haircut;
  };
  const sources: ProjectionIncomeSource[] = order.map((id) => {
    const s = bySource.get(id)!;
    return {
      sourceId: id,
      label: s.label,
      category: s.category as ProjectionIncomeSource["category"],
      ...(s.ownerId !== undefined ? { ownerId: s.ownerId } : {}),
      cashInflowCents: s.cashInflowCents,
      netCashFlowCents: netCashFlow(id, s.cashInflowCents),
    };
  });
  // Reporting-only, never a tax bucket: spending an asset bears no tax or deferral, so its
  // net equals its cash.
  if (liquidDrawdownCents > 0) {
    sources.push({
      sourceId: SAVINGS_DRAWDOWN_SOURCE_ID,
      label: SAVINGS_DRAWDOWN_LABEL,
      category: "savingsDrawdown",
      cashInflowCents: liquidDrawdownCents,
      netCashFlowCents: liquidDrawdownCents,
    });
  }
  // Budget-line slice of the itemized list in one pass — this runs 660+ times per projection.
  const lineMonthlyCents: Record<string, Cents> = {};
  for (const item of spendingItems) {
    if (item.sourceKind === "budgetLine") lineMonthlyCents[item.id] = item.amountCents;
  }

  return {
    incomeByCategoryCents,
    incomeSources: sources,
    totalIncomeCents,
    governmentRetirementBenefitCents: incomeByCategoryCents["governmentRetirementBenefit"] ?? 0,
    taxCents,
    // Always present: `{}` in a zero-tax month, otherwise Σ === `taxCents`.
    taxByCategoryCents,
    taxBySourceCents,
    deferralBySourceCents,
    expensesCents,
    liabilityPaymentsCents,
    // Not a second pass: the map IS the items, filtered, so the two cannot disagree.
    lineMonthlyCents,
    spendingItems,
    totalSpendingCents: sumSpendingItems(spendingItems),
  };
}
