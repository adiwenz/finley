/**
 * @vitest-environment jsdom
 *
 * Behavioral coverage for App's plan state: value editing and the event ledger.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { App } from "./main";
import * as engine from "@finley/engine";
import { dollarsToCents } from "@finley/engine";
import { presetById } from "./presets";

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
    expect((screen.getByLabelText(/Savings return/) as HTMLInputElement).value).toBe("1");
    expect(screen.getByText(/No life events yet/)).toBeTruthy();
  });
});

describe("App — event ledger", () => {
  it("adds an event without rebuilding the projection base", () => {
    const spy = vi.spyOn(engine, "createProjectionBase");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    fireEvent.click(screen.getByText("Add event"));

    // The default "Added an expense" event has one timeline marker (one Remove).
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(screen.queryByText(/No life events yet/)).toBeNull();
    // The base is memoized on budget identity, which a ledger edit must not churn.
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

    // Move the separation to Year 5, where the partner exists.
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

    // The default "Added an expense" defaults to Year 0, before the partnership, so only
    // you can own it.
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "BudgetItemStartEvent" },
    });
    expect(screen.queryByLabelText("Whose")).toBeNull();

    // Move the expense to Year 5, where the partner is in the household.
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "60" } });
    const owner = screen.getByLabelText("Whose");
    expect(within(owner).getByRole("option", { name: "Partner" })).toBeTruthy();
  });

  it("carries a partner's own job through every surface, and edits it from the Jobs panel", () => {
    // A partner authored WITH a job on the timeline must (a) show up in the household's
    // job list, (b) count as income on the income-vs-spend graph, which once projected the
    // plan alone so no timeline event reached it, and (c) stay editable in place.
    render(<App />);
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "0" } });

    // Authored in the join form; scope to its Jobs section since the Jobs panel also
    // offers an "Add a job" button.
    const partnerJobsField = screen.getByText("Jobs (optional)").closest(".field") as HTMLElement;
    fireEvent.click(within(partnerJobsField).getByRole("button", { name: /Add a job/i }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /Monthly salary/i }), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.click(screen.getByText("Add event"));

    // (a) The Jobs panel lists it, owned by the partner, alongside the primary's.
    const row = screen.getByLabelText("Partner · Job 1");
    expect(within(row).getByText("$2,000/mo")).toBeTruthy();
    expect(screen.getByLabelText("Alex · Job 1")).toBeTruthy();

    // (b) The income-vs-spend surface counts it: $5,000 + $2,000 at a month before the
    // first CPI step.
    const selectBudgetMonth = (month: number) =>
      fireEvent.change(screen.getByRole("spinbutton", { name: "Month" }), {
        target: { value: String(month) },
      });
    const incomeDollars = () =>
      Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));
    selectBudgetMonth(6);
    expect(incomeDollars()).toBe(7000);

    // (c) Editing the partner's pay revises the RelationshipEvent in place.
    fireEvent.click(screen.getByRole("button", { name: /Edit Partner · Job 1/i }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /Monthly salary/i }), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(within(screen.getByLabelText("Partner · Job 1")).getByText("$3,000/mo")).toBeTruthy();
    // Still ONE marker — revised in place, not removed and re-added. (Match "Remove"
    // exactly; the join form's job list has a "Remove job 1" button.)
    expect(screen.getAllByRole("button", { name: /^Remove$/ })).toHaveLength(1);
    expect(incomeDollars()).toBe(8000);
  });

  it("blocks a removal whose dependent would fail, and surfaces the conflict", () => {
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

    // Removing "Partnered" would strand the separation → blocked with a conflict.
    fireEvent.click(screen.getAllByText("Remove")[0]);

    expect(screen.getByText(/can.t do that yet/i)).toBeTruthy();
    expect(screen.getAllByText("Remove")).toHaveLength(2);
  });
});

describe("App — starter simulations", () => {
  it("loads a scenario's plan and its seed timeline together", () => {
    render(<App />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alex");
    expect(screen.getByText(/No life events yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "student-loan" },
    });

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Riley");
    expect((screen.getByLabelText(/Opening balance/) as HTMLInputElement).value).toBe("4000");
    // The $45k student loan arrived as a real timeline event (one Remove control).
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(screen.queryByText(/No life events yet/)).toBeNull();
  });

  it("counts a scenario's loan payment in the spending need the income chart draws", () => {
    render(<App />);
    // The SECOND row: a Year-0 loan originates in month 0 and is first serviced in month 1,
    // so month 0's spending need does not include its payment.
    const spendingNeed = () =>
      Number(screen.getByTestId("income-second-spending-need").textContent);
    const withoutLoan = spendingNeed();

    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "student-loan" },
    });

    // Riley's $3,000 budget + health, PLUS the seed loan's scheduled payment (~$500/mo on
    // $45k at 6% over 10 years): the Base panel charts the whole scenario, not the bare
    // plan.
    const riley = presetById("student-loan").plan;
    const rileyBudget = riley.budgetLines.reduce(
      (sum, l) =>
        sum + (l.target.kind === "expense" && l.amountSource.kind === "literal" ? l.amountSource.monthlyCents : 0),
      0,
    );
    const budgetAndHealth = rileyBudget + riley.healthMonthlyCents;
    expect(spendingNeed()).toBeGreaterThan(budgetAndHealth + dollarsToCents(400));
    expect(spendingNeed()).not.toBe(withoutLoan);
  });

  it("draws the loan payment as its own band on the spending graph", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "student-loan" },
    });

    // Beside the budget lines, not as one of them. Read the SECOND row: the seed loan is
    // authored at Year 0, so month 0 originates it and month 1 is the first month it is
    // serviced (an amortization schedule's index 0 is `startMonth + 1`).
    const servicedRow = JSON.parse(
      screen.getByTestId("perline-second-row").textContent || "{}",
    ) as Record<string, number>;
    expect(servicedRow["debt:loan-student"]).toBeGreaterThan(dollarsToCents(400));
    // And the budget lines are unchanged by its arrival.
    expect(servicedRow["line:housing"]).toBeGreaterThan(0);
  });

  it("swaps back to a plan-only scenario, clearing the prior seed timeline", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "student-loan" },
    });
    expect(screen.getAllByText("Remove")).toHaveLength(1);

    // The credit-card scenario carries no seed events — loading it clears the loan.
    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "living-on-credit" },
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Jordan");
    expect(screen.getByText(/No life events yet/)).toBeTruthy();
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

    // A budget edit rebuilds it more than once — the net-worth graph, plus the sweep the
    // retirement panel runs to find the feasible age — so only the fact of a rebuild is
    // asserted.
    fireEvent.change(screen.getByLabelText(/Savings return/), {
      target: { value: "5" },
    });
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  // The guard that overrides accumulate rather than replace lives in
  // `baseAdjustments/monthEdit.test.ts` (applyLineOverride).

  it("drives the whole projection from a line-item budget edit", () => {
    // Guards a regression: the panel once held the budget in its own state and projected
    // it separately, so raising spending past income moved its chart and nothing else.
    const spy = vi.spyOn(engine, "createProjectionBase");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    const housing = screen.getByRole("spinbutton", { name: /Housing/ });
    fireEvent.change(housing, { target: { value: "9000" } }); // far past the $5,000 income
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));

    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    const lastPlan = spy.mock.calls.at(-1)?.[0];
    expect(lastPlan?.budgetLines.find((l) => l.id === "housing")?.overrides).toHaveLength(1);
  });
});
