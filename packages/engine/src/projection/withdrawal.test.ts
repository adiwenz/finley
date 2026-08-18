import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import {
  nullJurisdiction,
  type Jurisdiction,
  type WithdrawalTaxBasis,
} from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { SimGoal, GoalDisposal } from "../goal/goal";
import { AmortizingLoan, SYNTHETIC_CARD_ID } from "../liability/liability";
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

/** Non-compounding by default (rate 0) so balances move only by withdrawal/deposit. */
function account(
  id: string,
  taxProfile: SimAccountTaxProfile,
  dollars: number,
  liquid = false,
  annualRate = 0,
): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: annualRate,
  });
}

function expense(monthlyDollars: number, startMonth = 0): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(startMonth, dollarsToCents(monthlyDollars), { type: "fixed" }, {
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
    expect(series.months[0].flows?.cashFlowIncomeByCategoryCents["ordinaryIncome"]).toBe(
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

  it("sizes decumulation against expenses PLUS debt — a payment income can't cover sells investments", () => {
    // Income exactly covers the expense, so a waterfall sized against expenses alone would draw
    // nothing. The loan payment is an automatically-funded obligation too: the shared waterfall
    // must size against the whole obligation total — expenses and debt together — and liquidate
    // the brokerage to fund the payment. This pins that the decumulation input derives from the
    // full obligation list, debt included, rather than from a parallel expenses-only scalar.
    const income: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(2_000), { type: "fixed" }, {
        baselineUnit: "monthly",
      }),
      ownerId: "p1",
    };
    // 0% APR, $12k over 12 months → a flat $1,000 payment, first due at month 1.
    const loan = new AmortizingLoan({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(12_000),
      apr: 0,
      termMonths: 12,
    });
    const series = simulateHousehold(
      baseInput(
        [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)],
        { incomeSeries: [income], expenseSeries: [expense(2_000)], liabilities: [loan] },
      ),
      nullJurisdiction,
    );
    // Month 0 originates the loan with no payment due, so income covers the expense outright.
    expect(series.months[0].accountBalancesCents["brokerage"]).toBe(dollarsToCents(100_000));
    // Month 1's $1,000 payment lands beyond income → exactly $1,000 comes out of the brokerage.
    expect(series.months[1].accountBalancesCents["brokerage"]).toBe(dollarsToCents(99_000));
    // Funded by liquidation, never by borrowing onto the synthetic shortfall card.
    expect(series.months[1].liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
    expect(series.months[1].isInsolvent).toBe(false);
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
      computeTaxByCategoryCents: () => ({}),
      computeTaxCents: () => 0, // never charged mid-year regardless; isolates the drawdown arithmetic
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
    expect(desiredWins.months[0].flows?.cashFlowIncomeByCategoryCents["ordinaryIncome"]).toBe(
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

  it("draws the need plus the month's tax instalment — the need alone, never a gross-up", () => {
    // Two things this pins apart, which a flat rate makes easy to confuse.
    //
    // NOT a gross-up: nothing here solves "sell enough that the sale's own tax still leaves
    // $2,000" at the moment of the draw. That recursion happens nowhere any more — settling a
    // year's balance in the FOLLOWING April is what removed the need for it.
    //
    // But the draw is not the bare $2,000 either. The year-start estimate now anticipates that
    // this household funds its living from a fully-taxable account, so it has an estimated
    // annual liability and charges a twelfth of it every month — and the waterfall that sizes
    // decumulation's gap has already docked that instalment from take-home, because otherwise the
    // instalment is exactly what the month leaves uncovered. So the draw is `need + instalment`,
    // an ADDITION of a separately-computed figure, not a multiplication of the need.
    const flatTax: Jurisdiction = {
      id: "flat-25",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
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
    const drawn = dollarsToCents(100_000) - series.months[0].accountBalancesCents["pretax"];
    const instalment = series.months[0].flows!.taxCents;
    expect(instalment).toBeGreaterThan(0);
    expect(drawn).toBe(dollarsToCents(2_000) + instalment);
    // Nothing was withheld from the draw itself: the whole $2,000 of need still reached the
    // expense, and the cash account — which the instalment would have had to raid had the gap
    // ignored it — is untouched at zero rather than overdrawn.
    expect(series.months[0].accountBalancesCents["cash"]).toBe(0);
  });

  it("draws exactly the need from a tax-exempt account too — same behavior, different category", () => {
    const flatTax: Jurisdiction = {
      id: "flat-25",
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
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
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, dollarsToCents(5_000), ctx);
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
      dollarsToCents(5_000),
      ctx,
      ["taxExempt", "taxable", "taxDeferred"],
    );
    expect(st.assetBalances.get("taxexempt")).toBe(dollarsToCents(5_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(10_000));
    expect(sources[0].taxCategory).toBe("taxExempt");
  });

  it("sells the shortfall it is handed and nothing more — income it does not model is already out", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    const st = state(accounts, { brokerage: 10_000 });
    // A $5k obligation with a $3k forced RMD already booked as income reaches this function as a
    // $2k shortfall: the waterfall that measured it counted the RMD, as it counts wages, a
    // benefit, a deferral and payroll tax. Nothing here re-derives any of that, which is why an
    // elective draw can never double-withdraw against a forced one.
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, dollarsToCents(2_000), ctx);
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(8_000));
    const electiveTotal = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(electiveTotal).toBe(dollarsToCents(2_000));
  });

  it("spends a cash account before selling anything taxable", () => {
    // The two untaxed-on-withdrawal categories, side by side. Cash is drawn first: its interest
    // was taxed the month it was credited, so holding it defers nothing — while every dollar of
    // pre-tax sold in its place is ordinary income the household did not have to realize.
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("cash", CASH_INTEREST_TAX_PROFILE, 0),
      account("roth", TAX_EXEMPT_TAX_PROFILE, 0),
    ];
    const st = state(accounts, { pretax: 10_000, cash: 10_000, roth: 10_000 });
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, dollarsToCents(5_000), ctx);
    expect(st.assetBalances.get("cash")).toBe(dollarsToCents(5_000));
    expect(st.assetBalances.get("pretax")).toBe(dollarsToCents(10_000));
    expect(st.assetBalances.get("roth")).toBe(dollarsToCents(10_000));
    expect(sources[0].taxCategory).toBe("taxedAtAccrual");
  });

  it("still keeps genuinely tax-free growth for last", () => {
    // The Roth is untouched until the cash AND the pre-tax account are gone: what is preserved by
    // holding it is real, which is exactly what is not true of the cash beside it.
    const accounts = [
      account("roth", TAX_EXEMPT_TAX_PROFILE, 0),
      account("cash", CASH_INTEREST_TAX_PROFILE, 0),
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
    ];
    const st = state(accounts, { roth: 10_000, cash: 4_000, pretax: 4_000 });
    buildWithdrawalSources(st, nullJurisdiction, dollarsToCents(9_000), ctx);
    expect(st.assetBalances.get("cash")).toBe(0);
    expect(st.assetBalances.get("pretax")).toBe(0);
    expect(st.assetBalances.get("roth")).toBe(dollarsToCents(9_000));
  });

  it("ranks on what an account DEFERS, not on what its withdrawal is taxed as", () => {
    // An annuity-like account: it pays ordinary income, exactly as a 401(k) does, out of principal
    // that was already taxed. Same withdrawal category as the pre-tax account, opposite treatment
    // — and the order follows the treatment, drawing it first and leaving the 401(k) whole.
    //
    // Under the old ranking these two shared a category and therefore a rank, and which one got
    // drained came down to roster order. That is the failure this decoupling exists to make
    // impossible; it is not hypothetical, it is what stranded a cash goal fund behind a
    // retirement account.
    const alreadyTaxed: SimAccountTaxProfile = {
      withdrawalCategory: "ordinaryIncome",
      taxTreatment: "taxedAtAccrual",
      contributionsPreTax: false,
      forcedDistributionEligible: false,
    };
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("annuity", alreadyTaxed, 0),
    ];
    const st = state(accounts, { pretax: 10_000, annuity: 10_000 });
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, dollarsToCents(4_000), ctx);
    expect(st.assetBalances.get("annuity")).toBe(dollarsToCents(6_000));
    expect(st.assetBalances.get("pretax")).toBe(dollarsToCents(10_000));
    // The flow is still reported as what it IS — ordinary income, for the brackets to price.
    expect(sources[0].taxCategory).toBe("ordinaryIncome");
  });

  it("exposes the tax-efficient default order as a named constant", () => {
    // Account TREATMENTS, not withdrawal categories: cash first (its return was already taxed at
    // accrual, so holding it defers nothing), genuinely tax-free growth last.
    expect(DEFAULT_LIQUIDATION_ORDER).toEqual([
      "taxedAtAccrual",
      "taxable",
      "taxDeferred",
      "taxExempt",
    ]);
  });
});

describe("Decumulation draws carry the full withdrawal breakdown", () => {
  const ctx = { year: 2026 };

  /** 25% on realized capital gain, with pro-rata basis recovery so a draw books only its gain. */
  const capGainsTax: Jurisdiction = {
    id: "capgains-25",
    computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * 0.25),
    computeTaxByCategoryCents: (byCat) => {
      const t = Math.round((byCat.capitalGains ?? 0) * 0.25);
      return t > 0 ? { capitalGains: t } : {};
    },
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }: WithdrawalTaxBasis) =>
      balanceCents <= 0
        ? grossCents
        : Math.round((grossCents * (balanceCents - basisCents)) / balanceCents),
  };

  function stateWithBasis(acc: SimAccount, balanceDollars: number, basisDollars: number): WithdrawalState {
    return {
      accounts: [acc],
      assetBalances: new Map([[acc.id, dollarsToCents(balanceDollars)]]),
      basisByAccount: new Map([[acc.id, dollarsToCents(basisDollars)]]),
      liquidAccount: null,
    };
  }

  it("reports gross, returned principal, realized gain and net for an appreciated draw — no gross-up", () => {
    // $10k balance against a $4k basis: 60% of any liquidation is realized gain. No gross-up:
    // this is an ordinary mid-year draw, and federal income tax is never charged against it
    // here (it settles once, annually, in December) — so exactly the need is sold.
    const brokerage = account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 10_000);
    const st = stateWithBasis(brokerage, 10_000, 4_000);
    const needCents = dollarsToCents(3_000);
    const { decumulationDraws } = buildWithdrawalSources(st, capGainsTax, needCents, ctx);

    expect(decumulationDraws).toHaveLength(1);
    const draw = decumulationDraws[0];
    expect(draw.sourceId).toBe("brokerage");

    // Exactly the need is sold — gross == net == need, no gross-up.
    expect(draw.grossWithdrawnCents).toBe(needCents);
    expect(draw.netDeliveredCents).toBe(needCents);
    expect(draw.taxCents).toBe(0);

    // Internal identities: gross = principal + gain, net = gross (nothing charged here).
    expect(draw.principalCents + draw.realizedGainCents).toBe(draw.grossWithdrawnCents);
    expect(draw.grossWithdrawnCents).toBe(draw.netDeliveredCents);

    // Gross matches the account balance reduction; principal matches the basis reduction.
    expect(draw.grossWithdrawnCents).toBe(dollarsToCents(10_000) - (st.assetBalances.get("brokerage") ?? 0));
    expect(draw.principalCents).toBe(dollarsToCents(4_000) - (st.basisByAccount.get("brokerage") ?? 0));

    // The realized gain (60% of the $3k draw) is still tracked — it feeds the year's taxable-
    // income accumulator — even though it is not charged here.
    expect(draw.realizedGainCents).toBe(Math.round(needCents * 0.6));
  });

  it("reports zero gain and zero tax for a cash-like draw, using the same shape", () => {
    // basis == balance ⇒ no gain, so nothing is taxed — but the breakdown is still fully populated.
    const savings = account("savings", CAPITAL_GAINS_TAX_PROFILE, 10_000);
    const st = stateWithBasis(savings, 10_000, 10_000);
    const { decumulationDraws } = buildWithdrawalSources(st, capGainsTax, dollarsToCents(3_000), ctx);

    expect(decumulationDraws[0]).toEqual({
      sourceId: "savings",
      grossWithdrawnCents: dollarsToCents(3_000),
      principalCents: dollarsToCents(3_000),
      realizedGainCents: 0,
      taxCents: 0,
      netDeliveredCents: dollarsToCents(3_000),
    });
  });
});

describe("Early-withdrawal penalty on a pre-tax draw", () => {
  const ctx = { year: 2026 };

  /** Flat 10% on the taxable portion of an ordinary-income draw before 59½ — the US-2026 shape. */
  const penaltyJurisdiction: Jurisdiction = {
    id: "penalty-10",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    earlyWithdrawalPenaltyCents: (basis, wctx) =>
      basis.category === "ordinaryIncome" && wctx.age < 59.5
        ? Math.round(basis.grossCents * 0.1)
        : 0,
  };

  function stateWithOwner(
    accounts: SimAccount[],
    dollarsById: Record<string, number>,
    birthYear?: number,
  ): WithdrawalState {
    const assetBalances = new Map<string, number>();
    for (const a of accounts) assetBalances.set(a.id, dollarsToCents(dollarsById[a.id] ?? 0));
    return {
      accounts,
      assetBalances,
      basisByAccount: new Map(),
      liquidAccount: null,
      ...(birthYear === undefined
        ? {}
        : { personsById: new Map([["p1", { id: "p1", name: "You", birthYear }]]) }),
    };
  }

  it("charges the jurisdiction's penalty and draws more from the next account so the household still nets the need", () => {
    const accounts = [
      account("pretax", PRE_TAX_TAX_PROFILE, 0),
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0),
    ];
    const st = stateWithOwner(accounts, { pretax: 10_000, brokerage: 10_000 }, 2026 - 35);
    const { decumulationDraws } = buildWithdrawalSources(
      st,
      penaltyJurisdiction,
      dollarsToCents(1_000),
      ctx,
      ["taxDeferred", "taxable"],
    );

    const pretaxDraw = decumulationDraws.find((d) => d.sourceId === "pretax");
    expect(pretaxDraw?.grossWithdrawnCents).toBe(dollarsToCents(1_000));
    expect(pretaxDraw?.taxCents).toBe(dollarsToCents(100));
    expect(pretaxDraw?.netDeliveredCents).toBe(dollarsToCents(900));

    // The $100 lost to the penalty is made up from the next account in line.
    const brokerageDraw = decumulationDraws.find((d) => d.sourceId === "brokerage");
    expect(brokerageDraw?.grossWithdrawnCents).toBe(dollarsToCents(100));
    expect(brokerageDraw?.taxCents).toBe(0);

    const totalNet = decumulationDraws.reduce((s, d) => s + d.netDeliveredCents, 0);
    expect(totalNet).toBe(dollarsToCents(1_000));
  });

  it("charges nothing at or past the jurisdiction's access age", () => {
    const accounts = [account("pretax", PRE_TAX_TAX_PROFILE, 0)];
    const st = stateWithOwner(accounts, { pretax: 10_000 }, 2026 - 60);
    const { decumulationDraws } = buildWithdrawalSources(st, penaltyJurisdiction, dollarsToCents(1_000), ctx);
    expect(decumulationDraws[0].taxCents).toBe(0);
    expect(decumulationDraws[0].netDeliveredCents).toBe(dollarsToCents(1_000));
  });

  it("charges nothing when the account owner's age cannot be determined", () => {
    const accounts = [account("pretax", PRE_TAX_TAX_PROFILE, 0)];
    const st = stateWithOwner(accounts, { pretax: 10_000 });
    const { decumulationDraws } = buildWithdrawalSources(st, penaltyJurisdiction, dollarsToCents(1_000), ctx);
    expect(decumulationDraws[0].taxCents).toBe(0);
  });

  it("never charges a non-pre-tax account, whatever the owner's age", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    const st = stateWithOwner(accounts, { brokerage: 10_000 }, 2026 - 35);
    const { decumulationDraws } = buildWithdrawalSources(st, penaltyJurisdiction, dollarsToCents(1_000), ctx);
    expect(decumulationDraws[0].taxCents).toBe(0);
  });
});

describe("Decumulation reporting splits realized gain from returned principal (#122)", () => {
  /** Pro-rata capital gains, no tax — isolates the income/drawdown split from tax cash flow. */
  const proRataGains: Jurisdiction = {
    id: "prorata-gains",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }: WithdrawalTaxBasis) =>
      balanceCents <= 0 ? grossCents : Math.round((grossCents * (balanceCents - basisCents)) / balanceCents),
  };

  it("reports only the realized gain as capital-gains income and the returned principal as the account's own principal-drawdown band", () => {
    // Brokerage opens at $10k (basis == balance). One month of 100% growth before the expense
    // hits leaves it at $20k balance / $10k basis — a clean 50% gain fraction — so the $4,000
    // withdrawal in month 1 splits evenly: $2,000 gain, $2,000 returned principal.
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 10_000, false, 4095),
        ],
        { expenseSeries: [expense(4_000, 1)] },
      ),
      proRataGains,
    );
    // Confirms the setup reaches the intended 50% gain fraction before asserting the split.
    expect(series.months[0].accountBalancesCents["brokerage"]).toBe(dollarsToCents(20_000));
    expect(series.months[0].accountBasisCents["brokerage"]).toBe(dollarsToCents(10_000));

    const flows = series.months[1].flows!;
    expect(flows.cashFlowIncomeByCategoryCents["capitalGains"]).toBe(dollarsToCents(2_000));
    const investmentDrawdown = flows.incomeSources.find((s) => s.sourceId === "brokerage:principal");
    expect(investmentDrawdown?.cashInflowCents).toBe(dollarsToCents(2_000));
    expect(investmentDrawdown?.label).toBe("brokerage (principal)");
    // The full $4,000 need still reached the household — the waterfall lost nothing.
    expect(
      flows.cashFlowIncomeByCategoryCents["capitalGains"]! +
        (investmentDrawdown?.cashInflowCents ?? 0),
    ).toBe(dollarsToCents(4_000));
  });

  it("splits a tax-exempt (Roth-style) withdrawal the same way — genuinely untaxed growth is still reported income, per the account's own category", () => {
    // Mirrors the brokerage case above with a Roth-style account instead: `buildWithdrawalSources`
    // reads `principalCents`/`realizedGainCents` off basis alone, with no category check, so a
    // tax-exempt account past its basis splits identically — the growth bands under its own
    // `taxExempt` category rather than `capitalGains`, and the basis returns as investment
    // principal drawdown.
    const series = simulateHousehold(
      baseInput(
        [
          account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
          account("roth", TAX_EXEMPT_TAX_PROFILE, 10_000, false, 4095),
        ],
        { expenseSeries: [expense(4_000, 1)] },
      ),
      proRataGains,
    );
    expect(series.months[0].accountBalancesCents["roth"]).toBe(dollarsToCents(20_000));
    expect(series.months[0].accountBasisCents["roth"]).toBe(dollarsToCents(10_000));

    const flows = series.months[1].flows!;
    expect(flows.cashFlowIncomeByCategoryCents["taxExempt"]).toBe(dollarsToCents(2_000));
    const investmentDrawdown = flows.incomeSources.find((s) => s.sourceId === "roth:principal");
    expect(investmentDrawdown?.cashInflowCents).toBe(dollarsToCents(2_000));
    expect(investmentDrawdown?.label).toBe("roth (principal)");
  });

  it("reports no capital-gains income for a basis-only (no-gain) brokerage withdrawal", () => {
    const series = simulateHousehold(
      baseInput(
        [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 10_000)],
        { expenseSeries: [expense(3_000)] },
      ),
      proRataGains,
    );
    const flows = series.months[0].flows!;
    expect(flows.cashFlowIncomeByCategoryCents["capitalGains"]).toBe(0);
    const investmentDrawdown = flows.incomeSources.find((s) => s.sourceId === "brokerage:principal");
    expect(investmentDrawdown?.cashInflowCents).toBe(dollarsToCents(3_000));
  });

  it("still reports a retirement-account withdrawal as full retirement income (unaffected)", () => {
    const series = simulateHousehold(
      baseInput([account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
        expenseSeries: [expense(2_000)],
      }),
      proRataGains,
    );
    const flows = series.months[0].flows!;
    expect(flows.cashFlowIncomeByCategoryCents["ordinaryIncome"]).toBe(dollarsToCents(2_000));
    expect(flows.incomeSources.find((s) => s.sourceId === "savings-drawdown")).toBeUndefined();
  });
});

describe("No draw is ever grossed up — ordinary decumulation sells exactly the need", () => {
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

  // A steep, cliff-shaped tax that would once have forced a large gross-up climb — a
  // regression guard that no jurisdiction shape, however punishing, changes what gets sold:
  // federal income tax is never charged against an ordinary mid-year draw at all now. The gain
  // joins the year's taxable income, the year closes in December, and whatever the year's
  // instalments did not cover settles the following April (taxYearSettlement.ts).
  const steepCliff: Jurisdiction = {
    id: "steep-cliff",
    computeTaxByCategoryCents: () => ({}),
    computeTaxCents: (byCat) => (byCat.capitalGains ?? 0) > dollarsToCents(500) ? dollarsToCents(44_000) : 0,
  };

  it("sells exactly the need under a punishing flat-rate jurisdiction, ignoring the rate entirely", () => {
    const flatGains: Jurisdiction = {
      id: "flat-gains-20",
      computeTaxByCategoryCents: () => ({}),
      computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * 0.2),
    };
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 100_000)];
    const st = state(accounts, { brokerage: 100_000 });
    const { sources } = buildWithdrawalSources(st, flatGains, dollarsToCents(2_000), ctx);
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(2_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(98_000));
  });

  it("sells exactly the need even against a jurisdiction with a punishing tax cliff", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 500_000)];
    const st = state(accounts, { brokerage: 500_000 });
    const { sources } = buildWithdrawalSources(st, steepCliff, dollarsToCents(1_000), ctx);
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(1_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(499_000));
  });

  it("spills to the next source once an account's balance is exhausted, never over-selling to cover a tax that is never charged here", () => {
    const accounts = [
      account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 1_000),
      account("pretax", PRE_TAX_TAX_PROFILE, 100_000),
    ];
    const st = state(accounts, { brokerage: 1_000, pretax: 100_000 });
    const { sources } = buildWithdrawalSources(st, steepCliff, dollarsToCents(10_000), ctx);

    expect(st.assetBalances.get("brokerage")).toBe(0);
    // Exactly the $9,000 remainder comes from pre-tax — no gross-up inflates it.
    expect(st.assetBalances.get("pretax")).toBe(dollarsToCents(100_000 - 9_000));
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(10_000));
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
    const { sources } = buildWithdrawalSources(st, flatGains20, dollarsToCents(2_000), ctx);
    // No gain → no tax → no gross-up.
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(2_000));
    expect(sources[0].taxableCents).toBe(0);
    // Basis fell by the principal returned: $100k − $2k.
    expect(st.basisByAccount.get("brokerage")).toBe(dollarsToCents(98_000));
  });

  it("books only the gain fraction for a partially-appreciated account — exactly the need is sold, no gross-up", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    // $100k balance on $60k basis → 40% of any draw is gain.
    const st = state(accounts, { brokerage: 100_000 }, { brokerage: 60_000 });
    const { sources } = buildWithdrawalSources(st, flatGains20, dollarsToCents(6_000), ctx);
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(6_000));
    const gain = sources.reduce((s, x) => s + (x.taxableCents ?? x.waterfallInflowCents), 0);
    expect(gain).toBe(Math.round(drawn * 0.4));
    // Basis fell only by the principal fraction (60%).
    const basisDrawn = dollarsToCents(60_000) - (st.basisByAccount.get("brokerage") ?? 0);
    expect(basisDrawn).toBe(drawn - gain);
  });

  it("leaves a pre-tax draw fully taxable (basis 0 → gain == gross), exactly the need, no gross-up", () => {
    const accounts = [account("pretax", PRE_TAX_TAX_PROFILE, 0)];
    const flatOrdinary20: Jurisdiction = {
      id: "flat-ord-20",
      computeTaxByCategoryCents: () => ({}),
      computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.2),
    };
    // No basis entry → basis 0 → the whole draw is gain.
    const st = state(accounts, { pretax: 100_000 });
    const { sources } = buildWithdrawalSources(st, flatOrdinary20, dollarsToCents(2_000), ctx);
    const drawn = sources.reduce((s, x) => s + x.waterfallInflowCents, 0);
    expect(drawn).toBe(dollarsToCents(2_000));
    expect(sources[0].taxableCents).toBe(drawn);
  });

  it("returns basis pro-rata so a later draw's gain fraction tracks the basis that remains", () => {
    const accounts = [account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 0)];
    // $100k balance / $50k basis → 50% gain fraction; no tax seam, to isolate arithmetic.
    const st = state(accounts, { brokerage: 100_000 }, { brokerage: 50_000 });
    const { sources: first } = buildWithdrawalSources(st, proRataNoTax, dollarsToCents(20_000), ctx);
    // Drew $20k: $10k gain booked, $10k basis returned → $40k basis on $80k balance.
    expect(first[0].taxableCents).toBe(dollarsToCents(10_000));
    expect(st.assetBalances.get("brokerage")).toBe(dollarsToCents(80_000));
    expect(st.basisByAccount.get("brokerage")).toBe(dollarsToCents(40_000));
    // The gain fraction held at 50%.
    const { sources: second } = buildWithdrawalSources(st, proRataNoTax, dollarsToCents(20_000), ctx);
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
      dollarsToCents(5_000),
      ctx,
    );
    expect(liquidDrawdownCents).toBe(dollarsToCents(2_000));
    expect(sources).toHaveLength(1);
    expect(sources[0].waterfallInflowCents).toBe(dollarsToCents(3_000)); // no tax seam → one-for-one
  });

  it("reports no drawdown when income already covers the month", () => {
    const st = stateWithCash(10_000, 100_000);
    // A covered month is a shortfall of 0 — the buffer is not touched, so a household whose pay
    // clears its bills does not show a savings drawdown band.
    const { sources, liquidDrawdownCents } = buildWithdrawalSources(st, nullJurisdiction, 0, ctx);
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
    const { sources } = buildWithdrawalSources(st, nullJurisdiction, dollarsToCents(5_000), ctx);
    expect(sources[0].sourceId).toBe("brokerage");
    expect(sources[0].label).toBe("Brokerage draw");
  });
});
