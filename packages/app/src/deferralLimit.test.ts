/**
 * The 401(k) elective-limit disclosure. The limit belongs to the **person**, not the
 * household: each person's jobs sum against their own age-indexed limit, and two earners
 * are never pooled. Driven through the real household roster (`jobOwnersOf`) that the Jobs
 * panel reads, so a partner's jobs reach the scan exactly as they do in the app.
 */
import { describe, expect, it } from "vitest";
import {
  PRIMARY_PERSON_ID,
  dollarsToCents,
  type Job,
  type Ledger,
  type LifeEvent,
  type Plan,
} from "@finley/engine";
import { firstDeferralLimitCrossing } from "./deferralLimit";
import { jobOwnersOf } from "./jobOwners";
import { PLAN_DEFAULTS } from "./planDefaults";
import { START_YEAR } from "./config";
import { setJobDeferralFraction, setJobMonthlyIncome } from "./testing/planFixtures";
import { runOf } from "./testing/projectionHarness";

/** The event-free ledger as a public {@link Ledger} literal (the engine's `emptyLedger` is internal). */
const noEvents: Ledger = { events: [], nextSequenceNumber: 0 };

/** The defaults with the default job's salary + deferral set — both ride the job, not the plan. */
function budget(opts: {
  monthlyIncome?: number;
  deferralPct?: number;
  overrides?: Partial<Plan>;
}): Plan {
  let plan: Plan = { ...PLAN_DEFAULTS, ...(opts.overrides ?? {}) };
  // The default plan's lone job, by its engine-minted id — these single-earner cases never
  // override `jobs`, so this is Alex's job on the plan being tuned.
  const jobId = PLAN_DEFAULTS.jobs[0]!.id;
  if (opts.monthlyIncome !== undefined) plan = setJobMonthlyIncome(plan, jobId, dollarsToCents(opts.monthlyIncome));
  if (opts.deferralPct !== undefined) plan = setJobDeferralFraction(plan, jobId, opts.deferralPct / 100);
  return plan;
}

function crossingFor(plan: Plan, ledger: Ledger = noEvents) {
  // The interpreted roster comes from a full run (`runOf(...).household`) — the public read
  // that replaces `interpretLedger` + `createProjectionBase`. The deferral scan reads only the
  // roster and the `rules` limit seam, so the run's jurisdiction is immaterial to the crossing.
  return firstDeferralLimitCrossing(
    jobOwnersOf(runOf(plan, ledger).household, ledger),
    plan.inflationPct,
  );
}

const job = (
  id: string,
  ownerId: string,
  monthlyDollars: number,
  deferralPct: number,
  over: Partial<Job> = {},
): Job => ({
  id,
  ownerId,
  startYear: START_YEAR,
  endYear: START_YEAR - 40 + 65,
  retirementStrategy: "extendable",
  salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), currentSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
  ...(deferralPct > 0
    ? { deferral: { deferralFraction: deferralPct / 100, fundAccountId: "retirement" } }
    : {}),
  ...over,
});

/** A partner joining at month 0 with `jobs` of their own, aged 40 and retiring at 65. */
const partnerWith = (jobs: readonly Job[]): Ledger => ({
  events: [
    {
      id: "r1",
      sequenceNumber: 0,
      type: "RelationshipEvent",
      month: 0,
      person: {
        id: "p-1",
        name: "Sam",
        birthYear: START_YEAR - 40,
        benefitClaimingAge: 67,
        jobs,
      },
    } satisfies LifeEvent,
  ],
  nextSequenceNumber: 1,
});

describe("firstDeferralLimitCrossing — one earner (unchanged behaviour)", () => {
  it("returns null when nothing is deferred", () => {
    expect(crossingFor(budget({ deferralPct: 0 }))).toBeNull();
  });

  it("crosses in the current year when the rate already tops the limit", () => {
    // $60k/yr at 50% = $30k, above the 2026 $24,500 elective limit → crosses at k=0.
    const crossing = crossingFor(budget({ monthlyIncome: 5000, deferralPct: 50 }));
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(START_YEAR);
    expect(crossing!.personName).toBe(PLAN_DEFAULTS.name); // named, even on a solo plan
  });

  it("crosses in a LATER year when income inflates past the limit", () => {
    // $48k/yr at 50% = $24k, just under the 2026 $24,500 limit today. Income grows at
    // 3% CPI while the limit indexes at 2.5%, so it crosses within a few years.
    const crossing = crossingFor(
      budget({
        monthlyIncome: 4000,
        deferralPct: 50,
        overrides: { inflationPct: 3, currentAge: 35, retirementAge: 65 },
      }),
    );
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBeGreaterThan(START_YEAR); // NOT flagged today — the precise part
    expect(crossing!.annualDeferralCents).toBeGreaterThan(crossing!.limitCents);
  });

  it("never crosses when a modest rate stays under the limit for the whole career", () => {
    // $48k/yr at 10% = $4.8k, far below the limit for all 30 working years.
    expect(
      crossingFor(
        budget({
          monthlyIncome: 4000,
          deferralPct: 10,
          overrides: { inflationPct: 3, currentAge: 35, retirementAge: 65 },
        }),
      ),
    ).toBeNull();
  });

  it("stops scanning at retirement — a post-retirement crossing never counts", () => {
    // Retiring next year: even a high rate has only one working year to cross in.
    const crossing = crossingFor(
      budget({
        monthlyIncome: 1500,
        deferralPct: 50,
        overrides: { currentAge: 64, retirementAge: 65 },
      }),
    );
    // $18k/yr at 50% = $9k, under the age-64 limit ($24,500 + $8,000 catch-up) → null.
    expect(crossing).toBeNull();
  });
});

describe("firstDeferralLimitCrossing — a person's own jobs, summed", () => {
  it("aggregates one person's jobs before comparing with the limit", () => {
    // Two jobs at $30k/yr, each deferring 50% = $30k total, over the $24,500 limit.
    // Neither job crosses alone.
    const twoJobs: Plan = {
      ...budget({ monthlyIncome: 2500, deferralPct: 50 }),
      jobs: [
        job("job-1", PRIMARY_PERSON_ID, 2500, 50),
        job("job-2", PRIMARY_PERSON_ID, 2500, 50),
      ],
    };
    const crossing = crossingFor(twoJobs);
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(START_YEAR);
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(30_000));
    expect(crossing!.personName).toBe(PLAN_DEFAULTS.name);
  });

  it("counts only the years a job is actually worked", () => {
    // The second $30k job hasn't started: $15k today, under the limit, crossing when it does.
    const later: Plan = {
      ...PLAN_DEFAULTS,
      inflationPct: 0,
      jobs: [
        job("job-1", PRIMARY_PERSON_ID, 2500, 50),
        job("job-2", PRIMARY_PERSON_ID, 2500, 50, { startYear: START_YEAR + 5 }),
      ],
    };
    const crossing = crossingFor(later);
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(START_YEAR + 5);
  });
});

describe("firstDeferralLimitCrossing — every earner, each against their own limit", () => {
  it("flags a partner who tops the limit on a job of their own", () => {
    // The primary defers nothing; Sam defers $30k on a $60k job — invisible to a scan that
    // reads only `Plan.jobs`, the primary's.
    const crossing = crossingFor(
      budget({ deferralPct: 0 }),
      partnerWith([job("p-1-job-1", "p-1", 5000, 50)]),
    );
    expect(crossing).not.toBeNull();
    expect(crossing!.personId).toBe("p-1");
    expect(crossing!.personName).toBe("Sam");
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(30_000));
    // Read at SAM's age (40), not the primary's (35): catch-up bands are age-indexed, so
    // the wrong age reads the wrong limit.
    expect(crossing!.age).toBe(40);
  });

  it("aggregates a partner's OWN two jobs, and nobody else's", () => {
    const crossing = crossingFor(
      budget({ deferralPct: 0 }),
      partnerWith([job("p-1-job-1", "p-1", 2500, 50), job("p-1-job-2", "p-1", 2500, 50)]),
    );
    expect(crossing).not.toBeNull();
    expect(crossing!.personId).toBe("p-1");
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(30_000));
  });

  it("does NOT pool two people — each stays inside their own limit", () => {
    // $20k + $20k = $40k across the household, past a single $24,500 limit — but the limit
    // is individual and neither person is over theirs. Summing would invent a warning.
    const plan: Plan = {
      ...PLAN_DEFAULTS,
      inflationPct: 0,
      jobs: [job("job-1", PRIMARY_PERSON_ID, 5000, 33.34)], // $60k at 33.34% ≈ $20k
    };
    const crossing = crossingFor(plan, partnerWith([job("p-1-job-1", "p-1", 5000, 33.34)]));
    expect(crossing).toBeNull();
  });

  it("reports the EARLIEST crossing when both people eventually cross", () => {
    // The primary crosses today at 50% of $60k; Sam's smaller job only later, as CPI lifts
    // it. The nudge names one person, so it must be the first.
    const plan = budget({ monthlyIncome: 5000, deferralPct: 50, overrides: { inflationPct: 3 } });
    const crossing = crossingFor(plan, partnerWith([job("p-1-job-1", "p-1", 4000, 50)]));
    expect(crossing).not.toBeNull();
    expect(crossing!.personName).toBe(PLAN_DEFAULTS.name);
    expect(crossing!.year).toBe(START_YEAR);
  });

  it("scans a partner against THEIR retirement age, not the household's", () => {
    // Sam is 40 and retires at 41: one working year, and their $12k deferral is under the
    // limit in it — even though the primary person keeps working for decades.
    const retiringSoon: Ledger = {
      events: [
        {
          id: "r1",
          sequenceNumber: 0,
          type: "RelationshipEvent",
          month: 0,
          person: {
            id: "p-1",
            name: "Sam",
            birthYear: START_YEAR - 40,
            benefitClaimingAge: 67,
            jobs: [job("p-1-job-1", "p-1", 2000, 50)],
          },
        } satisfies LifeEvent,
      ],
      nextSequenceNumber: 1,
    };
    expect(crossingFor(budget({ deferralPct: 0 }), retiringSoon)).toBeNull();
  });
});
