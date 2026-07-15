/**
 * App-side 401(k) deferral-limit disclosure (§5.4). The waterfall silently caps a
 * pre-tax deferral at the year's IRS elective limit and pays the overflow as taxable
 * income (see the engine's `applyDeferrals`); this derivation surfaces that so the
 * cap is not invisible in the editor.
 *
 * It must be a per-year scan, not a single current-year check: income grows with CPI
 * while the limit indexes forward at its own (lower) rate AND steps with the age-
 * banded catch-ups (up at 50, higher at 60–63, back down at 64). So a plan under the
 * cap today can cross it later — or a catch-up can lift the person back under — and
 * only walking each working year catches the first crossing honestly.
 */

import { retirementDeferralLimitCents } from "@finley/rules";
import { START_YEAR } from "./config";
import type { BudgetValues } from "./planTypes";

export interface DeferralLimitCrossing {
  /** Calendar year of the first crossing. */
  readonly year: number;
  /** The person's age that year. */
  readonly age: number;
  /** Projected annual pre-tax deferral that year (nominal). */
  readonly annualDeferralCents: number;
  /** That year's IRS elective limit (nominal), which the deferral exceeds. */
  readonly limitCents: number;
}

/**
 * The first working year in which the plan's pre-tax 401(k) deferral would exceed
 * that year's elective limit, or null if it stays within the limit for the whole
 * career. Scans each year the person is still working (age &lt; retirement), growing
 * income at CPI and reading the age-indexed limit from the `rules` seam.
 *
 * Nominal, annual granularity — a close match to the sim's inflation-linked income
 * and nominal indexed limit, not the exact month-by-month cap the engine applies.
 */
export function firstDeferralLimitCrossing(budget: BudgetValues): DeferralLimitCrossing | null {
  const fraction = budget.retirementDeferralPct / 100;
  if (fraction <= 0) return null;

  const annualIncomeNowCents = budget.incomeCents * 12;
  const inflation = budget.inflationPct / 100;

  for (let k = 0; budget.currentAge + k < budget.retirementAge; k++) {
    const year = START_YEAR + k;
    const age = budget.currentAge + k;
    const annualDeferralCents = Math.round(
      annualIncomeNowCents * Math.pow(1 + inflation, k) * fraction,
    );
    const limitCents = retirementDeferralLimitCents({ year, age });
    if (annualDeferralCents > limitCents) {
      return { year, age, annualDeferralCents, limitCents };
    }
  }
  return null;
}
