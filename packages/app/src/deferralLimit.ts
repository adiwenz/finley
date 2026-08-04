/**
 * App-side 401(k) deferral-limit disclosure: the waterfall (`applyDeferrals`) silently caps
 * a pre-tax deferral at the year's IRS elective limit, paying overflow as taxable income.
 *
 * Income grows with CPI while the limit indexes lower AND steps at the age-banded catch-ups
 * (50, higher 60–63, back down at 64), so the first crossing needs every working year
 * walked.
 *
 * And **per person** — the limit belongs to the earner: summing the household invents
 * crossings a couple lacks; folding a partner's jobs in at the primary earner's age reads
 * the wrong catch-up band.
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
 * both in the household and still working (age &lt; their retirement age), against the
 * limit read at *their* age from the `rules` seam. Earliest crossing wins; ties go to the
 * earlier member in join order.
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
    // Every plan the person defers into, not one privileged job.
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
        const endYearExclusive = j.endYear;
        if (year < j.startYear || year >= endYearExclusive) continue; // not worked this year
        // Projected pay grows off the CURRENT-SALARY ANCHOR, never the job's starting salary:
        // this scan is forward-only, and the engine's forward series bases month 0 on the
        // authored current salary. Real slope from "now", then CPI-indexed — the same seam.
        const realCents =
          j.salary.currentSalaryCents *
          Math.pow(1 + j.salary.realGrowthPct / 100, year - START_YEAR);
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
