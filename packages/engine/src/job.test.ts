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

  it("does not double-apply inflation at month 0, and keeps the existing raise anniversary", () => {
    // 3% CPI, real-flat. Current pay $120,000/yr = $10,000/mo, authored as of "now".
    const job = jobWith(START_60K, dollarsToCents(120_000));
    const forward = forwardFor(job, 0.03);

    // Month 0 is the authored figure verbatim — indexing it would double-count the CPI that
    // already brought the salary to today's dollars.
    expect(forward.getMonthlyCents(0)).toBe(dollarsToCents(10_000));
    // The growth clock is untouched by the anchor: still the job's own annual cycle, firing
    // at month 12 rather than restarting from month 0.
    expect(forward.getMonthlyCents(11)).toBe(dollarsToCents(10_000));
    expect(forward.getMonthlyCents(12)).toBe(dollarsToCents(10_300)); // exactly one 3% step

    // History rides the STARTING salary CPI-indexed back to 2004 and grown forward, so 2025
    // sits just under $60,000 — nowhere near the $120,000 current pay.
    const prior2025 = priorFor(job, 0.03)[2025]!;
    expect(prior2025).toBeGreaterThan(dollarsToCents(57_000));
    expect(prior2025).toBeLessThan(dollarsToCents(60_000));
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
    expect(path.monthZeroStepCents).toBe(dollarsToCents(80_000 / 12) - dollarsToCents(6_250));
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

  it("compounds real growth between changes, in today's dollars", () => {
    // CPI never appears: every figure that goes in is authored in today's money, so what comes
    // back is what the projection pays in today's money and not a future nominal paycheck.
    const growing: Job = {
      ...historic,
      salary: { ...historic.salary, realGrowthPct: 10 },
      payChanges: [],
    };
    const path = jobPayPath(growing, span);
    expect(path.monthlyCentsAt(0)).toBe(dollarsToCents(80_000 / 12));
    expect(path.monthlyCentsAt(12)).toBe(Math.round(dollarsToCents(80_000 / 12) * 1.1));
    // History grows from the START anchor at its own start, never from the current one.
    expect(path.monthlyCentsAt(-132)).toBe(dollarsToCents(5_000));
    expect(path.monthlyCentsAt(-120)).toBe(Math.round(dollarsToCents(5_000) * 1.1));
  });
});
