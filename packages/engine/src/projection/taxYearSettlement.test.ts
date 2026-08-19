/**
 * The two seams the projection-level tests exercise only indirectly: WHICH month closes a tax
 * year and which settles it, and the consume-once discipline that stops a balance being charged
 * twice. Both are one-line rules whose whole value is that they are stated in exactly one place.
 */
import { describe, it, expect } from "vitest";
import { SimAccount, PRE_TAX_TAX_PROFILE } from "../plan/simAccount";
import { dollarsToCents } from "../money/cashFlowSeries";
import { initSimState } from "./runState";
import type { SimState } from "./runState";
import type { HouseholdSimInput } from "./simulate.types";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import {
  dueTaxYearSettlements,
  finalizeTaxYear,
  isTaxSettlementMonth,
  isTaxYearCloseMonth,
} from "./taxYearSettlement";

const flat25: Jurisdiction = {
  id: "flat-25",
  computeTaxCents: (byCat) => Math.round((byCat.ordinaryIncome ?? 0) * 0.25),
  computeTaxByCategoryCents: (byCat) => {
    const cents = Math.round((byCat.ordinaryIncome ?? 0) * 0.25);
    return cents ? { ordinaryIncome: cents } : {};
  },
};

const input: HouseholdSimInput = {
  horizonMonths: 24,
  annualInflationRate: 0,
  startYear: 2026,
  persons: [{ id: "p1", name: "You" }],
  accounts: [
    new SimAccount({
      id: "pretax",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(100_000),
      initialAnnualRate: 0,
    }),
  ],
  incomeSeries: [],
  expenseSeries: [],
};

/** Every balance parked against `taxYear`, summed and signed — positive due, negative refunded. */
function parkedTotalCents(state: SimState, taxYear: number): number {
  let total = 0;
  for (const [key, settlement] of state.pendingTaxSettlementsByPersonYear) {
    if (key.endsWith(`|${taxYear}`)) total += settlement.totalCents;
  }
  return total;
}

/** A state whose 2026 is over: $40k of taxable income and nothing withheld against it. */
function stateWithClosedYear(): SimState {
  const state = initSimState(input);
  state.taxableIncomeByPersonYear.set("p1|2026", { ordinaryIncome: dollarsToCents(40_000) });
  return state;
}

describe("the tax year's close and its settlement month", () => {
  it("closes a year in its twelfth month and settles it in the following year's fourth", () => {
    // The mapping lives in exactly one module, so this is the one place it is asserted: December
    // (index 11 of a January-start year) closes, April (index 3) settles.
    const closes = [...Array(36).keys()].filter(isTaxYearCloseMonth);
    const settles = [...Array(36).keys()].filter(isTaxSettlementMonth);
    expect(closes).toEqual([11, 23, 35]);
    expect(settles).toEqual([3, 15, 27]);
    // Four months apart, every year — a December close is settled by the NEXT April, never its
    // own. The last close in the window has no April inside it, which is exactly the horizon-end
    // case: a final year's balance is parked and the run ends before it can be settled.
    for (const [i, close] of closes.slice(0, -1).entries()) expect(settles[i + 1]! - close).toBe(4);
  });
});

describe("finalizing a tax year", () => {
  it("parks the year's balance without moving a cent", () => {
    const state = stateWithClosedYear();
    const before = new Map(state.assetBalances);
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);

    // Nothing was sold, borrowed or refunded — the year's close is arithmetic only, which is what
    // removed the December cliff and the recursive gross-up that a same-month settlement needed.
    expect([...state.assetBalances]).toEqual([...before]);
    // Nothing was withheld all year, so the whole 25% of $40k is left to settle.
    expect(parkedTotalCents(state, 2026)).toBe(dollarsToCents(10_000));
  });

  it("does nothing in any month but the year's last", () => {
    for (const month of [0, 3, 6, 10, 12]) {
      const state = stateWithClosedYear();
      finalizeTaxYear(state, flat25, { year: 2026 }, month);
      expect(state.pendingTaxSettlementsByPersonYear.size, `month ${month}`).toBe(0);
    }
  });

  it("nets off what the year's withholding already collected, and parks nothing when it landed exactly", () => {
    const state = stateWithClosedYear();
    state.federalTaxPaidByPersonYear.set("p1|2026", {
      totalCents: dollarsToCents(10_000),
      byCategoryCents: { ordinaryIncome: dollarsToCents(10_000) },
      bySourceCents: { pretax: dollarsToCents(10_000) },
    });
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);
    expect(state.pendingTaxSettlementsByPersonYear.size).toBe(0);
  });

  it("parks a NEGATIVE balance when the year over-withheld", () => {
    const state = stateWithClosedYear();
    state.federalTaxPaidByPersonYear.set("p1|2026", {
      totalCents: dollarsToCents(12_000),
      byCategoryCents: { ordinaryIncome: dollarsToCents(12_000) },
      bySourceCents: { pretax: dollarsToCents(12_000) },
    });
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);
    // A refund is the same object with the sign reversed — no separate path, and no clamp at zero.
    expect(parkedTotalCents(state, 2026)).toBe(-dollarsToCents(2_000));
  });
});

describe("finalizing a tax year — the payroll-tax reconciliation rides on the same balance", () => {
  /** A year in which two employers each withheld against their own wages, above one combined cap. */
  function stateWithTwoEmployers(): SimState {
    const state = stateWithClosedYear();
    state.sourceYearToDate.set(
      "p1|2026",
      new Map([
        ["jobA", { earnedByCategory: { wages: dollarsToCents(80_000) }, supplementalWagesCents: 0, wageWithholdingCents: 0, withholdingWagesCents: 0 }],
        ["jobB", { earnedByCategory: { wages: dollarsToCents(80_000) }, supplementalWagesCents: 0, wageWithholdingCents: 0, withholdingWagesCents: 0 }],
      ]),
    );
    return state;
  }

  it("folds a jurisdiction's payroll reconciliation into the balance, signed", () => {
    // A credit of $2,000 for payroll withheld above one combined cap, against $10,000 of income
    // tax still owed — one April movement, not two.
    const withCredit: Jurisdiction = {
      ...flat25,
      reconcilePayrollTaxCents: () => -dollarsToCents(2_000),
    };
    const state = stateWithTwoEmployers();
    finalizeTaxYear(state, withCredit, { year: 2026 }, 11);
    expect(parkedTotalCents(state, 2026)).toBe(dollarsToCents(8_000));
  });

  it("keeps the balance's category and source splits summing to it, reconciliation included", () => {
    // With a breakdown seam, so the correction bands under what actually bore payroll tax rather
    // than under raw earnings — the jurisdiction's call, not the engine's.
    const withCredit: Jurisdiction = {
      ...flat25,
      reconcilePayrollTaxCents: () => -dollarsToCents(2_000),
      computePayrollWithholdingByCategoryCents: (byCat) =>
        byCat.wages ? { wages: Math.round(byCat.wages * 0.05) } : {},
    };
    const state = stateWithTwoEmployers();
    finalizeTaxYear(state, withCredit, { year: 2026 }, 11);
    const settlement = state.pendingTaxSettlementsByPersonYear.get("p1|2026")!;
    const sum = (values: Iterable<number | undefined>) =>
      [...values].reduce((total: number, v) => total + (v ?? 0), 0);
    expect(sum(Object.values(settlement.byCategoryCents))).toBe(settlement.totalCents);
    expect(sum(Object.values(settlement.bySourceCents))).toBe(settlement.totalCents);
    // The credit bands under the jobs that earned the wages it corrects, evenly here because
    // both employers paid the same.
    expect(settlement.bySourceCents.jobA).toBe(-dollarsToCents(1_000));
    expect(settlement.bySourceCents.jobB).toBe(-dollarsToCents(1_000));
  });

  it("leaves a non-wage source out of the correction entirely", () => {
    // An IRA draw is in the same year-to-date map as the two jobs, because which categories a cap
    // binds on is the jurisdiction's decision and the engine cannot filter ahead of it. The
    // jurisdiction's own breakdown is what keeps the draw out of a payroll credit.
    const state = stateWithTwoEmployers();
    state.sourceYearToDate.get("p1|2026")!.set("ira", {
      earnedByCategory: { ordinaryIncome: dollarsToCents(50_000) },
      supplementalWagesCents: 0,
      wageWithholdingCents: 0,
      withholdingWagesCents: 0,
    });
    finalizeTaxYear(
      state,
      {
        ...flat25,
        reconcilePayrollTaxCents: () => -dollarsToCents(2_000),
        computePayrollWithholdingByCategoryCents: (byCat) =>
          byCat.wages ? { wages: Math.round(byCat.wages * 0.05) } : {},
      },
      { year: 2026 },
      11,
    );
    const settlement = state.pendingTaxSettlementsByPersonYear.get("p1|2026")!;
    expect(settlement.bySourceCents.jobA).toBe(-dollarsToCents(1_000));
    expect(settlement.bySourceCents.jobB).toBe(-dollarsToCents(1_000));
    // The draw carries only its own income tax, none of the payroll credit.
    expect(settlement.bySourceCents.ira ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("moves nothing when the jurisdiction has nothing to reconcile", () => {
    const state = stateWithTwoEmployers();
    finalizeTaxYear(state, { ...flat25, reconcilePayrollTaxCents: () => 0 }, { year: 2026 }, 11);
    expect(parkedTotalCents(state, 2026)).toBe(dollarsToCents(10_000));
  });
});

describe("settling a closed year", () => {
  it("hands the balance over in April, once, and never again", () => {
    const state = stateWithClosedYear();
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);

    // Nothing is due before April, and the balance is still pending while it waits.
    for (const month of [12, 13, 14]) {
      expect(dueTaxYearSettlements(state, { year: 2027 }, month).size, `month ${month}`).toBe(0);
    }
    expect(state.pendingTaxSettlementsByPersonYear.size).toBe(1);

    const due = dueTaxYearSettlements(state, { year: 2027 }, 15);
    expect(due.get("p1")?.totalCents).toBe(dollarsToCents(10_000));
    // CONSUMED. A second read of the same April — or of any April after it — finds nothing, which
    // is what makes "charged exactly once" a property of the data rather than of the caller.
    expect(dueTaxYearSettlements(state, { year: 2027 }, 15).size).toBe(0);
    expect(dueTaxYearSettlements(state, { year: 2028 }, 27).size).toBe(0);
    expect(state.pendingTaxSettlementsByPersonYear.size).toBe(0);
  });

  it("settles only the year that just closed, never one two years back", () => {
    const state = stateWithClosedYear();
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);
    // April 2028 asks for 2027's balance; 2026's is not its to take, and stays where it is.
    expect(dueTaxYearSettlements(state, { year: 2028 }, 27).size).toBe(0);
    expect(state.pendingTaxSettlementsByPersonYear.has("p1|2026")).toBe(true);
  });
});
