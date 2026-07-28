import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  projectScenario,
  planSurvives,
  solveRetirement,
  scenarioOf,
  createProjectionBase,
  addEvent,
  emptyLedger,
  PRIMARY_PERSON_ID,
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  buildWithdrawalSources,
  type WithdrawalState,
  type JurisdictionContext,
  type ProjectionContext,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { retirementView } from "./retirementView";
import { PLAN_DEFAULTS } from "./planDefaults";
import { setJobMonthlyIncome } from "./planPeople";
import { START_YEAR } from "./config";
import type { Plan } from "@finley/engine";

const CTX: ProjectionContext = { jurisdiction: usJurisdiction, startYear: START_YEAR };

/** The view for a plan with no timeline events; the event-aware path is tested below. */
function viewOf(plan: Plan) {
  return retirementView(scenarioOf(plan));
}

function survivesAt(budget: Plan, age: number): boolean {
  return planSurvives(projectScenario(scenarioOf({ ...budget, retirementAge: age }), CTX));
}

describe("retirementView — headline age driven off the real projection", () => {
  it("reports a feasible headline age that actually survives in the projection", () => {
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.headlineAge).not.toBeNull();
    const age = view.headlineAge as number;
    expect(survivesAt(PLAN_DEFAULTS, age)).toBe(true);
    // A year earlier does not — the headline is genuinely the threshold.
    expect(survivesAt(PLAN_DEFAULTS, age - 1)).toBe(false);
  });

  it("the month offset is (age − now) × 12, floored at 0 — the chart reference line", () => {
    const view = viewOf(PLAN_DEFAULTS);
    const age = view.headlineAge as number;
    expect(view.headlineMonth).toBe((age - PLAN_DEFAULTS.currentAge) * 12);
  });

  it("panel age == the first projection age that survives (panel and graph agree)", () => {
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
      jobs: [],
      expenseCents: PLAN_DEFAULTS.expenseCents,
    };
    const view = viewOf(broke);
    expect(view.headlineAge).toBeNull();
    expect(view.headlineMonth).toBeNull();
  });
});

describe("retirementView — target mode against the pinned age", () => {
  it("reports the pinned age on track (100%) when the plan survives there", () => {
    // Real single-filer federal tax plus a cash-realistic 1% emergency-fund return lift the
    // default plan's feasible floor to 75.
    const pinnedAtFloor: Plan = { ...PLAN_DEFAULTS, retirementAge: 75 };
    const view = viewOf(pinnedAtFloor);
    expect(view.target.feasible).toBe(true);
    expect(view.target.nearestFeasibleAge).toBe(pinnedAtFloor.retirementAge);
    expect(view.targetOnTrackPct).toBe(100);
  });

  it("falls short of 100% and points to the nearest feasible age when the pin can't survive", () => {
    // Below the feasible floor. The nearest feasible age is the solver's full-retirement
    // headline — the pin is graded by the same rule.
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

  // The default plan pinned at 65 is infeasible (the floor is above 65) yet holds a `retain`
  // home reserve keeping net worth positive throughout — the shape that once pinned the
  // metric to a contradictory "100% of the way there".
  it("never reads 100% for an infeasible plan and rounds the % DOWN to 0.1%", () => {
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.target.feasible).toBe(false);
    expect(view.targetOnTrackPct).toBeLessThan(100);
    expect(view.targetOnTrackPct).toBe(Math.floor(view.target.onTrackFraction * 1000) / 10);
    expect(view.targetOnTrackPct).toBeLessThanOrEqual(view.target.onTrackFraction * 100);
  });
});

describe("retirementView — early-retiree health-cost honesty flag (Medicare)", () => {
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
    // Nothing budgeted, so the shortfall is the whole (indexed) pre-65 benchmark.
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

  it("prices the benchmark in today's dollars — independent of how far off retirement is", () => {
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
    // The base-year benchmark, not an inflated one: $1,200 − $0 budgeted.
    expect(far.earlyRetireeHealth.shortfallMonthlyCents).toBe(dollarsToCents(1_200));
  });
});

describe("retirementView — attributed Medicare residual step (visible at 65)", () => {
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

  it("prices the residual in today's dollars — independent of when the person reaches 65", () => {
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

describe("retirementView — the timeline events count toward retirement", () => {
  // The panel must reason about the plan plus the ledger, as the graph does: if it still
  // projected an empty ledger, a costly new expense would not budge the headline age.
  it("a recurring expense added to the ledger pushes the headline age later", () => {
    // Real single-filer federal tax pins the default $5k plan at the Social-Security floor
    // (67), where an added expense flips it infeasible rather than merely later. The raise
    // buys headroom below the floor, keeping "moves strictly later" observable.
    const plan: Plan = setJobMonthlyIncome(PLAN_DEFAULTS, "job-1", dollarsToCents(7000));
    // Childcare, written as the app's AddEventForm would.
    const base = createProjectionBase(plan, CTX);
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
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const baselineAge = viewOf(plan).headlineAge;
    const withChildAge = retirementView({ plan, ledger: added.ledger }).headlineAge;
    // The bare-plan baseline retires at 60 — the home goal is a drawable `retain` reserve,
    // so the down-payment fund counts toward the nest egg.
    expect(baselineAge).toBe(60);
    expect(withChildAge as number).toBeGreaterThan(60);
  });
});

// No surplus-sweep-vs-idle comparison: `surplusSwept` is gone and leftover cash always
// idles (a household wanting surplus invested authors a brokerage contribution line).

describe("every draw nets its need under the real jurisdiction", () => {
  // The engine's own tests use synthetic jurisdictions (it cannot import the rules
  // package); this proves the seam that ships. Sizing the draw by inverting an implied rate
  // (`need / (1 − rate)`) under-delivered by $500.61 on a $50k need, because a bracket is
  // `offset + rate × draw`, not proportional to the draw.
  it.each([1_000, 5_000, 20_000, 50_000])("nets a $%i need to the cent", (needDollars) => {
    const opening = dollarsToCents(5_000_000);
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: PRIMARY_PERSON_ID,
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: opening,
      initialAnnualRate: 0,
    });
    const state: WithdrawalState = {
      accounts: [brokerage],
      assetBalances: new Map([["brokerage", opening]]),
      // Basis absent → 0 → whole draw taxable, isolating the gross-up arithmetic.
      basisByAccount: new Map(),
      liquidAccount: null,
    };
    const need = dollarsToCents(needDollars);
    const ctx: JurisdictionContext = { year: START_YEAR };
    const { sources } = buildWithdrawalSources(state, usJurisdiction, [], need, ctx);

    // Re-file the draws as a tax return: what does the household keep?
    const byCategory: Record<string, number> = {};
    for (const s of sources) {
      byCategory[s.taxCategory] = (byCategory[s.taxCategory] ?? 0) + s.waterfallInflowCents;
    }
    const gross = sources.reduce((sum, s) => sum + s.waterfallInflowCents, 0);
    const net = gross - usJurisdiction.computeTaxCents(byCategory, ctx);
    expect(net).toBeGreaterThanOrEqual(need);
    // Exactly the need, not merely enough — an overshoot liquidates more than it must.
    expect(net).toBe(need);
  });
});
