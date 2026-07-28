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
  // Cash interest is ordinary income in the year it is credited (1099-INT), withdrawn or
  // not. Flat 10% so the tax figure is easy to read off.
  const flatOrdinary10: Jurisdiction = {
    id: "flat-ordinary-10",
    computeTaxCents: (byCat) =>
      Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.1),
    // Per-category tax lets the waterfall attribute tax per source.
    computeTaxByCategoryCents: (byCat) => {
      const out: Partial<Record<TaxCategory, number>> = {};
      for (const [cat, cents] of Object.entries(byCat)) {
        if (cents) out[cat as TaxCategory] = Math.round(cents * 0.1);
      }
      return out;
    },
    // The same split the US jurisdiction makes; the deferral is the jurisdiction's call.
    returnTaxTreatment: (kind) =>
      kind === "interest"
        ? { taxAtAccrual: true, category: "ordinaryIncome" }
        : { taxAtAccrual: false, category: "capitalGains" },
  };

  function savings(openingDollars: number, annualRate: number, id = "savings"): SimAccount {
    return new SimAccount({
      id,
      ownerId: "p1",
      // Only the default is labelled; the rest fall back to the id.
      label: id === "savings" ? "Cash savings" : id,
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
        // Steady $3k/mo so the buffer is never drawn — only its interest is under test.
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
        expenseSeries: [],
      },
      flatOrdinary10,
    );
  }

  it("taxes the credited interest the year after it is credited, never $0 while growing", () => {
    const series = run(0.12); // ~1%/mo on a six-figure buffer → four-figure annual interest
    // Compounding runs after the tax seam, so month 0 (the first processed month) has no
    // accrued interest yet — wage-only tax.
    expect(series.months[0].flows?.taxCents).toBe(dollarsToCents(300));
    // Then last month's credited interest is taxed on top of wages.
    expect(series.months[1].flows?.taxCents).toBeGreaterThan(dollarsToCents(300));
    expect(series.months[2].flows?.taxCents).toBeGreaterThan(dollarsToCents(300));
    // Never drawn, only growing — yet still taxed.
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b3 = series.months[2].accountBalancesCents["savings"];
    expect(b3).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(dollarsToCents(120_000));
  });

  it("books nothing when the buffer earns no interest (0% return → wage-only tax)", () => {
    // Control: at a 0 rate no interest is credited, isolating it as the cause of the rise above.
    const series = run(0);
    for (const m of [0, 1, 2, 3]) {
      expect(series.months[m].flows?.taxCents).toBe(dollarsToCents(300));
    }
  });

  it("taxes EVERY cash account's interest, not only the liquid shortfall sink", () => {
    // Accrual tax is keyed on the account's `returnKind`, not on the single liquid sink.
    // Only the second account varies — brokerage (deferred) vs cash reserve — at equal
    // balance and rate, so the tax gap is exactly the reserve's interest tax.
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
    // Month 2 taxes month 1's interest. Equal figures would mean the non-liquid buffer's
    // interest was dropped.
    const brokerageTax = runWith(brokerage).months[2].flows?.taxCents ?? 0;
    const reserveTax = runWith(reserve).months[2].flows?.taxCents ?? 0;
    expect(reserveTax).toBeGreaterThan(brokerageTax);
    // The gap is ~10% of the reserve's ~$1.1k first-month interest on $120k.
    expect(reserveTax - brokerageTax).toBeGreaterThan(dollarsToCents(100));
  });

  it("bands each cash account's interest separately, under its own name", () => {
    // Merging the two into one per-owner line made a drained buffer look like it was still
    // earning its neighbour's interest. The app's Simple view re-collapses them.
    const reserve = savings(120_000, 0.12, "reserve");
    const series = simulateHousehold(
      {
        horizonMonths: 4,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [savings(120_000, 0.12), reserve],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
        expenseSeries: [],
      },
      flatOrdinary10,
    );
    const interest = (series.months[2].flows?.incomeSources ?? []).filter(
      (s) => s.category === "savingsInterest",
    );
    expect(interest.map((s) => s.sourceId).sort()).toEqual(["interest:reserve", "interest:savings"]);
    expect(interest.find((s) => s.sourceId === "interest:savings")!.label).toBe("Cash savings");
    expect(interest.find((s) => s.sourceId === "interest:reserve")!.label).toBe("reserve");
    for (const s of interest) expect(s.cashInflowCents).toBeGreaterThan(0);
  });

  it("reports credited interest as a cash inflow and nets its tax off (cash flow ≠ zero)", () => {
    const series = run(0.12);
    // Identified by explicit `savingsInterest` provenance, never by parsing the id.
    const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest).toBeDefined();
    expect(interest!.label).toBe("Cash savings");
    expect(interest!.sourceId).toBe("interest:savings");
    expect(interest!.cashInflowCents).toBeGreaterThan(0);
    const tax = series.months[2].flows?.taxBySourceCents?.[interest!.sourceId] ?? 0;
    // ~10% of the interest (±1¢ from the largest-remainder apportionment of the category tax).
    expect(Math.abs(tax - Math.round(interest!.cashInflowCents * 0.1))).toBeLessThanOrEqual(1);
    expect(tax).toBeGreaterThan(0);
    expect(interest!.netCashFlowCents).toBe(interest!.cashInflowCents - tax);
    expect(interest!.netCashFlowCents).toBeLessThan(interest!.cashInflowCents);
    expect(series.months[2].flows?.totalIncomeCents).toBe(
      dollarsToCents(3_000) + interest!.cashInflowCents,
    );
  });

  it("credits the account exactly once — the interest cash is never re-deposited", () => {
    // No income or expenses: only compounding and the interest tax (drawn from the balance
    // via the shortfall cascade) move it. Re-injecting the booking's cash would jump month
    // 2 by roughly a second interest payment.
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
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b2 = series.months[1].accountBalancesCents["savings"];
    // Month 0 (first processed): nothing accrued yet → pure compounding.
    expect(b1).toBe(Math.round(opening * (1 + r)));
    // With no other income the tax is a deficit funded from the balance, so month 1 is
    // (prior − tax) compounded once, not a second credit.
    const tax = series.months[1].flows?.taxCents ?? 0;
    expect(tax).toBeGreaterThan(0);
    expect(b2).toBe(Math.round((b1 - tax) * (1 + r)));
    // No double-count: month 1's growth is below one interest payment (net of tax), never the
    // two a re-deposit would add.
    const grewBy = b2 - b1;
    const interest = series.months[1].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest?.cashInflowCents).toBeGreaterThan(0);
    expect(grewBy).toBeLessThan(interest!.cashInflowCents);
  });

  it("keeps flat brokerage ROI as non-cash growth — no interest cash inflow, no accrual tax", () => {
    // A brokerage's return is deferred unrealized appreciation, not cash: it must never book
    // a cash-inflow source, or paper gains would inflate the cash-flow view.
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
        // The liquid surplus sink earns 0%, so the ONLY candidate for a savings-interest
        // inflow is the brokerage.
        accounts: [savings(0, 0, "cash"), brokerage],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
        expenseSeries: [],
      },
      flatOrdinary10,
    );
    for (const m of [0, 1, 2, 3]) {
      const sources = series.months[m].flows?.incomeSources ?? [];
      expect(sources.some((s) => s.category === "savingsInterest")).toBe(false);
      // Its balance still grows untaxed at accrual — wage-only tax every month.
      expect(series.months[m].flows?.taxCents).toBe(dollarsToCents(300));
    }
    expect(series.months[3].accountBalancesCents["brokerage"]).toBeGreaterThan(dollarsToCents(120_000));
  });
});

describe("Already-credited savings interest funds spending without double-counting", () => {
  // Interest that already compounded into the balance can be spent, is reported as real cash,
  // is taxed, and leaves the account reconciling:
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
   * $10,000 savings earns exactly $500 in month 0 (5%/month) — the first processed month —
   * then the rate drops to 0 so month 1 books no NEW interest. Spending ($400) starts in
   * month 1 — the reconciliation month: already-credited interest, real spending, its tax,
   * nothing else moving. The rate-change and spend land at month 1 (not 2) so that exactly
   * ONE 5% month precedes the reconciliation, now that month 0 is a processed flow month.
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
    acct.addRateChange(1, 0); // no further interest after month 0's credit
    return simulateHousehold(
      {
        horizonMonths: 3,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acct],
        incomeSeries: [],
        expenseSeries: [
          {
            series: new SimCashFlowSeries(1, dollarsToCents(400), { type: "fixed" }, { baselineUnit: "monthly" }),
            ownerId: "p1",
          },
        ],
      },
      flat20,
    );
  }

  it("reports the $500 interest as cash in, nets its $100 tax to $400, and funds the $400 spend", () => {
    const series = runReconciliation();
    // Month 0 credits exactly $500 (5% on $10,000) — one credit, no spending yet.
    expect(series.months[0].accountBalancesCents["savings"]).toBe(dollarsToCents(10_500));

    const recon = series.months[1]; // the reconciliation month
    const interest = recon.flows!.incomeSources.find((s) => s.category === "savingsInterest")!;
    expect(interest.cashInflowCents).toBe(dollarsToCents(500));
    // $100 tax (flat 20%), attributed to the interest source → $400 net.
    expect(recon.flows!.taxBySourceCents![interest.sourceId]).toBe(dollarsToCents(100));
    expect(interest.netCashFlowCents).toBe(dollarsToCents(400));
    // No FALSE insolvency — the gap is genuinely met by the savings the interest is part of.
    expect(recon.flows!.totalSpendingCents).toBe(dollarsToCents(400));
    expect(recon.isInsolvent).toBe(false);
  });

  it("credits the interest exactly once and reconciles fully: beginning + interest − spend − tax", () => {
    const series = runReconciliation();
    const begin = dollarsToCents(10_000);
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b2 = series.months[1].accountBalancesCents["savings"];
    // The interest hits the balance exactly ONCE: month 0 is beginning + $500, not
    // beginning + $500 + a re-deposited $500.
    expect(b1).toBe(begin + dollarsToCents(500));
    // Month 1 draws the $400 spend AND the $100 interest tax from that balance: the tax, owed
    // on income that brought no cash into the waterfall, is funded by the shortfall cascade
    // rather than dropped. Ending reconciles: $10,000 + $500 − $400 − $100 = $10,000.
    expect(b2).toBe(begin + dollarsToCents(500) - dollarsToCents(400) - dollarsToCents(100));
    expect(b2).toBe(dollarsToCents(10_000));
  });
});
