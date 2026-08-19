/**
 * The tax year's CLOSE and its CASH SETTLEMENT — two different months, which is the whole point
 * of this module.
 *
 * A tax year's liability is annual and becomes exactly knowable the moment December's income has
 * folded into {@link import("./runState").SimState.taxableIncomeByPersonYear}. Its BALANCE — the
 * liability less what payroll already withheld — is not a December cash flow. It is
 * settled in April of the FOLLOWING year, the way a real filing is:
 *
 * ```
 * 2028 taxable activity → exact 2028 liability → 2028 balance due/refund → April 2029 cash flow
 * ```
 *
 * Two consequences follow, and both are why this arrangement replaced a December true-up:
 *
 *  1. **No same-year recursion.** December used to sell assets to pay its own true-up, and each
 *     sale's gain enlarged the very bill it was raising cash for — a fixed-point climb solved by
 *     iterating "sell → re-price → sell more". Here the year is closed before anything is sold,
 *     so `Tax(Income_2028)` is final. The April draw that funds the balance is 2029 income, and
 *     2029's own estimate and settlement account for it normally. A closed year is never reopened.
 *  2. **No December spike.** The balance leaves the year it belongs to and lands in a month with
 *     eleven ordinary months around it, funded by the ordinary waterfall like any other need.
 *
 * A settlement is SIGNED: positive is tax due, negative is a refund. Both ride the same channel —
 * the month's federal income-tax charge (see {@link import("./allocationStep").allocateMonth}) —
 * so a balance due is docked from take-home and forces decumulation exactly as withholding
 * does, and a refund raises take-home and lands wherever an ordinary surplus lands. Neither
 * touches a balance directly.
 *
 * Each settlement is consumed EXACTLY ONCE: {@link dueTaxYearSettlements} deletes what it
 * returns, so a second read in the same April, or any later month, finds nothing.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { SimState } from "./runState";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import {
  annualFederalTax,
  MONTHS_IN_TAX_YEAR,
  NO_FEDERAL_TAX_PAID,
  type FederalTaxPayment,
} from "./federalIncomeTax";

/**
 * The tax year's last month — December, when month 0 is January. The year's actual liability is
 * knowable from here on; nothing is charged.
 */
export function isTaxYearCloseMonth(month: number): boolean {
  return month % MONTHS_IN_TAX_YEAR === MONTHS_IN_TAX_YEAR - 1;
}

/**
 * Filing month: the tax year's FOURTH calendar month, which is April while the simulator starts
 * every run in January. The `% 12 === 3` mapping lives HERE and nowhere else, so a later
 * non-January start has one line to change — it becomes a lookup of the true calendar month
 * rather than an offset from month 0, and every caller below is already written in terms of
 * "the month the prior year settles in" rather than a number.
 */
const SETTLEMENT_MONTH_IN_YEAR = 3;

export function isTaxSettlementMonth(month: number): boolean {
  return month % MONTHS_IN_TAX_YEAR === SETTLEMENT_MONTH_IN_YEAR;
}

/**
 * The signed payroll-tax adjustment the year's filing makes, for one person — positive owed,
 * negative refunded. Zero whenever the jurisdiction declines to reconcile, and zero for the
 * ordinary year in which every cap the withholding applied was the right one.
 *
 * Each wage source's WHOLE-YEAR earnings go to the seam separately, because the whole point of
 * the reconciliation is that withholding was computed per source and the liability is not.
 */
function reconcilePayrollTax(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  personYearKey: string,
): Cents {
  const seam = jurisdiction.reconcilePayrollTaxCents;
  const bySource = state.sourceYearToDate.get(personYearKey);
  if (seam === undefined || bySource === undefined || bySource.size === 0) return 0;
  return seam([...bySource.values()].map((ytd) => ytd.earnedByCategory), ctx);
}

/** Where a completed year's balance waits for April: `${personId}|${taxYear}`. */
function settlementKey(personId: string, taxYear: number): string {
  return `${personId}|${taxYear}`;
}

/**
 * Close the tax year: price each person's ACTUAL annual taxable income, subtract the estimated
 * withholding they already paid, and park the signed difference against `ctx.year` for April of
 * the next year to charge or refund. A no-op in every month but the year's last.
 *
 * Mutates only {@link import("./runState").SimState.pendingTaxSettlementsByPersonYear} — no sale,
 * no borrow, no refund, no change to the year's taxable base. That is the point: December stops
 * being a cash event, so the December net-worth sawtooth a decumulating household used to show
 * has nothing left to come from.
 *
 * Called after the month's own income has folded into `taxableIncomeByPersonYear` (via {@link
 * import("./allocationStep").allocateMonth}), so the base read here is the COMPLETE year
 * regardless of which month each dollar landed in.
 *
 * A run that stops before its next April leaves the last year's balance parked and unsettled, and
 * it is deliberately NOT hurried forward into December: doing so would restore the very spike
 * (and the recursion behind it) this arrangement removes. Where the run stopped because the
 * household DIED, the parked balance is not simply abandoned — it becomes an estate obligation,
 * weighed against estate assets rather than charged to a month
 * ({@link import("./estateSettlement").settleEstate}).
 */
export function finalizeTaxYear(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  month: number,
): void {
  if (!isTaxYearCloseMonth(month)) return;

  for (const pid of state.personIds) {
    const key = settlementKey(pid, ctx.year);
    const actualBase = state.taxableIncomeByPersonYear.get(key) ?? {};
    const paid = state.federalTaxPaidByPersonYear.get(key) ?? NO_FEDERAL_TAX_PAID;

    // What the year actually OWES, on everything that actually arrived — the authoritative
    // figure, and the only place it is ever priced. What was WITHHELD against it is `paid`, and
    // the two disagree by construction: payroll withheld from wages a paycheck at a time and
    // withheld nothing at all from a withdrawal, a gain or a penalty. That disagreement IS the
    // refund or balance due.
    const { totalCents, byCategoryCents } = annualFederalTax(jurisdiction, ctx, pid, actualBase);
    // Plus whatever the filing squares up on payroll tax — nothing at all for the ordinary
    // single-job year, and for a multi-employer one the excess Social Security each employer
    // withheld independently, back as a credit. A tax-law reconciliation, not a tidying-up: FICA
    // is otherwise settled paycheck by paycheck and never revisited.
    const payrollReconciliationCents = reconcilePayrollTax(state, jurisdiction, ctx, key);
    const trueUpCents = totalCents + payrollReconciliationCents - paid.totalCents;
    if (trueUpCents === 0) continue;

    // The year's real sources — a job, a benefit, an account draw — weighted by what each
    // actually contributed to the taxable base, so April's charge bands back to where the
    // liability came from. No settlement-draw weights any more: the sale that funds this balance
    // happens in April and is April's own income, keyed by its own account like any other draw.
    const actualBySource: Record<string, Cents> = {};
    attributeTaxToSources(
      byCategoryCents,
      [...(state.taxableBySourceByPersonYear.get(key)?.values() ?? [])],
      actualBySource,
    );

    // Both breakdowns are differences against what the year already charged, so the year's twelve
    // withholding plus this balance sum to the actual annual liability — category by category and
    // source by source, not merely in total.
    const settlementByCategory: TaxableByCategory = {};
    for (const category of new Set([
      ...Object.keys(byCategoryCents),
      ...Object.keys(paid.byCategoryCents),
    ]) as Set<TaxCategory>) {
      addCategory(
        settlementByCategory,
        category,
        (byCategoryCents[category] ?? 0) - (paid.byCategoryCents[category] ?? 0),
      );
    }
    const settlementBySource: Record<string, Cents> = {};
    for (const source of new Set([
      ...Object.keys(actualBySource),
      ...Object.keys(paid.bySourceCents),
    ])) {
      const cents = (actualBySource[source] ?? 0) - (paid.bySourceCents[source] ?? 0);
      if (cents !== 0) settlementBySource[source] = cents;
    }

    // The payroll reconciliation joins both breakdowns under the categories and sources that
    // actually BORE payroll tax, so the settlement's splits still sum to its total. It cannot be
    // apportioned across the income-tax weights above: those include a benefit and a withdrawal,
    // and neither pays payroll tax at all.
    //
    // Which sources bore it is the jurisdiction's answer, not the engine's — the same per-category
    // breakdown the waterfall attributes each month's charge with, run over each source's WHOLE
    // year. A source the seam charges nothing on takes none of the correction, which is what keeps
    // an IRA draw out of a Social-Security credit. A jurisdiction that reconciles without offering
    // a breakdown falls back to raw earnings, which is cruder but still sums to the total — the
    // splits are reporting, and a reporting gap must not leave the balance unattributed.
    if (payrollReconciliationCents !== 0) {
      const weights: SourceTaxable[] = [];
      const breakdown = jurisdiction.computePayrollWithholdingByCategoryCents;
      for (const [sourceKey, ytd] of state.sourceYearToDate.get(key) ?? []) {
        const borne = breakdown?.(ytd.earnedByCategory, ctx) ?? ytd.earnedByCategory;
        for (const [category, cents] of Object.entries(borne)) {
          if (cents) {
            weights.push({ key: sourceKey, category: category as TaxCategory, taxableCents: cents });
          }
        }
      }
      const totalWeight = weights.reduce((sum, w) => sum + w.taxableCents, 0);
      if (totalWeight > 0) {
        // Cumulative rounding across the weights, so the pieces sum to the reconciliation exactly.
        let prevCum = 0;
        let acc = 0;
        for (const weight of weights) {
          acc += weight.taxableCents;
          const cum = Math.round((payrollReconciliationCents * acc) / totalWeight);
          const share = cum - prevCum;
          prevCum = cum;
          if (share === 0) continue;
          addCategory(settlementByCategory, weight.category, share);
          settlementBySource[weight.key] = (settlementBySource[weight.key] ?? 0) + share;
        }
      }
    }

    state.pendingTaxSettlementsByPersonYear.set(key, {
      totalCents: trueUpCents,
      byCategoryCents: settlementByCategory,
      bySourceCents: settlementBySource,
    });
  }
}

/**
 * The prior tax year's balance, per person, in the April it is due — and CONSUMED: every entry
 * returned is deleted from the pending map, so nothing can be charged twice. Empty in every other
 * month, and empty in an April whose prior year came out exactly on estimate.
 *
 * Signed, like what it was stored as. The caller charges it through the same channel as the
 * month's own withholding, which is what puts it through the ordinary funding waterfall: a
 * balance due enlarges the month's cash need and may be funded by a taxable withdrawal, and that
 * withdrawal is income in the CURRENT year, folded into the current year's accumulator by the
 * ordinary path. It must NOT be credited to the current year's `federalTaxPaidByPersonYear` —
 * it pays a different year's liability, and crediting it would make December undercharge by
 * exactly this amount.
 */
export function dueTaxYearSettlements(
  state: SimState,
  ctx: JurisdictionContext,
  month: number,
): ReadonlyMap<string, FederalTaxPayment> {
  const due = new Map<string, FederalTaxPayment>();
  if (!isTaxSettlementMonth(month)) return due;

  for (const pid of state.personIds) {
    const key = settlementKey(pid, ctx.year - 1);
    const settlement = state.pendingTaxSettlementsByPersonYear.get(key);
    if (settlement === undefined) continue;
    state.pendingTaxSettlementsByPersonYear.delete(key);
    due.set(pid, settlement);
  }
  return due;
}

/**
 * Every parked balance belonging to a year BEFORE `ctx.year`, summed and signed — what a run
 * ending in `ctx.year` accrued and never settled, because each of those balances was waiting for
 * an April that the run did not reach.
 *
 * `ctx.year`'s own entry is excluded: the caller ({@link
 * import("./estateSettlement").settleEstate}) prices that year from its actual income directly,
 * and December of a final year parks exactly that same figure.
 *
 * Ordinarily empty — a year's balance is consumed the following April, so at most one year can be
 * outstanding at once, and only where the run ends between January and March.
 */
export function unsettledBalancesFromEarlierYearsCents(
  state: SimState,
  ctx: JurisdictionContext,
): Cents {
  let total = 0;
  for (const [key, settlement] of state.pendingTaxSettlementsByPersonYear) {
    // The key is `${personId}|${taxYear}`; a person id never contains the separator, but a
    // last-index split is right whether or not that stays true.
    const taxYear = Number(key.slice(key.lastIndexOf("|") + 1));
    if (taxYear !== ctx.year) total += settlement.totalCents;
  }
  return total;
}
