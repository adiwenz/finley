import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
  type SimOneTimeTransfer,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { apportionByWeight, type Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type ProjectionSeries,
  type SimOwnedSeries,
} from "./simulate";
import type { SimPerson } from "./simulate.types";
import { explicitObligation } from "./financialObligation";
import { monthlyInstallmentCents } from "./federalIncomeTax";
import { AmortizingLoan } from "../liability/liability";

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

const CATEGORIES = ["wages", "ordinaryIncome", "capitalGains", "taxExempt"] as const;

/**
 * A flat rate on the combined categories, with the SAME per-category rounding feeding both the
 * scalar and the breakdown, so the two are exact by construction — isolating this test suite
 * from the reconciliation math `rules`/`waterfallInvariants.ts` already cover elsewhere.
 */
function flatAnnual(rate: number): Jurisdiction {
  const perCategory = (byCat: Partial<Record<string, number>>): Partial<Record<string, number>> => {
    const out: Partial<Record<string, number>> = {};
    for (const category of CATEGORIES) {
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

/**
 * A BRACKETED jurisdiction: an allowance, then two rates. Progressive on purpose — under a flat
 * rate the year's tax is linear in income, so summing twelve instalments and reconciling can
 * agree by arithmetic that says nothing about the annual seam. Here the estimate's marginal rate
 * genuinely differs from the actual year's.
 */
function progressiveAnnual(): Jurisdiction {
  const scalar = (byCat: Partial<Record<string, number>>): Cents => {
    const total = CATEGORIES.reduce((s, c) => s + (byCat[c] ?? 0), 0);
    const overAllowance = Math.max(0, total - dollarsToCents(20_000));
    const lower = Math.min(overAllowance, dollarsToCents(60_000));
    return Math.round(lower * 0.1 + Math.max(0, overAllowance - lower) * 0.35);
  };
  return {
    id: "progressive-annual",
    computeTaxCents: scalar,
    computeTaxByCategoryCents: (byCat) =>
      Object.fromEntries(
        apportionByWeight(
          scalar(byCat),
          CATEGORIES.map((c) => [c, byCat[c] ?? 0] as const),
        ),
      ),
  };
}

/** Every month's charged federal income tax, in order. */
function monthlyTax(projection: ProjectionSeries): Cents[] {
  return projection.months.map((m) => m.flows!.taxCents);
}

const sum = (values: readonly Cents[]): Cents => values.reduce((s, v) => s + v, 0);

describe("Federal income tax — a smooth monthly estimated payment", () => {
  it("charges steady wages an equal twelfth every month, with nothing left to settle in December", () => {
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [series(10_000, 0, 11)], // $120k/yr
      }),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    // 25% of $120k, in twelve equal payments — not one $30k charge in December.
    expect(taxes).toEqual(Array(12).fill(dollarsToCents(2_500)));
    expect(sum(taxes)).toBe(dollarsToCents(30_000));
  });

  it("keeps December in line with the other eleven months — no annual sawtooth", () => {
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 36,
        incomeSeries: [series(10_000, 0, 35)],
      }),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    // The regression this model exists to remove: a December that dwarfs its neighbours, three
    // years running. Net worth grows monotonically instead of dropping every twelfth month.
    for (const december of [11, 23, 35]) {
      expect(taxes[december]).toBe(taxes[december - 1]);
    }
    expect(Math.max(...taxes)).toBe(Math.min(...taxes));
    const netWorth = projection.months.map((m) => m.netWorthNominalCents!);
    for (let m = 1; m < netWorth.length; m++) expect(netWorth[m]).toBeGreaterThan(netWorth[m - 1]);
  });

  it("spreads a known annual RMD across the year rather than charging it in the RMD month or December", () => {
    const rmdJurisdiction: Jurisdiction = {
      ...flatAnnual(0.3),
      requiredMinimumDistributionCents: (preTaxBalanceCents, ctx) =>
        ctx.age >= 73 ? Math.min(preTaxBalanceCents, dollarsToCents(80_000)) : 0,
    };
    const projection = simulateHousehold(
      baseInput(
        [account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 200_000)],
        { persons: [{ id: "p1", name: "You", birthYear: 2026 - 75 }] },
      ),
      rmdJurisdiction,
    );
    // The whole $80k RMD is forced out in month 0 — a lump the projection already knew about.
    expect(projection.months[0].flows!.cashFlowIncomeByCategoryCents["ordinaryIncome"]).toBe(
      dollarsToCents(80_000),
    );
    // 30% of $80k, paid in twelve equal instalments: neither the RMD month nor December is spiked.
    expect(monthlyTax(projection)).toEqual(Array(12).fill(dollarsToCents(2_000)));
  });

  it("estimates the same annual liability for lumpy and evenly-scheduled income", () => {
    const run = (incomeSeries: SimOwnedSeries[]): ProjectionSeries =>
      simulateHousehold(
        baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], { incomeSeries }),
        flatAnnual(0.25),
      );
    const lump = monthlyTax(run([series(120_000, 0, 0)])); // the whole year's pay in month 0
    const spread = monthlyTax(run([series(10_000, 0, 11)]));
    expect(lump).toEqual(spread);
    expect(sum(lump)).toBe(dollarsToCents(30_000));
  });

  it("never annualizes year-to-date income: a January lump does not charge early and refund later", () => {
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [series(120_000, 0, 0)],
      }),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    // Under YTD annualization January would be taxed as if $1.44M were coming and the eleven
    // months after it would each refund part of that back. Nothing here is a refund, and
    // January is no larger than any other month.
    for (const tax of taxes) expect(tax).toBe(dollarsToCents(2_500));
  });

  it("includes a one-month bonus in the year's estimate, spread like the rest of the year", () => {
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        // $120k of salary plus a $60k bonus in month 4 — authored as its own single month of the
        // compiled series, exactly as a `thisMonthOnly` job override compiles. Knowable at the
        // year's start, so it is estimated, not reconciled: one-off does not mean unpredictable.
        incomeSeries: [series(10_000, 0, 11), series(60_000, 4, 4)],
      }),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    expect(taxes).toEqual(Array(12).fill(dollarsToCents(3_750))); // 25% of $180k, in twelfths
    expect(taxes[4]).toBe(taxes[0]); // the bonus month is no heavier than any other
  });

  it("starts a fresh tax year each January", () => {
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        horizonMonths: 24,
        incomeSeries: [series(5_000, 0, 23)], // $60k/yr, two full years
      }),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    // Year 2 is priced on year 2's income alone — not inflated by year 1's already-taxed income.
    expect(sum(taxes.slice(12))).toBe(sum(taxes.slice(0, 12)));
    expect(sum(taxes.slice(0, 12))).toBe(dollarsToCents(15_000));
  });
});

/**
 * The year's BALANCE — its actual liability less the instalments it collected — is not a December
 * cash flow. December closes the year's arithmetic; April of the following year moves its money,
 * the way a real filing settles. These pin both halves.
 */
describe("Federal income tax — the year's balance settles the following April", () => {
  /** The month a tax year starting at month 0 settles in: April of the next year. */
  const SETTLES_IN = 15;

  /**
   * Money the year-start estimate CANNOT see: a one-time transfer into or out of an account. The
   * forecast models transfers not at all — it walks balances forward through draws and growth
   * alone — so a mid-year influx leaves it having collected for sales the household never makes,
   * and a mid-year outflow leaves it having missed sales it must.
   *
   * That is now the only lever these tests have, and deliberately so. Everything else they used to
   * pull is anticipated: an ordinary lumpy spend is read from the compiled series month by month,
   * and a debt's payments are read off its own schedule, origination and maturity included (see
   * the debt-schedule tests below). A settlement exists for what the plan genuinely does not
   * describe, and this is what that looks like.
   */
  const withTransfer = (account: SimAccount, transfer: SimOneTimeTransfer): SimAccount => {
    account.addTransfer(transfer);
    return account;
  };

  /** The whole of an account, gone in `month` — a transfer the plan's series do not carry. */
  const emptiedIn = (month: number): SimOneTimeTransfer => ({ month, proportionalFraction: -1 });

  it("anticipates the decumulation an ordinary spend forces, rather than saving it all for the balance", () => {
    const rate = 0.25;
    const wages = series(2_000, 0, 15); // $24k/yr — nowhere near enough to fund the spend below
    const run = (expenseSeries: SimOwnedSeries[]): ProjectionSeries =>
      simulateHousehold(
        baseInput(
          [
            account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
            account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
          ],
          { horizonMonths: 16, incomeSeries: [wages], expenseSeries },
        ),
        flatAnnual(rate),
      );
    const steady = monthlyTax(run([]));
    // A $50k obligation in month 6 that only a fully-taxable pre-tax draw can fund. The ACCOUNT
    // it comes out of is discovered by the waterfall — but that the household will be $50k short
    // is plain from the compiled expense series before the year starts, so the year-start
    // forecast prices the withdrawal it will take.
    const withDraw = monthlyTax(run([series(50_000, 6, 6)]));

    // Anticipated, so every month of the year pays a share — including the months BEFORE the
    // spend even lands. That is the whole point: the liability is annual, so the payments are too.
    for (let m = 0; m < 12; m++) expect(withDraw[m]!).toBeGreaterThan(steady[m]!);
    // And all twelve are the one estimate, December included — a later month never re-prices, and
    // December is no longer a true-up. They differ only by the cumulative rounding that makes
    // twelve instalments sum exactly.
    expect(Math.max(...withDraw.slice(0, 12)) - Math.min(...withDraw.slice(0, 12))).toBeLessThanOrEqual(1);
    // And the year leaves next to nothing behind. The forecast is built from the need MONTH BY
    // MONTH, so it knows both things an annual total averages away: that six months of wages are
    // banked before the spend lands, and that the spend still has to be met in month 6 out of
    // only what has been banked by then. April's charge is therefore year 1's own instalment plus
    // a residue of pennies — where a forecast that spread the year's need evenly left a balance
    // several times an instalment.
    expect(withDraw[SETTLES_IN]! - withDraw[14]!).toBeLessThan(dollarsToCents(1));
  });

  it("charges a positive balance exactly once, in April, and never again", () => {
    // Two full years plus the April that settles the second, so both settlements are visible and
    // a settlement charged twice would show up as a second anomalous month.
    const projection = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
        horizonMonths: 28,
        expenseSeries: [series(3_000, 0, 27)],
      }),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    // The months that stand out from their own year's flat instalment — exactly the two Aprils
    // that settle a prior year, and nothing else.
    const instalmentOf = (y: number): Cents => taxes[y * 12]!;
    const anomalies = taxes
      .map((tax, m) => ({ tax, m }))
      .filter(({ tax, m }) => Math.abs(tax - instalmentOf(Math.floor(m / 12))) > 1)
      .map(({ m }) => m);
    expect(anomalies).toEqual([15, 27]);
  });

  it("refunds a negative balance exactly once, in April, as cash the household keeps", () => {
    // An over-collecting year: January forecasts a full twelve months of pre-tax selling to cover
    // $36k of spending, and collects for it — then $50,000 of cash the plan never described lands
    // in July and pays for the second half, so half the year's forecast sales never happen.
    const projection = simulateHousehold(
      baseInput(
        [
          withTransfer(account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), {
            month: 6,
            amountCents: dollarsToCents(50_000),
          }),
          account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000),
        ],
        { horizonMonths: 16, expenseSeries: [series(3_000, 0, 11)] },
      ),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    const refundMonth = SETTLES_IN; // April of year 1, settling year 0
    // A refund, not a smaller charge: the month's tax is NEGATIVE, which is what makes it cash
    // coming back rather than a discount on a bill.
    expect(taxes[refundMonth]!).toBeLessThan(0);
    // Once. Year 1 spends nothing and sells nothing, so its own months charge nothing at all —
    // every cent of movement in the year is the one settlement.
    for (const m of [12, 13, 14]) expect(taxes[m]!).toBe(0);
    // And it lands as MONEY: net worth rises in the refund month, in a household that has spent
    // every other month of the run drawing its accounts down.
    const netWorth = projection.months.map((m) => m.netWorthNominalCents!);
    expect(netWorth[refundMonth]!).toBeGreaterThan(netWorth[refundMonth - 1]!);
    expect(netWorth[refundMonth]! - netWorth[refundMonth - 1]!).toBe(-taxes[refundMonth]!);
  });

  it("makes the year's instalments plus its balance equal the annual tax on its actual income", () => {
    const rate = 0.25;
    // $24k of wages the estimate paces on and collects twelve instalments for, against $72k of
    // spending it expects the $60k in checking to cover — so it forecasts no pre-tax sale at all.
    // Then checking is emptied in July by a transfer the plan never described, and the year's
    // second half is funded by selling pre-tax, taxable, with nothing withheld against it.
    const projection = simulateHousehold(
      baseInput(
        [
          withTransfer(account("checking", CAPITAL_GAINS_TAX_PROFILE, 60_000, true), emptiedIn(6)),
          account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
        ],
        {
          horizonMonths: 16,
          incomeSeries: [series(2_000, 0, 11)],
          expenseSeries: [series(6_000, 0, 11)],
        },
      ),
      flatAnnual(rate),
    );
    const taxes = monthlyTax(projection);
    // Both halves are real: the year collected instalments AND left a balance behind.
    expect(sum(taxes.slice(0, 12))).toBe(dollarsToCents(6_000)); // 25% of the wages it could see
    // April carries tax from two years at once — year 0's balance on top of year 1's own
    // instalment, which March charges alone and so measures.
    const balance = taxes[15]! - taxes[14]!;
    expect(balance).toBeGreaterThan(dollarsToCents(1_000));

    // Basis 0, so every cent that left the pre-tax account in year 0 IS year 0's taxable income,
    // on top of the year's wages.
    const drawn = dollarsToCents(500_000) - projection.months[11]!.accountBalancesCents.pretax!;
    const liability = Math.round((drawn + dollarsToCents(24_000)) * rate);
    // THE INVARIANT the model rests on: the year's twelve instalments plus the balance settled the
    // following April come to the annual liability on the year's ACTUAL taxable income — no
    // modelling residue, and no dependence on which month each dollar landed in. The single cent
    // of slack is not the model's: it is the amount by which April's own instalment of year 1 can
    // differ from March's, which is the only thing standing between `taxes[15] - taxes[14]` and
    // the balance itself.
    expect(Math.abs(sum(taxes.slice(0, 12)) + balance - liability)).toBeLessThanOrEqual(1);
  });

  it("funds an April balance from the retirement account as income of the year of the DRAW", () => {
    const rate = 0.25;
    // The same unseen transfer as above: $50k of checking the year opens expecting to spend, gone
    // in July. It leaves 2026 with a balance AND with no cash at all — so the only thing April
    // 2027 can sell to pay that balance is the traditional retirement account, and that sale is
    // fully taxable. 2026's own spending stops at its December, so 2027 has no income and no
    // expenses whatsoever: everything it is charged traces back to funding the prior year's bill.
    const input = (horizonMonths: number): HouseholdSimInput =>
      baseInput(
        [
          withTransfer(account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000, true), emptiedIn(6)),
          account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
        ],
        { horizonMonths, expenseSeries: [series(4_000, 0, 11)] },
      );
    const run = (horizonMonths: number): Cents[] =>
      monthlyTax(simulateHousehold(input(horizonMonths), flatAnnual(rate)));
    // A CLOSED YEAR IS NEVER REOPENED. 2026's twelve charges are identical whether the run stops
    // at its December or carries on through the April that settles it — the sale that pays the
    // balance does not flow back into the liability it is paying.
    expect(run(28).slice(0, 12)).toEqual(run(12));

    const projection = simulateHousehold(input(28), flatAnnual(rate));
    const taxes = monthlyTax(projection);
    const pretaxAt = (m: number): Cents => projection.months[m]!.accountBalancesCents.pretax!;
    // April sells exactly what it owes — the balance, not a grossed-up multiple of it.
    expect(pretaxAt(14) - pretaxAt(15)).toBe(taxes[15]!);

    // And that sale is 2027 income. Year 1's whole taxable base is what left the pre-tax account
    // during year 1, and its own liability — twelve instalments plus the balance it leaves for
    // April 2028 — prices exactly that. Within a few cents: April 2028's charge also carries a
    // sub-dollar instalment of 2028's own estimate, which no assertion here can net out.
    const year1Drawn = pretaxAt(11) - pretaxAt(23);
    // Net 2026's balance back OUT of 2027's twelve charges and 2028's back IN — a settlement
    // month is the one month carrying tax from two different years at once. An April charge less
    // its March neighbour is the balance to within the cent of cumulative instalment rounding,
    // which is the whole tolerance below.
    const balanceOf = (april: number): Cents => taxes[april]! - taxes[april - 1]!;
    const year1Charged = sum(taxes.slice(12, 24)) - balanceOf(15) + balanceOf(27);
    expect(Math.abs(year1Charged - Math.round(year1Drawn * rate))).toBeLessThanOrEqual(5);
    // Not a rounding artefact of an empty year: the draw really did create a bill in 2027.
    expect(year1Charged).toBeGreaterThan(dollarsToCents(500));
  });

  it("puts the April balance through the ordinary funding waterfall", () => {
    const projection = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
        horizonMonths: 16,
        expenseSeries: [series(10_000, 0, 0)],
      }),
      flatAnnual(0.25),
    );
    const april = projection.months[SETTLES_IN]!;
    // Nothing else is owed that month — no expense series past month 0 — so the account movement
    // is the settlement's, and it came out through decumulation like any other need. A settlement
    // that mutated balances directly would move the money without the draw ever appearing.
    const drawn = projection.months[14]!.accountBalancesCents.pretax! - april.accountBalancesCents.pretax!;
    expect(drawn).toBe(april.flows!.taxCents);
    // It bands as the account's ORDINARY draw — there is no settlement-specific source any more,
    // because there is no settlement-specific sale.
    const bands = april.flows!.incomeSources;
    expect(bands.find((s) => s.sourceId === "pretax")?.label).toBe("pretax");
    expect(bands.some((s) => s.sourceId?.startsWith("tax-settlement"))).toBe(false);
  });

  it("starts January's estimate normally while the prior year's balance is still pending", () => {
    const projection = simulateHousehold(
      baseInput(
        [
          withTransfer(account("checking", CAPITAL_GAINS_TAX_PROFILE, 50_000, true), emptiedIn(6)),
          account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
        ],
        { horizonMonths: 16, expenseSeries: [series(4_000, 0, 11)] },
      ),
      flatAnnual(0.25),
    );
    const taxes = monthlyTax(projection);
    // January–March of 2027 carry a pending 2026 balance and are unaffected by it as CHARGES:
    // they are flat twelfths of 2027's own estimate, like any other year's.
    expect(Math.max(...taxes.slice(12, 15)) - Math.min(...taxes.slice(12, 15))).toBeLessThanOrEqual(1);
    // 2027's estimate is nonetheless AWARE of it. The year has no income and no expenses at all,
    // so a forecast blind to the pending balance would have nothing to fund, forecast no
    // withdrawal, and price the year at nothing.
    expect(taxes[12]!).toBeGreaterThan(0);
    // The balance still lands in April, on top of that instalment.
    expect(taxes[15]!).toBeGreaterThan(taxes[14]! * 10);
  });

  it("charges exactly the jurisdiction's annual tax on the year's actual base, under a progressive schedule", () => {
    const jurisdiction = progressiveAnnual();
    // $96k of wages the estimate paces on, and a $40k obligation in month 6 that only the
    // fully-taxable pre-tax account can fund — landing in the 35% band the wages alone never
    // reached. The draw is EXPLICIT, so the estimate prices it exactly and leaves no balance.
    const projection = simulateHousehold(
      baseInput(
        [account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 500_000)],
        {
          incomeSeries: [series(8_000, 0, 11)],
          fundingDraws: [
            explicitObligation({
              id: "spend1",
              sourceId: "spend1",
              month: 6,
              amountCents: dollarsToCents(40_000),
              orderedAccountIds: ["pretax"],
              treatment: "expense",
            }),
          ],
        },
      ),
      jurisdiction,
    );
    const taxes = monthlyTax(projection);
    const actualBase = { ordinaryIncome: dollarsToCents(96_000 + 40_000) };
    const estimated = jurisdiction.computeTaxCents(actualBase, { year: 2026 });

    // Nothing is left to settle: the obligation names `pretax` and the amount, so the estimate
    // prices the draw through the same resolver the simulator will use and the year is paced on
    // the full $136k from January. Twelve instalments, summing exactly to the annual liability,
    // even though the rate genuinely jumps a bracket — and no April balance to carry.
    expect(sum(taxes)).toBe(estimated);
    expect(taxes[11]).toBe(monthlyInstallmentCents(estimated, 11));
    expect(Math.max(...taxes) - Math.min(...taxes)).toBeLessThanOrEqual(1);
  });

  it("combines two mid-year withdrawals into one annual base rather than two separate bills", () => {
    const rate = 0.2;
    const run = (expenseSeries: SimOwnedSeries[]): Cents =>
      sum(
        monthlyTax(
          simulateHousehold(
            baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], {
              horizonMonths: 16,
              expenseSeries,
            }),
            flatAnnual(rate),
          ),
        ),
      );
    // $5k drawn in month 0 and $5k in month 6 must cost exactly what a single $10k draw costs:
    // the year's tax depends on the year's total, never on how it was split across months.
    expect(run([series(5_000, 0, 0), series(5_000, 6, 6)])).toBe(run([series(10_000, 0, 0)]));
  });

  it("leaves a year truncated by a funding block unsettled — its April never comes", () => {
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [series(10_000, 0, 11)],
        fundingDraws: [
          explicitObligation({
            id: "spend1",
            sourceId: "spend1",
            month: 3,
            amountCents: dollarsToCents(500_000),
            orderedAccountIds: ["checking"],
            treatment: "expense",
          }),
        ],
      }),
      flatAnnual(0.25),
    );
    expect(projection.blockedAtMonth).toBe(3);
    const taxes = monthlyTax(projection);
    // Four instalments of the full year's estimate and not a cent more. The year's balance is
    // computed at its close and parked — but the run stops in April 2026, four months before the
    // December that closes it and a year before the April that would settle it. Hurrying it
    // forward into the blocked month is exactly the same-month true-up this model removed.
    for (const tax of taxes) expect(tax).toBe(monthlyInstallmentCents(dollarsToCents(30_000), 0));
    expect(sum(taxes)).toBe(dollarsToCents(10_000));
  });
});

/**
 * Debt service is the largest thing most households fund, and it is the one part of the year's
 * need whose timing is already written down: an amortization schedule, an origination month, a
 * final payment. The year-start estimate reads it from there.
 *
 * It used to hold JANUARY's payment flat for twelve months, which is wrong in both directions and
 * by a lot. A loan maturing in the spring went on being funded — with forecast pre-tax sales, and
 * so with real instalments collected against sales the household never made — for every month of
 * the rest of the year, and the over-collection came back as a refund a year later. A loan
 * originating in July was funded for none of the months it existed, and its decumulation landed
 * whole on the following April.
 */
describe("Federal income tax — debt service is estimated on the schedule the debts actually keep", () => {
  const rate = 0.25;
  /** A pre-tax-only household: every dollar of debt service is funded by a fully taxable sale. */
  const runWithLoan = (loan: AmortizingLoan, horizonMonths: number): Cents[] =>
    monthlyTax(
      simulateHousehold(
        baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
          horizonMonths,
          liabilities: [loan],
        }),
        flatAnnual(rate),
      ),
    );

  /** $3,000 a month, interest-free, from month 1 to `termMonths`. */
  const loanOf = (termMonths: number): AmortizingLoan =>
    new AmortizingLoan({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(3_000 * termMonths),
      apr: 0,
      termMonths,
    });

  it("stops estimating for a loan the year it matures, rather than collecting all year and refunding", () => {
    // Fifteen payments: twelve in year 0, then January, February and March of year 1 — $12,000 of
    // debt service in a year whose January payment, held flat, would have read as $36,000.
    const matures = runWithLoan(loanOf(15), 28);
    // Funding $12,000 from a fully taxable account costs $12,000 + the tax on the sale itself:
    // T = 0.25 × ($12,000 + T) → $4,000, and the year collects exactly that.
    expect(Math.abs(sum(matures.slice(12, 24)) - dollarsToCents(4_000))).toBeLessThan(
      dollarsToCents(1),
    );
    // A household whose loan really does run all twelve months of year 1 — same $3,000 payment,
    // longer term — is the estimate the maturing loan used to be given: three times as much.
    const stillPaying = runWithLoan(loanOf(27), 28);
    expect(Math.abs(sum(stillPaying.slice(12, 24)) - dollarsToCents(12_000))).toBeLessThan(
      dollarsToCents(1),
    );
    // THE REGRESSION: the over-collection, and the refund a year later that gave it back, are both
    // simply gone. April 2028 settles year 1 at a rounding residue, not at $8,000 returned.
    expect(Math.abs(matures[27]!)).toBeLessThan(dollarsToCents(1));
    // And the months after maturity are not carrying a phantom payment: year 2 pays no debt, has
    // no spending, and is charged nothing at all.
    for (const m of [24, 25, 26]) expect(Math.abs(matures[m]!)).toBeLessThan(dollarsToCents(1));
  });

  it("estimates a loan that originates mid-year from the month it starts paying", () => {
    const originates = new AmortizingLoan({
      id: "loan",
      ownerId: "p1",
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(45_000),
      startMonth: 5,
      apr: 0,
      termMonths: 6, // $7,500 a month across months 6–11 — the second half of the year only
    });
    const taxes = runWithLoan(originates, 16);
    // T = 0.25 × ($45,000 + T) → $15,000, collected across the year the payments fall in.
    expect(Math.abs(sum(taxes.slice(0, 12)) - dollarsToCents(15_000))).toBeLessThan(
      dollarsToCents(1),
    );
    // Anticipated from January, not discovered in July: the six months BEFORE the loan exists
    // already pay their share, and every month of the year pays the same share.
    for (let m = 0; m < 6; m++) expect(taxes[m]!).toBeGreaterThan(dollarsToCents(1_000));
    expect(Math.max(...taxes.slice(0, 12)) - Math.min(...taxes.slice(0, 12))).toBeLessThanOrEqual(1);
    // THE REGRESSION: a year that saw none of this left the whole $15,000 for the following April.
    // Nothing is left now — year 1 spends nothing, so its months are empty and so is its April.
    expect(Math.abs(taxes[15]!)).toBeLessThan(dollarsToCents(1));
  });
});

/**
 * THE REGRESSION. A retired household living off its accounts: the shape in which deferring
 * every decumulation dollar of tax to a same-year December true-up produced a five-figure
 * December charge, year after year, against near-zero months either side of it — a sawtooth in
 * the tax chart and a matching one in net worth.
 *
 * Nothing here is scheduled income. The whole tax bill comes from withdrawals the funding
 * waterfall decides on month by month, which is exactly what the year-start estimate could not
 * see and now forecasts.
 */
describe("Federal income tax — a retired household decumulating, over five full years", () => {
  // A $15k allowance, then 10% and 35% — bracketed on purpose, so the estimate's marginal rate
  // genuinely differs from the year's and the twelve instalments cannot agree with the annual
  // liability by linear arithmetic alone.
  const jurisdiction = ((): Jurisdiction => {
    const scalar = (byCat: Partial<Record<string, number>>): Cents => {
      const total = CATEGORIES.reduce((s, c) => s + (byCat[c] ?? 0), 0);
      const over = Math.max(0, total - dollarsToCents(15_000));
      const lower = Math.min(over, dollarsToCents(60_000));
      return Math.round(lower * 0.1 + Math.max(0, over - lower) * 0.35);
    };
    return {
      id: "retired-progressive",
      computeTaxCents: scalar,
      computeTaxByCategoryCents: (byCat) =>
        Object.fromEntries(
          apportionByWeight(scalar(byCat), CATEGORIES.map((c) => [c, byCat[c] ?? 0] as const)),
        ),
      // Pro-rata return of capital, as a real jurisdiction defines it — without this seam the
      // engine's fallback is "the whole draw is taxable", which would make even the cash
      // accounts' drawdowns taxable income and obscure what this scenario is about.
      taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) =>
        grossCents -
        Math.round(grossCents * (balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0)),
    };
  })();
  const SPEND = 6_000; // $72k/yr — far past what the $20k of cash and brokerage can carry
  const YEARS = 5;

  /**
   * The reported shape: cash and brokerage a tenth of the pre-tax account each, no wages, no
   * benefit, and ordinary living costs that can only come out of the retirement account once the
   * first $20k is gone. The pre-tax balance is sized so FIVE complete years of decumulation fit —
   * at the reported $100k it would be exhausted inside two, and the recurring year-end spike is
   * the whole point of the regression.
   *
   * Nothing compounds (every rate is 0), which keeps the brokerage's basis equal to its balance:
   * its draws realize NO gain, so the year's entire taxable base is the pre-tax withdrawal,
   * readable straight off that account's balance.
   */
  const retired = (): ProjectionSeries =>
    simulateHousehold(
      baseInput(
        [
          account("savings", CAPITAL_GAINS_TAX_PROFILE, 10_000, true),
          account("retirement", PRE_TAX_TAX_PROFILE, 500_000),
          account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 10_000),
        ],
        { horizonMonths: 12 * YEARS, expenseSeries: [series(SPEND, 0, 12 * YEARS - 1)] },
      ),
      jurisdiction,
    );

  /** The twelve monthly charges of tax year `y`. */
  const yearOf = (taxes: readonly Cents[], y: number): Cents[] => taxes.slice(y * 12, y * 12 + 12);

  it("charges every month of every year a flat instalment — December included", () => {
    const taxes = monthlyTax(retired());
    for (let y = 0; y < YEARS; y++) {
      const months = yearOf(taxes, y);
      // The year-start estimate saw the decumulation coming, so every month charges. Before this,
      // a year with no scheduled income estimated $0 and charged nothing at all until December.
      for (const [i, tax] of months.entries()) {
        expect(tax, `year ${y} month ${i}`).toBeGreaterThan(0);
      }
      // Eleven of the twelve are one flat estimate — the year is priced once, in January, and
      // never re-priced from year-to-date income. December is one of them: it is no longer a
      // true-up, and the sawtooth that made it the entire annual bill is gone outright.
      const withoutApril = months.filter((_, i) => i !== 3);
      expect(Math.max(...withoutApril) - Math.min(...withoutApril), `year ${y}`).toBeLessThanOrEqual(1);
      expect(months[11], `year ${y} December`).toBe(months[10]! === months[9]! ? months[10]! : months[11]!);
      expect(Math.abs(months[11]! - months[10]!), `year ${y} December`).toBeLessThanOrEqual(1);
      // April is the ONLY month carrying anything extra, and only from year `y-1`. Year 0 has no
      // prior year, so even its April is an ordinary instalment.
      if (y === 0) expect(Math.abs(months[3]! - months[2]!)).toBeLessThanOrEqual(1);
      else expect(months[3]!).toBeGreaterThan(months[2]!);
    }
  });

  it("settles each year's balance in the FOLLOWING April, exactly once and exactly in full", () => {
    const projection = retired();
    const taxes = monthlyTax(projection);
    const retirementAt = (m: number): Cents => projection.months[m]!.accountBalancesCents.retirement!;

    // Walked forward year by year, with no unknowns: year 0 carries nothing in, so its twelve
    // charges ARE its estimate; its liability is the jurisdiction's tax on what actually left the
    // pre-tax account (basis 0, so the drawn total IS the taxable base); the difference is the
    // balance April of year 1 must settle — which then determines year 1's own estimate, and so on.
    let carriedIn = 0;
    for (let y = 0; y < YEARS; y++) {
      const months = yearOf(taxes, y);
      const estimate = sum(months) - carriedIn;
      const opening = y === 0 ? dollarsToCents(500_000) : retirementAt(y * 12 - 1);
      const liability = jurisdiction.computeTaxCents(
        { ordinaryIncome: opening - retirementAt(y * 12 + 11) },
        { year: 2026 + y },
      );
      // Every month is a twelfth of the year's own estimate, and April is that PLUS the previous
      // year's balance in full — the settlement lands in one month, whole, and in no other.
      for (const [i, tax] of months.entries()) {
        expect(tax, `year ${y} month ${i}`).toBe(
          monthlyInstallmentCents(estimate, i) + (i === 3 ? carriedIn : 0),
        );
      }
      // The year's liability is still exactly the jurisdiction's annual tax on its actual taxable
      // income — the settlement moved WHEN the money changes hands, never how much is owed.
      carriedIn = liability - estimate;
    }
  });

  it("draws net worth down smoothly, with no year-end cliff", () => {
    const netWorth = retired().months.map((m) => m.netWorthNominalCents!);
    const drops = netWorth.slice(1).map((v, i) => netWorth[i]! - v);
    // A spending household's net worth falls every month; the question is whether it falls a
    // roughly equal amount each time. The recurring December cliff was several times the
    // surrounding months. Every month is now within 2× the median.
    const median = [...drops].sort((a, b) => a - b)[Math.floor(drops.length / 2)]!;
    expect(median).toBeGreaterThan(0);
    for (let y = 0; y < YEARS; y++) {
      // `drops[i]` is the fall from month `i`'s close to month `i+1`'s, so December of year `y`
      // closes at `y*12+11` and its own drop is the one indexed `y*12+10`.
      expect(drops[y * 12 + 10], `December of year ${y}`).toBeLessThan(median * 2);
    }
    expect(Math.max(...drops)).toBeLessThan(median * 2);
  });

  it("keeps the year's estimate in the accounts the waterfall will actually draw", () => {
    // The estimate's per-source attribution has to name the same bands the real draws do,
    // or the tax chart shows an estimated band beside an actual band for one account.
    const flows = retired().months[0]!.flows!;
    expect(Object.keys(flows.taxBySourceCents)).toEqual(["retirement"]);
    expect(flows.taxBySourceCents["retirement"]).toBe(flows.taxCents);
  });
});

/**
 * An explicitly-funded event states its own allocation — which accounts, in what order, for how
 * much — so its taxable income is not a forecast at all: the year-start estimate prices the draw
 * through the simulator's own resolver against the balances the year opens with. These pin both
 * halves of what that does and does not mean: the draw itself is NOT enlarged to prepay its own
 * tax (no gross-up at the taxable event), and the tax it causes is nonetheless spread across the
 * year's instalments rather than dropped on December.
 */
describe("Federal income tax — an explicitly-funded event is priced from its own allocation", () => {
  // The year's whole liability: 25% of $120k of wages plus the whole $100k pre-tax draw.
  const ANNUAL_TAX = dollarsToCents(55_000);

  /** $120k of wages and a $500k pre-tax account, with one draw against it in month 4. */
  function withDraw(treatment: "asset-acquisition" | "expense"): ProjectionSeries {
    return simulateHousehold(
      baseInput(
        [account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 500_000)],
        {
          incomeSeries: [series(10_000, 0, 11)],
          fundingDraws: [
            explicitObligation({
              id: "draw1",
              sourceId: "draw1",
              month: 4,
              amountCents: dollarsToCents(100_000),
              orderedAccountIds: ["pretax"],
              treatment,
            }),
          ],
        },
      ),
      flatAnnual(0.25),
    );
  }

  it.each([
    ["a home purchase's down payment", "asset-acquisition"],
    ["a one-time spend", "expense"],
  ] as const)("does not gross up %s, and spreads its tax across the year", (_label, treatment) => {
    const projection = withDraw(treatment);
    const taxes = monthlyTax(projection);

    // Exactly $100k left the account — not $133k sold to prepay the tax the sale itself causes.
    // Knowing the tax in advance is not the same as charging it at the taxable event, and this
    // is the difference: the allocation is honoured to the cent.
    expect(projection.months[4].accountBalancesCents.pretax).toBe(
      dollarsToCents(500_000 - 100_000),
    );
    // The $100k IS the year's actual taxable income either way — the identical tax schedule
    // below is the proof. What differs is whether it BANDS as cash flow, and that turns on where
    // the cash went. A one-time spend reduces net worth and shows in the expense graph, so
    // banding its funding is matched by the spending it covers. A down payment converts cash
    // into a house, appears nowhere on the spending side, and so bands nothing at all — an
    // unmatched $100k of "income" would have read as a month the household could have spent it.
    const ordinaryIn = (m: number): Cents =>
      projection.months[m].flows!.cashFlowIncomeByCategoryCents["ordinaryIncome"] ?? 0;
    expect(ordinaryIn(4) - ordinaryIn(3)).toBe(
      treatment === "expense" ? dollarsToCents(100_000) : 0,
    );
    // The estimate DID see it — the obligation named its account and amount in January — so the
    // year is paced on $220k from month 0. The month the draw lands in is no heavier than any
    // other, and neither is December.
    expect(taxes).toEqual(
      Array.from({ length: 12 }, (_, i) => monthlyInstallmentCents(ANNUAL_TAX, i)),
    );
    expect(sum(taxes)).toBe(ANNUAL_TAX);
  });

  it("counts an event's funding once — its amount never re-enters the unresolved annual deficit", () => {
    // The double-count trap. The $100k draw is BOTH an outflow the household must fund and an
    // explicitly-allocated one already priced from its own sources. Counting it in both places
    // would forecast a second $100k of decumulation on top of the real one and roughly double
    // the year's estimate. The control is a run with no draw at all: the difference between the
    // two years' estimates must be the tax on ONE $100k of ordinary income, not two.
    const withoutDraw = simulateHousehold(
      baseInput(
        [account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true), account("pretax", PRE_TAX_TAX_PROFILE, 500_000)],
        { incomeSeries: [series(10_000, 0, 11)] },
      ),
      flatAnnual(0.25),
    );
    const delta = sum(monthlyTax(withDraw("expense"))) - sum(monthlyTax(withoutDraw));
    expect(delta).toBe(dollarsToCents(25_000));
  });
});

describe("Federal income tax — the year a retirement account is exhausted", () => {
  // The regression: the year-start estimate forecasts decumulation against the accounts, and it
  // used to cap each account's whole-year draw at its JANUARY balance. An account being spent
  // goes on earning on whatever has not been spent yet, so in the one year it is drained it funds
  // MORE than it ever held at once — and the tax on that slice had nowhere to go but the
  // following April, landing as a lone spike months after the household had stopped paying tax.
  //
  // On the shipped default plan at $10k/$100k/$10k the spike was $549.67 in April 2076, against a
  // retirement account that opened 2075 holding $82,092.22 and funded $84,568.18 of withdrawals.
  // This fixture is the same shape in miniature, and is discriminating: under the old cap its
  // April charge is $138.29, and it is $0.00 once the forecast compounds.
  const jurisdiction = ((): Jurisdiction => {
    const scalar = (byCat: Partial<Record<string, number>>): Cents => {
      const total = CATEGORIES.reduce((s, c) => s + (byCat[c] ?? 0), 0);
      const over = Math.max(0, total - dollarsToCents(15_000));
      const lower = Math.min(over, dollarsToCents(60_000));
      return Math.round(lower * 0.1 + Math.max(0, over - lower) * 0.35);
    };
    return {
      id: "exhaustion-progressive",
      computeTaxCents: scalar,
      computeTaxByCategoryCents: (byCat) =>
        Object.fromEntries(
          apportionByWeight(scalar(byCat), CATEGORIES.map((c) => [c, byCat[c] ?? 0] as const)),
        ),
      taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) =>
        grossCents -
        Math.round(grossCents * (balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0)),
    };
  })();

  /**
   * Three years. A pre-tax account compounding at 7% funds $6,000/month of living costs and
   * empties partway through year two. Spending STOPS at the end of that year, which is what keeps
   * year three solvent — so if an April settlement were owed there, the run could actually charge
   * it, and this test's central assertion cannot pass by the household simply being broke.
   */
  const exhausting = (): ProjectionSeries =>
    simulateHousehold(
      baseInput(
        [
          account("savings", CAPITAL_GAINS_TAX_PROFILE, 1_000, true),
          account("retirement", PRE_TAX_TAX_PROFILE, 130_000, false, 0.07),
        ],
        { horizonMonths: 36, expenseSeries: [series(6_000, 0, 23)] },
      ),
      jurisdiction,
    );

  // The premise, pinned separately because it is a fact about the SIMULATOR rather than the
  // forecast: this is the thing a January-balance cap structurally cannot predict, and it holds
  // whether or not the forecast has been taught to see it. The regression is the test below.
  it("draws more from the account than it opened the year holding", () => {
    const projection = exhausting();
    const openingCents = projection.months[11]!.accountBalancesCents.retirement;
    const drawnCents = sum(
      projection.months.slice(12, 24).map((m) =>
        m.flows!.incomeSources
          .filter((s) => s.sourceId === "retirement")
          .reduce((t, s) => t + s.cashInflowCents, 0),
      ),
    );

    // The account is genuinely exhausted in year two...
    expect(projection.months[23]!.accountBalancesCents.retirement).toBe(0);
    // ...and funded more than it opened the year holding. This slice — the growth earned before
    // depletion — is exactly what a January-balance cap cannot see.
    expect(drawnCents).toBeGreaterThan(openingCents);
    expect(drawnCents - openingCents).toBeGreaterThan(dollarsToCents(1_000));
  });

  it("leaves the following April with nothing to settle", () => {
    const projection = exhausting();
    // Year three is solvent, so an unpaid balance WOULD be charged here — the assertion below is
    // about the estimate having been right, not about there being no money to charge.
    expect(projection.months.slice(24, 36).every((m) => !m.isInsolvent)).toBe(true);

    // April of year three: $138.29 under the old opening-balance cap, nothing now. The exhaustion
    // year's own twelve instalments carried its liability, which is the whole point of pacing.
    expect(projection.months[27]!.flows!.taxCents).toBe(0);
    // And no other month of year three picked it up instead.
    expect(sum(projection.months.slice(24, 36).map((m) => m.flows!.taxCents))).toBe(0);
    // Not vacuous: the exhaustion year really did pay tax, month by month.
    expect(sum(projection.months.slice(12, 24).map((m) => m.flows!.taxCents))).toBeGreaterThan(
      dollarsToCents(4_000),
    );
  });
});

describe("Federal income tax — the monthly instalment", () => {
  it("splits any annual liability into twelve near-equal payments summing to it exactly", () => {
    // Exactness is what makes December a genuine `actual − paid` difference rather than a
    // rounding residue, so it has to hold for amounts that do not divide by twelve.
    for (const annualCents of [0, 1, 7, 100, 3_000_000, 1_234_567, 999_999_999]) {
      const instalments = Array.from({ length: 12 }, (_, i) =>
        monthlyInstallmentCents(annualCents, i),
      );
      expect(sum(instalments)).toBe(annualCents);
      expect(Math.max(...instalments) - Math.min(...instalments)).toBeLessThanOrEqual(1);
    }
  });
});

describe("Federal income tax — attribution", () => {
  it("sums a month's per-category breakdown exactly to the tax it charged, estimate and settlement alike", () => {
    const projection = simulateHousehold(
      baseInput([account("brokerage", CAPITAL_GAINS_TAX_PROFILE, 200_000, false, 0.12)], {
        incomeSeries: [series(2_000, 0, 11)],
        // Six months of 12%/yr growth first, so the account holds embedded gain (basis <
        // balance) by the time this forces a taxable capital-gains liquidation.
        expenseSeries: [series(50_000, 6, 6)],
      }),
      flatAnnual(0.25),
    );
    for (const month of projection.months) {
      const flows = month.flows!;
      const breakdown = Object.values(flows.taxByCategoryCents ?? {}).reduce(
        (s, v) => s + (v ?? 0),
        0,
      );
      expect(breakdown).toBe(flows.taxCents);
    }
    const december = projection.months[11].flows!;
    // Wages paced the estimate all year; December adds the capital gain the draw realized.
    expect(december.taxByCategoryCents?.capitalGains).toBeGreaterThan(0);
  });
});

describe("Federal income tax — payroll tax is a separate levy, untouched by any of this", () => {
  it("charges the same payroll tax whether or not the household decumulates", () => {
    // Payroll tax is charged on WAGES as they are earned, per month, by its own jurisdiction
    // seam — it is not annual, it is not estimated, and it has no December reconciliation.
    // Forecasting the year's income-tax funding must not perturb it: the two runs below share
    // one wage stream and differ only in a spending line big enough to force a taxable pre-tax
    // withdrawal (and so a much larger income-tax estimate) every month.
    const jurisdiction: Jurisdiction = {
      ...flatAnnual(0.25),
      computePayrollTaxCents: (byCategory) => Math.round((byCategory.wages ?? 0) * 0.0765),
      computePayrollTaxByCategoryCents: (byCategory) => {
        const t = Math.round((byCategory.wages ?? 0) * 0.0765);
        return t > 0 ? { wages: t } : {};
      },
    };
    // Tagged `wages` explicitly — the point of the levy is that it rides EARNINGS, so a pre-tax
    // withdrawal (`ordinaryIncome`) must not attract it however large the decumulation gets.
    const wages: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(5_000), { type: "fixed" }, {
        baselineUnit: "monthly",
        endMonth: 11,
        taxCategory: "wages",
      }),
      ownerId: "p1",
    };
    const run = (expenseSeries: SimOwnedSeries[]): Cents[] =>
      simulateHousehold(
        baseInput(
          [
            account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
            account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
          ],
          { incomeSeries: [wages], expenseSeries },
        ),
        jurisdiction,
      ).months.map((m) => m.flows!.payrollTaxCents);

    const idle = run([]);
    const decumulating = run([series(9_000, 0, 11)]);
    // 7.65% of $5,000, every month, in both runs.
    expect(idle).toEqual(Array(12).fill(Math.round(dollarsToCents(5_000) * 0.0765)));
    expect(decumulating).toEqual(idle);
  });
});
