import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
} from "../simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";
import type { SimGoal, GoalDisposal } from "../goal";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type SimOwnedSeries,
  type SimPerson,
} from "./simulate";
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

/** A flat monthly expense series — the obligation the retiree must fund. */
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

describe("Desired-withdrawal decumulation channel (§7, #35)", () => {
  it("liquidates an investment account to fund a retirement shortfall instead of borrowing", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    // Month 1: $2k of expenses funded by selling $2k of the brokerage; no debt.
    expect(series.months[1].accountBalancesCents["brokerage"]).toBe(dollarsToCents(98_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(0);
    // Synthetic card is never touched — no "retiring onto a credit card".
    for (const [, bal] of Object.entries(series.months[1].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
    expect(series.months[1].isInsolvent).toBe(false);
  });

  it("spends the liquid buffer down to 0 before selling investments (D2)", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 1_200, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    // $2k need, $1.2k in cash → only $800 comes out of the brokerage; cash drains to 0.
    expect(series.months[1].accountBalancesCents["cash"]).toBe(0);
    expect(series.months[1].accountBalancesCents["brokerage"]).toBe(dollarsToCents(99_200));
  });

  it("drains taxable before pre-tax (liquidation order D2)", () => {
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
    expect(series.months[1].accountBalancesCents["brokerage"]).toBe(0);
    expect(series.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(99_000));
  });

  it("injects a pre-tax draw as ordinaryIncome in the flows (taxed once at the chokepoint)", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      nullJurisdiction,
    );
    expect(series.months[1].flows?.incomeByCategoryCents["ordinaryIncome"]).toBe(
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
    expect(series.months[1].accountBalancesCents["brokerage"]).toBe(dollarsToCents(100_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(dollarsToCents(3_000));
  });

  /**
   * A goal fixture accumulating into `goal-<id>`. Takes the disposition/date as one
   * {@link GoalDisposal} pair rather than two params, so a fixture cannot build a
   * combination the type forbids (§5.2).
   */
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

  it("leaves a future-dated convertToEquity goal fund earmarked, funding the shortfall from the brokerage instead (D4, §5.2)", () => {
    const futureGoal = goal("home", { disposition: "convertToEquity", targetDate: 24 }); // still in the future at month 1
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("goal-home", CAPITAL_GAINS_TAX_PROFILE, 50_000),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000),
        ],
        { expenseSeries: [expense(2_000)], goals: [futureGoal] },
      ),
      nullJurisdiction,
    );
    // The earmarked home fund is untouched; the brokerage funds the shortfall.
    expect(series.months[1].accountBalancesCents["goal-home"]).toBe(dollarsToCents(50_000));
    expect(series.months[1].accountBalancesCents["brokerage"]).toBe(dollarsToCents(98_000));
  });

  it("counts a future-dated `retain` goal fund toward the drawable nest egg (§5.2)", () => {
    // A `retain` reserve (e.g. an emergency fund) stays in net worth and IS drawable
    // in retirement — unlike a `convertToEquity`/`spend` fund it is NOT earmarked out,
    // even before its target date. So it funds the shortfall before other investments.
    const reserve = goal("reserve", { disposition: "retain", targetDate: 24 }); // future-dated, yet drawable
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
    // The reserve is tapped for the $2k need rather than borrowed against.
    expect(series.months[1].accountBalancesCents["goal-reserve"]).toBe(dollarsToCents(48_000));
    for (const [, bal] of Object.entries(series.months[1].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });

  it("counts a future-dated `drawDown` goal fund toward the drawable nest egg (§5.2)", () => {
    // A `drawDown` goal fund IS the nest egg (retirement / college) — the fourth
    // disposition, the counterpart to the `retain` case above. Like `retain` and
    // unlike `convertToEquity`/`spend`, it is NOT earmarked out of decumulation even
    // before its target date, so it funds the shortfall rather than being borrowed
    // against. Guards the `disposition !== convertToEquity && !== spend` branch of
    // `isEarmarkedForDisposition` for the drawDown arm at the integration level: a
    // regression that earmarked drawDown funds would leave this shortfall on credit.
    const nestEgg = goal("nestegg", { disposition: "drawDown", targetDate: 24 }); // future-dated, yet drawable
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
    // The nest-egg fund is tapped for the $2k need rather than borrowed against.
    expect(series.months[1].accountBalancesCents["goal-nestegg"]).toBe(dollarsToCents(48_000));
    for (const [, bal] of Object.entries(series.months[1].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });

  it("does not double-withdraw when an RMD is forced: total pre-tax drawn is max(desired, required), not the sum (§7/#32)", () => {
    // A forced RMD already draws `required` from pre-tax and re-enters as income, so the
    // desired channel sees a smaller gap. The two must settle at max(desired, required),
    // never required + desired.
    const rmdJurisdiction = (requiredDollars: number): Jurisdiction => ({
      id: "rmd-test",
      computeTaxCents: () => 0, // no tax → net == gross, isolates the drawdown arithmetic
      requiredMinimumDistributionCents: (preTaxBalanceCents, ctx) =>
        ctx.age >= 73 ? Math.min(preTaxBalanceCents, dollarsToCents(requiredDollars)) : 0,
    });
    // Age 75 in 2026 → past the RMD start age, so the seam fires at month 1.
    const rmdAgePerson: SimPerson = { id: "p1", name: "You", birthYear: 2026 - 75 };
    const accounts = () => [
      account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
    ];

    // Desired (the $2k obligation) > required ($1k RMD): RMD draws $1k, the desired
    // channel tops up the remaining $1k → $2k total pre-tax drawn (max), not $3k.
    const desiredWins = simulateHousehold(
      baseInput(accounts(), {
        persons: [rmdAgePerson],
        expenseSeries: [expense(2_000)],
      }),
      rmdJurisdiction(1_000),
    );
    expect(desiredWins.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(98_000));
    // Every pre-tax dollar (RMD + desired) is taxed once as ordinaryIncome — the whole $2k.
    expect(desiredWins.months[1].flows?.incomeByCategoryCents["ordinaryIncome"]).toBe(
      dollarsToCents(2_000),
    );
    for (const [, bal] of Object.entries(desiredWins.months[1].liabilityBalancesCents)) {
      expect(bal).toBe(0); // no borrowing
    }

    // Required ($5k RMD) > desired ($2k obligation): the forced RMD already exceeds the
    // need, so the desired channel adds nothing → $5k total drawn (max), not $7k. The
    // $3k of net RMD income beyond expenses idles in the liquid cash account.
    const requiredWins = simulateHousehold(
      baseInput(accounts(), {
        persons: [rmdAgePerson],
        expenseSeries: [expense(2_000)],
      }),
      rmdJurisdiction(5_000),
    );
    expect(requiredWins.months[1].accountBalancesCents["pretax"]).toBe(dollarsToCents(95_000));
    expect(requiredWins.months[1].accountBalancesCents["cash"]).toBe(dollarsToCents(3_000));
  });

  it("grosses up a pre-tax draw so it nets the needed cash under a flat tax", () => {
    // Flat 25% tax on ordinary-income taxable → a $2k net need requires a larger gross draw.
    const flatTax: Jurisdiction = {
      id: "flat-25",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
    };
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      flatTax,
    );
    // Gross ≈ 2000 / (1 − 0.25) ≈ $2,666.67 leaves pre-tax; net $2k funds the expense.
    const drawn = dollarsToCents(100_000) - series.months[1].accountBalancesCents["pretax"];
    expect(drawn).toBeGreaterThanOrEqual(dollarsToCents(2_666));
    expect(drawn).toBeLessThanOrEqual(dollarsToCents(2_668));
    // Cash lands ~0 (single-pass residual only), no debt.
    expect(Math.abs(series.months[1].accountBalancesCents["cash"])).toBeLessThan(dollarsToCents(5));
  });

  it("does NOT tax a tax-exempt draw: it comes out one-for-one, not grossed up (contrast with pre-tax)", () => {
    // Same flat 25% tax on ordinary income as the pre-tax gross-up case — but a
    // tax-exempt account's withdrawal produces the `taxExempt` category, which this
    // jurisdiction never taxes, so exactly the $2k need leaves it (no gross-up).
    const flatTax: Jurisdiction = {
      id: "flat-25",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
    };
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      flatTax,
    );
    // Exactly $2k drawn (contrast: a pre-tax draw would be ~$2,667), and no debt.
    expect(series.months[1].accountBalancesCents["taxexempt"]).toBe(dollarsToCents(98_000));
    expect(series.months[1].accountBalancesCents["cash"]).toBe(0);
    for (const [, bal] of Object.entries(series.months[1].liabilityBalancesCents)) {
      expect(bal).toBe(0);
    }
  });
});

describe("Drawdown order — RMD-first, tax-efficient default, overridable (§16, #69 AC7)", () => {
  const ctx = { year: 2026 };

  /** A withdrawal state over the given accounts, each seeded to `dollars`. */
  function state(accounts: SimAccount[], dollarsById: Record<string, number>): WithdrawalState {
    const assetBalances = new Map<string, number>();
    for (const a of accounts) assetBalances.set(a.id, dollarsToCents(dollarsById[a.id] ?? 0));
    return { accounts, assetBalances, liquidAccount: null, goals: [] };
  }

  it("draws the tax-efficient DEFAULT order: capital-gains → ordinary-income → tax-exempt", () => {
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 0),
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0),
    ];
    const st = state(accounts, { pretax: 10_000, taxexempt: 10_000, brokerage: 10_000 });
    // $5k need, no other income → the capital-gains brokerage is tapped first.
    const sources = buildWithdrawalSources(st, nullJurisdiction, 1, [], dollarsToCents(5_000), ctx);
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(5_000)); // drawn
    expect(st.assetBalances.get("pretax")).toBe(dollarsToCents(10_000)); // untouched
    expect(st.assetBalances.get("taxexempt")).toBe(dollarsToCents(10_000)); // untouched
    expect(sources).toHaveLength(1);
    expect(sources[0].taxCategory).toBe("capitalGains");
  });

  it("honors an explicit liquidation-order OVERRIDE (§16 overridable)", () => {
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("taxexempt", TAX_EXEMPT_TAX_PROFILE, 0),
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0),
    ];
    const st = state(accounts, { pretax: 10_000, taxexempt: 10_000, brokerage: 10_000 });
    // Override: draw tax-exempt FIRST (e.g. a bequest strategy) — the opposite of the default.
    const sources = buildWithdrawalSources(
      st,
      nullJurisdiction,
      1,
      [],
      dollarsToCents(5_000),
      ctx,
      ["taxExempt", "capitalGains", "ordinaryIncome"],
    );
    expect(st.assetBalances.get("taxexempt")).toBe(dollarsToCents(5_000)); // drawn first
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(10_000)); // untouched
    expect(sources[0].taxCategory).toBe("taxExempt");
  });

  it("honors forced RMDs first: an RMD source shrinks the need before any elective draw (§16)", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    const st = state(accounts, { brokerage: 10_000 });
    // A $3k forced RMD is already booked as income; the $5k obligation only needs a
    // $2k elective top-up from the brokerage (RMD counted first, no double-draw).
    const rmd: IncomeSourceMonth[] = [
      { ownerId: "p1", grossCents: dollarsToCents(3_000), taxCategory: "ordinaryIncome" },
    ];
    const sources = buildWithdrawalSources(
      st,
      nullJurisdiction,
      1,
      rmd,
      dollarsToCents(5_000),
      ctx,
    );
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(8_000)); // only $2k elective
    const electiveTotal = sources.reduce((s, x) => s + x.grossCents, 0);
    expect(electiveTotal).toBe(dollarsToCents(2_000));
  });

  it("exposes the tax-efficient default order as a named constant", () => {
    expect(DEFAULT_LIQUIDATION_ORDER).toEqual(["capitalGains", "ordinaryIncome", "taxExempt"]);
  });
});
