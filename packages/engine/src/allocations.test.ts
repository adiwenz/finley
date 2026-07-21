import { describe, it, expect } from "vitest";
import { dollarsToCents } from "./cashFlowSeries";
import type { Job } from "./job";
import type { BudgetLine } from "./budgetLine";
import type { SimGoal } from "./goal";
import {
  allocations,
  goalToLineItem,
  routeAllocationWrite,
  type Allocation,
} from "./allocations";

const job: Job = {
  id: "job-1",
  ownerId: "p1",
  startYear: 2026,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(120000), realGrowthPct: 0 },
  deferral: { deferralFraction: 0.1, fundAccountId: "401k", employerMatchFraction: 0.5 },
};

const rentLine: BudgetLine = {
  id: "rent",
  label: "Rent",
  target: { kind: "expense" },
  category: "needs",
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(2000) },
};

const brokerageLine: BudgetLine = {
  id: "brokerage",
  label: "Taxable investing",
  target: { kind: "account", accountId: "brokerage", taxTreatment: "postTax" },
  category: "savings",
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
};

const houseGoal: SimGoal = {
  id: "house",
  name: "House down payment",
  targetCents: dollarsToCents(24000),
  targetDate: 24,
  fundAccountId: "house-fund",
  priority: 1500,
  disposition: "convertToEquity",
  scope: "shared",
};

const ids = (a: readonly Allocation[]): string[] => a.map((x) => x.id);

describe("allocations() — unified view (§13/§14, #69 AC1)", () => {
  it("unifies job deferrals, budget lines, and goals into one list", () => {
    const view = allocations({ jobs: [job], budgetLines: [rentLine, brokerageLine], goals: [houseGoal] });
    // One entry per source item — nothing dropped, nothing invented.
    expect(view).toHaveLength(4);
    expect(view.some((a) => a.home.kind === "job")).toBe(true);
    expect(view.some((a) => a.home.kind === "budgetLine")).toBe(true);
    expect(view.some((a) => a.home.kind === "goal")).toBe(true);
  });

  it("gives every allocation a stable, unique id derived from its canonical home", () => {
    const view = allocations({ jobs: [job], budgetLines: [rentLine, brokerageLine], goals: [houseGoal] });
    const uniq = new Set(ids(view));
    expect(uniq.size).toBe(view.length);
    // Re-running the selector produces byte-identical ids (stable).
    const again = allocations({ jobs: [job], budgetLines: [rentLine, brokerageLine], goals: [houseGoal] });
    expect(ids(again)).toEqual(ids(view));
  });

  it("orders pre-tax deferrals first (above the tax line), then post-tax in priority order (§13)", () => {
    const view = allocations({ jobs: [job], budgetLines: [rentLine, brokerageLine], goals: [houseGoal] });
    // The deferral (pre-tax) is first; everything after it is post-tax.
    expect(view[0].home.kind).toBe("job");
    expect(view[0].taxTreatment).toBe("preTax");
    expect(view.slice(1).every((a) => a.taxTreatment === "postTax")).toBe(true);
    // Post-tax band is sorted by effective priority: rent (needs, 0) < brokerage
    // (savings, 2000)… but the house goal (explicit 1500) slots between them.
    const postTaxIds = ids(view).slice(1);
    expect(postTaxIds).toEqual(["line:rent", "goal:house", "line:brokerage"]);
  });

  it("carries each item's tax treatment: deferral pre-tax, expense/goal post-tax", () => {
    const view = allocations({ jobs: [job], budgetLines: [rentLine, brokerageLine], goals: [houseGoal] });
    const byId = new Map(view.map((a) => [a.id, a]));
    expect(byId.get("deferral:job-1")?.taxTreatment).toBe("preTax");
    expect(byId.get("line:rent")?.taxTreatment).toBe("postTax");
    expect(byId.get("goal:house")?.taxTreatment).toBe("postTax");
  });
});

describe("goalToLineItem() — a goal is a computed goal-paced line item (§14)", () => {
  it("compiles a goal into a goal-paced contribution line to its fund account", () => {
    const line = goalToLineItem(houseGoal);
    expect(line.target).toEqual({
      kind: "account",
      accountId: "house-fund",
      taxTreatment: "postTax",
    });
    expect(line.amountSource).toEqual({
      kind: "goalPaced",
      targetCents: dollarsToCents(24000),
      targetMonth: 24,
    });
    expect(line.priority).toBe(1500);
  });

  it("an asap goal has no deadline, so it carries no goal-paced deadline (fills the remainder)", () => {
    const asap: SimGoal = { ...houseGoal, disposition: "retain", targetDate: "asap" };
    const line = goalToLineItem(asap);
    // No dated pace — the sinking-fund source needs a numeric deadline, so an asap
    // goal is not goalPaced (it fills fill-order from the remainder in the waterfall).
    expect(line.amountSource.kind).not.toBe("goalPaced");
  });
});

describe("routeAllocationWrite() — writes go to the canonical home (§13, #69 AC2)", () => {
  const view = allocations({ jobs: [job], budgetLines: [rentLine, brokerageLine], goals: [houseGoal] });
  const byId = new Map(view.map((a) => [a.id, a]));

  it("routes a deferral edit to the job (401k → job)", () => {
    const route = routeAllocationWrite(byId.get("deferral:job-1")!, {
      kind: "deferralFraction",
      value: 0.15,
    });
    expect(route.home).toEqual({ kind: "job", jobId: "job-1" });
  });

  it("routes an expense/contribution edit to the budget line (post-tax → budget)", () => {
    const route = routeAllocationWrite(byId.get("line:rent")!, {
      kind: "monthlyCents",
      value: dollarsToCents(2200),
    });
    expect(route.home).toEqual({ kind: "budgetLine", lineId: "rent" });
  });

  it("routes a goal-field edit to the goal (goal semantics → goal)", () => {
    const route = routeAllocationWrite(byId.get("goal:house")!, {
      kind: "goalTarget",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
    });
    expect(route.home).toEqual({ kind: "goal", goalId: "house" });
  });

  it("rejects an edit whose kind does not belong to the allocation's home", () => {
    // A deferralFraction edit makes no sense on a budget expense line.
    expect(() =>
      routeAllocationWrite(byId.get("line:rent")!, { kind: "deferralFraction", value: 0.1 }),
    ).toThrow();
    // A goal-target edit makes no sense on a job deferral.
    expect(() =>
      routeAllocationWrite(byId.get("deferral:job-1")!, {
        kind: "goalTarget",
        targetCents: dollarsToCents(1),
        targetDate: 12,
      }),
    ).toThrow();
  });
});
