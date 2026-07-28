/**
 * App-side 401(k) deferral-limit disclosure. The waterfall silently caps a pre-tax
 * deferral at the year's IRS elective limit and pays the overflow as taxable income (see
 * the engine's `applyDeferrals`); this surfaces that so the cap isn't invisible in the
 * editor.
 *
 * A per-year scan, not a current-year check: income grows with CPI while the limit indexes
 * at its own lower rate AND steps with the age-banded catch-ups (up at 50, higher at 60–63,
 * back down at 64). A plan under the cap today can cross later, or a catch-up can lift the
 * person back under; only walking each working year finds the first crossing.
 *
 * And **per person** — the elective limit belongs to the earner, not the household: two
 * people each deferring $20k both sit inside a $24,500 limit, while one person deferring
 * $20k across two jobs is over it. So each member's jobs are summed against their own
 * age-indexed limit over their own working years, and the crossing names whose it is.
 * Summing the household would invent a crossing for a couple who has none; folding a
 * partner's jobs in at the primary earner's age would read the wrong catch-up band.
 */

import { retirementDeferralLimitCents } from "@finley/rules";
import { START_YEAR } from "./config";
import type { PersonId } from "@finley/engine";
import type { JobOwner } from "./jobOwners";
import { yearOfMonth } from "./planPeople";

export interface DeferralLimitCrossing {
  /** Whose limit it is — the elective limit is individual. */
  readonly personId: PersonId;
  readonly personName: string;
  /** Calendar year of the first crossing. */
  readonly year: number;
  /** The person's age that year. */
  readonly age: number;
  /** Projected annual pre-tax deferral that year (nominal), across ALL of their jobs. */
  readonly annualDeferralCents: number;
  /** That year's IRS elective limit (nominal), which the deferral exceeds. */
  readonly limitCents: number;
}

/** The calendar years a member is in the household: `[first, lastExclusive)`. */
function membershipYears(owner: JobOwner): { first: number; lastExclusive: number } {
  return {
    // The primary person joins with the base household (`-Infinity`), i.e. from the frozen
    // "now"; a partner only from the month they joined.
    first: Number.isFinite(owner.startMonth) ? yearOfMonth(owner.startMonth) : START_YEAR,
    // `endMonth` is the separation month, whose last paid month is the one before it.
    lastExclusive:
      owner.endMonth === null ? Infinity : yearOfMonth(Math.max(0, owner.endMonth - 1)) + 1,
  };
}

/**
 * The first working year in which **any** member's pre-tax 401(k) deferral would exceed
 * that year's elective limit, else null. Each earner is scanned over the years they are
 * both in the household and still working (age &lt; their retirement age), their deferral
 * summed across every job held that year and compared with the limit read at *their* age
 * from the `rules` seam. Earliest crossing wins; ties go to the earlier member in join
 * order.
 *
 * Nominal, annual granularity — close to the sim's inflation-linked income and indexed
 * limit, not the exact month-by-month cap the engine applies.
 */
export function firstDeferralLimitCrossing(
  owners: readonly JobOwner[],
  inflationPct: number,
): DeferralLimitCrossing | null {
  const inflation = inflationPct / 100;
  let earliest: DeferralLimitCrossing | null = null;

  for (const owner of owners) {
    // The limit is per PERSON, across every plan they defer into — sum ALL their jobs, not
    // one privileged job. Each defers only in the years worked, at its own elected
    // fraction, on its own growing salary.
    const deferringJobs = owner.jobs.filter((j) => (j.deferral?.deferralFraction ?? 0) > 0);
    if (deferringJobs.length === 0) continue;

    const years = membershipYears(owner);
    const retirementYear = owner.birthYear + owner.retirementTargetAge;

    for (let year = years.first; year < retirementYear && year < years.lastExclusive; year++) {
      // A crossing later than one already found can't be the first one.
      if (earliest !== null && year >= earliest.year) break;
      const age = year - owner.birthYear;

      let annualDeferralCents = 0;
      for (const j of deferringJobs) {
        const endYearExclusive = j.endYear ?? retirementYear;
        if (year < j.startYear || year >= endYearExclusive) continue; // not worked this year
        // Nominal salary this year: today's-dollars salary grown by its real slope since
        // the job's start, then CPI-indexed — the same seam the engine compiles.
        const realCents =
          j.salary.startingSalaryCents *
          Math.pow(1 + j.salary.realGrowthPct / 100, year - j.startYear);
        const nominalCents = realCents * Math.pow(1 + inflation, year - START_YEAR);
        annualDeferralCents += nominalCents * j.deferral!.deferralFraction;
      }
      annualDeferralCents = Math.round(annualDeferralCents);

      const limitCents = retirementDeferralLimitCents({ year, age });
      if (annualDeferralCents > limitCents) {
        earliest = {
          personId: owner.id,
          personName: owner.name,
          year,
          age,
          annualDeferralCents,
          limitCents,
        };
        break;
      }
    }
  }
  return earliest;
}
