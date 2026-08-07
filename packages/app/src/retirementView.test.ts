import { describe, it, expect } from "vitest";
import { dollarsToCents, Projection, type Jurisdiction } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "./testing/projectionHarness";
import { retirementView } from "./retirementView";
import { PLAN_DEFAULTS } from "./planDefaults";
import { setJobCurrentMonthlyIncome } from "./testing/planFixtures";
import type { Plan } from "@finley/engine";

/** The view for a plan with no timeline events; the event-aware path is tested below. */
function viewOf(plan: Plan) {
  return retirementView(Projection.fromState(stateOf(plan), usJurisdiction));
}

/**
 * The default plan with its health spend restated. Health is a `healthcare`-category budget
 * line rather than a plan field, so a test that used to set `healthMonthlyCents` edits the
 * budget — which is the same thing the early-retiree check now reads.
 */
function withHealth(dollars: number, over: Partial<Plan> = {}): Plan {
  return {
    ...PLAN_DEFAULTS,
    budgetLines: PLAN_DEFAULTS.budgetLines.map((line) =>
      line.category === "healthcare"
        ? { ...line, amountSource: { kind: "literal", monthlyCents: dollarsToCents(dollars) } }
        : line,
    ),
    ...over,
  };
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
    expect(view.plannedWorkStopAge).toBe(outlook.solution.plannedWorkStopAge);
    expect(view.authoredPlanSurvives).toBe(outlook.solution.authoredPlanSurvives);
    expect(view.earlyRetireeHealth).toEqual(outlook.earlyRetireeHealth);
    expect(view.continuedJobs).toEqual(outlook.solution.continuedJobs);
    // The presentation fields the panel used to read off the live `budget` instead — pinned here
    // as coming off the SAME reader as everything above, not a second, possibly-live source.
    expect(view.lifeExpectancy).toBe(reader.plan.lifeExpectancy);
    expect(view.primaryName).toBe(reader.plan.name || null);
  });

  it("reads lifeExpectancy and primaryName off the projection passed in, not a later one", () => {
    // The hazard `useRetirementSurface` guards against for the series and the age: pairing a
    // solved view with metadata from a DIFFERENT plan. A view built from one projection must
    // report that projection's own life expectancy and name, whatever a caller holds elsewhere.
    const younger = viewOf({ ...PLAN_DEFAULTS, lifeExpectancy: 85, name: "Old" });
    const older = viewOf({ ...PLAN_DEFAULTS, lifeExpectancy: 95, name: "New" });
    expect(younger.lifeExpectancy).toBe(85);
    expect(younger.primaryName).toBe("Old");
    expect(older.lifeExpectancy).toBe(95);
    expect(older.primaryName).toBe("New");
  });

  it("falls back to null for an unnamed plan, same as the panel's own fallback", () => {
    expect(viewOf({ ...PLAN_DEFAULTS, name: "" }).primaryName).toBeNull();
  });

  it("carries no pinned-target figures — there is no age to score against", () => {
    // `target` and `targetOnTrackPct` went with `Plan.retirementAge`. Asserted as absent rather
    // than merely unused: the view is what the panel renders, and a stale field here is how a
    // removed concept comes back as a line of copy nobody meant to keep.
    const view = viewOf(PLAN_DEFAULTS) as unknown as Record<string, unknown>;
    expect(view.target).toBeUndefined();
    expect(view.targetOnTrackPct).toBeUndefined();
  });
});

describe("retirementView — a blocked projection can't be solved", () => {
  // A stub outlook whose projection blocked: the solver reports no age and the reason is a block,
  // not "no age works". The view must surface the block and the age it stopped at, not a headline.
  //
  // The age is STATED here, not derived from a month: converting the block onto the primary's
  // clock is the engine's job (`projectionFacade.test.ts` pins that conversion), and what is left
  // for this view is carrying the answer through without dropping or renaming it.
  function blockedReader(plan: Plan, blockedAtMonth: number, blockedAtAge: number) {
    const real = Projection.fromState(stateOf(plan), usJurisdiction);
    const outlook = real.retirement(usJurisdiction);
    return {
      plan: real.plan,
      retirement: (_j: Jurisdiction) => ({
        ...outlook,
        solution: { ...outlook.solution, fullRetirementAge: null, blocked: true, blockedAtMonth },
        fullRetirementMonth: null,
        blockedAtAge,
      }),
    };
  }

  it("reports blocked and the age the projection stopped at", () => {
    // Blocked 24 months out on a plan aged 40 — the engine reports that as age 42.
    const view = retirementView(blockedReader({ ...PLAN_DEFAULTS, currentAge: 40 }, 24, 42));
    expect(view.blocked).toBe(true);
    expect(view.blockedAtAge).toBe(42);
    expect(view.headlineAge).toBeNull();
  });

  it("is not blocked for an ordinary plan", () => {
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.blocked).toBe(false);
    expect(view.blockedAtAge).toBeNull();
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

describe("retirementView — early-retiree health flag, measured at the SOLVED age", () => {
  /** Enough opening balance to solve well before Medicare; nothing budgeted for health. */
  const retiresEarly = withHealth(0, { openingBalanceCents: dollarsToCents(500_000) });

  it("flags a household whose earliest feasible age falls before Medicare", () => {
    const view = viewOf(retiresEarly);
    expect(view.headlineAge).toBe(58);
    expect(view.earlyRetireeHealth.flagged).toBe(true);
    // Seven self-funded years — 65 minus the SOLVED 58, not a figure the plan states.
    expect(view.earlyRetireeHealth.gapYears).toBe(7);
  });

  it("does NOT flag the default plan, which cannot stop working until after 65", () => {
    const view = viewOf(PLAN_DEFAULTS);
    expect(view.headlineAge).toBeGreaterThan(65);
    expect(view.earlyRetireeHealth.flagged).toBe(false);
    expect(view.earlyRetireeHealth.gapYears).toBe(0);
  });

  it("does NOT flag a household that can never retire — no retirement, no gap", () => {
    const view = viewOf({ ...PLAN_DEFAULTS, openingBalanceCents: 0, jobs: [] });
    expect(view.headlineAge).toBeNull();
    expect(view.earlyRetireeHealth.flagged).toBe(false);
    expect(view.earlyRetireeHealth.gapYears).toBe(0);
  });

  it("prices the benchmark in today's dollars, not indexed out to the retirement year", () => {
    // The solved age is 58 against a current age of 35 — 23 years out. An indexed benchmark
    // would be far above the base figure, so the exact base number is the assertion.
    expect(viewOf(retiresEarly).earlyRetireeHealth.shortfallMonthlyCents).toBe(
      dollarsToCents(1_200),
    );
  });
});

/*
 * The "attributed Medicare residual step" block is gone with the step itself. The plan holds no
 * post-coverage figure to attribute, and nothing steps health at 65 — whatever the budget's
 * health line says is what the projection charges, for as long as the line runs. The
 * early-retiree gap check above survives because it only ever read the AUTHORED cost and
 * synthesised none.
 */

describe("retirementView — the timeline events count toward retirement", () => {
  // The panel must reason about the plan plus the ledger, as the graph does: if it still
  // projected an empty ledger, a costly new expense would not budge the headline age.
  it("a recurring expense added to the ledger pushes the headline age later", () => {
    // Real single-filer federal tax plus FICA pins the default $5k plan above the
    // Social-Security floor, where an added expense flips it infeasible rather than merely
    // later. The raise buys headroom below the floor, keeping "moves strictly later" observable.
    // The month-0 anchor only: this is a raise TODAY, and restating the job's start salary
    // with it would rewrite a 2009 paycheck as $7,000 and inflate the covered-earnings record
    // the benefit is priced off.
    const plan: Plan = setJobCurrentMonthlyIncome(
      PLAN_DEFAULTS,
      PLAN_DEFAULTS.jobs[0]!.id,
      dollarsToCents(7000),
    );
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
    // The bare-plan baseline retires at 63 — the home goal is a drawable `retain` reserve, so
    // the down-payment fund counts toward the nest egg. FICA charged on the $7k wages trims
    // take-home and pushes the floor out, and the childcare expense pushes it further still.
    expect(baselineAge).toBe(63);
    expect(withChildAge as number).toBeGreaterThan(63);
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
