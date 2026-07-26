import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { SimPerson } from "./simulate.types";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
} from "../simAccount";
import { SimCashFlowSeries, dollarsToCents, preciseMonthlyRate, type TaxCategory } from "../cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";
import {
  makePerson,
  makeInvestmentAccount,
  monthlyIncome,
  monthlyExpense,
} from "./simulate.testSupport";

describe("simulateHousehold", () => {
  it("month 0 is the opening balance, unchanged", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    expect(series.months[0].netWorthNominalCents).toBe(dollarsToCents(10000));
    expect(series.months[0].accountBalancesCents["investment"]).toBe(dollarsToCents(10000));
  });

  it("produces horizonMonths+1 data points", () => {
    const acc = makeInvestmentAccount(0, 0.07);
    const series = simulateHousehold(
      { horizonMonths: 24, annualInflationRate: 0.03, persons: [], accounts: [acc], incomeSeries: [], expenseSeries: [] },
      nullJurisdiction,
    );
    expect(series.months.length).toBe(25);
  });

  it("net cash flow (income - expense) accumulates in the liquid account each month", () => {
    // $3000/mo income, $2000/mo expense → $1000/mo net flow, 0% return
    const acc = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(3000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2000)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    // After 12 months of $1000/mo net flow at 0% return: $12,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(12000));
  });

  it("asset account compounds at preciseMonthlyRate, no cash flow", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    const series = simulateHousehold(
      {
        horizonMonths: 120,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    // $10k @ 7% for 10 years ≈ $19,671.51; integer-cents rounding within a dime
    expect(Math.abs(series.months[120].netWorthNominalCents! - dollarsToCents(19671.51))).toBeLessThanOrEqual(10);
  });

  it("negative net worth (expenses > income) renders below zero", () => {
    const acc = makeInvestmentAccount(0, 0);
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(1000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(2000)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    expect(series.months[6].netWorthNominalCents).toBeLessThan(0);
  });

  it("real net worth < nominal when inflation > 0", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0);
    const series = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );
    expect(series.months[24].netWorthRealCents!).toBeLessThan(series.months[24].netWorthNominalCents!);
  });

  it("all monetary values are integer cents", () => {
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    const series = simulateHousehold(
      {
        horizonMonths: 12,
        annualInflationRate: 0.03,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [{ series: monthlyIncome(dollarsToCents(5000)), ownerId: "p1" }],
        expenseSeries: [{ series: monthlyExpense(dollarsToCents(3500)), ownerId: "p1" }],
      },
      nullJurisdiction,
    );
    for (const m of series.months) {
      expect(Number.isInteger(m.netWorthNominalCents)).toBe(true);
      expect(Number.isInteger(m.netWorthRealCents)).toBe(true);
    }
  });

  it("account with rate change: applies new rate from that month forward", () => {
    // Start $10k, 7% for 12 months, then switch to 0%
    const acc = makeInvestmentAccount(dollarsToCents(10000), 0.07);
    acc.addRateChange(12, 0);

    const series = simulateHousehold(
      {
        horizonMonths: 24,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );

    // After 12 months at 7%, balance should be > $10k
    const balAt12 = series.months[12].netWorthNominalCents;
    expect(balAt12).toBeGreaterThan(dollarsToCents(10000));

    // After 12 more months at 0%, balance unchanged
    expect(series.months[24].netWorthNominalCents).toBe(balAt12);
  });

  it("one-time transfer is applied before compounding in its month", () => {
    // $0 opening, 0% return, $5000 influx at month 3
    const acc = makeInvestmentAccount(0, 0);
    acc.addTransfer({ month: 3, amountCents: dollarsToCents(5000) });

    const series = simulateHousehold(
      {
        horizonMonths: 4,
        annualInflationRate: 0,
        persons: [makePerson()],
        accounts: [acc],
        incomeSeries: [],
        expenseSeries: [],
      },
      nullJurisdiction,
    );

    expect(series.months[2].netWorthNominalCents).toBe(0);
    expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(5000));
    expect(series.months[4].netWorthNominalCents).toBe(dollarsToCents(5000));
  });
});

describe("simulateHousehold — §5.0 allocation waterfall (issue #7)", () => {
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

  it("the annual deferral cap is enforced across the calendar year (§5.4)", () => {
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

  it("the deferral cap is age-aware: an over-50 catch-up raises one person's limit (§5.4)", () => {
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

  describe("goal disposition firing at maturity (§5.2, #28)", () => {
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

    it("`convertToEquity` synthesizes equity that appreciates at the FUND's own rate (AC3)", () => {
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

  describe("dated goals amortize to their deadline (#26/#69 AC3, AC7)", () => {
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

    it("amortizes the far goal along a rising path instead of filling it then idling (AC7)", () => {
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

    it("both affordable goals reach 100% regardless of priority order (AC3)", () => {
      const forward = simulateHousehold(scenario(1, 2), nullJurisdiction);
      const reversed = simulateHousehold(scenario(2, 1), nullJurisdiction);
      // The near goal fires (spend) at month 6, so read its balance AT its deadline.
      for (const s of [forward, reversed]) {
        expect(s.months[6].accountBalancesCents["near-fund"]).toBe(dollarsToCents(6000));
        expect(s.months[12].accountBalancesCents["far-fund"]).toBe(dollarsToCents(12000));
      }
    });
  });

  describe("Savings interest is taxed as ordinary income at accrual (Commit 2, #94)", () => {
    // A cash account's return is interest — taxable as ordinary income in the year it
    // is credited (the 1099-INT), whether or not it is ever withdrawn. Before this the
    // model credited the growth straight to the balance and never booked the tax, so
    // decades of compounding rode untaxed. Flat 10% on ordinary income (wages default to
    // ordinaryIncome), so the tax figure is easy to read off.
    const flatOrdinary10: Jurisdiction = {
      id: "flat-ordinary-10",
      computeTaxCents: (byCat) =>
        Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.1),
      // The per-category breakdown seam (§5.3, #110) — 10% of each taxable category. Supplying
      // it lets the waterfall attribute tax per source, so a source's net cash flow is defined.
      computeTaxByCategoryCents: (byCat) => {
        const out: Partial<Record<TaxCategory, number>> = {};
        for (const [cat, cents] of Object.entries(byCat)) {
          if (cents) out[cat as TaxCategory] = Math.round(cents * 0.1);
        }
        return out;
      },
      // Interest is taxed at accrual as ordinary income; capital appreciation is deferred
      // to withdrawal — the same split the US jurisdiction makes. Keyed on the account's
      // `returnKind` (the brokerage now declares "appreciation" explicitly, so the deferral
      // is this jurisdiction's decision, not an engine default-by-omission).
      returnTaxTreatment: (kind) =>
        kind === "interest"
          ? { taxAtAccrual: true, category: "ordinaryIncome" }
          : { taxAtAccrual: false, category: "capitalGains" },
    };

    /** A liquid cash buffer (savings) — post-tax in, tax-free withdrawal, taxable interest. */
    function savings(openingDollars: number, annualRate: number, id = "savings"): SimAccount {
      return new SimAccount({
        id,
        ownerId: "p1",
        liquid: id === "savings",
        taxProfile: CASH_INTEREST_TAX_PROFILE,
        openingBalanceCents: dollarsToCents(openingDollars),
        initialAnnualRate: annualRate,
      });
    }

    function run(annualRate: number) {
      return simulateHousehold(
        {
          horizonMonths: 4,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [savings(120_000, annualRate)],
          // Steady $3k/mo covers the (absent) obligations; surplus idles into savings, so
          // the buffer is never WITHDRAWN — its interest is the only thing under test.
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
          expenseSeries: [],
        },
        flatOrdinary10,
      );
    }

    it("taxes the credited interest the year after it is credited, never $0 while growing", () => {
      const series = run(0.12); // ~1%/mo on a six-figure buffer → four-figure annual interest
      // Month 1: only wages are taxable — the interest has not compounded yet (accrual
      // lag: compounding runs after the tax seam), so tax is exactly 10% of $3k.
      expect(series.months[1].flows?.taxCents).toBe(dollarsToCents(300));
      // Month 2 onward: last month's credited interest is now taxed on top of wages, so
      // the retirement/earning month no longer reports the wage-only figure.
      expect(series.months[2].flows?.taxCents).toBeGreaterThan(dollarsToCents(300));
      expect(series.months[3].flows?.taxCents).toBeGreaterThan(dollarsToCents(300));
      // The buffer is never drawn — it only grows — yet its interest is still taxed.
      const b1 = series.months[1].accountBalancesCents["savings"];
      const b3 = series.months[3].accountBalancesCents["savings"];
      expect(b3).toBeGreaterThan(b1);
      expect(b1).toBeGreaterThan(dollarsToCents(120_000));
    });

    it("books nothing when the buffer earns no interest (0% return → wage-only tax)", () => {
      // The control: with a flat cash rate of 0 there is no credited interest, so every
      // month reports the bare wage tax. This isolates the interest as the cause above.
      const series = run(0);
      for (const m of [1, 2, 3, 4]) {
        expect(series.months[m].flows?.taxCents).toBe(dollarsToCents(300));
      }
    });

    it("taxes EVERY cash account's interest, not only the liquid shortfall sink", () => {
      // The model can hold more than one cash account (a second savings/reserve).
      // Interest accrual is a per-account tax keyed on the account's `returnTaxCategory`,
      // not on the single liquid sink, so a second NON-liquid cash buffer's interest
      // must be taxed too. Hold the topology fixed — same liquid buffer, same surplus
      // sweep — and vary ONLY the second account: a brokerage (return deferred, taxed
      // at a withdrawal that never happens → adds no tax) vs a cash reserve (interest
      // taxed at accrual). Same balance and rate on both, so the tax gap is exactly the
      // reserve's interest tax, with no surplus-sweep confound.
      const brokerage = new SimAccount({
        id: "brokerage",
        ownerId: "p1",
        liquid: false,
        taxProfile: CAPITAL_GAINS_TAX_PROFILE,
        openingBalanceCents: dollarsToCents(120_000),
        initialAnnualRate: 0.12,
      });
      const reserve = savings(120_000, 0.12, "reserve"); // a second, NON-liquid cash buffer
      function runWith(second: SimAccount) {
        return simulateHousehold(
          {
            horizonMonths: 4,
            annualInflationRate: 0,
            persons: [makePerson()],
            accounts: [savings(120_000, 0.12), second],
            incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
            expenseSeries: [],
          },
          flatOrdinary10,
        );
      }
      // Month 2 taxes month 1's credited interest. The brokerage's growth is deferred
      // (never withdrawn → never taxed); the reserve's interest is taxed at accrual, so
      // the reserve run taxes strictly more — it would be EQUAL if the second buffer's
      // interest were dropped (the old single-liquid-account bug).
      const brokerageTax = runWith(brokerage).months[2].flows?.taxCents ?? 0;
      const reserveTax = runWith(reserve).months[2].flows?.taxCents ?? 0;
      expect(reserveTax).toBeGreaterThan(brokerageTax);
      // The gap is ~10% of the reserve's ~$1.1k first-month interest on $120k — the
      // reserve's interest is genuinely booked, not silently dropped or overwritten.
      expect(reserveTax - brokerageTax).toBeGreaterThan(dollarsToCents(100));
    });

    // ── Savings interest is real household cash: the cash-flow reconciliation (#94 follow-up)
    //
    // Interest must reconcile four ways at once — it credits the account, enters the
    // waterfall (once, for tax), shows on the cash-flow view as real cash, and has its tax
    // netted off — WITHOUT being double-counted against the balance. The desired shape, for
    // $500 of interest taxed $100: cash inflow $500, tax $100, net cash flow $400, and the
    // account still credited the full $500 (the tax is paid from other cash, not the balance).

    it("reports credited interest as a cash inflow and nets its tax off (cash flow ≠ zero)", () => {
      const series = run(0.12);
      // Month 2 carries last month's credited interest as a source (month 1 hasn't compounded
      // yet). It is banded — not dropped as it was when it reported waterfallInflowCents 0. The
      // engine tags it with the explicit `savingsInterest` provenance (its tax category stays
      // ordinaryIncome), which is how it is identified — never by parsing its id.
      const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
      expect(interest).toBeDefined();
      expect(interest!.label).toBe("Savings interest");
      expect(interest!.cashInflowCents).toBeGreaterThan(0);
      // Its tax is 10% of the interest (flatOrdinary10), attributed back to the interest
      // source, and the engine's net cash flow is exactly cash inflow − that tax.
      const tax = series.months[2].flows?.taxBySourceCents?.[interest!.sourceId] ?? 0;
      // ~10% of the interest (±1¢ from the largest-remainder apportionment of the category tax).
      expect(Math.abs(tax - Math.round(interest!.cashInflowCents * 0.1))).toBeLessThanOrEqual(1);
      expect(tax).toBeGreaterThan(0);
      expect(interest!.netCashFlowCents).toBe(interest!.cashInflowCents - tax);
      expect(interest!.netCashFlowCents).toBeLessThan(interest!.cashInflowCents); // tax deducted
      // …and it counts toward the household's taxable-income total (wages + interest).
      expect(series.months[2].flows?.totalIncomeCents).toBe(
        dollarsToCents(3_000) + interest!.cashInflowCents,
      );
    });

    it("credits the account exactly once — the interest cash is never re-deposited", () => {
      // No income, no expenses: the only things moving the balance are compounding and the
      // tax on the interest (now drawn from the balance via the §5.1 cascade — see below). If
      // the interest booking's cash were (wrongly) re-injected, month 2 would jump by roughly a
      // second interest payment; instead it only grows by the net interest.
      const series = simulateHousehold(
        {
          horizonMonths: 4,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [savings(120_000, 0.12)],
          incomeSeries: [],
          expenseSeries: [],
        },
        flatOrdinary10,
      );
      const opening = dollarsToCents(120_000);
      const r = preciseMonthlyRate(0.12);
      const b1 = series.months[1].accountBalancesCents["savings"];
      const b2 = series.months[2].accountBalancesCents["savings"];
      // Month 1 has no interest source yet (nothing accrued) → pure compounding.
      expect(b1).toBe(Math.round(opening * (1 + r)));
      // Month 2 taxes month 1's interest; with no other income that tax is a deficit funded
      // from the balance, so month 2 is (prior balance − that tax) compounded once — NOT a
      // second interest credit on top.
      const tax = series.months[2].flows?.taxCents ?? 0;
      expect(tax).toBeGreaterThan(0);
      expect(b2).toBe(Math.round((b1 - tax) * (1 + r)));
      // No double-count: month 2's growth is at most one interest payment (net of tax it is
      // less), never the two a re-deposit would add.
      const grewBy = b2 - b1;
      const interest = series.months[2].flows?.incomeSources.find((s) => s.category === "savingsInterest");
      expect(interest?.cashInflowCents).toBeGreaterThan(0);
      expect(grewBy).toBeLessThan(interest!.cashInflowCents); // net of tax → below one gross payment
    });

    it("keeps flat brokerage ROI as non-cash growth — no interest cash inflow, no accrual tax", () => {
      // A brokerage's return is unrealized appreciation (deferred), not cash: it must never
      // book a cash-inflow source, so paper gains can't inflate the cash-flow view.
      const brokerage = new SimAccount({
        id: "brokerage",
        ownerId: "p1",
        liquid: false,
        taxProfile: CAPITAL_GAINS_TAX_PROFILE,
        openingBalanceCents: dollarsToCents(120_000),
        initialAnnualRate: 0.12,
      });
      const series = simulateHousehold(
        {
          horizonMonths: 4,
          annualInflationRate: 0,
          persons: [makePerson()],
          // A liquid cash sink for surplus, plus the brokerage under test. The cash sink
          // earns 0% so the ONLY candidate for an ordinaryIncome cash inflow is the brokerage.
          accounts: [savings(0, 0, "cash"), brokerage],
          incomeSeries: [{ series: monthlyIncome(dollarsToCents(3_000)), ownerId: "p1" }],
          expenseSeries: [],
        },
        flatOrdinary10,
      );
      for (const m of [1, 2, 3, 4]) {
        const sources = series.months[m].flows?.incomeSources ?? [];
        // The brokerage's growth is deferred — it appears as no savings-interest source at all.
        expect(sources.some((s) => s.category === "savingsInterest")).toBe(false);
        // And its balance still grows untaxed at accrual (wage-only tax every month).
        expect(series.months[m].flows?.taxCents).toBe(dollarsToCents(300));
      }
      expect(series.months[4].accountBalancesCents["brokerage"]).toBeGreaterThan(dollarsToCents(120_000));
    });
  });

  describe("Already-credited savings interest funds spending without double-counting (#94)", () => {
    // The behavioural reconciliation the cash-flow fix is really about: interest that already
    // compounded into the balance can be spent, is reported as real cash, is taxed, and leaves
    // the account reconciling — with no phantom second credit and no false shortfall.
    //   Beginning savings $10,000 · interest +$500 · other income $0 · spending $400 · tax $100
    //   ⇒ cashInflow $500, net cash flow $400, spending funded, ending savings $10,000.
    const flat20: Jurisdiction = {
      id: "flat-ordinary-20",
      computeTaxCents: (byCat) => Math.round(((byCat.ordinaryIncome ?? 0) + (byCat.wages ?? 0)) * 0.2),
      computeTaxByCategoryCents: (byCat) => {
        const out: Partial<Record<TaxCategory, number>> = {};
        for (const [cat, cents] of Object.entries(byCat)) {
          if (cents) out[cat as TaxCategory] = Math.round(cents * 0.2);
        }
        return out;
      },
      returnTaxTreatment: (kind) =>
        kind === "interest"
          ? { taxAtAccrual: true, category: "ordinaryIncome" }
          : { taxAtAccrual: false, category: "capitalGains" },
    };

    /**
     * The scenario: $10,000 savings earns exactly $500 in month 1 (5%/month, no spending yet),
     * then the rate drops to 0 so month 2 books no NEW interest. Spending ($400) starts in
     * month 2, when month 1's $500 is reported. So month 2 is the reconciliation month:
     * already-credited interest, real spending, its tax, nothing else moving.
     */
    function runReconciliation() {
      const acct = new SimAccount({
        id: "savings",
        ownerId: "p1",
        liquid: true,
        taxProfile: CASH_INTEREST_TAX_PROFILE,
        openingBalanceCents: dollarsToCents(10_000),
        initialAnnualRate: Math.pow(1.05, 12) - 1, // → preciseMonthlyRate = exactly 5%
      });
      acct.addRateChange(2, 0); // no further interest after month 1's credit
      return simulateHousehold(
        {
          horizonMonths: 3,
          annualInflationRate: 0,
          persons: [makePerson()],
          accounts: [acct],
          incomeSeries: [], // other income: $0
          expenseSeries: [
            {
              series: new SimCashFlowSeries(2, dollarsToCents(400), { type: "fixed" }, { baselineUnit: "monthly" }),
              ownerId: "p1",
            },
          ],
        },
        flat20,
      );
    }

    it("reports the $500 interest as cash in, nets its $100 tax to $400, and funds the $400 spend", () => {
      const series = runReconciliation();
      // Month 1 credits exactly $500 (5% on $10,000) — one credit, no spending yet.
      expect(series.months[1].accountBalancesCents["savings"]).toBe(dollarsToCents(10_500));

      const m2 = series.months[2];
      const interest = m2.flows!.incomeSources.find((s) => s.category === "savingsInterest")!;
      // cashInflow = $500: the already-credited interest is reported as real household cash.
      expect(interest.cashInflowCents).toBe(dollarsToCents(500));
      // Its tax is $100 (flat 20%), attributed to the interest source; net cash flow = $400.
      expect(m2.flows!.taxBySourceCents![interest.sourceId]).toBe(dollarsToCents(100));
      expect(interest.netCashFlowCents).toBe(dollarsToCents(400));
      // The $400 spend is funded and the month stays solvent — no FALSE shortfall/insolvency
      // (the gap is genuinely met by the savings the interest is part of).
      expect(m2.flows!.totalSpendingCents).toBe(dollarsToCents(400));
      expect(m2.isInsolvent).toBe(false);
    });

    it("credits the interest exactly once and reconciles fully: beginning + interest − spend − tax", () => {
      const series = runReconciliation();
      const begin = dollarsToCents(10_000);
      const b1 = series.months[1].accountBalancesCents["savings"];
      const b2 = series.months[2].accountBalancesCents["savings"];
      // The interest hits the balance exactly ONCE: month 1 is beginning + $500, full stop —
      // not beginning + $500 + a second re-deposited $500.
      expect(b1).toBe(begin + dollarsToCents(500));
      // Month 2 draws the $400 spend AND the $100 interest tax out of that balance — the tax,
      // owed on income that brought no cash into the waterfall, is funded by the §5.1 cascade
      // rather than dropped. Ending reconciles fully: $10,000 + $500 − $400 − $100 = $10,000.
      expect(b2).toBe(begin + dollarsToCents(500) - dollarsToCents(400) - dollarsToCents(100));
      expect(b2).toBe(dollarsToCents(10_000));
    });
  });
});
