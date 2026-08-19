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
  // liability is charged in full — nothing is withheld or estimated for it during the year (see
  // `federalIncomeTax.ts`'s module doc).
  const WAGE_ANNUAL_TAX = dollarsToCents(3_600); // 10% of $3,000/mo × 12
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

  it("charges nothing during the year the interest is credited in, settling it whole the following April", () => {
    const series = run(0.12); // ~1%/mo on a six-figure buffer → four-figure annual interest
    // Interest is real taxable income the moment it is credited, but — like wages — nothing is
    // withheld or estimated against it during the year: every month of year 0 charges $0.
    for (const month of series.months.slice(0, 12)) expect(month.flows!.taxCents).toBe(0);
    // April 2027 charges the year's WHOLE liability at once: wages plus every month's interest.
    const settled = series.months[SETTLEMENT_MONTH].flows!.taxCents;
    expect(settled).toBeGreaterThan(WAGE_ANNUAL_TAX);
    // Never drawn, only growing, all year — and untaxed in-year while it grows.
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b10 = series.months[10].accountBalancesCents["savings"];
    expect(b10).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(dollarsToCents(120_000));
  });

  it("charges nothing all year, and exactly the wage liability the following April, when the buffer earns no interest", () => {
    // Control: at a 0 rate no interest is ever credited, isolating interest as the cause of
    // the settlement's excess above.
    const series = run(0, 16);
    for (const m of series.months.slice(0, 12)) expect(m.flows?.taxCents).toBe(0);
    expect(series.months[SETTLEMENT_MONTH].flows!.taxCents).toBe(WAGE_ANNUAL_TAX);
    expect(series.months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0)).toBe(WAGE_ANNUAL_TAX);
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
    // The year's WHOLE liability, settled the following April — which is where a cash buffer's
    // interest shows up. Equal figures would mean the non-liquid buffer's interest was dropped
    // from the annual base.
    const settled = (accounts: SimAccount): number =>
      runWith(accounts).months[SETTLEMENT_MONTH].flows!.taxCents;
    const brokerageTax = settled(brokerage);
    const reserveTax = settled(reserve);
    expect(reserveTax).toBeGreaterThan(brokerageTax);
    // The gap is ~10% of the reserve's ~$13k full year of interest on $120k at ~1%/mo.
    expect(reserveTax - brokerageTax).toBeGreaterThan(dollarsToCents(1_000));
  });

  it("bands each cash account's interest separately, under its own name", () => {
    // Merging the two into one per-owner line made a drained buffer look like it was still
    // earning its neighbour's interest. The app's Simple view re-collapses them. Income-source
    // banding runs every month regardless of when tax is charged.
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

  it("reports credited interest as a cash inflow bearing no same-month tax haircut", () => {
    // Nothing is charged during the year, so the interest's cash inflow this month is untouched —
    // its share of the year's liability is only attributed once the year settles, the following
    // April.
    const series = run(0.12, 4);
    // Identified by explicit `savingsInterest` provenance, never by parsing the id.
    const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest).toBeDefined();
    expect(interest!.label).toBe("Cash savings");
    expect(interest!.sourceId).toBe("interest:savings");
    expect(interest!.cashInflowCents).toBeGreaterThan(0);
    expect(series.months[2].flows!.taxCents).toBe(0);
    expect(series.months[2].flows!.taxBySourceCents).toEqual({});
    expect(interest!.netCashFlowCents).toBe(interest!.cashInflowCents);
    expect(series.months[2].flows?.totalIncomeCents).toBe(
      dollarsToCents(3_000) + interest!.cashInflowCents,
    );
  });

  it("credits the account exactly once — the interest cash is never re-deposited", () => {
    // No income or expenses, and a horizon short of December: only compounding moves the
    // balance, tax untouched (nothing is charged before the following April). Re-injecting the
    // booking's cash would jump month 1 by roughly a second interest payment.
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
    // Nothing is charged this early in the year, so the balance simply compounds.
    expect(series.months[0].flows!.taxCents).toBe(0);
    expect(b1).toBe(Math.round(opening * (1 + r)));
    // Month 1 is month 0 compounded once more, not a second credit.
    expect(b2).toBe(Math.round(b1 * (1 + r)));
    const interest = series.months[1].flows?.incomeSources.find((s) => s.category === "savingsInterest");
    expect(interest?.cashInflowCents).toBeGreaterThan(0);
    // No double-count: a re-deposit of month 0's reported interest would instead compound
    // `b1 + interest`, a strictly larger (and different) figure.
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
        horizonMonths: 16,
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
    for (const m of [0, 1, 2, 3, 9, 10, 11]) {
      const sources = series.months[m].flows?.incomeSources ?? [];
      expect(sources.some((s) => s.category === "savingsInterest")).toBe(false);
      expect(series.months[m].flows?.taxCents).toBe(0);
    }
    // The brokerage's 12% growth never entered the taxable accumulator, accrual or otherwise —
    // so the year settles at exactly the wage-only figure, in April.
    expect(series.months[SETTLEMENT_MONTH].flows?.taxCents).toBe(WAGE_ANNUAL_TAX);
    expect(series.months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0)).toBe(WAGE_ANNUAL_TAX);
    expect(series.months[11].accountBalancesCents["brokerage"]).toBeGreaterThan(dollarsToCents(120_000));
  });
});

describe("Already-credited savings interest funds spending without double-counting", () => {
  // Interest that already compounded into the balance can be spent, is reported as real cash,
  // and leaves the account reconciling — WITHOUT any tax deducted, since this 3-month horizon
  // never reaches the following April (the only month income tax is ever charged):
  //   Beginning savings $10,000 · interest +$500 · other income $0 · spending $400 · tax $0
  //   ⇒ cashInflow $500, net cash flow $500 (no per-source haircut), spending funded, ending
  //   savings $10,100.
  const flat20: Jurisdiction = {
    id: "flat-ordinary-20",
    computeTaxCents: (byCat) => Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.2),
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
   * month 1 — the reconciliation month: already-credited interest, real spending, no tax
   * (the 3-month horizon never reaches the settling April), nothing else moving.
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

  it("reports the interest as cash in, untaxed this month, and funds the $400 spend", () => {
    const series = runReconciliation();
    // Month 0 credits 5% of the opening balance — nothing is charged this early in the year.
    expect(series.months[0].flows!.taxCents).toBe(0);
    const credited = Math.round(dollarsToCents(10_000) * 0.05);
    expect(series.months[0].accountBalancesCents["savings"]).toBe(dollarsToCents(10_000) + credited);

    const recon = series.months[1]; // the reconciliation month
    const interest = recon.flows!.incomeSources.find((s) => s.category === "savingsInterest")!;
    expect(interest.cashInflowCents).toBe(credited);
    expect(recon.flows!.taxCents).toBe(0);
    expect(recon.flows!.taxBySourceCents).toEqual({});
    expect(interest.netCashFlowCents).toBe(credited);
    // No FALSE insolvency — the gap is genuinely met by the savings the interest is part of.
    expect(recon.flows!.totalObligationsCents).toBe(dollarsToCents(400));
    expect(recon.isInsolvent).toBe(false);
  });

  it("credits the interest exactly once and reconciles fully: beginning + interest − spend", () => {
    const series = runReconciliation();
    const begin = dollarsToCents(10_000);
    const b1 = series.months[0].accountBalancesCents["savings"];
    const b2 = series.months[1].accountBalancesCents["savings"];
    // The interest hits the balance exactly ONCE: month 0 grown by 5%, not that plus a
    // re-deposited credit. Nothing is charged this early in the year.
    const credited = Math.round(begin * 0.05);
    expect(b1).toBe(begin + credited);
    // Month 1 earns nothing (the rate drops to 0) and draws only the $400 spend.
    expect(b2).toBe(b1 - dollarsToCents(400));
  });
});
