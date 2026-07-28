/**
 * Diagnostic cash-flow capture for a single simulated month. The simulator calls
 * {@link buildFlows} in its per-month loop and attaches the result to the month's snapshot as
 * {@link ProjectionMonthFlows}; the report/debug layer reads them back out (`report.ts`).
 *
 * Its own file because, alone among the per-month builders in `simulate.ts`, its output the
 * *simulation never consumes* — flows exist purely to be reported. Isolating that lets sim
 * (producer) and report (consumer) depend on a neutral module instead of each other.
 *
 * Pure: it buckets the very same resolved figures the waterfall consumed, so the flow view
 * can never drift from the sim.
 */

import type { Cents } from "../money";
import type { IncomeSourceMonth } from "./waterfall";
import type { ProjectionIncomeSource, ProjectionMonthFlows } from "./simulate.types";
import { sumSpendingItems, type SpendingItem } from "./spendingItems";

/** The stable source id / label of the reported liquid-buffer drawdown. */
export const SAVINGS_DRAWDOWN_SOURCE_ID = "savings-drawdown";
const SAVINGS_DRAWDOWN_LABEL = "Savings drawdown";

/**
 * Bucket this month's resolved income sources, tax, expenses, and liability payments into the
 * diagnostic {@link ProjectionMonthFlows}, from the same figures the waterfall consumed or
 * produced, so the flow view can never drift from the sim.
 *
 * Spending arrives already itemized ({@link SpendingItem}) — budget lines, health, event
 * expenses, liability payments. The per-line map is derived from that list here rather than
 * computed separately, so both views are one computation with two shapes.
 *
 * Two income views from one pass: the `incomeByCategoryCents` tax-category rollup (retained
 * for compatibility) and the finer `incomeSources` list keeping each source distinct, so two
 * jobs or two pre-tax accounts no longer collapse into one bucket. `sourceId`/`label` ride
 * through from the builders; a source lacking them falls back to its tax category.
 *
 * `liquidDrawdownCents` (the gap cash savings covered, from the withdrawal channel) is
 * appended as its own `savingsDrawdown` source so "living off savings" is visible, but stays
 * OUT of the category rollup and total: a drawdown is spending an asset, not income.
 *
 * `taxByCategoryCents` — the jurisdiction's per-category split of `taxCents` — rides straight
 * through (`{}` in a zero-tax month, otherwise reconciling to `taxCents`). Passed
 * pre-computed because attribution is the jurisdiction's call, not the report layer's.
 *
 * `taxBySourceCents` and `deferralBySourceCents` ride through the same way, keyed by the SAME
 * `sourceId ?? taxCategory` the income side bands on, so a consumer can line each income band
 * up with the tax it bore and the deferral it made. The tax maps default to `{}`, so they are
 * always present downstream.
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
  // Aggregate genuine income by source, first-seen order, keyed by `sourceId` (tax category as
  // fallback); repeated keys sum. Bands on `cashInflowCents`, the realized cash paid: for
  // accrued interest that is the interest itself (waterfallInflowCents 0, but real household
  // cash), for everything else the gross — so interest appears rather than being dropped.
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
        // Reported provenance: the source's explicit `reportCategory` when set (savings
        // interest → "savingsInterest"), else its tax category — keeping the display axis
        // distinct from the tax axis without the UI parsing ids.
        category: src.reportCategory ?? src.taxCategory,
        // A source id is opaque and two members' benefits share a label, so the owner is
        // what tells them apart.
        ownerId: src.ownerId,
      });
    }
  }
  // Net cash flow per banded source: cash inflow minus its pre-tax deferral and the tax it
  // bore, keyed by the SAME id the waterfall attributed those on. The app displays this
  // take-home directly; re-deriving it dropped interest's tax and understated the net. SIGNED
  // and deliberately NOT clamped — a source taxed on more than it paid in cash has a genuinely
  // negative net, and a consumer needing a nonnegative stacked band clamps at render. Absent
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
      // The owner is what tells two members' same-labelled benefits apart.
      ...(s.ownerId !== undefined ? { ownerId: s.ownerId } : {}),
      cashInflowCents: s.cashInflowCents,
      netCashFlowCents: netCashFlow(id, s.cashInflowCents),
    };
  });
  // The liquid-buffer drawdown: reporting-only, never a tax bucket. Spending an asset bears
  // no tax or deferral, so its net equals its cash.
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
    // Tax analog of `incomeByCategoryCents`. Always present: `{}` in a zero-tax month,
    // otherwise Σ === `taxCents`.
    taxByCategoryCents,
    // Finer per-source tax split, keyed like `incomeSources`, plus the per-source deferral.
    // The tax split is always present (`{}` when no tax).
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
