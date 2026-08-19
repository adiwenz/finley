/**
 * WITHHOLDING WHEN A PERSON HOLDS MORE THAN ONE JOB, end to end through the public `Projection`
 * surface against real US-2026 rules.
 *
 * Two independent employers each price their own wages as if they were the person's only income,
 * so between them they withhold from the bottom of the brackets twice and the year comes up short.
 * A W-4 has the employee correct for that themselves, and these tests are about the correction:
 * that it is sized from what has ACTUALLY been paid rather than from a forecast, that it lands on
 * one job rather than every job, that it re-derives itself the month the job mix changes, and —
 * the invariant everything else rests on — that no version of it ever reaches back and re-withholds
 * a paycheque already paid.
 */
import { describe, it, expect } from "vitest";
import {
  Projection,
  CURRENT_FORMAT_VERSION,
  dollarsToCents,
  type Plan,
  type Job,
  type JobIncomeOverride,
  type TaxCategory,
  type ProjectionResult,
} from "@finley/engine";
import { usJurisdiction } from "./index";

const START_YEAR = 2026;
const BIRTH_YEAR = START_YEAR - 40;
/** Two whole tax years plus the April that settles the second — everything these tests read. */
const HORIZON_MONTHS = 24;

/**
 * One job's pay, stated month by month rather than as a salary with events layered on: every
 * scenario here turns on WHICH months a job pays and how much, so saying it directly is what
 * keeps the fixture readable and the mid-year boundaries exact.
 */
interface JobSpec {
  readonly id: string;
  /** Regular monthly pay in dollars — 0 for a month the job is not being held. */
  readonly monthlyDollars: (month: number) => number;
  /** One-off dollars paid on top that month, withheld as supplemental wages. */
  readonly bonusDollars?: (month: number) => number;
}

/** A job paying `annualDollars` in every month of `[startMonth, endMonthExclusive)` and nothing outside it. */
function steadyJob(
  id: string,
  annualDollars: number,
  startMonth = 0,
  endMonthExclusive = HORIZON_MONTHS,
): JobSpec {
  return {
    id,
    monthlyDollars: (month) =>
      month >= startMonth && month < endMonthExclusive ? annualDollars / 12 : 0,
  };
}

function toJob(spec: JobSpec): Job {
  const incomeOverrides: JobIncomeOverride[] = [];
  for (let month = 0; month < HORIZON_MONTHS; month++) {
    // `setTo` first, so it is the baseline the bonus then adds to — and so the month's regular
    // rate of pay is stated outright rather than inferred from a salary path.
    incomeOverrides.push({
      id: `${spec.id}-pay-${month}`,
      month,
      kind: "setTo",
      cents: dollarsToCents(spec.monthlyDollars(month)),
    });
    const bonus = spec.bonusDollars?.(month) ?? 0;
    if (bonus > 0) {
      incomeOverrides.push({
        id: `${spec.id}-bonus-${month}`,
        month,
        kind: "addBonus",
        cents: dollarsToCents(bonus),
      });
    }
  }
  return {
    id: spec.id,
    ownerId: "p1",
    startYear: BIRTH_YEAR + 22,
    endYear: BIRTH_YEAR + 65,
    salary: {
      startingSalaryCents: dollarsToCents(12 * spec.monthlyDollars(0)),
      currentSalaryCents: dollarsToCents(12 * spec.monthlyDollars(0)),
      realGrowthPct: 0,
    },
    incomeOverrides,
  };
}

/**
 * No expenses, no investment return and no inflation, so the ONLY thing moving between the
 * paycheque and the April balance is withholding — an interest credit or a price index would put
 * income into the year that no payroll system could have withheld against, and every "withheld
 * what it owed" assertion below would have to be loosened to absorb it.
 */
function planWith(...specs: readonly JobSpec[]): Plan {
  return {
    budgetLines: [],
    openingBalanceCents: dollarsToCents(200_000),
    savingsReturnPct: 0,
    retirementReturnPct: 0,
    brokerageReturnPct: 0,
    sharedScheme: "proportional",
    goals: [],
    inflationPct: 0,
    primary: {
      id: "p1",
      name: "Single filer",
      birthYear: BIRTH_YEAR,
      lifeExpectancy: 85,
      benefitClaimingAge: 67,
      jobs: specs.map(toJob),
    },
  };
}

function run(...specs: readonly JobSpec[]): ProjectionResult {
  return Projection.fromState(
    {
      scenario: { plan: planWith(...specs), ledger: { events: [], nextSequenceNumber: 0 } },
      startYear: START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
    },
    usJurisdiction,
  ).run(usJurisdiction);
}

/** Income tax charged in one month — withholding, plus the prior year's balance in April only. */
const taxIn = (result: ProjectionResult, month: number): number =>
  result.series.months[month]?.flows?.taxCents ?? 0;

const monthlyTax = (result: ProjectionResult, from: number, toExclusive: number): number[] =>
  Array.from({ length: toExclusive - from }, (_, i) => taxIn(result, from + i));

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Assert a run of months withholds one figure. To the cent, not exactly: the correction is rounded
 * to whole cents per period, and each month re-derives it against what the previous months really
 * withheld, so a rounding residue is picked up rather than left to drift.
 */
function expectLevel(months: readonly number[]): void {
  expect(Math.max(...months) - Math.min(...months)).toBeLessThanOrEqual(1);
}

/** The year's ACTUAL income by category, as the run itself reported it. */
function actualAnnualBase(
  result: ProjectionResult,
  year: number,
): Partial<Record<TaxCategory, number>> {
  const base: Partial<Record<TaxCategory, number>> = {};
  for (const month of result.series.months.slice(year * 12, year * 12 + 12)) {
    for (const [category, cents] of Object.entries(
      month.flows?.cashFlowIncomeByCategoryCents ?? {},
    )) {
      base[category as TaxCategory] = (base[category as TaxCategory] ?? 0) + cents;
    }
  }
  return base;
}

/** What the year actually OWES on the wages it actually paid — the figure withholding aims at. */
function annualLiability(result: ProjectionResult, year: number): number {
  return usJurisdiction.computeTaxCents(
    { wages: actualAnnualBase(result, year).wages ?? 0 },
    { year: START_YEAR + year },
  );
}

/**
 * The balance the prior tax year settled at, positive when due — April's charge less the ordinary
 * withholding either side of it. April is the one month carrying tax from two years at once, so a
 * neighbouring month is the reference for what its own withholding was; exact wherever the filing
 * year's own pay is level, which every fixture below arranges.
 */
const aprilBalance = (result: ProjectionResult): number => taxIn(result, 15) - taxIn(result, 14);

describe("multiple concurrent jobs — the withholding correction the employee makes", () => {
  it("withholds a two-job year to what it owes, where two independent employers would fall short", () => {
    const both = run(steadyJob("big", 180_000), steadyJob("small", 20_000));
    const withheld = sum(monthlyTax(both, 0, 12));
    expect(Math.abs(withheld - annualLiability(both, 0))).toBeLessThan(dollarsToCents(20));

    // The gap being closed: $20k priced on its own sits almost entirely in the 0% band and the
    // 10% bracket, when in truth it is stacked on $180k and every dollar of it is marginal.
    const uncorrected = sum(monthlyTax(run(steadyJob("big", 180_000)), 0, 12));
    const smallAlone = sum(monthlyTax(run(steadyJob("small", 20_000)), 0, 12));
    expect(uncorrected + smallAlone).toBeLessThan(withheld - dollarsToCents(3_000));
  });

  it("charges the correction to ONE job — the highest-paying — rather than to every employer", () => {
    const result = run(steadyJob("big", 180_000), steadyJob("small", 20_000));
    const bySource = result.series.months[0]?.flows?.taxBySourceCents ?? {};
    const smallAlone = taxIn(run(steadyJob("small", 20_000)), 0);
    // The smaller employer withholds exactly what it would if it were the only job in the world;
    // it has no way to know about the other one, and the model does not pretend it does.
    expect(bySource["job:small"]).toBe(smallAlone);
    expect(bySource["job:big"]).toBeGreaterThan(taxIn(run(steadyJob("big", 180_000)), 0));
  });

  it("spreads the correction across three jobs of very different sizes", () => {
    const result = run(
      steadyJob("large", 200_000),
      steadyJob("middling", 30_000),
      steadyJob("tiny", 10_000),
    );
    const withheld = sum(monthlyTax(result, 0, 12));
    expect(Math.abs(withheld - annualLiability(result, 0))).toBeLessThan(dollarsToCents(20));
    // Nothing about the method is specific to two jobs: the halved-bracket checkbox it replaces
    // could not have expressed this at all.
    const alone =
      sum(monthlyTax(run(steadyJob("large", 200_000)), 0, 12)) +
      sum(monthlyTax(run(steadyJob("middling", 30_000)), 0, 12)) +
      sum(monthlyTax(run(steadyJob("tiny", 10_000)), 0, 12));
    expect(alone).toBeLessThan(withheld);
  });
});

describe("multiple concurrent jobs — a job mix that changes mid-year", () => {
  const JOB_A = steadyJob("a", 100_000);
  /** Starts in July of year 0 and runs on — the second half of one year, then a whole one. */
  const JOB_B_FROM_JULY = steadyJob("b", 50_000, 6);

  it("leaves January–June exactly as they were when a second job starts in July", () => {
    const before = monthlyTax(run(JOB_A), 0, 6);
    const after = monthlyTax(run(JOB_A, JOB_B_FROM_JULY), 0, 6);
    // THE INVARIANT: an event in month 6 may change month 6 and everything after it, and nothing
    // at all before it. No annualized YTD average, no re-withholding, no catch-up on a paycheque
    // that has already been spent.
    expect(after).toEqual(before);
  });

  it("makes the rest of the year carry the whole correction the first half never withheld", () => {
    const result = run(JOB_A, JOB_B_FROM_JULY);
    const months = monthlyTax(result, 0, 12);
    // July jumps by more than the new job's own withholding: it also starts making up the six
    // months in which one employer priced $100k as if it were the household's whole income.
    const bAlone = taxIn(run(steadyJob("b", 50_000)), 0);
    expect(months[6]! - months[5]!).toBeGreaterThan(bAlone);
    // Level from July on — the correction is re-derived every month and lands on the same figure,
    // because what it is aiming at has not moved.
    expectLevel(months.slice(6));
    // And it gets there: by December the year has withheld what the year actually owes, on the
    // $125k it actually paid rather than on the $150k a full year of both jobs would have.
    expect(Math.abs(sum(months) - annualLiability(result, 0))).toBeLessThan(dollarsToCents(20));
  });

  it("asks December alone to settle a job that starts in December", () => {
    const result = run(JOB_A, steadyJob("b", 50_000, 11));
    const months = monthlyTax(result, 0, 12);
    expect(months.slice(0, 11)).toEqual(monthlyTax(run(JOB_A), 0, 11));
    // One pay period left, so the whole of the correction is due in it: December withholds more
    // than double what the new job's own employer would have taken, and the year lands on its
    // liability rather than deferring the shortfall to April.
    const bAlone = taxIn(run(steadyJob("b", 50_000)), 0);
    expect(months[11]! - months[10]!).toBeGreaterThan(bAlone * 2);
    expect(Math.abs(sum(months) - annualLiability(result, 0))).toBeLessThan(dollarsToCents(20));
  });

  it("stops correcting the month a second job ends, and refunds the excess in April", () => {
    // B is held for January to March only. While it is held, the correction is sized as though it
    // will continue — which is the only thing an employee could know in February — so the year
    // ends up ahead of its liability rather than behind it.
    const result = run(JOB_A, steadyJob("b", 50_000, 0, 3));
    const months = monthlyTax(result, 0, 12);
    expect(months[3]!).toBeLessThan(months[2]!);
    // From April onward it is a plain one-job year again, at exactly the figure one job withholds.
    const aAlone = taxIn(run(JOB_A), 0);
    for (const tax of months.slice(3)) expect(tax).toBe(aAlone);
    expect(sum(months)).toBeGreaterThan(annualLiability(result, 0));
    // Over-withholding is never handed back mid-year — payroll cannot do that. It comes back as
    // the refund it really is, the following April.
    expect(aprilBalance(result)).toBeLessThan(0);
  });

  it("re-derives the correction at each step as a second and then a third job start", () => {
    const result = run(
      steadyJob("a", 90_000),
      steadyJob("b", 60_000, 4),
      steadyJob("c", 30_000, 8),
    );
    const months = monthlyTax(result, 0, 12);
    // Three regimes, each level within itself and each higher than the last — one recalculation
    // per change, never a rolling average that would smear the boundaries.
    expectLevel(months.slice(0, 4));
    expectLevel(months.slice(4, 8));
    expectLevel(months.slice(8, 12));
    expect(months[4]!).toBeGreaterThan(months[3]!);
    expect(months[8]!).toBeGreaterThan(months[7]!);
    // Earlier regimes are untouched by the later ones.
    expect(months.slice(0, 4)).toEqual(monthlyTax(run(steadyJob("a", 90_000)), 0, 4));
    expect(Math.abs(sum(months) - annualLiability(result, 0))).toBeLessThan(dollarsToCents(20));
  });

  it("recalculates when a salary changes while two jobs are being held", () => {
    const raised: JobSpec = {
      id: "a",
      monthlyDollars: (month) => (month < 6 ? 100_000 / 12 : 150_000 / 12),
    };
    const result = run(raised, steadyJob("b", 50_000));
    const months = monthlyTax(result, 0, 12);
    // The raise moves July onward and nothing before it, exactly as a job starting would.
    expect(months.slice(0, 6)).toEqual(monthlyTax(run(steadyJob("a", 100_000), steadyJob("b", 50_000)), 0, 6));
    expect(months[6]!).toBeGreaterThan(months[5]!);
    expect(Math.abs(sum(months) - annualLiability(result, 0))).toBeLessThan(dollarsToCents(20));
  });
});

describe("multiple concurrent jobs — bonuses stay supplemental", () => {
  const WITH_BONUS: JobSpec = {
    id: "a",
    monthlyDollars: () => 100_000 / 12,
    bonusDollars: (month) => (month === 5 ? 20_000 : 0),
  };

  it("withholds a bonus at the flat supplemental rate without disturbing the regular correction", () => {
    const result = run(WITH_BONUS, steadyJob("b", 50_000));
    const months = monthlyTax(result, 0, 12);
    // June is May plus 22% of the bonus and nothing else: the multiple-jobs correction is sized
    // from the RATE of pay each job is issuing, and a one-off payment is not a rate of pay.
    const flatOnBonus = Math.round(dollarsToCents(20_000) * 0.22);
    expect(Math.abs(months[5]! - months[4]! - flatOnBonus)).toBeLessThanOrEqual(1);
    expect(months.slice(0, 5)).toEqual(
      monthlyTax(run(steadyJob("a", 100_000), steadyJob("b", 50_000)), 0, 5),
    );
  });

  it("counts the bonus as wages already paid when correcting the months after it", () => {
    const result = run(WITH_BONUS, steadyJob("b", 50_000));
    const months = monthlyTax(result, 0, 12);
    // From July the bonus is part of what the year has actually paid, so the correction covers the
    // gap between its flat 22% and this household's real marginal rate — a bill it would otherwise
    // have carried to April. Still a correction to the REMAINING months, never to the earlier ones.
    expect(months[6]!).toBeGreaterThan(months[4]!);
    expect(Math.abs(sum(months) - annualLiability(result, 0))).toBeLessThan(dollarsToCents(20));
  });
});

describe("multiple concurrent jobs — the following April", () => {
  it("settles the year to its exact liability however the jobs came and went", () => {
    const result = run(steadyJob("a", 100_000), steadyJob("b", 50_000, 6));
    const withheld = sum(monthlyTax(result, 0, 12));
    // THE INVARIANT the whole model rests on: what twelve paycheques withheld, plus what April
    // settles, is the one annual liability on the year's actual income — priced by two genuinely
    // different computations that must nevertheless agree.
    expect(Math.abs(withheld + aprilBalance(result) - annualLiability(result, 0))).toBeLessThanOrEqual(1);
  });

  it("settles a year whose second job was held for three months to its exact liability", () => {
    const result = run(steadyJob("a", 100_000), steadyJob("b", 50_000, 0, 3));
    const withheld = sum(monthlyTax(result, 0, 12));
    expect(Math.abs(withheld + aprilBalance(result) - annualLiability(result, 0))).toBeLessThanOrEqual(1);
  });
});
