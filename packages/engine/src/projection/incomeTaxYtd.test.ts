/**
 * End-to-end acceptance coverage for income tax reconciled from YTD taxable income rather
 * than each month's own annualized (×12) slice. Unit coverage for the reconciliation
 * arithmetic itself lives in incomeTax.test.ts; this file exercises it through the full
 * monthly simulation pipeline (RMD, wages, decumulation) the way a real plan would.
 *
 * A synthetic progressive jurisdiction stands in for a rules package the engine cannot
 * import (the same convention `fundingDrawStep.test.ts`/`withdrawal.test.ts` use) — 0% up to
 * $50k of combined ordinary/capital-gains income, 40% above, so timing within the year
 * changes the naive (pre-reconciliation) answer but never the YTD-reconciled one.
 */

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
import { buildWithdrawalSources, type WithdrawalState } from "./withdrawal";
import type { YtdTaxState } from "./incomeTax";

const THRESHOLD = dollarsToCents(50_000);
const RATE = 0.4;

/** 0% to $50k of combined ordinaryIncome + capitalGains, 40% above — one shared bracket. */
const progressive: Jurisdiction = {
  id: "progressive-40-over-50k",
  computeTaxCents: (a) => {
    const total = (a.ordinaryIncome ?? 0) + (a.capitalGains ?? 0) + (a.wages ?? 0);
    return Math.round(Math.max(0, total - THRESHOLD) * RATE);
  },
  computeTaxByCategoryCents: (a) => {
    const total = (a.ordinaryIncome ?? 0) + (a.capitalGains ?? 0) + (a.wages ?? 0);
    const tax = Math.round(Math.max(0, total - THRESHOLD) * RATE);
    if (tax <= 0 || total <= 0) return {};
    // Proportional split across whichever categories are present — reporting only.
    const out: Partial<Record<string, number>> = {};
    for (const [cat, amt] of Object.entries({ ordinaryIncome: a.ordinaryIncome, capitalGains: a.capitalGains, wages: a.wages })) {
      if (amt) out[cat] = Math.round((tax * amt) / total);
    }
    // Largest-remainder correction so Σ === tax exactly.
    const sum = Object.values(out).reduce((s: number, v) => s + (v ?? 0), 0);
    const diff = tax - sum;
    if (diff !== 0) {
      const firstKey = Object.keys(out)[0];
      if (firstKey) out[firstKey] = (out[firstKey] ?? 0) + diff;
    }
    return out;
  },
  requiredMinimumDistributionCents: (balance, ctx) => (ctx.age >= 73 ? balance : 0), // forces the whole balance
};

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

function baseInput(
  person: SimPerson,
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): HouseholdSimInput {
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

/** Σ of every processed month's tax charge across the given month range (inclusive). */
function cumulativeTaxCents(series: ReturnType<typeof simulateHousehold>, from: number, to: number): number {
  let total = 0;
  for (let m = from; m <= to; m++) total += series.months[m]?.flows?.taxCents ?? 0;
  return total;
}

describe("Income tax reconciles from YTD taxable income, not each month's own annualized slice", () => {
  it("an RMD forced entirely into one month is not taxed as though it recurred every month", () => {
    // $120k RMD, forced whole in month 0 (age 73). True annual tax: 40% of (120k − 50k) = $28k.
    // The naive monthly annualization this reconciliation replaces would instead charge
    // round(0.4×(120k×12−50k)/12)
    // ≈ $46,333 in January ALONE — vastly more than the true annual liability.
    const rmdAgePerson: SimPerson = { id: "p1", name: "You", birthYear: 2026 - 73 };
    const series = simulateHousehold(
      baseInput(rmdAgePerson, [
        account("pretax", PRE_TAX_TAX_PROFILE, 120_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      progressive,
    );
    const trueAnnualTax = dollarsToCents(28_000);
    expect(cumulativeTaxCents(series, 0, 11)).toBe(trueAnnualTax);
    // January (month 0, monthsElapsed 1) has nothing else to go on and reads the SAME
    // inflated naive estimate Part 1 would have charged (assuming $120k/mo might recur all
    // year) — the fix isn't a smaller January charge, it's that later months, seeing the
    // SAME $120k YTD spread over more elapsed months, revise the pace down and REFUND the
    // overcharge (see incomeTax.test.ts for the isolated month-by-month arithmetic), so the
    // running total still reconciles to the true annual liability by December.
    expect(series.months[0].flows?.taxCents).toBe(46_333_33);
    expect(series.months[1].flows?.taxCents ?? 0).toBeLessThan(0); // February refunds part of it
  });

  it("an RMD forced into January and the same total delivered as twelve equal distributions owe identical annual tax", () => {
    // Direct A/B companion to the test above: rather than checking the RMD's cumulative tax
    // against a hand-computed constant, run a SECOND household that receives the identical
    // $120k total spread evenly across the year (not age-triggered, so nothing forces it —
    // a stand-in for "the same dollars, paid out monthly instead of yanked out at once") and
    // assert the two households' cumulative tax is EQUAL, not just that both separately equal
    // $28k. This is what pins the RMD path (simulateHousehold's automatic
    // requiredMinimumDistributionCents forcing) to the SAME reconciliation the ordinary
    // income path uses, rather than trusting two independent calculations to agree by luck.
    const rmdAgePerson: SimPerson = { id: "p1", name: "You", birthYear: 2026 - 73 };
    const lumpSeries = simulateHousehold(
      baseInput(rmdAgePerson, [
        account("pretax", PRE_TAX_TAX_PROFILE, 120_000),
        account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true),
      ]),
      progressive,
    );

    const notYetRmdAge: SimPerson = { id: "p1", name: "You", birthYear: 2026 - 40 };
    const distributions: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(10_000), { type: "fixed" }, { baselineUnit: "monthly" }),
      ownerId: "p1",
    };
    const spreadSeries = simulateHousehold(
      baseInput(notYetRmdAge, [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [distributions],
      }),
      progressive,
    );

    const trueAnnualTax = dollarsToCents(28_000);
    expect(cumulativeTaxCents(lumpSeries, 0, 11)).toBe(trueAnnualTax);
    expect(cumulativeTaxCents(spreadSeries, 0, 11)).toBe(trueAnnualTax);
    expect(cumulativeTaxCents(lumpSeries, 0, 11)).toBe(cumulativeTaxCents(spreadSeries, 0, 11));
  });

  it("a bonus stacked onto steady wages is taxed as part of the year's actual total, not as though it recurred monthly", () => {
    // $60k/yr steady wages ($5k/mo) plus a single $20k bonus in month 6. True annual tax on
    // the combined $80k: 40% of (80k − 50k) = $12k.
    const wages: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(5_000), { type: "fixed" }, { baselineUnit: "monthly" }),
      ownerId: "p1",
    };
    const bonus: SimOwnedSeries = {
      series: new SimCashFlowSeries(6, dollarsToCents(20_000), { type: "fixed" }, {
        baselineUnit: "monthly",
        endMonth: 6,
      }),
      ownerId: "p1",
    };
    const person: SimPerson = { id: "p1", name: "You" };
    const series = simulateHousehold(
      baseInput(person, [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [wages, bonus],
      }),
      progressive,
    );
    expect(cumulativeTaxCents(series, 0, 11)).toBe(dollarsToCents(12_000));
  });

  it("a $120k bonus paid as one January lump sum or spread evenly across the year owes identical annual tax", () => {
    // Direct A/B: two households earning the SAME $120k over the same year, differing only
    // in timing. Both must reconcile to the same true annual liability — 40% of (120k − 50k)
    // = $28k — proving the invariant holds for household-level WAGE income exactly as it
    // does for the pure reconciliation arithmetic (incomeTax.test.ts) and for the RMD
    // decumulation path above.
    const lumpBonus: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(120_000), { type: "fixed" }, {
        baselineUnit: "monthly",
        endMonth: 0,
      }),
      ownerId: "p1",
    };
    const person: SimPerson = { id: "p1", name: "You" };
    const lumpSeries = simulateHousehold(
      baseInput(person, [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [lumpBonus],
      }),
      progressive,
    );

    const spreadWages: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(10_000), { type: "fixed" }, { baselineUnit: "monthly" }),
      ownerId: "p1",
    };
    const spreadSeries = simulateHousehold(
      baseInput(person, [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [spreadWages],
      }),
      progressive,
    );

    const trueAnnualTax = dollarsToCents(28_000);
    expect(cumulativeTaxCents(lumpSeries, 0, 11)).toBe(trueAnnualTax);
    expect(cumulativeTaxCents(spreadSeries, 0, 11)).toBe(trueAnnualTax);
    expect(cumulativeTaxCents(lumpSeries, 0, 11)).toBe(cumulativeTaxCents(spreadSeries, 0, 11));
  });

  it("a new calendar year starts income tax fresh — January owes nothing on last year's income", () => {
    const wages: SimOwnedSeries = {
      series: new SimCashFlowSeries(0, dollarsToCents(6_000), { type: "fixed" }, { baselineUnit: "monthly" }),
      ownerId: "p1",
    };
    const person: SimPerson = { id: "p1", name: "You" };
    const series = simulateHousehold(
      baseInput(person, [account("cash", CAPITAL_GAINS_TAX_PROFILE, 0, true)], {
        incomeSeries: [wages],
        horizonMonths: 24,
      }),
      progressive,
    );
    // Identical steady $6k/mo wages every month → January of year 1 and January of year 2
    // (month 12) must charge the SAME amount; year 2 carries none of year 1's YTD forward.
    expect(series.months[12].flows?.taxCents).toBe(series.months[0].flows?.taxCents);
    // Each year's cumulative independently reconciles to the true annual liability on $72k:
    // 40% of (72k − 50k) = $8,800.
    const trueAnnualTax = dollarsToCents(8_800);
    expect(cumulativeTaxCents(series, 0, 11)).toBe(trueAnnualTax);
    expect(cumulativeTaxCents(series, 12, 23)).toBe(trueAnnualTax);
  });

  it("a second taxable withdrawal later in the year stacks on the first's YTD base, not priced standalone", () => {
    // Two draws from separate fully-appreciated (basis 0) accounts, both priced at
    // monthsElapsed 12 (December) so annualizeYtd does not inflate a one-time draw as though
    // it recurred — isolating the STACKING behavior (the second draw's marginal price sees
    // the first's realized gain already in its YTD base) from the separate recurrence-
    // annualization behavior the RMD test above covers.
    const ctx = { year: 2026 };
    const accounts = [
      account("brokerage-a", CAPITAL_GAINS_TAX_PROFILE, 100_000),
      account("brokerage-b", CAPITAL_GAINS_TAX_PROFILE, 100_000),
    ];
    const state: WithdrawalState = {
      accounts,
      assetBalances: new Map(accounts.map((a) => [a.id, dollarsToCents(100_000)])),
      basisByAccount: new Map(),
      liquidAccount: null,
    };
    const priorYtdByOwner = new Map<string, YtdTaxState>();
    function stateFor(ownerId: string): YtdTaxState {
      return priorYtdByOwner.get(ownerId) ?? { taxableByCategory: {}, taxPaidCents: 0 };
    }

    // First draw of $30k, alone — under the $50k threshold, so untaxed.
    const first = buildWithdrawalSources(
      state,
      progressive,
      [],
      dollarsToCents(30_000),
      ctx,
      undefined,
      undefined,
      (ownerId) => stateFor(ownerId),
      12,
    );
    const firstTax = first.decumulationDraws.reduce((s, d) => s + d.taxCents, 0);
    expect(firstTax).toBe(0);
    priorYtdByOwner.set("p1", {
      taxableByCategory: { capitalGains: first.decumulationDraws.reduce((s, d) => s + d.realizedGainCents, 0) },
      taxPaidCents: firstTax,
    });

    // A second $30k draw. Combined YTD ($60k) crosses the threshold, so THIS draw alone
    // bears the tax on the $10k excess — proving it priced against the stacked base, not as
    // if it were the year's only draw (which would again read $0).
    const second = buildWithdrawalSources(
      state,
      progressive,
      [],
      dollarsToCents(30_000),
      ctx,
      undefined,
      undefined,
      (ownerId) => stateFor(ownerId),
      12,
    );
    const secondTax = second.decumulationDraws.reduce((s, d) => s + d.taxCents, 0);
    expect(secondTax).toBeGreaterThan(0);
  });
});
