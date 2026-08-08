/**
 * **The Job/Person standing model — how an authored job becomes this household's income.**
 *
 * The sole source of truth for earned income: several jobs compile additively rather than one
 * winning, the pre-"now" covered-earnings record falls out of the same jobs, the band a wage is
 * drawn under is named by the job, and a membership clips what the HOUSEHOLD is paid without
 * touching the job's own salary path.
 *
 * Two neighbours own the rest: `job.payPath.test.ts` the authored pay curve itself, and
 * `job.adjustments.test.ts` the overrides and pay changes that move it.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "../ledger/ledger";
import { replayLedger } from "../projection/buildHouseholdInput";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { createProjectionBase, PRIMARY_PERSON_ID, type ProjectionContext } from "../compile/projectionBase";
import { samplePlan, salariedJob, SAMPLE_JOB_END_AGE } from "../testing/samplePlan";
import {
  deferralFractionOf,
  deriveRealGrowthPct,
  jobPayPath,
  monthlyIncomeCentsOf,
  type Job,
} from "./job";
import { RETIREMENT_ID } from "../plan/ids";
import type { Person } from "../plan/person";
import { compileHouseholdJobSeries, compilePersonPriorEarnings } from "../compile/compilePerson";
import { personJobContexts, resolveHouseholdJobs } from "./householdJob";
import type { Plan } from "../plan/plan";
import { dollarsToCents } from "../money/cashFlowSeries";

const START_YEAR = 2026;

function ctx(): ProjectionContext {
  return { jurisdiction: nullJurisdiction, startYear: START_YEAR };
}

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

function project(plan: Plan) {
  return replayLedger(emptyLedger, createProjectionBase(plan, ctx()), nullJurisdiction);
}

/** The sample plan's single open-ended job (real-flat salary, deferral on it). */
const openEndedJob: Job = salariedJob(dollarsToCents(8000), { deferralFraction: 0.1 });
/** Authored to run to 80 — past the sample plan's retirement age, so the two are visibly not the same thing. */
const lateEndingJob: Job = salariedJob(dollarsToCents(8000), { deferralFraction: 0.1, endAge: 80 });


describe("Job/Person standing model — additive compilation", () => {
  it("allows any number of jobs — no elevated career job", () => {
    const birthYear = samplePlan.primary.birthYear;
    // Two jobs is legal: neither is elevated, and each compiles to forward income ending where
    // it was authored to end.
    const person: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
      // Both authored to run to 80 — well past where the fixture's own job stops at 60, which
      // is the point: the end is each job's, and holding two does not make either the one that
      // ends employment.
      jobs: [lateEndingJob, { ...lateEndingJob, id: "job-2" }],
    };
    const series = compilePersonIncomeSeries(person, START_YEAR, samplePlan.inflationPct / 100);
    expect(series).toHaveLength(2);
    const authoredEndMonth = (80 - (START_YEAR - samplePlan.primary.birthYear)) * 12 - 1;
    expect(series.every((s) => s.series.endMonth === authoredEndMonth)).toBe(true);
    expect(series[0]!.series.endMonth).toBeGreaterThan(
      (SAMPLE_JOB_END_AGE - (START_YEAR - samplePlan.primary.birthYear)) * 12,
    );
  });

  it("carries no retirement age at all — a Person is a birth year, a claiming age and jobs", () => {
    // `retirementTargetAge` is gone from the model, not merely ignored. While it existed it was
    // the thing that ended an open-ended job, so a planning target authored on another panel
    // decided when employment stopped; the field being absent is what makes that unsayable.
    const person: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear: samplePlan.primary.birthYear,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
      jobs: [lateEndingJob],
    };
    expect(Object.keys(person)).not.toContain("retirementTargetAge");
    const [series] = compilePersonIncomeSeries(person, START_YEAR, samplePlan.inflationPct / 100);
    expect(series.series.endMonth).toBe((80 - (START_YEAR - samplePlan.primary.birthYear)) * 12 - 1);
  });

  it("ends a job exactly where it was authored to end", () => {
    // The other half of the same rule: what the user stated is what happens. Only an authored
    // end ends a job, and it is unaffected by any retirement target.
    const birthYear = samplePlan.primary.birthYear;
    const endYear = START_YEAR + 10;
    const person: Person = {
      id: PRIMARY_PERSON_ID,
      name: "P",
      birthYear,
      lifeExpectancy: samplePlan.primary.lifeExpectancy,
      benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
      jobs: [{ ...openEndedJob, endYear }],
    };
    const [series] = compilePersonIncomeSeries(person, START_YEAR, samplePlan.inflationPct / 100);
    expect(series.series.endMonth).toBe(10 * 12 - 1);
  });

  it("computes pre-'now' earnings directly from the jobs", () => {
    const base = createProjectionBase({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [openEndedJob] } }, ctx());
    // The pre-"now" record derives from the roster's authoring Persons, as the sim
    // boundary does via compilePerson.
    const prior = compilePersonPriorEarnings(base.initialPersons![0], START_YEAR);
    // The record covers exactly the pre-"now" working years [careerStart … now).
    expect(Object.keys(prior).length).toBeGreaterThan(0);
    // Sim still starts at "now" — no pre-"now" months are simulated.
    expect(project({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [openEndedJob] } }).months[0].month).toBe(0);
  });

  it("derives a real growth rate from two salary points", () => {
    // Doubling in real terms over 10 years ≈ 7.18%/yr.
    expect(deriveRealGrowthPct(100, 2020, 200, 2030)).toBeCloseTo(7.177, 2);
    expect(deriveRealGrowthPct(100, 2020, 100, 2020)).toBe(0);
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
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    jobs,
  });
  const priorFor = (jobs: Job[]): Record<number, number> =>
    compilePersonPriorEarnings(personWith(jobs), START_YEAR);

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
    const raised: Job = { ...flat72k, payChanges: [{ id: "adjustment-75", month: -24, kind: "setTo", cents: dollarsToCents(10_000) }] };
    const prior = priorFor([raised]);
    expect(prior[2023]).toBe(dollarsToCents(72_000));
    expect(prior[2024]).toBe(dollarsToCents(120_000));
    expect(prior[2025]).toBe(dollarsToCents(120_000));
  });

  it("adds a pre-'now' covered bonus to exactly its year", () => {
    const withBonus: Job = { ...flat72k, incomeOverrides: [{ id: "adjustment-76", month: -6, kind: "addBonus", cents: dollarsToCents(5_000) }] };
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
    const raisedLater: Job = { ...flat72k, payChanges: [{ id: "adjustment-77", month: 12, kind: "setTo", cents: dollarsToCents(20_000) }] };
    const prior = priorFor([raisedLater]);
    expect(prior[2025]).toBe(dollarsToCents(72_000));
    expect(prior[2027]).toBeUndefined();
  });
});


describe("Job — human name drives the income band label (display only)", () => {
  const personWith = (job: Job): Person => ({
    id: PRIMARY_PERSON_ID,
    name: "P",
    birthYear: samplePlan.primary.birthYear,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
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
    endYear: START_YEAR + 40,
    salary: { startingSalaryCents: dollarsToCents(72_000), currentSalaryCents: dollarsToCents(72_000), realGrowthPct: 2 },
  };

  it("round-trips a monthly figure through the annual one it is stored as", () => {
    // The form states monthly, the job stores annual, and a number typed in has to come back
    // out as the number typed — the reader's rounding has to invert the ×12 the anchor is
    // authored with.
    for (const monthly of [dollarsToCents(5_000), dollarsToCents(4_333.33), 1, 0]) {
      const stored: Job = { ...job, salary: { ...job.salary, currentSalaryCents: monthly * 12 } };
      expect(monthlyIncomeCentsOf(stored)).toBe(monthly);
    }
  });

  it("reads the STARTING monthly salary, before growth and pay changes", () => {
    const raised: Job = {
      ...job,
      payChanges: [{ id: "adjustment-86", month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    expect(monthlyIncomeCentsOf(raised)).toBe(dollarsToCents(6_000));
  });

  it("reads an absent deferral as the 0% it is elected at", () => {
    // No deferral and a 0% deferral read the same, so the form never shows a rate the person
    // never elected. The absent case is the `deferral` key omitted outright — where authoring
    // puts a dropped deferral — and a present one reads its stored fraction straight back.
    const deferring: Job = {
      ...job,
      deferral: { deferralFraction: 0.1, fundAccountId: RETIREMENT_ID },
    };
    expect(deferralFractionOf(job)).toBe(0);
    expect(deferralFractionOf(deferring)).toBe(0.1);
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
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
    jobs,
  });
  /** $6,000/mo now, real-flat, running from before "now" to retirement. */
  const base: Job = {
    id: "job-p2",
    ownerId: "p2",
    startYear: BIRTH_YEAR + 30,
    endYear: START_YEAR + 40,
    salary: {
      startingSalaryCents: dollarsToCents(72_000),
      currentSalaryCents: dollarsToCents(72_000),
      realGrowthPct: 0,
    },
  };
  /** Zero CPI, so a paycheck is the authored figure and a raise is visible as itself. */
  const paid = (job: Job, month: number, span?: { startMonth: number; endMonth: number | null }) => {
    const membership = { person: partner([job]), ...(span ?? { startMonth: JOIN, endMonth: null }) };
    const compiled = compileHouseholdJobSeries(
      resolveHouseholdJobs(personJobContexts(membership), START_YEAR, { kind: "authored" }),
      0,
    );
    return compiled.length === 0 ? 0 : compiled[0]!.series.getMonthlyCents(month);
  };

  it("carries a pre-join setTo into the salary the partner brings with them", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-106", month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    expect(paid(job, 12)).toBe(0); // not a member yet — nothing is paid
    expect(paid(job, JOIN)).toBe(dollarsToCents(9_000)); // arrives on the RAISED salary
  });

  it("carries a pre-join changeBy, composed against the pay standing at the time", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-107", month: 12, kind: "changeBy", cents: dollarsToCents(1_500) }],
    };
    expect(paid(job, JOIN)).toBe(dollarsToCents(7_500)); // 6,000 + 1,500
  });

  it("composes several pre-join changes in order", () => {
    const job: Job = {
      ...base,
      payChanges: [
        { id: "adjustment-108", month: 6, kind: "setTo", cents: dollarsToCents(8_000) },
        { id: "adjustment-109", month: 12, kind: "changeBy", cents: dollarsToCents(500) },
        { id: "adjustment-110", month: 18, kind: "changeBy", cents: dollarsToCents(-1_000) },
      ],
    };
    expect(paid(job, JOIN)).toBe(dollarsToCents(7_500)); // 8,000 + 500 − 1,000
  });

  it("excludes a pre-join bonus — a bonus is a payment, not a salary state", () => {
    const job: Job = {
      ...base,
      incomeOverrides: [{ id: "adjustment-111", month: 12, kind: "addBonus", cents: dollarsToCents(5_000) }],
    };
    expect(paid(job, 12)).toBe(0);
    expect(paid(job, JOIN)).toBe(dollarsToCents(6_000)); // unchanged by the bonus it missed
  });

  it("includes a bonus that lands during membership", () => {
    const job: Job = {
      ...base,
      incomeOverrides: [{ id: "adjustment-112", month: 36, kind: "addBonus", cents: dollarsToCents(5_000) }],
    };
    expect(paid(job, 36)).toBe(dollarsToCents(11_000));
    expect(paid(job, 37)).toBe(dollarsToCents(6_000));
  });

  it("stops paying when membership ends, leaving the job's own path untouched", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-113", month: 60, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    const window = { startMonth: JOIN, endMonth: 48 };
    expect(paid(job, 47, window)).toBe(dollarsToCents(6_000));
    expect(paid(job, 48, window)).toBe(0);
    // The raise at month 60 is still the job's own — read without a membership window it lands.
    expect(paid(job, 60, { startMonth: 0, endMonth: null })).toBe(
      dollarsToCents(9_000),
    );
  });

  it("keeps month-0 semantics under a membership window", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-114", month: 0, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    const fromNow = { startMonth: 0, endMonth: null };
    expect(paid(job, 0, fromNow)).toBe(dollarsToCents(6_000)); // the anchor still owns month 0
    expect(paid(job, 1, fromNow)).toBe(dollarsToCents(9_000));
  });

  it("leaves jobPayPath alone — it knows nothing about households", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-115", month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
    };
    const path = jobPayPath(job, { startMonth: -120, endMonthExclusive: 300 });
    expect(path.monthlyCentsAt(12)).toBe(dollarsToCents(9_000));
    expect(path.monthlyCentsAt(JOIN)).toBe(dollarsToCents(9_000));
  });
});
