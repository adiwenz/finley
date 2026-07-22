/**
 * @vitest-environment jsdom
 *
 * The Base + Adjustments budget editor (issue #71). Pins the UI acceptance criteria:
 *   - AC3: the Base is prepopulated from a default template and editable; quickstart.
 *   - AC4: an edit routes to the right primitive (ledger / line override / income).
 *   - AC5: a far-future point reads as an age milestone, not a bare month index.
 *   - AC2: the per-line graph surfaces a starved line in a shortfall month.
 *
 * The gesture under test is direct manipulation: point at a month, change a number,
 * answer "just this month" or "from here forward". The chart is the pointer affordance
 * for selecting the month; these tests drive the equivalent keyboard input, since
 * Recharts needs a real layout width that jsdom does not provide.
 */
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { dollarsToCents, type Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { BaseAdjustmentsPanel } from "./baseAdjustmentsPanel";

afterEach(cleanup);

/**
 * The budget now lives on the plan, so the panel is controlled — these tests own the
 * state the app owns in production. Renders through a stateful holder so an edit
 * round-trips exactly as it does in `App`.
 */
function Harness({ initial }: { initial: Plan }) {
  const [plan, setPlan] = useState(initial);
  return <BaseAdjustmentsPanel plan={plan} setBudget={setPlan} />;
}

const renderPanel = (plan: Plan) => render(<Harness initial={plan} />);

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

  it("replaces the base with a 50/30/20 quickstart from income", () => {
    renderPanel(PLAN_DEFAULTS);
    fireEvent.click(screen.getByRole("button", { name: /Quickstart/i }));
    expect(spin(/Needs \(50%\)/)).toBeTruthy();
    expect(spin(/Savings \(20%\)/)).toBeTruthy();
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
    expect(screen.getByTestId("scope-prompt").textContent).toMatch(/\$1,600 → \$2,400/);
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
    selectMonth(14);
    editRow(/Housing/, 2400);
    selectMonth(40);
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    expect(Number(spin(/Housing/).value)).toBe(1600);
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
    selectMonth(14);
    editRow(/Housing/, 2400);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/dated override/i);
    // The change stands at month 14 and every month after it...
    expect(Number(spin(/Housing/).value)).toBe(2400);
    selectMonth(200);
    expect(Number(spin(/Housing/).value)).toBe(2400);
    // ...but not before it.
    selectMonth(13);
    expect(Number(spin(/Housing/).value)).toBe(1600);
  });

  it("routes 'just this month' to a single-month override that does not carry forward", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(14);
    editRow(/Housing/, 3000);
    fireEvent.click(screen.getByRole("button", { name: /Just this month/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/one-month override/i);
    expect(Number(spin(/Housing/).value)).toBe(3000);
    selectMonth(15);
    expect(Number(spin(/Housing/).value)).toBe(1600);
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
    editRow(/Housing/, 2400);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByTestId("scope-prompt")).toBeNull();
    expect(screen.queryByTestId("adjustment-route")).toBeNull();
    expect(Number(spin(/Housing/).value)).toBe(1600);
  });

  it("routes a permanent income change to a job/stream override, never a budget line", () => {
    renderPanel(PLAN_DEFAULTS);
    selectMonth(14);
    editRow(/Take-home/, 9000);
    fireEvent.click(screen.getByRole("button", { name: /From here forward/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/income override/i);
    expect(Number(spin(/Take-home/).value)).toBe(9000);
  });

  it("routes a one-month income change to a ledger transaction for the delta", () => {
    renderPanel(PLAN_DEFAULTS);
    const base = Number(spin(/Take-home/).value);
    selectMonth(14);
    editRow(/Take-home/, base + 800);
    fireEvent.click(screen.getByRole("button", { name: /Just this month/i }));
    const echo = screen.getByTestId("adjustment-route").textContent ?? "";
    expect(echo).toMatch(/ledger transaction/i);
    expect(echo).toMatch(/month 14/);
    // The delta, not the new total — the standing income is untouched.
    expect(echo).toMatch(/\$800/);
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

describe("BaseAdjustmentsPanel — per-line graph starvation (AC2)", () => {
  const brokePlan: Plan = {
    ...PLAN_DEFAULTS,
    incomeCents: dollarsToCents(1_500), // far below the ~$3,000 template budget
    openingBalanceCents: 0,
    retirementDeferralPct: 0,
    surplusSwept: false,
    goals: [],
    healthMonthlyCents: 0,
    postCoverageHealthMonthlyCents: 0,
    enrollsInPublicHealthCoverage: false,
  };

  it("shows a shortfall summary naming a starved line when income can't fund the budget", () => {
    renderPanel(brokePlan);
    const summary = screen.getByTestId("perline-summary").textContent ?? "";
    expect(summary).toMatch(/shortfall/i);
    // The lowest-priority wants (Subscriptions / Dining) starve before the needs.
    expect(summary).toMatch(/Subscriptions|Dining/);
  });

  it("reports every line fully funded for a comfortable budget", () => {
    const richPlan: Plan = {
      ...PLAN_DEFAULTS,
      incomeCents: dollarsToCents(8_000),
      lifeExpectancy: 40,
      goals: [],
      healthMonthlyCents: 0,
      postCoverageHealthMonthlyCents: 0,
      enrollsInPublicHealthCoverage: false,
    };
    renderPanel(richPlan);
    expect(screen.getByTestId("perline-summary").textContent).toMatch(/fully funded/i);
  });
});
