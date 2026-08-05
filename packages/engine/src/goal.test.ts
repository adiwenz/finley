import { describe, it, expect } from "vitest";
import { computeGoalProgress, type SimGoal } from "./goal";
import { CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { planAccount, type PlanAccount } from "./planAccount";
import type { PersonId } from "./job";
import { simulateHousehold } from "./projection/simulate";
import type { SimPerson, ProjectionSeries } from "./projection/simulate.types";
import { SimCashFlowSeries, dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";

const person: SimPerson = { id: "p1", name: "Alice" };

/**
 * A hand-built projection whose only moving part is the `"fund"` balance, one entry per
 * month — the independent source of truth for the completion scan. Every other field is
 * inert, so the test pins exactly the balance-vs-target logic.
 */
function seriesFromFundBalances(balancesCents: readonly number[]): ProjectionSeries {
  const mkMonth = (bal: number, month: number) => ({
    month,
    netWorthNominalCents: bal,
    netWorthRealCents: bal,
    accountBalancesCents: { fund: bal },
    accountBasisCents: {},
    liabilityBalancesCents: {},
    liabilityPaymentRecords: {},
    propertyValuesCents: {},
    isInsolvent: false,
    uncoveredCents: 0,
  });
  // Opening is inert here — goal progress reads only the processed months — so mirror the
  // first balance rather than modelling a distinct pre-flow value.
  const built = balancesCents.map(mkMonth);
  return {
    opening: mkMonth(balancesCents[0] ?? 0, 0),
    months: built,
    status: "ran-to-horizon",
    simulatedThroughMonth: built.length - 1,
  };
}

function fundGoal(overrides: Partial<SimGoal> = {}): SimGoal {
  return {
    id: "g",
    name: "House",
    targetCents: dollarsToCents(24000),
    targetDate: 24,
    fundAccountId: "fund",
    priority: 1,
    disposition: "retain",
    scope: "shared",
    ...overrides,
  };
}

function account(id: string, annualRate: number, liquid = true): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    liquid,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: 0,
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
        accounts: [fund.sim],
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
        accounts: [fund.sim],
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
        accounts: [fund.sim],
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

describe("computeGoalProgress — completion (In Progress → Funded, latched)", () => {
  it("latches Funded once the balance reaches target on/before the target date, even if a later event drains the account", () => {
    // Reaches $24,000 at month 10, drained by month 20, target date month 24: completion
    // must latch at the month-10 reach.
    const balances = Array.from({ length: 25 }, (_, m) => {
      if (m < 10) return dollarsToCents(2400 * m); // ramp to target by month 10
      if (m < 20) return dollarsToCents(24000); // held at target
      return 0; // drained
    });
    const progress = computeGoalProgress(fundGoal(), seriesFromFundBalances(balances), []);
    expect(progress.completion).toBe("funded");
  });

  it("stays In Progress when the balance never reaches target on/before the target date", () => {
    // Climbs to only ~$15,000 of the $24,000 target, never crossing on/before month 24.
    const balances = Array.from({ length: 31 }, (_, m) => dollarsToCents(500 * m));
    const progress = computeGoalProgress(fundGoal(), seriesFromFundBalances(balances), []);
    expect(progress.completion).toBe("inProgress");
  });

  it("does not count a target reached only AFTER the target date", () => {
    // Balance is below target through month 24, only reaching it at month 30.
    const balances = Array.from({ length: 31 }, (_, m) =>
      m < 30 ? dollarsToCents(20000) : dollarsToCents(24000),
    );
    expect(computeGoalProgress(fundGoal(), seriesFromFundBalances(balances), []).completion).toBe(
      "inProgress",
    );
  });

  it("an 'asap' goal is Funded once the balance ever reaches target across the whole horizon", () => {
    const balances = Array.from({ length: 13 }, (_, m) => dollarsToCents(2000 * m));
    const progress = computeGoalProgress(
      fundGoal({ targetDate: "asap" }),
      seriesFromFundBalances(balances),
      [],
    );
    // $24,000 reached at month 12 (the horizon end) → funded.
    expect(progress.completion).toBe("funded");
  });
});

describe("computeGoalProgress — verdict routing & risk flag", () => {
  const trivialProjection = simulateHousehold(
    {
      horizonMonths: 36,
      annualInflationRate: 0,
      persons: [person],
      accounts: [account("fund", 0).sim],
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
