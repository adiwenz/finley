import { describe, it, expect } from "vitest";
import { portfolioSurvives, dollarsToCents } from "@finley/engine";
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

  it("computes SS from the AIME→PIA formula (real dollars), not a flat authored figure", () => {
    // With no authored override, the panel prices SS from the plan's full-career
    // earnings — the same seam the graph uses — deflated to today's dollars. For the
    // default $60k earner this is a realistic replacement above the old $24k flat
    // figure, and necessarily below the salary itself.
    const p = buildRetirementScenario(PLAN_DEFAULTS).persons[0];
    expect(p.annualSocialSecurityCents).toBeGreaterThan(dollarsToCents(24_000));
    expect(p.annualSocialSecurityCents).toBeLessThan(PLAN_DEFAULTS.incomeCents * 12);
  });

  it("honors an authored Social Security override when the plan pins one (SSA statement)", () => {
    const p = buildRetirementScenario({
      ...PLAN_DEFAULTS,
      socialSecurityAnnualCents: dollarsToCents(30_000),
    }).persons[0];
    expect(p.annualSocialSecurityCents).toBe(dollarsToCents(30_000));
  });

  it("yields a $0 SS benefit for a plan with no earnings (empty record)", () => {
    const p = buildRetirementScenario({ ...PLAN_DEFAULTS, incomeCents: 0 }).persons[0];
    expect(p.annualSocialSecurityCents).toBe(0);
  });

  it("carries per-person health as a separate additive component that grows net of general inflation (§5.4)", () => {
    const p = buildRetirementScenario(PLAN_DEFAULTS).persons[0];
    // Health rides on the person, alongside general household spend, not inside it.
    expect(p.annualHealthExpenseCents).toBe(PLAN_DEFAULTS.healthMonthlyCents * 12);
    // Real growth is the health rate net of CPI: with health == CPI it is ~0 (health
    // holds constant in real terms).
    const expectedRealGrowth =
      (1 + PLAN_DEFAULTS.healthInflationPct / 100) / (1 + PLAN_DEFAULTS.inflationPct / 100) - 1;
    expect(p.healthRealGrowthRate).toBeCloseTo(expectedRealGrowth, 10);
  });

  it("grows health in real terms only when its rate outpaces CPI (§5.4)", () => {
    const faster = buildRetirementScenario({ ...PLAN_DEFAULTS, healthInflationPct: 6, inflationPct: 3 });
    const equal = buildRetirementScenario({ ...PLAN_DEFAULTS, healthInflationPct: 3, inflationPct: 3 });
    expect(faster.persons[0].healthRealGrowthRate as number).toBeGreaterThan(0);
    expect(equal.persons[0].healthRealGrowthRate as number).toBeCloseTo(0, 10);
  });

  it("sets the Medicare step when enrolling: eligibility age 65 and the authored residual (§5.4)", () => {
    const p = buildRetirementScenario(PLAN_DEFAULTS).persons[0];
    expect(p.medicareEligibilityAge).toBe(65);
    // The residual is the user's authored figure (today's dollars), not a fraction.
    expect(p.postMedicareHealthAnnualCents).toBe(PLAN_DEFAULTS.postMedicareHealthMonthlyCents * 12);
  });

  it("leaves the eligibility age unset when not enrolling — self-funded for life (§5.4)", () => {
    const p = buildRetirementScenario({ ...PLAN_DEFAULTS, enrollsInMedicare: false }).persons[0];
    expect(p.medicareEligibilityAge).toBeUndefined();
    expect(p.postMedicareHealthAnnualCents).toBeUndefined();
    // The pre-65 line is still present — it just runs for life.
    expect(p.annualHealthExpenseCents).toBe(PLAN_DEFAULTS.healthMonthlyCents * 12);
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

describe("retirementView — early-retiree health-cost honesty flag (§5.4, Medicare)", () => {
  it("does NOT flag a plan that retires at the Medicare age (no self-funded gap)", () => {
    const view = retirementView({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(view.earlyRetireeHealth.flagged).toBe(false);
    expect(view.earlyRetireeHealth.gapYears).toBe(0);
  });

  it("flags an early retirement whose authored health cost is below the pre-65 benchmark", () => {
    const view = retirementView({
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: 0,
    });
    expect(view.earlyRetireeHealth.flagged).toBe(true);
    // Ten self-funded years (55 → 65) before Medicare.
    expect(view.earlyRetireeHealth.gapYears).toBe(10);
    // The shortfall is the whole (indexed) pre-65 benchmark, since nothing is budgeted.
    expect(view.earlyRetireeHealth.shortfallMonthlyCents).toBeGreaterThan(0);
  });

  it("does NOT flag an early retiree who already budgets at least the benchmark", () => {
    const view = retirementView({
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: dollarsToCents(5000),
    });
    expect(view.earlyRetireeHealth.flagged).toBe(false);
    expect(view.earlyRetireeHealth.shortfallMonthlyCents).toBe(0);
  });

  it("prices the benchmark in today's dollars — independent of how far off retirement is (§0.5)", () => {
    // The panel is a real / today's-dollars surface, so the same retirement age must
    // yield the same shortfall whether it lands 2 years out or decades out; the
    // benchmark is NOT inflated to the future retirement year (that would pit a
    // nominal 2040s cost against a today's-dollars health budget).
    const near = retirementView({
      ...PLAN_DEFAULTS,
      currentAge: 60,
      retirementAge: 62,
      healthMonthlyCents: 0,
    });
    const far = retirementView({
      ...PLAN_DEFAULTS,
      currentAge: 35,
      retirementAge: 62,
      healthMonthlyCents: 0,
    });
    expect(far.earlyRetireeHealth.shortfallMonthlyCents).toBe(
      near.earlyRetireeHealth.shortfallMonthlyCents,
    );
    // And it is the base-year benchmark, not an inflated one: $1,200 − $0 budgeted.
    expect(far.earlyRetireeHealth.shortfallMonthlyCents).toBe(dollarsToCents(1_200));
  });
});

describe("retirementView — attributed Medicare residual step (§5.4, visible at 65)", () => {
  it("surfaces the ~$500/mo residual step in today's dollars", () => {
    const view = retirementView({ ...PLAN_DEFAULTS, currentAge: 65 });
    expect(view.medicareResidualMonthlyCents).toBe(dollarsToCents(500));
  });

  it("is present regardless of retirement age (the step is always shown, not just for early retirees)", () => {
    const early = retirementView({ ...PLAN_DEFAULTS, retirementAge: 55 });
    const late = retirementView({ ...PLAN_DEFAULTS, retirementAge: 70 });
    expect(early.medicareResidualMonthlyCents).toBeGreaterThan(0);
    expect(late.medicareResidualMonthlyCents).toBeGreaterThan(0);
  });

  it("prices the residual in today's dollars — independent of when the person reaches 65 (§0.5)", () => {
    // The panel is a today's-dollars surface, so the residual is the base figure
    // whether Medicare is 5 or 30 years away — not inflated to that future year.
    const soon = retirementView({ ...PLAN_DEFAULTS, currentAge: 60 });
    const later = retirementView({ ...PLAN_DEFAULTS, currentAge: 35 });
    expect(later.medicareResidualMonthlyCents).toBe(soon.medicareResidualMonthlyCents);
    expect(later.medicareResidualMonthlyCents).toBe(dollarsToCents(500));
  });

  it("stays below the pre-65 self-funded benchmark (the step at 65 is downward)", () => {
    const view = retirementView({ ...PLAN_DEFAULTS, retirementAge: 55, healthMonthlyCents: 0 });
    // The pre-65 shortfall (whole benchmark, nothing budgeted) exceeds the residual.
    expect(view.earlyRetireeHealth.shortfallMonthlyCents).toBeGreaterThan(
      view.medicareResidualMonthlyCents,
    );
  });
});
