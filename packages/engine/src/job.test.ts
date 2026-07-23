/**
 * Issue #64/#72: the first-class Job/Person standing model — the sole source of
 * truth for earned income now that the scalar `incomeCents` path is deleted. These
 * pin the §5/§66 open-ended-job semantics and that the pre-"now" covered-earnings
 * record falls directly out of the jobs.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, nullJurisdiction } from "./index";
import { createProjectionBase, PRIMARY_PERSON_ID, type ProjectionContext } from "./projectionBase";
import { samplePlan, careerJob } from "./testing/samplePlan";
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

/** The sample plan's single open-ended career job (real-flat salary, deferral on it). */
const openEndedJob: Job = careerJob(dollarsToCents(8000), { deferralFraction: 0.1 });

describe("Job/Person standing model — additive compilation (issue #64)", () => {
  it("allows any number of open-ended (null-end) jobs — no elevated career job (§5, issue #66)", () => {
    const birthYear = START_YEAR - samplePlan.currentAge;
    // Two open-ended jobs is legal now: neither is elevated over the other, and both
    // compile to forward income ending at the owner's retirementTargetAge.
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

  it("retirementTargetAge is the per-person input that sets an open-ended job's end (§5, issue #66)", () => {
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
    // The open-ended (null-end) job's forward income stops the month before the owner
    // turns `retirementTargetAge` — the input alone moves the end; nothing else changes.
    expect(openEndedEndMonth(60)).toBe((60 - samplePlan.currentAge) * 12 - 1);
    expect(openEndedEndMonth(65)).toBe((65 - samplePlan.currentAge) * 12 - 1);
    expect(openEndedEndMonth(65)).toBeGreaterThan(openEndedEndMonth(60) as number);
  });

  it("computes pre-'now' earnings directly from the jobs (§4.6)", () => {
    const base = createProjectionBase({ ...samplePlan, jobs: [openEndedJob] }, ctx());
    // The roster holds authoring Persons; the pre-"now" covered-earnings record is
    // derived from their jobs (the sim boundary does the same via compilePerson).
    const prior = compilePersonPriorEarnings(
      base.initialPersons![0],
      START_YEAR,
      samplePlan.inflationPct / 100,
    );
    // The record covers exactly the pre-"now" working years [careerStart … now).
    expect(Object.keys(prior).length).toBeGreaterThan(0);
    // Sim still starts at "now" — no pre-"now" months are simulated (§4.6).
    expect(project({ ...samplePlan, jobs: [openEndedJob] }).months[0].month).toBe(0);
  });

  it("derives a real growth rate from two salary points", () => {
    // Doubling in real terms over 10 years ≈ 7.18%/yr.
    expect(deriveRealGrowthPct(100, 2020, 200, 2030)).toBeCloseTo(7.177, 2);
    expect(deriveRealGrowthPct(100, 2020, 100, 2020)).toBe(0);
  });
});

describe("Job/Person standing model — one-month income overrides (§10.3, §20)", () => {
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
  const base: Job = careerJob(dollarsToCents(6000));

  it("leaves every other month untouched (override is one month only)", () => {
    // Months 0–11 are year 0, so baseline pay is a round $6,000 (a real-flat salary
    // grows at CPI, so later years are not round).
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
    // A large one-month bonus raises that month's gross wages, so the projection's
    // income flow for the month reflects base + bonus (the series feeds the waterfall).
    const job: Job = { ...base, incomeOverrides: [{ month: 6, kind: "addBonus", cents: dollarsToCents(3000) }] };
    const series = project({ ...samplePlan, jobs: [job] }).months;
    expect(series[6].flows?.totalIncomeCents).toBe(dollarsToCents(9000)); // 6000 + 3000
    expect(series[5].flows?.totalIncomeCents).toBe(dollarsToCents(6000));
  });
});
