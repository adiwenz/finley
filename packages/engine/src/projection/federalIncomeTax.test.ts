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
    expect(projection.months[0].flows!.incomeByCategoryCents["ordinaryIncome"]).toBe(
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
  it("charges an endogenous taxable withdrawal in December, leaving earlier months untouched", () => {
    const rate = 0.25;
    const wages = series(2_000, 0, 11); // $24k/yr — nowhere near enough to fund the spend below
    const run = (expenseSeries: SimOwnedSeries[]): ProjectionSeries =>
      simulateHousehold(
        baseInput([account("pretax", PRE_TAX_TAX_PROFILE, 500_000)], {
          incomeSeries: [wages],
          expenseSeries,
        }),
        flatAnnual(rate),
      );
    const steady = monthlyTax(run([]));
    // A $50k obligation in month 6 that only a fully-taxable pre-tax draw can fund: taxable
    // income the year's estimate could not have known about.
    const withDraw = monthlyTax(run([series(50_000, 6, 6)]));

    // Every month before December is the SAME estimate in both runs — the mid-year draw does
    // not retroactively raise the instalments already paid, nor the month it lands in.
    expect(withDraw.slice(0, 11)).toEqual(steady.slice(0, 11));
    // The whole difference lands in December's reconciliation.
    expect(withDraw[11]).toBeGreaterThan(steady[11]);
    expect(sum(withDraw) - sum(steady)).toBe(withDraw[11] - steady[11]);
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
    // Nothing was scheduled, so no instalment was estimated; the whole year settles in December.
    expect(taxes.slice(0, 11)).toEqual(Array(11).fill(0));
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
    // And the estimate really was wrong, so the equality is doing work rather than holding
    // because nothing needed reconciling: the eleven months before December are the wages-only
    // estimate to the cent, and December carries the whole difference.
    const estimated = jurisdiction.computeTaxCents(
      { ordinaryIncome: dollarsToCents(96_000) },
      { year: 2026 },
    );
    expect(sum(taxes.slice(0, 11))).toBe(estimated - monthlyInstallmentCents(estimated, 11));
    expect(taxes[11]).toBeGreaterThan(taxes[0]);
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
 * A funding draw's taxable slice depends on the funding account's balance and cost basis in the
 * month it lands — both of them products of the year's returns, earlier draws and tax already
 * paid — so it is unknowable at the year's start and belongs to December. These pin both halves:
 * the draw is not enlarged to prepay its own tax, and the tax still gets collected.
 */
describe("Federal income tax — funding draws are not knowable at year start", () => {
  const WAGE_MONTHLY_TAX = dollarsToCents(2_500); // 25% of $120k/yr, in twelfths

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
  ] as const)("does not gross up %s, and settles its tax in December", (_label, treatment) => {
    const projection = withDraw(treatment);
    const taxes = monthlyTax(projection);

    // Exactly $100k left the account — not $133k sold to prepay the tax the sale itself causes.
    expect(projection.months[4].accountBalancesCents.pretax).toBe(
      dollarsToCents(500_000 - 100_000),
    );
    // The $100k IS the year's actual taxable income, booked in the month it was realized —
    // that month's ordinary income is the usual $10k of pay plus the whole draw.
    const ordinaryIn = (m: number): Cents =>
      projection.months[m].flows!.incomeByCategoryCents["ordinaryIncome"] ?? 0;
    expect(ordinaryIn(4) - ordinaryIn(3)).toBe(dollarsToCents(100_000));
    // The estimate never saw it: every month up to December is the wages-only instalment, and
    // the month of the draw is no heavier than the others.
    expect(taxes.slice(0, 11)).toEqual(Array(11).fill(WAGE_MONTHLY_TAX));
    // December trues up the whole $100k at once, out of the cash the year's wages built up.
    expect(taxes[11]).toBe(WAGE_MONTHLY_TAX + dollarsToCents(25_000));
    expect(sum(taxes)).toBe(dollarsToCents(30_000 + 25_000));
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
