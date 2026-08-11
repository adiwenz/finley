/**
 * @vitest-environment jsdom
 *
 * BudgetEditor tests only the editor contract: which controls exist, their bounds, and which
 * PlanPatch each interaction sends. Engine validation and the consequences of those patches are
 * tested in @finley/engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AGE_LIMITS, MAX_AGE, MAX_LIVED_AGE, type Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { enterNumber } from "../../testing/numberField";
import { BudgetEditor } from "./budgetEditor";

afterEach(cleanup);

function renderEditor(budget: Plan = PLAN_DEFAULTS) {
  const updatePlan = vi.fn();
  const transact = vi.fn((write: any) => write({ updatePlan }));
  render(<BudgetEditor budget={budget} transact={transact as any} />);
  return { transact, updatePlan };
}

describe("BudgetEditor", () => {
  it("renders the standing plan controls and no duplicate health or retirement-age controls", () => {
    renderEditor();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText(/General inflation/i)).toBeTruthy();
    expect(screen.getByLabelText(/Current age/i)).toBeTruthy();
    expect(screen.getByLabelText(/Life expectancy/i)).toBeTruthy();
    expect(screen.getByLabelText(/Social Security claiming age/i)).toBeTruthy();
    expect(screen.getByLabelText(/Cash opening balance/i)).toBeTruthy();
    expect(screen.getByLabelText(/Retirement opening balance/i)).toBeTruthy();
    expect(screen.getByLabelText(/Brokerage opening balance/i)).toBeTruthy();
    expect(screen.queryByLabelText(/health/i)).toBeNull();
    expect(screen.queryByLabelText(/Retirement age/i)).toBeNull();
  });

  it("publishes the UI bounds from the engine constants", () => {
    renderEditor();
    const currentAge = screen.getByLabelText(/Current age/i) as HTMLInputElement;
    const expectancy = screen.getByLabelText(/Life expectancy/i) as HTMLInputElement;
    const claiming = screen.getByLabelText(/Social Security claiming age/i) as HTMLInputElement;

    expect(Number(currentAge.max)).toBe(
      Math.min(MAX_LIVED_AGE, PLAN_DEFAULTS.primary.lifeExpectancy - 1),
    );
    expect(Number(expectancy.min)).toBe(START_YEAR - PLAN_DEFAULTS.primary.birthYear + 1);
    expect(Number(expectancy.max)).toBe(MAX_AGE);
    expect(Number(claiming.min)).toBe(62);
    expect(Number(claiming.max)).toBe(AGE_LIMITS.benefitClaimingAge);
  });

  it("chains current-age max to one year below a shorter life expectancy", () => {
    renderEditor({
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, lifeExpectancy: 70 },
    });
    expect((screen.getByLabelText(/Current age/i) as HTMLInputElement).max).toBe("69");
  });

  it("offers both surplus destinations and defaults an unset value to savings", () => {
    renderEditor({ ...PLAN_DEFAULTS, surplusCashTo: undefined });
    const select = screen.getByLabelText(/Surplus cash goes to/i) as HTMLSelectElement;
    expect(select.value).toBe("savings");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["savings", "brokerage"]);
  });

  it("routes a name edit through updatePlan", () => {
    const { updatePlan } = renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam" } });
    expect(updatePlan).toHaveBeenLastCalledWith({ name: "Sam" });
  });

  it("converts current age to birth year before updating the plan", () => {
    const { updatePlan } = renderEditor();
    enterNumber(screen.getByLabelText(/Current age/i), 45);
    expect(updatePlan).toHaveBeenLastCalledWith({ birthYear: START_YEAR - 45 });
  });

  it("routes life expectancy and claiming age as their plan fields", () => {
    const { updatePlan } = renderEditor();
    enterNumber(screen.getByLabelText(/Life expectancy/i), 95);
    expect(updatePlan).toHaveBeenLastCalledWith({ lifeExpectancy: 95 });

    enterNumber(screen.getByLabelText(/Social Security claiming age/i), 70);
    expect(updatePlan).toHaveBeenLastCalledWith({ benefitClaimingAge: 70 });
  });

  it("routes the surplus destination through updatePlan", () => {
    const { updatePlan } = renderEditor({ ...PLAN_DEFAULTS, surplusCashTo: undefined });
    fireEvent.change(screen.getByLabelText(/Surplus cash goes to/i), {
      target: { value: "brokerage" },
    });
    expect(updatePlan).toHaveBeenLastCalledWith({ surplusCashTo: "brokerage" });
  });

  it("routes each account's opening balance through updatePlan independently", () => {
    const { updatePlan } = renderEditor();
    enterNumber(screen.getByLabelText(/Cash opening balance/i), 12000);
    expect(updatePlan).toHaveBeenLastCalledWith({ openingBalanceCents: 1200000 });

    enterNumber(screen.getByLabelText(/Retirement opening balance/i), 50000);
    expect(updatePlan).toHaveBeenLastCalledWith({ retirementOpeningBalanceCents: 5000000 });

    enterNumber(screen.getByLabelText(/Brokerage opening balance/i), 15000);
    expect(updatePlan).toHaveBeenLastCalledWith({ brokerageOpeningBalanceCents: 1500000 });
  });

  it("keeps return-rate controls in Advanced", () => {
    renderEditor();
    const advanced = screen.getByText("Advanced").closest("details")!;
    expect(advanced.querySelectorAll('input[type="number"]').length).toBe(3);
    expect(screen.getByLabelText(/Savings return/i)).toBeTruthy();
    expect(screen.getByLabelText(/Retirement return/i)).toBeTruthy();
    expect(screen.getByLabelText(/Brokerage return/i)).toBeTruthy();
  });

  it("labels Social Security as an estimate rather than advice", () => {
    renderEditor();
    expect(screen.getByText(/Social Security figures are an estimate, not advice/i)).toBeTruthy();
  });
});
