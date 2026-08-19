/**
 * **Monthly federal income-tax withholding on wages — the one in-year income-tax cash flow.**
 *
 * A household earning $60k does not hand the government nothing for twelve months and then a
 * lump the following April; its employer withholds every paycheck. Modelling the year as a
 * single April charge overstated take-home all year, let balances build up on money that was
 * never the household's, and then crashed them in one month. So wages are withheld against
 * monthly here — and NOTHING else is.
 *
 * ## The causality rule this module exists to respect
 *
 * A transaction in month M must never change a cash flow in a month before M. That rules out
 * the obvious way to withhold accurately (look at what the year is GOING to earn and spread its
 * tax evenly), which is exactly the perfect-foresight forecast this replaced: an October
 * withdrawal would raise January's withholding, and January's balance would fall because of
 * something that had not happened yet. Every input here is therefore strictly backward-looking:
 *
 *  - the base is YEAR-TO-DATE wage income, through the current month and no further;
 *  - the running total already withheld is what the earlier months actually charged;
 *  - nothing consults a later month, an authored event, or a future account balance.
 *
 * ## The method: annualize, price, prorate
 *
 * Cumulative withholding due through month `m` of the year is
 *
 * ```
 *   annualTax( YTD wages × 12/m ) × m/12
 * ```
 *
 * — the paycheck approximation a real payer makes: treat the pay so far as the year's run rate,
 * price a full year of it through the ordinary annual seam, and collect the elapsed fraction.
 * The month CHARGES the difference between that figure and what has already been withheld.
 *
 * For the level earner this is exact and perfectly smooth: `YTD × 12/m` is the same salary every
 * month, so the cumulative figure is `annualTax(salary) × m/12` and each month charges a twelfth.
 * A raise or a bonus in month M raises the run rate from M onward, catching up over the rest of
 * the year — and never before M, which is the whole point.
 *
 * ## What it deliberately gets wrong, and where that lands
 *
 * Withholding is an ESTIMATE and is not meant to be exact. It sees only wages, so a year with a
 * large capital gain or a pre-tax withdrawal under-withholds, and one with a big January bonus
 * over-withholds. Both are correct behaviour, not error: the difference is the balance (or
 * refund) the following April settles ({@link import("./taxYearSettlement").finalizeTaxYear}),
 * which is what a tax return is for. No attempt is made to shrink that true-up by anticipating
 * anything, and quarterly estimated payments on non-wage income are not modelled.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { TaxCategory } from "../money/cashFlowSeries";
import { addCategory, type TaxableByCategory } from "./taxAttribution";
import { MONTHS_IN_TAX_YEAR } from "./federalIncomeTax";

/** 1..12 — how many months of the tax year `month` completes, the annualization divisor. */
export function monthsElapsedInTaxYear(month: number): number {
  return (month % MONTHS_IN_TAX_YEAR) + 1;
}

/**
 * The slice of a taxable-income map a payer withholds against — `{}` when the jurisdiction
 * withholds on nothing, which is how a jurisdiction opts out of in-year income tax entirely.
 */
export function withheldCategoriesOnly(
  jurisdiction: Jurisdiction,
  taxableByCategory: TaxableByCategory,
): TaxableByCategory {
  const gate = jurisdiction.isWithheldCategory;
  if (gate === undefined) return {};
  const base: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(taxableByCategory)) {
    if (cents && gate(category as TaxCategory)) addCategory(base, category as TaxCategory, cents);
  }
  return base;
}

/** Σ of a per-category map. */
export function totalOfCategories(byCategory: TaxableByCategory): Cents {
  let total = 0;
  for (const cents of Object.values(byCategory)) total += cents ?? 0;
  return total;
}

/**
 * Cumulative withholding DUE through `month`, per category: the year-to-date withheld-category
 * income annualized to a full year, priced through the jurisdiction's annual seam, and prorated
 * back to the elapsed fraction of the year. `{}` when nothing has been earned in a withheld
 * category yet.
 *
 * Per category rather than as a scalar so the month's charge can be attributed back to the
 * income sources that bore it, exactly as payroll tax's incremental charge is. The scalar is
 * simply Σ, so the two can never disagree — this never calls {@link
 * Jurisdiction.computeTaxCents} for a total it then reports a different breakdown of.
 */
export function cumulativeWithholdingByCategoryCents(
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  ytdWithheldBaseCents: TaxableByCategory,
  month: number,
): TaxableByCategory {
  const elapsed = monthsElapsedInTaxYear(month);
  const annualized: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(ytdWithheldBaseCents)) {
    if (cents) {
      addCategory(
        annualized,
        category as TaxCategory,
        Math.round((cents * MONTHS_IN_TAX_YEAR) / elapsed),
      );
    }
  }
  if (totalOfCategories(annualized) <= 0) return {};

  const annualTaxByCategory = jurisdiction.computeTaxByCategoryCents(annualized, ctx);
  const cumulative: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(annualTaxByCategory)) {
    if (cents) {
      addCategory(
        cumulative,
        category as TaxCategory,
        Math.round((cents * elapsed) / MONTHS_IN_TAX_YEAR),
      );
    }
  }
  return cumulative;
}

/**
 * What THIS month withholds, per category: the cumulative figure due through it, less what the
 * year has already withheld.
 *
 * **Never negative, per category.** A month whose run rate falls (a bonus month rolling out of
 * the annualization, wages stopping mid-year) makes the cumulative figure drop below what is
 * already collected; withholding then simply stops, rather than refunding cash mid-year. Real
 * withholding behaves the same way, and the over-withheld amount comes back as an April refund.
 * The clamp is per category so the total is always Σ of the parts, and it is what makes the
 * running total monotone — so no month can ever undo an earlier month's charge.
 *
 * `ytdWithheldBaseCents` must INCLUDE this month's own wage income, and `alreadyWithheldCents`
 * must exclude this month's charge (it is what this returns).
 */
export function monthlyWithholdingByCategoryCents(
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  ytdWithheldBaseCents: TaxableByCategory,
  alreadyWithheldCents: TaxableByCategory,
  month: number,
): TaxableByCategory {
  const cumulative = cumulativeWithholdingByCategoryCents(
    jurisdiction,
    ctx,
    ytdWithheldBaseCents,
    month,
  );
  const increment: TaxableByCategory = {};
  for (const [category, cents] of Object.entries(cumulative)) {
    const due = cents ?? 0;
    const paid = alreadyWithheldCents[category as TaxCategory] ?? 0;
    addCategory(increment, category as TaxCategory, Math.max(0, due - paid));
  }
  return increment;
}
