/**
 * **When would this household first defer more into a retirement plan than the year's elective
 * limit allows?** — a disclosure, computed off the same authored facts the projection runs on.
 *
 * The waterfall already caps a pre-tax deferral at the limit and pays the overflow as taxable
 * income, silently and correctly. This exists to say so BEFORE it happens, so a household
 * planning a percentage never discovers that a slice of it has quietly been landing in a taxable
 * account for years.
 *
 * Income grows with CPI while the limit indexes lower AND steps at the age-banded catch-ups (50,
 * higher 60–63, back down at 64), so the first crossing needs every working year walked rather
 * than a closed-form comparison at one date.
 *
 * **Per person.** The elective limit belongs to the earner: summing a household invents crossings
 * a couple does not have, and folding a partner's jobs in at the primary's age reads the wrong
 * catch-up band. Each member is scanned against the limit read at THEIR age.
 *
 * This lived in the app. It read `Job.startYear`/`endYear` to decide which years were worked,
 * read `HouseholdMembership.endMonth` to decide which years belonged to the household, and
 * projected pay with a `Math.pow` of its own — three rules the engine already owned, restated
 * where nothing could keep them in step. Every one of them is now the engine's single answer:
 * the paid window comes from {@link resolveHouseholdJobs}, and the pay from
 * {@link jobPayPath}, which mirrors the simulator's own series to the cent.
 */

import { interpretLedger } from "../ledger/interpret";
import { createProjectionBase } from "../compile/projectionBase";
import { jobPayPath } from "../job/job";
import {
  householdPaidMonths,
  householdPaidYears,
  personJobContexts,
  resolveHouseholdJobs,
  type HouseholdPaidMonths,
  type ResolvedHouseholdJob,
} from "../job/householdJob";
import type { ProjectionContext } from "../compile/projectionBase";
import type { Scenario } from "../plan/scenario";
import type { PersonId } from "../job/job";
import type { Cents } from "../money/money";

export interface DeferralLimitCrossing {
  /** Whose limit it is — the elective limit is individual. */
  readonly personId: PersonId;
  readonly personName: string;
  /** Calendar year of the first crossing. */
  readonly year: number;
  /** The person's age that year. */
  readonly age: number;
  /** Projected annual pre-tax deferral that year (nominal), across ALL of their jobs. */
  readonly annualDeferralCents: Cents;
  /** That year's elective limit (nominal), which the deferral exceeds. */
  readonly limitCents: Cents;
}

/** One deferring job, with the window it pays this household and the pay it pays over it. */
interface DeferringJob {
  readonly resolved: ResolvedHouseholdJob;
  readonly paid: HouseholdPaidMonths;
  readonly deferralFraction: number;
  monthlyCentsAt(month: number): Cents;
}

/**
 * The first year any member's pre-tax deferral would exceed their own elective limit, else
 * `null`. Earliest crossing wins; ties go to the earlier member in join order.
 *
 * Nominal and annual: close to the sim's inflation-linked income and indexed limit, not the exact
 * month-by-month cap the waterfall applies. `null` for a jurisdiction that states no limit —
 * there is nothing to cross.
 */
export function firstDeferralLimitCrossing(
  scenario: Scenario,
  ctx: ProjectionContext,
): DeferralLimitCrossing | null {
  const limitAt = ctx.jurisdiction.retirementDeferralLimitCents;
  if (limitAt === undefined) return null;

  const base = createProjectionBase(scenario.plan, ctx);
  const household = interpretLedger(scenario.ledger, base);
  const inflationRate = scenario.plan.inflationPct / 100;

  let earliest: DeferralLimitCrossing | null = null;

  // Join order, so a tie between two members resolves to the one who was here first.
  for (const membership of household.memberships) {
    const person = membership.person;
    // `"authored"`: this discloses what the plan the household wrote down would do. A solver
    // candidate is a hypothesis they have not adopted and must not move what their plan says.
    const deferring: DeferringJob[] = [];
    for (const resolved of resolveHouseholdJobs(
      personJobContexts(membership),
      ctx.startYear,
      { kind: "authored" },
    )) {
      const deferralFraction = resolved.job.deferral?.deferralFraction ?? 0;
      if (deferralFraction <= 0) continue;
      // The months this household is actually paid for the job — employment ∩ membership, the
      // engine's one answer. A job wholly behind us, or one whose owner had left before it
      // began, yields none and is skipped rather than special-cased.
      const paid = householdPaidMonths(resolved);
      if (paid === null) continue;
      // Compiled over the EMPLOYMENT, not the paid window: growth anchors on when the job
      // started, and clipping the anchor would restate the pay of every month after a join.
      const path = jobPayPath(
        resolved.job,
        {
          startMonth: resolved.employmentStartMonth,
          endMonthExclusive: resolved.employmentEndMonthExclusive,
        },
        { inflationRate, denomination: "paycheck" },
      );
      deferring.push({
        resolved,
        paid,
        deferralFraction,
        monthlyCentsAt: (month) => path.monthlyCentsAt(month),
      });
    }
    if (deferring.length === 0) continue;

    const windows = deferring.map((d) => householdPaidYears(d.paid, ctx.startYear));
    const firstYear = Math.min(...windows.map((w) => w.fromYear));
    const lastYearExclusive = Math.max(...windows.map((w) => w.toYearExclusive));

    for (let year = firstYear; year < lastYearExclusive; year++) {
      // A crossing later than one already found cannot be the first one.
      if (earliest !== null && year >= earliest.year) break;

      const yearStartMonth = (year - ctx.startYear) * 12;
      let annualDeferralCents = 0;
      for (const job of deferring) {
        for (let month = yearStartMonth; month < yearStartMonth + 12; month++) {
          // Summed month by month rather than annualized off one of them: a pay change lands on
          // a month, and a raise in July is half a year of each figure.
          if (month < job.paid.fromMonth || month >= job.paid.toMonthExclusive) continue;
          annualDeferralCents += job.monthlyCentsAt(month) * job.deferralFraction;
        }
      }
      annualDeferralCents = Math.round(annualDeferralCents);
      if (annualDeferralCents === 0) continue;

      const age = year - person.birthYear;
      const limitCents = limitAt({ year, age });
      if (annualDeferralCents > limitCents) {
        earliest = {
          personId: person.id,
          personName: person.name,
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
