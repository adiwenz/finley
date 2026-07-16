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
import type { ProjectionMonthFlows } from "./simulate.types";

/**
 * Bucket this month's resolved income sources, expenses, and liability payments into
 * the diagnostic {@link ProjectionMonthFlows}. Reads the same figures the waterfall
 * consumed (income sources incl. derived SS/RMD, expense total, scheduled payments),
 * so the flow view can never drift from the sim.
 */
export function buildFlows(
  incomeSources: readonly IncomeSourceMonth[],
  expensesCents: Cents,
  liabilityPaymentsCents: Cents,
): ProjectionMonthFlows {
  const incomeByCategoryCents: Record<string, Cents> = {};
  let totalIncomeCents = 0;
  for (const src of incomeSources) {
    incomeByCategoryCents[src.taxCategory] =
      (incomeByCategoryCents[src.taxCategory] ?? 0) + src.grossCents;
    totalIncomeCents += src.grossCents;
  }
  return {
    incomeByCategoryCents,
    totalIncomeCents,
    governmentRetirementBenefitCents: incomeByCategoryCents["governmentRetirementBenefit"] ?? 0,
    expensesCents,
    liabilityPaymentsCents,
  };
}
