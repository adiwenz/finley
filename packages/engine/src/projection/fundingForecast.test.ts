/**
 * The annual funding forecast in isolation: given a year's need and the accounts in the
 * waterfall's own draw order, which accounts pay for it and how much taxable income that
 * realizes. The projection-level consequences are in `federalIncomeTax.test.ts`; these pin the
 * arithmetic and the seams.
 */
import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE, SimAccount } from "../plan/simAccount";
import { forecastFundingDraws, type ForecastAccount } from "./fundingForecast";
import { orderedLiquidationAccounts, DEFAULT_LIQUIDATION_ORDER } from "./withdrawal";

const CTX = { year: 2026 };

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
): ForecastAccount {
  return {
    id,
    ownerId: "p1",
    category,
    balanceCents: dollarsToCents(dollars),
    basisCents: dollarsToCents(basisDollars),
    ...(liquidBuffer ? { liquidBuffer } : {}),
  };
}

describe("forecastFundingDraws — how a year's shortfall gets paid for", () => {
  it("takes each account in turn, exactly what is left of the need", () => {
    const draws = forecastFundingDraws(
      dollarsToCents(50_000),
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
      dollarsToCents(5_000),
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
      dollarsToCents(30_000),
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
      dollarsToCents(20_000),
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
      dollarsToCents(10_000),
      [acct("cash", "capitalGains", 10_000, 0, true)],
      nullJurisdiction,
      CTX,
    ).draws;
    expect(draws[0]!.grossCents).toBe(dollarsToCents(10_000));
    expect(draws[0]!.taxableCents).toBe(0);
  });

  it("reports what the accounts could not cover rather than over-drawing them", () => {
    const { draws, unfundedCents } = forecastFundingDraws(
      dollarsToCents(30_000),
      [acct("pretax", "ordinaryIncome", 12_000, 0)],
      proRata,
      CTX,
    );
    expect(draws[0]!.grossCents).toBe(dollarsToCents(12_000));
    expect(unfundedCents).toBe(dollarsToCents(18_000));
  });

  it("forecasts nothing for a household with no shortfall", () => {
    // A surplus year: the tax comes out of income, and no investment is sold to pay it.
    for (const need of [0, -dollarsToCents(50_000)]) {
      expect(forecastFundingDraws(need, [acct("pretax", "ordinaryIncome", 100_000, 0)], proRata, CTX))
        .toEqual({ draws: [], unfundedCents: 0 });
    }
  });

  it("skips an account that holds nothing instead of landing it as a zero draw", () => {
    const draws = forecastFundingDraws(
      dollarsToCents(5_000),
      [acct("drained", "capitalGains", 0, 0), acct("pretax", "ordinaryIncome", 100_000, 0)],
      proRata,
      CTX,
    ).draws;
    expect(draws.map((d) => d.accountId)).toEqual(["pretax"]);
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
