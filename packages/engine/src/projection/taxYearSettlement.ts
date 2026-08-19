/**
 * The tax year's CLOSE and its CASH SETTLEMENT — two different months, which is the whole point
 * of this module.
 *
 * A tax year's liability is annual and becomes exactly knowable the moment December's income has
 * folded into {@link import("./runState").SimState.taxableIncomeByPersonYear}. Wages were
 * withheld against as they were paid ({@link import("./withholding")}); everything else — gains,
 * pre-tax withdrawals, RMDs, penalties, one-off taxable events — bore no in-year cash at all. So
 * what is settled in April of the FOLLOWING year is the DIFFERENCE, the way a real filing is:
 *
 * ```
 * 2028 taxable activity → exact 2028 liability → less 2028 withholding → April 2029 cash flow
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
 *     What lands there is only ever the UNWITHHELD part: a household living on wages settles at
 *     or near zero, and April is a real event only for a year that produced income no payer
 *     withheld against.
 *
 * A settlement is SIGNED: positive is tax due, negative is a refund. Both ride the same channel —
 * the month's federal income-tax charge (see {@link import("./allocationStep").allocateMonth}) —
 * so a balance due is docked from take-home and forces decumulation exactly as an instalment
 * does, and a refund raises take-home and lands wherever an ordinary surplus lands. Neither
 * touches a balance directly.
 *
 * Each settlement is consumed EXACTLY ONCE: {@link dueTaxYearSettlements} deletes what it
 * returns, so a second read in the same April, or any later month, finds nothing.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { SimState } from "./runState";
import {
  addCategory,
  attributeSignedTaxToSources,
  subtractCategories,
  type TaxableByCategory,
} from "./taxAttribution";
import { annualFederalTax, MONTHS_IN_TAX_YEAR, type FederalTaxPayment } from "./federalIncomeTax";
import { totalOfCategories } from "./withholding";

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

/** Where a completed year's balance waits for April: `${personId}|${taxYear}`. */
function settlementKey(personId: string, taxYear: number): string {
  return `${personId}|${taxYear}`;
}

/**
 * Close the tax year: price each person's ACTUAL annual taxable income, subtract the federal
 * income tax already WITHHELD against it during the year, and park the remaining balance against
 * `ctx.year` for April of the next year to charge (or, if negative — over-withheld — refund). A
 * no-op in every month but the year's last.
 *
 * This is the arithmetic of a tax return, and the only place the two figures meet: withholding
 * saw wages alone, month by month, and never anything that had not happened yet ({@link
 * import("./withholding")}); the liability priced here sees everything the year actually produced
 * — gains, pre-tax withdrawals, RMDs, the early-withdrawal penalty. The difference is exactly the
 * tax on what a payer never withheld against, and April settles it.
 *
 * Mutates only {@link import("./runState").SimState.pendingTaxSettlementsByPersonYear} — no sale,
 * no borrow, no refund, no change to the year's taxable base. December is not a cash event.
 *
 * Called after the month's own income has folded into `taxableIncomeByPersonYear` (via {@link
 * import("./allocationStep").allocateMonth}), so the base read here is the COMPLETE year
 * regardless of which month each dollar landed in — an event in October changes THIS total, and
 * so April's settlement, but never a month before October.
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

    const { totalCents: incomeTaxCents, byCategoryCents } = annualFederalTax(
      jurisdiction,
      ctx,
      pid,
      actualBase,
    );
    // A FLAT top-up, not proportional taxable income run through the jurisdiction's brackets —
    // the early-withdrawal penalty is already a priced dollar amount (see
    // `earlyWithdrawalPenaltyByPersonYear`'s doc in `runState.ts`), so it is added on top of the
    // bracket-priced liability rather than mixed into `byCategoryCents`, which must reconcile
    // exactly to `annualFederalTax`'s own `totalCents` (asserted inside it).
    const penaltyCents = state.earlyWithdrawalPenaltyByPersonYear.get(key) ?? 0;
    // Real cash already handed over during the year, by category — subtracted from the same
    // category it was withheld against, so a year of pure wages settles at exactly zero and a
    // year with an unwithheld October withdrawal settles at the tax on that withdrawal alone.
    const withheldByCategory = state.federalWithheldByPersonYear.get(key) ?? {};
    const netByCategory = subtractCategories(byCategoryCents, withheldByCategory);
    const totalCents = incomeTaxCents + penaltyCents - totalOfCategories(withheldByCategory);
    if (totalCents === 0) continue;

    // The year's real sources — a job, a benefit, an account draw — weighted by what each
    // actually contributed to the taxable base, so April's charge bands back to where the
    // liability came from. Signed: a category the year over-withheld on refunds through the same
    // sources it was collected from.
    const settlementBySource: Record<string, Cents> = {};
    attributeSignedTaxToSources(
      netByCategory,
      [...(state.taxableBySourceByPersonYear.get(key)?.values() ?? [])],
      settlementBySource,
    );

    const settlementByCategory: TaxableByCategory = { ...netByCategory };
    // The penalty rides its own dedicated bucket — `ordinaryIncome` because that is the only
    // category `earlyWithdrawalPenaltyCents` gates on (US rules), and a source key of its own
    // (`earlyWithdrawalPenalty`) rather than any account's, since it is not that account's income.
    if (penaltyCents !== 0) {
      addCategory(settlementByCategory, "ordinaryIncome", penaltyCents);
      settlementBySource.earlyWithdrawalPenalty =
        (settlementBySource.earlyWithdrawalPenalty ?? 0) + penaltyCents;
    }

    state.pendingTaxSettlementsByPersonYear.set(key, {
      totalCents,
      byCategoryCents: settlementByCategory,
      bySourceCents: settlementBySource,
    });
  }
}

/**
 * The prior tax year's balance, per person, in the April it is due — and CONSUMED: every entry
 * returned is deleted from the pending map, so nothing can be charged twice. Empty in every other
 * month, and empty in an April whose prior year owed nothing.
 *
 * Signed, like what it was stored as. The caller charges it through the ordinary funding
 * waterfall: a balance due enlarges the month's cash need and may be funded by a taxable
 * withdrawal, and that withdrawal is income in the CURRENT year, folded into the current year's
 * accumulator by the ordinary path — a different year's liability from the one this balance pays.
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

/**
 * The household's whole pending tax balance from the year just closed, summed across persons —
 * what this year's April will charge or refund, before that month consumes it. Signed. Read-only:
 * consuming is {@link dueTaxYearSettlements}'s job alone.
 */
export function pendingSettlementTotalCents(state: SimState, ctx: JurisdictionContext): Cents {
  let total = 0;
  for (const pid of state.personIds) {
    total += state.pendingTaxSettlementsByPersonYear.get(settlementKey(pid, ctx.year - 1))?.totalCents ?? 0;
  }
  return total;
}
