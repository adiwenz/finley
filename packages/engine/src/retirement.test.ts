import { describe, it, expect } from "vitest";
import {
  findRetirementAge,
  portfolioSurvives,
  assessRetirementTarget,
  untaxedWithdrawal,
  type RetirementPerson,
  type RetirementScenario,
  type WithdrawalStep,
} from "./retirement";
import { dollarsToCents } from "./cashFlowSeries";

function person(overrides: Partial<RetirementPerson> = {}): RetirementPerson {
  return {
    id: "p1",
    currentAge: 40,
    lifeExpectancy: 90,
    ssClaimingAge: 67,
    annualEmploymentIncomeCents: dollarsToCents(60_000),
    annualSocialSecurityCents: dollarsToCents(24_000),
    plannedRetirementAge: 65,
    ...overrides,
  };
}

function scenario(overrides: Partial<RetirementScenario> = {}): RetirementScenario {
  return {
    persons: [person()],
    startingPortfolioCents: dollarsToCents(200_000),
    annualExpenseCents: dollarsToCents(40_000),
    realReturnRate: 0.04,
    ...overrides,
  };
}

describe("portfolioSurvives — the one §7 survival check (real dollars)", () => {
  it("passes when retiring late leaves the portfolio positive to life expectancy", () => {
    const s = scenario();
    const ages = new Map([["p1", 70]]);
    expect(portfolioSurvives(s, ages).survives).toBe(true);
  });

  it("fails when retiring far too early drains the portfolio before life expectancy", () => {
    const s = scenario({ startingPortfolioCents: dollarsToCents(50_000) });
    const ages = new Map([["p1", 41]]); // retire almost immediately, thin portfolio
    const result = portfolioSurvives(s, ages);
    expect(result.survives).toBe(false);
    expect(result.lowestBalanceCents).toBeLessThan(0);
  });

  it("uses the REAL return rate — nominal growth cannot rescue an early retirement", () => {
    // Same scenario, only the return differs. A high *real* return survives an
    // early retirement that a zero real return does not: proves the check reads
    // the real rate it is given (the §0.5 guard), not a hidden nominal one.
    const ages = new Map([["p1", 55]]);
    const rich = scenario({ realReturnRate: 0.05 });
    const flat = scenario({ realReturnRate: 0 });
    expect(portfolioSurvives(rich, ages).survives).toBe(true);
    expect(portfolioSurvives(flat, ages).survives).toBe(false);
  });

  it("counts Social Security only from the pinned claiming age", () => {
    // An already-retired person (age = retirement age) so the whole horizon is a
    // withdrawal phase. Claiming later (a longer self-funded gap) leaves strictly
    // less money — proving SS is a pinned input the check honours, not ignored.
    const ages = new Map([["p1", 65]]);
    const retiree = (ssClaimingAge: number): RetirementPerson =>
      person({
        currentAge: 65,
        plannedRetirementAge: 65,
        lifeExpectancy: 90,
        annualEmploymentIncomeCents: 0,
        ssClaimingAge,
      });
    const lateClaim = scenario({
      persons: [retiree(70)],
      startingPortfolioCents: dollarsToCents(300_000),
      realReturnRate: 0.03,
    });
    const earlyClaim = scenario({
      persons: [retiree(65)],
      startingPortfolioCents: dollarsToCents(300_000),
      realReturnRate: 0.03,
    });
    expect(portfolioSurvives(lateClaim, ages).lowestBalanceCents).toBeLessThan(
      portfolioSurvives(earlyClaim, ages).lowestBalanceCents,
    );
  });
});

describe("findRetirementAge — one binary search, monotone threshold (§7)", () => {
  it("Mode 1 (group) returns the earliest feasible age; one below it fails", () => {
    const s = scenario();
    const { earliestFeasibleAge } = findRetirementAge(s, { mode: "group" });
    expect(earliestFeasibleAge).not.toBeNull();
    const age = earliestFeasibleAge as number;
    expect(portfolioSurvives(s, new Map([["p1", age]])).survives).toBe(true);
    expect(portfolioSurvives(s, new Map([["p1", age - 1]])).survives).toBe(false);
  });

  it("defaults to Mode 1 when no search is passed", () => {
    const s = scenario();
    expect(findRetirementAge(s).earliestFeasibleAge).toBe(
      findRetirementAge(s, { mode: "group" }).earliestFeasibleAge,
    );
  });

  it("returns null when the money never lasts (expenses swamp income and portfolio)", () => {
    const s = scenario({
      startingPortfolioCents: 0,
      annualExpenseCents: dollarsToCents(200_000),
      persons: [person({ annualEmploymentIncomeCents: dollarsToCents(50_000) })],
    });
    expect(findRetirementAge(s, { mode: "group" }).earliestFeasibleAge).toBeNull();
  });

  it("Mode 2 pins the partner and searches one person; a later partner pin helps", () => {
    // Two-person household. Searching Alice's age: if Bob works longer (higher
    // pin), his extra income years relax Alice's earliest age — staggered
    // retirement falls straight out of Mode 2 with a non-matching pin (§7).
    const alice = person({ id: "alice", plannedRetirementAge: 60 });
    const bobEarly = person({ id: "bob", plannedRetirementAge: 60 });
    const bobLate = person({ id: "bob", plannedRetirementAge: 68 });

    const withEarlyBob = scenario({
      persons: [alice, bobEarly],
      startingPortfolioCents: dollarsToCents(300_000),
      annualExpenseCents: dollarsToCents(70_000),
    });
    const withLateBob = scenario({
      persons: [alice, bobLate],
      startingPortfolioCents: dollarsToCents(300_000),
      annualExpenseCents: dollarsToCents(70_000),
    });

    const earliestWithEarlyBob = findRetirementAge(withEarlyBob, {
      mode: "person",
      personId: "alice",
    }).earliestFeasibleAge as number;
    const earliestWithLateBob = findRetirementAge(withLateBob, {
      mode: "person",
      personId: "alice",
    }).earliestFeasibleAge as number;

    expect(earliestWithLateBob).toBeLessThanOrEqual(earliestWithEarlyBob);
  });
});

describe("assessRetirementTarget — target mode & honest nearest-feasible (§7.1)", () => {
  it("a reachable pin is feasible, ~100% on track, nearest = the pin", () => {
    const s = scenario();
    const feasibleAge = findRetirementAge(s).earliestFeasibleAge as number;
    const a = assessRetirementTarget(s, feasibleAge + 3);
    expect(a.feasible).toBe(true);
    expect(a.nearestFeasibleAge).toBe(feasibleAge + 3);
    expect(a.onTrackFraction).toBeGreaterThanOrEqual(1);
  });

  it("an unreachable pin reports < 100% on track and the honest nearest feasible age", () => {
    const s = scenario();
    const feasibleAge = findRetirementAge(s).earliestFeasibleAge as number;
    const tooEarly = feasibleAge - 5;
    const a = assessRetirementTarget(s, tooEarly);
    expect(a.feasible).toBe(false);
    expect(a.onTrackFraction).toBeLessThan(1);
    expect(a.onTrackFraction).toBeGreaterThan(0);
    expect(a.nearestFeasibleAge).toBe(feasibleAge);
    expect(a.nearestFeasibleAge as number).toBeGreaterThan(tooEarly);
  });
});

describe("withdrawal step is a replaceable seam (§5.3 seam 3)", () => {
  it("v1 untaxedWithdrawal returns the net need unchanged", () => {
    expect(
      untaxedWithdrawal({ netNeededCents: 12_345, yearOffset: 3, personAges: new Map() }),
    ).toBe(12_345);
  });

  it("a taxing step grosses up withdrawals, making an early retirement harder", () => {
    // Already-retired person so the whole horizon withdraws. A 25% withdrawal tax
    // means the portfolio must fund 1/0.75× the spend, so survival is strictly
    // worse — proving tax enters through the swappable step, no solver change.
    const ages = new Map([["p1", 65]]);
    const retiree = person({
      currentAge: 65,
      plannedRetirementAge: 65,
      lifeExpectancy: 90,
      annualEmploymentIncomeCents: 0,
    });
    const taxing: WithdrawalStep = (req) => Math.round(req.netNeededCents / 0.75);
    const untaxed = scenario({ persons: [retiree], startingPortfolioCents: dollarsToCents(300_000) });
    const taxed = scenario({
      persons: [retiree],
      startingPortfolioCents: dollarsToCents(300_000),
      withdrawalStep: taxing,
    });
    expect(portfolioSurvives(untaxed, ages).lowestBalanceCents).toBeGreaterThan(
      portfolioSurvives(taxed, ages).lowestBalanceCents,
    );
  });
});
