import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { SimPerson } from "./simulate.types";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../simAccount";
import { dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction";
import {
  makePerson,
  makeInvestmentAccount,
  monthlyIncome,
  monthlyExpense,
} from "./simulate.testSupport";

describe("simulateHousehold — allocation waterfall", () => {
  const person: SimPerson = { id: "p1", name: "Alice" };

  function retirementAccount(): SimAccount {
    // Non-liquid pre-tax: deferrals land here, the surplus/idle step never does
    // (it targets the liquid account).
    return new SimAccount({
      id: "401k",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
  }

  it("a plan-bearing job defers pre-tax into its retirement account each month", () => {
    const checking = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 3,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, retirementAccount()],
        incomeSeries: [
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p1",
            planDescriptor: { deferralFraction: 0.1, fundAccountId: "401k" },
          },
        ],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    // $500/mo deferred → $1500 after 3 months; take-home $4500/mo → $13,500 in checking.
    expect(series.months[3].accountBalancesCents["401k"]).toBe(dollarsToCents(1500));
    expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(13500));
  });

  it("the annual deferral cap is enforced across the calendar year", () => {
    // Wants $5000/mo against a $12,000 annual limit → capped mid-year, reset next year.
    const cappingJurisdiction = {
      id: "cap-test",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      retirementDeferralLimitCents: () => dollarsToCents(12000),
    };
    const checking = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, retirementAccount()],
        incomeSeries: [
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p1",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k" },
          },
        ],
        expenseSeries: [],
      },
      cappingJurisdiction,
    );
    // Year one is months 0–11 (ctx.year = startYear + floor(month/12)); deferrals in
    // months 1–11 cap at $12,000, against an uncapped 11×$5000 = $55,000.
    expect(series.months[11].accountBalancesCents["401k"]).toBe(dollarsToCents(12000));
    // Month 12 opens the next calendar year and the room resets: a second full $12,000
    // by month 23 → $24,000 cumulative.
    expect(series.months[23].accountBalancesCents["401k"]).toBe(dollarsToCents(24000));
  });

  it("the deferral cap is age-aware: an over-50 catch-up raises one person's limit", () => {
    // $12,000 base plus a $3,000 catch-up from age 50. The seam is called per person
    // with that person's age, so only the older partner's cap lifts.
    const catchUpJurisdiction = {
      id: "catchup-test",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      retirementDeferralLimitCents: (ctx: { year: number; age?: number }) =>
        dollarsToCents(12000) + (ctx.age !== undefined && ctx.age >= 50 ? dollarsToCents(3000) : 0),
    };
    // startYear defaults to 2026: born 1971 → age 55 (catch-up); born 1990 → age 36 (base).
    const older: SimPerson = { id: "p1", name: "Alice", birthYear: 1971 };
    const younger: SimPerson = { id: "p2", name: "Bob", birthYear: 1990 };
    const older401k = new SimAccount({
      id: "401k-a",
      ownerId: "p1",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const younger401k = new SimAccount({
      id: "401k-b",
      ownerId: "p2",
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const checking = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 11,
        annualInflationRate: 0,
        persons: [older, younger],
        accounts: [checking, older401k, younger401k],
        incomeSeries: [
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p1",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-a" },
          },
          {
            series: monthlyIncome(dollarsToCents(5000)),
            ownerId: "p2",
            planDescriptor: { deferralFraction: 1.0, fundAccountId: "401k-b" },
          },
        ],
        expenseSeries: [],
      },
      catchUpJurisdiction,
    );
    // The over-50 partner caps at $15,000 (base + catch-up); the younger at $12,000.
    expect(series.months[11].accountBalancesCents["401k-a"]).toBe(dollarsToCents(15000));
    expect(series.months[11].accountBalancesCents["401k-b"]).toBe(dollarsToCents(12000));
  });

  it("routing income through the waterfall conserves net worth vs. the naive path", () => {
    // With no goals, no plan, and idle surplus, the waterfall must reproduce plain net
    // flow into the liquid account exactly.
    const checking = makeInvestmentAccount(dollarsToCents(1000), 0);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2000)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    // $1000 opening + $1000/mo net for 12 months = $13,000.
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(13000));
  });

  it("surplus swept to an investment account instead of idling in liquid (lever 4)", () => {
    const checking = makeInvestmentAccount(0, 0);
    const brokerage = new SimAccount({
      id: "brokerage",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, brokerage],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(2000)), ownerId: "p1" }],
        expenseSeries: [],
        surplusDestination: { kind: "swept", accountId: "brokerage" },
      },
      nullJurisdiction,
    );
    expect(series.months[6].accountBalancesCents["brokerage"]).toBe(dollarsToCents(12000));
    expect(series.months[6].accountBalancesCents["investment"]).toBe(0);
  });

  /** A rate-0 fund account so a goal's balance moves only by deposit/disposition. */
  function goalFund(id: string): SimAccount {
    return new SimAccount({
      id,
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
  }

  describe("a matured goal never fires — the fund simply stays put (#150)", () => {
    // $2000/mo income, no expenses; the goal funds $2000/mo and hits its $4000 target
    // exactly at month 2, its target date. A goal never moves its own money out — only a
    // timeline event does — so maturity is a no-op: the fund stays in the account and in
    // net worth, drawable like any other, whatever its purely descriptive disposition.
    const goalScenario = (disposition: "retain" | "drawDown") => ({
      horizonMonths: 4,
      annualInflationRate: 0,
      persons: [makePerson()],
      accounts: [makeInvestmentAccount(0, 0), goalFund("goal-x")],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(2000)), ownerId: "p1" }],
      expenseSeries: [],
      goals: [
        {
          id: "x",
          name: "Goal X",
          targetCents: dollarsToCents(4000),
          targetDate: 2,
          fundAccountId: "goal-x",
          priority: 0,
          disposition,
          scope: "shared" as const,
        },
      ],
    });

    it.each(["retain", "drawDown"] as const)(
      "a `%s` goal's fund stays in the account and in net worth past its target date",
      (disposition) => {
        const series = simulateHousehold(goalScenario(disposition), nullJurisdiction);
        // Month 2 (target): the fund shows AT target — the goal reads as achieved.
        expect(series.months[2].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
        expect(series.months[2].netWorthNominalCents).toBe(dollarsToCents(4000));
        // Month 3: fund unchanged (nothing fired, no equity synthesized), plus this
        // month's $2000 idling in the liquid account → net worth $6000.
        expect(series.months[3].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
        expect(series.months[3].propertyValuesCents["goal-equity-x"]).toBeUndefined();
        expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(2000));
        expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(6000));
      },
    );
  });

  it("a shared goal is funded ahead of idle surplus, up to its target", () => {
    const checking = makeInvestmentAccount(0, 0);
    const emergency = new SimAccount({
      id: "emergency",
      ownerId: "p1",
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: 0,
    });
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [person],
        accounts: [checking, emergency],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(2000)), ownerId: "p1" }],
        expenseSeries: [],
        goals: [
          {
            id: "ef",
            name: "Emergency fund",
            targetCents: dollarsToCents(5000),
            targetDate: "asap",
            fundAccountId: "emergency",
            priority: 1,
            disposition: "drawDown",
            scope: "shared",
          },
        ],
      },
      nullJurisdiction,
    );
    // Months 1–2 fill the goal to $5000 ($2000 + $2000 + $1000), then surplus idles.
    expect(series.months[3].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    expect(series.months[6].accountBalancesCents["emergency"]).toBe(dollarsToCents(5000));
    // Once capped, the rest idles in checking: $1000 in month 3, $2000 in months 4–6.
    expect(series.months[6].accountBalancesCents["investment"]).toBe(dollarsToCents(7000));
  });

  describe("dated goals amortize to their deadline", () => {
    // Two goals well within budget: $6k by month 6, $12k by month 12. $3k/mo income more
    // than covers both paces ($1k + $1k), so the outcome must not depend on priority
    // order and each fund must track an amortized path, not fill-then-idle.
    const near = (priority: number) => ({
      id: "near",
      name: "Near goal",
      targetCents: dollarsToCents(6000),
      targetDate: 6,
      fundAccountId: "near-fund",
      priority,
      disposition: "retain" as const,
      scope: "shared" as const,
    });
    const far = (priority: number) => ({
      id: "far",
      name: "Far goal",
      targetCents: dollarsToCents(12000),
      targetDate: 12,
      fundAccountId: "far-fund",
      priority,
      disposition: "retain" as const,
      scope: "shared" as const,
    });
    const scenario = (nearPriority: number, farPriority: number) => ({
      horizonMonths: 12,
      annualInflationRate: 0,
      persons: [person],
      accounts: [
        makeInvestmentAccount(0, 0),
        goalFund("near-fund"),
        goalFund("far-fund"),
      ],
      incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
      expenseSeries: [],
      goals: [near(nearPriority), far(farPriority)],
    });

    it("amortizes the far goal along a rising path instead of filling it then idling", () => {
      const series = simulateHousehold(scenario(1, 2), nullJurisdiction);
      const far0 = series.months[1].accountBalancesCents["far-fund"];
      const far6 = series.months[6].accountBalancesCents["far-fund"];
      const far12 = series.months[12].accountBalancesCents["far-fund"];
      // Fill-then-idle would land the full $12k in month 1; a paced path starts small,
      // climbs monotonically, and reaches the target only at the month-12 deadline.
      expect(far0).toBeGreaterThan(0);
      expect(far0).toBeLessThan(dollarsToCents(2000));
      expect(far6).toBeGreaterThan(far0);
      expect(far6).toBeLessThan(dollarsToCents(12000));
      expect(far12).toBe(dollarsToCents(12000));
    });

    it("both affordable goals reach 100% regardless of priority order", () => {
      const forward = simulateHousehold(scenario(1, 2), nullJurisdiction);
      const reversed = simulateHousehold(scenario(2, 1), nullJurisdiction);
      // The near goal is fully funded by its month-6 deadline; read its balance there.
      for (const s of [forward, reversed]) {
        expect(s.months[6].accountBalancesCents["near-fund"]).toBe(dollarsToCents(6000));
        expect(s.months[12].accountBalancesCents["far-fund"]).toBe(dollarsToCents(12000));
      }
    });
  });
});
