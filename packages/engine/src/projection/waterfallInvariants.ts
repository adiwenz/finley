import type { Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";

/**
 * §5.3 PER-PERSON attribution invariant (issue #110 follow-up), checked as each person is
 * taxed and BEFORE anything is aggregated. The jurisdiction's contract is that the Σ of its
 * per-category breakdown equals its own scalar `computeTaxCents` for the SAME taxable input —
 * so we assert it per person. Checking here, not only on the household total, catches
 * OFFSETTING errors: one person over-attributed and another under by the same amount would
 * reconcile at the household level yet each be wrong. Exact to the cent (integer cents; a
 * zero-tax person trivially passes with a `{}` breakdown).
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
 * §5.3 HOUSEHOLD attribution invariant (issue #110 follow-up) — the second check. When any
 * tax is charged, the per-source breakdown MUST reconcile to the scalar `taxCents`. This is
 * what keeps the take-home cash-flow chart honest: it derives each source's net as `cashInflow
 * − deferral − attributed tax`, so a partial `taxBySourceCents` would leave tax un-subtracted
 * and overstate take-home. An incomplete jurisdiction implementation is a bug we fail loudly
 * on, not a misleading chart we render.
 *
 * Reconciliation is EXACT to the cent — no tolerance. Everything here is integer cents:
 * `attributeTaxToSources` splits each category's tax with {@link apportionByWeight}
 * (largest-remainder, Σ shares === the category tax exactly), and the {@link
 * assertPersonTaxBreakdownReconciles} per-person invariant has already pinned each person's
 * breakdown to their scalar. So the household Σ equals `taxCents` on the nose; any deviation
 * is a bug, not benign rounding. A jurisdiction that charges NO tax (`taxCents` 0) is exempt.
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
