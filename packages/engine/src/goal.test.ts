import { describe, it, expect } from "vitest";
import { computeGoalProgress, type SimGoal } from "./goal";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { simulateHousehold } from "./projection/simulate";
import type { SimPerson } from "./projection/simulate.types";
import { SimCashFlowSeries, dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";

const person: SimPerson = { id: "p1", name: "Alice" };

function account(id: string, annualRate: number, liquid = true): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: 0,
    initialAnnualRate: annualRate,
  });
}

function monthly(cents: number): SimCashFlowSeries {
  return new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly" });
}

describe("computeGoalProgress — projection-based on-track %", () => {
  it("on-track fraction is projected fund at target date ÷ target, not saved-so-far ÷ target", () => {
    // $1000/mo income, all swept to the goal fund; 0% growth.
    const fund = account("fund", 0);
    const projection = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [person],
        accounts: [fund],
        incomeSeries: [{ series: monthly(dollarsToCents(1000)), ownerId: "p1" }],
        expenseSeries: [],
        surplusDestination: { kind: "swept", accountId: "fund" },
      },
      nullJurisdiction,
    );

    const goal: SimGoal = {
      id: "g",
      name: "House",
      targetCents: dollarsToCents(24000),
      targetDate: 24,
      fundAccountId: "fund",
      priority: 1,
      disposition: "retain",
      scope: "shared",
    };
    const progress = computeGoalProgress(goal, projection, [fund]);
    // By month 24, $24,000 accumulated → exactly on track.
    expect(progress.onTrackFraction).toBeCloseTo(1, 5);
  });

  it("underfunded goal reports < 1 (planning insight)", () => {
    const fund = account("fund", 0);
    const projection = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [person],
        accounts: [fund],
        incomeSeries: [{ series: monthly(dollarsToCents(500)), ownerId: "p1" }],
        expenseSeries: [],
        surplusDestination: { kind: "swept", accountId: "fund" },
      },
      nullJurisdiction,
    );
    const goal: SimGoal = {
      id: "g",
      name: "House",
      targetCents: dollarsToCents(24000),
      targetDate: 24,
      fundAccountId: "fund",
      priority: 1,
      disposition: "retain",
      scope: "shared",
    };
    // Only $12,000 accumulated by month 24 → 50% on track.
    expect(computeGoalProgress(goal, projection, [fund]).onTrackFraction).toBeCloseTo(0.5, 5);
  });

  it("a zero-target goal reports 1 (nothing to fund, no divide-by-zero)", () => {
    const fund = account("fund", 0);
    const projection = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [person],
        accounts: [fund],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    const goal: SimGoal = {
      id: "g",
      name: "zero",
      targetCents: 0,
      targetDate: 6,
      fundAccountId: "fund",
      priority: 1,
      disposition: "drawDown",
      scope: "shared",
    };
    expect(computeGoalProgress(goal, projection, [fund]).onTrackFraction).toBe(1);
  });
});

describe("computeGoalProgress — verdict routing & risk flag", () => {
  const trivialProjection = simulateHousehold(
    {
      horizonMonths: 36,
      annualInflationRate: 0,
      persons: [person],
      accounts: [account("fund", 0)],
      incomeSeries: [],
      expenseSeries: [],
    },
    nullJurisdiction,
  );

  it("a standing (drawDown) goal < 12 months out routes to the immediate (asset-ratio) verdict path", () => {
    const goal: SimGoal = {
      id: "g",
      name: "near",
      targetCents: dollarsToCents(1000),
      targetDate: 6,
      fundAccountId: "fund",
      priority: 1,
      disposition: "drawDown",
      scope: "shared",
    };
    expect(computeGoalProgress(goal, trivialProjection, [account("fund", 0)]).verdictPath).toBe(
      "immediate",
    );
  });

  it("a near-term goal with an 'asap' date uses the projection path (no concrete date to grade against)", () => {
    const goal: SimGoal = {
      id: "g",
      name: "asap",
      targetCents: dollarsToCents(1000),
      targetDate: "asap",
      fundAccountId: "fund",
      priority: 1,
      disposition: "retain",
      scope: "shared",
    };
    expect(computeGoalProgress(goal, trivialProjection, [account("fund", 0)]).verdictPath).toBe(
      "projection",
    );
  });

  it("a goal ≥ 12 months out uses the projection path", () => {
    const goal: SimGoal = {
      id: "g",
      name: "far",
      targetCents: dollarsToCents(1000),
      targetDate: 30,
      fundAccountId: "fund",
      priority: 1,
      disposition: "drawDown",
      scope: "shared",
    };
    expect(computeGoalProgress(goal, trivialProjection, [account("fund", 0)]).verdictPath).toBe(
      "projection",
    );
  });

  it("flags a near-term goal held in a high-return / high-risk account", () => {
    const risky = account("fund", 0.08); // equity-like
    const goal: SimGoal = {
      id: "g",
      name: "near-risky",
      targetCents: dollarsToCents(1000),
      targetDate: 12,
      fundAccountId: "fund",
      priority: 1,
      disposition: "retain",
      scope: "shared",
    };
    expect(computeGoalProgress(goal, trivialProjection, [risky]).shortHorizonRiskFlag).toBe(true);
  });

  it("does NOT flag a near-term goal held in a low-risk account", () => {
    const safe = account("fund", 0.01); // HYSA-like
    const goal: SimGoal = {
      id: "g",
      name: "near-safe",
      targetCents: dollarsToCents(1000),
      targetDate: 12,
      fundAccountId: "fund",
      priority: 1,
      disposition: "retain",
      scope: "shared",
    };
    expect(computeGoalProgress(goal, trivialProjection, [safe]).shortHorizonRiskFlag).toBe(false);
  });

  it("does NOT flag a long-horizon goal even in a high-risk account", () => {
    const risky = account("fund", 0.08);
    const goal: SimGoal = {
      id: "g",
      name: "far-risky",
      targetCents: dollarsToCents(1000),
      targetDate: 240, // 20 years out
      fundAccountId: "fund",
      priority: 1,
      disposition: "drawDown",
      scope: "shared",
    };
    // targetDate beyond the 36-month horizon still measures monthsToTarget from now.
    expect(computeGoalProgress(goal, trivialProjection, [risky]).shortHorizonRiskFlag).toBe(false);
  });
});
