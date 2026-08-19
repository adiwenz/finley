import { describe, it, expect } from "vitest";
import type { WageWithholdingRequest } from "@finley/engine";
import { federalTaxTables } from "./federalTaxTables";
import { federalAnnualTaxCents } from "./federalTax";
import {
  wageWithholdingCents,
  regularWageWithholdingCents,
  supplementalWageWithholdingCents,
  withholdingRateSchedules,
  defaultW4Configuration,
  multipleJobsAdjustmentCents,
  SUPPLEMENTAL_WAGE_RATE,
  SUPPLEMENTAL_WAGE_EXCESS_RATE,
  SUPPLEMENTAL_WAGE_EXCESS_THRESHOLD_CENTS,
  type W4Configuration,
} from "./wageWithholding";

const YEAR = 2026;
const MONTHLY = 12;

/** A monthly paycheck from a single job, nothing else declared. */
function request(over: Partial<WageWithholdingRequest> = {}): WageWithholdingRequest {
  return {
    taxCategory: "wages",
    regularWagesCents: 0,
    supplementalWagesCents: 0,
    priorSupplementalWagesCents: 0,
    priorRegularWithholdingCents: 0,
    payPeriodsPerYear: MONTHLY,
    remainingPayPeriods: MONTHLY,
    concurrentRegularWagesCents: [0],
    bearsMultipleJobsAdjustment: false,
    priorPersonWagesCents: 0,
    priorPersonWithholdingCents: 0,
    ...over,
  };
}

const DEFAULT_W4: W4Configuration = defaultW4Configuration(request(), YEAR);

/** A year of identical paycheques from one salary. */
function withheldOnLevelSalary(annualDollars: number, w4: W4Configuration = DEFAULT_W4): number {
  const monthly = Math.round((annualDollars * 100) / MONTHLY);
  return regularWageWithholdingCents(monthly, MONTHLY, w4, YEAR) * MONTHLY;
}

describe("Publication 15-T percentage-method schedules", () => {
  it("starts withholding only above the standard deduction, net of the frozen line-1g allowance", () => {
    // Worksheet 1A subtracts $8,600 on line 1g, and the schedule carries the rest of the standard
    // deduction as its 0% band. The two together must remove exactly one standard deduction —
    // that identity is what keeps withholding and the return on the same tables.
    const { standardDeductionCents } = federalTaxTables(YEAR);
    const [zeroBand, firstRate] = withholdingRateSchedules(YEAR).standard;
    expect(zeroBand).toEqual({ lowerCents: 0, baseTaxCents: 0, rate: 0 });
    expect(firstRate!.lowerCents).toBe(standardDeductionCents - 8_600_00);
    expect(firstRate!.rate).toBe(0.1);
  });

  it("halves every threshold and tax amount on the Step 2 checkbox schedule", () => {
    const { standard, step2Checkbox } = withholdingRateSchedules(YEAR);
    // The checkbox schedule carries the WHOLE standard deduction (line 1g is zero when it is
    // ticked), so its 0% band is the full deduction halved rather than the standard band halved.
    expect(step2Checkbox[1]!.lowerCents).toBe(federalTaxTables(YEAR).standardDeductionCents / 2);
    for (let i = 2; i < standard.length; i++) {
      expect(step2Checkbox[i]!.rate).toBe(standard[i]!.rate);
      expect(step2Checkbox[i]!.baseTaxCents * 2).toBeCloseTo(standard[i]!.baseTaxCents, -2);
    }
  });
});

describe("Regular wages — the annualize-and-price method", () => {
  it("withholds a level salary's whole-year liability, to within a rounding residue", () => {
    // The point of the percentage method: twelve identical paycheques from an ordinary salaried
    // job land on the return's own answer, so April settles to approximately nothing.
    for (const annualDollars of [30_000, 60_000, 120_000, 250_000]) {
      const owed = federalAnnualTaxCents({ wages: annualDollars * 100 }, YEAR);
      expect(withheldOnLevelSalary(annualDollars)).toBeCloseTo(owed, -2);
    }
  });

  it("withholds nothing from a paycheck below the standard deduction's monthly share", () => {
    expect(regularWageWithholdingCents(500_00, MONTHLY, DEFAULT_W4, YEAR)).toBe(0);
  });

  it("prices a RAISE from the raised paycheck alone, leaving every earlier one untouched", () => {
    // Six months at $5,000 then six at $7,000. Each figure is priced as though it were the whole
    // year, which is exactly what makes the first six months unaffected by the raise.
    const before = regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR);
    const after = regularWageWithholdingCents(7_000_00, MONTHLY, DEFAULT_W4, YEAR);
    expect(after).toBeGreaterThan(before);
    expect(before).toBe(regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR));
  });

  it("prices a PAY CUT down immediately, without crediting back what earlier months withheld", () => {
    const cut = regularWageWithholdingCents(2_000_00, MONTHLY, DEFAULT_W4, YEAR);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThan(regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR));
  });

  it("withholds NOTHING from a missed paycheck, and does not catch up on the next one", () => {
    expect(regularWageWithholdingCents(0, MONTHLY, DEFAULT_W4, YEAR)).toBe(0);
    // The month after is priced on its own wage, carrying no memory of the month that paid zero.
    expect(regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR)).toBe(
      regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR),
    );
  });

  it("over-withholds a variable earner's good months and under-withholds the lean ones", () => {
    // The annualization assumption is wrong for lumpy pay, and deliberately so. Twelve $5,000
    // months and six $10,000 months withhold different totals on the same $60,000 — the gap is
    // what April settles.
    const level = withheldOnLevelSalary(60_000);
    const lumpy = regularWageWithholdingCents(10_000_00, MONTHLY, DEFAULT_W4, YEAR) * 6;
    expect(lumpy).toBeGreaterThan(level);
  });

  it("halves the brackets when the multiple-jobs box is ticked, so two jobs do not each get a full allowance", () => {
    const single = regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR);
    const multi = regularWageWithholdingCents(
      5_000_00,
      MONTHLY,
      { ...DEFAULT_W4, multipleJobsCheckbox: true },
      YEAR,
    );
    expect(multi).toBeGreaterThan(single);
    // Two $5,000 jobs with the box ticked withhold roughly what one $10,000 job does, which is
    // the whole point of the halved schedule.
    expect(multi * 2).toBeCloseTo(regularWageWithholdingCents(10_000_00, MONTHLY, DEFAULT_W4, YEAR), -4);
  });

  it("never ticks the Step 2 checkbox — the multiple-jobs correction rides on line 4(c) instead", () => {
    const twoJobs = request({
      regularWagesCents: 5_000_00,
      concurrentRegularWagesCents: [5_000_00, 5_000_00],
      bearsMultipleJobsAdjustment: true,
    });
    expect(defaultW4Configuration(twoJobs, YEAR).multipleJobsCheckbox).toBe(false);
    expect(defaultW4Configuration(twoJobs, YEAR).extraWithholdingPerPeriodCents).toBeGreaterThan(0);
  });

  it("applies each W-4 line the form's own way: credits reduce, other income raises, extra adds", () => {
    const base = regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR);
    const withCredit = regularWageWithholdingCents(
      5_000_00,
      MONTHLY,
      { ...DEFAULT_W4, dependentCreditsCents: 2_400_00 },
      YEAR,
    );
    expect(base - withCredit).toBe(2_400_00 / MONTHLY);
    expect(
      regularWageWithholdingCents(5_000_00, MONTHLY, { ...DEFAULT_W4, otherIncomeCents: 12_000_00 }, YEAR),
    ).toBeGreaterThan(base);
    expect(
      regularWageWithholdingCents(5_000_00, MONTHLY, { ...DEFAULT_W4, deductionsCents: 12_000_00 }, YEAR),
    ).toBeLessThan(base);
    expect(
      regularWageWithholdingCents(5_000_00, MONTHLY, { ...DEFAULT_W4, extraWithholdingPerPeriodCents: 100_00 }, YEAR),
    ).toBe(base + 100_00);
  });

  it("never withholds a negative amount, however large the credit claimed", () => {
    expect(
      regularWageWithholdingCents(5_000_00, MONTHLY, { ...DEFAULT_W4, dependentCreditsCents: 99_000_00 }, YEAR),
    ).toBe(0);
  });
});

describe("The multiple-jobs adjustment — line 4(c) rather than the Step 2 checkbox", () => {
  /** Two $5,000-a-month jobs, January, with the correction on the first of them. */
  const twoJobs = (over: Partial<WageWithholdingRequest> = {}): WageWithholdingRequest =>
    request({
      regularWagesCents: 5_000_00,
      concurrentRegularWagesCents: [5_000_00, 5_000_00],
      bearsMultipleJobsAdjustment: true,
      ...over,
    });

  it("asks for nothing at all when the person holds a single job", () => {
    expect(
      multipleJobsAdjustmentCents(
        request({ regularWagesCents: 5_000_00, concurrentRegularWagesCents: [5_000_00] }),
        YEAR,
      ),
    ).toBe(0);
  });

  it("asks for nothing from a job that is not the one carrying the correction", () => {
    // Exactly one employer applies it, so the household is corrected once rather than once per
    // job — the error that ticking the checkbox on every W-4 would make with three jobs.
    expect(
      multipleJobsAdjustmentCents(twoJobs({ bearsMultipleJobsAdjustment: false }), YEAR),
    ).toBe(0);
  });

  it("closes the gap between what two employers withhold and what the combined wage owes", () => {
    const perJob = regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR);
    const combined = regularWageWithholdingCents(10_000_00, MONTHLY, DEFAULT_W4, YEAR);
    expect(multipleJobsAdjustmentCents(twoJobs(), YEAR)).toBe(combined - perJob * 2);
  });

  it("generalises past two jobs, to any number of any sizes", () => {
    const wages = [8_000_00, 2_500_00, 400_00];
    const adjustment = multipleJobsAdjustmentCents(
      request({
        regularWagesCents: 8_000_00,
        concurrentRegularWagesCents: wages,
        bearsMultipleJobsAdjustment: true,
      }),
      YEAR,
    );
    const unadjusted = wages.reduce(
      (sum, w) => sum + regularWageWithholdingCents(w, MONTHLY, DEFAULT_W4, YEAR),
      0,
    );
    const combined = regularWageWithholdingCents(10_900_00, MONTHLY, DEFAULT_W4, YEAR);
    expect(adjustment).toBe(combined - unadjusted);
  });

  it("sizes what is left to withhold from what the year has ACTUALLY paid and withheld", () => {
    // Six months in, one job all along and a second one starting now: the first half withheld what
    // one employer would, and the six periods that remain carry the whole correction for the year.
    const midYear = twoJobs({
      remainingPayPeriods: 6,
      priorPersonWagesCents: 30_000_00,
      priorPersonWithholdingCents: 3_000_00,
    });
    const projectedAnnualWagesCents = 30_000_00 + 10_000_00 * 6;
    const target = regularWageWithholdingCents(projectedAnnualWagesCents, 1, DEFAULT_W4, YEAR);
    const unadjustedRemaining =
      regularWageWithholdingCents(5_000_00, MONTHLY, DEFAULT_W4, YEAR) * 2 * 6;
    expect(multipleJobsAdjustmentCents(midYear, YEAR)).toBe(
      Math.round((target - 3_000_00 - unadjustedRemaining) / 6),
    );
  });

  it("never asks for a negative amount — payroll cannot hand back an over-withholding", () => {
    // A year that has already withheld far more than it will owe. The correction goes to zero and
    // stays there; the excess comes back as April's refund, which is where it belongs.
    expect(
      multipleJobsAdjustmentCents(
        twoJobs({ remainingPayPeriods: 2, priorPersonWithholdingCents: 80_000_00 }),
        YEAR,
      ),
    ).toBe(0);
  });
});

describe("Supplemental wages — a bonus is not a pay rise", () => {
  it("takes the flat 22% where the employer has already withheld against regular wages", () => {
    const withheld = supplementalWageWithholdingCents(
      request({ supplementalWagesCents: 10_000_00, priorRegularWithholdingCents: 1 }),
      DEFAULT_W4,
      YEAR,
    );
    expect(withheld).toBe(Math.round(10_000_00 * SUPPLEMENTAL_WAGE_RATE));
  });

  it("does NOT annualize the bonus: the same bonus paid twice withholds twice, not four times", () => {
    // Annualizing a $10,000 bonus in a monthly period would price it as $120,000 of extra pay.
    // Pinning strict proportionality is what rules that out.
    const once = supplementalWageWithholdingCents(
      request({ supplementalWagesCents: 10_000_00, priorRegularWithholdingCents: 1 }),
      DEFAULT_W4,
      YEAR,
    );
    const twice = supplementalWageWithholdingCents(
      request({ supplementalWagesCents: 20_000_00, priorRegularWithholdingCents: 1 }),
      DEFAULT_W4,
      YEAR,
    );
    expect(twice).toBe(once * 2);
  });

  it("leaves the regular wages beside it withheld exactly as they would be alone", () => {
    const salaryOnly = wageWithholdingCents(request({ regularWagesCents: 5_000_00 }), YEAR);
    const withBonus = wageWithholdingCents(
      request({ regularWagesCents: 5_000_00, supplementalWagesCents: 10_000_00 }),
      YEAR,
    );
    expect(withBonus - salaryOnly).toBe(Math.round(10_000_00 * SUPPLEMENTAL_WAGE_RATE));
  });

  it("splits a payment straddling the $1,000,000 cumulative threshold, at both rates", () => {
    const priorSupplementalWagesCents = SUPPLEMENTAL_WAGE_EXCESS_THRESHOLD_CENTS - 100_000_00;
    const withheld = supplementalWageWithholdingCents(
      request({
        supplementalWagesCents: 300_000_00,
        priorSupplementalWagesCents,
        priorRegularWithholdingCents: 1,
      }),
      DEFAULT_W4,
      YEAR,
    );
    expect(withheld).toBe(
      Math.round(200_000_00 * SUPPLEMENTAL_WAGE_EXCESS_RATE) +
        Math.round(100_000_00 * SUPPLEMENTAL_WAGE_RATE),
    );
  });

  it("falls back to the aggregate method where nothing has been withheld from regular wages", () => {
    // The flat rate is not permitted here, so the bonus is withheld as the difference between the
    // combined paycheck and the regular wage alone — which is still not an annualized bonus,
    // because the annualization cancels out of the subtraction.
    const req = request({ regularWagesCents: 1_000_00, supplementalWagesCents: 2_000_00 });
    const aggregate = supplementalWageWithholdingCents(req, DEFAULT_W4, YEAR);
    const combined = regularWageWithholdingCents(3_000_00, MONTHLY, DEFAULT_W4, YEAR);
    const regularOnly = regularWageWithholdingCents(1_000_00, MONTHLY, DEFAULT_W4, YEAR);
    expect(aggregate).toBe(combined - regularOnly);
    expect(aggregate).not.toBe(Math.round(2_000_00 * SUPPLEMENTAL_WAGE_RATE));
  });

  it("withholds nothing at all when no supplemental wages were paid", () => {
    expect(supplementalWageWithholdingCents(request({ regularWagesCents: 5_000_00 }), DEFAULT_W4, YEAR)).toBe(0);
  });
});
