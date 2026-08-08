/**
 * @vitest-environment jsdom
 *
 * GoalsPanel deletion UI only. The engine owns which events actually fund a goal; this suite
 * supplies `eventsFundedByGoal` directly and tests refusal state, messaging, and transaction routing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { GoalsPanel } from "./goalsPanel";

const goal = {
  id: "goal-1",
  name: "Home down payment",
  targetCents: 10_000_000,
  targetDate: 72,
  disposition: "retain" as const,
  annualReturnPct: 0,
};

const budget = { ...PLAN_DEFAULTS, goals: [goal] };

const progressResult = {
  goalProgress: () => [
    {
      goal: { ...goal, priority: 0 },
      progress: {
        onTrackFraction: 0.5,
        shortHorizonRiskFlag: false,
        completion: "inProgress",
      },
    },
  ],
} as any;

const blocker = (id = "event-1", month = 72) => ({
  id,
  sequenceNumber: 0,
  month,
  type: "HomePurchaseEvent",
  propertyId: `house-${id}`,
  ownerId: "primary",
  purchasePriceCents: 50_000_000,
  downPaymentCents: 10_000_000,
  downPaymentSourceIds: ["fund-goal-1"],
});

function renderPanel(events: readonly any[] = []) {
  const transact = vi.fn();
  const projection = { eventsFundedByGoal: vi.fn(() => events) } as any;
  const view = (nextEvents: readonly any[]) => (
    <GoalsPanel
      budget={budget}
      result={progressResult}
      projection={{ ...projection, eventsFundedByGoal: vi.fn(() => nextEvents) }}
      transact={transact}
    />
  );
  const rendered = render(view(events));
  return {
    transact,
    rerender: (nextEvents: readonly any[]) => rendered.rerender(view(nextEvents)),
  };
}

afterEach(cleanup);

describe("GoalsPanel — delete refusal", () => {
  it("shows the blocking events and does not transact when deletion is refused", () => {
    const { transact } = renderPanel([blocker()]);

    fireEvent.click(screen.getByLabelText("Delete Home down payment"));

    expect(transact).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("This account cannot be deleted because it funds");
    expect(screen.getByRole("alert").textContent).toContain("Bought a home");
  });

  it("routes an unblocked deletion through transact", () => {
    const { transact } = renderPanel([]);

    fireEvent.click(screen.getByLabelText("Delete Home down payment"));

    expect(transact).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a spent refusal when its blocker disappears", () => {
    const { rerender } = renderPanel([blocker()]);
    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender([]);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not revive an old refusal for a different later blocker until delete is asked again", () => {
    const { rerender } = renderPanel([blocker("event-1", 72)]);
    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender([blocker("event-2", 84)]);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByLabelText("Delete Home down payment"));
    expect(screen.getByRole("alert").textContent).toContain("Year 7");
  });
});
