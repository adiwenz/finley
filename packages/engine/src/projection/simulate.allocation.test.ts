import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { SimPerson } from "./simulate.types";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../simAccount";
import { dollarsToCents, preciseMonthlyRate } from "../cashFlowSeries";
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
    // A non-liquid pre-tax account — deferrals land here, but the surplus/idle
    // step never does (it targets the liquid account).
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
    // Wants to defer $5000/mo but the annual limit is $12,000 → capped mid-year,
    // and reset the next calendar year.
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
    // Calendar year one is months 0–11 (ctx.year = startYear + floor(month/12));
    // deferrals in months 1–11 cap at $12,000 (vs. an uncapped 11×$5000 = $55,000).
    expect(series.months[11].accountBalancesCents["401k"]).toBe(dollarsToCents(12000));
    // Month 12 opens the next calendar year → the room resets; by month 23 a second
    // full $12,000 has been deferred → $24,000 cumulative.
    expect(series.months[23].accountBalancesCents["401k"]).toBe(dollarsToCents(24000));
  });

  it("the deferral cap is age-aware: an over-50 catch-up raises one person's limit", () => {
    // Base annual limit $12,000, plus a $3,000 catch-up from age 50. The seam is
    // called per person with that person's age, so only the older partner's cap lifts.
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
    // With no goals, no plan, and idle surplus, the waterfall must reproduce the
    // old 'net flow into the liquid account' behavior exactly (backward compat).
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

  describe("goal disposition firing at maturity", () => {
    // $2000/mo income, no expenses; the goal is funded $2000/mo and reaches its
    // $4000 target exactly at month 2 (its target date). Firing happens at the END
    // of the target month, so the month-2 snapshot still shows the fund AT target
    // (the goal reads as achieved) and the disposition takes effect from month 3.
    const goalScenario = (disposition: "spend" | "convertToEquity" | "retain") => ({
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

    it("`spend` consumes the fund at maturity — it leaves net worth and is not re-funded", () => {
      const series = simulateHousehold(goalScenario("spend"), nullJurisdiction);
      // Month 2 (target): the fund is shown AT target — the goal reads as achieved.
      expect(series.months[2].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
      expect(series.months[2].netWorthNominalCents).toBe(dollarsToCents(4000));
      // Month 3: the $4000 has been spent — gone from the fund and from net worth,
      // and NOT re-accumulated (this month's $2000 income idles in the liquid account).
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(0);
      expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(2000));
      expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(2000));
    });

    it("`convertToEquity` swaps the fund into an illiquid equity holding — net worth is conserved", () => {
      const series = simulateHousehold(goalScenario("convertToEquity"), nullJurisdiction);
      // Month 2 (target): the fund is shown AT target.
      expect(series.months[2].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
      expect(series.months[2].netWorthNominalCents).toBe(dollarsToCents(4000));
      // Month 3: the fund is emptied but the $4000 reappears as illiquid home equity —
      // net worth is unchanged by the swap (the $6000 = $4000 equity + $2000 new savings).
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(0);
      expect(series.months[3].propertyValuesCents["goal-equity-x"]).toBe(dollarsToCents(4000));
      expect(series.months[3].accountBalancesCents["investment"]).toBe(dollarsToCents(2000));
      expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(6000));
    });

    it("`retain` fires nothing — the fund stays in the account past its target date", () => {
      const series = simulateHousehold(goalScenario("retain"), nullJurisdiction);
      // The reserve is held as-is: still in the fund at month 3, still counted in net
      // worth, and no equity holding was synthesized.
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(dollarsToCents(4000));
      expect(series.months[3].propertyValuesCents["goal-equity-x"]).toBeUndefined();
      expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(6000));
    });

    it("`convertToEquity` synthesizes equity that appreciates at the FUND's own rate", () => {
      // A pre-funded goal whose fund earns 6%/yr, no contributions. The equity that
      // replaces it at maturity must keep compounding at that same 6% — this pins the
      // rate wiring (fundAccount.getRateAt), which every other firing test, using
      // rate-0 funds, cannot catch: a regression to a hardcoded 0 rate would leave the
      // equity flat and slip past them.
      const fundRate = 0.06;
      const monthly = 1 + preciseMonthlyRate(fundRate);
      const series = simulateHousehold(
        {
          horizonMonths: 5,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [
            makeInvestmentAccount(0, 0),
            new SimAccount({
              id: "goal-x",
              ownerId: "p1",
              liquid: false,
              taxProfile: CAPITAL_GAINS_TAX_PROFILE,
              openingBalanceCents: dollarsToCents(4000),
              initialAnnualRate: fundRate,
            }),
          ],
          incomeSeries: [],
          expenseSeries: [],
          goals: [
            {
              id: "x",
              name: "Goal X",
              targetCents: dollarsToCents(4000),
              targetDate: 2,
              fundAccountId: "goal-x",
              priority: 0,
              disposition: "convertToEquity" as const,
              scope: "shared" as const,
            },
          ],
        },
        nullJurisdiction,
      );
      // Fires at end of month 2; the equity opens at month 3 at the matured balance,
      // then appreciates once per month at exactly the fund's 6% (via advanceProperties).
      const opened = series.months[3].propertyValuesCents["goal-equity-x"];
      expect(opened).toBeGreaterThan(0);
      expect(series.months[3].accountBalancesCents["goal-x"]).toBe(0);
      expect(series.months[4].propertyValuesCents["goal-equity-x"]).toBe(
        Math.round(opened! * monthly),
      );
      expect(series.months[5].propertyValuesCents["goal-equity-x"]).toBe(
        Math.round(series.months[4].propertyValuesCents["goal-equity-x"]! * monthly),
      );
    });
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
    // After the goal is capped, the rest idles in checking: month 3 gets $1000, 4–6 get $2000.
    expect(series.months[6].accountBalancesCents["investment"]).toBe(dollarsToCents(7000));
  });

  describe("dated goals amortize to their deadline", () => {
    // Two goals well within budget: $6k by month 6 and $12k by month 12. A $3k/mo
    // income more than covers both paces ($1k + $1k), so the outcome must not depend
    // on priority order and each fund must track an amortized path, not fill-then-idle.
    const near = (priority: number) => ({
      id: "near",
      name: "Near goal",
      targetCents: dollarsToCents(6000),
      targetDate: 6,
      fundAccountId: "near-fund",
      priority,
      disposition: "spend" as const,
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
      // climbs monotonically, and only reaches the target at the month-12 deadline.
      expect(far0).toBeGreaterThan(0);
      expect(far0).toBeLessThan(dollarsToCents(2000));
      expect(far6).toBeGreaterThan(far0);
      expect(far6).toBeLessThan(dollarsToCents(12000));
      expect(far12).toBe(dollarsToCents(12000));
    });

    it("both affordable goals reach 100% regardless of priority order", () => {
      const forward = simulateHousehold(scenario(1, 2), nullJurisdiction);
      const reversed = simulateHousehold(scenario(2, 1), nullJurisdiction);
      // The near goal fires (spend) at month 6, so read its balance AT its deadline.
      for (const s of [forward, reversed]) {
        expect(s.months[6].accountBalancesCents["near-fund"]).toBe(dollarsToCents(6000));
        expect(s.months[12].accountBalancesCents["far-fund"]).toBe(dollarsToCents(12000));
      }
    });
  });
});
