import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  dollarsToCents,
  nullJurisdiction,
  createProjectionBase,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import {
  goalRows,
  reorderGoal,
  dispositionLabel,
  addGoal,
  updateGoal,
  removeGoal,
  freshGoalId,
  goalDisposal,
} from "./goalsView";
import { goalFundAccountId } from "@finley/engine";
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
  postCoverageHealthMonthlyCents: 0,
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: 35,
  careerStartAge: 18,
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
  disposition: "spend",
  annualReturnPct: 0,
};
const goalB: GoalPlan = {
  id: "b",
  name: "Goal B",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  disposition: "spend",
  annualReturnPct: 0,
};

function project(budget: Plan) {
  return replayLedger(
    emptyLedger,
    createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR }),
    nullJurisdiction,
  );
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
      disposition: "drawDown",
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

describe("goalRows — surfaces each goal's disposition (§5.2)", () => {
  it("carries the disposition and a plain-language label so the fate of the money is visible", () => {
    // Issue #28's whole point: make explicit what BECOMES of a goal's money at target.
    const equityGoal: GoalPlan = { ...goalA, id: "home", disposition: "convertToEquity" };
    const budget = { ...baseBudget, goals: [equityGoal] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].disposition).toBe("convertToEquity");
    expect(rows[0].dispositionLabel).toBe("Becomes home equity");
  });
});

describe("dispositionLabel", () => {
  it("maps each disposition to a plain-language fate (§5.2)", () => {
    expect(dispositionLabel("retain")).toBe("Kept as a reserve");
    expect(dispositionLabel("convertToEquity")).toBe("Becomes home equity");
    expect(dispositionLabel("spend")).toBe("Spent at target");
    expect(dispositionLabel("drawDown")).toBe("Drawn down over time");
  });
});

describe("goalDisposal — legal disposition/date pairing (§5.2)", () => {
  it("keeps a standing disposition's date, including 'asap'", () => {
    expect(goalDisposal("retain", "asap")).toEqual({ disposition: "retain", targetDate: "asap" });
    expect(goalDisposal("drawDown", 24)).toEqual({ disposition: "drawDown", targetDate: 24 });
  });

  it("forces a firing disposition onto a concrete month, never 'asap'", () => {
    // spend/convertToEquity must fire AT a month; a stray 'asap' collapses to 0
    // so an illegal GoalDisposal pair can never be authored.
    expect(goalDisposal("spend", 12)).toEqual({ disposition: "spend", targetDate: 12 });
    expect(goalDisposal("convertToEquity", "asap")).toEqual({
      disposition: "convertToEquity",
      targetDate: 0,
    });
  });
});

describe("freshGoalId", () => {
  it("returns an id not already used by any goal", () => {
    const goals = [goalA, goalB];
    const id = freshGoalId(goals);
    expect(goals.some((g) => g.id === id)).toBe(false);
  });

  it("is deterministic for the same goal list", () => {
    expect(freshGoalId([goalA])).toBe(freshGoalId([goalA]));
  });

  it("avoids colliding with an existing generated id", () => {
    const first = freshGoalId([]);
    const seeded: GoalPlan = { ...goalA, id: first };
    expect(freshGoalId([seeded])).not.toBe(first);
  });
});

describe("addGoal", () => {
  it("appends a new goal at lowest priority with a fresh id, returning a new array", () => {
    const goals = [goalA];
    const next = addGoal(goals, {
      name: "Goal C",
      targetCents: dollarsToCents(1000),
      disposition: "spend",
      targetDate: 12,
      annualReturnPct: 0,
    });
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ name: "Goal C", targetCents: dollarsToCents(1000) });
    expect(goals.some((g) => g.id === next[1].id)).toBe(false); // fresh, unique id
    expect(goals).toEqual([goalA]); // original untouched (immutability)
  });

  it("makes the new goal scorable — its derived fund account is projected (§5.2)", () => {
    const budget = { ...baseBudget, goals: addGoal([goalA], {
      name: "Goal C",
      targetCents: dollarsToCents(6000),
      disposition: "spend",
      targetDate: 12,
      annualReturnPct: 0,
    }) };
    const rows = goalRows(budget, project(budget));
    // Lowest priority: it appears last and, starved behind Goal A, reads 0%.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ name: "Goal C", priority: 1 });
  });
});

describe("updateGoal", () => {
  it("edits an existing goal's fields, keeping its id and list position", () => {
    const goals = [goalA, goalB];
    const next = updateGoal(goals, "a", {
      name: "Renamed",
      targetCents: dollarsToCents(40000),
      disposition: "retain",
      targetDate: "asap",
      annualReturnPct: 3,
    });
    expect(next[0]).toMatchObject({
      id: "a",
      name: "Renamed",
      targetCents: dollarsToCents(40000),
      disposition: "retain",
      targetDate: "asap",
      annualReturnPct: 3,
    });
    expect(next[1]).toBe(goalB); // untouched goal keeps its identity
    expect(goals[0]).toBe(goalA); // original element untouched
  });

  it("re-runs live: editing the target moves the on-track % (§5.2 feedback loop)", () => {
    const before = { ...baseBudget, goals: [goalA] };
    // goalA: $30k by month 12, $1,500/mo surplus → $18k → 60%.
    expect(goalRows(before, project(before))[0].onTrackPct).toBe(60);
    // Halve the target: the same $18k now clears it → capped 100%.
    const after = {
      ...baseBudget,
      goals: updateGoal(before.goals, "a", {
        name: "Goal A",
        targetCents: dollarsToCents(15000),
        disposition: "spend",
        targetDate: 12,
        annualReturnPct: 0,
      }),
    };
    expect(goalRows(after, project(after))[0].onTrackPct).toBe(100);
  });

  it("is a no-op (new array) when the id is not found", () => {
    const goals = [goalA];
    const next = updateGoal(goals, "missing", {
      name: "x",
      targetCents: 0,
      disposition: "spend",
      targetDate: 1,
      annualReturnPct: 0,
    });
    expect(next).toEqual(goals);
    expect(next).not.toBe(goals);
  });
});

describe("removeGoal", () => {
  it("drops the goal and returns a new array", () => {
    const goals = [goalA, goalB];
    const next = removeGoal(goals, "a");
    expect(next.map((g) => g.id)).toEqual(["b"]);
    expect(goals).toHaveLength(2); // original untouched
  });

  it("removes the goal's derived fund account from the projection (§5.2)", () => {
    const before = { ...baseBudget, goals: [goalA, goalB] };
    const beforeSeries = project(before);
    expect(beforeSeries.months[0].accountBalancesCents).toHaveProperty(
      goalFundAccountId(goalA),
    );
    const after = { ...baseBudget, goals: removeGoal(before.goals, "a") };
    const afterSeries = project(after);
    expect(afterSeries.months[0].accountBalancesCents).not.toHaveProperty(
      goalFundAccountId(goalA),
    );
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
