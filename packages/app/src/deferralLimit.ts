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
import type { Plan } from "@finley/engine";
import { primaryBirthYear, primaryJobs } from "./planPeople";

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
export function firstDeferralLimitCrossing(budget: Plan): DeferralLimitCrossing | null {
  // The elective limit is per PERSON, across every plan they defer into — so sum the
  // deferral over ALL of the primary person's jobs, not one "career" job (§11). Each job
  // defers only in the years it is worked, at its own elected fraction, on its own
  // growing salary; the household can hold several jobs, several possibly open-ended.
  const deferringJobs = primaryJobs(budget).filter((j) => (j.deferral?.deferralFraction ?? 0) > 0);
  if (deferringJobs.length === 0) return null;

  const inflation = budget.inflationPct / 100;
  const birthYear = primaryBirthYear(budget);

  for (let k = 0; budget.currentAge + k < budget.retirementAge; k++) {
    const year = START_YEAR + k;
    const age = budget.currentAge + k;

    let annualDeferralCents = 0;
    for (const j of deferringJobs) {
      const endYearExclusive = j.endYear ?? birthYear + budget.retirementAge;
      if (year < j.startYear || year >= endYearExclusive) continue; // not worked this year
      // Nominal salary this year: today's-dollars salary grown by its real slope from the
      // job's start, then CPI-indexed to nominal — the same seam the engine compiles.
      const realCents =
        j.salary.startingSalaryCents * Math.pow(1 + j.salary.realGrowthPct / 100, year - j.startYear);
      const nominalCents = realCents * Math.pow(1 + inflation, year - START_YEAR);
      annualDeferralCents += nominalCents * j.deferral!.deferralFraction;
    }
    annualDeferralCents = Math.round(annualDeferralCents);

    const limitCents = retirementDeferralLimitCents({ year, age });
    if (annualDeferralCents > limitCents) {
      return { year, age, annualDeferralCents, limitCents };
    }
  }
  return null;
}
