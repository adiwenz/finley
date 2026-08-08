/**
 * `buildRetirementOutlook` as a plain function of state — the month/age conversions layered on
 * top of {@link solveRetirement}'s answer, and the early-retiree health flag read off it.
 *
 * `solveRetirement` itself, and the search over candidate ages, are pinned in
 * `retirementSolver.test.ts`. `projectionFacade.run.test.ts` pins that `Projection.retirement`
 * actually calls through to this module; what is asserted here is the module's own arithmetic —
 * converting the solved age to a month, the blocked month back to an age, and reading the health
 * gap off whichever age the search returned.
 */
import { describe, it, expect } from "vitest";
import { buildRetirementOutlook } from "./retirementOutlook";
import { Projection } from "../facade/projectionFacade";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { P1 } from "../testing/projectionFacadeFixtures";

describe("buildRetirementOutlook — age/month conversions over the search's answer", () => {
  const CURRENT_AGE = SAMPLE_START_YEAR - samplePlan.primary.birthYear;

  it("dates the full-retirement age in months from now", () => {
    const outlook = buildRetirementOutlook(stateOf(samplePlan), nullJurisdiction);
    const age = outlook.solution.fullRetirementAge;
    expect(age).not.toBeNull();
    expect(outlook.fullRetirementMonth).toBe((age! - CURRENT_AGE) * 12);
  });

  it("dates a BLOCK as an age, the mirror conversion", () => {
    // Authored affordable, then stranded by lowering the opening balance — the §4.5 gate refuses
    // an unaffordable purchase up front, so a block has to be made this way.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    p.updatePlan({ openingBalanceCents: dollarsToCents(500000) });
    p.buyHome({
      month: 24,
      ownerId: P1,
      purchasePriceCents: dollarsToCents(600000),
      downPaymentCents: dollarsToCents(400000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 6,
      mortgageTermMonths: 360,
    });
    p.updatePlan({ openingBalanceCents: dollarsToCents(1000) });

    expect(p.run(nullJurisdiction).series.status).toBe("blocked");
    const outlook = buildRetirementOutlook(p.toState(), nullJurisdiction);
    expect(outlook.solution.blocked).toBe(true);
    // Two years out on a plan aged 40 → 42, floored to whole years like every reported age.
    expect(outlook.blockedAtAge).toBe(CURRENT_AGE + 2);
  });

  it("states no blocked age for a projection that was never blocked", () => {
    expect(buildRetirementOutlook(stateOf(samplePlan), nullJurisdiction).blockedAtAge).toBeNull();
  });
});

describe("buildRetirementOutlook — the early-retiree health gap", () => {
  const covered = mockJurisdiction({
    publicHealthCoverageAge: 65,
    healthCostBenchmarkMonthlyCents: () => dollarsToCents(1000),
  });

  it("flags a health gap only when the SOLVED age lands before the coverage age", () => {
    // The sample plan solves to 60. With $600/mo authored against a $1,000/mo benchmark that
    // is a 5-year gap — measured off the search's answer, not off any figure the plan states.
    const flag = buildRetirementOutlook(stateOf(samplePlan), covered).earlyRetireeHealth;
    expect(flag.gapYears).toBe(5);
    expect(flag.shortfallMonthlyCents).toBe(dollarsToCents(400));
  });

  it("closes the window once a coverage age the household already clears is named", () => {
    const coversEarly = mockJurisdiction({
      publicHealthCoverageAge: 55,
      healthCostBenchmarkMonthlyCents: () => dollarsToCents(1000),
    });
    expect(
      buildRetirementOutlook(stateOf(samplePlan), coversEarly).earlyRetireeHealth.gapYears,
    ).toBe(0);
  });

  it("has no window to be early for when the jurisdiction names no coverage age", () => {
    expect(
      buildRetirementOutlook(stateOf(samplePlan), nullJurisdiction).earlyRetireeHealth.gapYears,
    ).toBe(0);
  });

  it("raises no health gap for a household that can never retire", () => {
    // No solved age is not an early one. Flagging here would warn about a retirement the plan
    // cannot take, which is exactly what measuring against a pinned age used to do.
    const broke = {
      ...samplePlan,
      openingBalanceCents: 0,
      primary: { ...samplePlan.primary, jobs: [] },
    };
    const outlook = buildRetirementOutlook(stateOf(broke), covered);
    expect(outlook.solution.fullRetirementAge).toBeNull();
    expect(outlook.earlyRetireeHealth.flagged).toBe(false);
    expect(outlook.earlyRetireeHealth.gapYears).toBe(0);
  });
});
