import { describe, it, expect } from "vitest";
import {
  SimAccount,
  type SimAccountTaxProfile,
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
 * `rate` above a yearly allowance, so a year that earns less than the allowance owes NOTHING —
 * the only shape in which a full-year estimate can overshoot what the year actually owes, and
 * therefore the only one that exercises a refund.
 */
function flatAnnualWithAllowance(rate: number, allowanceDollars: number): Jurisdiction {
  const scalar = (byCat: Partial<Record<string, number>>): Cents => {
    const total = CATEGORIES.reduce((s, c) => s + (byCat[c] ?? 0), 0);
    return Math.round(Math.max(0, total - dollarsToCents(allowanceDollars)) * rate);
  };
  return {
    id: "flat-annual-allowance",
    computeTaxCents: scalar,
    // Apportioned by taxable weight so Σ === the scalar exactly, whatever the mix.
    computeTaxByCategoryCents: (byCat) =>
      Object.fromEntries(
        apportionByWeight(
          scalar(byCat),
          CATEGORIES.map((c) => [c, byCat[c] ?? 0] as const),
        ),
      ),
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

describe("Federal income tax — December reconciles against the year's ACTUAL income", () => {
  it("anticipates the decumulation an ordinary spend forces, rather than saving it all for December", () => {
    const rate = 0.25;
    const wages = series(2_000, 0, 11); // $24k/yr — nowhere near enough to fund the spend below
    const run = (expenseSeries: SimOwnedSeries[]): ProjectionSeries =>
      simulateHousehold(
        baseInput(
          [
            account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true),
            account("pretax", PRE_TAX_TAX_PROFILE, 500_000),
          ],
          { incomeSeries: [wages], expenseSeries },
        ),
        flatAnnual(rate),
      );
    const steady = monthlyTax(run([]));
    // A $50k obligation in month 6 that only a fully-taxable pre-tax draw can fund. The ACCOUNT
    // it comes out of is discovered by the waterfall — but that the household will be $50k short
    // is plain from the compiled expense series before the year starts, so the year-start
    // forecast prices the withdrawal it will take.
    const withDraw = monthlyTax(run([series(50_000, 6, 6)]));

    // Anticipated, so every month pays a share — including the eleven before December, and
    // including the months BEFORE the spend even lands. That is the whole point: the liability
    // is annual, so the payments are annual too.
    for (let m = 0; m < 11; m++) expect(withDraw[m]!).toBeGreaterThan(steady[m]!);
    // Those eleven are the one estimate, unchanged all year — a later month never re-prices;
    // they differ only by the cumulative rounding that makes twelve instalments sum exactly.
    expect(Math.max(...withDraw.slice(0, 11)) - Math.min(...withDraw.slice(0, 11))).toBeLessThanOrEqual(1);
    // December is a true-up, not the bill. It is still the largest month — an ANNUAL forecast
    // cannot know that the six months of surplus banked before the spend land too late to
    // shrink the month-6 draw — but it is now the same order of magnitude as its neighbours,
    // where deferring all decumulation tax made it roughly twenty-five times them.
    expect(withDraw[11]!).toBeGreaterThan(withDraw[10]!);
    expect(withDraw[11]!).toBeLessThan(withDraw[10]! * 2);
    // Still exactly right in total — a smoother schedule, not a different bill. $24k of wages
    // plus the whole gross withdrawal (basis 0), at 25%.
    const drawn = dollarsToCents(500_000) - run([series(50_000, 6, 6)]).months[11].accountBalancesCents.pretax;
    expect(sum(withDraw)).toBe(Math.round((dollarsToCents(24_000) + drawn) * rate));
  });

  it("makes the year's total charge equal the annual tax on the year's actual taxable income", () => {
    const rate = 0.25;
    // No cash anywhere: the $10k obligation forces a fully-taxable pre-tax draw, and December's
    // remaining bill can only be paid by selling MORE of the same account — which realizes more
    // taxable income, recursively enlarging the bill until sale and bill converge.
    const projection = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
        expenseSeries: [series(10_000, 0, 0)],
      }),
      flatAnnual(rate),
    );
    const taxes = monthlyTax(projection);
    // No SCHEDULED income at all — yet the year is not tax-free, and the estimate knows it: the
    // spend has to come from the pre-tax account, so the forecast prices that withdrawal and
    // charges a twelfth of the result every month.
    for (const tax of taxes.slice(0, 11)) expect(tax).toBeGreaterThan(0);
    // Closed form for a fully-taxable (basis 0) source at flat rate r on an initial withdrawal
    // S: the recursive gross-up converges to tax = r·S / (1 − r). Integer-cent rounding at each
    // step of the climb can land a couple of cents off.
    const expected = Math.round((rate * dollarsToCents(10_000)) / (1 - rate));
    expect(sum(taxes)).toBeGreaterThan(Math.round(dollarsToCents(10_000) * rate));
    expect(Math.abs(sum(taxes) - expected)).toBeLessThanOrEqual(2);
    // Fully funded: the account paid for both the original withdrawal and the settlement's top-up.
    expect(projection.months[11].accountBalancesCents.pretax).toBeLessThan(
      dollarsToCents(1_000_000) - dollarsToCents(10_000),
    );
  });

  it("names the settlement's own sale apart from the account's ordinary draw", () => {
    // A December that both funds an obligation from the pre-tax account AND sells more of it to
    // settle the year: two bands, same account, same month. Sharing the account's bare label put
    // two differently-coloured legend entries reading the same words on the charts, which next
    // to "Required distribution" in a retired year read as an RMD a decade early.
    const projection = simulateHousehold(
      baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 1_000_000)], {
        expenseSeries: [series(10_000, 11, 11)],
      }),
      flatAnnual(0.25),
    );
    const bands = projection.months[11].flows!.incomeSources;
    const labelOf = (sourceId: string) => bands.find((s) => s.sourceId === sourceId)?.label;
    expect(labelOf("pretax")).toBe("pretax");
    expect(labelOf("tax-settlement:pretax")).toBe("pretax — sold to settle tax");
  });

  it("charges exactly the jurisdiction's annual tax on the year's actual base, under a progressive schedule", () => {
    const jurisdiction = progressiveAnnual();
    // $96k of wages the estimate paces on, and a $40k obligation in month 6 that only the
    // fully-taxable pre-tax account can fund — income the estimate never saw, landing in the
    // 35% band the wages alone never reached. Ample cash by December, so the settlement is paid
    // without selling more and the year's base is exactly these two figures.
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

    // The invariant the whole model rests on: twelve instalments plus December's reconciliation
    // come to the annual liability on the year's actual taxable income, to the cent — no
    // rounding residue, and no dependence on which month the $40k landed in.
    expect(sum(taxes)).toBe(jurisdiction.computeTaxCents(actualBase, { year: 2026 }));
    // The spend's funding is EXPLICIT — the obligation names `pretax` and the amount — so the
    // estimate does not have to forecast which account pays or guess at the gain: it prices the
    // draw through the same resolver the simulator will use, and the year is estimated on the
    // full $136k from January. December is therefore an ordinary twelfth like every other month,
    // not the reconciliation of a $40k surprise, even though the rate genuinely jumps a bracket.
    const estimated = jurisdiction.computeTaxCents(actualBase, { year: 2026 });
    expect(sum(taxes.slice(0, 11))).toBe(estimated - monthlyInstallmentCents(estimated, 11));
    expect(taxes[11]).toBe(monthlyInstallmentCents(estimated, 11));
    expect(Math.max(...taxes) - Math.min(...taxes)).toBeLessThanOrEqual(1);
  });

  it("combines two mid-year withdrawals into one annual base rather than two separate bills", () => {
    const rate = 0.2;
    const run = (expenseSeries: SimOwnedSeries[]): Cents =>
      sum(
        monthlyTax(
          simulateHousehold(
            baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 100_000)], { expenseSeries }),
            flatAnnual(rate),
          ),
        ),
      );
    // $5k drawn in month 0 and $5k in month 6 must cost exactly what a single $10k draw costs:
    // the year's tax depends on the year's total, never on how it was split across months.
    expect(run([series(5_000, 0, 0), series(5_000, 6, 6)])).toBe(run([series(10_000, 0, 0)]));
  });

  it("refunds an overshooting estimate in a single settlement, never month by month", () => {
    const rate = 0.25;
    // $50k of the year's income is untaxed, so a year cut short at $40k owes nothing at all —
    // while the estimate, priced on a full $120k year, has been collecting all along.
    const projection = simulateHousehold(
      baseInput([account("checking", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [series(10_000, 0, 11)],
        // Far beyond anything "checking" holds, so the run is blocked (and the tax year settled)
        // at month 3 rather than ever reaching December.
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
      flatAnnualWithAllowance(rate, 50_000),
    );
    expect(projection.status).toBe("blocked");
    const taxes = monthlyTax(projection);
    // Every month before the settlement CHARGED — a refund is never spread backwards.
    for (const tax of taxes.slice(0, 3)) expect(tax).toBeGreaterThan(0);
    // One refund, in the settling month, of exactly what the estimate over-collected.
    expect(taxes[3]).toBeLessThan(0);
    expect(sum(taxes)).toBe(0); // the year's actual liability on $40k
  });

  it("settles a year truncated by a funding block instead of carrying it into a December that never comes", () => {
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
    // 25% of the four months of wages that actually landed ($40k) — the year is priced on what
    // happened, not on the full twelve months the estimate was pacing towards.
    expect(sum(monthlyTax(projection))).toBe(dollarsToCents(10_000));
  });
});

/**
 * THE REGRESSION. A retired household living off its accounts: the shape in which deferring
 * every decumulation dollar of tax to December produced a five-figure December charge, year
 * after year, against near-zero months either side of it — a sawtooth in the tax chart and a
 * matching one in net worth.
 *
 * Nothing here is scheduled income. The whole tax bill comes from withdrawals the funding
 * waterfall decides on month by month, which is exactly what the year-start estimate could not
 * see and now forecasts.
 */
describe("Federal income tax — a retired household decumulating, over four full years", () => {
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
  const YEARS = 4;

  /**
   * The reported shape: cash and brokerage a tenth of the pre-tax account each, no wages, no
   * benefit, and ordinary living costs that can only come out of the retirement account once the
   * first $20k is gone. The pre-tax balance is sized so FOUR complete years of decumulation fit —
   * at the reported $100k it would be exhausted inside two, and the recurring December spike is
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

  it("anticipates the taxable decumulation and charges it across the year, not in December", () => {
    const taxes = monthlyTax(retired());

    for (let y = 0; y < YEARS; y++) {
      const months = yearOf(taxes, y);
      const december = months[11]!;
      const annual = sum(months);
      // The year-start estimate saw the decumulation coming: January charges, and so does every
      // month after it. Before this, a year with no scheduled income estimated $0 and charged
      // nothing at all until December.
      for (const [i, tax] of months.entries()) {
        expect(tax, `year ${y} month ${i}`).toBeGreaterThan(0);
      }
      // The eleven instalments are one flat estimate, not a ramp — the year is priced once, in
      // January, and never re-priced from year-to-date income.
      const instalments = months.slice(0, 11);
      expect(Math.max(...instalments) - Math.min(...instalments)).toBeLessThanOrEqual(1);
      // December is a TRUE-UP now. Deferring all of it made December the entire annual bill —
      // 100% of the year — against $0 in the eleven months before. It is now a small correction
      // for what an annual forecast cannot know (which month each draw lands in, and against
      // what balances), comfortably under a fifth of the year.
      expect(december, `year ${y} December`).toBeLessThan(Math.round(annual * 0.2));
    }
  });

  it("still charges exactly the jurisdiction's annual tax on the year's actual taxable income", () => {
    const projection = retired();
    const taxes = monthlyTax(projection);
    const retirementAt = (m: number): Cents => projection.months[m]!.accountBalancesCents.retirement!;

    for (let y = 0; y < YEARS; y++) {
      // Basis 0, so every cent that left the pre-tax account in this year IS this year's taxable
      // income — including whatever December's settlement itself had to sell.
      const opening = y === 0 ? dollarsToCents(500_000) : retirementAt(y * 12 - 1);
      const drawn = opening - retirementAt(y * 12 + 11);
      expect(sum(yearOf(taxes, y)), `year ${y}`).toBe(
        jurisdiction.computeTaxCents({ ordinaryIncome: drawn }, { year: 2026 + y }),
      );
    }
  });

  it("draws net worth down smoothly, with no December cliff", () => {
    const netWorth = retired().months.map((m) => m.netWorthNominalCents!);
    const drops = netWorth.slice(1).map((v, i) => netWorth[i]! - v);
    // A spending household's net worth falls every month; the question is whether it falls a
    // roughly equal amount each time. The recurring December cliff was several times the
    // surrounding months. Every month is now within 2× the median.
    const median = [...drops].sort((a, b) => a - b)[Math.floor(drops.length / 2)]!;
    expect(median).toBeGreaterThan(0);
    for (const december of [11, 23, 35]) {
      expect(drops[december], `December of year ${Math.floor(december / 12)}`).toBeLessThan(
        median * 2,
      );
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
