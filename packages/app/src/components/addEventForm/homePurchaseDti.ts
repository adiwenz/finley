/**
 * The §4.5 soft debt-to-income assessment for a *prospective* home purchase —
 * the app-side glue that feeds the engine's pure affordability arithmetic
 * (`assessDti`, `mortgagePaymentForPurchaseCents`) the household's real numbers.
 *
 * Slice 4 (#23): the arithmetic already lived in the engine but had zero call
 * sites. This derives the three inputs it needs from the live household at the
 * purchase month — gross monthly income, the mortgage the purchase would imply,
 * and the debt already being serviced — and returns the classification plus the
 * mortgage figure the warning copy quotes. It NEVER blocks; the caller records
 * the event regardless and only renders an advisory when a guideline is crossed.
 */

import {
  assessDti,
  buildSnapshot,
  mortgagePaymentForPurchaseCents,
  type Cents,
  type DtiAssessment,
  type Household,
  type ProjectionSeries,
} from "@finley/engine";

export interface HomePurchaseDtiInput {
  /** The month the purchase is authored for — gross income and existing debt are read here. */
  readonly month: number;
  readonly purchasePriceCents: Cents;
  readonly downPaymentCents: Cents;
  /** Fractional annual rate (0.065), matching {@link HomePurchaseEvent.mortgageApr}. */
  readonly apr: number;
  readonly termMonths: number;
}

export interface HomePurchaseDti {
  readonly assessment: DtiAssessment;
  /** The level monthly mortgage payment the purchase would add. */
  readonly monthlyMortgageCents: Cents;
  /** Gross monthly income the ratios are measured against (0 → nothing is flagged). */
  readonly monthlyGrossCents: Cents;
  /** True when either the front- or back-end guideline is exceeded — the advisory fires. */
  readonly exceeded: boolean;
}

/** Gross monthly income at `month`: the sum of every active income series' rate. */
function monthlyGrossCents(
  household: Household,
  series: ProjectionSeries,
  month: number,
): Cents {
  const snapshot = buildSnapshot(household, month, series);
  return snapshot.income.reduce((sum, s) => sum + s.monthlyCents, 0);
}

/**
 * Debt already serviced at `month`, before this purchase — scheduled liability
 * payments (mortgages, loans, card minimums) from the projected month's flows.
 * Month 0 carries no flows (§4.6), and an empty ledger none at all, so this is 0
 * when nothing is owed.
 */
function existingMonthlyDebtCents(series: ProjectionSeries, month: number): Cents {
  return series.months[month]?.flows?.liabilityPaymentsCents ?? 0;
}

/**
 * Classify a prospective purchase against the DTI guidelines. Housing = the new
 * mortgage; total debt = the new mortgage plus everything already serviced. With
 * zero gross income {@link assessDti} flags nothing (no divide-by-zero warning).
 */
export function assessHomePurchaseDti(
  household: Household,
  series: ProjectionSeries,
  input: HomePurchaseDtiInput,
): HomePurchaseDti {
  const monthlyMortgageCents = mortgagePaymentForPurchaseCents(
    input.purchasePriceCents,
    input.downPaymentCents,
    input.apr,
    input.termMonths,
  );
  const gross = monthlyGrossCents(household, series, input.month);
  const existingDebt = existingMonthlyDebtCents(series, input.month);
  const assessment = assessDti(gross, monthlyMortgageCents, existingDebt + monthlyMortgageCents);
  return {
    assessment,
    monthlyMortgageCents,
    monthlyGrossCents: gross,
    exceeded: assessment.frontEndExceeded || assessment.backEndExceeded,
  };
}
