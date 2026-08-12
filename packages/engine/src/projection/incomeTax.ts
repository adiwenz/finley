import { apportionByWeight, type Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import { mergeCategories, type TaxableByCategory } from "./taxAttribution";
import { assertPersonTaxBreakdownReconciles } from "./waterfallInvariants";

/**
 * The engine's shared income-tax reconciliation: a jurisdiction's tax seam takes ANNUAL
 * taxable-by-category and returns ANNUAL tax liability — it owns tax POLICY only. The engine
 * turns a month's flows into an annual ESTIMATE by extrapolating year-to-date taxable income
 * across the months elapsed so far (`taxableYTD / monthsElapsed × 12`), taxes that estimate,
 * and charges only the difference between the resulting target cumulative liability and what
 * has already been charged this year. At month 12, `taxableYTD` equals the actual annual
 * total and the target IS the true annual liability, so cumulative tax reconciles exactly
 * regardless of how the income was distributed across months — a lump (an RMD, a bonus) is
 * never taxed as though it recurred every month.
 *
 * Every monthly caller — the waterfall's real charge, a funding-draw gross-up, a
 * decumulation gross-up — shares these functions so they cannot drift apart. Each takes the
 * jurisdiction's tax-seam closures directly (never a `Jurisdiction` + `ctx` pair) so a caller
 * that already has them bound (`WaterfallInput.computeTaxCents`, or a local
 * `jurisdiction.computeTaxCents(x, ctx)` closure) passes them straight through.
 */

/** One person's income-tax position at the START of this month (before this month's flows). */
export interface YtdTaxState {
  /** Cumulative taxable income by category so far this calendar year. */
  readonly taxableByCategory: TaxableByCategory;
  /** Cumulative income tax actually charged so far this calendar year (the scalar total). */
  readonly taxPaidCents: Cents;
}

/** A fresh tax year: nothing earned, nothing charged. */
export const FRESH_YTD_TAX_STATE: YtdTaxState = { taxableByCategory: {}, taxPaidCents: 0 };

/**
 * Calendar months elapsed so far this year, INCLUDING `month` — `month` is absolute across the
 * whole simulation, so this is its 1-indexed position within its current 12-month year, the
 * denominator {@link annualizeYtd} extrapolates over. Shared by every caller that annualizes
 * YTD income for the SAME month so they read the same position.
 */
export function elapsedMonthsInYear(month: number): number {
  return (month % 12) + 1;
}

function scaleByCategory(byCategory: TaxableByCategory, numerator: number, denominator: number): TaxableByCategory {
  const out: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(byCategory)) {
    if (!cents) continue;
    out[category as TaxCategory] = Math.round((cents * numerator) / denominator);
  }
  return out;
}

function positiveWeights(byCategory: TaxableByCategory): (readonly [string, number])[] {
  return Object.entries(byCategory)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
    .map(([category, cents]) => [category, cents as number] as const);
}

/**
 * Distribute `totalCents` (ANY sign) across `annualBreakdown`'s cents, standing in as
 * weights. `apportionByWeight` only accepts a non-negative total (a refund month, where this
 * month's reconciled charge is negative, is a legitimate outcome — see the module doc), so a
 * negative total is apportioned by its magnitude and every share re-negated, splitting a
 * refund across categories in the same proportions a charge would use.
 *
 * `fallbackWeights` (the merged YTD taxable-by-category) stands in whenever `annualBreakdown`
 * itself has no positive entries — the current month's ANNUALIZED estimate can imply zero tax
 * (e.g. it has fallen back under the standard deduction) even while a refund is still owed
 * from an earlier, higher estimate; there is then no TAX composition to attribute it by, so
 * fall back to the INCOME composition that produced the earlier charge. That fallback is
 * guaranteed non-empty whenever a refund is due: `taxPaidCents` cannot be nonzero without
 * taxable income having been recorded for it, and that income is still part of the YTD total.
 */
function apportionByAnnualBreakdown(
  totalCents: Cents,
  annualBreakdown: TaxableByCategory,
  fallbackWeights: TaxableByCategory,
): TaxableByCategory {
  if (totalCents === 0) return {};
  let weights = positiveWeights(annualBreakdown);
  if (weights.length === 0) weights = positiveWeights(fallbackWeights);
  const shares = apportionByWeight(Math.abs(totalCents), weights);
  const out: TaxableByCategory = {};
  for (const [category, cents] of shares) {
    out[category as TaxCategory] = totalCents > 0 ? cents : -cents;
  }
  return out;
}

/**
 * Extrapolate a YTD cumulative total (accrued over `monthsElapsed` months) to a full-year
 * pace. Exact once `monthsElapsed` reaches 12 — the estimate IS the actual annual total.
 */
export function annualizeYtd(ytdByCategory: TaxableByCategory, monthsElapsed: number): TaxableByCategory {
  return scaleByCategory(ytdByCategory, 12, monthsElapsed);
}

/**
 * The reconciled cumulative tax TARGET owed through `monthsElapsed` months, given YTD
 * taxable-by-category: annualize the YTD pace, tax the annual estimate, then take the
 * `monthsElapsed/12` share of that annual liability. At `monthsElapsed` 12 this equals the
 * jurisdiction's actual annual liability on the (now exact) YTD total.
 */
export function targetCumulativeTaxCents(
  computeAnnualTaxCents: (annualByCategory: TaxableByCategory) => Cents,
  ytdByCategory: TaxableByCategory,
  monthsElapsed: number,
): Cents {
  const annualTax = computeAnnualTaxCents(annualizeYtd(ytdByCategory, monthsElapsed));
  return Math.round((annualTax * monthsElapsed) / 12);
}

/**
 * This month's reconciled income-tax charge for a hypothetical this-month taxable-by-category,
 * given the person's YTD state going into the month: the target cumulative liability through
 * this month, minus what has already been charged this year. `priorState.taxPaidCents`
 * cancels out of any DIFFERENCE of two calls sharing the same `priorState`/`monthsElapsed` —
 * which is exactly how a gross-up loop uses this (base vs. base+candidate-gain) — so the same
 * function serves both an absolute read and a funding-draw/decumulation gross-up's marginal
 * probe, without drifting apart. The waterfall's real monthly charge instead uses {@link
 * ytdIncomeTaxWithBreakdownCents}, which needs the breakdown too and computes the jurisdiction
 * seam only once each rather than calling this alongside {@link ytdIncomeTaxByCategoryCents}.
 */
export function ytdIncomeTaxCents(
  computeAnnualTaxCents: (annualByCategory: TaxableByCategory) => Cents,
  priorState: YtdTaxState,
  monthsElapsed: number,
  thisMonthTaxableByCategory: TaxableByCategory,
): Cents {
  const after = mergeCategories(priorState.taxableByCategory, thisMonthTaxableByCategory);
  return targetCumulativeTaxCents(computeAnnualTaxCents, after, monthsElapsed) - priorState.taxPaidCents;
}

/**
 * {@link ytdIncomeTaxCents} and its per-{@link TaxCategory} breakdown together, calling each
 * jurisdiction seam function exactly ONCE (not once per function) — the waterfall's real
 * monthly charge needs both every month, and a jurisdiction seam is not assumed cheap or
 * side-effect-free enough to call twice for one answer.
 *
 * The breakdown apportions THIS MONTH's scalar charge by the CURRENT month's annual weights
 * — never by differencing two independently-apportioned cumulative snapshots. Weight ratios
 * between categories can shift month to month as the estimated annual composition changes
 * (more wages, less capital gains, say), which would let one category's OWN running total
 * dip even while the person's overall charge rises; apportioning the increment directly
 * avoids ever producing a spuriously negative single-category share that {@link
 * import("./taxAttribution").attributeTaxToSources} — which skips non-positive category
 * entries — would then drop from the per-source attribution, breaking the household Σ
 * invariant. A consequence: cumulative per-category charges do NOT need to sum to the
 * jurisdiction's annual per-category breakdown (only each MONTH's Σ reconciles to that
 * month's scalar charge) — the same average-rate approximation the pre-YTD attribution
 * already disclosed as `taxAttributionProportional`.
 */
export function ytdIncomeTaxWithBreakdownCents(
  computeAnnualTaxCents: (annualByCategory: TaxableByCategory) => Cents,
  computeAnnualTaxByCategoryCents: (annualByCategory: TaxableByCategory) => TaxableByCategory,
  priorState: YtdTaxState,
  monthsElapsed: number,
  thisMonthTaxableByCategory: TaxableByCategory,
  personId: string,
): { taxCents: Cents; taxByCategoryCents: TaxableByCategory } {
  const after = mergeCategories(priorState.taxableByCategory, thisMonthTaxableByCategory);
  const annual = annualizeYtd(after, monthsElapsed);
  const annualTax = computeAnnualTaxCents(annual);
  const annualBreakdown = computeAnnualTaxByCategoryCents(annual);
  // The jurisdiction's own contract, checked at the annual scale it was declared at: Σ
  // `computeAnnualTaxByCategoryCents` MUST equal `computeAnnualTaxCents` for the SAME annual
  // input. Apportioning by WEIGHT (not by absolute value) below would otherwise let a
  // breakdown that violates this reconcile trivially once re-apportioned to the monthly
  // figure, silently absorbing the bug.
  assertPersonTaxBreakdownReconciles(personId, annualTax, annualBreakdown);
  const targetScalar = Math.round((annualTax * monthsElapsed) / 12);
  const taxCents = targetScalar - priorState.taxPaidCents;
  return { taxCents, taxByCategoryCents: apportionByAnnualBreakdown(taxCents, annualBreakdown, after) };
}

/** {@link ytdIncomeTaxWithBreakdownCents}'s breakdown alone. */
export function ytdIncomeTaxByCategoryCents(
  computeAnnualTaxCents: (annualByCategory: TaxableByCategory) => Cents,
  computeAnnualTaxByCategoryCents: (annualByCategory: TaxableByCategory) => TaxableByCategory,
  priorState: YtdTaxState,
  monthsElapsed: number,
  thisMonthTaxableByCategory: TaxableByCategory,
  personId: string,
): TaxableByCategory {
  return ytdIncomeTaxWithBreakdownCents(
    computeAnnualTaxCents,
    computeAnnualTaxByCategoryCents,
    priorState,
    monthsElapsed,
    thisMonthTaxableByCategory,
    personId,
  ).taxByCategoryCents;
}
