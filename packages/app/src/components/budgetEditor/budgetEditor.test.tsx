/**
 * @vitest-environment jsdom
 *
 * Coverage for the Budget/Accounts editor's Social Security claiming-age control
 * (§5.4). The claiming age is a pinned retirement input the solver reads (benefits
 * begin at that age); this pins the app-side lever that edits it, its 62–70 bound,
 * and the estimates-not-advice disclaimer the issue requires alongside it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { dollarsToCents } from "@finley/engine";
import { BudgetEditor } from "./budgetEditor";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

afterEach(cleanup);

/** A controlled harness so edits round-trip through real budget state. */
function Harness({ initial = PLAN_DEFAULTS }: { initial?: Plan }) {
  const [budget, setBudget] = useState<Plan>(initial);
  return (
    <>
      <BudgetEditor budget={budget} setBudget={setBudget} scrubMonth={0} />
      <output data-testid="ss-claiming-age">{budget.ssClaimingAge}</output>
      <output data-testid="career-start-age">{budget.careerStartAge}</output>
      <output data-testid="retirement-age">{budget.retirementAge}</output>
      <output data-testid="health-inflation">{budget.healthInflationPct}</output>
      <output data-testid="enrolls">{String(budget.enrollsInPublicHealthCoverage)}</output>
    </>
  );
}

describe("BudgetEditor — Social Security claiming age (§5.4)", () => {
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

  it("edits flow back into ssClaimingAge (delaying the claim to 70)", () => {
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
    // Several fields carry the disclaimer (SS and health); at least one is present.
    expect(screen.getAllByText(/not advice/i).length).toBeGreaterThan(0);
  });
});

describe("BudgetEditor — career start age (§4.6/§5.4, #41)", () => {
  it("shows the career-start-age control seeded from the plan (default 18)", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Career start age/i) as HTMLInputElement;
    expect(input.value).toBe("18");
  });

  it("edits flow back into careerStartAge (started working at 25)", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Career start age/i);
    fireEvent.change(input, { target: { value: "25" } });
    expect(screen.getByTestId("career-start-age").textContent).toBe("25");
  });

  it("caps the control at the current age — no future working years to seed", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, currentAge: 35 }} />);
    const input = screen.getByLabelText(/Career start age/i);
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("career-start-age").textContent).toBe("35");
  });
});

describe("BudgetEditor — health cost + its own inflation rate (§5.4)", () => {
  it("shows the health-inflation control seeded from the plan", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Health cost increase/i) as HTMLInputElement;
    expect(input.value).toBe(String(PLAN_DEFAULTS.healthInflationPct));
  });

  it("edits flow back into healthInflationPct", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Health cost increase/i);
    fireEvent.change(input, { target: { value: "7" } });
    expect(screen.getByTestId("health-inflation").textContent).toBe("7");
  });

  it("shows the pre-65 and from-65 health lines when enrolling in Medicare", () => {
    render(<Harness />);
    expect(screen.getByLabelText(/health care \(before 65\)/i)).toBeTruthy();
    expect(screen.getByLabelText(/health care \(from 65\)/i)).toBeTruthy();
  });

  it("hides the from-65 residual when self-funding for life", () => {
    render(<Harness initial={{ ...PLAN_DEFAULTS, enrollsInPublicHealthCoverage: false }} />);
    expect(screen.queryByLabelText(/health care \(from 65\)/i)).toBeNull();
  });

  it("toggles enrolment back into the plan", () => {
    render(<Harness />);
    const select = screen.getByLabelText(/Medicare at 65/i);
    fireEvent.change(select, { target: { value: "self-fund" } });
    expect(screen.getByTestId("enrolls").textContent).toBe("false");
  });
});

describe("BudgetEditor — 401(k) deferral over the IRS limit (§5.4)", () => {
  it("discloses that contributions above the annual limit are paid as taxable income", () => {
    // $5,000/mo = $60k/yr; a 50% deferral is $30k, above the 2026 $24,500 elective limit.
    render(<Harness initial={{ ...PLAN_DEFAULTS, retirementDeferralPct: 50 }} />);
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
  });

  it("shows no such disclosure when the deferral stays under the limit", () => {
    render(<Harness />); // default 0% deferral
    expect(screen.queryByText(/paid as taxable income/i)).toBeNull();
  });

  it("discloses a crossing that only happens in a later year as income inflates", () => {
    // $48k/yr at 50% = $24k, under the $24,500 limit today but past it within a few
    // years (3% income growth vs 2.5% limit indexing) — the precise-scan case.
    render(
      <Harness
        initial={{
          ...PLAN_DEFAULTS,
          incomeCents: dollarsToCents(4000),
          retirementDeferralPct: 50,
          inflationPct: 3,
          currentAge: 35,
          retirementAge: 65,
        }}
      />,
    );
    expect(screen.getByText(/paid as taxable income/i)).toBeTruthy();
  });
});

describe("BudgetEditor — retirement age (§7)", () => {
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
    // Current age 50 sits above the static 40 floor, so it becomes the binding
    // lower bound: a retirement age below it is nonsensical and clamps up to 50.
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
