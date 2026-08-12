/**
 * Diagnostic cash-flow capture for a single simulated month. The simulator attaches
 * {@link buildFlows}'s result to the month's snapshot as {@link ProjectionMonthFlows};
 * `report.ts` reads it back out.
 *
 * Its own file because its *output* — the flow record — is something the simulation never reads
 * back: sim (producer) and report (consumer) depend on a neutral module instead of each other.
 * Its *input* is a different story since the inversion: the obligation list it buckets is the
 * very list the waterfall funded earlier this month, passed in here to be reported. So the flow
 * view is a projection of what the sim already did, and can never drift from it — no figure is
 * recomputed, only re-shaped.
 */

import type { Cents } from "../money/money";
import type { IncomeSourceMonth } from "./waterfall";
import type { MonthlyWages, ProjectionIncomeSource, ProjectionMonthFlows } from "./simulate.types";
import {
  automaticFundingTotal,
  expenseReportingTotal,
  orderObligationsByPriority,
  type FinancialObligation,
} from "./financialObligation";

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
 * `taxByCategoryCents`, `taxBySourceCents`, `payrollTaxBySourceCents` and
 * `deferralBySourceCents` ride through pre-computed — attribution is the jurisdiction's call.
 * The per-source maps are keyed by the SAME `sourceId ?? taxCategory` the income side bands on.
 *
 * `taxBySourceCents` also haircuts each source's `netCashFlowCents` (this month's SAME-month
 * charge), so it must stay same-month-true — always `{}` under the annual settlement, since
 * income tax is never charged in the month it's earned. `reportedTaxBySourceCents` is the
 * DISPLAY figure `flows.taxBySourceCents` returns instead (defaulting to `taxBySourceCents`
 * when absent): the December settlement's apportionment of the year's bill back to the sources
 * that produced it, for the tax chart alone. Splitting the two keeps a source's per-month
 * take-home honest — attributing a whole year's tax onto the one month it happens to be BILLED
 * would read as though that source earned nothing, when in fact the tax was raised by selling
 * OTHER assets ({@link import("./annualTaxSettlement").SettlementDraw}), not by docking that
 * month's paycheck.
 */
export function buildFlows(
  incomeSources: readonly IncomeSourceMonth[],
  taxCents: Cents,
  obligations: readonly FinancialObligation[],
  liquidDrawdownCents: Cents = 0,
  taxByCategoryCents: Readonly<Record<string, Cents>> = {},
  taxBySourceCents: Readonly<Record<string, Cents>> = {},
  deferralBySourceCents?: Readonly<Record<string, Cents>>,
  payrollTaxCents: Cents = 0,
  payrollTaxBySourceCents: Readonly<Record<string, Cents>> = {},
  reportedTaxBySourceCents: Readonly<Record<string, Cents>> = taxBySourceCents,
  /**
   * Explicitly-funded `expense` obligations resolved this month (a One-Time Spend) — never part
   * of `obligations` above, whose {@link automaticFundingTotal}/`liabilityPaymentsCents`
   * derivation assumes every entry is automatic. Folded ONLY into the expense/chart views
   * ({@link expenseReportingTotal}, the returned `obligations` band list), never into
   * `totalObligationsCents`, so the double-count tripwire holds: the money appears in the
   * expense graph and never inflates what the shared waterfall was asked for.
   */
  explicitExpenseObligations: readonly FinancialObligation[] = [],
  // `resolvedFunding` is a partition of the FUNDED total, known only after the shortfall cascade
  // settles which obligations came up short — later than this reporting pass — so the simulator
  // attaches it to the returned bands rather than this pure re-description computing it.
): Omit<ProjectionMonthFlows, "resolvedFunding"> {
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
  // Net per banded source: cash inflow minus its pre-tax deferral, the income tax it bore,
  // and the payroll tax it bore, keyed by the SAME id the waterfall attributed those on
  // (re-deriving it dropped interest's tax). SIGNED and NOT clamped — a source taxed on more
  // than it paid in cash has a genuinely negative net; a consumer needing a nonnegative
  // stacked band clamps at render. Absent breakdown maps → no haircut, so net equals cash
  // inflow (null jurisdiction's fallback).
  const netCashFlow = (sourceId: string, cashInflowCents: Cents): Cents => {
    const haircut =
      (deferralBySourceCents?.[sourceId] ?? 0) +
      (taxBySourceCents[sourceId] ?? 0) +
      (payrollTaxBySourceCents[sourceId] ?? 0);
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
  // Pay for work, per earner — a regrouping of the bands above, so it cannot disagree with what
  // the sim paid. Reading the banded `sources` is the whole point: a job outside its span banded
  // nothing, which is why `jobCount` is how many jobs PAID this month rather than how many were
  // authored. The savings drawdown pushed above is skipped on `category`, as is every benefit.
  const wagesByOwner: Record<string, MonthlyWages> = {};
  for (const s of sources) {
    if (s.category !== "wages" || s.ownerId === undefined) continue;
    const prior = wagesByOwner[s.ownerId];
    wagesByOwner[s.ownerId] = {
      jobCount: (prior?.jobCount ?? 0) + 1,
      grossCents: (prior?.grossCents ?? 0) + s.cashInflowCents,
      deferralCents: (prior?.deferralCents ?? 0) + (deferralBySourceCents?.[s.sourceId] ?? 0),
      // Placeholder: the blend is only meaningful over the completed sums, so the pass below
      // restates it once per owner rather than this loop recomputing it per job.
      deferralFraction: 0,
    };
  }
  for (const [ownerId, w] of Object.entries(wagesByOwner)) {
    // Guarded rather than assumed positive: a banded source had nonzero cash, but the sum is
    // not bounded below by anything — an income override can zero out the month.
    wagesByOwner[ownerId] = {
      ...w,
      deferralFraction: w.grossCents > 0 ? w.deferralCents / w.grossCents : 0,
    };
  }

  // Every reported total is a derivation of the one obligation list the waterfall consumed, so
  // the flow view cannot drift from the funded amount. The two named sums split the list on
  // orthogonal axes (funding kind vs. treatment); the debt rollup is their difference — the
  // automatically-funded non-expenses — rather than a fresh reduce over the list. All three
  // coincide with the pre-inversion scalars while every obligation is `funding: automatic`
  // (this slice) and diverge once explicit funding arrives (Slice #4). `liabilityPaymentsCents`
  // is deliberately derived from `obligations` ALONE, never the merged list below: an explicit
  // expense is never a liability payment, and folding it into this subtraction would understate
  // debt service by exactly the spend's amount.
  const totalObligationsCents = automaticFundingTotal(obligations);
  const liabilityPaymentsCents = totalObligationsCents - expenseReportingTotal(obligations);
  // The double-count tripwire: an explicit expense is real spending — it belongs in the graph —
  // but it never drew the waterfall, so it is folded in ONLY here, after `totalObligationsCents`
  // is fixed above.
  const reportedObligations = [...obligations, ...explicitExpenseObligations];
  const expensesCents = expenseReportingTotal(reportedObligations);

  // Budget-line slice of the list in one pass — this runs 660+ times per projection.
  const lineMonthlyCents: Record<string, Cents> = {};
  for (const o of obligations) {
    if (o.sourceKind === "budgetLine") lineMonthlyCents[o.id] = o.amountCents;
  }

  return {
    incomeByCategoryCents,
    incomeSources: sources,
    wagesByOwner,
    totalIncomeCents,
    governmentRetirementBenefitCents: incomeByCategoryCents["governmentRetirementBenefit"] ?? 0,
    taxCents,
    payrollTaxCents,
    // Always present: `{}` in a zero-tax month, otherwise Σ === `taxCents`.
    taxByCategoryCents,
    taxBySourceCents: reportedTaxBySourceCents,
    payrollTaxBySourceCents,
    deferralBySourceCents,
    expensesCents,
    liabilityPaymentsCents,
    // Not a second pass: the map IS the list, filtered, so the two cannot disagree.
    lineMonthlyCents,
    // Ordered for reporting only — chart bands stack by priority, stable on id across months.
    // The waterfall already consumed `obligations` as an order-invariant sum; the merged list
    // adds only explicit expenses, which never drew it.
    obligations: orderObligationsByPriority(reportedObligations),
    totalObligationsCents,
  };
}
