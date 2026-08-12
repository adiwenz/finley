import { describe, it, expect } from "vitest";
import {
  annualizeYtd,
  targetCumulativeTaxCents,
  ytdIncomeTaxCents,
  ytdIncomeTaxByCategoryCents,
  ytdIncomeTaxWithBreakdownCents,
  FRESH_YTD_TAX_STATE,
  type YtdTaxState,
} from "./incomeTax";

/** A flat 25% ANNUAL tax on ordinaryIncome — the seam's annual-in/annual-out contract. */
const flat25 = (annualByCategory: Partial<Record<string, number>>): number =>
  Math.round((annualByCategory.ordinaryIncome ?? 0) * 0.25);

/** 0% to $50k, 40% above — a progressive bracket, so timing within the year matters. */
const progressive = (annualByCategory: Partial<Record<string, number>>): number =>
  Math.round(Math.max(0, (annualByCategory.ordinaryIncome ?? 0) - 50_000_00) * 0.4);

describe("annualizeYtd — scale a YTD cumulative total to a full-year estimate", () => {
  it("scales the same total down as more months elapse, converging on the true annual figure", () => {
    // $30k earned through 3 months → $120k/yr pace, same as $10k through 1 month.
    expect(annualizeYtd({ ordinaryIncome: 30_000_00 }, 3)).toEqual({ ordinaryIncome: 120_000_00 });
    // Through all 12 months, the estimate IS the actual total — no more extrapolation.
    expect(annualizeYtd({ ordinaryIncome: 120_000_00 }, 12)).toEqual({ ordinaryIncome: 120_000_00 });
  });
});

describe("targetCumulativeTaxCents — the reconciled cumulative tax owed through this month", () => {
  it("matches the naive monthly annualization in month 1 of a fresh year", () => {
    // $10k in month 1 → $120k annualized pace → $30k annual tax → 1/12 owed through month 1.
    const target = targetCumulativeTaxCents(flat25, { ordinaryIncome: 10_000_00 }, 1);
    expect(target).toBe(Math.round(30_000_00 / 12));
  });

  it("reaches exactly the true annual liability once all 12 months are in", () => {
    const target = targetCumulativeTaxCents(flat25, { ordinaryIncome: 120_000_00 }, 12);
    expect(target).toBe(30_000_00);
  });
});

describe("ytdIncomeTaxCents — this month's reconciled charge, given prior YTD state", () => {
  it("charges a steady earner the same amount every month (smooth, matches the naive monthly seam)", () => {
    let state = FRESH_YTD_TAX_STATE;
    const monthlyCharges: number[] = [];
    for (let month = 1; month <= 3; month++) {
      const charge = ytdIncomeTaxCents(flat25, state, month, { ordinaryIncome: 10_000_00 });
      monthlyCharges.push(charge);
      state = {
        taxableByCategory: { ordinaryIncome: (state.taxableByCategory.ordinaryIncome ?? 0) + 10_000_00 },
        taxPaidCents: state.taxPaidCents + charge,
      };
    }
    // $10k/mo × 25% = $2,500/mo, every month — steady income reconciles to a steady charge.
    expect(monthlyCharges).toEqual([2_500_00, 2_500_00, 2_500_00]);
  });

  it("December's CUMULATIVE tax equals the annual liability regardless of a lump vs. an even spread", () => {
    // The whole point of YTD reconciliation: a $120k RMD lump in January and the same $120k spread evenly
    // across the year must both reconcile to the SAME annual liability by December — even
    // though the naive monthly-annualize-×12 approach (Part 1) massively overtaxes the lump
    // (it would charge round(progressive(120_000_00×12)/12) = 46_333_33 in January ALONE).
    const trueAnnualTax = progressive({ ordinaryIncome: 120_000_00 });
    expect(trueAnnualTax).toBe(28_000_00); // 40% of (120k − 50k)

    function totalTaxOverYear(monthlyOrdinaryIncome: readonly number[]): number {
      let state = FRESH_YTD_TAX_STATE;
      let cumulativeCharged = 0;
      monthlyOrdinaryIncome.forEach((monthly, i) => {
        const monthsElapsed = i + 1;
        const charge = ytdIncomeTaxCents(progressive, state, monthsElapsed, { ordinaryIncome: monthly });
        cumulativeCharged += charge;
        state = {
          taxableByCategory: {
            ordinaryIncome: (state.taxableByCategory.ordinaryIncome ?? 0) + monthly,
          },
          taxPaidCents: state.taxPaidCents + charge,
        };
      });
      return cumulativeCharged;
    }

    const lump = [120_000_00, ...Array(11).fill(0)];
    const spread = Array(12).fill(10_000_00);
    expect(totalTaxOverYear(lump)).toBe(trueAnnualTax);
    expect(totalTaxOverYear(spread)).toBe(trueAnnualTax);
  });

  it("starts a new tax year fresh: a January call with no prior state ignores last year entirely", () => {
    // Last year's large YTD/paid state is simply never passed to the new year's call — a
    // fresh FRESH_YTD_TAX_STATE stands in, exactly as it would for a brand-new tax year.
    const januaryCharge = ytdIncomeTaxCents(progressive, FRESH_YTD_TAX_STATE, 1, {
      ordinaryIncome: 10_000_00,
    });
    // $10k → $120k annualized pace → same $28k/yr liability → 1/12 owed through month 1.
    expect(januaryCharge).toBe(Math.round(28_000_00 / 12));
  });
});

describe("ytdIncomeTaxWithBreakdownCents — scalar + breakdown together, one seam call each", () => {
  it("matches ytdIncomeTaxCents/ytdIncomeTaxByCategoryCents exactly, calling each seam once", () => {
    const mixedScalar = (a: Partial<Record<string, number>>): number =>
      Math.round((a.wages ?? 0) * 0.2) + Math.round((a.capitalGains ?? 0) * 0.15);
    let scalarCalls = 0;
    let breakdownCalls = 0;
    const countedScalar = (a: Partial<Record<string, number>>): number => {
      scalarCalls++;
      return mixedScalar(a);
    };
    const countedByCategory = (a: Partial<Record<string, number>>): Partial<Record<string, number>> => {
      breakdownCalls++;
      const w = Math.round((a.wages ?? 0) * 0.2);
      const g = Math.round((a.capitalGains ?? 0) * 0.15);
      const out: Partial<Record<string, number>> = {};
      if (w > 0) out.wages = w;
      if (g > 0) out.capitalGains = g;
      return out;
    };
    const taxable = { wages: 5_000_00, capitalGains: 3_000_00 };
    const expectedScalar = ytdIncomeTaxCents(mixedScalar, FRESH_YTD_TAX_STATE, 1, taxable);
    const expectedByCategory = ytdIncomeTaxByCategoryCents(
      mixedScalar,
      countedByCategory,
      FRESH_YTD_TAX_STATE,
      1,
      taxable,
      "p1",
    );
    breakdownCalls = 0; // reset after computing the independent expectation above

    const { taxCents, taxByCategoryCents } = ytdIncomeTaxWithBreakdownCents(
      countedScalar,
      countedByCategory,
      FRESH_YTD_TAX_STATE,
      1,
      taxable,
      "p1",
    );
    expect(taxCents).toBe(expectedScalar);
    expect(taxByCategoryCents).toEqual(expectedByCategory);
    expect(scalarCalls).toBe(1);
    expect(breakdownCalls).toBe(1);
  });
});

describe("ytdIncomeTaxWithBreakdownCents — never attributes a negative share to one category", () => {
  it("stays non-negative and exact per category under a stacking deduction, even as the annual weight mix shifts", () => {
    // A deduction absorbed by wages first, remainder onto capital gains — like real federal
    // tax's standard-deduction stacking (federalTaxCore.ts). As the wages/gains MIX shifts
    // month to month, each category's share of the ANNUAL estimate shifts too; apportioning
    // THIS MONTH's scalar charge by the CURRENT weights (rather than differencing two
    // independently-apportioned cumulative snapshots) is what keeps every month's share
    // non-negative — the bug this regression guards: a per-category history-based diff let
    // one category's own share dip below its prior month's even while the person's total
    // charge rose, and `attributeTaxToSources` silently drops a non-positive category entry,
    // breaking the household Σ invariant (surfaced only under real usJurisdiction brackets).
    const DEDUCTION = 50_000_00;
    const stacking = (a: Partial<Record<string, number>>): number => {
      const wages = a.wages ?? 0;
      const gains = a.capitalGains ?? 0;
      const wagesTaxable = Math.max(0, wages - DEDUCTION);
      const remainder = Math.max(0, DEDUCTION - wages);
      const gainsTaxable = Math.max(0, gains - remainder);
      return Math.round(wagesTaxable * 0.3 + gainsTaxable * 0.1);
    };
    const stackingByCategory = (a: Partial<Record<string, number>>): Partial<Record<string, number>> => {
      const wages = a.wages ?? 0;
      const gains = a.capitalGains ?? 0;
      const wagesTaxable = Math.max(0, wages - DEDUCTION);
      const remainder = Math.max(0, DEDUCTION - wages);
      const gainsTaxable = Math.max(0, gains - remainder);
      const out: Partial<Record<string, number>> = {};
      const w = Math.round(wagesTaxable * 0.3);
      const g = Math.round(gainsTaxable * 0.1);
      if (w > 0) out.wages = w;
      if (g > 0) out.capitalGains = g;
      return out;
    };

    // Month 1: wages only, well above the deduction. Month 2: no new wages, but a large
    // capital-gains lump — the annualized wages PACE actually drops (same YTD, more months),
    // shrinking wages' share of the annual estimate just as gains' share balloons.
    let state = FRESH_YTD_TAX_STATE;
    const monthlyTaxable = [{ wages: 60_000_00 }, { capitalGains: 600_000_00 }, { wages: 5_000_00 }];
    monthlyTaxable.forEach((thisMonth, i) => {
      const monthsElapsed = i + 1;
      const { taxCents, taxByCategoryCents } = ytdIncomeTaxWithBreakdownCents(
        stacking,
        stackingByCategory,
        state,
        monthsElapsed,
        thisMonth,
        "p1",
      );
      const sum = Object.values(taxByCategoryCents).reduce((s, v) => s + (v ?? 0), 0);
      expect(sum).toBe(taxCents);
      if (taxCents >= 0) {
        for (const v of Object.values(taxByCategoryCents)) expect(v ?? 0).toBeGreaterThanOrEqual(0);
      }
      state = {
        taxableByCategory: {
          wages: (state.taxableByCategory.wages ?? 0) + (thisMonth.wages ?? 0),
          capitalGains: (state.taxableByCategory.capitalGains ?? 0) + (thisMonth.capitalGains ?? 0),
        },
        taxPaidCents: state.taxPaidCents + taxCents,
      };
    });
  });
});

describe("ytdIncomeTaxWithBreakdownCents — attributes a refund even when the current estimate implies zero tax", () => {
  it("falls back to the taxable-income composition when the annual tax breakdown is empty", () => {
    // A big January bonus (annualized ×12 at monthsElapsed=1) crosses the deduction and gets
    // charged; with no further income, February's annualized pace (same YTD ÷ 2 months) falls
    // back under the deduction — annualTax is 0, so `computeTaxByCategoryCents` has nothing to
    // weight by, yet a refund of everything charged in January is still owed.
    const DEDUCTION = 12_000_00;
    const flatOverDeduction = (a: Partial<Record<string, number>>): number =>
      Math.round(Math.max(0, (a.wages ?? 0) - DEDUCTION) * 0.2);
    const flatOverDeductionByCategory = (a: Partial<Record<string, number>>): Partial<Record<string, number>> => {
      const t = flatOverDeduction(a);
      return t > 0 ? { wages: t } : {};
    };

    const january = ytdIncomeTaxWithBreakdownCents(
      flatOverDeduction,
      flatOverDeductionByCategory,
      FRESH_YTD_TAX_STATE,
      1,
      { wages: 2_000_00 },
      "p1",
    );
    expect(january.taxCents).toBeGreaterThan(0);

    const stateAfterJanuary: YtdTaxState = {
      taxableByCategory: { wages: 2_000_00 },
      taxPaidCents: january.taxCents,
    };
    const february = ytdIncomeTaxWithBreakdownCents(
      flatOverDeduction,
      flatOverDeductionByCategory,
      stateAfterJanuary,
      2,
      {},
      "p1",
    );
    // Annualized $2,000/2×12 = $12,000 sits exactly at the deduction → $0 annual tax now, so
    // the whole of January's charge must be refunded — attributed to `wages`, the only
    // category that ever carried taxable income, via the fallback.
    expect(february.taxCents).toBe(-january.taxCents);
    expect(february.taxByCategoryCents).toEqual({ wages: -january.taxCents });
  });
});

describe("ytdIncomeTaxByCategoryCents — sums exactly to the scalar monthly charge", () => {
  it("reconciles to ytdIncomeTaxCents for a mixed multi-category month", () => {
    const mixedScalar = (a: Partial<Record<string, number>>): number =>
      Math.round((a.wages ?? 0) * 0.2) + Math.round((a.capitalGains ?? 0) * 0.15);
    const mixedByCategory = (a: Partial<Record<string, number>>): Partial<Record<string, number>> => {
      const w = Math.round((a.wages ?? 0) * 0.2);
      const g = Math.round((a.capitalGains ?? 0) * 0.15);
      const out: Partial<Record<string, number>> = {};
      if (w > 0) out.wages = w;
      if (g > 0) out.capitalGains = g;
      return out;
    };
    const taxable = { wages: 5_000_00, capitalGains: 3_000_00 };
    const scalar = ytdIncomeTaxCents(mixedScalar, FRESH_YTD_TAX_STATE, 1, taxable);
    const byCategory = ytdIncomeTaxByCategoryCents(
      mixedScalar,
      mixedByCategory,
      FRESH_YTD_TAX_STATE,
      1,
      taxable,
      "p1",
    );
    const sum = Object.values(byCategory).reduce((s, v) => s + (v ?? 0), 0);
    expect(sum).toBe(scalar);
    expect(byCategory.wages).toBeGreaterThan(0);
    expect(byCategory.capitalGains).toBeGreaterThan(0);
  });
});
