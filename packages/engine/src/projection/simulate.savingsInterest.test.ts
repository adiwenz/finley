import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
} from "../simAccount";
import { SimCashFlowSeries, dollarsToCents, preciseMonthlyRate, type TaxCategory } from "../cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction";
import { makePerson, monthlyIncome } from "./simulate.testSupport";

describe("Savings interest is taxed as ordinary income at accrual", () => {
  // A cash account's return is interest — taxable as ordinary income in the year it
  // is credited (the 1099-INT), whether or not it is ever withdrawn. Before this the
  // model credited the growth straight to the balance and never booked the tax, so
  // decades of compounding rode untaxed. Flat 10% on ordinary income (wages default to
  // ordinaryIncome), so the tax figure is easy to read off.
  const flatOrdinary10: Jurisdiction = {
    id: "flat-ordinary-10",
    computeTaxCents: (byCat) =>
      Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.1),
    // The per-category breakdown seam — 10% of each taxable category. Supplying
    // it lets the waterfall attribute tax per source, so a source's net cash flow is defined.
    computeTaxByCategoryCents: (byCat) => {
      const out: Partial<Record<TaxCategory, number>> = {};
      for (const [cat, cents] of Object.entries(byCat)) {
        if (cents) out[cat as TaxCategory] = Math.round(cents * 0.1);
      }
      return out;
    },
    // Interest is taxed at accrual as ordinary income; capital appreciation is deferred
    // to withdrawal — the same split the US jurisdiction makes. Keyed on the account's
    // `returnKind` (the brokerage now declares "appreciation" explicitly, so the deferral
    // is this jurisdiction's decision, not an engine default-by-omission).
    returnTaxTreatment: (kind) =>
      kind === "interest"
        ? { taxAtAccrual: true, category: "ordinaryIncome" }
        : { taxAtAccrual: false, category: "capitalGains" },
  };

  /** A liquid cash buffer (savings) — post-tax in, tax-free withdrawal, taxable interest. */
  function savings(openingDollars: number, annualRate: number, id = "savings"): SimAccount {
    return new SimAccount({
      id,
      ownerId: "p1",
      liquid: id === "savings",
      taxProfile: CASH_INTEREST_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(openingDollars),
      initialAnnualRate: annualRate,
    });
  }

  function run(annualRate: number) {
    return simulateHousehold(
      {
        horizonMonths: 4,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [savings(120_000, annualRate)],
        // Steady $3k/mo covers the (absent) obligations; surplus idles into savings, so
        // the buffer is never WITHDRAWN — its interest is the only thing under test.
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
        expenseSeries: [],
      },
      flatOrdinary10,
    );
  }

  it("taxes the credited interest the year after it is credited, never $0 while growing", () => {
    const series = run(0.12); // ~1%/mo on a six-figure buffer → four-figure annual interest
    // Month 1: only wages are taxable — the interest has not compounded yet (accrual
    // lag: compounding runs after the tax seam), so tax is exactly 10% of $3k.
    expect(series.months[1].flows?.taxCents).toBe(dollarsToCents(300));
    // Month 2 onward: last month's credited interest is now taxed on top of wages, so
    // the retirement/earning month no longer reports the wage-only figure.
    expect(series.months[2].flows?.taxCents).toBeGreaterThan(dollarsToCents(300));
    expect(series.months[3].flows?.taxCents).toBeGreaterThan(dollarsToCents(300));
    // The buffer is never drawn — it only grows — yet its interest is still taxed.
    const b1 = series.months[1].accountBalancesCents["savings"];
    const b3 = series.months[3].accountBalancesCents["savings"];
    expect(b3).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(dollarsToCents(120_000));
  });

  it("books nothing when the buffer earns no interest (0% return → wage-only tax)", () => {
    // The control: with a flat cash rate of 0 there is no credited interest, so every
    // month reports the bare wage tax. This isolates the interest as the cause above.
    const series = run(0);
    for (const m of [1, 2, 3, 4]) {
      expect(series.months[m].flows?.taxCents).toBe(dollarsToCents(300));
    }
  });

  it("taxes EVERY cash account's interest, not only the liquid shortfall sink", () => {
    // The model can hold more than one cash account (a second savings/reserve).
    // Interest accrual is a per-account tax keyed on the account's `returnTaxCategory`,
    // not on the single liquid sink, so a second NON-liquid cash buffer's interest
    // must be taxed too. Hold the topology fixed — same liquid buffer, same surplus
    // sweep — and vary ONLY the second account: a brokerage (return deferred, taxed
    // at a withdrawal that never happens → adds no tax) vs a cash reserve (interest
    // taxed at accrual). Same balance and rate on both, so the tax gap is exactly the
    // reserve's interest tax, with no surplus-sweep confound.
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(120_000),
      initialAnnualRate: 0.12,
    });
    const reserve = savings(120_000, 0.12, "reserve"); // a second, NON-liquid cash buffer
    function runWith(second: SimAccount) {
      return simulateHousehold(
        {
          horizonMonths: 4,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [savings(120_000, 0.12), second],
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
          expenseSeries: [],
        },
        flatOrdinary10,
      );
    }
    // Month 2 taxes month 1's credited interest. The brokerage's growth is deferred
    // (never withdrawn → never taxed); the reserve's interest is taxed at accrual, so
    // the reserve run taxes strictly more — it would be EQUAL if the second buffer's
    // interest were dropped (the old single-liquid-account bug).
    const brokerageTax = runWith(brokerage).months[2].flows?.taxCents ?? 0;
    const reserveTax = runWith(reserve).months[2].flows?.taxCents ?? 0;
    expect(reserveTax).toBeGreaterThan(brokerageTax);
    // The gap is ~10% of the reserve's ~$1.1k first-month interest on $120k — the
    // reserve's interest is genuinely booked, not silently dropped or overwritten.
    expect(reserveTax - brokerageTax).toBeGreaterThan(dollarsToCents(100));
  });

  // ── Savings interest is real household cash: the cash-flow reconciliation
  //
  // Interest must reconcile four ways at once — it credits the account, enters the
  // waterfall (once, for tax), shows on the cash-flow view as real cash, and has its tax
  // netted off — WITHOUT being double-counted against the balance. The desired shape, for
  // $500 of interest taxed $100: cash inflow $500, tax $100, net cash flow $400, and the
  // account still credited the full $500 (the tax is paid from other cash, not the balance).

  it("reports credited interest as a cash inflow and nets its tax off (cash flow ≠ zero)", () => {
    const series = run(0.12);
    // Month 2 carries last month's credited interest as a source (month 1 hasn't compounded
    // yet). It is banded — not dropped as it was when it reported waterfallInflowCents 0. The
    // engine tags it with the explicit `savingsInterest` provenance (its tax category stays
    // ordinaryIncome), which is how it is identified — never by parsing its id.
    const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest).toBeDefined();
    expect(interest!.label).toBe("Savings interest");
    expect(interest!.cashInflowCents).toBeGreaterThan(0);
    // Its tax is 10% of the interest (flatOrdinary10), attributed back to the interest
    // source, and the engine's net cash flow is exactly cash inflow − that tax.
    const tax = series.months[2].flows?.taxBySourceCents?.[interest!.sourceId] ?? 0;
    // ~10% of the interest (±1¢ from the largest-remainder apportionment of the category tax).
    expect(Math.abs(tax - Math.round(interest!.cashInflowCents * 0.1))).toBeLessThanOrEqual(1);
    expect(tax).toBeGreaterThan(0);
    expect(interest!.netCashFlowCents).toBe(interest!.cashInflowCents - tax);
    expect(interest!.netCashFlowCents).toBeLessThan(interest!.cashInflowCents); // tax deducted
    // …and it counts toward the household's taxable-income total (wages + interest).
    expect(series.months[2].flows?.totalIncomeCents).toBe(
      dollarsToCents(3_000) + interest!.cashInflowCents,
    );
  });

  it("credits the account exactly once — the interest cash is never re-deposited", () => {
    // No income, no expenses: the only things moving the balance are compounding and the
    // tax on the interest (now drawn from the balance via the shortfall cascade — see below). If
    // the interest booking's cash were (wrongly) re-injected, month 2 would jump by roughly a
    // second interest payment; instead it only grows by the net interest.
    const series = simulateHousehold(
      {
        horizonMonths: 4,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [savings(120_000, 0.12)],
        incomeSeries: [],
        expenseSeries: [],
      },
      flatOrdinary10,
    );
    const opening = dollarsToCents(120_000);
    const r = preciseMonthlyRate(0.12);
    const b1 = series.months[1].accountBalancesCents["savings"];
    const b2 = series.months[2].accountBalancesCents["savings"];
    // Month 1 has no interest source yet (nothing accrued) → pure compounding.
    expect(b1).toBe(Math.round(opening * (1 + r)));
    // Month 2 taxes month 1's interest; with no other income that tax is a deficit funded
    // from the balance, so month 2 is (prior balance − that tax) compounded once — NOT a
    // second interest credit on top.
    const tax = series.months[2].flows?.taxCents ?? 0;
    expect(tax).toBeGreaterThan(0);
    expect(b2).toBe(Math.round((b1 - tax) * (1 + r)));
    // No double-count: month 2's growth is at most one interest payment (net of tax it is
    // less), never the two a re-deposit would add.
    const grewBy = b2 - b1;
    const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest?.cashInflowCents).toBeGreaterThan(0);
    expect(grewBy).toBeLessThan(interest!.cashInflowCents); // net of tax → below one gross payment
  });

  it("keeps flat brokerage ROI as non-cash growth — no interest cash inflow, no accrual tax", () => {
    // A brokerage's return is unrealized appreciation (deferred), not cash: it must never
    // book a cash-inflow source, so paper gains can't inflate the cash-flow view.
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(120_000),
      initialAnnualRate: 0.12,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 4,
        annualInflationRate: 0,
        persons: [makePerson()],
        // A liquid cash sink for surplus, plus the brokerage under test. The cash sink
        // earns 0% so the ONLY candidate for an ordinaryIncome cash inflow is the brokerage.
        accounts: [savings(0, 0, "cash"), brokerage],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
        expenseSeries: [],
      },
      flatOrdinary10,
    );
    for (const m of [1, 2, 3, 4]) {
      const sources = series.months[m].flows?.incomeSources ?? [];
      // The brokerage's growth is deferred — it appears as no savings-interest source at all.
      expect(sources.some((s) => s.category === "savingsInterest")).toBe(false);
      // And its balance still grows untaxed at accrual (wage-only tax every month).
      expect(series.months[m].flows?.taxCents).toBe(dollarsToCents(300));
    }
    expect(series.months[4].accountBalancesCents["brokerage"]).toBeGreaterThan(dollarsToCents(120_000));
  });
});

describe("Already-credited savings interest funds spending without double-counting", () => {
  // The behavioural reconciliation the cash-flow fix is really about: interest that already
  // compounded into the balance can be spent, is reported as real cash, is taxed, and leaves
  // the account reconciling — with no phantom second credit and no false shortfall.
  //   Beginning savings $10,000 · interest +$500 · other income $0 · spending $400 · tax $100
  //   ⇒ cashInflow $500, net cash flow $400, spending funded, ending savings $10,000.
  const flat20: Jurisdiction = {
    id: "flat-ordinary-20",
    computeTaxCents: (byCat) => Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.2),
    computeTaxByCategoryCents: (byCat) => {
      const out: Partial<Record<TaxCategory, number>> = {};
      for (const [cat, cents] of Object.entries(byCat)) {
        if (cents) out[cat as TaxCategory] = Math.round(cents * 0.2);
      }
      return out;
    },
    returnTaxTreatment: (kind) =>
      kind === "interest"
        ? { taxAtAccrual: true, category: "ordinaryIncome" }
        : { taxAtAccrual: false, category: "capitalGains" },
  };

  /**
   * The scenario: $10,000 savings earns exactly $500 in month 1 (5%/month, no spending yet),
   * then the rate drops to 0 so month 2 books no NEW interest. Spending ($400) starts in
   * month 2, when month 1's $500 is reported. So month 2 is the reconciliation month:
   * already-credited interest, real spending, its tax, nothing else moving.
   */
  function runReconciliation() {
    const acct = new SimAccount({
      id: "savings",
      ownerId: "p1",
      liquid: true,
      taxProfile: CASH_INTEREST_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(10_000),
      initialAnnualRate: Math.pow(1.05, 12) - 1, // → preciseMonthlyRate = exactly 5%
    });
    acct.addRateChange(2, 0); // no further interest after month 1's credit
    return simulateHousehold(
      {
        horizonMonths: 3,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acct],
        incomeSeries: [], // other income: $0
        expenseSeries: [
          {
            series: new SimCashFlowSeries(2, dollarsToCents(400), { type: "fixed" }, { baselineUnit: "monthly" }),
            ownerId: "p1",
          },
        ],
      },
      flat20,
    );
  }

  it("reports the $500 interest as cash in, nets its $100 tax to $400, and funds the $400 spend", () => {
    const series = runReconciliation();
    // Month 1 credits exactly $500 (5% on $10,000) — one credit, no spending yet.
    expect(series.months[1].accountBalancesCents["savings"]).toBe(dollarsToCents(10_500));

    const m2 = series.months[2];
    const interest = m2.flows!.incomeSources.find((s) => s.category === "savingsInterest")!;
    // cashInflow = $500: the already-credited interest is reported as real household cash.
    expect(interest.cashInflowCents).toBe(dollarsToCents(500));
    // Its tax is $100 (flat 20%), attributed to the interest source; net cash flow = $400.
    expect(m2.flows!.taxBySourceCents![interest.sourceId]).toBe(dollarsToCents(100));
    expect(interest.netCashFlowCents).toBe(dollarsToCents(400));
    // The $400 spend is funded and the month stays solvent — no FALSE shortfall/insolvency
    // (the gap is genuinely met by the savings the interest is part of).
    expect(m2.flows!.totalSpendingCents).toBe(dollarsToCents(400));
    expect(m2.isInsolvent).toBe(false);
  });

  it("credits the interest exactly once and reconciles fully: beginning + interest − spend − tax", () => {
    const series = runReconciliation();
    const begin = dollarsToCents(10_000);
    const b1 = series.months[1].accountBalancesCents["savings"];
    const b2 = series.months[2].accountBalancesCents["savings"];
    // The interest hits the balance exactly ONCE: month 1 is beginning + $500, full stop —
    // not beginning + $500 + a second re-deposited $500.
    expect(b1).toBe(begin + dollarsToCents(500));
    // Month 2 draws the $400 spend AND the $100 interest tax out of that balance — the tax,
    // owed on income that brought no cash into the waterfall, is funded by the shortfall cascade
    // rather than dropped. Ending reconciles fully: $10,000 + $500 − $400 − $100 = $10,000.
    expect(b2).toBe(begin + dollarsToCents(500) - dollarsToCents(400) - dollarsToCents(100));
    expect(b2).toBe(dollarsToCents(10_000));
  });
});
