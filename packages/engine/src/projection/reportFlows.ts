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

/** The stable source id / label of the reported liquid-buffer drawdown (issue #99). */
export const SAVINGS_DRAWDOWN_SOURCE_ID = "savings-drawdown";
const SAVINGS_DRAWDOWN_LABEL = "Savings drawdown";

/**
 * Bucket this month's resolved income sources, tax, expenses, and liability payments
 * into the diagnostic {@link ProjectionMonthFlows}. Reads the same figures the waterfall
 * consumed or produced (income sources incl. derived benefit/RMD, the tax it charged,
 * expense total, scheduled payments), so the flow view can never drift from the sim.
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
 */
export function buildFlows(
  incomeSources: readonly IncomeSourceMonth[],
  taxCents: Cents,
  expensesCents: Cents,
  liabilityPaymentsCents: Cents,
  lineMonthlyCents: Readonly<Record<string, Cents>>,
  liquidDrawdownCents: Cents = 0,
): ProjectionMonthFlows {
  const incomeByCategoryCents: Record<string, Cents> = {};
  let totalIncomeCents = 0;
  // Aggregate genuine income by source, preserving first-seen order. A source is keyed
  // by its `sourceId` (or its tax category as a fallback); repeated keys sum.
  const bySource = new Map<string, ProjectionIncomeSource>();
  const order: string[] = [];
  for (const src of incomeSources) {
    incomeByCategoryCents[src.taxCategory] =
      (incomeByCategoryCents[src.taxCategory] ?? 0) + src.grossCents;
    totalIncomeCents += src.grossCents;
    // A zero-gross booking (accrued interest, whose cash is already in the balance)
    // carries no cash to band — it belongs to the category rollup above, not here.
    if (src.grossCents === 0) continue;
    const sourceId = src.sourceId ?? src.taxCategory;
    const existing = bySource.get(sourceId);
    if (existing !== undefined) {
      bySource.set(sourceId, { ...existing, grossCents: existing.grossCents + src.grossCents });
    } else {
      order.push(sourceId);
      bySource.set(sourceId, {
        sourceId,
        label: src.label ?? src.taxCategory,
        category: src.taxCategory,
        grossCents: src.grossCents,
      });
    }
  }
  const sources: ProjectionIncomeSource[] = order.map((id) => bySource.get(id)!);
  // The liquid-buffer drawdown: its own reporting-only source, never a tax bucket.
  if (liquidDrawdownCents > 0) {
    sources.push({
      sourceId: SAVINGS_DRAWDOWN_SOURCE_ID,
      label: SAVINGS_DRAWDOWN_LABEL,
      category: "savingsDrawdown",
      grossCents: liquidDrawdownCents,
    });
  }
  return {
    incomeByCategoryCents,
    incomeSources: sources,
    totalIncomeCents,
    governmentRetirementBenefitCents: incomeByCategoryCents["governmentRetirementBenefit"] ?? 0,
    taxCents,
    expensesCents,
    liabilityPaymentsCents,
    lineMonthlyCents,
  };
}
