import { describe, expect, it, vi } from "vitest";
import type { GoalPlan, Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "./planDefaults";
import {
  dispositionLabel,
  fundingBlockMessage,
  goalDisposal,
  goalFundingBlocks,
  goalRows,
} from "./goalsView";

const goalA: GoalPlan = {
  id: "a",
  name: "Emergency fund",
  targetCents: 3_000_000,
  targetDate: 12,
  disposition: "retain",
  annualReturnPct: 1,
};
const goalB: GoalPlan = {
  id: "b",
  name: "Trip",
  targetCents: 2_000_000,
  targetDate: "asap",
  disposition: "drawDown",
  annualReturnPct: 7,
};
const budget: Plan = { ...PLAN_DEFAULTS, goals: [goalA, goalB] };

function result(rows: readonly any[]) {
  return { goalProgress: () => rows } as any;
}

describe("goalRows", () => {
  it("maps the engine's goal progress into display rows without recomputing it", () => {
    const rows = goalRows(
      budget,
      result([
        {
          goal: { ...goalA, priority: 0 },
          progress: {
            onTrackFraction: 0.654,
            shortHorizonRiskFlag: false,
            completion: "inProgress",
          },
        },
        {
          goal: { ...goalB, priority: 1 },
          progress: {
            onTrackFraction: 1.4,
            shortHorizonRiskFlag: true,
            completion: "funded",
          },
        },
      ]),
    );

    expect(rows[0]).toMatchObject({
      id: "a",
      priority: 0,
      onTrackPct: 65,
      annualReturnPct: 1,
      completion: "inProgress",
      behindPace: true,
      dispositionLabel: "Kept as a reserve",
    });
    expect(rows[1]).toMatchObject({
      id: "b",
      priority: 1,
      onTrackPct: 100,
      annualReturnPct: 7,
      shortHorizonRiskFlag: true,
      completion: "funded",
      behindPace: false,
      dispositionLabel: "Drawn down over time",
    });
  });

  it("caps the displayed on-track percentage at 100", () => {
    const [row] = goalRows(
      { ...budget, goals: [goalA] },
      result([
        {
          goal: { ...goalA, priority: 0 },
          progress: { onTrackFraction: 2.5, shortHorizonRiskFlag: false, completion: "funded" },
        },
      ]),
    );
    expect(row.onTrackPct).toBe(100);
  });
});

describe("goal view vocabulary", () => {
  it("labels both dispositions", () => {
    expect(dispositionLabel("retain")).toBe("Kept as a reserve");
    expect(dispositionLabel("drawDown")).toBe("Drawn down over time");
  });

  it("pairs disposition and target date verbatim", () => {
    expect(goalDisposal("retain", "asap")).toEqual({ disposition: "retain", targetDate: "asap" });
    expect(goalDisposal("drawDown", 24)).toEqual({ disposition: "drawDown", targetDate: 24 });
  });
});

describe("goal deletion presentation", () => {
  it("maps facade blocker events into the labels and months the panel needs", () => {
    const projection = {
      eventsFundedByGoal: vi.fn(() => [
        {
          id: "buy-1",
          sequenceNumber: 0,
          month: 72,
          type: "HomePurchaseEvent",
          propertyId: "home-1",
          ownerId: "primary",
          purchasePriceCents: 50_000_000,
          downPaymentCents: 10_000_000,
          downPaymentSourceIds: ["fund-a"],
        },
      ]),
    } as any;

    expect(goalFundingBlocks(projection, "a")).toEqual([
      { eventId: "buy-1", label: "Bought a home", month: 72 },
    ]);
    expect(projection.eventsFundedByGoal).toHaveBeenCalledWith("a");
  });

  it("formats zero, one, or several blockers without deciding which events block", () => {
    expect(fundingBlockMessage([])).toBeNull();
    expect(
      fundingBlockMessage([
        { eventId: "a", label: "Bought a home", month: 72 },
        { eventId: "b", label: "One-time spend", month: 84 },
      ]),
    ).toBe(
      "This account cannot be deleted because it funds:\n- Bought a home in Year 6 (2032)\n- One-time spend in Year 7 (2033)",
    );
  });
});
