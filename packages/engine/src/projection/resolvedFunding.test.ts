/**
 * Per-line funding attribution on the flow record, end to end. The seam is the simulator's public
 * output: each month's `flows.resolvedFunding` names, per obligation, the sources that paid it in
 * the order the cascade consumed them — income cash, liquid drawdown, decumulation, then credit.
 *
 * The reconciliation these tests pin: every obligation is fully funded until credit is genuinely
 * exhausted, each record's `funded + shortfall` equals what was requested, its sources sum to the
 * funded amount, and they never appear out of cascade order. The scenarios are hand-sized so the
 * expected split follows from the priority rule, not from re-running the engine's own arithmetic.
 */

import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { HouseholdSimInput, SimOwnedSeries, SimPerson } from "./simulate.types";
import type { FundingSourceKind, ResolvedFunding } from "./resolvedFunding";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../simAccount";
import { dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction";
import { RevolvingCard } from "../liability";
import { monthlyIncome, monthlyExpense } from "./simulate.testSupport";

const PERSON: SimPerson = { id: "p1", name: "Alice" };

/** A liquid cash buffer — the shortfall sink and the source of any liquid drawdown. */
function cashAccount(openingCents: number): SimAccount {
  return new SimAccount({
    id: "cash",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** A non-liquid investment the decumulation channel can liquidate; basis == balance ⇒ no gain. */
function investmentAccount(openingCents: number): SimAccount {
  return new SimAccount({
    id: "brokerage",
    ownerId: "p1",
    liquid: false,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** An automatically-funded expense line carrying an explicit priority (lower funded first). */
function expenseLine(id: string, dollars: number, priority: number): SimOwnedSeries {
  return {
    series: monthlyExpense(dollarsToCents(dollars)),
    ownerId: "p1",
    label: id,
    obligationSource: { kind: "budgetLine", id, category: "needs", editable: true, priority },
  };
}

function run(input: Omit<HouseholdSimInput, "horizonMonths" | "annualInflationRate" | "persons">) {
  return simulateHousehold(
    { horizonMonths: 1, annualInflationRate: 0, persons: [PERSON], ...input },
    nullJurisdiction,
  );
}

/** The month-0 attribution list, guaranteed present on a processed month. */
function attributionAt(input: Parameters<typeof run>[0]) {
  const funding = run(input).months[0].flows?.resolvedFunding;
  if (funding === undefined) throw new Error("expected resolvedFunding on the flow record");
  return funding;
}

const byObligation = (funding: readonly ResolvedFunding[], id: string): ResolvedFunding => {
  const record = funding.find((f) => f.obligationId === id);
  if (record === undefined) throw new Error(`no funding record for ${id}`);
  return record;
};

const kinds = (record: ResolvedFunding): FundingSourceKind[] =>
  record.sources.map((s) => s.kind);

describe("resolvedFunding — per-line attribution on the flow record", () => {
  it("a month funded entirely from income attributes every obligation to income", () => {
    const funding = attributionAt({
      accounts: [cashAccount(0)],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(8000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1000, 0), expenseLine("fun", 500, 100)],
    });

    for (const id of ["line:rent", "line:fun"]) {
      const record = byObligation(funding, id);
      expect(record.shortfallCents).toBe(0);
      expect(record.fundedCents).toBe(record.requestedCents);
      expect(record.sources).toEqual([
        { kind: "income", sourceId: "income", amountCents: record.requestedCents },
      ]);
    }
  });

  it("a tight month attributes the lowest-priority obligation to drawdown and then credit", () => {
    // $1000 income, $500 liquid buffer, $2000 of obligations. The $800 need funds from income;
    // the $1200 want takes the remaining $200 income, the $500 buffer, then $500 on credit.
    const funding = attributionAt({
      accounts: [cashAccount(dollarsToCents(500))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("need", 800, 0), expenseLine("want", 1200, 100)],
    });

    expect(byObligation(funding, "line:need").sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(800) },
    ]);
    const want = byObligation(funding, "line:want");
    expect(want.shortfallCents).toBe(0);
    expect(want.sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(200) },
      { kind: "account", sourceId: "cash", amountCents: dollarsToCents(500) },
      { kind: "credit", sourceId: "credit", amountCents: dollarsToCents(500) },
    ]);
  });

  it("decumulation liquidates a named investment account between drawdown and credit", () => {
    // $1000 income, no buffer, $1500 need → $500 gap liquidated from the brokerage (no gain).
    const funding = attributionAt({
      accounts: [cashAccount(0), investmentAccount(dollarsToCents(10000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("need", 1500, 0)],
    });

    expect(byObligation(funding, "line:need").sources).toEqual([
      { kind: "income", sourceId: "income", amountCents: dollarsToCents(1000) },
      { kind: "account", sourceId: "brokerage", amountCents: dollarsToCents(500) },
    ]);
  });

  it("a debt obligation attributes as fully funded from the highest-priority source", () => {
    // The loan payment is mandatory (funded first); ample income covers it and the expense.
    const funding = attributionAt({
      accounts: [cashAccount(0)],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(4000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("rent", 1200, 0)],
      liabilities: [
        new RevolvingCard({
          id: "card",
          ownerId: "p1",
          openingBalanceCents: dollarsToCents(2000),
          apr: 0.2,
          creditLimitCents: dollarsToCents(10000),
          startMonth: -1,
        }),
      ],
    });

    const debt = byObligation(funding, "debt:card");
    expect(debt.shortfallCents).toBe(0);
    expect(debt.fundedCents).toBe(debt.requestedCents);
    expect(kinds(debt)).toEqual(["income"]);
  });

  it("keeps funded+shortfall reconciled and sources in cascade order for every record", () => {
    const funding = attributionAt({
      accounts: [cashAccount(dollarsToCents(500)), investmentAccount(dollarsToCents(3000))],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
      expenseSeries: [expenseLine("a", 900, 0), expenseLine("b", 900, 50), expenseLine("c", 900, 100)],
    });

    const rank: Record<FundingSourceKind, number> = { income: 0, account: 1, credit: 2 };
    for (const record of funding) {
      expect(record.fundedCents + record.shortfallCents).toBe(record.requestedCents);
      const sum = record.sources.reduce((t, s) => t + s.amountCents, 0);
      expect(sum).toBe(record.fundedCents);
      const ranks = record.sources.map((s) => rank[s.kind]);
      expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    }
  });
});
