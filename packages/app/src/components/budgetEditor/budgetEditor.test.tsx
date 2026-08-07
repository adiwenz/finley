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
import { START_YEAR } from "../../config";
import { AGE_LIMITS, MAX_AGE, MAX_LIVED_AGE } from "@finley/engine";
import type { Job, Plan } from "@finley/engine";

afterEach(cleanup);

/** A controlled harness so edits round-trip through the real facade. */
function Harness({ initial = PLAN_DEFAULTS }: { initial?: Plan }) {
  const { state, transact } = useTestProjection(initial);
  const budget = state.scenario.plan;
  return (
    <>
      <BudgetEditor budget={budget} transact={transact} />
      <output data-testid="ss-claiming-age">{budget.primary.benefitClaimingAge}</output>
      {/* The plan's jobs as this panel left them — a birth-year edit is a job edit too. */}
      <output data-testid="jobs">{JSON.stringify(budget.primary.jobs)}</output>
      <output data-testid="expectancy">{budget.primary.lifeExpectancy}</output>
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

/**
 * The two age fields reach the engine's own rules about jobs, because a job is dated against the
 * person these fields describe. Both directions are pinned here, at the surface a user actually
 * moves them from.
 */
describe("BudgetEditor — the age fields against the primary's own jobs", () => {
  /** The plan's lone job, read back off the harness. */
  const job = () => (JSON.parse(screen.getByTestId("jobs").textContent || "[]") as Job[])[0]!;
  it("carries the jobs when the CURRENT AGE moves — calendar years shift, ages hold", () => {
    // The default job runs 2009–2056, ages 18–65. Re-aging Alex to 45 moves the birth year ten
    // years back, so the employment moves with it and the ages the user authored are untouched.
    render(<Harness />);
    expect([job().startYear, job().endYear]).toEqual([2009, 2056]);

    enterNumber(screen.getByLabelText(/Current age/i), "45");

    // Born 1981 now, so the same two ages read back off the moved years.
    const birthYear = START_YEAR - 45;
    expect([job().startYear, job().endYear]).toEqual([1999, 2046]);
    expect([job().startYear - birthYear, job().endYear - birthYear]).toEqual([18, 65]);
  });

  it("refuses a LIFE EXPECTANCY that lands before the job ends, and the field snaps back", () => {
    // The job is worked to 65, so an expectancy of 60 would have Alex dead with three years of
    // employment still authored. The engine refuses it; nothing on the plan moves, and the
    // controlled field re-renders from the plan rather than keeping a value that never landed.
    render(<Harness />);
    const expectancy = screen.getByLabelText(/Life expectancy/i) as HTMLInputElement;
    enterNumber(expectancy, "60");

    expect(screen.getByTestId("expectancy").textContent).toBe("90");
    expect(expectancy.value).toBe("90");
    expect([job().startYear, job().endYear]).toEqual([2009, 2056]);
  });

  it("accepts an expectancy that reaches exactly the job's end", () => {
    // Alex dies the year the job ends: the last month worked is the last month lived, which the
    // containment rule allows. The boundary is where an off-by-one would bite.
    render(<Harness />);
    enterNumber(screen.getByLabelText(/Life expectancy/i), "65");
    expect(screen.getByTestId("expectancy").textContent).toBe("65");
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

  it("floors life expectancy at the primary's own age plus one, with no fixed minimum under it", () => {
    // The defaults make Alex 35. A `Math.max(60, …)` used to sit under this field, so a plan
    // could not state an expectancy below 60 however young the person was — a bound the engine
    // does not have. The floor is the gap of one and nothing else.
    render(<Harness />);
    expect(Number((screen.getByLabelText(/Life expectancy/i) as HTMLInputElement).min)).toBe(36);
    cleanup();

    // And a value under 60 commits. Authored on a plan with no job, because the default one is
    // worked to 65 and a job must end while its owner is alive — that refusal is a different
    // rule, and it would mask this one.
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, jobs: [] } }} />);
    const expectancy = screen.getByLabelText(/Life expectancy/i) as HTMLInputElement;
    enterNumber(expectancy, "40");
    expect(expectancy.value).toBe("40");
  });

  it("stops current age one year below the ceiling — a person of 120 has no plan left", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, primary: { ...PLAN_DEFAULTS.primary, lifeExpectancy: MAX_AGE } }} />);
    const input = screen.getByLabelText(/Current age/i) as HTMLInputElement;
    expect(Number(input.max)).toBe(MAX_LIVED_AGE);
    enterNumber(input, 200);
    expect(input.value).toBe(String(MAX_LIVED_AGE));
  });
});
