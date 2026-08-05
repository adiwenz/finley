/**
 * The `Projection` root over goals and budget lines: goal edit/reorder and the fund-account guard
 * that removal enforces, budget-line edit/remove, and patching the plan's standing scalars.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { samplePlan, stateOf } from "../testing/samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { goalFundAccountId } from "../compile/projectionBase";
import { withLedger } from "../plan/scenario";
import { emptyLedger } from "../ledger/ledger";
import { type LifeEvent } from "../ledger/eventTypes";
import { P1, freshProjection, plainJob, expenseLine } from "../testing/projectionFacadeFixtures";

describe("Projection root — removing a goal guards its fund account", () => {
  const carGoal = {
    name: "Car",
    targetCents: dollarsToCents(30000),
    targetDate: 36,
    disposition: "retain",
    annualReturnPct: 3,
  } as const;

  /**
   * A ledger whose home purchase spends from the goal's fund account. Written straight into
   * the state rather than through `buyHome`, so the removal guard is tested on its own and
   * not through the down-payment affordability gate.
   */
  function withPurchaseFundedBy(p: Projection, goalId: string): Projection {
    const s = p.state;
    const goal = s.scenario.plan.goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`test setup: no goal "${goalId}"`);
    // A cash purchase (no securing liability): only the down-payment source matters to the guard.
    const purchase: LifeEvent = {
      id: "e1",
      type: "HomePurchaseEvent",
      month: 24,
      sequenceNumber: 1,
      propertyId: "home-1",
      ownerId: P1,
      purchasePriceCents: dollarsToCents(300000),
      downPaymentCents: dollarsToCents(60000),
      downPaymentSourceIds: [goalFundAccountId(goal)],
    };
    return Projection.fromState(
      {
        ...s,
        scenario: withLedger(s.scenario, { events: [purchase], nextSequenceNumber: 2 }),
      },
      nullJurisdiction,
    );
  }

  it("removes a goal no event funds", () => {
    const p = freshProjection();
    const goalId = p.addGoal(carGoal);
    p.removeGoal(goalId);
    expect(p.plan.goals.map((g) => g.id)).not.toContain(goalId);
  });

  it("leaves the other goals alone", () => {
    const p = freshProjection();
    const keep = p.addGoal(carGoal);
    p.removeGoal(p.addGoal(carGoal));
    expect(p.plan.goals.map((g) => g.id)).toEqual([...samplePlan.goals.map((g) => g.id), keep]);
  });

  it("refuses while an event spends from the goal's fund account", () => {
    const p0 = freshProjection();
    const goalId = p0.addGoal(carGoal);
    const p = withPurchaseFundedBy(p0, goalId);
    const before = p.state;

    // The message names the goal, its derived fund account and the event holding it — all by
    // the ids the engine minted, so the assertion builds them from the handle it was given.
    expect(() => p.removeGoal(goalId)).toThrow(
      new RegExp(
        `cannot remove goal — Cannot remove goal "${goalId}": its fund account ` +
          `"fund-${goalId}" funds "e1" \\(HomePurchaseEvent, month 24\\)`,
      ),
    );
    // Refused means untouched, not partially applied.
    expect(p.state).toBe(before);
    expect(p.plan.goals.map((g) => g.id)).toContain(goalId);
  });

  it("allows the removal once the referencing event leaves the ledger", () => {
    const p0 = freshProjection();
    const goalId = p0.addGoal(carGoal);
    const blocked = withPurchaseFundedBy(p0, goalId);
    expect(() => blocked.removeGoal(goalId)).toThrow();

    const s = blocked.state;
    const unblocked = Projection.fromState(
      {
        ...s,
        scenario: withLedger(s.scenario, emptyLedger),
      },
      nullJurisdiction,
    );
    unblocked.removeGoal(goalId);
    expect(unblocked.plan.goals.map((g) => g.id)).not.toContain(goalId);
  });

  it("refuses an id the plan does not hold, distinctly from refusing a funded one", () => {
    const p = freshProjection();
    // A different refusal from the funding guard above: nothing is being protected, the goal
    // simply is not there, and the caller's next line assumes a removal that never happened.
    expect(() => p.removeGoal("no-such-goal")).toThrow(/no goal "no-such-goal"/);
    expect(p.plan.goals).toEqual(samplePlan.goals);
  });
});

describe("Projection root — editing a goal keeps its id and priority", () => {
  const carGoal = {
    name: "Car",
    targetCents: dollarsToCents(30000),
    targetDate: 36,
    disposition: "retain",
    annualReturnPct: 3,
  } as const;

  it("patches only the named fields, leaving the rest of the goal intact", () => {
    const p = freshProjection();
    const goalId = p.addGoal(carGoal);
    p.updateGoal(goalId, { name: "New car", annualReturnPct: 5 });
    const goal = p.plan.goals.find((g) => g.id === goalId);
    expect(goal).toMatchObject({
      id: goalId,
      name: "New car",
      annualReturnPct: 5,
      // Untouched fields survive the patch.
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
    });
  });

  it("holds the goal's list position, so its funding priority is unchanged", () => {
    const p = freshProjection();
    const first = p.addGoal(carGoal);
    const second = p.addGoal(carGoal);
    const before = p.plan.goals.map((g) => g.id);
    p.updateGoal(first, { name: "Renamed" });
    expect(p.plan.goals.map((g) => g.id)).toEqual(before);
    expect(p.plan.goals.map((g) => g.id)).toEqual([
      ...samplePlan.goals.map((g) => g.id),
      first,
      second,
    ]);
  });

  it("refuses an id the plan does not hold", () => {
    const p = freshProjection();
    const before = p.state;
    expect(() => p.updateGoal("no-such-goal", { name: "x" })).toThrow(/no goal "no-such-goal"/);
    expect(p.state).toBe(before);
  });
});

describe("Projection root — reordering a goal changes its funding priority", () => {
  const goal = {
    name: "Goal",
    targetCents: dollarsToCents(10000),
    targetDate: 24,
    disposition: "retain",
    annualReturnPct: 3,
  } as const;

  function seededProjection(): { p: Projection; a: string; b: string; c: string } {
    // Start from an empty goal list so priority (array index) reflects only what we add.
    const p = Projection.fromState(stateOf({ ...samplePlan, jobs: [], budgetLines: [], goals: [] }), nullJurisdiction);
    return { p, a: p.addGoal(goal), b: p.addGoal(goal), c: p.addGoal(goal) };
  }

  it("moves a goal one slot earlier when funded sooner", () => {
    const { p, a, b, c } = seededProjection();
    p.reorderGoal(b, "up");
    expect(p.plan.goals.map((g) => g.id)).toEqual([b, a, c]);
  });

  it("moves a goal one slot later when funded later", () => {
    const { p, a, b, c } = seededProjection();
    p.reorderGoal(b, "down");
    expect(p.plan.goals.map((g) => g.id)).toEqual([a, c, b]);
  });

  it("refuses a move that cannot happen — at either end, or for an id that is not there", () => {
    const { p, a, b, c } = seededProjection();
    const before = p.state;

    expect(() => p.reorderGoal(a, "up")).toThrow(/already first/);
    expect(() => p.reorderGoal(c, "down")).toThrow(/already last/);
    expect(() => p.reorderGoal("no-such-goal", "up")).toThrow(/no goal "no-such-goal"/);

    expect(p.state).toBe(before);
    expect(p.plan.goals.map((g) => g.id)).toEqual([a, b, c]);
  });
});

describe("Projection root — editing and removing a budget line", () => {
  it("patches the named fields and carries span, overrides and priority through", () => {
    const p = freshProjection();
    const lineId = p.addBudgetLine({
      ...expenseLine,
      priority: 2,
      span: { startMonth: 6 },
      overrides: [{ month: 12, monthlyCents: dollarsToCents(2500), scope: "thisMonthOnly" }],
    });

    p.updateBudgetLine(lineId, {
      label: "Rent (new place)",
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2400) },
    });

    expect(p.plan.budgetLines[0]).toEqual({
      id: lineId,
      label: "Rent (new place)",
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(2400) },
      target: { kind: "expense" },
      category: "needs",
      // Timeline facts about the line, not part of what an edit names.
      priority: 2,
      span: { startMonth: 6 },
      overrides: [{ month: 12, monthlyCents: dollarsToCents(2500), scope: "thisMonthOnly" }],
    });
  });

  it("switches an expense line to a contribution by replacing the whole target", () => {
    const p = freshProjection();
    const lineId = p.addBudgetLine(expenseLine);
    p.updateBudgetLine(lineId, {
      category: "savings",
      target: { kind: "account", accountId: "brokerage", taxTreatment: "postTax" },
    });
    expect(p.plan.budgetLines[0]?.target).toEqual({
      kind: "account",
      accountId: "brokerage",
      taxTreatment: "postTax",
    });
  });

  it("removes a line, leaving the others alone", () => {
    const p = freshProjection();
    const keep = p.addBudgetLine(expenseLine);
    p.removeBudgetLine(p.addBudgetLine(expenseLine));
    expect(p.plan.budgetLines.map((l) => l.id)).toEqual([keep]);
  });

  it("refuses an id the plan does not hold", () => {
    const p = freshProjection();
    p.addBudgetLine(expenseLine);
    const before = p.state;

    const missing = /no budget line "no-such-line"/;
    expect(() => p.updateBudgetLine("no-such-line", { label: "x" })).toThrow(missing);
    expect(() => p.removeBudgetLine("no-such-line")).toThrow(missing);
    expect(() =>
      p.addBudgetLineOverride("no-such-line", {
        month: 3,
        monthlyCents: dollarsToCents(100),
        scope: "thisMonthOnly",
      }),
    ).toThrow(missing);

    expect(p.state).toBe(before);
  });

  it("accumulates dated overrides, one per (scope, month), without a read-modify-write", () => {
    const p = freshProjection();
    const lineId = p.addBudgetLine(expenseLine);

    p.addBudgetLineOverride(lineId, {
      month: 6,
      monthlyCents: dollarsToCents(2500),
      scope: "thisMonthOnly",
    });
    // A different month, and the same month at the other scope: both stand beside the first.
    p.addBudgetLineOverride(lineId, {
      month: 12,
      monthlyCents: dollarsToCents(2600),
      scope: "thisMonthOnly",
    });
    p.addBudgetLineOverride(lineId, {
      month: 6,
      monthlyCents: dollarsToCents(2700),
      scope: "fromHereForward",
    });
    // Re-authoring one replaces it rather than stacking a second answer for that month.
    p.addBudgetLineOverride(lineId, {
      month: 6,
      monthlyCents: dollarsToCents(2550),
      scope: "thisMonthOnly",
    });

    expect(p.plan.budgetLines[0]?.overrides).toEqual([
      { month: 12, monthlyCents: dollarsToCents(2600), scope: "thisMonthOnly" },
      { month: 6, monthlyCents: dollarsToCents(2700), scope: "fromHereForward" },
      { month: 6, monthlyCents: dollarsToCents(2550), scope: "thisMonthOnly" },
    ]);
  });
});

describe("Projection root — patching the plan's standing scalars", () => {
  it("writes any scalar the budget editor writes, in one call", () => {
    const p = freshProjection();
    p.updatePlan({
      name: "Renamed",
      openingBalanceCents: dollarsToCents(50000),
      savingsReturnPct: 2,
      inflationPct: 4,
      currentAge: 41,
      lifeExpectancy: 90,
      benefitClaimingAge: 70,
      surplusCashTo: "brokerage",
      sharedScheme: "even",
    });

    expect(p.plan).toMatchObject({
      name: "Renamed",
      openingBalanceCents: dollarsToCents(50000),
      savingsReturnPct: 2,
      inflationPct: 4,
      currentAge: 41,
      lifeExpectancy: 90,
      benefitClaimingAge: 70,
      surplusCashTo: "brokerage",
      sharedScheme: "even",
      // Unnamed scalars keep their authored values.
      brokerageReturnPct: samplePlan.brokerageReturnPct,
    });
  });

  it("cannot reach the collections, so no edit bypasses their guards", () => {
    const p = freshProjection();
    const goalId = p.addGoal({
      name: "Car",
      targetCents: dollarsToCents(30000),
      targetDate: 36,
      disposition: "retain",
      annualReturnPct: 3,
    });
    const jobId = p.addJob(P1, plainJob);
    const lineId = p.addBudgetLine(expenseLine);

    // A `Partial<Plan>` would make `updatePlan({ goals: [] })` a way past `removeGoal`'s
    // fund-account guard. `PlanPatch` excludes the collections, so it does not typecheck —
    // and they are dropped at runtime too, for the JavaScript caller the type never reaches.
    // @ts-expect-error the collections are not part of PlanPatch
    p.updatePlan({ goals: [], jobs: [], budgetLines: [], inflationPct: 4 });

    expect(p.plan.goals.map((g) => g.id)).toContain(goalId);
    expect(p.plan.jobs.map((j) => j.id)).toEqual([jobId]);
    expect(p.plan.budgetLines.map((l) => l.id)).toEqual([lineId]);
    // The scalar in the same patch still lands — only the collections are refused.
    expect(p.plan.inflationPct).toBe(4);
  });

  it("offers no setRetirementTarget — there is no retirement age to write", () => {
    // The named shorthand went with the scalar it wrote. Asserted as absent rather than left
    // untested: it was the one door through which a retirement age could still be authored, and
    // a plan that can state one is a plan whose jobs can be contradicted by it.
    const p = freshProjection() as unknown as Record<string, unknown>;
    expect(p.setRetirementTarget).toBeUndefined();
  });
});

