/**
 * @vitest-environment jsdom
 *
 * Delete-guard wiring for the Goals panel: a goal whose fund account funds an event cannot
 * be deleted, and the refusal names the blocking events. The block logic itself is unit-
 * tested in goalsView.test.ts; these pin that the panel consults it and refuses the mutation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  emptyLedger,
  replayLedger,
  dollarsToCents,
  nullJurisdiction,
  createProjectionBase,
  goalFundAccountId,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { GoalsPanel } from "./goalsPanel";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan, GoalPlan, Ledger, LifeEvent } from "@finley/engine";

afterEach(cleanup);

const goal: GoalPlan = {
  id: "home",
  name: "Home down payment",
  targetCents: dollarsToCents(100000),
  targetDate: 72,
  disposition: "retain",
  annualReturnPct: 0,
};

function homePurchase(sourceIds: readonly string[]): LifeEvent {
  return {
    type: "HomePurchaseEvent",
    id: "buy1",
    sequenceNumber: 0,
    month: 72,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: dollarsToCents(500000),
    downPaymentCents: dollarsToCents(100000),
    downPaymentSourceIds: sourceIds,
    mortgageLiabilityId: "mtg1",
    mortgageApr: 0,
    mortgageTermMonths: 360,
  };
}

function project(budget: Plan) {
  return replayLedger(
    emptyLedger,
    createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR }),
    nullJurisdiction,
  );
}

function renderPanel(ledger: Ledger, setBudget = vi.fn()) {
  const budget: Plan = { ...PLAN_DEFAULTS, goals: [goal] };
  render(
    <GoalsPanel budget={budget} series={project(budget)} setBudget={setBudget} ledger={ledger} />,
  );
  return { setBudget };
}

describe("GoalsPanel — refuse to delete a goal that funds an event", () => {
  it("refuses the deletion and names the blocking event", () => {
    const ledger = { events: [homePurchase([goalFundAccountId(goal)])], nextSequenceNumber: 1 };
    const { setBudget } = renderPanel(ledger);
    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(setBudget).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "This account cannot be deleted because it funds",
    );
    expect(screen.getByRole("alert").textContent).toContain("Bought a home");
  });

  it("deletes normally when the goal's fund account funds nothing", () => {
    const ledger = { events: [homePurchase(["savings"])], nextSequenceNumber: 1 };
    const { setBudget } = renderPanel(ledger);
    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(setBudget).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
