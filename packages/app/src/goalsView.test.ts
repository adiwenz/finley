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
import { monthLabel } from "./format";
import {
  goalRows,
  reorderGoal,
  dispositionLabel,
  addGoal,
  updateGoal,
  removeGoal,
  freshGoalId,
  goalDisposal,
  goalFundingBlocks,
  fundingBlockMessage,
} from "./goalsView";
import { goalFundAccountId } from "@finley/engine";
import type { Plan, GoalPlan, Ledger, LifeEvent } from "@finley/engine";

const baseBudget: Plan = {
  name: "Alex",
  // Income is a single real-flat job — $5,000/mo, the surplus source below.
  jobs: [
    {
      id: "job-1",
      ownerId: "p1",
      startYear: START_YEAR - 35 + 18,
      endYear: null,
      salary: { startingSalaryCents: dollarsToCents(5000) * 12, realGrowthPct: 0 },
    },
  ],
  expenseCents: dollarsToCents(3500),
  expenseOverrides: [],
  openingBalanceCents: 0,
  savingsReturnPct: 0,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  sharedScheme: "proportional",
  goals: [],
  // No health line: these tests pin the $1,500/mo surplus ($5,000 − $3,500) goal funding
  // draws from, and health is a separate additive expense.
  healthMonthlyCents: 0,
  postCoverageHealthMonthlyCents: 0,
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: 35,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

/** Two goals that together outstrip the $1,500/mo surplus, so priority decides. */
const goalA: GoalPlan = {
  id: "a",
  name: "Goal A",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  disposition: "retain",
  annualReturnPct: 0,
};
const goalB: GoalPlan = {
  id: "b",
  name: "Goal B",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  disposition: "retain",
  annualReturnPct: 0,
};

function project(budget: Plan) {
  return replayLedger(
    emptyLedger,
    createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR }),
    nullJurisdiction,
  );
}

describe("goalRows — projection-based on-track %", () => {
  it("scores each goal by projected fund at target ÷ target, not saved-so-far", () => {
    const budget = { ...baseBudget, goals: [goalA, goalB] };
    const rows = goalRows(budget, project(budget));
    // $1,500/mo surplus, all to priority-0 Goal A. months[12] is the end of month 12, so 13
    // processed months (0–12) have funded it — now that month 0 saves — → $19,500 of $30,000.
    expect(rows[0]).toMatchObject({ id: "a", priority: 0, onTrackPct: 65 });
    // Goal B is starved behind A → 0% on track.
    expect(rows[1]).toMatchObject({ id: "b", priority: 1, onTrackPct: 0 });
  });

  it("reprioritizing visibly moves the OTHER goal's number (tradeoff)", () => {
    const budget = { ...baseBudget, goals: [goalA, goalB] };
    const reordered = { ...budget, goals: reorderGoal(budget.goals, "b", "up") };
    const rows = goalRows(reordered, project(reordered));
    // Now B is funded first: it takes the 65%, and A drops to 0.
    expect(rows.find((r) => r.id === "b")?.onTrackPct).toBe(65);
    expect(rows.find((r) => r.id === "a")?.onTrackPct).toBe(0);
  });

  it("caps on-track % at 100 once a goal is funded and left to grow", () => {
    // A $3,000 target fills in 2 months from the $1,500/mo surplus, then compounds for
    // the rest of the horizon — the raw fraction drifts past 1.0, but display is capped:
    // a met goal reads 100% and the surplus flows onward.
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

  it("flags a near-term goal accumulating in an equity-like account", () => {
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

describe("goalRows — surfaces derived completion (In Progress → Funded) and behind-pace", () => {
  it("marks a goal Funded once its projected balance reaches target on/before the date", () => {
    // $1,500/mo surplus fills a $3,000 target by ~month 2, well before month 24.
    const funded: GoalPlan = {
      id: "f",
      name: "Funded goal",
      targetCents: dollarsToCents(3000),
      targetDate: 24,
      disposition: "retain",
      annualReturnPct: 0,
    };
    const budget = { ...baseBudget, goals: [funded] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].completion).toBe("funded");
    // A funded goal is by definition not behind pace.
    expect(rows[0].behindPace).toBe(false);
  });

  it("marks an underfunded goal In Progress and behind pace (onTrackFraction < 1)", () => {
    // $30,000 by month 12 off a $1,500/mo surplus → only 60% funded in time.
    const budget = { ...baseBudget, goals: [goalA] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].completion).toBe("inProgress");
    expect(rows[0].behindPace).toBe(true);
  });
});

describe("goalRows — surfaces each goal's disposition", () => {
  it("carries the disposition and a plain-language label so the fate of the money is visible", () => {
    // What BECOMES of a goal's money at target must be explicit.
    const nestEggGoal: GoalPlan = { ...goalA, id: "nest", disposition: "drawDown" };
    const budget = { ...baseBudget, goals: [nestEggGoal] };
    const rows = goalRows(budget, project(budget));
    expect(rows[0].disposition).toBe("drawDown");
    expect(rows[0].dispositionLabel).toBe("Drawn down over time");
  });
});

describe("dispositionLabel", () => {
  it("maps each disposition to a plain-language fate", () => {
    expect(dispositionLabel("retain")).toBe("Kept as a reserve");
    expect(dispositionLabel("drawDown")).toBe("Drawn down over time");
  });
});

describe("goalDisposal — disposition/date pairing", () => {
  it("assembles the disposition and date verbatim, including 'asap'", () => {
    // Both dispositions are purely descriptive, so either date is kept as-is.
    expect(goalDisposal("retain", "asap")).toEqual({ disposition: "retain", targetDate: "asap" });
    expect(goalDisposal("drawDown", 24)).toEqual({ disposition: "drawDown", targetDate: 24 });
    expect(goalDisposal("retain", 12)).toEqual({ disposition: "retain", targetDate: 12 });
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
      disposition: "retain",
      targetDate: 12,
      annualReturnPct: 0,
    });
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ name: "Goal C", targetCents: dollarsToCents(1000) });
    expect(goals.some((g) => g.id === next[1].id)).toBe(false); // fresh, unique id
    expect(goals).toEqual([goalA]); // original untouched (immutability)
  });

  it("makes the new goal scorable — its derived fund account is projected", () => {
    const budget = { ...baseBudget, goals: addGoal([goalA], {
      name: "Goal C",
      targetCents: dollarsToCents(6000),
      disposition: "retain",
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

  it("re-runs live: editing the target moves the on-track % (feedback loop)", () => {
    const before = { ...baseBudget, goals: [goalA] };
    // goalA: $30k by month 12, $1,500/mo surplus over 13 processed months (0–12) → $19.5k → 65%.
    expect(goalRows(before, project(before))[0].onTrackPct).toBe(65);
    // Halve the target: the same $19.5k now clears it → capped 100%.
    const after = {
      ...baseBudget,
      goals: updateGoal(before.goals, "a", {
        name: "Goal A",
        targetCents: dollarsToCents(15000),
        disposition: "retain",
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
      disposition: "retain",
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

  it("removes the goal's derived fund account from the projection", () => {
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

/**
 * A home purchase drawing its down payment from `sourceIds`, in drain order. Today's only
 * event type that names a fund account as a funding source — the single real path to a
 * dangling reference a deleted goal would leave.
 */
function homePurchase(
  id: string,
  month: number,
  sequenceNumber: number,
  sourceIds: readonly string[],
): LifeEvent {
  return {
    type: "HomePurchaseEvent",
    id,
    sequenceNumber,
    month,
    propertyId: `${id}-house`,
    ownerId: "p1",
    purchasePriceCents: dollarsToCents(500000),
    downPaymentCents: dollarsToCents(100000),
    downPaymentSourceIds: sourceIds,
    mortgageLiabilityId: `${id}-mtg`,
    mortgageApr: 0,
    mortgageTermMonths: 360,
  };
}

function ledgerOf(...events: LifeEvent[]): Ledger {
  return { events, nextSequenceNumber: events.length };
}

describe("goalFundingBlocks — events naming a goal's fund account as a funding source", () => {
  it("names the event blocking a goal whose fund account it draws from", () => {
    // The home purchase at month 72 funds its down payment from Goal A's derived account.
    const buy = homePurchase("buy1", 72, 0, ["savings", goalFundAccountId(goalA)]);
    const blocks = goalFundingBlocks([goalA, goalB], "a", ledgerOf(buy));
    expect(blocks).toEqual([{ eventId: "buy1", label: "Bought a home", month: 72 }]);
  });

  it("returns nothing when no event references the goal's fund account", () => {
    const buy = homePurchase("buy1", 72, 0, ["savings"]);
    expect(goalFundingBlocks([goalA, goalB], "a", ledgerOf(buy))).toEqual([]);
  });

  it("unblocks once the referencing event is removed from the ledger", () => {
    const referenced = goalFundingBlocks([goalA], "a", ledgerOf(homePurchase("buy1", 72, 0, [goalFundAccountId(goalA)])));
    expect(referenced).toHaveLength(1);
    // The event gone from the log, nothing points at the fund account any more.
    expect(goalFundingBlocks([goalA], "a", emptyLedger)).toEqual([]);
  });

  it("lists every blocking event, sorted by (month, sequence)", () => {
    const later = homePurchase("buy2", 90, 1, [goalFundAccountId(goalA)]);
    const earlier = homePurchase("buy1", 72, 0, ["savings", goalFundAccountId(goalA)]);
    const blocks = goalFundingBlocks([goalA], "a", ledgerOf(later, earlier));
    expect(blocks).toEqual([
      { eventId: "buy1", label: "Bought a home", month: 72 },
      { eventId: "buy2", label: "Bought a home", month: 90 },
    ]);
  });
});

describe("fundingBlockMessage — the refuse-to-delete text", () => {
  const blocksFor = (goals: readonly GoalPlan[], id: string, ledger: Ledger) =>
    fundingBlockMessage(goalFundingBlocks(goals, id, ledger));

  it("is null when the goal's fund account is unreferenced (deletion may proceed)", () => {
    const buy = homePurchase("buy1", 72, 0, ["savings"]);
    expect(blocksFor([goalA], "a", ledgerOf(buy))).toBeNull();
  });

  it("names each blocking event by label and month", () => {
    const buy = homePurchase("buy1", 72, 0, [goalFundAccountId(goalA)]);
    expect(blocksFor([goalA], "a", ledgerOf(buy))).toBe(
      `This account cannot be deleted because it funds:\n- Bought a home in ${monthLabel(72)}`,
    );
  });

  it("names a narrowed set of blockers — the panel formats one refusal's own", () => {
    const early = homePurchase("buy1", 72, 0, [goalFundAccountId(goalA)]);
    const late = homePurchase("buy2", 90, 1, [goalFundAccountId(goalA)]);
    const blocks = goalFundingBlocks([goalA], "a", ledgerOf(early, late));
    expect(fundingBlockMessage(blocks.filter((b) => b.eventId === "buy2"))).toBe(
      `This account cannot be deleted because it funds:\n- Bought a home in ${monthLabel(90)}`,
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
