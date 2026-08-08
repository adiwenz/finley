/**
 * **The two ways authored pay moves off its own curve**, and what each one means.
 *
 * A {@link JobIncomeOverride} changes exactly one month — a bonus, a missed paycheck — and
 * {@link applyJobIncomeOverride} / {@link applyJobIncomeOverridesAt} / {@link orderedIncomeOverrides}
 * are the single definition of that, exported so no caller re-implements it. A `JobPayChange` is
 * permanent: it moves pay from its month forward. These pin both, and the case that decides
 * whether they are really two things — a raise and a bonus dated the same month.
 *
 * The underlying curve they modify is `job.payPath.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "../ledger/ledger";
import { replayLedger } from "../projection/buildHouseholdInput";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { createProjectionBase, PRIMARY_PERSON_ID, type ProjectionContext } from "../compile/projectionBase";
import { samplePlan, salariedJob } from "../testing/samplePlan";
import {
  applyJobIncomeOverride,
  applyJobIncomeOverridesAt,
  jobPayPath,
  orderedIncomeOverrides,
  type Job,
  type JobIncomeOverride,
} from "./job";
import type { Person } from "../plan/person";
import { compileHouseholdJobSeries } from "../compile/compilePerson";
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
    birthYear: samplePlan.primary.birthYear,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
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
    const series = project({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [job] } }).months;
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
    birthYear: samplePlan.primary.birthYear,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
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
    birthYear: samplePlan.primary.birthYear,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: samplePlan.primary.benefitClaimingAge,
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
    const series = project({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [job] } }).months;
    expect(series[5].flows?.totalIncomeCents).toBe(dollarsToCents(6000));
    expect(series[6].flows?.totalIncomeCents).toBe(dollarsToCents(9000));
    expect(series[7].flows?.totalIncomeCents).toBe(dollarsToCents(9000)); // persists, not one month
  });
});
