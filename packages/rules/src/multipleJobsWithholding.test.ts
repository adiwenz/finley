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

/**
 * The same household with a PARTNER alongside the primary, each holding their own jobs.
 *
 * Finley files no joint return: every person is an independent tax unit, so a partner exists in
 * these tests only to prove that they are NOT coordinated with. The partnering is dated well
 * before month 0 so both people are simply present for the whole horizon.
 */
function runHousehold(
  primarySpecs: readonly JobSpec[],
  partnerSpecs: readonly JobSpec[],
): ProjectionResult {
  const projection = Projection.fromState(
    {
      scenario: {
        plan: planWith(...primarySpecs),
        ledger: { events: [], nextSequenceNumber: 0 },
      },
      startYear: START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
    },
    usJurisdiction,
  );
  projection.startPartnered({
    partneredForMonths: 120,
    name: "Partner",
    birthYear: BIRTH_YEAR,
    lifeExpectancy: 85,
    jobs: partnerSpecs.map((spec) => {
      // The partner's jobs are minted with ids of the engine's choosing, so the fixture's own id
      // is dropped here — which is also why the readers below identify a person by what is NOT
      // theirs rather than by naming their sources.
      const { id: _id, ownerId: _ownerId, ...job } = toJob(spec);
      return job;
    }),
  });
  return projection.run(usJurisdiction);
}

/** Income tax charged this month against the named jobs alone — `taxBySourceCents` keys `job:<id>`. */
const taxForJobs = (result: ProjectionResult, month: number, ids: readonly string[]): number =>
  ids.reduce(
    (total, id) => total + (result.series.months[month]?.flows?.taxBySourceCents?.[`job:${id}`] ?? 0),
    0,
  );

/** The same, for FICA. */
const payrollForJobs = (result: ProjectionResult, month: number, ids: readonly string[]): number =>
  ids.reduce(
    (total, id) =>
      total + (result.series.months[month]?.flows?.payrollTaxBySourceCents?.[`job:${id}`] ?? 0),
    0,
  );

/**
 * The PRIMARY's twelve months of income tax, and everyone else's. The primary's jobs are the only
 * ones this file names, so "everyone else" is the household total less those — which is exactly
 * the partner, and stays right however many jobs the partner is given.
 */
const primaryTax = (result: ProjectionResult, ids: readonly string[]): number[] =>
  Array.from({ length: 12 }, (_, month) => taxForJobs(result, month, ids));
const partnerTax = (result: ProjectionResult, primaryIds: readonly string[]): number[] =>
  Array.from({ length: 12 }, (_, month) => taxIn(result, month) - taxForJobs(result, month, primaryIds));

/** This month's pre-tax, pre-deferral wages for one person, as the run itself banded them. */
const wagesOf = (result: ProjectionResult, month: number, personId: string): number =>
  result.series.months[month]?.flows?.wagesByOwner?.[personId]?.grossCents ?? 0;

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

describe("multiple concurrent jobs — a bonus is withheld once and never again", () => {
  /**
   * A bonus is withheld for by the flat supplemental method at the moment it is paid, and then it
   * is DONE. It never enters the regular-wage basis the multiple-jobs correction is measured from,
   * because a one-off payment is not a rate of pay: reading one as a raise would have every
   * remaining paycheque of the year withhold more, which is precisely the error the separate
   * supplemental method exists to prevent. Whatever the flat 22% got wrong is a matter for the
   * annual liability and the April that settles it.
   */
  const BASE = [steadyJob("a", 100_000), steadyJob("b", 50_000)] as const;
  const BONUS_DOLLARS = 20_000;
  const flatOn = (dollars: number): number => Math.round(dollarsToCents(dollars) * 0.22);

  /** The bigger job, paying the same salary as `BASE`'s but with a bonus in each month given. */
  const bonusIn = (...bonusMonths: readonly number[]): JobSpec => ({
    id: "a",
    monthlyDollars: () => 100_000 / 12,
    bonusDollars: (month) => (bonusMonths.includes(month) ? BONUS_DOLLARS : 0),
  });

  it("withholds a June bonus at the flat supplemental rate", () => {
    const months = monthlyTax(run(bonusIn(5), steadyJob("b", 50_000)), 0, 12);
    const baseline = monthlyTax(run(...BASE), 0, 12);
    // June is its ordinary paycheque plus 22% of the bonus, and nothing else.
    expect(Math.abs(months[5]! - baseline[5]! - flatOn(BONUS_DOLLARS))).toBeLessThanOrEqual(1);
  });

  it("leaves July through December withholding exactly what they would have without the bonus", () => {
    const months = monthlyTax(run(bonusIn(5), steadyJob("b", 50_000)), 0, 12);
    const baseline = monthlyTax(run(...BASE), 0, 12);
    // THE POINT OF THIS FILE'S SECOND HALF: identical, to the cent, in both directions — the
    // bonus neither raises the rest of the year's regular withholding nor lowers it. Only June
    // differs at all.
    expect(months.slice(6, 12)).toEqual(baseline.slice(6, 12));
    expect(months.slice(0, 5)).toEqual(baseline.slice(0, 5));
  });

  it("still counts the bonus in the year's taxable income and its liability", () => {
    const withBonus = run(bonusIn(5), steadyJob("b", 50_000));
    const without = run(...BASE);
    // Not withholding for it later is a payroll question; the bonus is ordinary wage income to
    // the authoritative annual calculation, which is where it has to land.
    expect(actualAnnualBase(withBonus, 0).wages).toBe(
      (actualAnnualBase(without, 0).wages ?? 0) + dollarsToCents(BONUS_DOLLARS),
    );
    expect(annualLiability(withBonus, 0)).toBeGreaterThan(annualLiability(without, 0));
  });

  it("settles the gap between the flat 22% and the bonus's real marginal tax in April", () => {
    const withBonus = run(bonusIn(5), steadyJob("b", 50_000));
    const without = run(...BASE);
    const extraLiability = annualLiability(withBonus, 0) - annualLiability(without, 0);
    // The bonus's real tax exceeds the 22% taken from it, and the whole of that shortfall — not a
    // cent of it withheld in the meantime — turns up in the following April's balance.
    expect(extraLiability).toBeGreaterThan(flatOn(BONUS_DOLLARS));
    expect(
      Math.abs(aprilBalance(withBonus) - aprilBalance(without) - (extraLiability - flatOn(BONUS_DOLLARS))),
    ).toBeLessThanOrEqual(1);
    // And the year still adds up: twelve paycheques plus that balance are the annual liability.
    const withheld = sum(monthlyTax(withBonus, 0, 12));
    expect(
      Math.abs(withheld + aprilBalance(withBonus) - annualLiability(withBonus, 0)),
    ).toBeLessThanOrEqual(1);
  });

  it("keeps three bonuses out of the regular-wage basis, not just one", () => {
    const months = monthlyTax(run(bonusIn(1, 5, 10), steadyJob("b", 50_000)), 0, 12);
    const baseline = monthlyTax(run(...BASE), 0, 12);
    for (const month of [1, 5, 10]) {
      expect(Math.abs(months[month]! - baseline[month]! - flatOn(BONUS_DOLLARS))).toBeLessThanOrEqual(1);
    }
    // Every other month is untouched — bonuses do not accumulate into the basis, so the third one
    // is no more contaminating than the first.
    for (const month of [0, 2, 3, 4, 6, 7, 8, 9, 11]) {
      expect(months[month]!, `month ${month}`).toBe(baseline[month]!);
    }
  });

  it("still corrects for a job that starts, and for a raise, while bonuses are being paid", () => {
    const raisedWithBonus: JobSpec = {
      id: "a",
      monthlyDollars: (month) => (month < 9 ? 100_000 / 12 : 150_000 / 12),
      bonusDollars: (month) => (month === 1 ? BONUS_DOLLARS : 0),
    };
    const months = monthlyTax(run(raisedWithBonus, steadyJob("b", 50_000, 6)), 0, 12);
    const baseline = monthlyTax(
      run(
        { id: "a", monthlyDollars: (month) => (month < 9 ? 100_000 / 12 : 150_000 / 12) },
        steadyJob("b", 50_000, 6),
      ),
      0,
      12,
    );
    // The bonus month aside, a bonus-laden year withholds exactly what the same year without
    // bonuses does — while the job starting in July and the raise in October each still move the
    // months from their own month onward.
    expect(months.filter((_, month) => month !== 1)).toEqual(
      baseline.filter((_, month) => month !== 1),
    );
    expect(months[6]!).toBeGreaterThan(months[5]!);
    expect(months[9]!).toBeGreaterThan(months[8]!);
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

describe("multiple jobs are scoped to ONE person — Finley files no joint return", () => {
  /**
   * Every person is an independent tax unit in this model, so the multiple-jobs correction
   * coordinates a person's OWN jobs and stops there. These are the tests that would fail if it
   * ever reached across the household — which, under joint filing, is a thing it would have to
   * do, and is a change this file would have to be rewritten for rather than extended.
   */
  const PRIMARY_IDS = ["a"] as const;
  const PRIMARY = steadyJob("a", 100_000);
  const PARTNER_MAIN = steadyJob("p", 90_000);

  it("adjusts the partner's withholding when their second job starts, and not the primary's", () => {
    const before = runHousehold([PRIMARY], [PARTNER_MAIN]);
    const after = runHousehold([PRIMARY], [PARTNER_MAIN, steadyJob("q", 40_000, 6)]);
    // The primary's employer withholds the same twelve figures either way: nothing about the
    // person beside them is any of its business, or any of their own W-4's.
    expect(primaryTax(after, PRIMARY_IDS)).toEqual(primaryTax(before, PRIMARY_IDS));
    // The partner's does move, from July and never before it.
    const partnerBefore = partnerTax(before, PRIMARY_IDS);
    const partnerAfter = partnerTax(after, PRIMARY_IDS);
    expect(partnerAfter.slice(0, 6)).toEqual(partnerBefore.slice(0, 6));
    expect(partnerAfter[6]!).toBeGreaterThan(partnerBefore[6]!);
  });

  it("leaves the primary's wages, withholding and FICA alone when a partner's job ends", () => {
    const ends = runHousehold([PRIMARY], [PARTNER_MAIN, steadyJob("q", 40_000, 0, 6)]);
    const continues = runHousehold([PRIMARY], [PARTNER_MAIN, steadyJob("q", 40_000)]);
    for (let month = 0; month < 12; month++) {
      expect(wagesOf(ends, month, "p1"), `wages ${month}`).toBe(wagesOf(continues, month, "p1"));
      expect(taxForJobs(ends, month, PRIMARY_IDS), `tax ${month}`).toBe(
        taxForJobs(continues, month, PRIMARY_IDS),
      );
      expect(payrollForJobs(ends, month, PRIMARY_IDS), `FICA ${month}`).toBe(
        payrollForJobs(continues, month, PRIMARY_IDS),
      );
    }
    // The partner's own correction does stop the month their second job does.
    const partner = partnerTax(ends, PRIMARY_IDS);
    expect(partner[6]!).toBeLessThan(partner[5]!);
  });

  it("corrects a partner's two jobs exactly as it corrects the primary's", () => {
    const asPrimary = run(steadyJob("a", 100_000), steadyJob("b", 50_000));
    const asPartner = runHousehold([], [steadyJob("a", 100_000), steadyJob("b", 50_000)]);
    // The same two jobs, moved from one person to the other, withhold the same twelve figures —
    // the algorithm is about a person, not about which person happens to be the primary.
    expect(monthlyTax(asPartner, 0, 12)).toEqual(monthlyTax(asPrimary, 0, 12));
  });
});

describe("a job ending — the paycheque simply stops", () => {
  it("withholds nothing at all, of either kind, once the only job has ended", () => {
    const result = run(steadyJob("a", 120_000, 0, 6));
    for (let month = 0; month < 6; month++) expect(taxIn(result, month)).toBeGreaterThan(0);
    for (let month = 6; month < 12; month++) {
      expect(wagesOf(result, month, "p1"), `wages ${month}`).toBe(0);
      expect(taxIn(result, month), `withholding ${month}`).toBe(0);
      expect(result.series.months[month]?.flows?.payrollTaxCents ?? 0, `FICA ${month}`).toBe(0);
    }
    // Six months were withheld against as though the salary would run all year, so the year is
    // ahead of its liability. That money comes back as a refund the following April — never as a
    // negative paycheque, which payroll has no way to issue.
    const withheld = sum(monthlyTax(result, 0, 12));
    expect(withheld).toBeGreaterThan(annualLiability(result, 0));
    expect(aprilBalance(result)).toBeLessThan(0);
    for (const tax of monthlyTax(result, 0, 12)) expect(tax).toBeGreaterThanOrEqual(0);
  });

  it("books nothing further against the job that ended while the other keeps paying", () => {
    const result = run(steadyJob("a", 100_000), steadyJob("b", 50_000, 0, 4));
    for (let month = 4; month < 12; month++) {
      expect(taxForJobs(result, month, ["b"]), `tax ${month}`).toBe(0);
      expect(payrollForJobs(result, month, ["b"]), `FICA ${month}`).toBe(0);
      expect(taxForJobs(result, month, ["a"]), `the survivor ${month}`).toBeGreaterThan(0);
    }
  });

  it("gives a job starting after another ended its OWN Social Security wage base", () => {
    // A pays the whole $184,500 wage base over six months and stops; B starts in July. B is a
    // different employer and has withheld nothing, so it starts its own base from zero — which is
    // what payroll rules require, and it over-withholds the person on purpose.
    const capped: JobSpec = { id: "a", monthlyDollars: (month) => (month < 6 ? 184_500 / 6 : 0) };
    const result = run(capped, { id: "b", monthlyDollars: (month) => (month >= 6 ? 2_000 : 0) });
    // Within a cent: FICA is charged as the difference between the seam on cumulative wages
    // after this month and before it, so a month's charge is not simply its own wage rounded.
    const fullFica = (dollars: number): number => Math.round(dollarsToCents(dollars) * 0.0765);
    for (let month = 0; month < 6; month++) {
      expect(
        Math.abs(payrollForJobs(result, month, ["a"]) - fullFica(184_500 / 6)),
        `A ${month}`,
      ).toBeLessThanOrEqual(1);
    }
    for (let month = 6; month < 12; month++) {
      // Full 6.2% + 1.45%, not the 1.45% a single payroll covering both jobs would have taken.
      expect(
        Math.abs(payrollForJobs(result, month, ["b"]) - fullFica(2_000)),
        `B ${month}`,
      ).toBeLessThanOrEqual(1);
    }
    // The excess is the employee's to reclaim, and the return is where they reclaim it: the year
    // settles to its income-tax liability LESS the Social Security nobody should have paid.
    const excessSocialSecurityCents = Math.round(dollarsToCents(12_000) * 0.062);
    const withheld = sum(monthlyTax(result, 0, 12));
    expect(
      Math.abs(
        withheld + aprilBalance(result) - (annualLiability(result, 0) - excessSocialSecurityCents),
      ),
    ).toBeLessThanOrEqual(1);
  });
});

describe("a bonus alongside a job mix that is itself changing", () => {
  const BONUS_DOLLARS = 20_000;
  const flatOn = (dollars: number): number => Math.round(dollarsToCents(dollars) * 0.22);
  /** The 100k job, optionally paying bonuses, optionally changing rate in month 6. */
  const jobA = (bonusMonths: readonly number[], laterAnnual = 100_000): JobSpec => ({
    id: "a",
    monthlyDollars: (month) => (month < 6 ? 100_000 : laterAnnual) / 12,
    bonusDollars: (month) => (bonusMonths.includes(month) ? BONUS_DOLLARS : 0),
  });

  it("keeps a June bonus out of the correction a job starting in July triggers", () => {
    const withBonus = run(jobA([5]), steadyJob("b", 50_000, 6));
    const without = run(jobA([]), steadyJob("b", 50_000, 6));
    const months = monthlyTax(withBonus, 0, 12);
    const baseline = monthlyTax(without, 0, 12);
    // June takes its flat 22% and hands nothing on. July moves for the new job and by exactly as
    // much as it would have moved had no bonus ever been paid.
    expect(Math.abs(months[5]! - baseline[5]! - flatOn(BONUS_DOLLARS))).toBeLessThanOrEqual(1);
    expect(months.slice(6, 12)).toEqual(baseline.slice(6, 12));
    expect(baseline[6]!).toBeGreaterThan(baseline[5]!);
  });

  it("keeps a bonus out of the correction a job ENDING triggers", () => {
    const withBonus = run(jobA([3]), steadyJob("b", 50_000, 0, 6));
    const without = run(jobA([]), steadyJob("b", 50_000, 0, 6));
    const months = monthlyTax(withBonus, 0, 12);
    const baseline = monthlyTax(without, 0, 12);
    expect(Math.abs(months[3]! - baseline[3]! - flatOn(BONUS_DOLLARS))).toBeLessThanOrEqual(1);
    expect(months.slice(4, 12)).toEqual(baseline.slice(4, 12));
    // The ending is what moves July, and it moves it DOWN — the correction was for two jobs.
    expect(baseline[6]!).toBeLessThan(baseline[5]!);
  });

  it("keeps three bonuses out of the correction a PAY CUT triggers", () => {
    const withBonuses = run(jobA([1, 4, 9], 60_000), steadyJob("b", 50_000));
    const without = run(jobA([], 60_000), steadyJob("b", 50_000));
    const months = monthlyTax(withBonuses, 0, 12);
    const baseline = monthlyTax(without, 0, 12);
    for (const month of [1, 4, 9]) {
      expect(
        Math.abs(months[month]! - baseline[month]! - flatOn(BONUS_DOLLARS)),
        `bonus month ${month}`,
      ).toBeLessThanOrEqual(1);
    }
    for (const month of [0, 2, 3, 5, 6, 7, 8, 10, 11]) {
      expect(months[month]!, `month ${month}`).toBe(baseline[month]!);
    }
    // The cut is a real change in the rate of pay, so it does what three bonuses could not.
    expect(baseline[6]!).toBeLessThan(baseline[5]!);
  });
});

describe("wages too small to withhold income tax against", () => {
  it("withholds no income tax below the deduction, and full FICA anyway", () => {
    const result = run(steadyJob("a", 8_000));
    for (let month = 0; month < 12; month++) {
      // Annualized, $8,000 does not clear the standard deduction and the frozen line-1g
      // allowance between them, so Publication 15-T asks for nothing — and never for less.
      expect(taxIn(result, month), `withholding ${month}`).toBe(0);
      // FICA is not a graduated tax and has no deduction: it applies from the first dollar.
      // Within a cent, because the charge is a difference of two cumulative figures.
      expect(
        Math.abs(
          (result.series.months[month]?.flows?.payrollTaxCents ?? 0) -
            Math.round(dollarsToCents(8_000 / 12) * 0.0765),
        ),
        `FICA ${month}`,
      ).toBeLessThanOrEqual(1);
    }
    // And the year genuinely owed nothing, so April has nothing to add either.
    expect(annualLiability(result, 0)).toBe(0);
    expect(aprilBalance(result)).toBe(0);
  });
});

describe("the causality invariant, event by event", () => {
  /**
   * THE architectural invariant: an event in month M changes month M and the months after it, and
   * NOTHING before it. Asserted over the household's whole cash position — income, both taxes,
   * spending and the net worth they all roll into — because a withholding that moved would drag
   * the balance sheet with it, and a test on the tax line alone would not see it.
   *
   * The non-wage events (a taxable retirement withdrawal, a one-time spend funded from an
   * account) hold the same property and are pinned in the engine's own `federalIncomeTax` suite,
   * which is where the funding machinery those events run through is exercised.
   */
  const cashFlows = (result: ProjectionResult, months: number): readonly (readonly number[])[] =>
    Array.from({ length: months }, (_, month) => {
      const flows = result.series.months[month]?.flows;
      return [
        flows?.totalIncomeCents ?? 0,
        flows?.taxCents ?? 0,
        flows?.payrollTaxCents ?? 0,
        flows?.expensesCents ?? 0,
        result.series.months[month]?.netWorthNominalCents ?? 0,
      ];
    });

  const A = steadyJob("a", 100_000);
  const at = 6;
  const cases: readonly (readonly [string, readonly JobSpec[], readonly JobSpec[]])[] = [
    ["a second job starts", [A], [A, steadyJob("b", 50_000, at)]],
    ["the second job ends", [A, steadyJob("b", 50_000)], [A, steadyJob("b", 50_000, 0, at)]],
    ["the only job ends", [A], [steadyJob("a", 100_000, 0, at)]],
    [
      "a raise",
      [A],
      [{ id: "a", monthlyDollars: (month) => (month < at ? 100_000 : 150_000) / 12 }],
    ],
    [
      "a pay cut",
      [A],
      [{ id: "a", monthlyDollars: (month) => (month < at ? 100_000 : 60_000) / 12 }],
    ],
    [
      "a bonus",
      [A],
      [{ id: "a", monthlyDollars: () => 100_000 / 12, bonusDollars: (m) => (m === at ? 20_000 : 0) }],
    ],
  ];

  for (const [what, baseline, withEvent] of cases) {
    it(`leaves every month before month ${at} identical when ${what}`, () => {
      expect(cashFlows(run(...withEvent), at)).toEqual(cashFlows(run(...baseline), at));
      // ...and the event really did happen, or the assertion above would be vacuous.
      expect(cashFlows(run(...withEvent), at + 1)).not.toEqual(cashFlows(run(...baseline), at + 1));
    });
  }
});

describe("the year and its April reconcile, whatever the year looked like", () => {
  /**
   * The one identity every scenario in this file has to satisfy: twelve paycheques plus the
   * following April's balance are the annual liability on the year's actual income. Withholding
   * prices it twelve times from single paycheques and the return prices it once from the whole
   * year, and the two have to meet.
   */
  const scenarios: readonly (readonly [string, readonly JobSpec[]])[] = [
    ["a single job", [steadyJob("a", 100_000)]],
    ["two concurrent jobs", [steadyJob("a", 100_000), steadyJob("b", 50_000)]],
    ["a job starting mid-year", [steadyJob("a", 100_000), steadyJob("b", 50_000, 7)]],
    ["a job ending mid-year", [steadyJob("a", 100_000), steadyJob("b", 50_000, 0, 5)]],
    [
      "a bonus",
      [{ id: "a", monthlyDollars: () => 100_000 / 12, bonusDollars: (m) => (m === 5 ? 25_000 : 0) }],
    ],
    [
      "a bonus alongside two jobs",
      [
        { id: "a", monthlyDollars: () => 100_000 / 12, bonusDollars: (m) => (m === 5 ? 25_000 : 0) },
        steadyJob("b", 50_000),
      ],
    ],
    // One employer, so the Social Security cap and the Additional Medicare threshold are both
    // crossed WITHIN a single payroll — nothing for the return to reconcile, and the income-tax
    // identity has to hold across them all the same.
    ["wages crossing the FICA thresholds", [steadyJob("a", 250_000)]],
  ];

  for (const [what, specs] of scenarios) {
    it(`settles a year with ${what} to its exact liability`, () => {
      const result = run(...specs);
      const withheld = sum(monthlyTax(result, 0, 12));
      expect(
        Math.abs(withheld + aprilBalance(result) - annualLiability(result, 0)),
      ).toBeLessThanOrEqual(1);
    });
  }
});
