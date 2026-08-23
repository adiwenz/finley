/**
 * THE SOCIAL-SECURITY WAGE BASE, applied the way a payroll department applies it — per employer,
 * with no knowledge of the worker's other jobs — end to end through the public `Projection`
 * surface against real US-2026 rules.
 *
 * The behaviour under test is a real feature of US payroll, not a modelling shortcut, and it has
 * one consequence that reads like a bug until it is pinned: a person holding several jobs can have
 * MORE Social Security withheld from their paycheques than they owe for the year, because each
 * employer runs the $184,500 cap over its own wages alone. Nothing corrects that during the year.
 * The over-withholding is a refundable credit (Schedule 3, "excess social security tax withheld")
 * claimed on the return the following April.
 *
 * Every figure below is stated in dollars in the assertion that pins it, so a change to a rate, a
 * cap or the reconciliation shows up here as an arithmetic difference a reader can check by hand.
 *
 * Two fixtures, both paying $300,000 of wages in 2026 and differing only in how many employers pay
 * it. That is the whole experiment: same wages, same income tax, different Social Security.
 */
import { describe, it, expect } from "vitest";
import {
  Projection,
  CURRENT_FORMAT_VERSION,
  dollarsToCents,
  type Job,
  type Plan,
  type ProjectionResult,
} from "@finley/engine";
import {
  usJurisdiction,
  payrollTaxTables,
  OASDI_RATE,
  MEDICARE_RATE,
  ADDITIONAL_MEDICARE_RATE,
  ADDITIONAL_MEDICARE_THRESHOLD_CENTS,
} from "./index";

const START_YEAR = 2026;
const BIRTH_YEAR = START_YEAR - 40;
/**
 * How many months of pay are stated OUTRIGHT. The projection itself runs to life expectancy; past
 * this the jobs keep paying the same salary, with no growth and no inflation to move it, which is
 * what lets the last test read a third year's April off the same run.
 */
const HORIZON_MONTHS = 24;
/** Month 0 is January of `START_YEAR`, so the following April is month 15. */
const APRIL_OF_YEAR_TWO = 15;

/** 2026's cap, pinned here so a reader can do every sum below without leaving the file. */
const WAGE_BASE_DOLLARS = 184_500;
/** 6.2% of the cap: the most Social Security ONE person can actually owe for 2026. */
const ANNUAL_OASDI_MAXIMUM_DOLLARS = 11_439;

/**
 * A job paying `annualDollars` in equal monthly instalments for the whole horizon. Pay is stated
 * month by month rather than left to a salary path, because these tests turn on the cumulative
 * total at each month's boundary and nothing else may move it.
 */
function job(id: string, annualDollars: number): Job {
  return {
    id,
    ownerId: "p1",
    startYear: BIRTH_YEAR + 22,
    endYear: BIRTH_YEAR + 65,
    salary: {
      startingSalaryCents: dollarsToCents(annualDollars),
      currentSalaryCents: dollarsToCents(annualDollars),
      realGrowthPct: 0,
    },
    incomeOverrides: Array.from({ length: HORIZON_MONTHS }, (_, month) => ({
      id: `${id}-pay-${month}`,
      month,
      kind: "setTo" as const,
      cents: dollarsToCents(annualDollars / 12),
    })),
  };
}

/**
 * No expenses, no investment return, no inflation and a balance large enough to never borrow: the
 * only thing moving between the paycheque and the April settlement is tax. Savings interest in
 * particular would put untaxed income into the year and blur the refund these tests measure.
 */
function run(...jobs: readonly Job[]): ProjectionResult {
  const plan: Plan = {
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
      jobs: [...jobs],
    },
  };
  return Projection.fromState(
    {
      scenario: { plan, ledger: { events: [], nextSequenceNumber: 0 } },
      startYear: START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
    },
    usJurisdiction,
  ).run(usJurisdiction);
}

/** ONE employer paying the whole $300,000 — the cap binds mid-year and withholding drops. */
const SOLO = run(job("solo", 300_000));
/** THREE employers paying $100,000 each. No single one reaches the cap; between them they blow past it. */
const SPLIT = run(job("a", 100_000), job("b", 100_000), job("c", 100_000));

/** FICA withheld from every paycheque this month, all jobs together. */
const ficaIn = (result: ProjectionResult, month: number): number =>
  result.series.months[month]?.flows?.payrollTaxCents ?? 0;

/** FICA withheld this month against one named job — `payrollTaxBySourceCents` keys `job:<id>`. */
const ficaForJob = (result: ProjectionResult, month: number, id: string): number =>
  result.series.months[month]?.flows?.payrollTaxBySourceCents?.[`job:${id}`] ?? 0;

const ficaOverYear = (result: ProjectionResult, year: number): number[] =>
  Array.from({ length: 12 }, (_, i) => ficaIn(result, year * 12 + i));

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** The signed balance the prior tax year settled at — positive owed, negative refunded. */
const settlementIn = (result: ProjectionResult, month: number): number =>
  result.series.months[month]?.flows?.taxSettlementCents ?? 0;

/**
 * Medicare is uncapped, so it is the constant part of every month's FICA and subtracting it
 * isolates the part that stops. $300,000/12 × 1.45% = $362.50 a month, in every month of the year.
 */
const MONTHLY_MEDICARE_DOLLARS = (300_000 / 12) * MEDICARE_RATE;

describe("one job over the wage base — Social Security stops, Medicare does not", () => {
  it("pins the 2026 cap and the maximum one person can owe against it", () => {
    expect(payrollTaxTables(2026).oasdiWageBaseCents).toBe(dollarsToCents(WAGE_BASE_DOLLARS));
    expect(Math.round(dollarsToCents(WAGE_BASE_DOLLARS) * OASDI_RATE)).toBe(
      dollarsToCents(ANNUAL_OASDI_MAXIMUM_DOLLARS),
    );
  });

  it("withholds the full 7.65% until the month cumulative pay reaches the cap", () => {
    // $25,000/mo, so cumulative pay is $175,000 after seven months — still under $184,500.
    // Each of those months: 6.2% + 1.45% of $25,000 = $1,550.00 + $362.50 = $1,912.50.
    for (const month of [0, 1, 2, 3, 4, 5, 6]) {
      expect(ficaIn(SOLO, month)).toBe(dollarsToCents(1_912.5));
    }
  });

  it("withholds Social Security on only the sliver of the crossing month that is under the cap", () => {
    // Month 7 takes cumulative pay from $175,000 to $200,000, of which only $9,500 is below the
    // cap: 6.2% × $9,500 = $589.00, plus the month's uncapped $362.50 of Medicare.
    expect(ficaIn(SOLO, 7)).toBe(dollarsToCents(589 + MONTHLY_MEDICARE_DOLLARS));
  });

  it("stops Social Security for the rest of the year while Medicare keeps running", () => {
    // Months 8-11 are past the cap. What is left is Medicare's $362.50 plus the 0.9% Additional
    // Medicare surtax, which by then applies: cumulative pay is over $200,000, so the surtax runs
    // on the whole $25,000 of each remaining month — 0.9% × $25,000 = $225.00.
    for (const month of [8, 9, 10, 11]) {
      expect(ficaIn(SOLO, month)).toBe(dollarsToCents(MONTHLY_MEDICARE_DOLLARS + 225));
    }
    // Medicare alone never stops: every month of the year carries at least its $362.50.
    for (let month = 0; month < 12; month++) {
      expect(ficaIn(SOLO, month)).toBeGreaterThanOrEqual(dollarsToCents(MONTHLY_MEDICARE_DOLLARS));
    }
  });

  it("withholds exactly the annual maximum of Social Security and not a cent more", () => {
    // $16,689.00 of FICA for the year = $11,439.00 OASDI + $4,350.00 Medicare + $900.00 surtax.
    const medicareDollars = 300_000 * MEDICARE_RATE;
    const surtaxDollars = (300_000 - 200_000) * ADDITIONAL_MEDICARE_RATE;
    expect(sum(ficaOverYear(SOLO, 0))).toBe(dollarsToCents(16_689));
    expect(dollarsToCents(ANNUAL_OASDI_MAXIMUM_DOLLARS + medicareDollars + surtaxDollars)).toBe(
      dollarsToCents(16_689),
    );
  });

  it("has nothing to reconcile in April, because one employer saw the whole picture", () => {
    // A cent of income-tax rounding is the entire settlement; the payroll side contributes zero.
    expect(Math.abs(settlementIn(SOLO, APRIL_OF_YEAR_TWO))).toBeLessThan(dollarsToCents(1));
  });

  it("resets the cap in the new tax year, at the newly indexed figure", () => {
    // The wage base is wage-indexed, so 2027 opens at $191,100 — and January withholds in full again.
    expect(payrollTaxTables(2027).oasdiWageBaseCents).toBe(dollarsToCents(191_100));
    expect(ficaIn(SOLO, 12)).toBe(dollarsToCents(1_912.5));
  });
});

describe("three jobs under the wage base — each employer applies the cap independently", () => {
  it("withholds 6.2% on every dollar all year, because no single job comes near the cap", () => {
    // $100,000 a year each, so each job's cumulative wages end the year at little over half the
    // $184,500 cap and no employer ever stops. Per job per month: 7.65% × $8,333.33 = $637.50.
    for (const id of ["a", "b", "c"]) {
      expect(ficaForJob(SPLIT, 0, id)).toBe(dollarsToCents(637.5));
      expect(ficaForJob(SPLIT, 11, id)).toBe(dollarsToCents(637.5));
    }
    // And so the household's monthly FICA is flat across the whole year — no step down anywhere,
    // which is the visible difference from the single-employer run above.
    const months = ficaOverYear(SPLIT, 0);
    expect(Math.max(...months) - Math.min(...months)).toBeLessThanOrEqual(dollarsToCents(0.1));
    expect(months[0]).toBe(dollarsToCents(1_912.5));
  });

  it("withholds no Additional Medicare surtax at all, though the person owes it", () => {
    // Each employer sees $100,000 — half the $200,000 threshold — and is required to ignore the
    // others. Every month is exactly OASDI + Medicare, with no surtax component anywhere.
    expect(ADDITIONAL_MEDICARE_THRESHOLD_CENTS).toBe(dollarsToCents(200_000));
    const perMonthDollars = (300_000 / 12) * (OASDI_RATE + MEDICARE_RATE);
    expect(ficaIn(SPLIT, 11)).toBe(dollarsToCents(perMonthDollars));
  });

  it("OVER-WITHHOLDS Social Security: $18,600.00 taken against an $11,439.00 maximum", () => {
    // Three employers × 6.2% × $100,000 = $18,600.00, which is $7,161.00 more Social Security than
    // this person can owe for 2026. The same $300,000 through one employer withheld $11,439.00.
    const oasdiWithheldDollars = 3 * 100_000 * OASDI_RATE;
    expect(oasdiWithheldDollars).toBe(18_600);
    expect(oasdiWithheldDollars - ANNUAL_OASDI_MAXIMUM_DOLLARS).toBe(7_161);

    // Read off the run rather than the rate: total FICA less the year's uncapped Medicare.
    const yearFica = sum(ficaOverYear(SPLIT, 0));
    expect(yearFica).toBe(dollarsToCents(22_950));
    expect(yearFica - dollarsToCents(300_000 * MEDICARE_RATE)).toBe(dollarsToCents(18_600));
    expect(yearFica).toBeGreaterThan(sum(ficaOverYear(SOLO, 0)));
  });
});

describe("the April reconciliation — a credit on the return, never a smaller paycheque", () => {
  it("refunds the excess Social Security net of the surtax owed, in the following April", () => {
    // Schedule 3 credit  $7,161.00 back
    // Form 8959 surtax     $900.00 owed   (0.9% × the $100,000 of combined wages over $200,000)
    //                    ─────────────
    // net settlement    −$6,261.00, negative meaning refunded.
    expect(settlementIn(SPLIT, APRIL_OF_YEAR_TWO)).toBe(-dollarsToCents(6_261));

    const surtaxDollars = (300_000 - 200_000) * ADDITIONAL_MEDICARE_RATE;
    expect(surtaxDollars - 7_161).toBe(-6_261);
  });

  it("settles in April and in no other month", () => {
    for (let month = 0; month < HORIZON_MONTHS; month++) {
      if (month === APRIL_OF_YEAR_TWO) continue;
      expect(Math.abs(settlementIn(SPLIT, month))).toBeLessThan(dollarsToCents(1));
    }
  });

  it("pays the refund as CASH IN, not as a reduction of that month's withholding", () => {
    // April's own FICA is the ordinary $1,912.50, identical to every month around it: the refund
    // did not reach back and re-withhold a paycheque already paid.
    expect(ficaIn(SPLIT, APRIL_OF_YEAR_TWO)).toBe(ficaIn(SPLIT, APRIL_OF_YEAR_TWO - 1));
    expect(ficaIn(SPLIT, APRIL_OF_YEAR_TWO)).toBe(dollarsToCents(1_912.5));

    // It arrives instead as a negative income-tax charge for the month — cash coming in.
    const april = SPLIT.series.months[APRIL_OF_YEAR_TWO]?.flows;
    expect(april?.taxCents).toBeLessThan(0);
    expect((april?.taxCents ?? 0) - settlementIn(SPLIT, APRIL_OF_YEAR_TWO)).toBe(
      SPLIT.series.months[APRIL_OF_YEAR_TWO - 1]?.flows?.taxCents,
    );
  });

  it("leaves every paycheque of the over-withheld year exactly as it was withheld", () => {
    // The whole point of the reconciliation being a filing step: no month of 2026 knows about it.
    // Each of the twelve is the same $1,912.50 the employers took at the time.
    for (const month of ficaOverYear(SPLIT, 0)) {
      expect(Math.abs(month - dollarsToCents(1_912.5))).toBeLessThanOrEqual(dollarsToCents(0.1));
    }
  });

  it("keeps over-withholding the NEXT year too — the cap is per employer every year", () => {
    // Nothing learns from the refund, exactly as in life: 2027 withholds the same $18,600.00 of
    // Social Security, and the credit merely shrinks because the cap indexed up to $191,100.
    //   withheld          $18,600.00
    //   maximum owed      $11,848.20   = 6.2% x $191,100
    //   credit             $6,751.80
    //   surtax owed          $900.00
    //   net settlement    -$5,851.80
    expect(sum(ficaOverYear(SPLIT, 1))).toBe(dollarsToCents(22_950));
    expect(Math.round(dollarsToCents(191_100) * OASDI_RATE)).toBe(dollarsToCents(11_848.2));
    expect(settlementIn(SPLIT, APRIL_OF_YEAR_TWO + 12)).toBe(-dollarsToCents(5_851.8));
  });
});
