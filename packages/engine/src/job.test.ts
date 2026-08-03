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
  applyJobIncomeOverride,
  applyJobIncomeOverridesAt,
  jobPayPath,
  monthlyIncomeCentsOf,
  orderedIncomeOverrides,
  startingMonthlyIncomeCentsOf,
  withCurrentMonthlyIncome,
  withDeferralFraction,
  withMonthlyIncome,
  withStartingMonthlyIncome,
  type Job,
  type JobIncomeOverride,
} from "./job";
import type { Person } from "./person";
import { compileHouseholdJobSeries, compilePersonPriorEarnings } from "./compilePerson";
import { personJobContexts, resolveHouseholdJobs } from "./householdJob";
import type { Plan } from "./plan";
import { dollarsToCents } from "./cashFlowSeries";

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
    resolveHouseholdJobs(personJobContexts(membership), nowYear),
    nowYear,
    inflationRate,
  );
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

describe("applyJobIncomeOverride — the one definition of what an adjustment means", () => {
  const bonus = (cents: number): JobIncomeOverride => ({ id: "a", month: 0, kind: "addBonus", cents });
  const setTo = (cents: number): JobIncomeOverride => ({ id: "a", month: 0, kind: "setTo", cents });

  it("adds an additive adjustment to what already stands there", () => {
    expect(applyJobIncomeOverride(600000, bonus(200000))).toBe(800000);
  });

  it("replaces the month's pay for setTo, whatever stood there", () => {
    expect(applyJobIncomeOverride(600000, setTo(400000))).toBe(400000);
    expect(applyJobIncomeOverride(0, setTo(400000))).toBe(400000);
  });

  it("floors at zero — a deduction bigger than the paycheck is a missed one, not a debt", () => {
    expect(applyJobIncomeOverride(600000, bonus(-900000))).toBe(0);
    expect(applyJobIncomeOverride(600000, setTo(-1))).toBe(0);
  });

  it("answers in whole cents, so no caller can introduce a fraction of one", () => {
    expect(applyJobIncomeOverride(100.4, bonus(0.2))).toBe(101); // 100.6, rounded
    expect(Number.isInteger(applyJobIncomeOverride(1, bonus(0.5)))).toBe(true);
  });

  it("composes by folding, which is the whole of what stacking is", () => {
    const stack = [bonus(100), setTo(900), bonus(50)];
    expect(stack.reduce(applyJobIncomeOverride, 600)).toBe(950);
  });

  it("orders by month, then by the order they were authored", () => {
    const later: JobIncomeOverride = { id: "b", month: 5, kind: "addBonus", cents: 1 };
    const first: JobIncomeOverride = { id: "c", month: 1, kind: "addBonus", cents: 2 };
    const second: JobIncomeOverride = { id: "d", month: 1, kind: "addBonus", cents: 3 };
    expect(orderedIncomeOverrides([later, first, second]).map((o) => o.id)).toEqual([
      "c",
      "d",
      "b",
    ]);
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
    const job: Job = { ...base, incomeOverrides: [{ id: "adjustment-60", month: 6, kind: "setTo", cents: 0 }] };
    expect(monthly(job, 5)).toBe(dollarsToCents(6000));
    expect(monthly(job, 6)).toBe(0);
    expect(monthly(job, 7)).toBe(dollarsToCents(6000));
  });

  it("setTo 0 models a missed paycheck; setTo X a one-month salary correction", () => {
    expect(monthly({ ...base, incomeOverrides: [{ id: "adjustment-61", month: 10, kind: "setTo", cents: 0 }] }, 10)).toBe(0);
    expect(
      monthly({ ...base, incomeOverrides: [{ id: "adjustment-62", month: 10, kind: "setTo", cents: dollarsToCents(9000) }] }, 10),
    ).toBe(dollarsToCents(9000));
  });

  it("addBonus adds on top of the month's grown baseline pay", () => {
    const job: Job = { ...base, incomeOverrides: [{ id: "adjustment-63", month: 10, kind: "addBonus", cents: dollarsToCents(2000) }] };
    expect(monthly(job, 10)).toBe(dollarsToCents(8000)); // 6000 base + 2000 bonus
  });

  it("ignores an override outside the job's paid span — a job cannot pay when not worked", () => {
    // A fixed-term job ending before month 24 gets a bonus at month 30: no effect.
    const ended: Job = { ...base, endYear: START_YEAR + 1, incomeOverrides: [{ id: "adjustment-64", month: 30, kind: "addBonus", cents: dollarsToCents(5000) }] };
    expect(monthly(ended, 30)).toBe(0);
  });

  it("stacks several adjustments in one month, each applied to what the last one left", () => {
    // $6,000 base + $2,000 + $1,000. Two payments in one month is an ordinary fact, and
    // neither displaces the other.
    const job: Job = {
      ...base,
      incomeOverrides: [
        { id: "a1", month: 10, kind: "addBonus", cents: dollarsToCents(2000) },
        { id: "a2", month: 10, kind: "addBonus", cents: dollarsToCents(1000) },
      ],
    };
    expect(monthly(job, 10)).toBe(dollarsToCents(9000));
    expect(monthly(job, 9)).toBe(dollarsToCents(6000));
  });

  it("lets a setTo authored first become the baseline a later bonus adds to", () => {
    // Ordering is authoring order within a month — see `orderedIncomeOverrides`.
    const job: Job = {
      ...base,
      incomeOverrides: [
        { id: "a1", month: 10, kind: "setTo", cents: dollarsToCents(4000) },
        { id: "a2", month: 10, kind: "addBonus", cents: dollarsToCents(1500) },
      ],
    };
    expect(monthly(job, 10)).toBe(dollarsToCents(5500));
  });

  it("lets a setTo authored last discard the bonus before it — that is what setTo says", () => {
    const job: Job = {
      ...base,
      incomeOverrides: [
        { id: "a1", month: 10, kind: "addBonus", cents: dollarsToCents(1500) },
        { id: "a2", month: 10, kind: "setTo", cents: dollarsToCents(4000) },
      ],
    };
    expect(monthly(job, 10)).toBe(dollarsToCents(4000));
  });

  it("floors a stack at zero rather than paying a negative wage", () => {
    const job: Job = {
      ...base,
      incomeOverrides: [
        { id: "a1", month: 10, kind: "addBonus", cents: -dollarsToCents(4000) },
        { id: "a2", month: 10, kind: "addBonus", cents: -dollarsToCents(5000) },
      ],
    };
    // −$9,000 against $6,000 of pay is a missed paycheck, never a bill from the employer.
    expect(monthly(job, 10)).toBe(0);
  });

  it("stacks a one-month bonus on top of a permanent raise dated the same month", () => {
    // Different kinds entirely: the raise opens a salary segment and the bonus perturbs the
    // one month. Both are in force, and the bonus lands on the RAISED pay.
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(7000) }],
      incomeOverrides: [{ id: "a1", month: 10, kind: "addBonus", cents: dollarsToCents(2000) }],
    };
    expect(monthly(job, 10)).toBe(dollarsToCents(9000));
    expect(monthly(job, 11)).toBe(dollarsToCents(7000)); // the raise stands; the bonus does not
  });

  it("reads the same stacked figure as the authoring surfaces do", () => {
    // `applyJobIncomeOverridesAt` is what the chart, the timeline and the Base + Adjustments
    // list fold over. It must agree with what the projection actually pays, or a bonus is
    // drawn at a figure the household never receives.
    const overrides: readonly JobIncomeOverride[] = [
      { id: "a1", month: 10, kind: "addBonus", cents: dollarsToCents(2000) },
      { id: "a2", month: 10, kind: "addBonus", cents: dollarsToCents(1000) },
    ];
    const job: Job = { ...base, incomeOverrides: overrides };
    expect(applyJobIncomeOverridesAt(dollarsToCents(6000), overrides, 10)).toBe(monthly(job, 10));
    // A month with none is left exactly as it was.
    expect(applyJobIncomeOverridesAt(dollarsToCents(6000), overrides, 9)).toBe(dollarsToCents(6000));
  });

  it("taxes a bonus as wages through the projection, not as untaxed cash", () => {
    // A one-month bonus raises that month's gross wages, so the income flow reads
    // base + bonus.
    const job: Job = { ...base, incomeOverrides: [{ id: "adjustment-65", month: 6, kind: "addBonus", cents: dollarsToCents(3000) }] };
    const series = project({ ...samplePlan, jobs: [job] }).months;
    expect(series[6].flows?.totalIncomeCents).toBe(dollarsToCents(9000)); // 6000 + 3000
    expect(series[5].flows?.totalIncomeCents).toBe(dollarsToCents(6000));
  });
});

/**
 * A raise and a one-month adjustment dated the SAME month — the case where the two kinds could
 * most easily be confused for one, and the one that regressed.
 *
 * The rule is stated on `JobPayChangeInput` in `job.ts`: the pay change establishes the salary
 * state, then the override modifies only that month's payment. A missed paycheck against a
 * same-month raise therefore pays nothing that month and the RAISED salary from the next one —
 * neither fact cancels the other.
 */
describe("a permanent raise and a one-month adjustment in the same month", () => {
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

  // $5,000/mo, real-flat. Months 0–11 are the first CPI year, so every figure below is round.
  const base: Job = salariedJob(dollarsToCents(5000));

  it("pays nothing in the month, and the raised salary from the next one", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: [{ id: "a1", month: 10, kind: "setTo", cents: 0 }],
    };
    expect(monthly(job, 9)).toBe(dollarsToCents(5000)); // the old salary, up to the raise
    expect(monthly(job, 10)).toBe(0); // missed — the payment, not the salary
    expect(monthly(job, 11)).toBe(dollarsToCents(6000)); // the raise stands, unaffected
  });

  it("survives the missed month — the raise is not undone by nothing being paid", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: [{ id: "a1", month: 10, kind: "setTo", cents: 0 }],
    };
    // A year on, the raised salary has grown at CPI off $6,000 — the $0 month left no mark on
    // the salary state, because an override never sets one.
    expect(monthly(job, 22)).toBe(Math.round(dollarsToCents(6000) * 1.03));
  });

  it("applies a partial one-month correction to the RAISED pay, not the old salary", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      // Half a month's work at the new salary, say. $3,000 is the authored figure either way;
      // what matters is that the month after is still the raise.
      incomeOverrides: [{ id: "a1", month: 10, kind: "setTo", cents: dollarsToCents(3000) }],
    };
    expect(monthly(job, 10)).toBe(dollarsToCents(3000));
    expect(monthly(job, 11)).toBe(dollarsToCents(6000));
  });

  it("deducts from the raised figure when the correction is additive", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: [{ id: "a1", month: 10, kind: "addBonus", cents: -dollarsToCents(1500) }],
    };
    // $6,000 − $1,500, NOT $5,000 − $1,500: the raise set the month's salary first.
    expect(monthly(job, 10)).toBe(dollarsToCents(4500));
    expect(monthly(job, 11)).toBe(dollarsToCents(6000));
  });

  it("handles a raise and a missed paycheck both dated month 0", () => {
    const job: Job = {
      ...base,
      // A change authored at "now" takes force NEXT month — the stated current salary owns
      // month 0. See `payChangeEffectiveMonth`.
      payChanges: [{ id: "p1", month: 0, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: [{ id: "a1", month: 0, kind: "setTo", cents: 0 }],
    };
    expect(monthly(job, 0)).toBe(0); // the override lands on month 0 itself; nothing is paid
    expect(monthly(job, 1)).toBe(dollarsToCents(6000)); // the deferred raise begins here
    expect(monthly(job, 2)).toBe(dollarsToCents(6000));
  });

  it("leaves the month-0 raise intact when the missed paycheck is removed again", () => {
    // The deferral and the override are independent: dropping one must not move the other.
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 0, kind: "setTo", cents: dollarsToCents(6000) }],
    };
    expect(monthly(job, 0)).toBe(dollarsToCents(5000)); // the anchor still owns month 0
    expect(monthly(job, 1)).toBe(dollarsToCents(6000));
  });

  it("reads the same figure through the helper every authoring surface folds", () => {
    // `jobPayPath` compiles the SALARY STATE — the raise, not the override — and a surface
    // layers the month's adjustments on top. This is that composition, asserted against what
    // the projection actually pays, so a chart cannot draw a month the household never sees.
    const overrides: readonly JobIncomeOverride[] = [
      { id: "a1", month: 10, kind: "setTo", cents: 0 },
    ];
    const job: Job = {
      ...base,
      payChanges: [{ id: "p1", month: 10, kind: "setTo", cents: dollarsToCents(6000) }],
      incomeOverrides: overrides,
    };
    const span = { startMonth: -120, endMonthExclusive: 360 };
    const path = jobPayPath(job, span);

    // The path knows the raise and nothing about the missed paycheck.
    expect(path.monthlyCentsAt(10)).toBe(dollarsToCents(6000));
    // Folded, it agrees with the projection to the cent — for the adjusted month and the next.
    expect(applyJobIncomeOverridesAt(path.monthlyCentsAt(10), overrides, 10)).toBe(monthly(job, 10));
    expect(applyJobIncomeOverridesAt(path.monthlyCentsAt(11), overrides, 11)).toBe(monthly(job, 11));
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
    const job: Job = { ...base, payChanges: [{ id: "adjustment-66", month: 6, kind: "setTo", cents: dollarsToCents(9000) }] };
    expect(monthly(job, 5)).toBe(dollarsToCents(6000)); // before the change: old pay
    expect(monthly(job, 6)).toBe(dollarsToCents(9000)); // the pay-change month
    expect(monthly(job, 11)).toBe(dollarsToCents(9000)); // and it PERSISTS (not one month)
  });

  it("changeBy adds to the month's baseline from its month forward; a negative delta is a cut", () => {
    const up: Job = { ...base, payChanges: [{ id: "adjustment-67", month: 6, kind: "changeBy", cents: dollarsToCents(2000) }] };
    expect(monthly(up, 5)).toBe(dollarsToCents(6000));
    expect(monthly(up, 6)).toBe(dollarsToCents(8000)); // 6000 + 2000, ongoing
    expect(monthly(up, 11)).toBe(dollarsToCents(8000));
    const cut: Job = { ...base, payChanges: [{ id: "adjustment-68", month: 6, kind: "changeBy", cents: -dollarsToCents(2000) }] };
    expect(monthly(cut, 6)).toBe(dollarsToCents(4000)); // a pay cut
  });

  it("compounds successive pay changes in month order", () => {
    const job: Job = {
      ...base,
      payChanges: [
        { id: "adjustment-69", month: 6, kind: "setTo", cents: dollarsToCents(9000) },
        { id: "adjustment-70", month: 9, kind: "changeBy", cents: dollarsToCents(1000) },
      ],
    };
    expect(monthly(job, 6)).toBe(dollarsToCents(9000));
    expect(monthly(job, 9)).toBe(dollarsToCents(10000)); // 9000 set + 1000 delta
  });

  it("applies pay changes BEFORE one-month overrides, so a later bonus lands on the changed pay", () => {
    const job: Job = {
      ...base,
      payChanges: [{ id: "adjustment-71", month: 6, kind: "setTo", cents: dollarsToCents(9000) }],
      incomeOverrides: [{ id: "adjustment-72", month: 8, kind: "addBonus", cents: dollarsToCents(1000) }],
    };
    expect(monthly(job, 7)).toBe(dollarsToCents(9000)); // changed pay
    expect(monthly(job, 8)).toBe(dollarsToCents(10000)); // changed pay + bonus
    expect(monthly(job, 9)).toBe(dollarsToCents(9000)); // bonus was one month; pay change persists
  });

  it("ignores a pay change outside the job's paid span — a job cannot be repriced when not worked", () => {
    const ended: Job = { ...base, endYear: START_YEAR + 1, payChanges: [{ id: "adjustment-73", month: 30, kind: "setTo", cents: dollarsToCents(9000) }] };
    expect(monthly(ended, 30)).toBe(0);
  });

  it("carries the changed pay through the projection as taxable wages, every month after", () => {
    const job: Job = { ...base, payChanges: [{ id: "adjustment-74", month: 6, kind: "setTo", cents: dollarsToCents(9000) }] };
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
      payChanges: [{ id: "adjustment-86", month: 12, kind: "setTo", cents: dollarsToCents(9_000) }],
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
  const paid = (job: Job, month: number, span?: { startMonth: number; endMonth: number | null }) => {
    const membership = { person: partner([job]), ...(span ?? { startMonth: JOIN, endMonth: null }) };
    const compiled = compileHouseholdJobSeries(
      resolveHouseholdJobs(personJobContexts(membership), START_YEAR),
      START_YEAR,
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
