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
  pendingSettlementTotalCents,
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
    expect(pendingSettlementTotalCents(state, { year: 2027 })).toBe(dollarsToCents(10_000));
  });

  it("does nothing in any month but the year's last", () => {
    for (const month of [0, 3, 6, 10, 12]) {
      const state = stateWithClosedYear();
      finalizeTaxYear(state, flat25, { year: 2026 }, month);
      expect(state.pendingTaxSettlementsByPersonYear.size, `month ${month}`).toBe(0);
    }
  });

  it("nets off what the year's instalments already collected, and parks nothing when they landed exactly", () => {
    const state = stateWithClosedYear();
    state.federalTaxPaidByPersonYear.set("p1|2026", {
      totalCents: dollarsToCents(10_000),
      byCategoryCents: { ordinaryIncome: dollarsToCents(10_000) },
      bySourceCents: { pretax: dollarsToCents(10_000) },
    });
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);
    expect(state.pendingTaxSettlementsByPersonYear.size).toBe(0);
  });

  it("parks a NEGATIVE balance when the year over-collected", () => {
    const state = stateWithClosedYear();
    state.federalTaxPaidByPersonYear.set("p1|2026", {
      totalCents: dollarsToCents(12_000),
      byCategoryCents: { ordinaryIncome: dollarsToCents(12_000) },
      bySourceCents: { pretax: dollarsToCents(12_000) },
    });
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);
    // A refund is the same object with the sign reversed — no separate path, and no clamp at zero.
    expect(pendingSettlementTotalCents(state, { year: 2027 })).toBe(-dollarsToCents(2_000));
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

describe("the early-withdrawal penalty settles through the SAME annual true-up as income tax", () => {
  /** No income tax at all — isolates the penalty's own path through the close. */
  const noIncomeTax: Jurisdiction = {
    id: "no-income-tax",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
  };

  it("is added on top of the year's priced income tax, never netted into the withdrawal itself", () => {
    const state = initSimState(input);
    // A $1,000 draw already reached the household in full this year (see `withdrawal.ts` /
    // `fundingDrawStep.ts`, which fold this same accumulator) — the close must still charge its
    // $100 penalty, entirely apart from whether any income tax is owed.
    state.earlyWithdrawalPenaltyByPersonYear.set("p1|2026", dollarsToCents(100));
    finalizeTaxYear(state, noIncomeTax, { year: 2026 }, 11);

    expect(pendingSettlementTotalCents(state, { year: 2027 })).toBe(dollarsToCents(100));
  });

  it("adds the flat penalty on top of a nonzero bracket-priced income tax", () => {
    const state = stateWithClosedYear(); // $40k ordinaryIncome under flat25 → $10,000 income tax
    state.earlyWithdrawalPenaltyByPersonYear.set("p1|2026", dollarsToCents(100));
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);

    expect(pendingSettlementTotalCents(state, { year: 2027 })).toBe(dollarsToCents(10_100));
  });

  it("charges nothing extra when no penalty was accumulated", () => {
    const state = stateWithClosedYear();
    finalizeTaxYear(state, flat25, { year: 2026 }, 11);
    expect(pendingSettlementTotalCents(state, { year: 2027 })).toBe(dollarsToCents(10_000));
  });
});
