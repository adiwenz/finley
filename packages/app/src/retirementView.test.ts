import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  projectScenario,
  realNetWorthSurvives,
  solveRetirement,
  scenarioOf,
  createProjectionBase,
  addEvent,
  emptyLedger,
  PRIMARY_PERSON_ID,
  type ProjectionContext,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { retirementView } from "./retirementView";
import { PLAN_DEFAULTS } from "./planDefaults";
import { START_YEAR } from "./config";
import type { Plan } from "@finley/engine";

/** The real-jurisdiction projection environment these #37 acceptance tests run against. */
const CTX: ProjectionContext = { jurisdiction: usJurisdiction, startYear: START_YEAR };

/**
 * The retirement view for a plan with no timeline events — the #37 baseline. These
 * acceptance tests pin the panel against the bare authored plan; the event-aware path
 * (a ledger that moves the age) is covered by its own test below.
 */
function viewOf(plan: Plan) {
  return retirementView(scenarioOf(plan));
}

/** Does the plan survive when retiring at exactly `age`? Runs the real projection. */
function survivesAt(budget: Plan, age: number): boolean {
  return realNetWorthSurvives(projectScenario(scenarioOf({ ...budget, retirementAge: age }), CTX));
}

describe("retirementView — headline age driven off the real projection (#37)", () => {
  it("reports a feasible headline age that actually survives in the projection", () => {
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.headlineAge).not.toBeNull();
    const age = view.headlineAge as number;
    // The headline is the earliest age whose real net worth lasts to life expectancy.
    expect(survivesAt(PLAN_DEFAULTS, age)).toBe(true);
    // …and one year earlier does not — it is genuinely the threshold.
    expect(survivesAt(PLAN_DEFAULTS, age - 1)).toBe(false);
  });

  it("the month offset is (age − now) × 12, floored at 0 — the chart reference line", () => {
    const view = viewOf(PLAN_DEFAULTS);
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
    expect(viewOf(PLAN_DEFAULTS).headlineAge).toBe(firstSurviving);
  });

  it("reports no feasible headline when the money can never last", () => {
    const broke: Plan = {
      ...PLAN_DEFAULTS,
      openingBalanceCents: 0,
      incomeCents: 0,
      expenseCents: PLAN_DEFAULTS.expenseCents,
    };
    const view = viewOf(broke);
    expect(view.headlineAge).toBeNull();
    expect(view.headlineMonth).toBeNull();
  });

  // Regression guard for the concrete harm in #28: the $60k home down-payment goal
  // (disposition `convertToEquity`, target month 60) must NOT compound as a phantom
  // drawable fund and overstate how early the household can retire. The panel/graph
  // agreement tests above only check INTERNAL consistency — they would still pass at
  // an inflated age if the fund leaked back into the nest egg. This pins the absolute
  // correction and shows the disposition is what drives it.
  it("the convertToEquity down-payment fund drops out of the nest egg (no phantom-fund overstatement, #28)", () => {
    // With the fund correctly swapped to illiquid equity at maturity, the earliest
    // feasible (partial retirement) age is 63 — agreeing with the tracer-bullet panel
    // (was an inflated 62).
    expect(solveRetirement(scenarioOf(PLAN_DEFAULTS), CTX).partialRetirementAge).toBe(63);

    // Counterfactual: had the same fund been `drawDown` (drawable — the pre-#28
    // behavior where a matured one-time fund kept compounding in the portfolio), the
    // phantom balance would let the household retire strictly EARLIER. That the two
    // ages differ is the whole point: disposition governs retirement-portfolio inclusion.
    const asDrawableFund: Plan = {
      ...PLAN_DEFAULTS,
      goals: PLAN_DEFAULTS.goals.map((g) =>
        g.id === "home" ? { ...g, disposition: "drawDown" as const } : g,
      ),
    };
    const phantomAge = solveRetirement(scenarioOf(asDrawableFund), CTX).partialRetirementAge;
    expect(phantomAge).not.toBeNull();
    expect(phantomAge as number).toBeLessThan(63);
  });
});

describe("retirementView — target mode against the pinned age (§7.1)", () => {
  it("reports the pinned age on track (100%) when the plan survives there", () => {
    // The default plan retires at 65, comfortably above the feasible floor.
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.target.feasible).toBe(true);
    expect(view.target.nearestFeasibleAge).toBe(PLAN_DEFAULTS.retirementAge);
    expect(view.targetOnTrackPct).toBe(100);
  });

  it("falls short of 100% and points to the nearest feasible age when the pin can't survive", () => {
    // Pin a retirement age below the feasible floor: infeasible, on-track < 100%, and
    // the nearest feasible age is exactly the full-retirement headline the solver finds
    // (the pin is graded by the same full-retirement rule as the headline).
    const pinnedTooEarly: Plan = { ...PLAN_DEFAULTS, retirementAge: PLAN_DEFAULTS.currentAge };
    const view = viewOf(pinnedTooEarly);
    expect(view.target.feasible).toBe(false);
    expect(view.targetOnTrackPct).toBeLessThan(100);
    expect(view.target.nearestFeasibleAge).toBe(view.headlineAge);
    expect(view.target.nearestFeasibleAge).toBe(
      solveRetirement(scenarioOf(pinnedTooEarly), CTX).fullRetirementAge,
    );
  });

  it("keeps the on-track % within [0, 100]", () => {
    const view = viewOf({ ...PLAN_DEFAULTS, retirementAge: PLAN_DEFAULTS.currentAge });
    expect(view.targetOnTrackPct).toBeGreaterThanOrEqual(0);
    expect(view.targetOnTrackPct).toBeLessThanOrEqual(100);
  });
});

describe("retirementView — early-retiree health-cost honesty flag (§5.4, Medicare)", () => {
  it("does NOT flag a plan that retires at the Medicare age (no self-funded gap)", () => {
    const view = viewOf({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(view.earlyRetireeHealth.flagged).toBe(false);
    expect(view.earlyRetireeHealth.gapYears).toBe(0);
  });

  it("flags an early retirement whose authored health cost is below the pre-65 benchmark", () => {
    const view = viewOf({
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
    const view = viewOf({
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: dollarsToCents(5000),
    });
    expect(view.earlyRetireeHealth.flagged).toBe(false);
    expect(view.earlyRetireeHealth.shortfallMonthlyCents).toBe(0);
  });

  it("prices the benchmark in today's dollars — independent of how far off retirement is (§0.5)", () => {
    const near = viewOf({
      ...PLAN_DEFAULTS,
      currentAge: 60,
      retirementAge: 62,
      healthMonthlyCents: 0,
    });
    const far = viewOf({
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
    const view = viewOf({ ...PLAN_DEFAULTS, currentAge: 65 });
    expect(view.residualHealthMonthlyCents).toBe(dollarsToCents(500));
  });

  it("is present regardless of retirement age (the step is always shown, not just for early retirees)", () => {
    const early = viewOf({ ...PLAN_DEFAULTS, retirementAge: 55 });
    const late = viewOf({ ...PLAN_DEFAULTS, retirementAge: 70 });
    expect(early.residualHealthMonthlyCents).toBeGreaterThan(0);
    expect(late.residualHealthMonthlyCents).toBeGreaterThan(0);
  });

  it("prices the residual in today's dollars — independent of when the person reaches 65 (§0.5)", () => {
    const soon = viewOf({ ...PLAN_DEFAULTS, currentAge: 60 });
    const later = viewOf({ ...PLAN_DEFAULTS, currentAge: 35 });
    expect(later.residualHealthMonthlyCents).toBe(soon.residualHealthMonthlyCents);
    expect(later.residualHealthMonthlyCents).toBe(dollarsToCents(500));
  });

  it("stays below the pre-65 self-funded benchmark (the step at 65 is downward)", () => {
    const view = viewOf({ ...PLAN_DEFAULTS, retirementAge: 55, healthMonthlyCents: 0 });
    expect(view.earlyRetireeHealth.shortfallMonthlyCents).toBeGreaterThan(
      view.residualHealthMonthlyCents,
    );
  });

  it("does NOT enrol → residual 0 and the self-funded-for-life story", () => {
    const view = viewOf({ ...PLAN_DEFAULTS, enrollsInPublicHealthCoverage: false });
    expect(view.residualHealthMonthlyCents).toBe(0);
    expect(view.enrollsInPublicHealthCoverage).toBe(false);
  });
});

describe("retirementView — the timeline events count toward retirement (issue #66)", () => {
  // The whole point of coupling the plan with its ledger: "when can we retire?" must
  // reason about the plan PLUS the events on the user's timeline, exactly as the graph
  // does — not the bare plan. Add a costly recurring expense to the ledger (e.g. the
  // cost of a new child) and the headline retirement age has to move LATER. If the panel
  // still projected an empty ledger, the age would not budge.
  it("a recurring expense added to the ledger pushes the headline age later", () => {
    // Attach an $800/mo childcare expense from now, the way the app's AddEventForm would.
    const base = createProjectionBase(PLAN_DEFAULTS, CTX);
    const added = addEvent(
      emptyLedger,
      base,
      {
        id: "new-child-costs",
        type: "BudgetItemStartEvent",
        month: 0,
        seriesId: "childcare",
        ownerId: PRIMARY_PERSON_ID,
        seriesType: "expense",
        monthlyCents: dollarsToCents(800),
        growthMode: { type: "fixed" },
      },
      usJurisdiction,
    );
    // Precondition: the event is valid and actually enters the ledger.
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const baselineAge = viewOf(PLAN_DEFAULTS).headlineAge;
    const withChildAge = retirementView({ plan: PLAN_DEFAULTS, ledger: added.ledger }).headlineAge;
    // The bare-plan baseline retires at 63; the scenario carrying the childcare expense
    // must retire strictly later. If the panel still projected an empty ledger, the two
    // would be equal — this is the regression guard for that.
    expect(baselineAge).toBe(63);
    expect(withChildAge as number).toBeGreaterThan(63);
  });
});
