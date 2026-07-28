import type { Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";

/**
 * PER-PERSON attribution invariant, checked as each person is taxed and BEFORE
 * aggregation. The jurisdiction's contract: Σ of its per-category breakdown equals its own
 * scalar `computeTaxCents` for the SAME taxable input. Asserting per person, not only on
 * the household total, catches OFFSETTING errors — one person over-attributed and another
 * under by the same amount reconciles at household level yet each is wrong. Exact to the
 * cent; a zero-tax person passes trivially with a `{}` breakdown.
 */
export function assertPersonTaxBreakdownReconciles(
  personId: string,
  scalarTaxCents: Cents,
  breakdown: Partial<Record<TaxCategory, Cents>>,
): void {
  const summed = Object.values(breakdown).reduce((s, v) => s + (v ?? 0), 0);
  if (summed !== scalarTaxCents) {
    throw new Error(
      `Tax attribution does not reconcile for person ${personId}: ` +
        `Σ computeTaxByCategoryCents=${summed} ≠ computeTaxCents=${scalarTaxCents}. ` +
        `The category breakdown must sum to the scalar tax for each person (integer cents).`,
    );
  }
}

/**
 * HOUSEHOLD attribution invariant — the second check: whenever tax is charged, the
 * per-source breakdown MUST reconcile to the scalar `taxCents`. This keeps the take-home
 * cash-flow chart honest, since it derives each source's net as `cashInflow − deferral −
 * attributed tax`; a partial `taxBySourceCents` would leave tax un-subtracted and overstate
 * take-home. Fail loudly on an incomplete jurisdiction rather than render a misleading chart.
 *
 * EXACT to the cent, no tolerance. Everything is integer cents: `attributeTaxToSources`
 * splits each category with {@link apportionByWeight} (largest-remainder, Σ shares === the
 * category tax), and {@link assertPersonTaxBreakdownReconciles} has already pinned each
 * person's breakdown to their scalar. Any deviation is a bug, not benign rounding. A
 * jurisdiction charging no tax (`taxCents` 0) is exempt.
 */
export function assertTaxAttributionReconciles(
  taxCents: Cents,
  taxBySourceCents: Readonly<Record<string, Cents>>,
): void {
  if (taxCents <= 0) return;
  const attributed = Object.values(taxBySourceCents).reduce((s, v) => s + v, 0);
  if (attributed !== taxCents) {
    throw new Error(
      `Tax attribution does not reconcile: Σ taxBySourceCents=${attributed} ≠ taxCents=${taxCents}. ` +
        `The per-source breakdown must sum to the tax charged exactly (integer cents).`,
    );
  }
}
