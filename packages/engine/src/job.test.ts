/**
 * The Job/Person standing model — the sole source of truth for earned income now that
 * the scalar `incomeCents` path is gone. Pins open-ended-job semantics and that the
 * pre-"now" covered-earnings record falls out of the jobs.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, nullJurisdiction } from "./index";
import { createProjectionBase, PRIMARY_PERSON_ID, type ProjectionContext } from "./projectionBase";
import { samplePlan, salariedJob } from "./testing/samplePlan";
import { deriveRealGrowthPct, type Job } from "./job";
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
    // The roster holds authoring Persons; the pre-"now" record derives from their jobs
    // (the sim boundary does the same via compilePerson).
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
    // Months 0–11 are year 0, so baseline pay is a round $6,000; a real-flat salary grows
    // at CPI, so later years are not round.
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
    // A one-month bonus raises that month's gross wages, so the projection's income flow
    // reads base + bonus (the series feeds the waterfall).
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
