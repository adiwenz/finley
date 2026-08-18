/**
 * The annual funding forecast in isolation: given a year's need and the accounts in the
 * waterfall's own draw order, which accounts pay for it and how much taxable income that
 * realizes. The projection-level consequences are in `federalIncomeTax.test.ts`; these pin the
 * arithmetic and the seams.
 */
import { describe, it, expect } from "vitest";
import { dollarsToCents, preciseMonthlyRate } from "../money/cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE, SimAccount } from "../plan/simAccount";
import {
  evenMonthlyShares,
  forecastFundingDraws,
  type ForecastAccount,
} from "./fundingForecast";
import { orderedLiquidationAccounts, DEFAULT_LIQUIDATION_ORDER } from "./withdrawal";

const CTX = { year: 2026 };

/** Twelve months of one annual rate, the same figures `SimAccount.getMonthlyRateAt` returns. */
const rates = (annualRate: number): number[] =>
  Array.from({ length: 12 }, () => preciseMonthlyRate(annualRate));

/** An account that does not grow — stated in twelve zeroes, because the type has no default. */
const FLAT = rates(0);

/** A year's need with nothing said about its timing: twelve equal months. */
const evenly = (annualDollars: number): number[] =>
  evenMonthlyShares(dollarsToCents(annualDollars));

/** Pro-rata return of capital — what a real jurisdiction supplies through the seam. */
const proRata: Jurisdiction = {
  ...nullJurisdiction,
  id: "pro-rata",
  taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) =>
    grossCents -
    Math.round(grossCents * (balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0)),
};

function acct(
  id: string,
  category: ForecastAccount["category"],
  dollars: number,
  basisDollars: number,
  liquidBuffer = false,
  monthlyRates: readonly number[] = FLAT,
  age?: number,
): ForecastAccount {
  return {
    id,
    ownerId: "p1",
    category,
    balanceCents: dollarsToCents(dollars),
    basisCents: dollarsToCents(basisDollars),
    monthlyRates,
    ...(liquidBuffer ? { liquidBuffer } : {}),
    ...(age === undefined ? {} : { age }),
  };
}

describe("forecastFundingDraws — how a year's shortfall gets paid for", () => {
  it("takes each account in turn, exactly what is left of the need", () => {
    const draws = forecastFundingDraws(
      evenly(50_000),
      [acct("cash", "capitalGains", 10_000, 10_000, true), acct("pretax", "ordinaryIncome", 100_000, 0)],
      proRata,
      CTX,
    ).draws;
    expect(draws.map((d) => [d.accountId, d.grossCents])).toEqual([
      ["cash", dollarsToCents(10_000)],
      ["pretax", dollarsToCents(40_000)],
    ]);
  });

  it("stops as soon as the need is covered, leaving later accounts untouched", () => {
    const { draws, unfundedCents } = forecastFundingDraws(
      evenly(5_000),
      [acct("cash", "capitalGains", 10_000, 10_000, true), acct("pretax", "ordinaryIncome", 100_000, 0)],
      proRata,
      CTX,
    );
    expect(draws).toHaveLength(1);
    expect(unfundedCents).toBe(0);
  });

  it("prices the taxable slice through the jurisdiction's own basis seam", () => {
    // A brokerage half basis: half the draw is a return of capital, half is gain. A pre-tax
    // account has no basis at all, so the whole draw is taxable.
    const draws = forecastFundingDraws(
      evenly(30_000),
      [acct("brokerage", "capitalGains", 20_000, 10_000), acct("pretax", "ordinaryIncome", 50_000, 0)],
      proRata,
      CTX,
    ).draws;
    expect(draws[0]!.taxableCents).toBe(dollarsToCents(10_000));
    expect(draws[1]!).toMatchObject({
      grossCents: dollarsToCents(10_000),
      taxableCents: dollarsToCents(10_000),
    });
  });

  it("treats the whole draw as taxable when the jurisdiction declines the seam", () => {
    // Matching `buildWithdrawalSources`, the channel this forecasts — NOT the pro-rata split the
    // explicit-funding path falls back to. Under a seamless jurisdiction that split would read a
    // full-basis brokerage draw as tax-free and under-estimate the year by its whole balance.
    const draws = forecastFundingDraws(
      evenly(20_000),
      [acct("brokerage", "capitalGains", 20_000, 20_000)],
      nullJurisdiction,
      CTX,
    ).draws;
    expect(draws[0]!.taxableCents).toBe(dollarsToCents(20_000));
  });

  it("realizes nothing on the liquid buffer, which is spent as cash rather than sold", () => {
    // `buildWithdrawalSources` covers its gap from the liquid account directly
    // (`liquidDrawdownCents`) and never books an income source for it. A forecast that priced a
    // gain on it would invent taxable income the year will never have — and under a seamless
    // jurisdiction it would invent the entire balance.
    const draws = forecastFundingDraws(
      evenly(10_000),
      [acct("cash", "capitalGains", 10_000, 0, true)],
      nullJurisdiction,
      CTX,
    ).draws;
    expect(draws[0]!.grossCents).toBe(dollarsToCents(10_000));
    expect(draws[0]!.taxableCents).toBe(0);
  });

  it("reports what the accounts could not cover rather than over-drawing them", () => {
    const { draws, unfundedCents } = forecastFundingDraws(
      evenly(30_000),
      [acct("pretax", "ordinaryIncome", 12_000, 0)],
      proRata,
      CTX,
    );
    expect(draws[0]!.grossCents).toBe(dollarsToCents(12_000));
    expect(unfundedCents).toBe(dollarsToCents(18_000));
  });

  it("forecasts nothing for a household with no shortfall", () => {
    // A surplus year: the tax comes out of income, and no investment is sold to pay it.
    for (const need of [evenly(0), evenly(-50_000)]) {
      expect(forecastFundingDraws(need, [acct("pretax", "ordinaryIncome", 100_000, 0)], proRata, CTX))
        .toEqual({ draws: [], unfundedCents: 0 });
    }
  });

  it("skips an account that holds nothing instead of landing it as a zero draw", () => {
    const draws = forecastFundingDraws(
      evenly(5_000),
      [acct("drained", "capitalGains", 0, 0), acct("pretax", "ordinaryIncome", 100_000, 0)],
      proRata,
      CTX,
    ).draws;
    expect(draws.map((d) => d.accountId)).toEqual(["pretax"]);
  });
});

describe("forecastFundingDraws — early-withdrawal penalty", () => {
  /** Flat 10% on the taxable portion of an ordinary-income draw before 59½ — the US-2026 shape. */
  const penaltyJurisdiction: Jurisdiction = {
    ...proRata,
    id: "penalty-10",
    earlyWithdrawalPenaltyCents: (basis, ctx) =>
      basis.category === "ordinaryIncome" && ctx.age < 59.5 ? Math.round(basis.grossCents * 0.1) : 0,
  };

  it("forecasts the penalty WITHOUT touching the account's forecast draw — never pulls extra from the next account", () => {
    const { draws, unfundedCents } = forecastFundingDraws(
      evenly(12_000),
      [
        acct("pretax", "ordinaryIncome", 100_000, 0, false, FLAT, 35),
        acct("brokerage", "capitalGains", 100_000, 100_000, false, FLAT, 35),
      ],
      penaltyJurisdiction,
      CTX,
    );
    // The pretax account sells exactly the $12,000 need, fully forecast — the $1,200 penalty is
    // reported on it but never treated as leakage the brokerage has to cover, exactly like the
    // real draw (`buildWithdrawalSources`/`resolveOrderedFundingDraw`).
    expect(draws).toEqual([
      {
        accountId: "pretax",
        ownerId: "p1",
        category: "ordinaryIncome",
        grossCents: dollarsToCents(12_000),
        taxableCents: dollarsToCents(12_000),
        earlyWithdrawalPenaltyCents: dollarsToCents(1_200),
      },
    ]);
    expect(unfundedCents).toBe(0);
  });

  it("forecasts no penalty once the account's forecast age clears the jurisdiction's threshold", () => {
    const draws = forecastFundingDraws(
      evenly(12_000),
      [acct("pretax", "ordinaryIncome", 100_000, 0, false, FLAT, 60)],
      penaltyJurisdiction,
      CTX,
    ).draws;
    expect(draws).toEqual([
      {
        accountId: "pretax",
        ownerId: "p1",
        category: "ordinaryIncome",
        grossCents: dollarsToCents(12_000),
        taxableCents: dollarsToCents(12_000),
        earlyWithdrawalPenaltyCents: 0,
      },
    ]);
  });

  it("forecasts no penalty when the account carries no age", () => {
    const draws = forecastFundingDraws(
      evenly(12_000),
      [acct("pretax", "ordinaryIncome", 100_000, 0)],
      penaltyJurisdiction,
      CTX,
    ).draws;
    expect(draws[0]!.grossCents).toBe(dollarsToCents(12_000));
    expect(draws[0]!.earlyWithdrawalPenaltyCents).toBe(0);
  });
});

describe("forecastFundingDraws — growth earned before depletion", () => {
  const growing = (dollars: number, annualRate: number): ForecastAccount =>
    acct("pretax", "ordinaryIncome", dollars, 0, false, rates(annualRate));

  /**
   * The default plan's final decumulation year, measured off the simulator: the retirement account
   * opened January 2075 holding $82,092.22 and paid out $84,568.18 before it emptied — $2,475.96
   * more than it ever held at once, because it went on earning 7% on whatever was not yet spent.
   * A forecast capped at the opening balance was short by that whole $2,475.96, and the tax on it
   * arrived as a lone spike the following April.
   */
  const OPENING_CENTS = 82_092_22;
  const ACTUAL_DRAWN_CENTS = 84_568_18;
  const OLD_CAP_MISS_CENTS = ACTUAL_DRAWN_CENTS - OPENING_CENTS;

  it("draws past the opening balance, and misses the simulator by far less than the cap did", () => {
    // Two behavioural claims, no third-decimal-place agreement with the simulator: this is a
    // forecast of a household whose real spending is not exactly a twelfth a month, and December
    // remains authoritative about the year's tax either way.
    const need = evenly(90_000);
    const grown = forecastFundingDraws(
      need,
      [{ ...growing(0, 0.07), balanceCents: OPENING_CENTS }],
      proRata,
      CTX,
    );
    const gross = grown.draws[0]!.grossCents;

    // 1. Intra-year growth makes it possible to fund more than January held, so the forecast does.
    expect(gross).toBeGreaterThan(OPENING_CENTS);
    // 2. And what remains of the old cap's miss is a small fraction of it — an order of magnitude,
    //    not a nudge. Asserted against the cap's own error rather than a tolerance picked to fit.
    expect(Math.abs(gross - ACTUAL_DRAWN_CENTS)).toBeLessThan(OLD_CAP_MISS_CENTS / 10);

    // Every dollar of it taxable: a pre-tax account carries no basis.
    expect(grown.draws[0]!.taxableCents).toBe(gross);
    // The residue is honestly reported rather than conjured out of a balance that never existed.
    expect(grown.unfundedCents).toBe(dollarsToCents(90_000) - gross);
  });

  it("cannot fund from growth that has not happened yet", () => {
    // The other side of the same coin, and why the need's shape matters: asked for the whole year
    // in January, the account can supply only what it holds in January. Growth is not a larger
    // balance, it is a balance that gets larger — spending it in month one forgoes it.
    const january = [dollarsToCents(90_000), ...Array.from({ length: 11 }, () => 0)];
    const lump = forecastFundingDraws(
      january,
      [{ ...growing(0, 0.07), balanceCents: OPENING_CENTS }],
      proRata,
      CTX,
    );
    expect(lump.draws[0]!.grossCents).toBe(OPENING_CENTS);
  });

  it("stops compounding an account once it is drained", () => {
    // A $10k account against a $50k need, at a rate absurd enough that the difference cannot
    // hide: 100% a year. Spread evenly the need takes ~$4,167 a month, so the account survives
    // into its third month and earns growth on what is left each time — but the moment it is
    // empty it must stop earning, and the eleven months that follow must add nothing.
    const drained = forecastFundingDraws(
      evenly(50_000),
      [growing(10_000, 1.0)],
      proRata,
      CTX,
    );
    const gross = drained.draws[0]!.grossCents;
    // More than it opened with, because two months' growth landed before it ran dry...
    expect(gross).toBeGreaterThan(dollarsToCents(10_000));
    // ...and nowhere near the $20,000 a full year of doubling would have supplied. A forecast
    // that went on compounding a spent balance would land there instead.
    expect(gross).toBeLessThan(dollarsToCents(11_000));
    expect(drained.unfundedCents).toBe(dollarsToCents(50_000) - gross);
  });

  it("leaves a household whose accounts comfortably cover the year unaffected", () => {
    // Growth only ever moves the CAP. Where the need binds instead, the forecast is the same
    // figure with or without rates — so this changes nothing for the years before exhaustion.
    const need = evenly(40_000);
    const flat = forecastFundingDraws(need, [acct("pretax", "ordinaryIncome", 500_000, 0)], proRata, CTX);
    const grown = forecastFundingDraws(need, [growing(500_000, 0.07)], proRata, CTX);
    expect(grown.draws[0]!.grossCents).toBe(flat.draws[0]!.grossCents);
    expect(grown.draws[0]!.grossCents).toBe(dollarsToCents(40_000));
  });

  it("spends a growing account in waterfall order, cash before investments", () => {
    // Order is not renegotiated by growth: the liquid buffer still goes first and still realizes
    // nothing, and only what it cannot cover reaches the account behind it.
    const { draws } = forecastFundingDraws(
      evenly(30_000),
      [acct("cash", "taxedAtAccrual", 12_000, 0, true, rates(0.01)), growing(500_000, 0.07)],
      proRata,
      CTX,
    );
    expect(draws.map((d) => d.accountId)).toEqual(["cash", "pretax"]);
    expect(draws[0]!.taxableCents).toBe(0);
    // The cash buffer covers its own balance plus the pennies of interest it earned on the way.
    expect(draws[0]!.grossCents).toBeGreaterThan(dollarsToCents(12_000));
    expect(draws[0]!.grossCents + draws[1]!.grossCents).toBe(dollarsToCents(30_000));
  });
});

describe("forecastFundingDraws — the shape of the year's need", () => {
  /** A single month's need, everything else zero — a home purchase, or a one-time spend. */
  const inMonth = (index: number, dollars: number): number[] =>
    Array.from({ length: 12 }, (_, m) => (m === index ? dollarsToCents(dollars) : 0));

  it("realizes a lump sum's gain against the month it actually falls in", () => {
    // $60,000 out of a growing brokerage, once in March against month by month. Under pro-rata the
    // basis fraction is fixed only while the balance is; growth lifts the balance and not the
    // basis, so dollars drawn later are a larger share gain. The timing is not cosmetic — it is
    // the difference between two different taxable incomes, and only one of them is the plan's.
    const brokerage = (): ForecastAccount =>
      acct("brokerage", "capitalGains", 200_000, 100_000, false, rates(0.10));

    const march = forecastFundingDraws(inMonth(2, 60_000), [brokerage()], proRata, CTX);
    const spread = forecastFundingDraws(evenly(60_000), [brokerage()], proRata, CTX);

    expect(march.draws[0]!.grossCents).toBe(spread.draws[0]!.grossCents);
    // Same dollars sold, different gain realized — which is exactly what averaging hid.
    expect(march.draws[0]!.taxableCents).not.toBe(spread.draws[0]!.taxableCents);
    expect(spread.draws[0]!.taxableCents).toBeGreaterThan(march.draws[0]!.taxableCents);
  });

  it("carries a surplus month forward instead of selling into the month it runs short", () => {
    // April costs $12,000 more than it earns; May earns $12,000 more than it costs. The household
    // does not sell $12,000 of stock in April and bank the proceeds in May — but a forecast that
    // clamped each month at zero would say it did, and would tax the sale.
    const lean = [...Array.from({ length: 3 }, () => 0), dollarsToCents(12_000), -dollarsToCents(12_000),
      ...Array.from({ length: 7 }, () => 0)];
    const forecast = forecastFundingDraws(lean, [acct("pretax", "ordinaryIncome", 500_000, 0)], proRata, CTX);
    expect(forecast.draws[0]!.grossCents).toBe(dollarsToCents(12_000));

    // Reverse the two months and the surplus arrives FIRST, so nothing is ever sold.
    const flush = [...Array.from({ length: 3 }, () => 0), -dollarsToCents(12_000), dollarsToCents(12_000),
      ...Array.from({ length: 7 }, () => 0)];
    expect(forecastFundingDraws(flush, [acct("pretax", "ordinaryIncome", 500_000, 0)], proRata, CTX))
      .toEqual({ draws: [], unfundedCents: 0 });
  });

  it("forecasts the draw a lumpy year needs even though the year totals to a surplus", () => {
    // A $40,000 one-time spend in February against $50,000 of surplus spread over the year. The
    // annual total is a $10,000 surplus — the old scalar need would have forecast no sale at all —
    // but February still has to be paid for, and the sale it takes is taxable in this year.
    const need = inMonth(1, 40_000).map((cents) => cents - dollarsToCents(50_000 / 12));
    expect(need.reduce((t, c) => t + c, 0)).toBeLessThan(0);

    const { draws } = forecastFundingDraws(need, [acct("pretax", "ordinaryIncome", 500_000, 0)], proRata, CTX);
    // $40,000 less the two months of surplus that have actually arrived by February — January's
    // and February's own. The other ten months' surplus is still in the future and cannot pay for
    // anything; that it eventually turns the year positive is beside the point in February.
    expect(draws[0]!.grossCents).toBe(dollarsToCents(40_000) - 2 * dollarsToCents(50_000 / 12));
    expect(draws[0]!.taxableCents).toBe(draws[0]!.grossCents);
  });
});

describe("orderedLiquidationAccounts — the one order every money-out path drains in", () => {
  const of = (id: string, preTax: boolean): SimAccount =>
    new SimAccount({
      id,
      ownerId: "p1",
      liquid: false,
      taxProfile: preTax ? PRE_TAX_TAX_PROFILE : CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });

  it("puts the liquid cash account first, then ranks by liquidation order", () => {
    const accounts = [of("pretax", true), of("cash", false), of("brokerage", false)];
    expect(orderedLiquidationAccounts(accounts, "cash").map((a) => a.id)).toEqual([
      "cash",
      "brokerage",
      "pretax",
    ]);
  });

  it("holds accounts of one category in roster order — a stable sort, so bands never reshuffle", () => {
    const accounts = [of("b1", false), of("b2", false), of("b3", false)];
    expect(orderedLiquidationAccounts(accounts, null).map((a) => a.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("ranks an unlisted category last rather than dropping it", () => {
    const accounts = [of("pretax", true), of("brokerage", false)];
    expect(orderedLiquidationAccounts(accounts, null, DEFAULT_LIQUIDATION_ORDER).map((a) => a.id)).toEqual([
      "brokerage",
      "pretax",
    ]);
    // An order naming nothing leaves every account at the same rank, so the roster order stands.
    expect(orderedLiquidationAccounts(accounts, null, []).map((a) => a.id)).toEqual([
      "pretax",
      "brokerage",
    ]);
  });

  it("does not mutate the roster it is given", () => {
    const accounts = [of("pretax", true), of("cash", false)];
    orderedLiquidationAccounts(accounts, "cash");
    expect(accounts.map((a) => a.id)).toEqual(["pretax", "cash"]);
  });
});
