import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
} from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents, preciseMonthlyRate, type TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { makePerson, monthlyIncome } from "./simulate.testSupport";

describe("Savings interest is taxed as ordinary income at accrual", () => {
  // Cash interest is ordinary income in the year it is credited (1099-INT), withdrawn or
  // not. Flat 10% so the tax figure is easy to read off.
  const flatOrdinary10: Jurisdiction = {
    id: "flat-ordinary-10",
    computeTaxCents: (byCat) =>
      Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.1),
    // Matches `computeTaxCents`'s category set exactly (ordinaryIncome/wages only) — NOT every
    // category present. A draw funding an April tax balance can introduce a `taxExempt` slice (a
    // cash account's withdrawal category: the growth over its cost basis was already taxed at
    // accrual, so a jurisdiction must charge it nothing); taxing every key blindly would silently
    // overtax that slice and break the Σ-breakdown-equals-scalar contract the engine asserts.
    computeTaxByCategoryCents: (byCat) => {
      const out: Partial<Record<TaxCategory, number>> = {};
      for (const cat of ["ordinaryIncome", "wages"] as const) {
        const cents = byCat[cat] ?? 0;
        if (cents) out[cat] = Math.round(cents * 0.1);
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

  // A full calendar year plus the following April (horizon 16), because that is where the year's
  // balance is now settled: December closes the year's arithmetic, April moves its money. Wages
  // are scheduled, so the year's estimate paces them evenly; interest is not, so the tax on it is
  // exactly what the year has left to settle.
  const WAGE_ONLY_MONTHLY_TAX = dollarsToCents(300); // 10% of $3,000/mo × 12, spread over 12
  /** The month the tax year that starts at month 0 settles in: April of the next year. */
  const SETTLEMENT_MONTH = 15;
  function run(annualRate: number, horizonMonths = 16) {
    return simulateHousehold(
      {
        horizonMonths,
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

  it("paces the year's credited interest monthly alongside the wages, leaving April nothing", () => {
    const series = run(0.12); // ~1%/mo on a six-figure buffer → four-figure annual interest
    // Interest is not SCHEDULED income and never was — no series carries it. It is nonetheless
    // paced, because the year's estimate comes from simulating the year, and a simulated month
    // credits and books interest exactly as a real one does. Every month therefore charges more
    // than the wage twelfth, and all twelve charge the same.
    const yearOne = series.months.slice(0, 12).map((m) => m.flows!.taxCents);
    for (const tax of yearOne) expect(tax).toBeGreaterThan(WAGE_ONLY_MONTHLY_TAX);
    expect(Math.max(...yearOne) - Math.min(...yearOne)).toBeLessThanOrEqual(1);
    // The year that used to leave its whole interest bill for the following April now leaves it
    // small change: the balance is under a tenth of a single month's charge.
    const march = series.months[14].flows!.taxCents;
    const balance = series.months[SETTLEMENT_MONTH].flows!.taxCents - march;
    expect(Math.abs(balance)).toBeLessThan(march / 10);
    // Never drawn, only growing, all year — and taxed as it grows.
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b10 = series.months[10].accountBalancesCents["savings"];
    expect(b10).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(dollarsToCents(119_000));
  });

  it("charges an even wage-only twelfth all year when the buffer earns no interest", () => {
    // Control: at a 0 rate no interest is ever credited, isolating interest as the cause of
    // December's excess tax above — here even December is just another instalment.
    const series = run(0, 12);
    for (const m of series.months) expect(m.flows?.taxCents).toBe(WAGE_ONLY_MONTHLY_TAX);
    expect(series.months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0)).toBe(dollarsToCents(3_600));
  });

  it("taxes EVERY cash account's interest, not only the liquid shortfall sink", () => {
    // Accrual tax is keyed on the account's `returnKind`, not on the single liquid sink.
    // Only the second account varies — brokerage (deferred) vs cash reserve — at equal balance
    // and rate, so the settlement-month tax gap is exactly the reserve's year of interest tax.
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
          horizonMonths: 16,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [savings(120_000, 0.12), second],
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
          expenseSeries: [],
        },
        flatOrdinary10,
      );
    }
    // The year's own twelve instalments, which is where a cash buffer's interest is now collected.
    // Equal figures would mean the non-liquid buffer's interest was dropped from the annual base.
    const yearOne = (accounts: SimAccount): number =>
      runWith(accounts).months.slice(0, 12).reduce((t, m) => t + m.flows!.taxCents, 0);
    const brokerageTax = yearOne(brokerage);
    const reserveTax = yearOne(reserve);
    expect(reserveTax).toBeGreaterThan(brokerageTax);
    // The gap is ~10% of the reserve's ~$13k full year of interest on $120k at ~1%/mo.
    expect(reserveTax - brokerageTax).toBeGreaterThan(dollarsToCents(1_000));
  });

  it("bands each cash account's interest separately, under its own name", () => {
    // Merging the two into one per-owner line made a drained buffer look like it was still
    // earning its neighbour's interest. The app's Simple view re-collapses them. Income-source
    // banding runs every month regardless of when tax is charged, so month 2 (mid-year, no
    // settlement) still exercises it.
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

  it("reports credited interest as a cash inflow bearing its own share of the month's tax", () => {
    // The instalment is apportioned across the sources the year's estimate was priced on, and the
    // interest is now one of them — so it carries a same-month haircut of its own instead of
    // riding free on the wage line until December.
    const series = run(0.12, 4);
    // Identified by explicit `savingsInterest` provenance, never by parsing the id.
    const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest).toBeDefined();
    expect(interest!.label).toBe("Cash savings");
    expect(interest!.sourceId).toBe("interest:savings");
    expect(interest!.cashInflowCents).toBeGreaterThan(0);
    const bySource = series.months[2].flows!.taxBySourceCents;
    expect(Object.keys(bySource).sort()).toEqual(["income:p1", "interest:savings"]);
    expect(bySource["income:p1"]).toBe(WAGE_ONLY_MONTHLY_TAX);
    expect(bySource["interest:savings"]).toBeGreaterThan(0);
    expect(interest!.netCashFlowCents).toBe(
      interest!.cashInflowCents - bySource["interest:savings"]!,
    );
    expect(series.months[2].flows?.totalIncomeCents).toBe(
      dollarsToCents(3_000) + interest!.cashInflowCents,
    );
  });

  it("credits the account exactly once — the interest cash is never re-deposited", () => {
    // No income or expenses, and a horizon short of December: only compounding moves the
    // balance, tax untouched. Re-injecting the booking's cash would jump month 1 by roughly a
    // second interest payment.
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
    // The buffer's own interest is the household's whole income, so it is also the whole of the
    // year's estimate — every month charges an instalment out of the buffer BEFORE that month's
    // compounding, which is the only thing standing between these balances and pure growth.
    const charged = (m: number): number => series.months[m].flows!.taxCents;
    expect(charged(0)).toBeGreaterThan(0);
    expect(b1).toBe(Math.round((opening - charged(0)) * (1 + r)));
    // Month 1 is month 0 charged and compounded once more, not a second credit.
    expect(b2).toBe(Math.round((b1 - charged(1)) * (1 + r)));
    // No double-count: `b2 === round(b1 * (1 + r))` above already pins this exactly — a
    // re-deposit of month 0's reported interest would instead compound `b1 + interest`, a
    // strictly larger (and different) figure. Confirm that reported figure is real and
    // positive without relying on it for the balance check itself.
    const interest = series.months[1].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest?.cashInflowCents).toBeGreaterThan(0);
    expect(b2).not.toBe(Math.round((b1 + interest!.cashInflowCents) * (1 + r)));
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
        horizonMonths: 12,
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
    for (const m of [0, 1, 2, 3, 9, 10]) {
      const sources = series.months[m].flows?.incomeSources ?? [];
      expect(sources.some((s) => s.category === "savingsInterest")).toBe(false);
      expect(series.months[m].flows?.taxCents).toBe(WAGE_ONLY_MONTHLY_TAX);
    }
    // December has nothing to reconcile — the brokerage's 12% growth never entered the taxable
    // accumulator, accrual or otherwise — so the year costs exactly the wage-only figure.
    expect(series.months[11].flows?.taxCents).toBe(WAGE_ONLY_MONTHLY_TAX);
    expect(series.months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0)).toBe(dollarsToCents(3_600));
    expect(series.months[11].accountBalancesCents["brokerage"]).toBeGreaterThan(dollarsToCents(120_000));
  });
});

describe("Already-credited savings interest funds spending without double-counting", () => {
  // Interest that already compounded into the balance can be spent, is reported as real cash,
  // and leaves the account reconciling — WITHOUT any tax deducted, since this 3-month horizon
  // never reaches December (the only month income tax is ever charged):
  //   Beginning savings $10,000 · interest +$500 · other income $0 · spending $400 · tax $0
  //   ⇒ cashInflow $500, net cash flow $500 (no per-source haircut), spending funded, ending
  //   savings $10,100.
  const flat20: Jurisdiction = {
    id: "flat-ordinary-20",
    computeTaxCents: (byCat) => Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.2),
    // Matches `computeTaxCents`'s category set exactly — see `flatOrdinary10` above for why
    // taxing every present key (including a settlement-induced `taxExempt` slice) would break
    // the runtime reconciliation contract.
    computeTaxByCategoryCents: (byCat) => {
      const out: Partial<Record<TaxCategory, number>> = {};
      for (const cat of ["ordinaryIncome", "wages"] as const) {
        const cents = byCat[cat] ?? 0;
        if (cents) out[cat] = Math.round(cents * 0.2);
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

  it("reports the interest as cash in, bearing the whole month's tax, and funds the $400 spend", () => {
    const series = runReconciliation();
    // Month 0 credits 5% of what is left after its own instalment — one credit, no spending yet.
    const tax0 = series.months[0].flows!.taxCents;
    const credited = Math.round((dollarsToCents(10_000) - tax0) * 0.05);
    expect(series.months[0].accountBalancesCents["savings"]).toBe(
      dollarsToCents(10_000) - tax0 + credited,
    );

    const recon = series.months[1]; // the reconciliation month
    const interest = recon.flows!.incomeSources.find((s) => s.category === "savingsInterest")!;
    expect(interest.cashInflowCents).toBe(credited);
    // The interest is the household's only taxable income, so the whole instalment is attributed
    // to it and its net cash flow is the credit less that haircut.
    expect(recon.flows!.taxBySourceCents).toEqual({ "interest:savings": recon.flows!.taxCents });
    expect(interest.netCashFlowCents).toBe(credited - recon.flows!.taxCents);
    // No FALSE insolvency — the gap is genuinely met by the savings the interest is part of.
    expect(recon.flows!.totalObligationsCents).toBe(dollarsToCents(400));
    expect(recon.isInsolvent).toBe(false);
  });

  it("credits the interest exactly once and reconciles fully: beginning − tax + interest − spend", () => {
    const series = runReconciliation();
    const begin = dollarsToCents(10_000);
    const tax = (m: number): number => series.months[m].flows!.taxCents;
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b2 = series.months[1].accountBalancesCents["savings"];
    // The interest hits the balance exactly ONCE: month 0 is what survived its own instalment,
    // grown by 5%, not that plus a re-deposited credit.
    const credited = Math.round((begin - tax(0)) * 0.05);
    expect(b1).toBe(begin - tax(0) + credited);
    // Month 1 earns nothing (the rate drops to 0) and draws the $400 spend and its own instalment.
    expect(b2).toBe(b1 - dollarsToCents(400) - tax(1));
  });
});
