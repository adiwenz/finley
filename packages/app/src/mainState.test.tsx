/**
 * @vitest-environment jsdom
 *
 * Behavioral coverage for App's plan state (the value-editing surface §10.2 and
 * the event ledger). These pin the wiring that replaced the old usePlanState
 * hook: budget edits churn the projection base, scrub/ledger edits do not, and
 * removal resolves against the latest ledger.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { App } from "./main";
import * as engine from "@finley/engine";

beforeAll(() => {
  // Recharts' ResponsiveContainer measures via ResizeObserver, absent in jsdom.
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

describe("App — initial values", () => {
  it("opens with the default plan and an empty ledger", () => {
    render(<App />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alex");
    expect((screen.getByLabelText(/Opening balance/) as HTMLInputElement).value).toBe("10000");
    expect((screen.getByLabelText(/Savings return/) as HTMLInputElement).value).toBe("7");
    expect(screen.getByText(/No life events yet/)).toBeTruthy();
  });
});

describe("App — event ledger", () => {
  it("adds an event without rebuilding the projection base", () => {
    const spy = vi.spyOn(engine, "createProjectionBase");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    fireEvent.click(screen.getByText("Add event"));

    // A default "Started a job" event now has one timeline marker (one Remove).
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(screen.queryByText(/No life events yet/)).toBeNull();
    // Ledger edits must not churn budget identity (projection base is memoized).
    expect(spy.mock.calls.length).toBe(callsAfterMount);
  });

  it("removes an event", () => {
    render(<App />);
    fireEvent.click(screen.getByText("Add event"));
    expect(screen.getAllByText("Remove")).toHaveLength(1);

    fireEvent.click(screen.getByText("Remove"));

    expect(screen.queryAllByText("Remove")).toHaveLength(0);
    expect(screen.getByText(/No life events yet/)).toBeTruthy();
  });

  it("removes every event when several removals run inside one act (no update discarded)", () => {
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

  it("only offers partners already in the household by the separation month", () => {
    render(<App />);

    // Partner joins in Year 5 (month 60).
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "60" } });
    fireEvent.click(screen.getByText("Add event"));

    // Switch to Separation. Its month defaults to Year 0 — before the partnership.
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "SeparationEvent" },
    });
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.getByText(/No partner in the household as of Year 0/)).toBeTruthy();

    // Move the separation to Year 5 — now the partner exists to separate from.
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "60" } });
    expect(screen.getByLabelText("From")).toBeTruthy();
  });

  it("offers a job/expense owner only once the partner is in the household", () => {
    render(<App />);

    // Partner joins in Year 5 (month 60).
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "60" } });
    fireEvent.click(screen.getByText("Add event"));

    // Back to the default "Started a job"; its month defaults to Year 0, before
    // the partnership — so there's no one but you to attribute income to.
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "JobChangeEvent" },
    });
    expect(screen.queryByLabelText("Whose")).toBeNull();

    // Move the job to Year 5 — the partner is now in the household and eligible.
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "60" } });
    const owner = screen.getByLabelText("Whose");
    expect(within(owner).getByRole("option", { name: "Partner" })).toBeTruthy();
  });

  it("blocks a removal whose dependent would fail, and surfaces the conflict", () => {
    render(<App />);

    // Partner joins the household…
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.click(screen.getByText("Add event"));

    // …then a separation from that partner.
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "SeparationEvent" },
    });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "p-0" } });
    fireEvent.click(screen.getByText("Add event"));

    expect(screen.getAllByText("Remove")).toHaveLength(2);

    // Removing "Partnered" would strand the separation → blocked with a conflict.
    fireEvent.click(screen.getAllByText("Remove")[0]);

    expect(screen.getByText(/can.t do that yet/i)).toBeTruthy();
    expect(screen.getAllByText("Remove")).toHaveLength(2);
  });
});

describe("App — budget edits", () => {
  it("rebuilds the projection base on a budget edit but not on scrub", () => {
    const spy = vi.spyOn(engine, "createProjectionBase");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    // Scrubbing the timeline changes no plan input, so nothing rebuilds the base.
    fireEvent.change(screen.getByLabelText(/Scrub to a month/), {
      target: { value: "120" },
    });
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    // A budget edit rebuilds it — once for the net-worth graph, plus the sweep the
    // projection-driven retirement panel runs to find the feasible age (#37), so the
    // count jumps by more than one. What matters is that an edit *does* rebuild.
    fireEvent.change(screen.getByLabelText(/Savings return/), {
      target: { value: "5" },
    });
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("appends expense overrides without replacing earlier ones", () => {
    render(<App />);

    for (let i = 0; i < 2; i++) {
      // The editor button (not the snapshot panel's expense row of the same text).
      fireEvent.click(screen.getByRole("button", { name: "$3,500/mo" }));
      fireEvent.click(screen.getByText("From here forward"));
    }

    expect(screen.getAllByText(/From Year 0/)).toHaveLength(2);
  });
});
