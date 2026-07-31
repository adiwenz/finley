import { describe, it, expect } from "vitest";
import { dollarsToCents, Projection, type Jurisdiction } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "./testing/projectionHarness";
import { retirementView } from "./retirementView";
import { PLAN_DEFAULTS } from "./planDefaults";
import { setJobMonthlyIncome } from "./testing/planFixtures";
import type { Plan } from "@finley/engine";

/** The view for a plan with no timeline events; the event-aware path is tested below. */
function viewOf(plan: Plan) {
  return retirementView(Projection.fromState(stateOf(plan), usJurisdiction));
}

describe("retirementView — one query behind every figure", () => {
  /**
   * Counts how many searches a render costs. Two members is the whole of what the view reads,
   * so the stand-in states them outright rather than wrapping a projection.
   */
  function countingReader(plan: Plan) {
    const real = Projection.fromState(stateOf(plan), usJurisdiction);
    let calls = 0;
    return {
      reader: {
        plan: real.plan,
        retirement: (j: Jurisdiction) => {
          calls += 1;
          return real.retirement(j);
        },
      },
      calls: () => calls,
    };
  }

  it("asks the facade once, and every figure it shows comes out of that answer", () => {
    const { reader, calls } = countingReader(PLAN_DEFAULTS);
    const view = retirementView(reader);
    expect(calls()).toBe(1);

    // Each field is the corresponding field of the one outlook, not a second derivation.
    const outlook = reader.retirement(usJurisdiction);
    expect(view.headlineAge).toBe(outlook.solution.fullRetirementAge);
    expect(view.headlineMonth).toBe(outlook.fullRetirementMonth);
    expect(view.target).toEqual(outlook.target);
    expect(view.earlyRetireeHealth).toEqual(outlook.earlyRetireeHealth);
  });

  it("keeps the on-track rounding on this side of the boundary — floored, clamped", () => {
    // The engine reports a fraction; rounding DOWN to a tenth is the app's rule, so a plan
    // 99.97% of the way cannot show a "100%" it has not earned.
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.targetOnTrackPct).toBeLessThanOrEqual(100);
    expect(view.targetOnTrackPct).toBeGreaterThanOrEqual(0);
    expect(view.targetOnTrackPct).toBe(
      Math.floor(view.target.onTrackFraction * 1000) / 10 > 100
        ? 100
        : Math.floor(view.target.onTrackFraction * 1000) / 10,
    );
  });
});

describe("retirementView — headline age driven off the real projection", () => {
  it("reports the full-retirement age the facade found, not a second search", () => {
    const projection = Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);
    expect(retirementView(projection).headlineAge).toBe(
      projection.retirement(usJurisdiction).solution.fullRetirementAge,
    );
  });

  it("the month offset is (age − now) × 12, floored at 0 — the chart reference line", () => {
    const view = viewOf(PLAN_DEFAULTS);
    const age = view.headlineAge as number;
    expect(view.headlineMonth).toBe((age - PLAN_DEFAULTS.currentAge) * 12);
  });

  it("reports no feasible headline when the money can never last", () => {
    const broke: Plan = {
      ...PLAN_DEFAULTS,
      openingBalanceCents: 0,
      jobs: [],
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
    const plan: Plan = setJobMonthlyIncome(PLAN_DEFAULTS, PLAN_DEFAULTS.jobs[0]!.id, dollarsToCents(7000));
    // A child spawns an 18-year childcare expense on the timeline — the surviving way the
    // AddEventForm puts recurring spend on the timeline now that "Added an expense" is gone.
    // Authored through the facade (`haveChild`), exactly as the app does, rather than seeding a
    // ledger by hand.
    const withChild = Projection.fromState(stateOf(plan), usJurisdiction);
    withChild.haveChild({
      month: 0,
      name: "Robin",
      birthMonth: 0,
      annualCostCents: dollarsToCents(9_600), // $800/mo
    });

    const baselineAge = viewOf(plan).headlineAge;
    const withChildAge = retirementView(withChild).headlineAge;
    // The bare-plan baseline retires at 60 — the home goal is a drawable `retain` reserve,
    // so the down-payment fund counts toward the nest egg.
    expect(baselineAge).toBe(60);
    expect(withChildAge as number).toBeGreaterThan(60);
  });
});

// No surplus-sweep-vs-idle comparison: `surplusSwept` is gone and leftover cash always
// idles (a household wanting surplus invested authors a brokerage contribution line).

// Dropped: the white-box "every draw nets its need under the real jurisdiction" block
// (SimAccount / WithdrawalState / buildWithdrawalSources / CAPITAL_GAINS_TAX_PROFILE). That was
// engine withdrawal-mechanics coverage reaching past the facade to size a brokerage draw so it
// nets its need to the cent under a bracketed (`offset + rate × draw`) tax.
//
// The whole-return gross-up arithmetic — including bracketed/offset, non-proportional taxes — is
// already covered engine-side in `packages/engine/src/projection/withdrawal.test.ts`
// ("Every taxed draw nets the need — whole-return gross-up": the flat-capital-gains case and the
// cliff/lump case that pins exactly the `offset + rate × draw` shape). What a `runOf` can observe
// today is the solvency consequence, which is far too coarse to catch a cent-level
// under-delivery: a draw that nets a dollar short still leaves the household solvent for years.
// So there is no facade-level assertion to write yet — see the direction below.
//
// TODO(facade): generalize `Projection.funding()` into a shared account-draw model, and have
// `Projection.run()` report the draws a pass actually executed.
//
// `funding()` answers half this question already — which liquid accounts could pay a money-out
// event at a month, and what a chosen set nets after tax — but only ahead of time, about an event
// being authored. The simulator does the same reasoning every month it has to cover a shortfall,
// and keeps none of it: a run reports balances after the fact, never the draws that moved them.
// One model behind both, with the executed draws surfaced on `ProjectionResult`, is the shape
// that fits — the pre-flight read and the run's own withdrawals stop being two implementations of
// one rule that can quietly disagree.
//
// It is what restores this coverage, rather than a hook added for it. With executed draws on the
// result, a test can read what a retirement drawdown actually took from each account and assert
// it netted the need to the cent under the REAL `usJurisdiction` — the assertion the dropped
// block made white-box, and the one thing engine tests cannot cover, since they run against
// synthetic profiles. The retirement runs above already exercise that seam implicitly by drawing
// accounts down under `usJurisdiction`; what is missing is any way to observe what they took.
