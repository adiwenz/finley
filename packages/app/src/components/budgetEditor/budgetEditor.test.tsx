/**
 * @vitest-environment jsdom
 *
 * The Budget/Accounts editor's Social Security claiming-age control. The claiming age is a
 * pinned retirement input the solver reads (benefits begin at that age); this pins the
 * app-side lever, its 62–70 bound, and the estimates-not-advice disclaimer beside it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import { BudgetEditor } from "./budgetEditor";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { useTestProjection } from "../../testing/projectionHarness";
import { AGE_LIMITS, MAX_AGE, MAX_LIVED_AGE } from "@finley/engine";
import type { Plan } from "@finley/engine";

afterEach(cleanup);

/** A controlled harness so edits round-trip through the real facade. */
function Harness({ initial = PLAN_DEFAULTS }: { initial?: Plan }) {
  const { state, transact } = useTestProjection(initial);
  const budget = state.scenario.plan;
  return (
    <>
      <BudgetEditor budget={budget} transact={transact} />
      <output data-testid="ss-claiming-age">{budget.primary.benefitClaimingAge}</output>
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
    enterNumber(input, 70);
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("70");
  });

  it("clamps a typed value above the 62–70 window down to 70 on blur", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i);
    // Typing flows through the FIELD freely — intermediate digits are never fought — but the
    // plan hears nothing until the field is committed, so 95 never becomes a claiming age.
    fireEvent.change(input, { target: { value: "95" } });
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("67");
    fireEvent.blur(input);
    expect(screen.getByTestId("ss-claiming-age").textContent).toBe("70");
  });

  it("clamps a typed value below the 62–70 window up to 62 on blur", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Social Security claiming age/i);
    enterNumber(input, 50);
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

describe("BudgetEditor — no retirement age to author", () => {
  it("offers no retirement-age field at all", () => {
    // Not merely unwired — absent. Each job states its own end, and when the household COULD
    // stop working is solved and shown in the Retirement panel; a field here could only ever
    // state a third thing that contradicted one of them.
    render(<Harness />);
    expect(screen.queryByLabelText(/Retirement age/i)).toBeNull();
  });

  it("chains current age to one year below life expectancy — the two never meet", () => {
    // A gap of one, not head to head. An expectancy equal to the age you already are says you
    // are already dead: the engine refuses it, so a form clamping to 70 here would commit a
    // value the very next write rejected and the field would snap back to where it started.
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, lifeExpectancy: 70 } }} />);
    const input = screen.getByLabelText(/Current age/i) as HTMLInputElement;
    enterNumber(input, 80);
    fireEvent.blur(input);
    expect(input.value).toBe("69");
  });
});

describe("BudgetEditor — no age can outrun the engine's own ceiling", () => {
  it("clamps life expectancy to MAX_AGE, so the field can never author a plan the engine refuses", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Life expectancy/i) as HTMLInputElement;
    // A digit too many — the exact typo the bound exists for. It commits at the ceiling
    // rather than asking the engine to simulate nine centuries of months.
    enterNumber(input, 950);
    expect(input.value).toBe(String(MAX_AGE));
  });

  it("gives each age field the engine's ceiling for that field, not one shared number", () => {
    // Read off the rendered `max` attributes rather than restated here: a field whose bound
    // drifted from the engine's would be caught by this, not by a comment. A form that let
    // through what the engine refuses would throw on commit instead of clamping.
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, lifeExpectancy: 100 } }} />);
    const maxOf = (name: RegExp) => Number((screen.getByLabelText(name) as HTMLInputElement).max);
    // Current age chains to one year below life expectancy, itself below its own 119 ceiling.
    // Both stay at or under what the engine would accept.
    expect(maxOf(/Current age/i)).toBe(99);
    expect(maxOf(/Life expectancy/i)).toBe(MAX_AGE);
    expect(maxOf(/Social Security claiming age/i)).toBe(AGE_LIMITS.benefitClaimingAge);
  });

  it("stops current age one year below the ceiling — a person of 120 has no plan left", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, lifeExpectancy: MAX_AGE } }} />);
    const input = screen.getByLabelText(/Current age/i) as HTMLInputElement;
    expect(Number(input.max)).toBe(MAX_LIVED_AGE);
    enterNumber(input, 200);
    expect(input.value).toBe(String(MAX_LIVED_AGE));
  });
});
