/**
 * @vitest-environment jsdom
 *
 * The Base + Adjustments budget editor: point at a month, change a number, answer "just
 * this month" or "from here forward". These tests drive the keyboard equivalent of the
 * chart click, since Recharts needs a real layout width jsdom lacks.
 *
 * The pay-change form this panel discloses is its own component, tested in
 * `payChangeEditor.test.tsx`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import {
  PRIMARY_PERSON_ID,
  Projection,
  dollarsToCents,
  healthcareMonthlyCents,
  type Job,
  type Ledger,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { useTestProjection, stateOf } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { setJobMonthlyIncome } from "../../testing/planFixtures";
import { BaseAdjustmentsPanel } from "./baseAdjustmentsPanel";
import { BudgetTooltip } from "./perLineBudgetChart";

afterEach(cleanup);

/** The event-free ledger in the public serialized shape — the app authors a timeline through
 * `Projection`, never by seeding the engine's internal `emptyLedger`. */
const NO_EVENTS: Ledger = { events: [], nextSequenceNumber: 0 };

const incomeReadonlyDollars = (): number =>
  Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));

const openOneOff = () =>
  fireEvent.click(screen.getByRole("button", { name: /Change pay at this month/i }));
const setOneOffKind = (value: string) =>
  fireEvent.change(screen.getByLabelText("Pay change kind"), { target: { value } });
const setOneOffAmount = (dollars: number) =>
  enterNumber(screen.getByRole("spinbutton", { name: /Amount/ }), dollars);
const applyOneOff = () => fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

/**
 * Stands in for `App`: holds the one `ProjectionState` the panel writes through, and runs the
 * app's ONE projection (plan *and* ledger) that every surface is fed from.
 */
function Harness({ initial, ledger: initialLedger = NO_EVENTS }: { initial: Plan; ledger?: Ledger }) {
  const { state, transact } = useTestProjection(initial, initialLedger);
  const plan = state.scenario.plan;
  const ledger = state.scenario.ledger;
  const projection = Projection.fromState(state, usJurisdiction);
  const { series, household } = projection.run(usJurisdiction);
  const personNames = new Map<string, string>([
    [PRIMARY_PERSON_ID, plan.primary.name],
    ...ledger.events.flatMap((e) =>
      e.type === "RelationshipEvent" ? ([[e.person.id, e.person.name]] as [string, string][]) : [],
    ),
  ]);
  return (
    <>
      <BaseAdjustmentsPanel
        plan={plan}
        transact={transact}
        series={series}
        personNames={personNames}
        household={household}
        ledger={ledger}
        projection={projection}
        plannedWorkStopAge={65}
      />
      <output data-testid="primary-jobs">{JSON.stringify(plan.primary.jobs)}</output>
      <output data-testid="partner-jobs">{JSON.stringify(partnerJobsOf(ledger))}</output>
    </>
  );
}

const renderPanel = (plan: Plan, ledger?: Ledger) =>
  render(<Harness initial={plan} ledger={ledger} />);

function partnerJobsOf(ledger: Ledger): readonly Job[] {
  for (const e of ledger.events) if (e.type === "RelationshipEvent") return e.person.jobs;
  return [];
}


const partnerWithJobLedger = (monthlyDollars: number): Ledger => ({
  events: [
    {
      id: "r1",
      sequenceNumber: 0,
      type: "RelationshipEvent",
      month: 0,
      person: {
        id: "p-1",
        name: "Sam",
        birthYear: START_YEAR - 40,
        lifeExpectancy: 85,
        benefitClaimingAge: 67,
        jobs: [
          {
            id: "p-1-job-1",
            name: "Sam's job",
            ownerId: "p-1",
            startYear: START_YEAR,
            endYear: START_YEAR - 40 + 65,
            salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), currentSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
          },
        ],
      },
    },
  ],
  nextSequenceNumber: 1,
});

const spin = (name: RegExp | string) =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

/** The keyboard equivalent of a chart click. */
const selectMonth = (month: number) =>
  enterNumber(spin("Month"), month);

/** Typing an amount stages the how-long question. */
const editRow = (name: RegExp | string, dollars: number) =>
  enterNumber(spin(name), dollars);

/**
 * A budget line's band key on the per-line graph. The engine mints every line id, so a test
 * finds the line by the label a reader sees and reads its key off the plan — never assuming the
 * id spells the label.
 */
const lineKey = (label: string, plan: Plan = PLAN_DEFAULTS): string =>
  `line:${plan.budgetLines.find((l) => l.label === label)!.id}`;


describe("BaseAdjustmentsPanel — Base", () => {
  it("prepopulates the base from the default template", () => {
    renderPanel(PLAN_DEFAULTS);
    expect(spin(/Housing/)).toBeTruthy();
    expect(spin(/Dining & fun/)).toBeTruthy();
  });

  it("opens pointed at month 0 with each line at its base amount", () => {
    renderPanel(PLAN_DEFAULTS);
    expect(screen.getByTestId("selected-month").textContent).toMatch(/month 0/);
    expect(Number(spin(/Housing/).value)).toBe(1600);
  });

  it("shows the standing income as a read-only total at the opening month, not $0", () => {
    // Month 0 is the flow-free opening snapshot, so `incomeByMonth[0]` is $0 despite a
    // full salary — the row reads the standing rate (month 1) instead.
    renderPanel(PLAN_DEFAULTS);
    expect(screen.getByTestId("selected-month").textContent).toMatch(/month 0/);
    expect(incomeReadonlyDollars()).toBe(5000);
    // Standing pay is edited in Jobs, not here.
    expect(screen.queryByRole("spinbutton", { name: /^Income$/ })).toBeNull();
  });

  it("grows every row with inflation as you move along the budget", () => {
    renderPanel(PLAN_DEFAULTS);
    const today = Number(spin(/Housing/).value);
    selectMonth(360);
    const inThirtyYears = Number(spin(/Housing/).value);
    expect(inThirtyYears).toBeGreaterThan(today * 2); // 3% over 30y ≈ ×2.4
    selectMonth(0);
    expect(Number(spin(/Housing/).value)).toBe(today);
  });

  it("shows income stopping at retirement and the benefit picking up at the claiming age", () => {
    renderPanel(PLAN_DEFAULTS);
    const monthAtAge = (age: number) =>
      (age - (START_YEAR - PLAN_DEFAULTS.primary.birthYear)) * 12;

    selectMonth(monthAtAge(60)); // still working
    const working = incomeReadonlyDollars();
    expect(working).toBeGreaterThan(0);

    selectMonth(monthAtAge(66)); // retired at 65, benefit not claimed until 67
    expect(incomeReadonlyDollars()).toBe(0);

    selectMonth(monthAtAge(70)); // benefit is being paid
    const benefit = incomeReadonlyDollars();
    expect(benefit).toBeGreaterThan(0);
    expect(benefit).toBeLessThan(working); // a benefit, not a salary that kept growing
  });

  it("graphs cash flows by source, and flags the retirement gap as a savings drawdown", () => {
    renderPanel(PLAN_DEFAULTS);
    const firstRow = JSON.parse(
      screen.getByTestId("income-first-row").textContent || "{}",
    ) as Record<string, number>;
    expect(Object.values(firstRow).some((v) => v > 0)).toBe(true);
    // Retires at 65, claims at 67 — that stretch is named a drawdown, not a flat zero.
    expect(screen.getByTestId("income-summary").textContent).toMatch(/living off savings/i);
  });

  it("counts income authored on the timeline — a partner's own jobs", () => {
    // Regression: the panel used to run its OWN plan-only projection, whose ledger is empty, so
    // a partner's $2,000/mo job moved the net-worth chart while the income graph below showed
    // only the primary's $5,000.
    renderPanel(PLAN_DEFAULTS, partnerWithJobLedger(2000));

    // Month 6: the partner has joined (month 0) and no CPI step has landed yet, so both
    // salaries still read at their authored rate.
    selectMonth(6);
    expect(incomeReadonlyDollars()).toBe(7000); // $5,000 primary + $2,000 partner

    // And the partner's job is its own band, not folded into the primary's wages.
    const bands = JSON.parse(screen.getByTestId("income-bands").textContent || "[]") as string[];
    expect(bands).toContain("Income · Sam's job");
  });

  it("defaults to the Simple income view and reveals every source under Advanced", () => {
    renderPanel(PLAN_DEFAULTS);
    const bands = (): string[] =>
      JSON.parse(screen.getByTestId("income-bands").textContent || "[]") as string[];

    expect(bands()).toContain("Social Security");
    expect(bands()).toContain("Living off savings");
    // The precise engine labels are hidden in Simple — they belong to Advanced.
    expect(bands()).not.toContain("Government benefit");
    expect(bands()).not.toContain("Savings drawdown");

    fireEvent.click(screen.getByRole("radio", { name: /Advanced/i }));
    expect(bands()).toContain("Government benefit");
    expect(bands()).toContain("Savings drawdown");
    expect(bands()).not.toContain("Living off savings");
    expect(bands()).not.toContain("Social Security");
  });

  it("draws take-home cash flows by default and switches to gross on the toggle", () => {
    // Take-home is the honest read against the spending-need line: cash after tax and deferral.
    renderPanel(PLAN_DEFAULTS);
    const cashFlowTotal = () =>
      Object.values(
        JSON.parse(screen.getByTestId("income-first-row").textContent || "{}") as Record<string, number>,
      ).reduce((s, v) => s + v, 0);
    const takeHome = cashFlowTotal();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show gross cash flows/i }));
    const gross = cashFlowTotal();
    expect(gross).toBeGreaterThan(takeHome); // gross adds back the wage tax
  });

  it("rebalances to 50/30/20 non-destructively — named lines survive, savings is seeded", () => {
    renderPanel(PLAN_DEFAULTS);
    expect(spin(/Housing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Quickstart/i }));
    // Still a named line after: the budget was rebalanced, not replaced by 3 buckets.
    expect(spin(/Housing/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: /Needs \(50%\)/ })).toBeNull();
    // A real savings contribution line is seeded for the empty savings tier.
    expect(screen.getByLabelText(/Delete Savings/i)).toBeTruthy();
  });
});

describe("BaseAdjustmentsPanel — editing a point on the budget", () => {
  it("asks how long a change lasts instead of applying it immediately", () => {
    renderPanel(PLAN_DEFAULTS);
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    selectMonth(14);
    editRow(/Housing/, 2400);
    const prompt = screen.getByTestId("scope-prompt").textContent ?? "";
    expect(prompt).toMatch(/Housing/);
    expect(prompt).toMatch(/month 14/);
    expect(screen.getByRole("button", { name: /Just this month/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /From here forward/i })).toBeTruthy();
  });

  it("shows what the user typed, before the change is committed", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(103);
    editRow(/Housing/, 2400);
    // The field must hold the typed value while the how-long question is open. It used to snap
    // back on every keystroke, so a backspace on "1600" left the box reading 1600 while staging
    // an edit to $160.
    expect(Number(spin(/Housing/).value)).toBe(2400);
    // The prompt's figures are that month's dollars, not today's — the row inflates.
    expect(screen.getByTestId("scope-prompt").textContent).toMatch(/→ \$2,400/);
  });

  it("keeps typing reactive across successive keystrokes", () => {
    renderPanel(PLAN_DEFAULTS);
    // The backspace-on-1600 sequence from the bug report.
    editRow(/Housing/, 160);
    expect(Number(spin(/Housing/).value)).toBe(160);
    editRow(/Housing/, 16);
    expect(Number(spin(/Housing/).value)).toBe(16);
    editRow(/Housing/, 1650);
    expect(Number(spin(/Housing/).value)).toBe(1650);
    expect(screen.getByTestId("scope-prompt").textContent).toMatch(/\$1,600 → \$1,650/);
  });

  it("drops a staged edit when the user moves to a different month", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(40);
    const untouchedAt40 = Number(spin(/Housing/).value);
    selectMonth(14);
    editRow(/Housing/, 2400);
    selectMonth(40);
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    expect(Number(spin(/Housing/).value)).toBe(untouchedAt40);
  });

  it("clears the prompt when the user types back to the original amount", () => {
    renderPanel(PLAN_DEFAULTS);
    editRow(/Housing/, 2400);
    editRow(/Housing/, 1600);
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    expect(Number(spin(/Housing/).value)).toBe(1600);
  });

  it("routes 'from here forward' to a dated override that carries to later months", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(13);
    const beforeEdit = Number(spin(/Housing/).value);
    selectMonth(14);
    editRow(/Housing/, 2400);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/dated override/i);
    // Typed at month 14, so month 14 charges exactly that — no inflation jump on commit.
    expect(Number(spin(/Housing/).value)).toBe(2400);
    // Later months carry the change and keep growing with prices from there.
    selectMonth(200);
    expect(Number(spin(/Housing/).value)).toBeGreaterThan(2400);
    selectMonth(13);
    expect(Number(spin(/Housing/).value)).toBe(beforeEdit);
  });

  it("routes 'just this month' to a single-month override that does not carry forward", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(15);
    const untouchedAt15 = Number(spin(/Housing/).value);
    selectMonth(14);
    editRow(/Housing/, 3000);
    fireEvent.click(screen.getByRole("button", { name: /Just this month/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/one-month override/i);
    expect(Number(spin(/Housing/).value)).toBe(3000);
    selectMonth(15);
    expect(Number(spin(/Housing/).value)).toBe(untouchedAt15);
  });

  it("names the edited row the way the row itself is labelled, not by its internal id", () => {
    // The route carries the line's authoring id ("dining"); echoing that back contradicts
    // the row above it, which reads "Dining & fun".
    renderPanel(PLAN_DEFAULTS);
    selectMonth(14);
    editRow(/Dining/, 700);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    const echo = screen.getByTestId("adjustment-route").textContent ?? "";
    expect(echo).toContain('"Dining & fun"');
    expect(echo).not.toContain('"dining"');
  });

  it("marks a row the user has already adjusted", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(14);
    editRow(/Housing/, 2400);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    expect(screen.getByText("adjusted")).toBeTruthy();
  });

  it("cancels a staged edit without changing the budget", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(14);
    const before = Number(spin(/Housing/).value);
    editRow(/Housing/, 2400);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    expect(screen.queryByTestId("adjustment-route")).toBeNull();
    expect(Number(spin(/Housing/).value)).toBe(before);
  });

  it("applies a one-off bonus on top of the selected month's pay, taxed through the sim", () => {
    // A bonus is a per-job JobIncomeOverride taxed as wages, so the projection moves, not just
    // the label.
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6); // year 0, base $5,000/mo
    expect(incomeReadonlyDollars()).toBe(5000);
    openOneOff();
    setOneOffAmount(2000); // default kind is "bonus (add on top)"
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/bonus of \$2,000/i);
    expect(incomeReadonlyDollars()).toBe(7000); // 5,000 base + 2,000 bonus
  });

  it("stacks the monthly-tax chart by job, matching the income chart", () => {
    // The US jurisdiction reports tax per category and the engine splits it to the job that bore
    // it, so each job draws its own wage-tax band and the split's Σ equals the row total.
    renderPanel(PLAN_DEFAULTS);
    const bands = JSON.parse(screen.getByTestId("tax-bands").textContent || "[]") as string[];
    // Named after its owner, not its minted id: an untitled job reads "Alex's job".
    expect(bands).toContain("Income · Alex's job");
    const firstRow = JSON.parse(screen.getByTestId("tax-first-row").textContent || "{}");
    const banded = Object.entries(firstRow.centsBySource as Record<string, number>).reduce(
      (s, [, c]) => s + c,
      0,
    );
    expect(banded).toBe(firstRow.taxCents as number);
  });

  it("sets pay to $0 for one month (a missed paycheck), taxed on $0 wages that month", () => {
    // There is no dedicated "missed paycheck" kind: a missed month is "Set pay this month" to
    // $0. It must zero BOTH the income and the wage tax — you are not taxed on a paycheck you
    // did not receive.
    renderPanel(PLAN_DEFAULTS);
    const firstRowTax = () =>
      (JSON.parse(screen.getByTestId("tax-first-row").textContent || "{}").taxCents as number) ?? 0;
    // Month 0 — the first processed month — normally pays $5,000 of wages and is taxed on them.
    expect(firstRowTax()).toBeGreaterThan(0);

    selectMonth(0);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(0); // the missed-paycheck case
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/pay set to \$0/i);
    expect(incomeReadonlyDollars()).toBe(0);
    // Taxed on $0 wages, not the full salary.
    expect(firstRowTax()).toBe(0);
    // The override is a single month, so the next one is untouched.
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(5000);
  });

  it("sets an absolute one-month pay figure", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(9000);
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(9000);
  });

  it("applies a permanent pay change that holds from the selected month forward", () => {
    // A permanent change rides a JobPayChange, so unlike "set pay this month" the next month
    // changes too, while the month before is untouched.
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);
    expect(incomeReadonlyDollars()).toBe(5000);
    openOneOff();
    setOneOffKind("setOngoing"); // "Set new pay" — the ongoing figure, up OR down
    setOneOffAmount(8000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/pay set to \$8,000/i);
    expect(incomeReadonlyDollars()).toBe(8000);
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(8000); // PERSISTS (not a one-month change)
    selectMonth(5);
    expect(incomeReadonlyDollars()).toBe(5000); // before the change: old pay
  });

  it("changes pay by a delta from the selected month forward", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);
    openOneOff();
    setOneOffKind("changeOngoing"); // "Change pay by (+/−)"
    setOneOffAmount(1500);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/pay changed by \$1,500/i);
    expect(incomeReadonlyDollars()).toBe(6500); // 5,000 + 1,500, ongoing
    selectMonth(12);
    expect(incomeReadonlyDollars()).toBe(6500);
  });
});


describe("BaseAdjustmentsPanel — add / edit / delete budget items", () => {
  const openAdd = () => fireEvent.click(screen.getByRole("button", { name: /Add a budget item/i }));
  const setName = (name: string) =>
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  const setType = (v: string) =>
    fireEvent.change(screen.getByLabelText("Item type"), { target: { value: v } });
  const setAmount = (dollars: number) =>
    enterNumber(screen.getByRole("spinbutton", { name: /Monthly amount/ }), dollars);
  const submitAdd = () => fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

  it("adds a named expense line", () => {
    renderPanel(PLAN_DEFAULTS);
    openAdd();
    setName("Pet care");
    setAmount(120);
    submitAdd();
    expect(spin(/Pet care/)).toBeTruthy();
  });

  it("toggling item type keeps name & amount and never mixes expense/contribution fields", () => {
    // The form's draft is a discriminated union, so only ONE kind's extra field exists: expense
    // shows Category, contribution shows Into account, and switching rebuilds that arm while
    // carrying name and amount over.
    renderPanel(PLAN_DEFAULTS);
    openAdd();
    setName("Flex");
    setAmount(300);

    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.queryByLabelText("Into account")).toBeNull();

    setType("contribution");
    expect(screen.getByLabelText("Into account")).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();

    setType("expense");
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.queryByLabelText("Into account")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Flex");
    expect(
      Number((screen.getByRole("spinbutton", { name: /Monthly amount/ }) as HTMLInputElement).value),
    ).toBe(300);

    // Submits as a plain expense: an editable spending spinbutton, where a contribution would
    // render read-only under Savings & contributions.
    submitAdd();
    expect(spin(/Flex/)).toBeTruthy();
    expect(screen.getByText(/No recurring contributions yet/i)).toBeTruthy();
  });

  it("adds a contribution line into an account, shown under Savings & contributions", () => {
    renderPanel(PLAN_DEFAULTS);
    expect(screen.getByText(/No recurring contributions yet/i)).toBeTruthy();
    openAdd();
    setName("Auto-invest");
    setType("contribution"); // reveals the account picker; forces savings tier
    setAmount(500);
    submitAdd();
    // A contribution row with its destination, not an editable spending row.
    const row = screen.getByText("Auto-invest").closest("div")!;
    expect(row.textContent).toMatch(/Brokerage/);
    expect(screen.getByLabelText(/Delete Auto-invest/i)).toBeTruthy();
  });

  it("renames a line in place via its edit form", () => {
    renderPanel(PLAN_DEFAULTS);
    fireEvent.click(screen.getByRole("button", { name: /Edit Housing/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rent" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(spin(/Rent/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: /Housing/ })).toBeNull();
  });

  it("keeps one disclosed form at a time, across spending AND contributions", () => {
    // The two lists are separate components, so the panel arbitrates the rule between them.
    const withContribution: Plan = {
      ...PLAN_DEFAULTS,
      budgetLines: [
        ...PLAN_DEFAULTS.budgetLines,
        {
          id: "save",
          label: "Savings",
          target: { kind: "account", accountId: "brokerage", taxTreatment: "postTax" },
          amountSource: { kind: "literal", monthlyCents: dollarsToCents(400) },
          category: "savings",
        },
      ],
    };
    renderPanel(withContribution);

    fireEvent.click(screen.getByRole("button", { name: /Edit Housing/i }));
    expect(screen.getByLabelText("Name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Edit Savings/i }));
    // Exactly one form open — the contribution's, not both.
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Savings");
  });

  it("renders a plan that authors no budget lines at all", () => {
    // An empty `budgetLines` is the deliberate spends-nothing plan, not a missing field: the
    // panel opens on it as an editable blank budget rather than erroring.
    renderPanel({ ...PLAN_DEFAULTS, budgetLines: [] });
    expect(screen.getByText(/No recurring contributions yet/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: /Housing/ })).toBeNull();
  });

  it("deletes a line", () => {
    renderPanel(PLAN_DEFAULTS);
    expect(spin(/Subscriptions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Delete Subscriptions/i }));
    expect(screen.queryByRole("spinbutton", { name: /Subscriptions/ })).toBeNull();
  });
});

describe("BaseAdjustmentsPanel — renders every obligation the month incurs", () => {
  it("edits health care in place, like every other recurring expense", () => {
    renderPanel(PLAN_DEFAULTS);
    // Health is a `healthcare`-category budget line, so it gets an amount input here and no
    // link away — the plan holds no health figure to send the user back to.
    expect(spin(/Healthcare/).value).toBe("700");
    expect(screen.queryByRole("link", { name: /Edit on the plan/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Edit Healthcare/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete Healthcare/i })).toBeTruthy();
  });

  it("routes a health edit through the same 'from here forward' gesture as any line", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(24);
    editRow(/Healthcare/, 900);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    // The override lands on the line and holds from that month on, so the later month reads
    // the new amount grown rather than the old one.
    selectMonth(36);
    expect(Number(spin(/Healthcare/).value)).toBeGreaterThan(890);
    // …and the months before it are untouched.
    selectMonth(12);
    expect(Number(spin(/Healthcare/).value)).toBeLessThan(800);
  });

  it("bands a loan payment read-only beside the editable budget lines, linking to the loan", () => {
    const projection = Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);
    projection.takeLoan({
      month: 0,
      ownerId: PRIMARY_PERSON_ID,
      openingBalanceCents: dollarsToCents(45_000),
      apr: 0.06,
      kind: "studentLoan",
      termMonths: 120,
    });
    const { series, household } = projection.run(usJurisdiction);
    render(
      <BaseAdjustmentsPanel
        plan={PLAN_DEFAULTS}
        transact={() => undefined}
        series={series}
        personNames={new Map()}
        household={household}
        ledger={NO_EVENTS}
        projection={projection}
        plannedWorkStopAge={65}
      />,
    );
    // Month 1 is the first serviced month (origination at month 0 charges nothing).
    selectMonth(1);
    // The user's own lines stay editable; the loan payment does not.
    expect(spin(/Housing/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: /loan payment/i })).toBeNull();
    expect(screen.getByRole("link", { name: /Change the loan/i })).toBeTruthy();
  });
});

describe("BaseAdjustmentsPanel — Funded by", () => {
  it("names an account-funded source by its authored label, not its internal id", () => {
    // Income far below the template budget forces a draw on the cash-savings account to cover
    // the gap, so month 0's "Funded by" section names an "account" source: `savings`, whose
    // authored label is "Cash savings" (see `SAVINGS_ID`/`SAVINGS_LABEL` in `projectionBase.ts`).
    const cashFundedPlan: Plan = {
      ...setJobMonthlyIncome(PLAN_DEFAULTS, PLAN_DEFAULTS.primary.jobs[0]!.id, dollarsToCents(1_500)),
      openingBalanceCents: dollarsToCents(50_000),
      goals: [],
    };
    renderPanel(cashFundedPlan);
    const funded = screen.getByText("Funded by").closest("section");
    if (funded === null) throw new Error("expected a 'Funded by' section");
    expect(funded.textContent).toContain("Cash savings");
    // The internal account id must never leak through as a source label once a plan label
    // resolves it — this is the wiring `BaseAdjustmentsPanel` supplies via `accountDescriptors()`.
    expect(within(funded).queryByText("savings")).toBeNull();
  });
});

describe("BaseAdjustmentsPanel — long-horizon points", () => {
  it("labels a far-future point by calendar year and age, not just a month index", () => {
    renderPanel(PLAN_DEFAULTS);
    // 15 years out for a 35-year-old = month 180 = age 50.
    selectMonth(180);
    const label = screen.getByTestId("selected-month").textContent ?? "";
    expect(label).toMatch(/month 180/);
    expect(label).toMatch(/age 50/);
  });
});

describe("BaseAdjustmentsPanel — per-line graph", () => {
  const brokePlan: Plan = {
    // $1,500/mo income, far below the ~$3,000 template budget.
    ...setJobMonthlyIncome(PLAN_DEFAULTS, PLAN_DEFAULTS.primary.jobs[0]!.id, dollarsToCents(1_500)),
    openingBalanceCents: 0,
    goals: [],
  };

  it("says the plan stops being financeable, without prescribing what to cut", () => {
    renderPanel(brokePlan);
    const summary = screen.getByTestId("perline-summary").textContent ?? "";
    expect(summary).toMatch(/no longer financeable/i);
    // It must NOT name a line to give up — dropping the user's wants is their call.
    expect(summary).not.toMatch(/Subscriptions|Dining|starv/i);
  });

  it("keeps every line at full amount in the graph even when the plan breaks", () => {
    renderPanel(brokePlan);
    const firstRow = JSON.parse(
      screen.getByTestId("perline-first-row").textContent || "{}",
    ) as Record<string, number>;
    expect(Object.values(firstRow).every((v) => v > 0)).toBe(true);
  });

  it("reports a comfortable budget as financed throughout", () => {
    const withIncome = setJobMonthlyIncome(
      PLAN_DEFAULTS,
      PLAN_DEFAULTS.primary.jobs[0]!.id,
      dollarsToCents(8_000),
    );
    const richPlan: Plan = {
      ...withIncome,
      primary: { ...withIncome.primary, lifeExpectancy: 40 },
      goals: [],
    };
    renderPanel(richPlan);
    expect(screen.getByTestId("perline-summary").textContent).toMatch(/financed across/i);
  });

  it("bands health care as one of the budget lines, keyed like any other", () => {
    // Health is an authored line now, so it bands under the same `line:<id>` key Housing does
    // — not the standalone "health" key it used when the plan compiled it as its own series.
    renderPanel(PLAN_DEFAULTS);
    const firstRow = JSON.parse(
      screen.getByTestId("perline-first-row").textContent || "{}",
    ) as Record<string, number>;
    expect(firstRow[lineKey("Housing")]).toBeGreaterThan(0);
    expect(firstRow[lineKey("Healthcare")]).toBe(healthcareMonthlyCents(PLAN_DEFAULTS.budgetLines));
    expect(firstRow["health"]).toBeUndefined();
  });

  it("bands a liability's payment from the timeline, with no extra props", () => {
    const projection = Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);
    const loanId = projection.takeLoan({
      month: 0,
      ownerId: PRIMARY_PERSON_ID,
      openingBalanceCents: dollarsToCents(45_000),
      apr: 0.06,
      kind: "studentLoan",
      termMonths: 120,
    });
    // Rendered bare, no Harness: the panel's job-owner props are the roster it authors pay
    // changes against, and this test authors none.
    const { series, household } = projection.run(usJurisdiction);
    render(
      <BaseAdjustmentsPanel
        plan={PLAN_DEFAULTS}
        transact={() => undefined}
        series={series}
        personNames={new Map()}
        household={household}
        ledger={NO_EVENTS}
        projection={projection}
        plannedWorkStopAge={65}
      />,
    );

    // The SECOND row: the loan is authored at month 0, which ORIGINATES it — a schedule's
    // index 0 is `startMonth + 1`, so month 1 is the first month it is serviced.
    const servicedRow = JSON.parse(
      screen.getByTestId("perline-second-row").textContent || "{}",
    ) as Record<string, number>;
    // Servicing the loan is spending, banded like anything else the month costs, and the budget
    // lines beside it are untouched by its arrival.
    expect(servicedRow[`debt:${loanId}`]).toBeGreaterThan(dollarsToCents(400));
    expect(servicedRow[lineKey("Housing")]).toBeGreaterThan(0);
    // Origination month itself: the debt exists but nothing is due yet.
    const firstRow = JSON.parse(
      screen.getByTestId("perline-first-row").textContent || "{}",
    ) as Record<string, number>;
    expect(firstRow[`debt:${loanId}`] ?? 0).toBe(0);
  });

  it("redraws when the budget changes — the memoized graphs must not go stale", () => {
    // The graphs skip re-rendering while only the staged edit moves, but a committed edit
    // changes the projection and they must follow.
    renderPanel(PLAN_DEFAULTS);
    const housingBand = () =>
      (
        JSON.parse(screen.getByTestId("perline-first-row").textContent || "{}") as Record<
          string,
          number
        >
      )[lineKey("Housing")];
    const before = housingBand();

    editRow(/Housing/, 2_400);
    expect(housingBand()).toBe(before); // staging alone changes no projection
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    expect(housingBand()).toBeGreaterThan(before); // committing does
  });

  it("adds the stack up for the reader: the hover readout carries the month's total", () => {
    // Recharts owns the hover and needs a layout jsdom lacks, so the readout is driven directly
    // with the payload Recharts would hand it.
    render(
      <BudgetTooltip
        active
        label={12}
        payload={[
          { name: "Housing", value: dollarsToCents(1_600), color: "#000" },
          { name: "Groceries", value: dollarsToCents(700), color: "#000" },
        ]}
      />,
    );
    expect(screen.getByText(/Housing : \$1,600/)).toBeTruthy();
    expect(screen.getByText(/Total : \$2,300/)).toBeTruthy();
  });

  it("leaves a band costing nothing this month out of the hover readout", () => {
    // A dormant line draws no height in the stack, so a "$0" row is noise. A paid-off loan is
    // absent from the month's obligations entirely and arrives as an undefined value — same rule.
    render(
      <BudgetTooltip
        active
        label={12}
        payload={[
          { name: "Housing", value: dollarsToCents(1_600), color: "#000" },
          { name: "Dining & fun", value: 0, color: "#000" },
          { name: "Mortgage payment", color: "#000" },
        ]}
      />,
    );
    expect(screen.getByText(/Housing : \$1,600/)).toBeTruthy();
    expect(screen.queryByText(/Dining & fun/)).toBeNull();
    expect(screen.queryByText(/Mortgage payment/)).toBeNull();
    expect(screen.getByText(/Total : \$1,600/)).toBeTruthy();
  });

  it("draws no hover readout for a month that costs nothing at all", () => {
    const { container } = render(
      <BudgetTooltip active label={12} payload={[{ name: "Housing", value: 0, color: "#000" }]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("draws no hover readout when nothing is hovered", () => {
    const { container } = render(<BudgetTooltip payload={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
