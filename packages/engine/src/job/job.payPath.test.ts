/**
 * **{@link jobPayPath} — what one authored job pays, month by month, across its own span.**
 *
 * A public engine function and the owner of this arithmetic: the two salary anchors a job states
 * (what it started at, what it pays now) and the curve between and beyond them — real growth,
 * the month-0 anchor, a pay change dated at month 0, the difference between today's dollars and
 * the nominal paycheck, and the flat reconstruction of a history nobody authored month by month.
 *
 * Adjustments to that curve — one-month overrides and permanent pay changes — are
 * `job.adjustments.test.ts`. What the compiled series then does inside a household is
 * `job.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID } from "../compile/projectionBase";
import { samplePlan, salariedJob, SAMPLE_JOB_END_AGE } from "../testing/samplePlan";
import {
  jobPayPath,
  monthlyIncomeCentsOf,
  startingMonthlyIncomeCentsOf,
  type Job,
} from "./job";
import type { Person } from "../plan/person";
import { compileHouseholdJobSeries, compilePersonPriorEarnings } from "../compile/compilePerson";
import { personJobContexts, resolveHouseholdJobs } from "./householdJob";
import { dollarsToCents } from "../money/cashFlowSeries";

const START_YEAR = 2026;

/**
 * One person's jobs compiled as an always-present household member — the shape these tests
 * care about, with the membership window (a partner's concern) left wide open.
 */
function compilePersonIncomeSeries(person: Person, nowYear: number, inflationRate: number) {
  const membership = { person, startMonth: -Infinity, endMonth: null };
  return compileHouseholdJobSeries(
    // Authored: no hypothetical stop, so an open-ended job runs to the horizon.
    resolveHouseholdJobs(personJobContexts(membership), nowYear, { kind: "authored" }),
    inflationRate,
  );
}




describe("Job/Person standing model — the month-0 current-salary anchor", () => {
  // A 40-year-old whose job started at 18 (year 2004), so history spans [2004 … 2025] and the
  // projection owns 2026 onward. The two salary anchors are authored INDEPENDENTLY here —
  // that is the whole point of the suite: the starting salary reconstructs history, the
  // current salary is authoritative from month 0, and neither is derived from the other.
  const personWith = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: START_YEAR - 40,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    jobs,
  });

  /** A job with a deliberately different start pay and current pay. Annual cents in. */
  const jobWith = (
    startingAnnualCents: number,
    currentAnnualCents: number,
    extra: Partial<Job> = {},
  ): Job => ({
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - 22, // 2004
    endYear: START_YEAR + 40,
    salary: {
      startingSalaryCents: startingAnnualCents,
      currentSalaryCents: currentAnnualCents,
      realGrowthPct: 0,
    },
    ...extra,
  });

  const priorFor = (job: Job): Record<number, number> =>
    compilePersonPriorEarnings(personWith([job]), START_YEAR);
  const forwardFor = (job: Job, inflationRate = 0) =>
    compilePersonIncomeSeries(personWith([job]), START_YEAR, inflationRate)[0]!.series;

  const START_60K = dollarsToCents(60_000);
  const CURRENT_80K = dollarsToCents(80_000);
  /** $80,000/yr as the monthly figure the anchor actually pays. */
  const MONTHLY_80K = Math.round(CURRENT_80K / 12);

  it("reconstructs history from a `setTo` raise, then starts month 0 at the current salary", () => {
    // Start $60k; raised to $75k/yr ($6,250/mo) from month −24; authored current pay $80k.
    const job = jobWith(START_60K, CURRENT_80K, {
      payChanges: [{ id: "adjustment-78", month: -24, kind: "setTo", cents: dollarsToCents(6_250) }],
    });

    const prior = priorFor(job);
    expect(prior[2023]).toBe(dollarsToCents(60_000)); // before the raise
    expect(prior[2024]).toBe(dollarsToCents(75_000)); // raise in force
    expect(prior[2025]).toBe(dollarsToCents(75_000)); // still in force at month −1

    // Month 0 resets to the authored current salary — NOT the $75k the history ended on.
    const forward = forwardFor(job);
    expect(forward.getMonthlyCents(0)).toBe(MONTHLY_80K);
    expect(forward.getMonthlyCents(11)).toBe(MONTHLY_80K);
  });

  it("applies a historical `changeBy` to prior earnings without reapplying it to current salary", () => {
    // Start $60k ($5,000/mo); +$1,000/mo from month −12 → $6,000/mo for 2025.
    const job = jobWith(START_60K, CURRENT_80K, {
      payChanges: [{ id: "adjustment-79", month: -12, kind: "changeBy", cents: dollarsToCents(1_000) }],
    });

    const prior = priorFor(job);
    expect(prior[2024]).toBe(dollarsToCents(60_000));
    expect(prior[2025]).toBe(dollarsToCents(72_000)); // $6,000/mo × 12

    // The +$1,000/mo is a historical fact, already reflected in the authored current salary.
    // Adding it again would read $81,000/yr; the anchor is exactly $80,000.
    expect(forwardFor(job).getMonthlyCents(0)).toBe(MONTHLY_80K);
  });

  it("composes multiple historical changes chronologically, each superseding the last", () => {
    const job = jobWith(START_60K, CURRENT_80K, {
      payChanges: [
        // Authored out of order on purpose — application is by date, not array order.
        { id: "adjustment-80", month: -12, kind: "changeBy", cents: dollarsToCents(500) }, // → $6,500/mo
        { id: "adjustment-81", month: -36, kind: "setTo", cents: dollarsToCents(6_000) }, // → $6,000/mo
      ],
    });

    const prior = priorFor(job);
    expect(prior[2022]).toBe(dollarsToCents(60_000)); // before either change
    expect(prior[2023]).toBe(dollarsToCents(72_000)); // setTo $6,000/mo
    expect(prior[2024]).toBe(dollarsToCents(72_000)); // holds
    expect(prior[2025]).toBe(dollarsToCents(78_000)); // changeBy on top → $6,500/mo
    expect(forwardFor(job).getMonthlyCents(0)).toBe(MONTHLY_80K);
  });

  it("keeps a historical one-month override in its own month and out of projected pay", () => {
    const job = jobWith(START_60K, CURRENT_80K, {
      incomeOverrides: [{ id: "adjustment-82", month: -6, kind: "addBonus", cents: dollarsToCents(5_000) }],
    });

    const prior = priorFor(job);
    expect(prior[2025]).toBe(dollarsToCents(65_000)); // $60,000 + the one-off $5,000
    expect(prior[2024]).toBe(dollarsToCents(60_000)); // neighbours untouched

    const forward = forwardFor(job);
    expect(forward.getMonthlyCents(0)).toBe(MONTHLY_80K); // no bonus leaks across month 0
    expect(forward.getMonthlyCents(6)).toBe(MONTHLY_80K);
  });

  it("accepts a step between the reconstructed month −1 salary and the current salary", () => {
    // History ends at $75k/yr; current pay is authored at $80k. The engine does not reconcile
    // them — the discontinuity is the authored truth, and month 0 is exactly the current pay.
    const job = jobWith(START_60K, CURRENT_80K, {
      payChanges: [{ id: "adjustment-83", month: -24, kind: "setTo", cents: dollarsToCents(6_250) }],
    });

    const endOfHistoryAnnual = priorFor(job)[2025]!;
    const monthZero = forwardFor(job).getMonthlyCents(0);

    expect(endOfHistoryAnnual).toBe(dollarsToCents(75_000));
    expect(monthZero).toBe(MONTHLY_80K);
    expect(monthZero).not.toBe(Math.round(endOfHistoryAnnual / 12)); // the step is real
  });

  it("applies a FUTURE pay change to the current-salary anchor, not the historical pay", () => {
    const job = jobWith(START_60K, CURRENT_80K, {
      payChanges: [
        { id: "adjustment-84", month: -24, kind: "setTo", cents: dollarsToCents(6_250) }, // history: $6,250/mo
        { id: "adjustment-85", month: 6, kind: "changeBy", cents: dollarsToCents(1_000) }, // future: +$1,000/mo
      ],
    });

    const forward = forwardFor(job);
    expect(forward.getMonthlyCents(5)).toBe(MONTHLY_80K);
    // Built on the $6,666/mo anchor, NOT on the $6,250/mo the history ended at.
    expect(forward.getMonthlyCents(6)).toBe(MONTHLY_80K + dollarsToCents(1_000));
    expect(forward.getMonthlyCents(6)).not.toBe(dollarsToCents(6_250 + 1_000));
  });

  it("does not double-apply inflation at month 0, and grows annually from the boundary", () => {
    // 3% CPI, real-flat. Current pay $120,000/yr = $10,000/mo, authored as of "now".
    const job = jobWith(START_60K, dollarsToCents(120_000));
    const forward = forwardFor(job, 0.03);

    // Month 0 is the authored figure verbatim — indexing it would double-count the CPI that
    // already brought the salary to today's dollars.
    expect(forward.getMonthlyCents(0)).toBe(dollarsToCents(10_000));
    // Growth runs annually from the projection boundary: month 0's authored figure holds for
    // a full year and the first raise lands at month 12. The job's own start is NOT the clock
    // — it is clamped to 0 — and no historical raise cadence is carried over. What this pins
    // is that the anchor neither pre-grows month 0 nor skips a year.
    expect(forward.getMonthlyCents(11)).toBe(dollarsToCents(10_000));
    expect(forward.getMonthlyCents(12)).toBe(dollarsToCents(10_300)); // exactly one 3% step

    // History holds the STARTING salary flat — nothing grows before month 0 — so every past
    // year is the $60,000 that was authored, and the $120,000 current pay is the forward
    // series' alone. CPI never reaches the record: it is a remembered paycheck, not a projection.
    expect(priorFor(job)[2025]).toBe(dollarsToCents(60_000));
    expect(priorFor(job)[2015]).toBe(dollarsToCents(60_000));
  });
});


describe("the two salary anchors, stated separately", () => {
  const job: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - 11,
    endYear: START_YEAR + 40,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(80_000),
      realGrowthPct: 0,
    },
  };

  it("reads each anchor without the other bleeding in", () => {
    // Neither anchor derives from the other, so a surface showing both reads them one at a
    // time — de-growing today's pay to guess the start pay would reapply the raises today's
    // pay already includes.
    const raised: Job = {
      ...job,
      salary: { ...job.salary, currentSalaryCents: dollarsToCents(7_500) * 12 },
    };
    expect(monthlyIncomeCentsOf(raised)).toBe(dollarsToCents(7_500));
    expect(startingMonthlyIncomeCentsOf(raised)).toBe(dollarsToCents(5_000));

    const restated: Job = {
      ...job,
      salary: { ...job.salary, startingSalaryCents: dollarsToCents(4_000) * 12 },
    };
    expect(startingMonthlyIncomeCentsOf(restated)).toBe(dollarsToCents(4_000));
    expect(monthlyIncomeCentsOf(restated)).toBe(dollarsToCents(80_000 / 12));
  });

  it("reads both anchors alike for a job stated in one number", () => {
    // A job authored from a single salary field sets both anchors to it, so the two readers
    // agree — the flat history a one-number job stands for.
    const monthly = dollarsToCents(6_000);
    const flat: Job = {
      ...job,
      salary: { ...job.salary, startingSalaryCents: monthly * 12, currentSalaryCents: monthly * 12 },
    };
    expect(monthlyIncomeCentsOf(flat)).toBe(monthly);
    expect(startingMonthlyIncomeCentsOf(flat)).toBe(monthly);
  });
});

describe("jobPayPath — a job's authored pay across its span", () => {
  // The scenario the UI could not reach before: $60k at the start, a raise to $75k five years
  // ago, $80k stated as today's pay. Owner is 41; the job began at 30.
  const historic: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - 11,
    endYear: START_YEAR + 40,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(80_000),
      realGrowthPct: 0,
    },
    payChanges: [
      { id: "adjustment-87", month: -60, kind: "setTo", cents: dollarsToCents(6_250) },
      { id: "adjustment-88", month: 72, kind: "setTo", cents: dollarsToCents(7_500) },
    ],
  };
  const span = { startMonth: -132, endMonthExclusive: (67 - 41) * 12 };

  it("reads history off the START anchor and everything from month 0 off the CURRENT one", () => {
    const path = jobPayPath(historic, span);
    expect(path.monthlyCentsAt(-132)).toBe(dollarsToCents(5_000)); // as it started
    expect(path.monthlyCentsAt(-61)).toBe(dollarsToCents(5_000)); // still, the month before
    expect(path.monthlyCentsAt(-60)).toBe(dollarsToCents(6_250)); // the historical raise
    expect(path.monthlyCentsAt(-1)).toBe(dollarsToCents(6_250)); // held to the seam
    expect(path.monthlyCentsAt(0)).toBe(dollarsToCents(80_000 / 12)); // the authored anchor
    expect(path.monthlyCentsAt(72)).toBe(dollarsToCents(7_500)); // the future raise
  });

  it("measures the month-0 step rather than closing it", () => {
    // The engine deliberately does not reconcile the two anchors, so the UI's job is to state
    // the gap. $6,667 stated against a history that reached $6,250.
    const path = jobPayPath(historic, span);
    expect(path.historyReachMonthlyCents).toBe(dollarsToCents(6_250));
    // To the nearest dollar, and measured against the history CONTINUED to month 0 — which
    // here is the same $6,250, since this job has no real growth to step by.
    expect(path.monthZeroStepCents).toBe(
      Math.round((dollarsToCents(80_000 / 12) - dollarsToCents(6_250)) / 100) * 100,
    );
  });

  it("reports no step when the history lands exactly on today's pay", () => {
    const monthly = dollarsToCents(6_250);
    const flat = jobPayPath(
      {
        ...historic,
        salary: { ...historic.salary, startingSalaryCents: monthly * 12, currentSalaryCents: monthly * 12 },
      },
      span,
    );
    expect(flat.monthZeroStepCents).toBe(0);
  });

  it("pays nothing outside the job's own span", () => {
    const path = jobPayPath(historic, span);
    expect(path.monthlyCentsAt(-133)).toBe(0);
    expect(path.monthlyCentsAt(span.endMonthExclusive)).toBe(0);
  });

  it("has no seam for a job that ended before now, but still knows what it last paid", () => {
    // A wholly-past job's month-0 anchor is never read by the engine, so the UI must not ask
    // for one — and what it last paid is the value that anchor should be pinned to.
    const barista: Job = {
      id: "job-2",
      ownerId: PRIMARY_PERSON_ID,
      startYear: START_YEAR - 19,
      endYear: START_YEAR - 15,
      salary: {
        startingSalaryCents: dollarsToCents(21_600),
        currentSalaryCents: dollarsToCents(21_600),
        realGrowthPct: 0,
      },
      payChanges: [{ id: "adjustment-89", month: -204, kind: "setTo", cents: dollarsToCents(2_100) }],
    };
    const path = jobPayPath(barista, { startMonth: -228, endMonthExclusive: -180 });
    expect(path.endedBeforeNow).toBe(true);
    expect(path.monthZeroStepCents).toBe(0);
    expect(path.historyReachMonthlyCents).toBe(dollarsToCents(2_100));
    expect(path.monthlyCentsAt(0)).toBe(0);
  });

  it("compounds real growth forward, and never backward into the past", () => {
    // Growth is a forward-half rule. The past is remembered rather than projected, so the same
    // `realGrowthPct` that compounds after month 0 does nothing at all before it.
    const growing: Job = {
      ...historic,
      salary: { ...historic.salary, realGrowthPct: 10 },
      payChanges: [],
    };
    const path = jobPayPath(growing, span);
    expect(path.monthlyCentsAt(0)).toBe(dollarsToCents(80_000 / 12));
    expect(path.monthlyCentsAt(12)).toBe(Math.round(dollarsToCents(80_000 / 12) * 1.1));
    // History is FLAT at the start anchor, whatever the growth rate says.
    expect(path.monthlyCentsAt(-132)).toBe(dollarsToCents(5_000));
    expect(path.monthlyCentsAt(-120)).toBe(dollarsToCents(5_000));
    expect(path.monthlyCentsAt(-1)).toBe(dollarsToCents(5_000));
  });
});

/**
 * A pay change dated at month 0 — what the Jobs panel writes when a user types their own current
 * age. Month 0 belongs to the authored `currentSalaryCents`, so the change cannot displace it;
 * it takes force at month 1 instead of overriding "now" or being discarded. Asserted on BOTH
 * readers, because the projection compiler and `jobPayPath` mirror each other by hand and this
 * is exactly the boundary where they would drift apart unnoticed.
 */
describe("a permanent pay change authored at month 0 — deferred to month 1", () => {
  const person = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: samplePlan.primary.birthYear,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
    jobs,
  });
  // Zero inflation, so a projected paycheck is the authored figure and the two readers are
  // directly comparable — the deferral rule is what is under test, not the growth machinery.
  const projected = (job: Job, month: number): number =>
    compilePersonIncomeSeries(person([job]), START_YEAR, 0)[0].series.getMonthlyCents(month);
  /** The same job read through the authoring path, over its whole projected span. */
  const authored = (job: Job, month: number): number =>
    jobPayPath(job, {
      startMonth: 0,
      endMonthExclusive: (SAMPLE_JOB_END_AGE - (START_YEAR - samplePlan.primary.birthYear)) * 12,
    }).monthlyCentsAt(month);

  /** $60k/yr = a round $5,000/mo, real-flat. */
  const base: Job = salariedJob(dollarsToCents(60_000) / 12);

  it("setTo: month 0 still pays the stated current salary, month 1 pays the new one", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-90", month: 0, kind: "setTo", cents: dollarsToCents(72_000) / 12 }],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(5_000));
    expect(projected(job, 1)).toBe(dollarsToCents(6_000));
    expect(projected(job, 24)).toBe(dollarsToCents(6_000));
    expect(authored(job, 0)).toBe(dollarsToCents(5_000));
    expect(authored(job, 1)).toBe(dollarsToCents(6_000));
  });

  it("changeBy: the delta lands on month 1, off the month-0 salary", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-91", month: 0, kind: "changeBy", cents: dollarsToCents(6_000) / 12 }],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(5_000));
    expect(projected(job, 1)).toBe(dollarsToCents(5_500));
    expect(authored(job, 0)).toBe(dollarsToCents(5_000));
    expect(authored(job, 1)).toBe(dollarsToCents(5_500));
  });

  it("applies several month-0 changes in a stable, authored sequence", () => {
    // Both defer to month 1 and compose there in the order they were written — a `setTo`
    // followed by a `changeBy` is $6,000 then +$500, never the other way round. The facade
    // keeps at most one change per authored month, so this shape reaches the compiler from a
    // plan built any other way (seed data, an import); the order still has to be a rule.
    const job: Job = {
      ...base,
      payChanges: [
        { id: "adjustment-92", month: 0, kind: "setTo", cents: dollarsToCents(6_000) },
        { id: "adjustment-93", month: 0, kind: "changeBy", cents: dollarsToCents(500) },
      ],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(5_000));
    expect(projected(job, 1)).toBe(dollarsToCents(6_500));
    expect(authored(job, 1)).toBe(dollarsToCents(6_500));
  });

  it("orders a deferred month-0 change ahead of one authored at month 1", () => {
    // Effective month first, authored month second: the month-0 change opens the segment the
    // month-1 `changeBy` then adds to, whatever order they sit in the array.
    const job: Job = {
      ...base,
      payChanges: [
        { id: "adjustment-94", month: 1, kind: "changeBy", cents: dollarsToCents(1_000) },
        { id: "adjustment-95", month: 0, kind: "setTo", cents: dollarsToCents(6_000) },
      ],
    };
    expect(projected(job, 1)).toBe(dollarsToCents(7_000));
    expect(authored(job, 1)).toBe(dollarsToCents(7_000));
  });

  it("does NOT defer a one-month bonus — a month-0 bonus is paid in month 0", () => {
    // A bonus adds to the month's pay instead of replacing the base salary, so the current
    // anchor is not in question and there is nothing to defer.
    const job: Job = {
      ...base,
      incomeOverrides: [{ id: "adjustment-96", month: 0, kind: "addBonus", cents: dollarsToCents(2_000) }],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(7_000));
    expect(projected(job, 1)).toBe(dollarsToCents(5_000));
  });

  it("leaves a month-1 change exactly where it was authored", () => {
    // The fix special-cases the month-0 boundary only; nothing else shifts by a month.
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-97", month: 1, kind: "setTo", cents: dollarsToCents(6_000) }],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(5_000));
    expect(projected(job, 1)).toBe(dollarsToCents(6_000));
    expect(authored(job, 1)).toBe(dollarsToCents(6_000));
  });

  it("leaves a historical change in history, unmoved", () => {
    const historical: Job = {
      ...base,
      startYear: START_YEAR - 5,
      payChanges: [{ id: "adjustment-98", month: -24, kind: "setTo", cents: dollarsToCents(4_000) }],
    };
    const path = jobPayPath(historical, { startMonth: -60, endMonthExclusive: 120 });
    expect(path.monthlyCentsAt(-25)).toBe(dollarsToCents(5_000));
    expect(path.monthlyCentsAt(-24)).toBe(dollarsToCents(4_000));
    expect(path.monthlyCentsAt(-1)).toBe(dollarsToCents(4_000));
    // Still dropped at the seam: the current anchor owns month 0.
    expect(path.monthlyCentsAt(0)).toBe(dollarsToCents(5_000));
  });

  it("keeps `monthlyIncomeCentsOf` equal to the projected month-0 base salary", () => {
    // The invariant the deferral protects: the figure the facade reads back as today's pay is
    // the figure the projection actually pays this month. A month-0 change used to break it.
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-99", month: 0, kind: "setTo", cents: dollarsToCents(72_000) / 12 }],
    };
    expect(monthlyIncomeCentsOf(job)).toBe(projected(job, 0));
  });

  it("agrees with the projection compiler on both sides of the boundary", () => {
    const job: Job = {
      ...base,
      payChanges: [
        { id: "adjustment-100", month: 0, kind: "changeBy", cents: dollarsToCents(500) },
        { id: "adjustment-101", month: 36, kind: "setTo", cents: dollarsToCents(9_000) },
      ],
    };
    for (const month of [0, 1, 2, 11, 12, 35, 36, 60]) {
      expect(authored(job, month)).toBe(projected(job, month));
    }
  });
});

/**
 * The two denominations `jobPayPath` can answer in. Today's dollars (the default) is what the
 * Jobs panel authors in; nominal is what the projection actually pays. The nominal reading is
 * only worth having if it MATCHES that projection, so that is what these assert — against the
 * compiler itself rather than against a hand-computed number, on both sides of "now".
 */
describe("jobPayPath — today's dollars vs the nominal paycheck", () => {
  const CPI = 0.03;
  const CURRENT_AGE = 40;
  const BIRTH_YEAR = START_YEAR - CURRENT_AGE;
  const person = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: BIRTH_YEAR,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
    jobs,
  });

  /** Started at 30 on $60k, $80k today, still running. Real growth on top of CPI. */
  const job: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: BIRTH_YEAR + 30,
    endYear: START_YEAR + 40,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(80_000),
      realGrowthPct: 2,
    },
  };
  const span = { startMonth: (30 - CURRENT_AGE) * 12, endMonthExclusive: (65 - CURRENT_AGE) * 12 };
  const projected = (month: number, j: Job = job): number =>
    compilePersonIncomeSeries(person([j]), START_YEAR, CPI)[0].series.getMonthlyCents(month);

  it("defaults to the paycheck — CPI absent, the anchors exactly as authored", () => {
    const path = jobPayPath(job, span);
    expect(path.monthlyCentsAt(0)).toBe(dollarsToCents(80_000 / 12));
    expect(path.monthlyCentsAt(span.startMonth)).toBe(dollarsToCents(5_000));
    // Only the 2% real growth compounds, with no CPI in it — which is exactly the projection
    // run at 0% inflation. Asserted against the compiler rather than a `Math.pow`: growth
    // rounds to the cent every year, so a closed-form power is off by a cent or two by then.
    const flat = compilePersonIncomeSeries(person([job]), START_YEAR, 0)[0].series;
    for (const month of [0, 12, 144, 240]) {
      expect(path.monthlyCentsAt(month)).toBe(flat.getMonthlyCents(month));
    }
  });

  it("reproduces the projected paycheck, month for month, when given the plan's CPI", () => {
    const nominal = jobPayPath(job, span, { inflationRate: CPI });
    // Whole years from the anchor, which is where the compiler's annual growth steps land.
    for (const month of [0, 12, 24, 60, 120, 240]) {
      expect(nominal.monthlyCentsAt(month)).toBe(projected(month));
    }
  });

  it("takes the START anchor verbatim — it is already the paycheck of that year", () => {
    // $60k is what the payslip read at 30, in the money of that year, so nothing converts it on
    // the way in. Today's-dollars is the DERIVED reading: ten years of CPI make that same
    // paycheck worth more in today's money, not less.
    const paycheck = jobPayPath(job, span, { inflationRate: CPI });
    expect(paycheck.monthlyCentsAt(span.startMonth)).toBe(dollarsToCents(5_000));

    const today = jobPayPath(job, span, { inflationRate: CPI, denomination: "todaysDollars" });
    expect(today.monthlyCentsAt(span.startMonth)).toBe(
      Math.round(dollarsToCents(5_000) * Math.pow(1 + CPI, 10)),
    );
    // Month 0 is the same figure in both: today's money IS the paycheck today.
    expect(today.monthlyCentsAt(0)).toBe(paycheck.monthlyCentsAt(0));
  });

  it("agrees with the pre-'now' covered-earnings record it feeds", () => {
    // The record sums the compiler's own historical series per calendar year. A flat year of
    // the nominal path times twelve is that year's covered wage — the two readings of the same
    // history cannot disagree, or the chart would be drawing a record the benefit never saw.
    const nominal = jobPayPath(job, span, { inflationRate: CPI });
    const prior = compilePersonPriorEarnings(person([job]), START_YEAR);
    for (const yearsBack of [10, 5, 1]) {
      const month = -yearsBack * 12;
      expect(prior[START_YEAR - yearsBack]).toBe(nominal.monthlyCentsAt(month) * 12);
    }
  });

  it("takes a pay change's stated amount verbatim in BOTH denominations", () => {
    // `JobPayChange.cents` is documented as nominal at its own month, so it is not deflated
    // for today's dollars. The inherited wrinkle, asserted so a future change to it is loud.
    const raised: Job = { ...job, payChanges: [{ id: "adjustment-102", month: 60, kind: "setTo", cents: dollarsToCents(9_000) }] };
    expect(jobPayPath(raised, span).monthlyCentsAt(60)).toBe(dollarsToCents(9_000));
    expect(jobPayPath(raised, span, { inflationRate: CPI }).monthlyCentsAt(60)).toBe(
      dollarsToCents(9_000),
    );
    expect(projected(60, raised)).toBe(dollarsToCents(9_000));
  });
});

/**
 * The pre-"now" half is REMEMBERED, not projected. Neither CPI nor `realGrowthPct` reaches a
 * month before 0: a historical wage holds at whatever was authored until a dated pay change
 * supersedes it, and only the forward half grows.
 */
describe("historical pay is flat", () => {
  const CURRENT_AGE = 40;
  const BIRTH_YEAR = START_YEAR - CURRENT_AGE;
  const person = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: BIRTH_YEAR,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
    jobs,
  });
  const base: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: BIRTH_YEAR + 30,
    endYear: START_YEAR + 40,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(96_000),
      realGrowthPct: 0,
    },
  };
  const span = { startMonth: -120, endMonthExclusive: (65 - CURRENT_AGE) * 12 };
  const CPI = 0.03;

  it("keeps unstated historical years nominally flat", () => {
    const prior = compilePersonPriorEarnings(person([base]), START_YEAR);
    for (const yearsBack of [10, 7, 4, 1]) {
      expect(prior[START_YEAR - yearsBack]).toBe(dollarsToCents(60_000));
    }
  });

  it("holds a dated historical change from its month, and grows it not at all", () => {
    // The one way a past year rises is a change the user dated there — read verbatim and held,
    // never compounded by CPI on the way to "now".
    const raised: Job = {
      ...base,
      payChanges: [{ id: "adjustment-105", month: -60, kind: "setTo", cents: dollarsToCents(7_000) }],
    };
    const prior = compilePersonPriorEarnings(person([raised]), START_YEAR);
    expect(prior[START_YEAR - 6]).toBe(dollarsToCents(60_000));
    // Held at the authored figure from there to "now" — no drift on top of what was stated.
    expect(prior[START_YEAR - 5]).toBe(dollarsToCents(7_000) * 12);
    expect(prior[START_YEAR - 1]).toBe(dollarsToCents(7_000) * 12);
  });

  it("keeps realGrowthPct a FORWARD rule — it never reaches the past", () => {
    const growing: Job = { ...base, salary: { ...base.salary, realGrowthPct: 5 } };
    const flat = compilePersonPriorEarnings(person([base]), START_YEAR);
    const grown = compilePersonPriorEarnings(person([growing]), START_YEAR);
    expect(grown).toEqual(flat);

    // Forward, the same rate compounds on top of CPI, as it always did.
    const forward = compilePersonIncomeSeries(person([growing]), START_YEAR, CPI)[0].series;
    expect(forward.getMonthlyCents(0)).toBe(dollarsToCents(96_000 / 12));
    expect(forward.getMonthlyCents(12)).toBe(
      Math.round(dollarsToCents(96_000 / 12) * 1.05 * 1.03),
    );
  });

  it("still gives month 0 to the current salary, whatever the history did", () => {
    // A dated historical change reconstructs the past and is dropped at the boundary: month 0 is
    // the authored current salary, not wherever the history reached.
    const withHistory: Job = {
      ...base,
      payChanges: [{ id: "adjustment-106", month: -48, kind: "setTo", cents: dollarsToCents(7_000) }],
    };
    const forward = compilePersonIncomeSeries(person([withHistory]), START_YEAR, CPI)[0].series;
    expect(forward.getMonthlyCents(0)).toBe(dollarsToCents(96_000 / 12));
    expect(jobPayPath(withHistory, span, { inflationRate: CPI }).monthlyCentsAt(0)).toBe(
      dollarsToCents(96_000 / 12),
    );
  });
});
