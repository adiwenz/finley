/**
 * The unified spending read model. Load-bearing invariant: the itemized list IS the month's
 * spending, so its sum must equal the rollups the simulator reports independently
 * (`expensesCents + liabilityPaymentsCents`). Anything that spends money without producing
 * an item — a new expense channel, a liability kind, a later authoring model — breaks that
 * sum here rather than quietly under-reporting in every chart downstream.
 */

import { describe, it, expect } from "vitest";
import { createProjectionBase } from "../projectionBase";
import { interpretLedger } from "../ledger/interpret";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { buildHouseholdSimInput } from "./buildHouseholdInput";
import { simulateHousehold } from "./simulate";
import { sumSpendingItems } from "./spendingItems";
import { dollarsToCents } from "../cashFlowSeries";
import { budgetLineAllocationId } from "../allocations";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { samplePlan, SAMPLE_START_YEAR } from "../testing/samplePlan";
import type { ProjectionContext } from "../projectionBase";
import type { BudgetLine } from "../budgetLine";
import type { Ledger } from "../ledger/ledger";
import type { Plan } from "../plan";
import type { NewLifeEvent } from "../ledger/eventTypes";

const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: SAMPLE_START_YEAR };

const expenseLine = (id: string, label: string, category: "needs" | "wants", dollars: number) =>
  ({
    id,
    label,
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents: dollarsToCents(dollars) },
    category,
  }) as BudgetLine;

/** A plan spending through authored lines, with a health line on top. */
const LINED_PLAN: Plan = {
  ...samplePlan,
  budgetLines: [
    expenseLine("housing", "Housing", "needs", 1_600),
    expenseLine("dining", "Dining & fun", "wants", 400),
  ],
  healthMonthlyCents: dollarsToCents(450),
};

function project(plan: Plan, events: readonly NewLifeEvent[] = []) {
  const base = createProjectionBase(plan, CTX);
  let ledger: Ledger = emptyLedger;
  for (const event of events) {
    const result = addEvent(ledger, base, event);
    if (!result.ok) throw new Error(`fixture event rejected: ${result.conflict}`);
    ledger = result.ledger;
  }
  return simulateHousehold(
    buildHouseholdSimInput(interpretLedger(ledger, base), base),
    CTX.jurisdiction,
  );
}

const LOAN: NewLifeEvent = {
  id: "loan-1",
  type: "LoanEvent",
  month: 0,
  liabilityId: "loan-student",
  ownerId: "p1",
  openingBalanceCents: dollarsToCents(30_000),
  apr: 0.06,
  kind: "studentLoan",
  termMonths: 120,
};

// A child spawns a linked child-cost expense series — the surviving event-authored expense
// on the timeline (recurring rates live in the budget, not on the ledger).
const CHILD_COST: NewLifeEvent = {
  id: "child-1",
  type: "ChildEvent",
  month: 12,
  childId: "kid-1",
  childName: "Robin",
  birthMonth: 12,
  annualCostCents: dollarsToCents(10_800), // $900/mo
};

describe("spendingItems — the invariant", () => {
  it.each([
    ["authored lines + health", LINED_PLAN, []],
    ["with a liability being serviced", LINED_PLAN, [LOAN]],
    ["with an event-created expense", LINED_PLAN, [CHILD_COST]],
    ["everything at once", LINED_PLAN, [LOAN, CHILD_COST]],
    ["the sample plan's single-line budget", samplePlan, [LOAN]],
  ])("%s: the items sum to the month's total spending, every month", (_name, plan, events) => {
    const series = project(plan as Plan, events as NewLifeEvent[]);
    const flowedMonths = series.months.filter((m) => m.flows !== undefined);
    expect(flowedMonths.length).toBeGreaterThan(0);
    for (const month of flowedMonths) {
      const flows = month.flows!;
      const expected = flows.expensesCents + flows.liabilityPaymentsCents;
      // Compared as a labelled pair so a failure names the month it broke in.
      expect({ month: month.month, cents: sumSpendingItems(flows.spendingItems) }).toEqual({
        month: month.month,
        cents: expected,
      });
      expect(flows.totalSpendingCents).toBe(expected);
    }
  });

  it("reports each authoring model as its own item, tagged with where it came from", () => {
    const flows = project(LINED_PLAN, [LOAN, CHILD_COST]).months[13]!.flows!;
    const byKind = (kind: string) => flows.spendingItems.filter((i) => i.sourceKind === kind);

    expect(byKind("budgetLine").map((i) => [i.id, i.label, i.category, i.editable])).toEqual([
      ["line:housing", "Housing", "needs", true],
      ["line:dining", "Dining & fun", "wants", true],
    ]);
    // Health, the loan payment, and the event's expense are all real spending, and none is
    // an editable line — the point of the `editable` flag: a UI offers an edit exactly where
    // an authored line exists.
    expect(byKind("healthcare").map((i) => [i.label, i.category, i.editable])).toEqual([
      ["Healthcare", "healthcare", false],
    ]);
    expect(byKind("liability").map((i) => [i.id, i.label, i.category, i.editable])).toEqual([
      ["debt:loan-student", "Student loan payment", "debtService", false],
    ]);
    expect(byKind("event").map((i) => [i.sourceId, i.category, i.editable])).toEqual([
      ["child-1:childCost", "other", false],
    ]);
    expect(byKind("liability")[0]!.amountCents).toBeGreaterThan(0);
  });

  it("keeps the per-line report as the budget-line slice of the same items", () => {
    // `lineMonthlyCents` is derived from the items rather than computed beside them, so the
    // itemized and per-line views are one computation, two shapes.
    const flows = project(LINED_PLAN, [LOAN]).months[1]!.flows!;
    const fromItems = Object.fromEntries(
      flows.spendingItems
        .filter((i) => i.sourceKind === "budgetLine")
        .map((i) => [i.id, i.amountCents]),
    );
    expect(flows.lineMonthlyCents).toEqual(fromItems);
    expect(flows.lineMonthlyCents[budgetLineAllocationId("housing")]).toBeGreaterThan(0);
    // A debt payment is NOT a budget line: it must never leak into the per-line map.
    expect(Object.keys(flows.lineMonthlyCents)).toHaveLength(2);
  });

  it("drops a debt's item once the loan is paid off, without dropping the total", () => {
    const series = project(LINED_PLAN, [LOAN]);
    const debtAt = (month: number) =>
      series.months[month]?.flows?.spendingItems.filter((i) => i.sourceKind === "liability") ?? [];
    expect(debtAt(60)).toHaveLength(1);
    // The 120-month term is over by month 130; spending goes on without it.
    expect(debtAt(130)).toHaveLength(0);
    expect(series.months[130]!.flows!.totalSpendingCents).toBeGreaterThan(0);
  });
});
