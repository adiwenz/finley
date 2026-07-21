/**
 * @vitest-environment jsdom
 *
 * The Base + Adjustments budget editor (issue #71). Pins the UI acceptance criteria:
 *   - AC3: the Base is prepopulated from a default template and editable; quickstart.
 *   - AC4: an adjustment routes to the right primitive (ledger / line override / income).
 *   - AC5: a long-horizon adjustment is age/milestone-anchored, resolved to a month.
 *   - AC2: the per-line graph surfaces a starved line in a shortfall month.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { dollarsToCents, type Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { BaseAdjustmentsPanel } from "./baseAdjustmentsPanel";

afterEach(cleanup);

describe("BaseAdjustmentsPanel — Base (AC3)", () => {
  it("prepopulates the base from the default template", () => {
    render(<BaseAdjustmentsPanel plan={PLAN_DEFAULTS} />);
    // Each base line is an editable number field labelled by the line's name.
    expect(screen.getByRole("spinbutton", { name: /Housing/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /Dining & fun/ })).toBeTruthy();
  });

  it("lets the user edit a base line amount", () => {
    render(<BaseAdjustmentsPanel plan={PLAN_DEFAULTS} />);
    const housing = screen.getByRole("spinbutton", { name: /Housing/ }) as HTMLInputElement;
    expect(Number(housing.value)).toBe(1600);
    fireEvent.change(housing, { target: { value: "1800" } });
    expect(
      Number((screen.getByRole("spinbutton", { name: /Housing/ }) as HTMLInputElement).value),
    ).toBe(1800);
  });

  it("replaces the base with a 50/30/20 quickstart from income", () => {
    render(<BaseAdjustmentsPanel plan={PLAN_DEFAULTS} />);
    fireEvent.click(screen.getByRole("button", { name: /Quickstart/i }));
    // The line editor is labelled by the line's label, so 50/30/20 lines appear.
    expect(screen.getByRole("spinbutton", { name: /Needs \(50%\)/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /Savings \(20%\)/ })).toBeTruthy();
  });
});

describe("BaseAdjustmentsPanel — Adjustments routing (AC4, AC5)", () => {
  it("routes a recurring spend change to a dated line override", () => {
    render(<BaseAdjustmentsPanel plan={PLAN_DEFAULTS} />);
    fireEvent.click(screen.getByRole("button", { name: /Apply adjustment/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/dated override/i);
  });

  it("routes a one-time change to a ledger transaction", () => {
    render(<BaseAdjustmentsPanel plan={PLAN_DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "oneTime" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply adjustment/i }));
    expect(screen.getByTestId("adjustment-route").textContent).toMatch(/ledger transaction/i);
  });

  it("routes a recurring income change to a job/stream override, age-anchored to a month (AC5)", () => {
    render(<BaseAdjustmentsPanel plan={PLAN_DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("What changes"), { target: { value: "income" } });
    fireEvent.change(screen.getByLabelText("When anchor"), { target: { value: "age" } });
    // At age 50 for a 35-year-old = 15 years = month 180.
    fireEvent.change(screen.getByLabelText("Age"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply adjustment/i }));
    const echo = screen.getByTestId("adjustment-route").textContent ?? "";
    expect(echo).toMatch(/income override/i);
    expect(echo).toMatch(/month 180/);
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
    render(<BaseAdjustmentsPanel plan={brokePlan} />);
    const summary = screen.getByTestId("perline-summary").textContent ?? "";
    expect(summary).toMatch(/shortfall/i);
    // The lowest-priority wants (Subscriptions / Dining) starve before the needs.
    expect(summary).toMatch(/Subscriptions|Dining/);
  });

  it("reports every line fully funded for a comfortable budget", () => {
    // High income that never stops within a short horizon → the ~$3,000 template is
    // funded throughout (retirement at 65 is beyond this 5-year horizon).
    const richPlan: Plan = {
      ...PLAN_DEFAULTS,
      incomeCents: dollarsToCents(8_000),
      lifeExpectancy: 40,
      goals: [],
      healthMonthlyCents: 0,
      postCoverageHealthMonthlyCents: 0,
      enrollsInPublicHealthCoverage: false,
    };
    render(<BaseAdjustmentsPanel plan={richPlan} />);
    expect(screen.getByTestId("perline-summary").textContent).toMatch(/fully funded/i);
  });
});
