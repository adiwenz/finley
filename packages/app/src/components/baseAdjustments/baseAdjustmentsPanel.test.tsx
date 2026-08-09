/**
 * @vitest-environment jsdom
 *
 * The Base + Adjustments budget editor: point at a month, change a number, answer "just
 * this month" or "from here forward". These tests drive the keyboard equivalent of the
 * chart click, since Recharts needs a real layout width jsdom lacks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import {
  PRIMARY_PERSON_ID,
  Projection,
  dollarsToCents,
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

const jobsOn = (testId: "primary-jobs" | "partner-jobs"): readonly Job[] =>
  JSON.parse(screen.getByTestId(testId).textContent || "[]") as Job[];

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
});

describe("PayChangeEditor — every earner's jobs, not just the primary person's", () => {
  // A partner's jobs ride the RelationshipEvent they joined with, not `Plan.jobs`. The control
  // once listed only the plan's jobs, so a partner's pay change had nowhere to land.
  const pickJob = (id: string) =>
    fireEvent.change(screen.getByLabelText("Job"), { target: { value: id } });

  /** Alex ($5,000/mo on the plan) and Sam ($3,000/mo on their own event). */
  const withPartner = () => renderPanel(PLAN_DEFAULTS, partnerWithJobLedger(3000));

  it("offers both members' jobs, each named by its owner", () => {
    withPartner();
    openOneOff();
    const options = Array.from(
      (screen.getByLabelText("Job") as HTMLSelectElement).options,
      (o) => o.text,
    );
    // Owner-qualified, so two jobs carrying the same title are still told apart.
    expect(options).toEqual(["Alex · Job 1", "Sam · Sam's job"]);
  });

  it("gives a partner's job a permanent raise, written back to their event", () => {
    withPartner();
    selectMonth(6);
    expect(incomeReadonlyDollars()).toBe(8000); // 5,000 + 3,000 while both work

    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setOngoing");
    setOneOffAmount(4500);
    applyOneOff();

    // It landed on the partner's job — on the LEDGER plane, not the plan.
    expect(jobsOn("partner-jobs")[0].payChanges).toEqual([
      { id: expect.any(String), month: 6, kind: "setTo", cents: dollarsToCents(4500) },
    ]);
    expect(jobsOn("primary-jobs")[0].payChanges).toBeUndefined();
    expect(incomeReadonlyDollars()).toBe(9500); // 5,000 + 4,500
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Sam/); // names whose job
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(9500); // PERSISTS — month 12 would also carry CPI
    selectMonth(5);
    expect(incomeReadonlyDollars()).toBe(8000); // before the raise, old pay
    // The list states what is authored AT the selected month, so it is empty on a month with
    // nothing on it — it is a reading of the plan, not a record of the last thing applied.
    expect(screen.queryByTestId("pay-change-route")).toBeNull();
  });

  it("lists two bonuses on the SAME job in the same month as two entries", () => {
    // The sharpest form of the collision: same job, same month, same scope — which the old
    // `${jobId}:${scope}` key made indistinguishable, so React kept one row and the second
    // bonus overwrote the first's text.
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);

    openOneOff();
    setOneOffAmount(2000);
    applyOneOff();

    openOneOff();
    setOneOffAmount(1500);
    applyOneOff();

    const listed = screen.getByTestId("pay-change-route").textContent ?? "";
    expect(listed).toMatch(/bonus of \$2,000/i);
    expect(listed).toMatch(/bonus of \$1,500/i);
    expect(
      screen.getAllByRole("listitem").filter((li) => /bonus of/i.test(li.textContent ?? "")),
    ).toHaveLength(2);
  });

  it("stops naming an adjustment once it is removed from the plan", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6);
    openOneOff();
    setOneOffAmount(2000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route")).toBeTruthy();

    // Removing it anywhere removes it here: the echo was outliving its own change before.
    selectMonth(7);
    expect(screen.queryByTestId("pay-change-route")).toBeNull();
    selectMonth(6);
    expect(screen.getByTestId("pay-change-route")).toBeTruthy();
  });
});

describe("PayChangeEditor — draft state (single nullable draft)", () => {
  const kindSelect = () => screen.getByLabelText("Pay change kind") as HTMLSelectElement;
  const amountValue = () => Number(spin(/Amount/).value);
  const cancel = () => fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

  it("opens with a clean default draft — a bonus of $0, no job pre-picked", () => {
    renderPanel(PLAN_DEFAULTS);
    openOneOff();
    expect(kindSelect().value).toBe("addBonus");
    expect(amountValue()).toBe(0);
  });

  it("discards unsaved values on cancel", () => {
    renderPanel(PLAN_DEFAULTS);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(9000);
    cancel();
    expect(screen.queryByLabelText("Pay change kind")).toBeNull();
    expect(screen.queryByTestId("pay-change-route")).toBeNull();
  });

  it("reopens clean after a cancel — the discarded draft does not leak back", () => {
    renderPanel(PLAN_DEFAULTS);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(9000);
    cancel();
    openOneOff();
    expect(kindSelect().value).toBe("addBonus"); // not the cancelled "setTo"
    expect(amountValue()).toBe(0); // not the cancelled 9000
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

  it("draws no hover readout when nothing is hovered", () => {
    const { container } = render(<BudgetTooltip payload={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
