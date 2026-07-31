/**
 * @vitest-environment jsdom
 *
 * The Budget/Accounts editor's Social Security claiming-age control. The claiming age is a
 * pinned retirement input the solver reads (benefits begin at that age); this pins the
 * app-side lever, its 62–70 bound, and the estimates-not-advice disclaimer beside it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BudgetEditor } from "./budgetEditor";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { useTestProjection } from "../../testing/projectionHarness";
import type { Plan } from "@finley/engine";

afterEach(cleanup);

/** A controlled harness so edits round-trip through the real facade. */
function Harness({ initial = PLAN_DEFAULTS }: { initial?: Plan }) {
  const { state, transact } = useTestProjection(initial);
  const budget = state.scenario.plan;
  return (
    <>
      <BudgetEditor budget={budget} transact={transact} />
      <output data-testid="ss-claiming-age">{budget.benefitClaimingAge}</output>
      <output data-testid="retirement-age">{budget.retirementAge}</output>
      <output data-testid="surplus-to">{budget.surplusCashTo ?? "savings"}</output>
    </>
  );
}

describe("BudgetEditor — Social Security claiming age", () => {
  it("shows the claiming-age control seeded from the plan (default 67)", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i) as HTMLInputElement;
    expect(input.value).toBe("67");
  });

  it("bounds the control to the legal 62–70 claiming window", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i) as HTMLInputElement;
    expect(input.min).toBe("62");
    expect(input.max).toBe("70");
  });

  it("edits flow back into benefitClaimingAge (delaying the claim to 70)", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i);
    fireEvent.change(input, { target: { value: "70" } });
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("70");
  });

  it("clamps a typed value above the 62–70 window down to 70 on blur", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i);
    fireEvent.change(input, { target: { value: "95" } });
    // Typing flows through freely; the clamp lands when the field is committed.
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("95");
    fireEvent.blur(input);
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("70");
  });

  it("clamps a typed value below the 62–70 window up to 62 on blur", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i);
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("62");
  });

  it("carries an estimates-not-advice disclaimer for the Social Security figure", () => {
    render(<Harness />);
    // Several fields carry it (SS and health); at least one is present.
    expect(screen.getAllByText(/not advice/i).length).toBeGreaterThan(0);
  });
});

describe("BudgetEditor — health is not authored here any more", () => {
  it("offers no health controls at all", () => {
    // Health is a `healthcare`-category budget line, authored in Base + Adjustments. A control
    // here would be a second surface writing the same number, which is what this refactor
    // removed — so the absence is the assertion.
    render(<Harness />);
    expect(screen.queryByLabelText(/health/i)).toBeNull();
    expect(screen.queryByLabelText(/Medicare/i)).toBeNull();
  });

  it("still offers the general inflation rate health used to sit beside", () => {
    // Guards against the removal taking its neighbour with it: CPI is a plan lever and stays.
    render(<Harness />);
    const input = screen.getByLabelText(/General inflation/i) as HTMLInputElement;
    expect(input.value).toBe(String(PLAN_DEFAULTS.inflationPct));
  });
});

describe("BudgetEditor — surplus-cash destination lever", () => {
  it("defaults the control to Cash savings when the plan leaves the lever unset", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, surplusCashTo: undefined }} />);
    const select = screen.getByLabelText(/Surplus cash goes to/i) as HTMLSelectElement;
    expect(select.value).toBe("savings");
  });

  it("offers both the savings and brokerage destinations", () => {
    render(<Harness />);
    const select = screen.getByLabelText(/Surplus cash goes to/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["savings", "brokerage"]);
  });

  it("edits flow back into surplusCashTo (sweeping surplus to the brokerage)", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, surplusCashTo: undefined }} />);
    const select = screen.getByLabelText(/Surplus cash goes to/i);
    fireEvent.change(select, { target: { value: "brokerage" } });
    expect(screen.getByTestId("surplus-to").textContent).toBe("brokerage");
  });
});

describe("BudgetEditor — retirement age", () => {
  it("shows a retirement-age control seeded from the plan", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Retirement age/i) as HTMLInputElement;
    expect(input.value).toBe(String(PLAN_DEFAULTS.retirementAge));
  });

  it("edits flow back into retirementAge (retiring early at 55)", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Retirement age/i);
    fireEvent.change(input, { target: { value: "55" } });
    expect(screen.getByTestId("retirement-age").textContent).toBe("55");
  });

  it("clamps retirement age up to current age (can't retire in the past)", () => {
    // Current age 50 sits above the static 40 floor, so it becomes the binding lower bound.
    render(<Harness initial={{ ...PLAN_DEFAULTS, currentAge: 50 }} />);
    const input = screen.getByLabelText(/Retirement age/i);
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("retirement-age").textContent).toBe("50");
  });

  it("clamps current age down to retirement age (can't already be past it)", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, retirementAge: 60 }} />);
    const input = screen.getByLabelText(/Current age/i);
    fireEvent.change(input, { target: { value: "70" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("60");
  });
});
