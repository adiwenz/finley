/**
 * @vitest-environment jsdom
 *
 * App-level orchestration coverage only.
 *
 * Component rendering/interaction belongs in the owning component suite.
 * Financial/domain semantics belong in @finley/engine.
 * Pure presentation transforms belong in app Node tests.
 *
 * A test belongs here only when it proves that App's central state coordinates
 * multiple surfaces correctly or avoids/requires expensive projection work.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { enterNumber } from "./testing/numberField";
import { App } from "./main";
import * as engine from "@finley/engine";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

/** The rail — the home screen's "today" column. Scopes queries away from the chooser and chart. */
const rail = (): HTMLElement => screen.getByRole("complementary", { name: /Your plan today/i });

/** Home → "Add life change" → the chooser card for `label`, leaving that kind's form open. */
function openChangeForm(label: string): void {
  fireEvent.click(within(rail()).getByRole("button", { name: /Add life change/i }));
  // The chooser lives in the drawer, so it is unambiguous even when the rail already lists a
  // change of the same kind.
  const drawer = screen.getByRole("dialog");
  fireEvent.click(within(drawer).getByRole("button", { name: new RegExp(label, "i") }));
}

/** The rail row for a life change, which is what opens it for editing. */
function railChange(label: string): HTMLElement {
  return within(rail()).getByRole("button", { name: new RegExp(label, "i") });
}

/** The wordmark, which is the way back to the plan from anywhere. */
function goHome(): void {
  fireEvent.click(screen.getByRole("button", { name: /Go to your plan/i }));
}

describe("App — central projection state", () => {
  it("reprojects when a ledger event changes the central state", () => {
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    openChangeForm("Took out a loan");
    fireEvent.click(screen.getByText("Add event"));

    // The change is now in the rail, and the projection was rebuilt to account for it.
    expect(railChange("Took out a loan")).toBeTruthy();
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("removes a life change through its drawer and drops it from the rail", () => {
    render(<App />);
    openChangeForm("Took out a loan");
    fireEvent.click(screen.getByText("Add event"));

    fireEvent.click(railChange("Took out a loan"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    expect(within(rail()).queryByRole("button", { name: /Took out a loan/i })).toBeNull();
  });

  it("carries a timeline-authored partner job to both the Jobs workspace and household income", () => {
    render(<App />);

    // Household income is stated on the Jobs workspace's summary tile — the surface a partner's
    // pay must reach, and the one a reader would check it against.
    const incomeTile = () => {
      fireEvent.click(within(rail()).getByRole("button", { name: /^Income$/i }));
      const value = within(screen.getByRole("dialog")).getByText(/per year, before tax/i)
        .previousSibling?.textContent ?? "";
      fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));
      return value;
    };
    const before = incomeTile();

    openChangeForm("Partnered");
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "0" } });

    const partnerJobsField = screen.getByText("Jobs (optional)").closest(".field") as HTMLElement;
    fireEvent.click(within(partnerJobsField).getByRole("button", { name: /Add a job/i }));
    enterNumber(screen.getByRole("spinbutton", { name: /Monthly salary/i }), "2000");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.click(screen.getByText("Add event"));

    expect(incomeTile()).not.toBe(before);
  });

  it("surfaces a refused removal without dropping the existing changes", () => {
    render(<App />);

    openChangeForm("Partnered");
    fireEvent.click(screen.getByText("Add event"));

    openChangeForm("Separated");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "p-0" } });
    fireEvent.click(screen.getByText("Add event"));

    // Removing the partnering would orphan the separation that depends on it. The drawer stays
    // open with the reason, and neither change is lost.
    fireEvent.click(railChange("Partnered"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    expect(screen.getByText(/can.t do that yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));
    expect(railChange("Partnered")).toBeTruthy();
    expect(railChange("Separated")).toBeTruthy();
  });
});

describe("App — scenario replacement", () => {
  /** Settings holds the "start over" picker; every scenario swap goes through it. */
  function chooseScenario(id: string): void {
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/ }));
    fireEvent.change(screen.getByLabelText(/Start from a scenario/), { target: { value: id } });
  }

  it("loads a scenario's plan and seed timeline together", () => {
    render(<App />);

    chooseScenario("student-loan");

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Riley");
    goHome();
    expect(railChange("Took out a loan")).toBeTruthy();
  });

  it("clears the old seed timeline when the next scenario has none", () => {
    render(<App />);

    chooseScenario("student-loan");
    chooseScenario("living-on-credit");

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Jordan");
    goHome();
    expect(screen.getByText(/What might change in the future\?/i)).toBeTruthy();
  });
});

describe("App — projection orchestration", () => {
  it("does not run the stop-working preview projection until preview is enabled", () => {
    const spy = vi.spyOn(engine.Projection.prototype, "runAtStopWorkingAge");
    render(<App />);

    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Settings$/ }));
    fireEvent.change(screen.getByLabelText(/Savings return/), { target: { value: "5" } });
    fireEvent.blur(screen.getByLabelText(/Savings return/));
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Preview the charts/ }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reprojects on a committed budget edit but not on an uncommitted keystroke", () => {
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/ }));
    const callsAfterMount = spy.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/Savings return/), { target: { value: "5" } });
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    fireEvent.blur(screen.getByLabelText(/Savings return/));
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("routes a line-item budget edit into the same central projection state", () => {
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    // The line-item budget lives in the Spending workspace, reached from the rail's card.
    fireEvent.click(within(rail()).getByRole("button", { name: /^Spending$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Edit spending/i }));
    const callsAfterMount = spy.mock.calls.length;

    enterNumber(screen.getByRole("spinbutton", { name: /Housing/ }), 9000);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));

    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    const lastState = spy.mock.calls.at(-1)?.[0];

    expect(
      lastState?.scenario.plan.budgetLines.find((line) => line.label === "Housing")?.overrides,
    ).toHaveLength(1);
  });
});

describe("App — navigation", () => {
  it("opens the matching summary drawer from each rail card", () => {
    render(<App />);

    fireEvent.click(within(rail()).getByRole("button", { name: /^Net worth$/i }));

    expect(screen.getByRole("dialog", { name: /Net worth/i })).toBeTruthy();
    expect(screen.getByText(/What the household owns and owes/i)).toBeTruthy();
  });

  it("follows a summary drawer's call to action into its workspace", () => {
    render(<App />);

    fireEvent.click(within(rail()).getByRole("button", { name: /^Income$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Manage jobs & income/i }));

    expect(screen.getByRole("heading", { level: 1, name: /Jobs & income/i })).toBeTruthy();
    // Following the CTA closes the drawer — the workspace is the surface now.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("App — onboarding", () => {
  /** Settings → "Build a new plan" opens the single onboarding page over the app. */
  function openOnboarding(): void {
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Build a new plan/i }));
  }

  it("asks everything on one page and replaces the plan with the answers", () => {
    render(<App />);
    openOnboarding();

    // One page: every question is present at once, with no step to advance through.
    expect(screen.getByLabelText(/How old are you\?/i)).toBeTruthy();
    expect(screen.getByLabelText(/Are you planning with a partner\?/i)).toBeTruthy();
    expect(screen.getByLabelText(/Household income/i)).toBeTruthy();
    expect(screen.getByLabelText(/Household spending/i)).toBeTruthy();
    expect(screen.getByLabelText(/Savings and investments/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/How old are you\?/i), { target: { value: "44" } });
    fireEvent.click(screen.getByRole("button", { name: /See my future/i }));

    // Lands on the plan, built from what was typed.
    expect(within(rail()).getByText(/Age 44/)).toBeTruthy();
  });

  it("leaves the existing plan alone when cancelled", () => {
    render(<App />);
    openOnboarding();

    fireEvent.change(screen.getByLabelText(/How old are you\?/i), { target: { value: "44" } });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    goHome();

    expect(within(rail()).queryByText(/Age 44/)).toBeNull();
  });
});
