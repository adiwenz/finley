/**
 * @vitest-environment jsdom
 *
 * The single authoring hook. Pins the transaction discipline every panel now depends on:
 * each write starts from the LATEST committed state (not the render-old one), commits the
 * whole resulting `ProjectionState`, and a refusal changes nothing while naming why.
 *
 * The same-tick case is the one a plan setter used to answer with a functional update. Panels
 * no longer have one, so it has to be answered here or two edits in one handler silently
 * become one.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  Projection,
  dollarsToCents,
  emptyLedger,
  goalFundAccountId,
  scenarioOf,
  withLedger,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PLAN_DEFAULTS } from "../planDefaults";
import { START_YEAR } from "../config";
import { useProjection, type UseProjection } from "./useProjection";
import type { GoalPlan, LifeEvent, ProjectionState } from "@finley/engine";

afterEach(cleanup);

const stateOf = (plan = PLAN_DEFAULTS): ProjectionState =>
  Projection.fromScenario(scenarioOf(plan), START_YEAR, usJurisdiction).toState();

const BLOCKED_GOAL: GoalPlan = {
  id: "down-payment",
  name: "Down payment",
  targetCents: dollarsToCents(100_000),
  targetDate: 72,
  disposition: "retain",
  annualReturnPct: 0,
};

/**
 * A goal the facade refuses to remove: a home purchase already spends from its derived fund
 * account, so dropping the goal would strand that reference.
 *
 * Authored as a scenario rather than through `buyHome`, so the fixture states the reference it
 * is about and nothing else — routing it through the authoring gate would make the setup
 * depend on the purchase being affordable, which is a different test's subject.
 */
function blockedGoalState(): ProjectionState {
  const purchase: LifeEvent = {
    type: "HomePurchaseEvent",
    id: "buy1",
    sequenceNumber: 0,
    month: 72,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: dollarsToCents(500_000),
    downPaymentCents: dollarsToCents(100_000),
    downPaymentSourceIds: [goalFundAccountId(BLOCKED_GOAL)],
    mortgageLiabilityId: "mtg1",
    mortgageApr: 0,
    mortgageTermMonths: 360,
  };
  const scenario = withLedger(scenarioOf({ ...PLAN_DEFAULTS, goals: [BLOCKED_GOAL] }), {
    events: [purchase],
    nextSequenceNumber: 1,
  });
  return Projection.fromScenario(scenario, START_YEAR, usJurisdiction).toState();
}

/** The hook under test, with its state and conflict rendered for assertion. */
function Harness({ onReady }: { onReady: (hook: UseProjection) => void }) {
  const hook = useProjection(stateOf());
  onReady(hook);
  const plan = hook.state.scenario.plan;
  return (
    <>
      <output data-testid="goal-ids">{plan.goals.map((g) => g.id).join(",")}</output>
      <output data-testid="line-count">{plan.budgetLines.length}</output>
      <output data-testid="retirement-age">{plan.retirementAge}</output>
      <output data-testid="conflict">{hook.conflict ?? ""}</output>
    </>
  );
}

/** Renders the hook and hands back a live reference to its latest returned value. */
function renderHook(): () => UseProjection {
  let latest: UseProjection | undefined;
  render(<Harness onReady={(h) => (latest = h)} />);
  return () => {
    if (latest === undefined) throw new Error("hook never rendered");
    return latest;
  };
}

const goalIds = () => screen.getByTestId("goal-ids").textContent ?? "";
const lineCount = () => Number(screen.getByTestId("line-count").textContent);
const conflict = () => screen.getByTestId("conflict").textContent ?? "";

const goal = (name: string) => ({
  name,
  targetCents: dollarsToCents(10_000),
  targetDate: 60,
  disposition: "retain" as const,
  annualReturnPct: 0,
});

describe("useProjection — several writes in ONE tick", () => {
  it("keeps every write, each starting from what the one before it committed", () => {
    const hook = renderHook();
    const before = goalIds().split(",").filter(Boolean).length;

    // Three writes with no render between them — the shape a handler that edits twice takes.
    act(() => {
      hook().transact((p) => p.addGoal(goal("First")));
      hook().transact((p) => p.addGoal(goal("Second")));
      hook().transact((p) => p.addGoal(goal("Third")));
    });

    const ids = goalIds().split(",").filter(Boolean);
    expect(ids).toHaveLength(before + 3);
    // Distinct ids: each write minted off the counter the previous one advanced, so no
    // update was computed from a state that had already been superseded.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("composes writes across the two collections in one tick", () => {
    const hook = renderHook();
    const goalsBefore = goalIds().split(",").filter(Boolean).length;
    const linesBefore = lineCount();

    act(() => {
      hook().transact((p) => p.addGoal(goal("Trip")));
      hook().transact((p) =>
        p.addBudgetLine({
          label: "Gym",
          target: { kind: "expense" },
          amountSource: { kind: "literal", monthlyCents: dollarsToCents(80) },
          category: "wants",
        }),
      );
      hook().transact((p) => p.updatePlan({ retirementAge: 62 }));
    });

    expect(goalIds().split(",").filter(Boolean)).toHaveLength(goalsBefore + 1);
    expect(lineCount()).toBe(linesBefore + 1);
    expect(screen.getByTestId("retirement-age").textContent).toBe("62");
  });

  it("returns each write's own result, so a caller can use the id it just minted", () => {
    const hook = renderHook();
    let first: string | undefined;
    let second: string | undefined;
    act(() => {
      first = hook().transact((p) => p.addGoal(goal("First")));
      second = hook().transact((p) => p.addGoal(goal("Second")));
    });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(goalIds()).toContain(first!);
    expect(goalIds()).toContain(second!);
  });
});

describe("useProjection — a refused write", () => {
  /** The hook standing on a state whose one goal cannot be removed. */
  function blocked(): () => UseProjection {
    const hook = renderHook();
    act(() => hook().loadState(blockedGoalState()));
    return hook;
  }

  it("changes nothing and reports the reason", () => {
    const hook = blocked();
    const idsBefore = goalIds();

    act(() => {
      hook().transact((p) => p.removeGoal(BLOCKED_GOAL.id));
    });

    expect(goalIds()).toBe(idsBefore); // the goal is still there
    expect(conflict()).not.toBe("");
    // The facade's `Projection: cannot …` framing is stripped: the user reads the reason.
    expect(conflict()).not.toContain("Projection: cannot");
  });

  it("returns undefined, so a caller can tell a refusal from a write with no result", () => {
    const hook = blocked();
    let result: unknown = "unset";
    act(() => {
      result = hook().transact((p) => p.removeGoal(BLOCKED_GOAL.id));
    });
    expect(result).toBeUndefined();
  });

  it("leaves the rest of a batched transaction unapplied", () => {
    // The refusal comes last, after two writes that would each have succeeded on their own.
    const hook = blocked();
    const linesBefore = lineCount();

    act(() => {
      hook().transact((p) => {
        p.updatePlan({ retirementAge: 61 });
        p.addBudgetLine({
          label: "Gym",
          target: { kind: "expense" },
          amountSource: { kind: "literal", monthlyCents: dollarsToCents(80) },
          category: "wants",
        });
        p.removeGoal(BLOCKED_GOAL.id);
      });
    });

    expect(lineCount()).toBe(linesBefore);
    expect(screen.getByTestId("retirement-age").textContent).toBe(String(PLAN_DEFAULTS.retirementAge));
  });

  it("clears on the next write that succeeds, and not before", () => {
    const hook = blocked();

    act(() => {
      hook().transact((p) => p.removeGoal(BLOCKED_GOAL.id));
    });
    expect(conflict()).not.toBe("");

    // A second refusal leaves the message standing rather than blanking it mid-flight.
    act(() => {
      hook().transact((p) => p.removeGoal(BLOCKED_GOAL.id));
    });
    expect(conflict()).not.toBe("");

    act(() => {
      hook().transact((p) => p.updatePlan({ retirementAge: 63 }));
    });
    expect(conflict()).toBe("");
  });
});

describe("useProjection — loading a whole state", () => {
  it("replaces the state and drops a standing conflict", () => {
    const hook = renderHook();
    act(() => hook().loadState(blockedGoalState()));
    act(() => {
      hook().transact((p) => p.removeGoal(BLOCKED_GOAL.id));
    });
    expect(conflict()).not.toBe("");
    expect(goalIds()).toContain(BLOCKED_GOAL.id);

    act(() => {
      hook().loadState(stateOf({ ...PLAN_DEFAULTS, goals: [] }));
    });

    expect(goalIds()).toBe("");
    expect(conflict()).toBe("");
  });

  it("writes after a load start from the LOADED state, not the one it replaced", () => {
    const hook = renderHook();
    act(() => {
      hook().loadState(stateOf({ ...PLAN_DEFAULTS, goals: [] }));
      // Same tick as the load: the write must not compose against the pre-load plan.
      hook().transact((p) => p.addGoal(goal("Fresh")));
    });
    expect(goalIds().split(",").filter(Boolean)).toHaveLength(1);
  });
});

describe("useProjection — removing a timeline transaction", () => {
  it("drops the event and surfaces a refusal like any other write", () => {
    const hook = renderHook();
    let eventId = "";
    act(() => {
      eventId = hook().transact((p) =>
        p.takeLoan({
          month: 0,
          ownerId: "p1",
          openingBalanceCents: dollarsToCents(20_000),
          apr: 0.06,
          kind: "studentLoan",
          termMonths: 120,
        }),
      )!;
    });
    expect(hook().state.scenario.ledger.events).toHaveLength(1);

    act(() => {
      hook().removeEvent(eventId);
    });
    expect(hook().state.scenario.ledger.events).toEqual(emptyLedger.events);
    expect(conflict()).toBe("");
  });
});
