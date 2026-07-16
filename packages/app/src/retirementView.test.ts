import { describe, it, expect } from "vitest";
import { dollarsToCents } from "@finley/engine";
import { retirementView } from "./retirementView";
import {
  projectPlan,
  realNetWorthSurvives,
  earliestFeasibleRetirementAge,
} from "./retirementSolver";
import { PLAN_DEFAULTS } from "./planDefaults";
import type { Plan } from "@finley/engine";

/** Does the plan survive when retiring at exactly `age`? Runs the real projection. */
function survivesAt(budget: Plan, age: number): boolean {
  return realNetWorthSurvives(projectPlan({ ...budget, retirementAge: age }));
}

describe("retirementView — headline age driven off the real projection (#37)", () => {
  it("reports a feasible headline age that actually survives in the projection", () => {
    const view = retirementView(PLAN_DEFAULTS);
    expect(view.headlineAge).not.toBeNull();
    const age = view.headlineAge as number;
    // The headline is the earliest age whose real net worth lasts to life expectancy.
    expect(survivesAt(PLAN_DEFAULTS, age)).toBe(true);
    // …and one year earlier does not — it is genuinely the threshold.
    expect(survivesAt(PLAN_DEFAULTS, age - 1)).toBe(false);
  });

  it("the month offset is (age − now) × 12, floored at 0 — the chart reference line", () => {
    const view = retirementView(PLAN_DEFAULTS);
    const age = view.headlineAge as number;
    expect(view.headlineMonth).toBe((age - PLAN_DEFAULTS.currentAge) * 12);
  });

  it("panel age == the first projection age that survives (panel and graph agree, #37)", () => {
    // Sweep every age from now to life expectancy and take the first that survives on
    // the same projection the net-worth graph draws; the panel must report exactly it.
    let firstSurviving: number | null = null;
    for (let age = PLAN_DEFAULTS.currentAge; age <= PLAN_DEFAULTS.lifeExpectancy; age++) {
      if (survivesAt(PLAN_DEFAULTS, age)) {
        firstSurviving = age;
        break;
      }
    }
    expect(retirementView(PLAN_DEFAULTS).headlineAge).toBe(firstSurviving);
  });

  it("reports no feasible headline when the money can never last", () => {
    const broke: Plan = {
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

describe("retirementView — target mode against the pinned age (§7.1)", () => {
  it("reports the pinned age on track (100%) when the plan survives there", () => {
    // The default plan retires at 65, comfortably above the feasible floor.
    const view = retirementView(PLAN_DEFAULTS);
    expect(view.target.feasible).toBe(true);
    expect(view.target.nearestFeasibleAge).toBe(PLAN_DEFAULTS.retirementAge);
    expect(view.targetOnTrackPct).toBe(100);
  });

  it("falls short of 100% and points to the nearest feasible age when the pin can't survive", () => {
    // Pin a retirement age below the feasible floor: infeasible, on-track < 100%, and
    // the nearest feasible age is exactly the headline the solver finds.
    const pinnedTooEarly: Plan = { ...PLAN_DEFAULTS, retirementAge: PLAN_DEFAULTS.currentAge };
    const view = retirementView(pinnedTooEarly);
    expect(view.target.feasible).toBe(false);
    expect(view.targetOnTrackPct).toBeLessThan(100);
    expect(view.target.nearestFeasibleAge).toBe(earliestFeasibleRetirementAge(pinnedTooEarly));
  });

  it("keeps the on-track % within [0, 100]", () => {
    const view = retirementView({ ...PLAN_DEFAULTS, retirementAge: PLAN_DEFAULTS.currentAge });
    expect(view.targetOnTrackPct).toBeGreaterThanOrEqual(0);
    expect(view.targetOnTrackPct).toBeLessThanOrEqual(100);
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
    const soon = retirementView({ ...PLAN_DEFAULTS, currentAge: 60 });
    const later = retirementView({ ...PLAN_DEFAULTS, currentAge: 35 });
    expect(later.medicareResidualMonthlyCents).toBe(soon.medicareResidualMonthlyCents);
    expect(later.medicareResidualMonthlyCents).toBe(dollarsToCents(500));
  });

  it("stays below the pre-65 self-funded benchmark (the step at 65 is downward)", () => {
    const view = retirementView({ ...PLAN_DEFAULTS, retirementAge: 55, healthMonthlyCents: 0 });
    expect(view.earlyRetireeHealth.shortfallMonthlyCents).toBeGreaterThan(
      view.medicareResidualMonthlyCents,
    );
  });

  it("does NOT enrol → residual 0 and the self-funded-for-life story", () => {
    const view = retirementView({ ...PLAN_DEFAULTS, enrollsInMedicare: false });
    expect(view.medicareResidualMonthlyCents).toBe(0);
    expect(view.enrollsInMedicare).toBe(false);
  });
});
