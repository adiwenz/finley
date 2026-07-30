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
import { monthLabel } from "../../format";
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

function homePurchase(
  sourceIds: readonly string[],
  { id = "buy1", sequenceNumber = 0, month = 72 } = {},
): LifeEvent {
  return {
    type: "HomePurchaseEvent",
    id,
    sequenceNumber,
    month,
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

const ledgerOf = (...events: readonly LifeEvent[]): Ledger => ({
  events,
  nextSequenceNumber: events.length + 1,
});

function project(budget: Plan) {
  return replayLedger(
    emptyLedger,
    createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR }),
    nullJurisdiction,
  );
}

function renderPanel(ledger: Ledger, setBudget = vi.fn()) {
  const budget: Plan = { ...PLAN_DEFAULTS, goals: [goal] };
  const series = project(budget);
  const panel = (l: Ledger) => (
    <GoalsPanel
      budget={budget}
      series={series}
      setBudget={setBudget}
      ledger={l}
      onAddGoal={vi.fn()}
    />
  );
  const { rerender } = render(panel(ledger));
  // The ledger is the only prop under test, so re-rendering means handing over a new one —
  // the panel keeps its own state across the swap, which is the point.
  return { setBudget, rerender: (next: Ledger) => rerender(panel(next)) };
}

describe("GoalsPanel — refuse to delete a goal that funds an event", () => {
  it("refuses the deletion and names the blocking event", () => {
    const ledger = ledgerOf(homePurchase([goalFundAccountId(goal)]));
    const { setBudget } = renderPanel(ledger);
    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(setBudget).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "This account cannot be deleted because it funds",
    );
    expect(screen.getByRole("alert").textContent).toContain("Bought a home");
  });

  it("deletes normally when the goal's fund account funds nothing", () => {
    const ledger = ledgerOf(homePurchase(["savings"]));
    const { setBudget } = renderPanel(ledger);
    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(setBudget).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("GoalsPanel — a refusal answers one delete, and does not outlive it", () => {
  const DELETE = "Delete Home down payment";
  const fundedByGoal = (over?: { id?: string; sequenceNumber?: number; month?: number }) =>
    homePurchase([goalFundAccountId(goal)], over);

  it("does not revive once a LATER event funds the same goal", () => {
    const { setBudget, rerender } = renderPanel(ledgerOf(fundedByGoal()));

    // 1. The delete is blocked, and the warning names the blocker.
    fireEvent.click(screen.getByLabelText(DELETE));
    expect(setBudget).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Bought a home");

    // 2. That event leaves the ledger — nothing blocks the goal, so the warning goes.
    rerender(emptyLedger);
    expect(screen.queryByRole("alert")).toBeNull();

    // 3. A DIFFERENT event now funds the same goal.
    rerender(ledgerOf(fundedByGoal({ id: "buy2", sequenceNumber: 1, month: 84 })));

    // 4. The user never asked to delete again, so nothing is refused and nothing is shown.
    expect(screen.queryByRole("alert")).toBeNull();

    // Asking again does refuse — on the new blocker, at its own month.
    fireEvent.click(screen.getByLabelText(DELETE));
    expect(screen.getByRole("alert").textContent).toContain(`Bought a home in ${monthLabel(84)}`);
    expect(setBudget).not.toHaveBeenCalled();
  });

  it("does not revive when the blocker is REPLACED in a single update", () => {
    // The harder path: no render in between where the goal is unblocked, so there is no
    // moment at which a spent refusal could notice it should drop itself. Only the pinned
    // ids can tell the answered question apart from the new blocker.
    const { rerender } = renderPanel(ledgerOf(fundedByGoal()));
    fireEvent.click(screen.getByLabelText(DELETE));
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender(ledgerOf(fundedByGoal({ id: "buy2", sequenceNumber: 1, month: 84 })));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-reads the blocker's words from the ledger rather than freezing them", () => {
    // The refusal stores ids, not the sentence, so re-dating the blocking event re-words it.
    const { rerender } = renderPanel(ledgerOf(fundedByGoal()));
    fireEvent.click(screen.getByLabelText(DELETE));
    expect(screen.getByRole("alert").textContent).toContain(`Bought a home in ${monthLabel(72)}`);

    rerender(ledgerOf(fundedByGoal({ month: 96 })));
    expect(screen.getByRole("alert").textContent).toContain(`Bought a home in ${monthLabel(96)}`);
  });

  it("keeps the refusal while only SOME of its blockers are cleared", () => {
    const both = ledgerOf(fundedByGoal(), fundedByGoal({ id: "buy2", sequenceNumber: 1, month: 84 }));
    const { rerender } = renderPanel(both);
    fireEvent.click(screen.getByLabelText(DELETE));
    expect(screen.getByRole("alert").textContent).toContain(`Bought a home in ${monthLabel(72)}`);
    expect(screen.getByRole("alert").textContent).toContain(`Bought a home in ${monthLabel(84)}`);

    // One blocker re-pointed away; the goal is still blocked by the other.
    rerender(ledgerOf(fundedByGoal({ id: "buy2", sequenceNumber: 1, month: 84 })));
    const alert = screen.getByRole("alert").textContent;
    expect(alert).toContain(`Bought a home in ${monthLabel(84)}`);
    expect(alert).not.toContain(monthLabel(72));
  });
});
