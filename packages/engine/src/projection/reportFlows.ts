/**
 * Diagnostic cash-flow capture for a single simulated month (§10). The simulator
 * calls {@link buildFlows} inside its per-month loop and attaches the result to the
 * month's snapshot as {@link ProjectionMonthFlows}; the report/debug layer then reads
 * those flows back out (see `report.ts`).
 *
 * It lives in its own file for one specific reason: of all the per-month builders in
 * `simulate.ts`, this is the only one whose output the *simulation itself never
 * consumes* — payments feed `advanceLiabilities`, income feeds the waterfall, but
 * flows feed nothing downstream. They exist purely to be reported. Isolating that
 * concern keeps it independently testable and lets both the sim (producer) and the
 * report (consumer) depend on a neutral module instead of each other.
 *
 * Pure: it buckets the very same resolved figures the waterfall consumed, so the
 * flow view can never drift from the sim.
 */

import type { Cents } from "../money";
import type { IncomeSourceMonth } from "./waterfall";
import type { ProjectionIncomeSource, ProjectionMonthFlows } from "./simulate.types";
import { sumSpendingItems, type SpendingItem } from "./spendingItems";

/** The stable source id / label of the reported liquid-buffer drawdown (issue #99). */
export const SAVINGS_DRAWDOWN_SOURCE_ID = "savings-drawdown";
const SAVINGS_DRAWDOWN_LABEL = "Savings drawdown";

/**
 * Bucket this month's resolved income sources, tax, expenses, and liability payments
 * into the diagnostic {@link ProjectionMonthFlows}. Reads the same figures the waterfall
 * consumed or produced (income sources incl. derived benefit/RMD, the tax it charged,
 * expense total, scheduled payments), so the flow view can never drift from the sim.
 *
 * Spending arrives already itemized ({@link SpendingItem}, issue #119 follow-up): one
 * list covering budget lines, health, event expenses, and liability payments. The
 * per-line map (§Q27) is derived from it here rather than computed separately, so the
 * itemized view and the per-line view are one computation with two shapes.
 *
 * Produces two income views from one pass over the sources (issue #99): the
 * `incomeByCategoryCents` tax-category rollup (retained, backward-compatible) and the
 * finer `incomeSources` list that keeps each source distinct — so two jobs, or two
 * pre-tax accounts, no longer collapse into one bucket. A source's `sourceId`/`label`
 * ride through from the builders; a source lacking them falls back to its tax category.
 *
 * The `liquidDrawdownCents` (the gap cash savings covered this month, from the
 * withdrawal channel) is appended as its own `savingsDrawdown` source so "living off
 * savings" is visible — but is kept OUT of the category rollup and the total, which stay
 * the taxable-income view (a drawdown is spending an asset, not income).
 *
 * The optional `taxByCategoryCents` (issue #110) is the per-category split of `taxCents`
 * the waterfall obtained from the jurisdiction's breakdown seam; it rides straight
 * through (absent → the consumer draws a single tax band). It is passed pre-computed
 * rather than re-derived here because attribution is the jurisdiction's call, not the
 * report layer's — this module only buckets what the sim already resolved.
 *
 * The finer `taxBySourceCents` (issue #110 follow-up) and `deferralBySourceCents` ride
 * through the same way, keyed by the SAME `sourceId ?? taxCategory` this function bands
 * the income side on — so a consumer can line each income band up with the tax it bore
 * and the deferral it made, and draw a per-job tax chart or a take-home income view.
 */
export function buildFlows(
  incomeSources: readonly IncomeSourceMonth[],
  taxCents: Cents,
  expensesCents: Cents,
  liabilityPaymentsCents: Cents,
  spendingItems: readonly SpendingItem[],
  liquidDrawdownCents: Cents = 0,
  taxByCategoryCents?: Readonly<Record<string, Cents>>,
  taxBySourceCents?: Readonly<Record<string, Cents>>,
  deferralBySourceCents?: Readonly<Record<string, Cents>>,
): ProjectionMonthFlows {
  const incomeByCategoryCents: Record<string, Cents> = {};
  let totalIncomeCents = 0;
  // Aggregate genuine income by source, preserving first-seen order. A source is keyed
  // by its `sourceId` (or its tax category as a fallback); repeated keys sum. We band on
  // `cashInflowCents` — the realized cash the source paid — which for accrued interest is
  // its interest (grossCents 0, but real household cash) and for everything else is its
  // gross. So interest now appears in the cash-flow view instead of being dropped.
  const bySource = new Map<string, { cashInflowCents: Cents; label: string; category: string }>();
  const order: string[] = [];
  for (const src of incomeSources) {
    const cashInflow = src.cashInflowCents ?? src.grossCents;
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
        category: src.taxCategory,
      });
    }
  }
  // Finish each banded source with its engine-produced net cash flow (§5.3, #110
  // follow-up): cash inflow minus the pre-tax deferral it made and the tax it bore, keyed
  // by the SAME id the waterfall attributed those on. Clamped at 0 defensively. This is
  // the take-home the app now displays directly instead of re-deriving (and re-deriving
  // dropped interest's tax, understating the household's net). Absent breakdown maps → no
  // haircut, so net equals cash inflow (a null jurisdiction's single-band fallback).
  const netCashFlow = (sourceId: string, cashInflowCents: Cents): Cents => {
    const haircut = (deferralBySourceCents?.[sourceId] ?? 0) + (taxBySourceCents?.[sourceId] ?? 0);
    return Math.max(0, cashInflowCents - haircut);
  };
  const sources: ProjectionIncomeSource[] = order.map((id) => {
    const s = bySource.get(id)!;
    return {
      sourceId: id,
      label: s.label,
      category: s.category as ProjectionIncomeSource["category"],
      cashInflowCents: s.cashInflowCents,
      netCashFlowCents: netCashFlow(id, s.cashInflowCents),
    };
  });
  // The liquid-buffer drawdown: its own reporting-only source, never a tax bucket. It bears
  // no tax or deferral (spending an asset, not income), so its net equals its cash.
  if (liquidDrawdownCents > 0) {
    sources.push({
      sourceId: SAVINGS_DRAWDOWN_SOURCE_ID,
      label: SAVINGS_DRAWDOWN_LABEL,
      category: "savingsDrawdown",
      cashInflowCents: liquidDrawdownCents,
      netCashFlowCents: liquidDrawdownCents,
    });
  }
  // The budget-line slice of the one itemized list, in a single pass: this runs once
  // per simulated month, i.e. 660+ times per projection.
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
    // The per-category tax breakdown (§5.3, #110) — the tax analog of
    // `incomeByCategoryCents`. Absent when the jurisdiction declines the breakdown, so a
    // consumer falls back to the single `taxCents` band. Σ === `taxCents` when present.
    taxByCategoryCents,
    // The finer per-source tax split and per-source deferral (issue #110 follow-up),
    // keyed like `incomeSources`. Absent when the jurisdiction declines the breakdown.
    taxBySourceCents,
    deferralBySourceCents,
    expensesCents,
    liabilityPaymentsCents,
    // Not a second pass over the series: the per-line map and the spending items
    // cannot disagree, because the map IS the items, filtered.
    lineMonthlyCents,
    spendingItems,
    totalSpendingCents: sumSpendingItems(spendingItems),
  };
}
