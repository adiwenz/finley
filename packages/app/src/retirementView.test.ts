import { describe, it, expect } from "vitest";
import { portfolioSurvives } from "@finley/engine";
import { buildRetirementScenario, retirementView } from "./retirementView";
import { PLAN_DEFAULTS } from "./planDefaults";
import { INFLATION } from "./config";
import { PRIMARY_PERSON_ID } from "./projectionBase";

describe("buildRetirementScenario — plan → §7 scenario mapping", () => {
  it("de-inflates a portfolio-wide blend of the account rates to a real rate (§0.5)", () => {
    const blendNominal =
      (PLAN_DEFAULTS.savingsReturnPct +
        PLAN_DEFAULTS.retirementReturnPct +
        PLAN_DEFAULTS.brokerageReturnPct) /
      3 /
      100;
    const expectedReal = (1 + blendNominal) / (1 + INFLATION) - 1;
    const scenario = buildRetirementScenario(PLAN_DEFAULTS);
    expect(scenario.realReturnRate).toBeCloseTo(expectedReal, 10);
    // A real rate below the nominal blend is the whole point of the conversion.
    expect(scenario.realReturnRate).toBeLessThan(blendNominal);
  });

  it("blends ALL standing-account rates, not just the retirement rate", () => {
    const budget = {
      ...PLAN_DEFAULTS,
      savingsReturnPct: 2,
      retirementReturnPct: 8,
      brokerageReturnPct: 5,
    };
    const blendNominal = (2 + 8 + 5) / 3 / 100;
    const scenario = buildRetirementScenario(budget);
    expect(scenario.realReturnRate).toBeCloseTo((1 + blendNominal) / (1 + INFLATION) - 1, 10);
    // Distinctly different from using the retirement rate (8%) alone.
    expect(scenario.realReturnRate).not.toBeCloseTo((1 + 0.08) / (1 + INFLATION) - 1, 6);
  });

  it("annualises the monthly income/expense and carries the pinned ages through", () => {
    const scenario = buildRetirementScenario(PLAN_DEFAULTS);
    expect(scenario.persons).toHaveLength(1);
    const p = scenario.persons[0];
    expect(p.id).toBe(PRIMARY_PERSON_ID);
    expect(p.annualEmploymentIncomeCents).toBe(PLAN_DEFAULTS.incomeCents * 12);
    expect(scenario.annualExpenseCents).toBe(PLAN_DEFAULTS.expenseCents * 12);
    expect(p.currentAge).toBe(PLAN_DEFAULTS.currentAge);
    expect(p.lifeExpectancy).toBe(PLAN_DEFAULTS.lifeExpectancy);
    expect(p.ssClaimingAge).toBe(PLAN_DEFAULTS.ssClaimingAge);
    expect(p.plannedRetirementAge).toBe(PLAN_DEFAULTS.retirementAge);
  });
});

describe("retirementView — headline + chart reference line + target", () => {
  it("exposes a feasible headline age that actually survives, and its month offset", () => {
    const view = retirementView(PLAN_DEFAULTS);
    expect(view.headlineAge).not.toBeNull();
    const age = view.headlineAge as number;
    // The month offset is (age - now) * 12, floored at 0 — the chart reference line.
    expect(view.headlineMonth).toBe((age - PLAN_DEFAULTS.currentAge) * 12);
    // The headline age must genuinely survive under the mapped scenario.
    const scenario = buildRetirementScenario(PLAN_DEFAULTS);
    expect(
      portfolioSurvives(scenario, new Map([[PRIMARY_PERSON_ID, age]])).survives,
    ).toBe(true);
  });

  it("caps the target on-track % at 100 and keeps it non-negative (§7.1)", () => {
    const view = retirementView(PLAN_DEFAULTS);
    expect(view.targetOnTrackPct).toBeLessThanOrEqual(100);
    expect(view.targetOnTrackPct).toBeGreaterThanOrEqual(0);
  });

  it("reports no feasible headline when the money can never last", () => {
    const broke = {
      ...PLAN_DEFAULTS,
      openingBalanceCents: 0,
      incomeCents: 0,
      expenseCents: PLAN_DEFAULTS.expenseCents,
    };
    const view = retirementView(broke);
    expect(view.headlineAge).toBeNull();
    expect(view.headlineMonth).toBeNull();
  });
});
