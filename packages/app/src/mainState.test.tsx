/**
 * @vitest-environment jsdom
 *
 * Behavioral coverage for App's plan state: value editing and the event ledger.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { enterNumber } from "./testing/numberField";
import { App } from "./main";
import * as engine from "@finley/engine";
import { dollarsToCents } from "@finley/engine";
import { presetById, presetState } from "./presets";

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
  it("no longer offers 'Added an expense' — recurring spend lives in Base + Adjustments", () => {
    render(<App />);
    const menu = screen.getByLabelText("What happened?");
    const labels = within(menu).getAllByRole("option").map((o) => o.textContent);
    expect(labels).not.toContain("Added an expense");
  });

  it("adds an event, reprojecting the single state through the facade", () => {
    // The app holds one `ProjectionState` and reads it through a `Projection` rebuilt on every
    // state change (`fromState`, which every write also routes through). A ledger edit changes
    // that state, so it reprojects — the base is no longer memoized apart from the ledger, as it
    // was on the low-level pipeline.
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    fireEvent.click(screen.getByText("Add event"));

    // The default "Took out a loan" event has one timeline marker (one Remove).
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(screen.queryByText(/No life events yet/)).toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
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
    enterNumber(screen.getByRole("spinbutton", { name: /Monthly salary/i }), "2000");
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.click(screen.getByText("Add event"));

    // (a) The Jobs panel lists it, owned by the partner, alongside the primary's.
    const row = screen.getByLabelText("Partner · Job 1");
    // The headline, not the chart's axis label — both quote the same figure.
    expect(within(row).getByTitle(/Current pay/).textContent).toBe("$2,000/mo");
    expect(screen.getByLabelText("Alex · Job 1")).toBeTruthy();

    // (b) The income-vs-spend surface counts it: $5,000 + $2,000 at a month before the
    // first CPI step.
    const selectBudgetMonth = (month: number) =>
      enterNumber(screen.getByRole("spinbutton", { name: "Month" }), month);
    const incomeDollars = () =>
      Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));
    selectBudgetMonth(6);
    expect(incomeDollars()).toBe(7000);

    // (c) Editing the partner's pay revises the RelationshipEvent in place.
    fireEvent.click(screen.getByRole("button", { name: /Edit Partner · Job 1/i }));
    enterNumber(screen.getByRole("spinbutton", { name: /Monthly salary/i }), "3000");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(
      within(screen.getByLabelText("Partner · Job 1")).getByTitle(/Current pay/).textContent,
    ).toBe("$3,000/mo");
    // Still ONE marker — revised in place, not removed and re-added. (Match "Remove"
    // exactly; the join form's job list has a "Remove job 1" button.)
    expect(screen.getAllByRole("button", { name: /^Remove$/ })).toHaveLength(1);
    expect(incomeDollars()).toBe(8000);
  });

  it("edits an authored partner from the timeline, revising the event in place", () => {
    render(<App />);

    // Author a partner joining now, unnamed (records as "Partner").
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "0" } });
    fireEvent.click(screen.getByText("Add event"));
    expect(screen.getByText("Partner joins the household")).toBeTruthy();

    // The timeline marker offers Edit beside Remove; opening it pre-fills the join form.
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    const nameField = screen.getByPlaceholderText(/Partner's name/i) as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    // Revised in place: one marker still, now naming Sam — not removed and re-added.
    expect(screen.getByText("Sam joins the household")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove$/ })).toHaveLength(1);
    // The edit surface closed on success, so the add form's type picker is back.
    expect(screen.getByLabelText("What happened?")).toBeTruthy();
  });

  it("closes the edit surface on Cancel without revising", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.click(screen.getByText("Add event"));

    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    fireEvent.change(screen.getByPlaceholderText(/Partner's name/i), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    // Abandoned: still the original unnamed partner, and the add form is back.
    expect(screen.getByText("Partner joins the household")).toBeTruthy();
    expect(screen.getByLabelText("What happened?")).toBeTruthy();
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

    // Riley's $3,000 budget — health among its lines now, not a plan field beside it — PLUS
    // the seed loan's scheduled payment (~$500/mo on $45k at 6% over 10 years): the Base
    // panel charts the whole scenario, not the bare plan.
    const riley = presetState(presetById("student-loan")).scenario.plan;
    const rileyBudget = riley.budgetLines.reduce(
      (sum, l) =>
        sum + (l.target.kind === "expense" && l.amountSource.kind === "literal" ? l.amountSource.monthlyCents : 0),
      0,
    );
    expect(spendingNeed()).toBeGreaterThan(rileyBudget + dollarsToCents(400));
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
    // Both band keys come off the built scenario: the engine minted the loan's liability id and
    // every budget line id, so the chart's series names are read, never assumed.
    const riley = presetState(presetById("student-loan")).scenario;
    const loan = riley.ledger.events.find((e) => e.type === "LoanEvent");
    const housing = riley.plan.budgetLines.find((l) => l.label === "Housing");
    expect(servicedRow[`debt:${loan!.id}`]).toBeGreaterThan(dollarsToCents(400));
    // And the budget lines are unchanged by its arrival.
    expect(servicedRow[`line:${housing!.id}`]).toBeGreaterThan(0);
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

describe("App — retirement chart preview", () => {
  const incomeDollars = () =>
    Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));

  it("swaps the income chart to the stop-working preview, and back", () => {
    render(<App />);

    // Age 70 (month 420): the authored default plan retires the primary at 65, so no wages; the
    // solved headline age (76) keeps them working, so previewing adds those wages back.
    enterNumber(screen.getByRole("spinbutton", { name: "Month" }), "420");
    const authored = incomeDollars();

    const toggle = () => screen.getByRole("checkbox", { name: /Preview the charts/ });
    fireEvent.click(toggle());
    expect(incomeDollars()).toBeGreaterThan(authored);

    // Turning the preview off restores the authored figure — the toggle changed no plan data.
    fireEvent.click(toggle());
    expect(incomeDollars()).toBe(authored);
  });

  it("does not run the stop-working preview projection until the toggle is on", () => {
    // The preview is a second full projection — ordinary plan edits (and the initial render)
    // must not pay for it while nobody has asked to see it. Only flipping the toggle should.
    const spy = vi.spyOn(engine.Projection.prototype, "runAtStopWorkingAge");
    render(<App />);
    expect(spy).not.toHaveBeenCalled();

    // A plan edit reprojects the authored run and re-renders the preview memo's dependencies,
    // but must not trigger the extra simulation while the toggle is still off.
    fireEvent.change(screen.getByLabelText(/Savings return/), { target: { value: "5" } });
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Preview the charts/ }));
    expect(spy).toHaveBeenCalledTimes(1);

    // Toggling off and back on is a legitimate reason to run it again — nothing here asserts
    // it's called only once ever, only that it's never called for free.
    fireEvent.click(screen.getByRole("checkbox", { name: /Preview the charts/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Preview the charts/ }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("names the primary, not a shared simultaneous age for everyone, once a differently-aged partner joins", () => {
    // `runAtStopWorkingAge` reads the headline age as the PRIMARY's own age and applies the
    // resulting calendar boundary household-wide — a partner authored at a different age
    // reaches that same month at a different personal age, and their own job could already
    // have ended before it (the boundary only caps a partner's job, never extends it out to
    // meet the primary's). A partner joining at 25, sixty years apart from the solved headline
    // age, would make "everyone stopped working at/when <headlineAge>" a specific, checkable
    // lie about the partner if the copy still claimed a shared moment.
    render(<App />);
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "RelationshipEvent" },
    });
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Their age in/), { target: { value: "25" } });
    fireEvent.click(screen.getByText("Add event"));

    // Still feasible with the partner added — the toggle is there to read.
    const toggleText = screen.getByRole("checkbox", { name: /Preview the charts/ }).closest("label")
      ?.textContent;
    // "by the time Alex turns <age>" — a cap everyone is guaranteed to be under, never a claim
    // that the whole household (partner included) reaches that age together.
    expect(toggleText).toMatch(/by the time Alex turns \d+/);
    expect(toggleText).not.toMatch(/everyone stopped working (at|when)\s*\d/i);
  });
});

describe("App — budget edits", () => {
  it("reprojects on a budget edit but not on scrub", () => {
    // The read handle is memoized on the state object, so scrubbing (which touches only the
    // cursor, never the state) reprojects nothing, while a plan edit produces a new state and
    // rebuilds it. `fromState` is where each rebuild goes in.
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    // Scrubbing the timeline changes no state, so nothing reprojects.
    fireEvent.change(screen.getByLabelText(/Scrub to a month/), {
      target: { value: "120" },
    });
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    // Typing in a number field is not yet an edit — it reprojects when the field COMMITS.
    fireEvent.change(screen.getByLabelText(/Savings return/), { target: { value: "5" } });
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    // Committed, it produces a new state, so the read handle rebuilds.
    fireEvent.blur(screen.getByLabelText(/Savings return/));
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  // The guard that overrides accumulate rather than replace lives in
  // `baseAdjustments/monthEdit.test.ts` (applyLineOverride).

  it("drives the whole projection from a line-item budget edit", () => {
    // Guards a regression: the panel once held the budget in its own state and projected
    // it separately, so raising spending past income moved its chart and nothing else. The
    // edited plan must reach the single state the whole app projects — read here off the state
    // the read handle is rebuilt from.
    const spy = vi.spyOn(engine.Projection, "fromState");
    render(<App />);
    const callsAfterMount = spy.mock.calls.length;

    const housing = screen.getByRole("spinbutton", { name: /Housing/ });
    enterNumber(housing, 9000); // far past the $5,000 income
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));

    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    const lastState = spy.mock.calls.at(-1)?.[0];
    // Found by the label the user edited — the line's id is the engine's, not "housing".
    expect(
      lastState?.scenario.plan.budgetLines.find((l) => l.label === "Housing")?.overrides,
    ).toHaveLength(1);
  });
});
