import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, dollarsToCents, nullJurisdiction } from "@finley/engine";
import { createProjectionBase } from "./projectionBase";
import { goalRows, reorderGoal } from "./goalsView";
import type { Plan, GoalPlan } from "@finley/engine";

const baseBudget: Plan = {
  name: "Alex",
  incomeCents: dollarsToCents(5000),
  expenseCents: dollarsToCents(3500),
  expenseOverrides: [],
  openingBalanceCents: 0,
  savingsReturnPct: 0,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  retirementDeferralPct: 0,
  sharedScheme: "proportional",
  surplusSwept: false,
  goals: [],
  // No health line here: these tests pin the $1,500/mo surplus ($5,000 − $3,500)
  // that goal funding draws from, and health is a separate additive expense (§5.4).
  healthMonthlyCents: 0,
  postMedicareHealthMonthlyCents: 0,
  enrollsInMedicare: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: 35,
  retirementAge: 65,
  lifeExpectancy: 90,
  ssClaimingAge: 67,
};

/** Two goals that together outstrip the $1,500/mo surplus, so priority decides. */
const goalA: GoalPlan = {
  id: "a",
  name: "Goal A",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  type: "oneTime",
  annualReturnPct: 0,
};
const goalB: GoalPlan = {
  id: "b",
  name: "Goal B",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  type: "oneTime",
  annualReturnPct: 0,
};

function project(budget: Plan) {
  return replayLedger(emptyLedger, createProjectionBase(budget), nullJurisdiction);
}

describe("goalRows — projection-based on-track % (§5.2)", () => {
  it("scores each goal by projected fund at target ÷ target, not saved-so-far", () => {
    const budget = { ...baseBudget, goals: [goalA, goalB] };
    const rows = goalRows(budget, project(budget));
    // $1,500/mo surplus, all to priority-0 Goal A: $18,000 of $30,000 by month 12.
    expect(rows[0]).toMatchObject({ id: "a", priority: 0, onTrackPct: 60 });
    // Goal B is starved behind A → 0% on track.
    expect(rows[1]).toMatchObject({ id: "b", priority: 1, onTrackPct: 0 });
  });

  it("reprioritizing visibly moves the OTHER goal's number (§5.2 tradeoff)", () => {
    const budget = { ...baseBudget, goals: [goalA, goalB] };
    const reordered = { ...budget, goals: reorderGoal(budget.goals, "b", "up") };
    const rows = goalRows(reordered, project(reordered));
    // Now B is funded first: it takes the 60%, and A drops to 0.
    expect(rows.find((r) => r.id === "b")?.onTrackPct).toBe(60);
    expect(rows.find((r) => r.id === "a")?.onTrackPct).toBe(0);
  });

  it("caps on-track % at 100 once a goal is funded and left to grow", () => {
    // $3,000 target fills in 2 months from the $1,500/mo surplus, then compounds
    // for the rest of the horizon — the raw fraction drifts past 1.0, but the
    // display is capped: a met goal reads 100%, and the surplus flows onward.
    const smallGoal: GoalPlan = {
      id: "s",
      name: "Small goal",
      targetCents: dollarsToCents(3000),
      targetDate: 24,
      type: "horizon",
      annualReturnPct: 10,
    };
    const budget = { ...baseBudget, goals: [smallGoal] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].onTrackPct).toBe(100);
  });

  it("flags a near-term goal accumulating in an equity-like account (§5.2)", () => {
    // A 7% return account + a 12-month horizon is exactly the risk v1 can't model.
    const budget = { ...baseBudget, goals: [{ ...goalA, annualReturnPct: 7 }] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].shortHorizonRiskFlag).toBe(true);
  });

  it("does NOT flag the same goal in a low-return account", () => {
    const budget = { ...baseBudget, goals: [{ ...goalA, annualReturnPct: 1 }] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].shortHorizonRiskFlag).toBe(false);
  });
});

describe("reorderGoal", () => {
  it("moves a goal up and leaves a new array (immutability)", () => {
    const goals = [goalA, goalB];
    const next = reorderGoal(goals, "b", "up");
    expect(next.map((g) => g.id)).toEqual(["b", "a"]);
    expect(goals.map((g) => g.id)).toEqual(["a", "b"]); // original untouched
  });

  it("is a no-op at the ends", () => {
    const goals = [goalA, goalB];
    expect(reorderGoal(goals, "a", "up").map((g) => g.id)).toEqual(["a", "b"]);
    expect(reorderGoal(goals, "b", "down").map((g) => g.id)).toEqual(["a", "b"]);
  });
});
