/**
 * @vitest-environment jsdom
 *
 * The Base + Adjustments budget editor (issue #71). Pins the UI acceptance criteria:
 *   - AC3: the Base is prepopulated from a default template and editable; quickstart.
 *   - AC4: an edit routes to the right primitive (ledger / line override / income).
 *   - AC5: a far-future point reads as an age milestone, not a bare month index.
 *   - AC2: the per-line graph draws the budget as authored, and says outright when
 *     the plan stops being financeable rather than dropping spending on its own.
 *
 * The gesture under test is direct manipulation: point at a month, change a number,
 * answer "just this month" or "from here forward". The chart is the pointer affordance
 * for selecting the month; these tests drive the equivalent keyboard input, since
 * Recharts needs a real layout width that jsdom does not provide.
 */
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  PRIMARY_PERSON_ID,
  createProjectionBase,
  dollarsToCents,
  emptyLedger,
  interpretLedger,
  projectScenario,
  updateEvent,
  type Job,
  type Ledger,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import type { EventRevision } from "../../hooks/useLedger";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { addJobFromDraft, blankJobDraft, setJobMonthlyIncome } from "../../planPeople";
import { BaseAdjustmentsPanel } from "./baseAdjustmentsPanel";
import { BudgetTooltip } from "./perLineBudgetChart";

afterEach(cleanup);

/** The read-only income figure at the selected month, as a whole-dollar number. */
const incomeReadonlyDollars = (): number =>
  Number((screen.getByTestId("income-readonly").textContent ?? "").replace(/[^0-9.]/g, ""));

/** Open the pay-change control, then drive its kind / amount and apply. */
const openOneOff = () =>
  fireEvent.click(screen.getByRole("button", { name: /Change pay at this month/i }));
const setOneOffKind = (value: string) =>
  fireEvent.change(screen.getByLabelText("Pay change kind"), { target: { value } });
const setOneOffAmount = (dollars: number) =>
  fireEvent.change(screen.getByRole("spinbutton", { name: /Amount/ }), {
    target: { value: String(dollars) },
  });
const applyOneOff = () => fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

/**
 * The budget now lives on the plan, so the panel is controlled — these tests own the
 * state the app owns in production. Renders through a stateful holder so an edit
 * round-trips exactly as it does in `App`.
 *
 * The panel does not project any more: `App` owns the app's ONE projection (plan *and*
 * ledger, §1) and passes it down, so this harness stands in for `App` and projects
 * through the identical pipeline. Tests that care only about the budget leave the ledger
 * empty; a test about timeline-authored income passes one in.
 */
function Harness({ initial, ledger: initialLedger = emptyLedger }: { initial: Plan; ledger?: Ledger }) {
  const [plan, setPlan] = useState(initial);
  // The ledger is state too, now that a pay change can land on a partner's job — it rides
  // the RelationshipEvent they joined with, so applying one revises that event (#118).
  const [ledger, setLedger] = useState(initialLedger);
  const ctx = { jurisdiction: usJurisdiction, startYear: START_YEAR };
  const base = createProjectionBase(plan, ctx);
  const household = interpretLedger(ledger, base);
  const series = projectScenario({ plan, ledger }, ctx);
  // The household roster App passes down, so income bands can name whose they are.
  const personNames = new Map<string, string>([
    [PRIMARY_PERSON_ID, plan.name],
    ...ledger.events.flatMap((e) =>
      e.type === "RelationshipEvent" ? ([[e.person.id, e.person.name]] as [string, string][]) : [],
    ),
  ]);
  // Stands in for `useLedger.reviseEvents`: all-or-nothing, and it answers synchronously.
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  const onReviseEvents = (revisions: readonly EventRevision[]): boolean => {
    let next = ledgerRef.current;
    for (const revision of revisions) {
      const result = updateEvent(next, revision.id, revision.next, base);
      if (!result.ok) return false;
      next = result.ledger;
    }
    ledgerRef.current = next;
    setLedger(next);
    return true;
  };
  return (
    <>
      <BaseAdjustmentsPanel
        plan={plan}
        setBudget={setPlan}
        series={series}
        personNames={personNames}
        household={household}
        ledger={ledger}
        onReviseEvents={onReviseEvents}
      />
      <output data-testid="primary-jobs">{JSON.stringify(plan.jobs)}</output>
      <output data-testid="partner-jobs">{JSON.stringify(partnerJobsOf(ledger))}</output>
    </>
  );
}

const renderPanel = (plan: Plan, ledger?: Ledger) =>
  render(<Harness initial={plan} ledger={ledger} />);

/** The jobs currently authored on the partner's RelationshipEvent — the ledger plane. */
function partnerJobsOf(ledger: Ledger): readonly Job[] {
  for (const e of ledger.events) if (e.type === "RelationshipEvent") return e.person.jobs;
  return [];
}

/** What each plane holds after an adjustment — the assertion surface for the routing. */
const jobsOn = (testId: "primary-jobs" | "partner-jobs"): readonly Job[] =>
  JSON.parse(screen.getByTestId(testId).textContent || "[]") as Job[];

/** A ledger whose only event is a partner joining at month 0 with one open-ended job (#118). */
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
        retirementTargetAge: 65,
        benefitClaimingAge: 67,
        jobs: [
          {
            id: "p-1-job-1",
            name: "Sam's job",
            ownerId: "p-1",
            startYear: START_YEAR,
            endYear: null,
            salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
          },
        ],
      },
    },
  ],
  nextSequenceNumber: 1,
});

const spin = (name: RegExp | string) =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

/** Point the editor at a month, the way a chart click would. */
const selectMonth = (month: number) =>
  fireEvent.change(spin("Month"), { target: { value: String(month) } });

/** Type a new amount into a row, which stages the how-long question. */
const editRow = (name: RegExp | string, dollars: number) =>
  fireEvent.change(spin(name), { target: { value: String(dollars) } });

describe("BaseAdjustmentsPanel — Base (AC3)", () => {
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
    // Income is authored in the Jobs panel; this row only displays the compiled total.
    // Month 0 is the projection's flow-free opening snapshot (the engine accrues flows
    // only for month > 0 — GH #34), so `incomeByMonth[0]` is $0 even though the job pays
    // a full salary; the row reads the standing rate (month 1) at the opening month.
    renderPanel(PLAN_DEFAULTS);
    expect(screen.getByTestId("selected-month").textContent).toMatch(/month 0/);
    expect(incomeReadonlyDollars()).toBe(5000);
    // The income figure is not an editable field — standing pay is edited in Jobs.
    expect(screen.queryByRole("spinbutton", { name: /^Income$/ })).toBeNull();
  });

  it("grows every row with inflation as you move along the budget", () => {
    // The editor sits directly under the graph, so it has to agree with it: scrub out
    // thirty years and the rows must show thirty-years-from-now dollars, not today's.
    renderPanel(PLAN_DEFAULTS);
    const today = Number(spin(/Housing/).value);
    selectMonth(360);
    const inThirtyYears = Number(spin(/Housing/).value);
    expect(inThirtyYears).toBeGreaterThan(today * 2); // 3% over 30y ≈ ×2.4
    selectMonth(0);
    expect(Number(spin(/Housing/).value)).toBe(today);
  });

  it("shows income stopping at retirement and the benefit picking up at the claiming age", () => {
    // The read-only figure is the income the projection actually pays — it stops at
    // retirement and the government benefit picks up at the claiming age, rather than a
    // salary compounding forever (at age 81 the old scalar row showed a $19k salary).
    renderPanel(PLAN_DEFAULTS);
    const monthAtAge = (age: number) => (age - PLAN_DEFAULTS.currentAge) * 12;

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
    // Income is not a budget line (§6/§17), so it gets its own graph above the budget.
    renderPanel(PLAN_DEFAULTS);
    const firstRow = JSON.parse(
      screen.getByTestId("income-first-row").textContent || "{}",
    ) as Record<string, number>;
    expect(Object.values(firstRow).some((v) => v > 0)).toBe(true);
    // Retires at 65, claims at 67 — that stretch is lived off savings, and the graph now
    // names it a drawdown rather than showing a misleading flat zero (issue #99).
    expect(screen.getByTestId("income-summary").textContent).toMatch(/living off savings/i);
  });

  it("counts income authored on the timeline — a partner's own jobs (issue #118)", () => {
    // The regression: this panel used to run its OWN projection from the plan alone,
    // whose ledger is empty. A partner joining with a $2,000/mo job moved the net-worth
    // chart and the snapshot while the income graph directly below them showed only the
    // primary earner's $5,000. One projection (plan + ledger) now feeds every surface.
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
    // Simple (issue #99 follow-up): wages per job, one "Social Security" band, and one
    // "Living off savings" band that folds in the benefit-gap drawdown and any asset sale.
    renderPanel(PLAN_DEFAULTS);
    const bands = (): string[] =>
      JSON.parse(screen.getByTestId("income-bands").textContent || "[]") as string[];

    expect(bands()).toContain("Social Security");
    expect(bands()).toContain("Living off savings");
    // The precise engine labels are hidden in Simple — they belong to Advanced.
    expect(bands()).not.toContain("Government benefit");
    expect(bands()).not.toContain("Savings drawdown");

    // Flip to Advanced: the collapsed bands split back into their real sources.
    fireEvent.click(screen.getByRole("checkbox", { name: /Advanced view/i }));
    expect(bands()).toContain("Government benefit");
    expect(bands()).toContain("Savings drawdown");
    expect(bands()).not.toContain("Living off savings");
    expect(bands()).not.toContain("Social Security");
  });

  it("draws take-home cash flows by default and switches to gross on the toggle (issue #110 follow-up)", () => {
    // Take-home is the honest read against the spending-need line: the bands are cash after
    // tax and deferral. Flipping "Show gross cash flows" raises them by exactly the tax the
    // wages bore, so gross > take-home while the household is earning and taxed.
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
    // Housing is a named line before quickstart…
    expect(spin(/Housing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Quickstart/i }));
    // …and still is after (the budget was rebalanced, not replaced by 3 buckets).
    expect(spin(/Housing/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: /Needs \(50%\)/ })).toBeNull();
    // A real savings contribution line is seeded for the empty savings tier.
    expect(screen.getByLabelText(/Delete Savings/i)).toBeTruthy();
  });
});

describe("BaseAdjustmentsPanel — editing a point on the budget (AC4)", () => {
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
    // The field must hold the typed value while the how-long question is open — it
    // used to snap back to the stored amount on every keystroke, so a backspace on
    // "1600" left the box reading 1600 while staging an edit to $160.
    expect(Number(spin(/Housing/).value)).toBe(2400);
    // The "before" figure is that month's dollars, not today's — the row inflates.
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
    // Later months carry the change AND keep growing with prices from there.
    selectMonth(200);
    expect(Number(spin(/Housing/).value)).toBeGreaterThan(2400);
    // Earlier months are untouched.
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
    // The route carries the line's authoring id ("dining"); echoing that back at the
    // user contradicts the row directly above it, which reads "Dining & fun".
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
    // A bonus is a per-job JobIncomeOverride taxed as wages, so the read-only income at
    // that month rises by exactly the bonus — the projection, not just the label, moves.
    renderPanel(PLAN_DEFAULTS);
    selectMonth(6); // year 0, base $5,000/mo
    expect(incomeReadonlyDollars()).toBe(5000);
    openOneOff();
    setOneOffAmount(2000); // default kind is "bonus (add on top)"
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/bonus of \$2,000/i);
    expect(incomeReadonlyDollars()).toBe(7000); // 5,000 base + 2,000 bonus
  });

  it("stacks the monthly-tax chart by job, matching the income chart (issue #110 follow-up)", () => {
    // The US jurisdiction reports tax per category and the engine splits it down to the
    // job that bore it, so the tax chart bands by source: the default plan's one job draws
    // its own wage-tax band (named like its income band), and the split's Σ equals the row
    // total.
    renderPanel(PLAN_DEFAULTS);
    const bands = JSON.parse(screen.getByTestId("tax-bands").textContent || "[]") as string[];
    expect(bands).toContain("Income · job-1");
    const firstRow = JSON.parse(screen.getByTestId("tax-first-row").textContent || "{}");
    const banded = Object.entries(firstRow.centsBySource as Record<string, number>).reduce(
      (s, [, c]) => s + c,
      0,
    );
    expect(banded).toBe(firstRow.taxCents as number);
  });

  it("sets pay to $0 for one month (a missed paycheck), taxed on $0 wages that month", () => {
    // There is no dedicated "missed paycheck" kind anymore: a missed month is just
    // "Set pay this month" to $0. It must zero BOTH the income and the wage tax for the
    // month — you are not taxed on a paycheck you did not receive.
    renderPanel(PLAN_DEFAULTS);
    const monthOneTax = () =>
      (JSON.parse(screen.getByTestId("tax-first-row").textContent || "{}").taxCents as number) ?? 0;
    // Month 1 normally pays $5,000 of wages and is taxed on them.
    expect(monthOneTax()).toBeGreaterThan(0);

    selectMonth(1);
    openOneOff();
    setOneOffKind("setTo");
    setOneOffAmount(0); // the missed-paycheck case
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/pay set to \$0/i);
    expect(incomeReadonlyDollars()).toBe(0);
    // Taxed on $0 wages, not the full salary: month 1's tax falls to $0.
    expect(monthOneTax()).toBe(0);
    // The next month is untouched — the override is a single month.
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
    // A permanent change rides a JobPayChange, so the new pay persists — unlike "set pay
    // this month", the next month is also changed, and the month before is untouched.
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

describe("PayChangeEditor — every earner's jobs, not just the primary person's (#118)", () => {
  // A partner's jobs ride the RelationshipEvent they joined with, not `Plan.jobs`. The
  // control used to list only the plan's jobs, so a partner's bonus, missed paycheck,
  // raise or cut had nowhere to land — the picker did not even offer their job.
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
      { month: 6, kind: "setTo", cents: dollarsToCents(4500) },
    ]);
    expect(jobsOn("primary-jobs")[0].payChanges).toBeUndefined();
    // And the projection moves: the raise holds from month 6 forward.
    expect(incomeReadonlyDollars()).toBe(9500); // 5,000 + 4,500
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(9500); // PERSISTS — month 12 would also carry CPI
    selectMonth(5);
    expect(incomeReadonlyDollars()).toBe(8000); // before the raise, old pay
    // The note names whose job it was.
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Sam/);
  });

  it("gives a partner's job a one-month bonus, then a missed paycheck", () => {
    withPartner();
    selectMonth(6);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffAmount(2000); // default kind: bonus on top
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(10_000); // 5,000 + 3,000 + 2,000, that month only
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(8000); // and only that month

    // A missed paycheck on the partner's job zeroes THEIR wages, leaving the primary's.
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setTo");
    setOneOffAmount(0);
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(5000);

    // Both overrides are on the partner's job, and the earlier one survived the later.
    expect(jobsOn("partner-jobs")[0].incomeOverrides).toEqual([
      { month: 6, kind: "addBonus", cents: dollarsToCents(2000) },
      { month: 7, kind: "setTo", cents: 0 },
    ]);
  });

  it("cuts a partner's ongoing pay, and corrects a single month of it", () => {
    // The remaining two kinds, on a partner's job: a permanent CUT (a pay change can go
    // down — that is why it is a "pay change", not a "raise") and a one-month correction
    // to an absolute figure that is not $0.
    withPartner();
    selectMonth(6);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("changeOngoing");
    setOneOffAmount(-800);
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(7200); // 5,000 + (3,000 − 800), ongoing

    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setTo");
    setOneOffAmount(1000); // this month they were paid $1,000, cut and all
    applyOneOff();
    expect(incomeReadonlyDollars()).toBe(6000); // 5,000 + 1,000, this month only
    selectMonth(7);
    expect(incomeReadonlyDollars()).toBe(7200); // the cut still stands; the correction does not

    const job = jobsOn("partner-jobs")[0];
    expect(job.payChanges).toEqual([{ month: 6, kind: "changeBy", cents: -dollarsToCents(800) }]);
    expect(job.incomeOverrides).toEqual([{ month: 6, kind: "setTo", cents: dollarsToCents(1000) }]);
  });

  it("changes only the job it was applied to, and nothing else about it", () => {
    withPartner();
    const partnerBefore = jobsOn("partner-jobs")[0];
    selectMonth(6);
    openOneOff();
    setOneOffKind("changeOngoing"); // defaults to the FIRST job — the primary person's
    setOneOffAmount(1000);
    applyOneOff();

    // The primary's job took the change; the partner's is untouched, byte for byte.
    expect(jobsOn("primary-jobs")[0].payChanges).toEqual([
      { month: 6, kind: "changeBy", cents: dollarsToCents(1000) },
    ]);
    expect(jobsOn("partner-jobs")[0]).toEqual(partnerBefore);
  });

  it("preserves the rest of a partner's job — name, span, salary, deferral, other adjustments", () => {
    withPartner();
    selectMonth(3);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffAmount(500);
    applyOneOff();

    selectMonth(9);
    openOneOff();
    pickJob("p-1-job-1");
    setOneOffKind("setOngoing");
    setOneOffAmount(3500);
    applyOneOff();

    const job = jobsOn("partner-jobs")[0];
    expect(job.id).toBe("p-1-job-1");
    expect(job.name).toBe("Sam's job");
    expect(job.ownerId).toBe("p-1");
    expect(job.startYear).toBe(START_YEAR);
    expect(job.endYear).toBeNull();
    expect(job.salary).toEqual({ startingSalaryCents: dollarsToCents(36_000), realGrowthPct: 0 });
    // The bonus from the first adjustment survived the second, which is a different kind.
    expect(job.incomeOverrides).toEqual([{ month: 3, kind: "addBonus", cents: dollarsToCents(500) }]);
    expect(job.payChanges).toEqual([{ month: 9, kind: "setTo", cents: dollarsToCents(3500) }]);
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
    // The form is closed and nothing was applied — no confirmation note.
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

  it("defaults to the first job with several jobs, unless another is picked", () => {
    // With a second open-ended job for the same person, the pay change should target Job 1
    // by default and honour an explicit pick otherwise.
    const twoJobs = addJobFromDraft(PLAN_DEFAULTS, blankJobDraft(PLAN_DEFAULTS));
    renderPanel(twoJobs);
    selectMonth(6);

    openOneOff();
    expect(screen.getByLabelText("Job")).toBeTruthy();
    setOneOffAmount(2000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Job 1/); // defaulted

    openOneOff();
    fireEvent.change(screen.getByLabelText("Job"), { target: { value: "job-2" } });
    setOneOffAmount(1000);
    applyOneOff();
    expect(screen.getByTestId("pay-change-route").textContent).toMatch(/Job 2/); // honoured
  });
});

describe("BaseAdjustmentsPanel — add / edit / delete budget items (§12/§15)", () => {
  const openAdd = () => fireEvent.click(screen.getByRole("button", { name: /Add a budget item/i }));
  const setName = (name: string) =>
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  const setType = (v: string) =>
    fireEvent.change(screen.getByLabelText("Item type"), { target: { value: v } });
  const setAmount = (dollars: number) =>
    fireEvent.change(screen.getByRole("spinbutton", { name: /Monthly amount/ }), {
      target: { value: String(dollars) },
    });
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
    // The form's draft is a discriminated union, so only ONE kind's extra field is ever
    // present: an expense shows Category (no account), a contribution shows Into account
    // (no category). Switching kind rebuilds that arm while carrying name and amount over.
    renderPanel(PLAN_DEFAULTS);
    openAdd();
    setName("Flex");
    setAmount(300);

    // Expense arm: category present, account absent.
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.queryByLabelText("Into account")).toBeNull();

    // → contribution: the fields swap, never coexist.
    setType("contribution");
    expect(screen.getByLabelText("Into account")).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();

    // → back to expense: swaps back, and the shared fields survived the round trip.
    setType("expense");
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.queryByLabelText("Into account")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Flex");
    expect(
      Number((screen.getByRole("spinbutton", { name: /Monthly amount/ }) as HTMLInputElement).value),
    ).toBe(300);

    // Submits as a plain expense: an editable spending SPINBUTTON (a contribution renders a
    // read-only value instead), and it isn't listed under Savings & contributions.
    submitAdd();
    expect(spin(/Flex/)).toBeTruthy();
    expect(screen.getByText(/No recurring contributions yet/i)).toBeTruthy();
  });

  it("adds a contribution line into an account, shown under Savings & contributions", () => {
    renderPanel(PLAN_DEFAULTS);
    // No contributions to begin with.
    expect(screen.getByText(/No recurring contributions yet/i)).toBeTruthy();
    openAdd();
    setName("Auto-invest");
    setType("contribution"); // reveals the account picker; forces savings tier
    setAmount(500);
    submitAdd();
    // Appears as a contribution row with its destination, not an editable spending row.
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
    // The two lists are separate components now; the single-form-at-a-time rule spans
    // them, so it is arbitrated by the panel. Opening one must close the other.
    const withContribution: Plan = {
      ...PLAN_DEFAULTS,
      budgetLines: [
        ...(PLAN_DEFAULTS.budgetLines ?? []),
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
    // `budgetLines` is optional on the plan; the panel falls back to a shared empty
    // list rather than minting one per render.
    const { budgetLines: _dropped, ...noLines } = PLAN_DEFAULTS;
    renderPanel(noLines as Plan);
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

describe("BaseAdjustmentsPanel — long-horizon points (AC5)", () => {
  it("labels a far-future point by calendar year and age, not just a month index", () => {
    renderPanel(PLAN_DEFAULTS);
    // 15 years out for a 35-year-old = month 180 = age 50.
    selectMonth(180);
    const label = screen.getByTestId("selected-month").textContent ?? "";
    expect(label).toMatch(/month 180/);
    expect(label).toMatch(/age 50/);
  });
});

describe("BaseAdjustmentsPanel — per-line graph (AC2)", () => {
  const brokePlan: Plan = {
    // $1,500/mo income, far below the ~$3,000 template budget.
    ...setJobMonthlyIncome(PLAN_DEFAULTS, "job-1", dollarsToCents(1_500)),
    openingBalanceCents: 0,
    goals: [],
    healthMonthlyCents: 0,
    postCoverageHealthMonthlyCents: 0,
    enrollsInPublicHealthCoverage: false,
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
    const richPlan: Plan = {
      ...setJobMonthlyIncome(PLAN_DEFAULTS, "job-1", dollarsToCents(8_000)),
      lifeExpectancy: 40,
      goals: [],
      healthMonthlyCents: 0,
      postCoverageHealthMonthlyCents: 0,
      enrollsInPublicHealthCoverage: false,
    };
    renderPanel(richPlan);
    expect(screen.getByTestId("perline-summary").textContent).toMatch(/financed across/i);
  });

  it("bands health care beside the budget lines, with nothing passed in but the series", () => {
    // The panel takes a plan and a projected series — no label maps, no household
    // series, no per-line map. Health is real spending the budget does not author, and
    // it reaches the graph because the ENGINE reports it, not because the panel
    // reassembled it from somewhere.
    renderPanel(PLAN_DEFAULTS);
    const firstRow = JSON.parse(
      screen.getByTestId("perline-first-row").textContent || "{}",
    ) as Record<string, number>;
    expect(firstRow["line:housing"]).toBeGreaterThan(0);
    expect(firstRow["health"]).toBe(PLAN_DEFAULTS.healthMonthlyCents);
  });

  it("bands a liability's payment from the timeline, with no extra props", () => {
    const projection = Projection.create({ plan: PLAN_DEFAULTS, startYear: START_YEAR });
    projection.takeLoan({
      id: "loan-student",
      month: 0,
      ownerId: PRIMARY_PERSON_ID,
      openingBalanceCents: dollarsToCents(45_000),
      apr: 0.06,
      kind: "studentLoan",
      termMonths: 120,
    });
    render(
      <BaseAdjustmentsPanel
        plan={PLAN_DEFAULTS}
        setBudget={() => {}}
        series={projection.run(usJurisdiction).series}
      />,
    );

    const firstRow = JSON.parse(
      screen.getByTestId("perline-first-row").textContent || "{}",
    ) as Record<string, number>;
    // Servicing the loan is spending — banded like anything else the month costs, and
    // the budget lines beside it are untouched by its arrival.
    expect(firstRow["debt:loan-student"]).toBeGreaterThan(dollarsToCents(400));
    expect(firstRow["line:housing"]).toBeGreaterThan(0);
  });

  it("redraws when the budget changes — the memoized graphs must not go stale", () => {
    // The graphs skip re-rendering while only the staged edit moves (they do not depend
    // on it). A committed edit changes the projection, and they must follow it.
    renderPanel(PLAN_DEFAULTS);
    const housingBand = () =>
      (
        JSON.parse(screen.getByTestId("perline-first-row").textContent || "{}") as Record<
          string,
          number
        >
      )["line:housing"];
    const before = housingBand();

    editRow(/Housing/, 2_400);
    // Staging alone changes nothing about the projection…
    expect(housingBand()).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    // …but committing does, and the graph shows it.
    expect(housingBand()).toBeGreaterThan(before);
  });

  it("adds the stack up for the reader: the hover readout carries the month's total", () => {
    // Recharts owns the hover itself (and needs a layout jsdom lacks), so the readout is
    // driven directly with the payload Recharts hands it.
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

  it("draws no hover readout when nothing is hovered", () => {
    const { container } = render(<BudgetTooltip payload={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
