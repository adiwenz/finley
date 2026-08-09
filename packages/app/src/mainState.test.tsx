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
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
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

describe("App — central projection state", () => {
  it("reprojects when a ledger event changes the central state", () => {
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    fireEvent.click(screen.getByText("Add event"));

    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("composes several removals in one tick without discarding an update", () => {
    render(<App />);
    fireEvent.click(screen.getByText("Add event"));
    fireEvent.click(screen.getByText("Add event"));

    const removes = screen.getAllByText("Remove");
    expect(removes).toHaveLength(2);

    act(() => {
      fireEvent.click(removes[0]);
      fireEvent.click(removes[1]);
    });

    expect(screen.queryAllByText("Remove")).toHaveLength(0);
  });

  it("carries a timeline-authored partner job to both Jobs and income surfaces", () => {
    render(<App />);

    const incomeDollars = () =>
      Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));
    const before = incomeDollars();

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "0" } });

    const partnerJobsField = screen.getByText("Jobs (optional)").closest(".field") as HTMLElement;
    fireEvent.click(within(partnerJobsField).getByRole("button", { name: /Add a job/i }));
    enterNumber(screen.getByRole("spinbutton", { name: /Monthly salary/i }), "2000");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.click(screen.getByText("Add event"));

    expect(screen.getByLabelText("Partner · Job 1")).toBeTruthy();
    expect(incomeDollars()).not.toBe(before);
  });

  it("surfaces a refused central write without dropping the existing events", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.click(screen.getByText("Add event"));

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "SeparationEvent" },
    });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "p-0" } });
    fireEvent.click(screen.getByText("Add event"));

    expect(screen.getAllByText("Remove")).toHaveLength(2);

    fireEvent.click(screen.getAllByText("Remove")[0]);

    expect(screen.getByText(/can.t do that yet/i)).toBeTruthy();
    expect(screen.getAllByText("Remove")).toHaveLength(2);
  });
});

describe("App — scenario replacement", () => {
  it("loads a scenario's plan and seed timeline together", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "student-loan" },
    });

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Riley");
    expect(screen.getAllByText("Remove")).toHaveLength(1);
  });

  it("clears the old seed timeline when the next scenario has none", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "student-loan" },
    });
    expect(screen.getAllByText("Remove")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "living-on-credit" },
    });

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Jordan");
    expect(screen.getByText(/No life events yet/)).toBeTruthy();
  });
});

describe("App — projection orchestration", () => {
  it("does not run the stop-working preview projection until preview is enabled", () => {
    const spy = vi.spyOn(engine.Projection.prototype, "runAtStopWorkingAge");
    render(<App />);

    expect(spy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Savings return/), { target: { value: "5" } });
    fireEvent.blur(screen.getByLabelText(/Savings return/));
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Preview the charts/ }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reprojects on a committed budget edit but not on timeline scrub", () => {
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/Scrub to a month/), {
      target: { value: "120" },
    });
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    fireEvent.change(screen.getByLabelText(/Savings return/), { target: { value: "5" } });
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    fireEvent.blur(screen.getByLabelText(/Savings return/));
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("routes a line-item budget edit into the same central projection state", () => {
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
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
