import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type SimOwnedSeries } from "./simulate";
import type { SimPerson } from "./simulate.types";

/** A non-compounding account so balances move only by withdrawal/deposit unless a rate is given. */
function account(id: string, taxProfile: SimAccountTaxProfile, dollars: number, liquid = false, rate = 0): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: rate,
  });
}

/** A recurring or one-shot expense/wage series, keyed off explicit start/end months. */
function series(monthlyDollars: number, startMonth = 0, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
    ownerId: "p1",
  };
}

const person: SimPerson = { id: "p1", name: "You" };

function baseInput(accounts: SimAccount[], overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
  return {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [person],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

/**
 * A flat rate on the combined categories, with the SAME per-category rounding feeding both the
 * scalar and the breakdown, so the two are exact by construction — isolating this test suite
 * from the reconciliation math `rules`/`waterfallInvariants.ts` already cover elsewhere.
 */
function flatAnnual(rate: number): Jurisdiction {
  const perCategory = (byCat: Partial<Record<string, number>>): Partial<Record<string, number>> => {
    const out: Partial<Record<string, number>> = {};
    for (const category of ["wages", "ordinaryIncome", "capitalGains", "taxExempt"] as const) {
      const v = byCat[category] ?? 0;
      if (v > 0) out[category] = Math.round(v * rate);
    }
    return out;
  };
  return {
    id: "flat-annual",
    computeTaxByCategoryCents: perCategory,
    computeTaxCents: (byCat) =>
      Object.values(perCategory(byCat)).reduce((s: number, v) => s + (v ?? 0), 0),
  };
}

describe("Annual tax settlement — the same annual income taxes the same regardless of timing", () => {
  it("$120k of wages taxes identically whether paid as a January lump or spread evenly across the year", () => {
    const rate = 0.25;
    const lump = series(120_000, 0, 0); // pays the whole $120k in month 0 only
    const spread = series(10_000, 0, 11); // pays $10k/mo for the whole 12-month horizon

    const lumpSeries = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], { incomeSeries: [lump] }),
      flatAnnual(rate),
    );
    const spreadSeries = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], { incomeSeries: [spread] }),
      flatAnnual(rate),
    );

    // December (month 11) is the year's settlement month for both.
    const lumpTax = lumpSeries.months[11].flows!.taxCents;
    const spreadTax = spreadSeries.months[11].flows!.taxCents;
    expect(lumpTax).toBe(dollarsToCents(30_000)); // 25% of $120k
    expect(spreadTax).toBe(lumpTax);

    // No month before December charges anything, in EITHER shape.
    for (let m = 0; m < 11; m++) {
      expect(lumpSeries.months[m].flows!.taxCents).toBe(0);
      expect(spreadSeries.months[m].flows!.taxCents).toBe(0);
    }
  });
});

describe("Annual tax settlement — a lumpy mid-year event does not cause an immediate payment", () => {
  it("a large January RMD does not cause an immediate federal income-tax payment", () => {
    const rmdJurisdiction: Jurisdiction = {
      ...flatAnnual(0.3),
      requiredMinimumDistributionCents: (preTaxBalanceCents, ctx) =>
        ctx.age >= 73 ? Math.min(preTaxBalanceCents, dollarsToCents(80_000)) : 0,
    };
    const rmdAgePerson: SimPerson = { id: "p1", name: "You", birthYear: 2026 - 75 };
    const seriesResult = simulateHousehold(
      baseInput(
        [account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)],
        { persons: [rmdAgePerson] },
      ),
      rmdJurisdiction,
    );
    // The $80k RMD is forced out at month 0 and shows up as taxable ordinary income there...
    expect(seriesResult.months[0].flows!.incomeByCategoryCents["ordinaryIncome"]).toBe(dollarsToCents(80_000));
    // ...but nothing is charged for it until December.
    expect(seriesResult.months[0].flows!.taxCents).toBe(0);
    expect(seriesResult.months[11].flows!.taxCents).toBeGreaterThan(0);
  });
});

describe("Annual tax settlement — multiple taxable events combine into one annual base", () => {
  it("two separate mid-year taxable withdrawals sum into the SAME December bill, not two smaller ones", () => {
    const rate = 0.2;
    // Two obligations, each forcing a $5k liquidation from the SAME pre-tax account, at
    // different months (0 and 6) — combined taxable income for the year is $10k, taxed once,
    // in December, never mid-year.
    const combined = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [series(5_000, 0, 0), series(5_000, 6, 6)],
      }),
      flatAnnual(rate),
    );
    for (const m of [0, 6]) expect(combined.months[m].flows!.taxCents).toBe(0);
    // Both draws combine before the recursive settlement climb: the SAME jurisdiction run
    // against a SINGLE $10k withdrawal (one month) is the ground truth for "no double-taxing,
    // no under-taxing" — the combined two-event run's December bill must match it exactly.
    const singleEvent = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [series(10_000, 0, 0)],
      }),
      flatAnnual(rate),
    );
    expect(combined.months[11].flows!.taxCents).toBe(singleEvent.months[11].flows!.taxCents);
    expect(combined.months[11].flows!.taxCents).toBeGreaterThan(0);
  });
});

describe("Annual tax settlement — funding the bill itself", () => {
  it("a bill payable from existing cash requires no additional taxable withdrawal (no recursive uplift)", () => {
    // Wages bank into a cash-like liquid account all year (basis tracks balance 1:1, so
    // selling from it later realizes ~no gain) — by December there is plenty of cash on hand
    // to pay the tax bill without touching anything appreciated.
    const rate = 0.25;
    const wages = series(10_000, 0, 11); // $120k/yr
    const seriesResult = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], { incomeSeries: [wages] }),
      flatAnnual(rate),
    );
    // Exactly 25% of $120k — no recursive top-up, because paying from cash realizes no gain.
    expect(seriesResult.months[11].flows!.taxCents).toBe(dollarsToCents(30_000));
  });

  it("a bill funded from a taxable retirement account with no cash correctly grosses itself up until it converges", () => {
    // No cash reserve anywhere: an early $10k pre-tax withdrawal (no gross-up — an ordinary
    // mid-year draw) leaves a bill that can ONLY be paid by selling MORE of the same fully
    // taxable pre-tax account — which itself realizes more taxable income, recursively
    // enlarging the bill, until the sale and the bill it causes converge.
    const rate = 0.25;
    const seriesResult = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
        expenseSeries: [series(10_000, 0, 0)],
      }),
      flatAnnual(rate),
    );
    const finalTax = seriesResult.months[11].flows!.taxCents;
    // Closed form for a fully-taxable (basis 0) source and a flat rate r on an initial
    // withdrawal S: settling recursively converges to tax = r·S / (1 − r).
    const expected = Math.round((rate * dollarsToCents(10_000)) / (1 - rate));
    // Integer-cent rounding at each step of the climb can land the observed value within a
    // few cents of the closed form; assert the climb actually ran (bill > the naive
    // non-recursive 25% of $10k) and landed at the closed-form fixed point.
    expect(finalTax).toBeGreaterThan(Math.round(dollarsToCents(10_000) * rate));
    expect(Math.abs(finalTax - expected)).toBeLessThanOrEqual(2);
    // Fully funded: the account still holds enough to have covered both the original
    // withdrawal and the settlement's own top-up (its balance dropped by both).
    expect(seriesResult.months[11].accountBalancesCents.pretax).toBeLessThan(dollarsToCents(1_000_000) - dollarsToCents(10_000));
  });
});

describe("Annual tax settlement — the accumulator resets every January", () => {
  it("year 2's tax is unaffected by year 1's already-settled income", () => {
    const rate = 0.25;
    // $60k/yr flat every year — if the accumulator carried over, year 2's bill would be
    // inflated by year 1's already-taxed income; it must not be.
    const wages = series(5_000, 0, 23); // $60k/yr for 2 full years
    const seriesResult = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 24,
        incomeSeries: [wages],
      }),
      flatAnnual(rate),
    );
    const year1Tax = seriesResult.months[11].flows!.taxCents;
    const year2Tax = seriesResult.months[23].flows!.taxCents;
    expect(year1Tax).toBe(dollarsToCents(15_000)); // 25% of $60k
    expect(year2Tax).toBe(year1Tax); // identical, not doubled or compounded
  });
});

describe("Annual tax settlement — per-category attribution reconciles exactly to the scalar liability", () => {
  it("a mixed wages + capital-gains year sums its December breakdown exactly to the charged total", () => {
    const rate = 0.25;
    const wages = series(2_000, 0, 11); // $24k/yr wages — far too little to cover the expense below
    const seriesResult = simulateHousehold(
      baseInput([account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 200_000, false, 0.12)], {
        incomeSeries: [wages],
        // Six months of 12%/yr growth first, so the account holds embedded gain (basis <
        // balance) by the time this forces a taxable capital-gains liquidation.
        expenseSeries: [series(50_000, 6, 6)],
      }),
      flatAnnual(rate),
    );
    const december = seriesResult.months[11].flows!;
    const sum = Object.values(december.taxByCategoryCents ?? {}).reduce((s, v) => s + (v ?? 0), 0);
    expect(sum).toBe(december.taxCents);
    expect(december.taxCents).toBeGreaterThan(0);
    // The helper series carries no explicit tax category, so it defaults to ordinaryIncome.
    expect(december.taxByCategoryCents?.ordinaryIncome).toBeGreaterThan(0);
    expect(december.taxByCategoryCents?.capitalGains).toBeGreaterThan(0);
  });
});
