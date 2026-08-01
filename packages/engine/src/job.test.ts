/**
 * The Job/Person standing model — the sole source of truth for earned income. Pins
 * open-ended-job semantics and that the pre-"now" covered-earnings record falls out of
 * the jobs.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger/ledger";
import { replayLedger } from "./projection/buildHouseholdInput";
import { nullJurisdiction } from "./jurisdiction";
import { createProjectionBase, PRIMARY_PERSON_ID, type ProjectionContext } from "./projectionBase";
import { samplePlan, salariedJob } from "./testing/samplePlan";
import {
  deferralFractionOf,
  deriveRealGrowthPct,
  estimateHistoryPayChanges,
  jobPayPath,
  monthlyIncomeCentsOf,
  startingMonthlyIncomeCentsOf,
  withCurrentMonthlyIncome,
  withDeferralFraction,
  withMonthlyIncome,
  withStartingMonthlyIncome,
  type Job,
} from "./job";
import type { Person } from "./person";
import { compilePersonIncomeSeries, compilePersonPriorEarnings } from "./compilePerson";
import type { Plan } from "./plan";
import { dollarsToCents } from "./cashFlowSeries";

const START_YEAR = 2026;

function ctx(): ProjectionContext {
  return { jurisdiction: nullJurisdiction, startYear: START_YEAR };
}

function project(plan: Plan) {
  return replayLedger(emptyLedger, createProjectionBase(plan, ctx()), nullJurisdiction);
}

/** The sample plan's single open-ended job (real-flat salary, deferral on it). */
const openEndedJob: Job = salariedJob(dollarsToCents(8000), { deferralFraction: 0.1 });

describe("Job/Person standing model — additive compilation", () => {
  it("allows any number of open-ended (null-end) jobs — no elevated career job", () => {
    const birthYear = START_YEAR - samplePlan.currentAge;
    // Two open-ended jobs is legal: neither is elevated, and both compile to forward
    // income ending at the owner's retirementTargetAge.
    const person: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear,
      retirementTargetAge: samplePlan.retirementAge,
      benefitClaimingAge: samplePlan.benefitClaimingAge,
      jobs: [openEndedJob, { ...openEndedJob, id: "job-2" }],
    };
    const series = compilePersonIncomeSeries(person, START_YEAR, samplePlan.inflationPct / 100);
    expect(series).toHaveLength(2);
    const retireEndMonth = (samplePlan.retirementAge - samplePlan.currentAge) * 12 - 1;
    expect(series.every((s) => s.series.endMonth === retireEndMonth)).toBe(true);
  });

  it("retirementTargetAge is the per-person input that sets an open-ended job's end", () => {
    const birthYear = START_YEAR - samplePlan.currentAge;
    const base: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear,
      retirementTargetAge: samplePlan.retirementAge,
      benefitClaimingAge: samplePlan.benefitClaimingAge,
      jobs: [openEndedJob],
    };
    const openEndedEndMonth = (age: number) =>
      compilePersonIncomeSeries(
        { ...base, retirementTargetAge: age },
        START_YEAR,
        samplePlan.inflationPct / 100,
      )[0].series.endMonth;
    // Forward income stops the month before the owner turns `retirementTargetAge` — that
    // input alone moves the end.
    expect(openEndedEndMonth(60)).toBe((60 - samplePlan.currentAge) * 12 - 1);
    expect(openEndedEndMonth(65)).toBe((65 - samplePlan.currentAge) * 12 - 1);
    expect(openEndedEndMonth(65)).toBeGreaterThan(openEndedEndMonth(60) as number);
  });

  it("computes pre-'now' earnings directly from the jobs", () => {
    const base = createProjectionBase({ ...samplePlan, jobs: [openEndedJob] }, ctx());
    // The pre-"now" record derives from the roster's authoring Persons, as the sim
    // boundary does via compilePerson.
    const prior = compilePersonPriorEarnings(
      base.initialPersons![0],
      START_YEAR,
      samplePlan.inflationPct / 100,
    );
    // The record covers exactly the pre-"now" working years [careerStart … now).
    expect(Object.keys(prior).length).toBeGreaterThan(0);
    // Sim still starts at "now" — no pre-"now" months are simulated.
    expect(project({ ...samplePlan, jobs: [openEndedJob] }).months[0].month).toBe(0);
  });

  it("derives a real growth rate from two salary points", () => {
    // Doubling in real terms over 10 years ≈ 7.18%/yr.
    expect(deriveRealGrowthPct(100, 2020, 200, 2030)).toBeCloseTo(7.177, 2);
    expect(deriveRealGrowthPct(100, 2020, 100, 2020)).toBe(0);
  });
});

describe("Job/Person standing model — one-month income overrides", () => {
  const person = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: START_YEAR - samplePlan.currentAge,
    retirementTargetAge: samplePlan.retirementAge,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
    jobs,
  });
  const monthly = (job: Job, month: number): number =>
    compilePersonIncomeSeries(person([job]), START_YEAR, samplePlan.inflationPct / 100)[0].series.getMonthlyCents(month);

  // A real-flat $6,000/mo job so a month's baseline pay is a round $6,000.
  const base: Job = salariedJob(dollarsToCents(6000));

  it("leaves every other month untouched (override is one month only)", () => {
    // Months 0–11 are year 0; a real-flat salary grows at CPI, so later years are not round.
    const job: Job = { ...base, incomeOverrides: [{ month: 6, kind: "setTo", cents: 0 }] };
    expect(monthly(job, 5)).toBe(dollarsToCents(6000));
    expect(monthly(job, 6)).toBe(0);
    expect(monthly(job, 7)).toBe(dollarsToCents(6000));
  });

  it("setTo 0 models a missed paycheck; setTo X a one-month salary correction", () => {
    expect(monthly({ ...base, incomeOverrides: [{ month: 10, kind: "setTo", cents: 0 }] }, 10)).toBe(0);
    expect(
      monthly({ ...base, incomeOverrides: [{ month: 10, kind: "setTo", cents: dollarsToCents(9000) }] }, 10),
    ).toBe(dollarsToCents(9000));
  });

  it("addBonus adds on top of the month's grown baseline pay", () => {
    const job: Job = { ...base, incomeOverrides: [{ month: 10, kind: "addBonus", cents: dollarsToCents(2000) }] };
    expect(monthly(job, 10)).toBe(dollarsToCents(8000)); // 6000 base + 2000 bonus
  });

  it("ignores an override outside the job's paid span — a job cannot pay when not worked", () => {
    // A fixed-term job ending before month 24 gets a bonus at month 30: no effect.
    const ended: Job = { ...base, endYear: START_YEAR + 1, incomeOverrides: [{ month: 30, kind: "addBonus", cents: dollarsToCents(5000) }] };
    expect(monthly(ended, 30)).toBe(0);
  });

  it("taxes a bonus as wages through the projection, not as untaxed cash", () => {
    // A one-month bonus raises that month's gross wages, so the income flow reads
    // base + bonus.
    const job: Job = { ...base, incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(3000) }] };
    const series = project({ ...samplePlan, jobs: [job] }).months;
    expect(series[6].flows?.totalIncomeCents).toBe(dollarsToCents(9000)); // 6000 + 3000
    expect(series[5].flows?.totalIncomeCents).toBe(dollarsToCents(6000));
  });
});

describe("Job/Person standing model — permanent pay changes", () => {
  const person = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: START_YEAR - samplePlan.currentAge,
    retirementTargetAge: samplePlan.retirementAge,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
    jobs,
  });
  const monthly = (job: Job, month: number): number =>
    compilePersonIncomeSeries(person([job]), START_YEAR, samplePlan.inflationPct / 100)[0].series.getMonthlyCents(month);

  // A real-flat $6,000/mo job: within a growth-anchor year the monthly pay is round.
  const base: Job = salariedJob(dollarsToCents(6000));

  it("setTo sets a new ongoing pay that holds from its month forward, unlike a one-month override", () => {
    const job: Job = { ...base, payChanges: [{ month: 6, kind: "setTo", cents: dollarsToCents(9000) }] };
    expect(monthly(job, 5)).toBe(dollarsToCents(6000)); // before the change: old pay
    expect(monthly(job, 6)).toBe(dollarsToCents(9000)); // the pay-change month
    expect(monthly(job, 11)).toBe(dollarsToCents(9000)); // and it PERSISTS (not one month)
  });

  it("changeBy adds to the month's baseline from its month forward; a negative delta is a cut", () => {
    const up: Job = { ...base, payChanges: [{ month: 6, kind: "changeBy", cents: dollarsToCents(2000) }] };
    expect(monthly(up, 5)).toBe(dollarsToCents(6000));
    expect(monthly(up, 6)).toBe(dollarsToCents(8000)); // 6000 + 2000, ongoing
    expect(monthly(up, 11)).toBe(dollarsToCents(8000));
    const cut: Job = { ...base, payChanges: [{ month: 6, kind: "changeBy", cents: -dollarsToCents(2000) }] };
    expect(monthly(cut, 6)).toBe(dollarsToCents(4000)); // a pay cut
  });

  it("compounds successive pay changes in month order", () => {
    const job: Job = {
      ...base,
      payChanges: [
        { month: 6, kind: "setTo", cents: dollarsToCents(9000) },
        { month: 9, kind: "changeBy", cents: dollarsToCents(1000) },
      ],
    };
    expect(monthly(job, 6)).toBe(dollarsToCents(9000));
    expect(monthly(job, 9)).toBe(dollarsToCents(10000)); // 9000 set + 1000 delta
  });

  it("applies pay changes BEFORE one-month overrides, so a later bonus lands on the changed pay", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 6, kind: "setTo", cents: dollarsToCents(9000) }],
      incomeOverrides: [{ month: 8, kind: "addBonus", cents: dollarsToCents(1000) }],
    };
    expect(monthly(job, 7)).toBe(dollarsToCents(9000)); // changed pay
    expect(monthly(job, 8)).toBe(dollarsToCents(10000)); // changed pay + bonus
    expect(monthly(job, 9)).toBe(dollarsToCents(9000)); // bonus was one month; pay change persists
  });

  it("ignores a pay change outside the job's paid span — a job cannot be repriced when not worked", () => {
    const ended: Job = { ...base, endYear: START_YEAR + 1, payChanges: [{ month: 30, kind: "setTo", cents: dollarsToCents(9000) }] };
    expect(monthly(ended, 30)).toBe(0);
  });

  it("carries the changed pay through the projection as taxable wages, every month after", () => {
    const job: Job = { ...base, payChanges: [{ month: 6, kind: "setTo", cents: dollarsToCents(9000) }] };
    const series = project({ ...samplePlan, jobs: [job] }).months;
    expect(series[5].flows?.totalIncomeCents).toBe(dollarsToCents(6000));
    expect(series[6].flows?.totalIncomeCents).toBe(dollarsToCents(9000));
    expect(series[7].flows?.totalIncomeCents).toBe(dollarsToCents(9000)); // persists, not one month
  });
});

describe("Job/Person standing model — pre-'now' covered earnings from actual compensation", () => {
  // A 40-year-old whose one job started at 18 (year 2004), so the pre-"now" record spans
  // [2004 … 2025]. Inflation is 0 in these cases, so a real-flat salary is nominally flat
  // too — every pre-"now" year equals the stated pay exactly, and a pay change or bonus
  // shows up as a clean whole-dollar shift rather than a CPI-blurred figure.
  const personWith = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: START_YEAR - 40,
    retirementTargetAge: 60,
    benefitClaimingAge: 67,
    jobs,
  });
  const priorFor = (jobs: Job[], inflationRate = 0): Record<number, number> =>
    compilePersonPriorEarnings(personWith(jobs), START_YEAR, inflationRate);

  const flat72k: Job = salariedJob(dollarsToCents(6000)); // $6,000/mo → $72,000/yr

  it("records each pre-'now' year at the actual covered pay (flat salary, no inflation)", () => {
    const prior = priorFor([flat72k]);
    expect(prior[2025]).toBe(dollarsToCents(72_000));
    expect(prior[2004]).toBe(dollarsToCents(72_000));
    expect(prior[2026]).toBeUndefined(); // "now" year onward is the forward series' job
  });

  it("reflects a pre-'now' permanent raise from the year it took effect (effective-dated pay change)", () => {
    // setTo $10,000/mo from month −24 (start of 2024): 2024–2025 pay the raised salary,
    // earlier years the original — the record tracks the actual paycheck, not one flat figure.
    const raised: Job = { ...flat72k, payChanges: [{ month: -24, kind: "setTo", cents: dollarsToCents(10_000) }] };
    const prior = priorFor([raised]);
    expect(prior[2023]).toBe(dollarsToCents(72_000));
    expect(prior[2024]).toBe(dollarsToCents(120_000));
    expect(prior[2025]).toBe(dollarsToCents(120_000));
  });

  it("adds a pre-'now' covered bonus to exactly its year", () => {
    const withBonus: Job = { ...flat72k, incomeOverrides: [{ month: -6, kind: "addBonus", cents: dollarsToCents(5_000) }] };
    const prior = priorFor([withBonus]);
    expect(prior[2025]).toBe(dollarsToCents(77_000)); // 72,000 + 5,000 one-off
    expect(prior[2024]).toBe(dollarsToCents(72_000));
  });

  it("sums compensation from multiple concurrent jobs within each year", () => {
    const second: Job = { ...salariedJob(dollarsToCents(2000)), id: "job-side" };
    const prior = priorFor([flat72k, second]);
    expect(prior[2025]).toBe(dollarsToCents(72_000 + 24_000)); // $6k/mo + $2k/mo = $96k/yr
  });

  it("excludes a future-dated pay change from the pre-'now' record (the forward series owns it)", () => {
    // A raise at month 12 (year 2027) must not leak into the pre-"now" years, or the same
    // earnings would be double-counted once the forward accumulation reaches 2027.
    const raisedLater: Job = { ...flat72k, payChanges: [{ month: 12, kind: "setTo", cents: dollarsToCents(20_000) }] };
    const prior = priorFor([raisedLater]);
    expect(prior[2025]).toBe(dollarsToCents(72_000));
    expect(prior[2027]).toBeUndefined();
  });
});

describe("Job/Person standing model — the month-0 current-salary anchor", () => {
  // A 40-year-old whose job started at 18 (year 2004), so history spans [2004 … 2025] and the
  // projection owns 2026 onward. The two salary anchors are authored INDEPENDENTLY here —
  // that is the whole point of the suite: the starting salary reconstructs history, the
  // current salary is authoritative from month 0, and neither is derived from the other.
  const personWith = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: START_YEAR - 40,
    retirementTargetAge: 60,
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
    endYear: null,
    salary: {
      startingSalaryCents: startingAnnualCents,
      currentSalaryCents: currentAnnualCents,
      realGrowthPct: 0,
    },
    ...extra,
  });

  const priorFor = (job: Job, inflationRate = 0): Record<number, number> =>
    compilePersonPriorEarnings(personWith([job]), START_YEAR, inflationRate);
  const forwardFor = (job: Job, inflationRate = 0) =>
    compilePersonIncomeSeries(personWith([job]), START_YEAR, inflationRate)[0]!.series;

  const START_60K = dollarsToCents(60_000);
  const CURRENT_80K = dollarsToCents(80_000);
  /** $80,000/yr as the monthly figure the anchor actually pays. */
  const MONTHLY_80K = Math.round(CURRENT_80K / 12);

  it("reconstructs history from a `setTo` raise, then starts month 0 at the current salary", () => {
    // Start $60k; raised to $75k/yr ($6,250/mo) from month −24; authored current pay $80k.
    const job = jobWith(START_60K, CURRENT_80K, {
      payChanges: [{ month: -24, kind: "setTo", cents: dollarsToCents(6_250) }],
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
      payChanges: [{ month: -12, kind: "changeBy", cents: dollarsToCents(1_000) }],
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
        { month: -12, kind: "changeBy", cents: dollarsToCents(500) }, // → $6,500/mo
        { month: -36, kind: "setTo", cents: dollarsToCents(6_000) }, // → $6,000/mo
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
      incomeOverrides: [{ month: -6, kind: "addBonus", cents: dollarsToCents(5_000) }],
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
      payChanges: [{ month: -24, kind: "setTo", cents: dollarsToCents(6_250) }],
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
        { month: -24, kind: "setTo", cents: dollarsToCents(6_250) }, // history: $6,250/mo
        { month: 6, kind: "changeBy", cents: dollarsToCents(1_000) }, // future: +$1,000/mo
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
    // series' alone. Inflation reaches the past only if the user asks for it.
    expect(priorFor(job, 0.03)[2025]).toBe(dollarsToCents(60_000));
    expect(priorFor(job, 0.03)[2015]).toBe(dollarsToCents(60_000));
  });
});

describe("Job — human name drives the income band label (display only)", () => {
  const personWith = (job: Job): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: START_YEAR - samplePlan.currentAge,
    retirementTargetAge: samplePlan.retirementAge,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
    jobs: [job],
  });
  const labelOf = (job: Job): string | undefined =>
    compilePersonIncomeSeries(personWith(job), START_YEAR, samplePlan.inflationPct / 100)[0].label;

  it("labels the band by the job's name when set", () => {
    const named: Job = { ...salariedJob(dollarsToCents(6000)), name: "Software Engineer" };
    expect(labelOf(named)).toBe("Income · Software Engineer");
  });

  it("falls back to the owner's name when the job has none (or only whitespace)", () => {
    // Not the id: ids are minted, not written — a partner's comes from their person id
    // ("p-0-job-1"), which says nothing to whoever reads the legend.
    expect(labelOf(salariedJob(dollarsToCents(6000)))).toBe("Income · P's job");
    expect(labelOf({ ...salariedJob(dollarsToCents(6000)), name: "   " })).toBe("Income · P's job");
  });

  it("numbers a person's untitled jobs only when they hold more than one", () => {
    // One name for two bands identifies neither; a lone untitled job needs no ordinal, so
    // its label can't shift as other jobs come and go.
    const two = compilePersonIncomeSeries(
      {
        ...personWith(salariedJob(dollarsToCents(6000))),
        jobs: [
          { ...salariedJob(dollarsToCents(6000)), id: "job-a" },
          { ...salariedJob(dollarsToCents(2000)), id: "job-b" },
          { ...salariedJob(dollarsToCents(1000)), id: "job-c", name: "Weekends" },
        ],
      },
      START_YEAR,
      samplePlan.inflationPct / 100,
    );
    expect(two.map((s) => s.label)).toEqual([
      "Income · P's job 1",
      "Income · P's job 2",
      "Income · Weekends",
    ]);
  });

  it("never touches identity — the band's sourceId stays keyed by the id, not the name", () => {
    const named: Job = { ...salariedJob(dollarsToCents(6000)), name: "Software Engineer" };
    const compiled = compilePersonIncomeSeries(
      personWith(named),
      START_YEAR,
      samplePlan.inflationPct / 100,
    )[0];
    expect(compiled.sourceId).toBe("job:job-main");
  });
});

describe("stating pay and deferral, and reading them back", () => {
  const job: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR,
    endYear: null,
    salary: { startingSalaryCents: dollarsToCents(72_000), currentSalaryCents: dollarsToCents(72_000), realGrowthPct: 2 },
  };

  it("round-trips a monthly figure through the annual one it is stored as", () => {
    // The form states monthly, the job stores annual, and a number typed in has to come back
    // out as the number typed — the two halves round together or it does not.
    for (const monthly of [dollarsToCents(5_000), dollarsToCents(4_333.33), 1, 0]) {
      expect(monthlyIncomeCentsOf(withMonthlyIncome(job, monthly))).toBe(monthly);
    }
  });

  it("reads the STARTING monthly salary, before growth and pay changes", () => {
    const raised: Job = {
      ...job,
      payChanges: [{ month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    expect(monthlyIncomeCentsOf(raised)).toBe(dollarsToCents(6_000));
  });

  it("reads an absent deferral as the 0% it is elected at", () => {
    // The pair of `withDeferralFraction(0)`, which REMOVES the deferral rather than storing a
    // zero: no deferral and a 0% deferral have to read the same or the form shows a rate the
    // person never elected.
    expect(deferralFractionOf(job)).toBe(0);
    expect(deferralFractionOf(withDeferralFraction(job, 0))).toBe(0);
    expect(deferralFractionOf(withDeferralFraction(job, 0.1))).toBe(0.1);
  });
});

describe("the two salary anchors, stated separately", () => {
  const job: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - 11,
    endYear: null,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(80_000),
      realGrowthPct: 0,
    },
  };

  it("writes each anchor without disturbing the other", () => {
    // The pair the one-field `withMonthlyIncome` cannot express. Neither anchor derives from
    // the other, so a surface showing both must be able to edit one at a time — de-growing
    // today's pay to guess the start pay would reapply the raises today's pay already includes.
    const raised = withCurrentMonthlyIncome(job, dollarsToCents(7_500));
    expect(monthlyIncomeCentsOf(raised)).toBe(dollarsToCents(7_500));
    expect(startingMonthlyIncomeCentsOf(raised)).toBe(dollarsToCents(5_000));

    const restated = withStartingMonthlyIncome(job, dollarsToCents(4_000));
    expect(startingMonthlyIncomeCentsOf(restated)).toBe(dollarsToCents(4_000));
    expect(monthlyIncomeCentsOf(restated)).toBe(dollarsToCents(80_000 / 12));
  });

  it("still sets both from one figure, for a job stated in one number", () => {
    const flat = withMonthlyIncome(job, dollarsToCents(6_000));
    expect(monthlyIncomeCentsOf(flat)).toBe(dollarsToCents(6_000));
    expect(startingMonthlyIncomeCentsOf(flat)).toBe(dollarsToCents(6_000));
  });
});

describe("jobPayPath — a job's authored pay across its span", () => {
  // The scenario the UI could not reach before: $60k at the start, a raise to $75k five years
  // ago, $80k stated as today's pay. Owner is 41; the job began at 30.
  const historic: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - 11,
    endYear: null,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(80_000),
      realGrowthPct: 0,
    },
    payChanges: [
      { month: -60, kind: "setTo", cents: dollarsToCents(6_250) },
      { month: 72, kind: "setTo", cents: dollarsToCents(7_500) },
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
    const flat = jobPayPath(withMonthlyIncome(historic, dollarsToCents(6_250)), span);
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
      payChanges: [{ month: -204, kind: "setTo", cents: dollarsToCents(2_100) }],
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
    birthYear: START_YEAR - samplePlan.currentAge,
    retirementTargetAge: samplePlan.retirementAge,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
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
      endMonthExclusive: (samplePlan.retirementAge - samplePlan.currentAge) * 12,
    }).monthlyCentsAt(month);

  /** $60k/yr = a round $5,000/mo, real-flat. */
  const base: Job = salariedJob(dollarsToCents(60_000) / 12);

  it("setTo: month 0 still pays the stated current salary, month 1 pays the new one", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 0, kind: "setTo", cents: dollarsToCents(72_000) / 12 }],
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
      payChanges: [{ month: 0, kind: "changeBy", cents: dollarsToCents(6_000) / 12 }],
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
        { month: 0, kind: "setTo", cents: dollarsToCents(6_000) },
        { month: 0, kind: "changeBy", cents: dollarsToCents(500) },
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
        { month: 1, kind: "changeBy", cents: dollarsToCents(1_000) },
        { month: 0, kind: "setTo", cents: dollarsToCents(6_000) },
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
      incomeOverrides: [{ month: 0, kind: "addBonus", cents: dollarsToCents(2_000) }],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(7_000));
    expect(projected(job, 1)).toBe(dollarsToCents(5_000));
  });

  it("leaves a month-1 change exactly where it was authored", () => {
    // The fix special-cases the month-0 boundary only; nothing else shifts by a month.
    const job: Job = {
      ...base,
      payChanges: [{ month: 1, kind: "setTo", cents: dollarsToCents(6_000) }],
    };
    expect(projected(job, 0)).toBe(dollarsToCents(5_000));
    expect(projected(job, 1)).toBe(dollarsToCents(6_000));
    expect(authored(job, 1)).toBe(dollarsToCents(6_000));
  });

  it("leaves a historical change in history, unmoved", () => {
    const historical: Job = {
      ...base,
      startYear: START_YEAR - 5,
      payChanges: [{ month: -24, kind: "setTo", cents: dollarsToCents(4_000) }],
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
      payChanges: [{ month: 0, kind: "setTo", cents: dollarsToCents(72_000) / 12 }],
    };
    expect(monthlyIncomeCentsOf(job)).toBe(projected(job, 0));
  });

  it("agrees with the projection compiler on both sides of the boundary", () => {
    const job: Job = {
      ...base,
      payChanges: [
        { month: 0, kind: "changeBy", cents: dollarsToCents(500) },
        { month: 36, kind: "setTo", cents: dollarsToCents(9_000) },
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
    retirementTargetAge: 65,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
    jobs,
  });

  /** Started at 30 on $60k, $80k today, still running. Real growth on top of CPI. */
  const job: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: BIRTH_YEAR + 30,
    endYear: null,
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
    const prior = compilePersonPriorEarnings(person([job]), START_YEAR, CPI);
    for (const yearsBack of [10, 5, 1]) {
      const month = -yearsBack * 12;
      expect(prior[START_YEAR - yearsBack]).toBe(nominal.monthlyCentsAt(month) * 12);
    }
  });

  it("takes a pay change's stated amount verbatim in BOTH denominations", () => {
    // `JobPayChange.cents` is documented as nominal at its own month, so it is not deflated
    // for today's dollars. The inherited wrinkle, asserted so a future change to it is loud.
    const raised: Job = { ...job, payChanges: [{ month: 60, kind: "setTo", cents: dollarsToCents(9_000) }] };
    expect(jobPayPath(raised, span).monthlyCentsAt(60)).toBe(dollarsToCents(9_000));
    expect(jobPayPath(raised, span, { inflationRate: CPI }).monthlyCentsAt(60)).toBe(
      dollarsToCents(9_000),
    );
    expect(projected(60, raised)).toBe(dollarsToCents(9_000));
  });
});

/**
 * Filling the unstated historical years — an EXPLICIT action, so what matters is that it never
 * touches anything the user said and that running it twice does not compound.
 */
describe("estimateHistoryPayChanges — filling in what nobody stated", () => {
  const CURRENT_AGE = 40;
  const BIRTH_YEAR = START_YEAR - CURRENT_AGE;
  /** Started at 30 on $5,000/mo — the paycheck of that year. Ten years of history. */
  const job: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: BIRTH_YEAR + 30,
    endYear: null,
    salary: {
      startingSalaryCents: dollarsToCents(60_000),
      currentSalaryCents: dollarsToCents(100_000),
      realGrowthPct: 0,
    },
  };
  const span = { startMonth: -120, endMonthExclusive: (65 - CURRENT_AGE) * 12 };

  it("fills one year at a time, from the start anchor, and stops at 'now'", () => {
    const estimates = estimateHistoryPayChanges(job, span, 0.03);
    // Nine: the start anchor already states year one, and month 0 belongs to the current anchor.
    expect(estimates).toHaveLength(9);
    expect(estimates.every((c) => c.estimated === true)).toBe(true);
    expect(estimates.every((c) => c.month < 0 && c.month >= span.startMonth)).toBe(true);
    expect(estimates[0]).toEqual({
      month: -108,
      kind: "setTo",
      cents: Math.round(dollarsToCents(5_000) * 1.03),
      estimated: true,
    });
  });

  it("leaves both anchors alone — neither is part of what it fills in", () => {
    const estimates = estimateHistoryPayChanges(job, span, 0.03);
    expect(estimates.some((c) => c.month === span.startMonth)).toBe(false);
    expect(estimates.some((c) => c.month === 0)).toBe(false);
  });

  it("never overwrites an authored change, and grows the following years FROM it", () => {
    const raised: Job = {
      ...job,
      payChanges: [{ month: -60, kind: "setTo", cents: dollarsToCents(8_000) }],
    };
    const estimates = estimateHistoryPayChanges(raised, span, 0.03);
    expect(estimates.some((c) => c.month === -60)).toBe(false);
    // The year after the authored raise is estimated off $8,000, not off the start anchor.
    const next = estimates.find((c) => c.month === -48)!;
    expect(next.cents).toBe(Math.round(dollarsToCents(8_000) * 1.03));
  });

  it("is idempotent — re-running reads through its own prior estimates", () => {
    const once = estimateHistoryPayChanges(job, span, 0.03);
    const twice = estimateHistoryPayChanges({ ...job, payChanges: once }, span, 0.03);
    expect(twice).toEqual(once);
  });

  it("has nothing to fill for a job with no past, or with no inflation to assume", () => {
    const future = { startMonth: 12, endMonthExclusive: 240 };
    expect(estimateHistoryPayChanges(job, future, 0.03)).toEqual([]);
    expect(estimateHistoryPayChanges(job, span, 0)).toEqual([]);
  });

  it("reaches the covered-earnings record once applied, and not before", () => {
    const person = (j: Job): Person => ({
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear: BIRTH_YEAR,
      retirementTargetAge: 65,
      benefitClaimingAge: samplePlan.benefitClaimingAge,
      jobs: [j],
    });
    // Before: flat at what was authored, every year. After: the unstated years rise with CPI.
    // This is the whole point of the action — nothing estimates until it is asked for.
    const before = compilePersonPriorEarnings(person(job), START_YEAR);
    expect(before[START_YEAR - 10]).toBe(before[START_YEAR - 1]);

    const applied = { ...job, payChanges: estimateHistoryPayChanges(job, span, 0.03) };
    const after = compilePersonPriorEarnings(person(applied), START_YEAR);
    expect(after[START_YEAR - 10]).toBe(before[START_YEAR - 10]); // the authored first year
    expect(after[START_YEAR - 1]).toBeGreaterThan(before[START_YEAR - 1]!);
  });
});

/**
 * The pre-"now" half is REMEMBERED, not projected. Nothing grows there until the user asks for
 * it, which is what makes "Estimate missing pay history" an honest offer rather than a relabelling
 * of something the compiler already did.
 */
describe("historical pay is flat until estimated", () => {
  const CURRENT_AGE = 40;
  const BIRTH_YEAR = START_YEAR - CURRENT_AGE;
  const person = (jobs: Job[]): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: BIRTH_YEAR,
    retirementTargetAge: 65,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
    jobs,
  });
  const base: Job = {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: BIRTH_YEAR + 30,
    endYear: null,
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

  it("grows only the unstated years once the estimate is applied", () => {
    const applied = {
      ...base,
      payChanges: estimateHistoryPayChanges(base, span, CPI),
    };
    const prior = compilePersonPriorEarnings(person([applied]), START_YEAR);
    // The first year is the authored anchor and does not move; later years climb at CPI.
    expect(prior[START_YEAR - 10]).toBe(dollarsToCents(60_000));
    expect(prior[START_YEAR - 9]).toBe(Math.round(dollarsToCents(60_000) * 1.03));
    expect(prior[START_YEAR - 1]!).toBeGreaterThan(prior[START_YEAR - 9]!);
  });

  it("leaves an authored historical change authoritative, and flat after it", () => {
    const raised: Job = {
      ...base,
      payChanges: [{ month: -60, kind: "setTo", cents: dollarsToCents(7_000) }],
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

  it("restores the flat authored history when the estimates are removed again", () => {
    const before = compilePersonPriorEarnings(person([base]), START_YEAR);
    const estimates = estimateHistoryPayChanges(base, span, CPI);
    const applied = { ...base, payChanges: estimates };
    expect(compilePersonPriorEarnings(person([applied]), START_YEAR)).not.toEqual(before);

    // Removing exactly what was generated — the flag is what makes them identifiable.
    const cleared = { ...applied, payChanges: applied.payChanges.filter((c) => !c.estimated) };
    expect(compilePersonPriorEarnings(person([cleared]), START_YEAR)).toEqual(before);
  });

  it("still gives month 0 to the current salary, whatever the history did", () => {
    const applied = { ...base, payChanges: estimateHistoryPayChanges(base, span, CPI) };
    const forward = compilePersonIncomeSeries(person([applied]), START_YEAR, CPI)[0].series;
    expect(forward.getMonthlyCents(0)).toBe(dollarsToCents(96_000 / 12));
    expect(jobPayPath(applied, span, { inflationRate: CPI }).monthlyCentsAt(0)).toBe(
      dollarsToCents(96_000 / 12),
    );
  });
});

/**
 * Household membership clips PAYMENT, not compensation. A partner's job ran before they joined,
 * and the raises it collected are part of the salary they arrive on — so the salary path is
 * compiled over the job's whole natural span and only the paying window is narrowed.
 */
describe("membership clips what the household is paid, not the job's salary path", () => {
  const CURRENT_AGE = 40;
  const BIRTH_YEAR = START_YEAR - CURRENT_AGE;
  const JOIN = 24;
  const partner = (jobs: Job[]): Person => ({
    id: "p2",
    name: "Sam",
    birthYear: BIRTH_YEAR,
    retirementTargetAge: 65,
    benefitClaimingAge: samplePlan.benefitClaimingAge,
    jobs,
  });
  /** $6,000/mo now, real-flat, running from before "now" to retirement. */
  const base: Job = {
    id: "job-p2",
    ownerId: "p2",
    startYear: BIRTH_YEAR + 30,
    endYear: null,
    salary: {
      startingSalaryCents: dollarsToCents(72_000),
      currentSalaryCents: dollarsToCents(72_000),
      realGrowthPct: 0,
    },
  };
  /** Zero CPI, so a paycheck is the authored figure and a raise is visible as itself. */
  const paid = (job: Job, month: number, window?: { startMonth: number; endMonthExclusive: number }) => {
    const compiled = compilePersonIncomeSeries(
      partner([job]),
      START_YEAR,
      0,
      window ?? { startMonth: JOIN, endMonthExclusive: Infinity },
    );
    return compiled.length === 0 ? 0 : compiled[0]!.series.getMonthlyCents(month);
  };

  it("carries a pre-join setTo into the salary the partner brings with them", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    expect(paid(job, 12)).toBe(0); // not a member yet — nothing is paid
    expect(paid(job, JOIN)).toBe(dollarsToCents(9_000)); // arrives on the RAISED salary
  });

  it("carries a pre-join changeBy, composed against the pay standing at the time", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 12, kind: "changeBy", cents: dollarsToCents(1_500) }],
    };
    expect(paid(job, JOIN)).toBe(dollarsToCents(7_500)); // 6,000 + 1,500
  });

  it("composes several pre-join changes in order", () => {
    const job: Job = {
      ...base,
      payChanges: [
        { month: 6, kind: "setTo", cents: dollarsToCents(8_000) },
        { month: 12, kind: "changeBy", cents: dollarsToCents(500) },
        { month: 18, kind: "changeBy", cents: dollarsToCents(-1_000) },
      ],
    };
    expect(paid(job, JOIN)).toBe(dollarsToCents(7_500)); // 8,000 + 500 − 1,000
  });

  it("excludes a pre-join bonus — a bonus is a payment, not a salary state", () => {
    const job: Job = {
      ...base,
      incomeOverrides: [{ month: 12, kind: "addBonus", cents: dollarsToCents(5_000) }],
    };
    expect(paid(job, 12)).toBe(0);
    expect(paid(job, JOIN)).toBe(dollarsToCents(6_000)); // unchanged by the bonus it missed
  });

  it("includes a bonus that lands during membership", () => {
    const job: Job = {
      ...base,
      incomeOverrides: [{ month: 36, kind: "addBonus", cents: dollarsToCents(5_000) }],
    };
    expect(paid(job, 36)).toBe(dollarsToCents(11_000));
    expect(paid(job, 37)).toBe(dollarsToCents(6_000));
  });

  it("stops paying when membership ends, leaving the job's own path untouched", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 60, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    const window = { startMonth: JOIN, endMonthExclusive: 48 };
    expect(paid(job, 47, window)).toBe(dollarsToCents(6_000));
    expect(paid(job, 48, window)).toBe(0);
    // The raise at month 60 is still the job's own — read without a membership window it lands.
    expect(paid(job, 60, { startMonth: 0, endMonthExclusive: Infinity })).toBe(
      dollarsToCents(9_000),
    );
  });

  it("keeps month-0 semantics under a membership window", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 0, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    const fromNow = { startMonth: 0, endMonthExclusive: Infinity };
    expect(paid(job, 0, fromNow)).toBe(dollarsToCents(6_000)); // the anchor still owns month 0
    expect(paid(job, 1, fromNow)).toBe(dollarsToCents(9_000));
  });

  it("leaves jobPayPath alone — it knows nothing about households", () => {
    const job: Job = {
      ...base,
      payChanges: [{ month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    const path = jobPayPath(job, { startMonth: -120, endMonthExclusive: 300 });
    expect(path.monthlyCentsAt(12)).toBe(dollarsToCents(9_000));
    expect(path.monthlyCentsAt(JOIN)).toBe(dollarsToCents(9_000));
  });
});
