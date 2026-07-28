import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
} from "../simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import {
  nullJurisdiction,
  type Jurisdiction,
  type WithdrawalTaxBasis,
} from "../jurisdiction";
import type { Cents } from "../money";
import type { SimGoal, GoalDisposal } from "../goal";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type SimOwnedSeries,
} from "./simulate";
import type { SimPerson } from "./simulate.types";
import {
  buildWithdrawalSources,
  DEFAULT_LIQUIDATION_ORDER,
  type WithdrawalState,
} from "./withdrawal";
import type { IncomeSourceMonth } from "./waterfall";

/** A non-compounding account so balances move only by withdrawal/deposit. */
function account(id: string, taxProfile: SimAccountTaxProfile, dollars: number, liquid = false): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

function expense(monthlyDollars: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId: "p1",
  };
}

const person: SimPerson = { id: "p1", name: "You" };

function baseInput(
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): HouseholdSimInput {
  return {
    horizonMonths: 3,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [person],
    accounts,
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

describe("Desired-withdrawal decumulation channel", () => {
  it("liquidates an investment account to fund a retirement shortfall instead of borrowing", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    expect(series.months[0].accountBalancesCents["brokerage"]).toBe(dollarsToCents(98_000));
    expect(series.months[0].accountBalancesCents["cash"]).toBe(0);
    // Synthetic card never touched — no "retiring onto a credit card".
    for (const [, bal] of Object.entries(series.months[0].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
    expect(series.months[0].isInsolvent).toBe(false);
  });

  it("spends the liquid buffer down to 0 before selling investments", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 1_200, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    // $2k need, $1.2k in cash → only $800 comes out of the brokerage; cash drains to 0.
    expect(series.months[0].accountBalancesCents["cash"]).toBe(0);
    expect(series.months[0].accountBalancesCents["brokerage"]).toBe(dollarsToCents(99_200));
  });

  it("drains taxable before pre-tax (liquidation order)", () => {
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 1_000),
        ],
        { expenseSeries: [expense(2_000)] },
      ),
      nullJurisdiction,
    );
    // $2k need: brokerage ($1k taxable) empties first, then $1k from pre-tax.
    expect(series.months[0].accountBalancesCents["brokerage"]).toBe(0);
    expect(series.months[0].accountBalancesCents["pretax"]).toBe(dollarsToCents(99_000));
  });

  it("injects a pre-tax draw as ordinaryIncome in the flows (taxed once at the chokepoint)", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    expect(series.months[0].flows?.incomeByCategoryCents["ordinaryIncome"]).toBe(
      dollarsToCents(2_000),
    );
  });

  it("does not withdraw when income covers the obligations (no accumulation-phase regression)", () => {
    const income: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(5_000), { type: "fixed" }, {
        baselineUnit: "monthly",
      }),
      ownerId: "p1",
    };
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)], {
        incomeSeries: [income],
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    // Income > expenses → brokerage untouched, surplus idles in cash.
    expect(series.months[0].accountBalancesCents["brokerage"]).toBe(dollarsToCents(100_000));
    expect(series.months[0].accountBalancesCents["cash"]).toBe(dollarsToCents(3_000));
  });

  function goal(id: string, disposal: GoalDisposal): SimGoal {
    return {
      id,
      name: id,
      targetCents: dollarsToCents(50_000),
      fundAccountId: `goal-${id}`,
      priority: 0,
      scope: "shared",
      ...disposal,
    };
  }

  it("draws a goal fund reaching its target month — no disposition earmarks or fires it (#150)", () => {
    // At its target month the fund is neither earmarked out nor zeroed, so it stays drawable.
    const maturing = goal("home", { disposition: "retain", targetDate: 1 }); // target IS month 1
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("goal-home", CAPITAL_GAINS_TAX_PROFILE, 50_000),
        ],
        { expenseSeries: [expense(2_000)], goals: [maturing] },
      ),
      nullJurisdiction,
    );
    // Read at the target month (month 1, absolute): months 0 and 1 have each drawn $2k to
    // cover expenses, so the fund sits at $50k − 2·$2k = $46k — still positive, proving the
    // target neither earmarked it out nor zeroed it.
    expect(series.months[1].accountBalancesCents["goal-home"]).toBe(dollarsToCents(46_000));
    for (const [, bal] of Object.entries(series.months[1].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });

  it("counts a future-dated `retain` goal fund toward the drawable nest egg", () => {
    // A `retain` reserve (e.g. an emergency fund) stays in net worth, so it stays drawable.
    const reserve = goal("reserve", { disposition: "retain", targetDate: 24 });
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("goal-reserve", CAPITAL_GAINS_TAX_PROFILE, 50_000),
        ],
        { expenseSeries: [expense(2_000)], goals: [reserve] },
      ),
      nullJurisdiction,
    );
    expect(series.months[0].accountBalancesCents["goal-reserve"]).toBe(dollarsToCents(48_000));
    for (const [, bal] of Object.entries(series.months[0].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });

  it("counts a future-dated `drawDown` goal fund toward the drawable nest egg", () => {
    // A `drawDown` fund IS the nest egg; holding it back until its target would leave
    // this on credit.
    const nestEgg = goal("nestegg", { disposition: "drawDown", targetDate: 24 });
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("goal-nestegg", CAPITAL_GAINS_TAX_PROFILE, 50_000),
        ],
        { expenseSeries: [expense(2_000)], goals: [nestEgg] },
      ),
      nullJurisdiction,
    );
    expect(series.months[0].accountBalancesCents["goal-nestegg"]).toBe(dollarsToCents(48_000));
    for (const [, bal] of Object.entries(series.months[0].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });

  it("does not double-withdraw when an RMD is forced: total pre-tax drawn is max(desired, required), not the sum", () => {
    // A forced RMD draws `required` and re-enters as income, shrinking the desired gap.
    const rmdJurisdiction = (requiredDollars: number): Jurisdiction => ({
      id: "rmd-test",
      computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
      computeTaxCents: () => 0, // no tax → net == gross, isolates the drawdown arithmetic
      requiredMinimumDistributionCents: (preTaxBalanceCents, ctx) =>
        ctx.age >= 73 ? Math.min(preTaxBalanceCents, dollarsToCents(requiredDollars)) : 0,
    });
    // Age 75 in 2026 → past the RMD start age, so the seam fires at month 0.
    const rmdAgePerson: SimPerson = { id: "p1", name: "You", birthYear: 2026 - 75 };
    const accounts = () => [
      account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
    ];

    // Desired ($2k) > required ($1k): RMD draws $1k, desired tops up $1k → $2k, not $3k.
    const desiredWins = simulateHousehold(
      baseInput(accounts(), {
        persons: [rmdAgePerson],
        expenseSeries: [expense(2_000)],
      }),
      rmdJurisdiction(1_000),
    );
    expect(desiredWins.months[0].accountBalancesCents["pretax"]).toBe(dollarsToCents(98_000));
    // RMD + desired taxed once as ordinaryIncome.
    expect(desiredWins.months[0].flows?.incomeByCategoryCents["ordinaryIncome"]).toBe(
      dollarsToCents(2_000),
    );
    for (const [, bal] of Object.entries(desiredWins.months[0].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }

    // Required ($5k) > desired ($2k): the desired channel adds nothing → $5k, not $7k.
    // The $3k of RMD income beyond expenses idles in cash.
    const requiredWins = simulateHousehold(
      baseInput(accounts(), {
        persons: [rmdAgePerson],
        expenseSeries: [expense(2_000)],
      }),
      rmdJurisdiction(5_000),
    );
    expect(requiredWins.months[0].accountBalancesCents["pretax"]).toBe(dollarsToCents(95_000));
    expect(requiredWins.months[0].accountBalancesCents["cash"]).toBe(dollarsToCents(3_000));
  });

  it("grosses up a pre-tax draw so it nets the needed cash under a flat tax", () => {
    const flatTax: Jurisdiction = {
      id: "flat-25",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
      // Single category, so the attributed breakdown is exact.
      computeTaxByCategoryCents: (byCat) => {
        const t = Math.round((byCat.ordinaryIncome ?? 0) * 0.25);
        return t > 0 ? { ordinaryIncome: t } : {};
      },
    };
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      flatTax,
    );
    // Gross ≈ 2000 / (1 − 0.25) ≈ $2,666.67 leaves pre-tax.
    const drawn = dollarsToCents(100_000) - series.months[0].accountBalancesCents["pretax"];
    expect(drawn).toBeGreaterThanOrEqual(dollarsToCents(2_666));
    expect(drawn).toBeLessThanOrEqual(dollarsToCents(2_668));
    // Cash lands ~0 — single-pass residual only.
    expect(Math.abs(series.months[0].accountBalancesCents["cash"])).toBeLessThan(dollarsToCents(5));
  });

  it("does NOT tax a tax-exempt draw: it comes out one-for-one, not grossed up (contrast with pre-tax)", () => {
    // The draw books `taxExempt`, which this jurisdiction never taxes.
    const flatTax: Jurisdiction = {
      id: "flat-25",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
      // Single category, so the attributed breakdown is exact.
      computeTaxByCategoryCents: (byCat) => {
        const t = Math.round((byCat.ordinaryIncome ?? 0) * 0.25);
        return t > 0 ? { ordinaryIncome: t } : {};
      },
    };
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      flatTax,
    );
    // Exactly $2k drawn; a pre-tax draw would have been ~$2,667.
    expect(series.months[0].accountBalancesCents["taxexempt"]).toBe(dollarsToCents(98_000));
    expect(series.months[0].accountBalancesCents["cash"]).toBe(0);
    for (const [, bal] of Object.entries(series.months[0].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });
});

describe("Drawdown order — RMD-first, tax-efficient default, overridable", () => {
  const ctx = { year: 2026 };

  function state(accounts: SimAccount[], dollarsById: Record<string, number>): WithdrawalState {
    const assetBalances = new Map<string, number>();
    for (const a of accounts) assetBalances.set(a.id, dollarsToCents(dollarsById[a.id] ?? 0));
    return { accounts, assetBalances, basisByAccount: new Map(), liquidAccount: null };
  }

  it("draws the tax-efficient DEFAULT order: capital-gains → ordinary-income → tax-exempt", () => {
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 0),
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0),
    ];
    const st = state(accounts, { pretax: 10_000, taxexempt: 10_000, brokerage: 10_000 });
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, [], dollarsToCents(5_000), ctx);
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(5_000));
    expect(st.assetBalances.get("pretax")).toBe(dollarsToCents(10_000));
    expect(st.assetBalances.get("taxexempt")).toBe(dollarsToCents(10_000));
    expect(sources).toHaveLength(1);
    expect(sources[0].taxCategory).toBe("capitalGains");
  });

  it("honors an explicit liquidation-order OVERRIDE (overridable)", () => {
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 0),
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0),
    ];
    const st = state(accounts, { pretax: 10_000, taxexempt: 10_000, brokerage: 10_000 });
    // Tax-exempt first, e.g. a bequest strategy.
    const { sources } = buildWithdrawalSources(
      st,
      nullJurisdiction,
      [],
      dollarsToCents(5_000),
      ctx,
      ["taxExempt", "capitalGains", "ordinaryIncome"],
    );
    expect(st.assetBalances.get("taxexempt")).toBe(dollarsToCents(5_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(10_000));
    expect(sources[0].taxCategory).toBe("taxExempt");
  });

  it("honors forced RMDs first: an RMD source shrinks the need before any elective draw", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    const st = state(accounts, { brokerage: 10_000 });
    // A $3k forced RMD is already booked as income, so the $5k obligation needs only a
    // $2k elective top-up.
    const rmd: IncomeSourceMonth[] = [
      { ownerId: "p1", waterfallInflowCents: dollarsToCents(3_000), taxCategory: "ordinaryIncome" },
    ];
    const { sources } = buildWithdrawalSources(
      st,
      nullJurisdiction,
      rmd,
      dollarsToCents(5_000),
      ctx,
    );
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(8_000));
    const electiveTotal = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(electiveTotal).toBe(dollarsToCents(2_000));
  });

  it("exposes the tax-efficient default order as a named constant", () => {
    expect(DEFAULT_LIQUIDATION_ORDER).toEqual(["capitalGains", "ordinaryIncome", "taxExempt"]);
  });
});

describe("Every taxed draw nets the need — whole-return gross-up", () => {
  const ctx = { year: 2026 };

  function state(
    accounts: SimAccount[],
    dollarsById: Record<string, number>,
    basisDollarsById: Record<string, number> = {},
  ): WithdrawalState {
    const assetBalances = new Map<string, number>();
    const basisByAccount = new Map<string, number>();
    for (const a of accounts) {
      assetBalances.set(a.id, dollarsToCents(dollarsById[a.id] ?? 0));
      if (basisDollarsById[a.id] !== undefined) {
        basisByAccount.set(a.id, dollarsToCents(basisDollarsById[a.id]));
      }
    }
    return { accounts, assetBalances, basisByAccount, liquidAccount: null };
  }

  /**
   * After-tax income across all sources. Taxes each owner's combined per-category map, as
   * the chokepoint does over the whole return, so category interactions count.
   */
  function householdNetCents(
    sources: readonly IncomeSourceMonth[],
    jurisdiction: Jurisdiction,
  ): number {
    const byOwner = new Map<string, Record<string, number>>();
    let gross = 0;
    for (const s of sources) {
      gross += s.waterfallInflowCents;
      const map = byOwner.get(s.ownerId) ?? {};
      map[s.taxCategory] = (map[s.taxCategory] ?? 0) + s.waterfallInflowCents;
      byOwner.set(s.ownerId, map);
    }
    let tax = 0;
    for (const map of byOwner.values()) tax += jurisdiction.computeTaxCents(map, ctx);
    return gross - tax;
  }

  /**
   * The provisional-income trap: draw and benefit each tax at 0% alone, but the draw pulls
   * the benefit into taxability. A per-category own-rate gross-up (×0%) cannot see this;
   * only differencing the whole return can.
   */
  const provisionalTrap: Jurisdiction = {
    id: "provisional-trap",
    computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
    computeTaxCents: (byCat) => {
      const benefit = byCat.governmentRetirementBenefit ?? 0;
      if (benefit === 0) return 0;
      const other =
        (byCat.capitalGains ?? 0) + (byCat.ordinaryIncome ?? 0) + (byCat.taxExempt ?? 0);
      const provisional = other + Math.round(benefit * 0.5);
      const taxableBenefit = Math.max(
        0,
        Math.min(benefit, provisional - dollarsToCents(1_000)),
      );
      return Math.round(taxableBenefit * 0.25);
    },
  };

  it("sizes a 0%-rate capital-gains draw that pulls a benefit into taxability to net the need", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)];
    const st = state(accounts, { brokerage: 100_000 });
    // $2k benefit booked, $3k obligations → $1k net need. A naive one-for-one draw
    // under-delivers by exactly the tax it induces on the benefit.
    const benefit: IncomeSourceMonth[] = [
      { ownerId: "p1", waterfallInflowCents: dollarsToCents(2_000), taxCategory: "governmentRetirementBenefit" },
    ];
    const { sources } = buildWithdrawalSources(
      st,
      provisionalTrap,
      benefit,
      dollarsToCents(3_000),
      ctx,
    );
    const net = householdNetCents([...benefit, ...sources], provisionalTrap);
    expect(net).toBeGreaterThanOrEqual(dollarsToCents(3_000));
    // Grossed up above the bare $1k need to absorb the induced tax.
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBeGreaterThan(dollarsToCents(1_000));
  });

  it("grosses up a capital-gains draw under a flat capital-gains tax so it nets the need", () => {
    const flatGains: Jurisdiction = {
      id: "flat-gains-20",
      computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
      computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * 0.2),
    };
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)];
    const st = state(accounts, { brokerage: 100_000 });
    const { sources } = buildWithdrawalSources(st, flatGains, [], dollarsToCents(2_000), ctx);
    const net = householdNetCents(sources, flatGains);
    expect(net).toBeGreaterThanOrEqual(dollarsToCents(2_000));
    // Gross ≈ 2000 / (1 − 0.20) = $2,500 leaves the brokerage.
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBeGreaterThanOrEqual(dollarsToCents(2_499));
    expect(drawn).toBeLessThanOrEqual(dollarsToCents(2_501));
  });

  it("sizes the draw to need + the LUMP when a cliff induces a fixed tax, not 100x the need", () => {
    // Crossing $30k of non-benefit income makes the entire benefit taxable at 50% at once.
    // The induced tax is a lump — the same $50k at any draw past the cliff — so
    // `need / (1 − rate)` does not apply: the implied rate ($50k on a $1k draw reads as
    // 5000%, clamped to 99%) would draw 100 × the need. The fixed point is need + lump.
    const cliff: Jurisdiction = {
      id: "cliff-50",
      computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
      computeTaxCents: (byCat) => {
        const benefit = byCat.governmentRetirementBenefit ?? 0;
        const other =
          (byCat.capitalGains ?? 0) + (byCat.ordinaryIncome ?? 0) + (byCat.taxExempt ?? 0);
        return other > dollarsToCents(30_000) ? Math.round(benefit * 0.5) : 0;
      },
    };
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 500_000)];
    const st = state(accounts, { brokerage: 500_000 });
    // $100k benefit plus $29.5k of gains sits just under the cliff (base tax 0);
    // funding $1k more tips the household over it.
    const booked: IncomeSourceMonth[] = [
      { ownerId: "p1", waterfallInflowCents: dollarsToCents(100_000), taxCategory: "governmentRetirementBenefit" },
      { ownerId: "p1", waterfallInflowCents: dollarsToCents(29_500), taxCategory: "capitalGains" },
    ];
    const { sources } = buildWithdrawalSources(
      st,
      cliff,
      booked,
      dollarsToCents(130_500), // $129.5k already booked + $1k of unfunded need
      ctx,
    );
    const net = householdNetCents([...booked, ...sources], cliff);
    expect(net).toBeGreaterThanOrEqual(dollarsToCents(130_500));
    // Costs need + lump ($51k), not the clamp's 100 × need ($100k).
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(51_000));
  });

  it("spills to the next source when an account cannot cover its own gross-up", () => {
    // Flat 20% on both categories. The brokerage holds $1k against a $10k need, so it
    // cannot fund its own gross-up: it empties, delivers $800 net, and the REMAINING need
    // (not the original) grosses up against the pre-tax account behind it.
    const flat20: Jurisdiction = {
      id: "flat-20",
      computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
      computeTaxCents: (byCat) =>
        Math.round(((byCat.capitalGains ?? 0) + (byCat.ordinaryIncome ?? 0)) * 0.2),
    };
    const accounts = [
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 1_000),
      account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
    ];
    const st = state(accounts, { brokerage: 1_000, pretax: 100_000 });
    const { sources } = buildWithdrawalSources(st, flat20, [], dollarsToCents(10_000), ctx);

    expect(st.assetBalances.get("brokerage")).toBe(0);
    // $9,200 of need remains, grossed up at 20% → $11,500 of pre-tax.
    expect(st.assetBalances.get("pretax")).toBe(dollarsToCents(100_000 - 11_500));
    expect(householdNetCents(sources, flat20)).toBeGreaterThanOrEqual(dollarsToCents(10_000));
  });

  it("takes the LEAST draw that nets the need when two cliffs offer more than one", () => {
    // Two cliffs stack two lumps, so $3k and $45k both net exactly $1k: a step tax makes
    // `need + lump` a fixed point in every region it lands in. Climbing from `need` finds
    // the cheap one; descending from the closed-form guess ($100k) would settle on $45k.
    const twoCliffs: Jurisdiction = {
      id: "two-cliffs",
      computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
      computeTaxCents: (byCat) => {
        const draw = byCat.capitalGains ?? 0;
        if (draw > dollarsToCents(4_000)) return dollarsToCents(44_000);
        if (draw > dollarsToCents(500)) return dollarsToCents(2_000);
        return 0;
      },
    };
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 500_000)];
    const st = state(accounts, { brokerage: 500_000 });
    const { sources } = buildWithdrawalSources(st, twoCliffs, [], dollarsToCents(1_000), ctx);
    const net = householdNetCents(sources, twoCliffs);
    expect(net).toBeGreaterThanOrEqual(dollarsToCents(1_000));
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(3_000));
  });
});

describe("Cost basis — only the gain of a fund withdrawal is taxable", () => {
  const ctx = { year: 2026 };

  function state(
    accounts: SimAccount[],
    dollarsById: Record<string, number>,
    basisDollarsById: Record<string, number> = {},
  ): WithdrawalState {
    const assetBalances = new Map<string, number>();
    const basisByAccount = new Map<string, number>();
    for (const a of accounts) {
      assetBalances.set(a.id, dollarsToCents(dollarsById[a.id] ?? 0));
      if (basisDollarsById[a.id] !== undefined) {
        basisByAccount.set(a.id, dollarsToCents(basisDollarsById[a.id]));
      }
    }
    return { accounts, assetBalances, basisByAccount, liquidAccount: null };
  }

  /**
   * After-tax income taxing each source's gain (`taxableCents`) rather than its gross, as
   * the tax seam does for a returned-basis fund draw.
   */
  function householdNetCentsGain(
    sources: readonly IncomeSourceMonth[],
    jurisdiction: Jurisdiction,
  ): number {
    const byOwner = new Map<string, Record<string, number>>();
    let gross = 0;
    for (const s of sources) {
      gross += s.waterfallInflowCents;
      const map = byOwner.get(s.ownerId) ?? {};
      map[s.taxCategory] = (map[s.taxCategory] ?? 0) + (s.taxableCents ?? s.waterfallInflowCents);
      byOwner.set(s.ownerId, map);
    }
    let tax = 0;
    for (const map of byOwner.values()) tax += jurisdiction.computeTaxCents(map, ctx);
    return gross - tax;
  }

  // US pro-rata return-of-capital: basis is returned in proportion to how much of the
  // balance is basis. Its own arithmetic is covered in @finley/rules; here it only shows
  // the engine passes basis and honors gain.
  const proRata = (b: WithdrawalTaxBasis): Cents => {
    if (b.balanceCents <= 0 || b.basisCents <= 0) return b.grossCents;
    const frac = Math.min(1, b.basisCents / b.balanceCents);
    return b.grossCents - Math.min(b.basisCents, Math.round(b.grossCents * frac));
  };
  /** A no-tax jurisdiction that still returns basis — isolates the gain arithmetic. */
  const proRataNoTax: Jurisdiction = {
    id: "prorata-no-tax",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    taxableWithdrawalCents: proRata,
  };

  /** A flat capitalGains-only tax — makes the taxable base observable. */
  const flatGains20: Jurisdiction = {
    id: "flat-gains-20",
    computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
    computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * 0.2),
    taxableWithdrawalCents: proRata,
  };

  it("books $0 taxable for a principal-only draw (basis == balance, no growth yet)", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    // Balance == basis: every dollar is returned principal, nothing is gain.
    const st = state(accounts, { brokerage: 100_000 }, { brokerage: 100_000 });
    const { sources } = buildWithdrawalSources(st, flatGains20, [], dollarsToCents(2_000), ctx);
    // No gain → no tax → no gross-up.
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(2_000));
    expect(sources[0].taxableCents).toBe(0);
    // Basis fell by the principal returned: $100k − $2k.
    expect(st.basisByAccount.get("brokerage")).toBe(dollarsToCents(98_000));
  });

  it("books only the gain fraction for a partially-appreciated account", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    // $100k balance on $60k basis → 40% of any draw is gain.
    const st = state(accounts, { brokerage: 100_000 }, { brokerage: 60_000 });
    const { sources } = buildWithdrawalSources(st, flatGains20, [], dollarsToCents(6_000), ctx);
    // gross g nets g − 0.2·(0.4·g) = 0.92·g = $6k → g ≈ $6,521.74.
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    const gain = sources.reduce((s, x) => s + (x.taxableCents ?? x.waterfallInflowCents), 0);
    expect(gain).toBe(Math.round(drawn * 0.4));
    expect(householdNetCentsGain(sources, flatGains20)).toBeGreaterThanOrEqual(dollarsToCents(6_000));
    // Basis fell only by the principal fraction (60%).
    const basisDrawn = dollarsToCents(60_000) - (st.basisByAccount.get("brokerage") ?? 0);
    expect(basisDrawn).toBe(drawn - gain);
  });

  it("leaves a pre-tax draw fully taxable (basis 0 → gain == gross, unchanged)", () => {
    const accounts = [account("pretax", PRE_TAX_TAX_PROFILE, 0)];
    const flatOrdinary20: Jurisdiction = {
      id: "flat-ord-20",
      computeTaxByCategoryCents: () => ({}), // gross-up probe only; never reconciled
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.2),
    };
    // No basis entry → basis 0 → the whole draw is gain.
    const st = state(accounts, { pretax: 100_000 });
    const { sources } = buildWithdrawalSources(st, flatOrdinary20, [], dollarsToCents(2_000), ctx);
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    // Grossed up ~2000/(1−0.2) = $2,500.
    expect(drawn).toBeGreaterThanOrEqual(dollarsToCents(2_499));
    expect(drawn).toBeLessThanOrEqual(dollarsToCents(2_501));
    expect(sources[0].taxableCents).toBe(drawn);
  });

  it("returns basis pro-rata so a later draw's gain fraction tracks the basis that remains", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    // $100k balance / $50k basis → 50% gain fraction; no tax seam, to isolate arithmetic.
    const st = state(accounts, { brokerage: 100_000 }, { brokerage: 50_000 });
    const { sources: first } = buildWithdrawalSources(st, proRataNoTax, [], dollarsToCents(20_000), ctx);
    // Drew $20k: $10k gain booked, $10k basis returned → $40k basis on $80k balance.
    expect(first[0].taxableCents).toBe(dollarsToCents(10_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(80_000));
    expect(st.basisByAccount.get("brokerage")).toBe(dollarsToCents(40_000));
    // The gain fraction held at 50%.
    const { sources: second } = buildWithdrawalSources(st, proRataNoTax, [], dollarsToCents(20_000), ctx);
    expect(second[0].taxableCents).toBe(dollarsToCents(10_000));
    expect(st.basisByAccount.get("brokerage")).toBe(dollarsToCents(30_000));
  });
});

describe("Liquid-buffer drawdown reporting", () => {
  const ctx = { year: 2026 };

  function stateWithCash(cashDollars: number, brokerageDollars: number): WithdrawalState {
    const cash = account("cash", CASH_INTEREST_TAX_PROFILE, cashDollars, true);
    const brokerage = account("brokerage", CAPITAL_GAINS_TAX_PROFILE, brokerageDollars);
    const assetBalances = new Map<string, number>([
      ["cash", dollarsToCents(cashDollars)],
      ["brokerage", dollarsToCents(brokerageDollars)],
    ]);
    return {
      accounts: [cash, brokerage],
      assetBalances,
      basisByAccount: new Map(),
      liquidAccount: cash,
    };
  }

  it("reports the whole gap as a drawdown, and sells nothing, when cash covers it", () => {
    const st = stateWithCash(10_000, 100_000);
    const { sources, liquidDrawdownCents } = buildWithdrawalSources(
      st,
      nullJurisdiction,
      [],
      dollarsToCents(3_000),
      ctx,
    );
    expect(sources).toEqual([]);
    expect(liquidDrawdownCents).toBe(dollarsToCents(3_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(100_000));
  });

  it("caps the drawdown at the buffer and sells investments for the rest", () => {
    const st = stateWithCash(2_000, 100_000);
    // $5k need; only $2k of cash → drawdown is the $2k buffer, the $3k rest is sold.
    const { sources, liquidDrawdownCents } = buildWithdrawalSources(
      st,
      nullJurisdiction,
      [],
      dollarsToCents(5_000),
      ctx,
    );
    expect(liquidDrawdownCents).toBe(dollarsToCents(2_000));
    expect(sources).toHaveLength(1);
    expect(sources[0].waterfallInflowCents).toBe(dollarsToCents(3_000)); // no tax seam → one-for-one
  });

  it("reports no drawdown when income already covers the month", () => {
    const st = stateWithCash(10_000, 100_000);
    const { sources, liquidDrawdownCents } = buildWithdrawalSources(
      st,
      nullJurisdiction,
      [{ ownerId: "p1", waterfallInflowCents: dollarsToCents(4_000), taxCategory: "wages" }],
      dollarsToCents(3_000), // obligations below the $4k income
      ctx,
    );
    expect(sources).toEqual([]);
    expect(liquidDrawdownCents).toBe(0);
  });

  it("names an investment draw by its account", () => {
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: "p1",
      label: "Brokerage",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(100_000),
      initialAnnualRate: 0,
    });
    const st: WithdrawalState = {
      accounts: [brokerage],
      assetBalances: new Map([["brokerage", dollarsToCents(100_000)]]),
      basisByAccount: new Map(),
      liquidAccount: null,
    };
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, [], dollarsToCents(5_000), ctx);
    expect(sources[0].sourceId).toBe("brokerage");
    expect(sources[0].label).toBe("Brokerage");
  });
});
