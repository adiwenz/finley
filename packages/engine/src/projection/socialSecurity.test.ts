import { describe, it, expect } from "vitest";
import { Account } from "../account";
import { CashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";
import { simulateHousehold, type HouseholdSimInput, type Person } from "./simulate";

/** A liquid, non-compounding cash account — surplus idles here so net worth = Σ SS deposits. */
function cashAccount(): Account {
  return new Account({
    id: "cash",
    ownerId: "p1",
    liquid: true,
    taxTreatment: "taxable",
    openingBalanceCents: 0,
    initialAnnualRate: 0,
  });
}

function baseInput(person: Person, overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
  return {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2026,
    persons: [person],
    accounts: [cashAccount()],
    incomeSeries: [],
    expenseSeries: [],
    ...overrides,
  };
}

describe("Social Security accumulation + benefit seam (§5.4)", () => {
  it("null jurisdiction: the record accumulates but the benefit is 0", () => {
    // Person already at full retirement age with seeded lifetime earnings, so a
    // benefit *would* be claimed immediately — but the null jurisdiction supplies
    // no seam, so SS income is 0 and net worth stays flat.
    const person: Person = {
      id: "p1",
      name: "You",
      birthYear: 1959, // turns 67 in 2026
      ssClaimingAge: 67,
      priorEarningsCents: { 2020: dollarsToCents(40_000), 2021: dollarsToCents(40_000) },
    };
    const series = simulateHousehold(baseInput(person), nullJurisdiction);
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });

  it("derives the monthly benefit from the accumulated record and injects it post-claim", () => {
    // Stub jurisdiction: benefit = 1% of total covered earnings on record. This
    // proves the seeded EarningsRecord is threaded through to the seam.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      socialSecurityMonthlyBenefitCents: (record) => {
        let total = 0;
        for (const cents of record.annualWagesCents.values()) total += cents;
        return Math.round(total / 100);
      },
    };
    const person: Person = {
      id: "p1",
      name: "You",
      birthYear: 1959,
      ssClaimingAge: 67, // claims from month 0 → benefit every simulated month
      priorEarningsCents: { 2020: dollarsToCents(40_000), 2021: dollarsToCents(40_000) },
    };
    // total = $80,000 = 8,000,000 cents → benefit = 80,000 cents/mo ($800).
    const series = simulateHousehold(baseInput(person), stub);
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(800) * 12);
  });

  it("only pays from the claiming month onward (claiming age is the gate)", () => {
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      socialSecurityMonthlyBenefitCents: () => dollarsToCents(1_000),
    };
    const person: Person = {
      id: "p1",
      name: "You",
      birthYear: 1965, // turns 62 in 2027 → claim starts at month 12
      ssClaimingAge: 62,
    };
    const series = simulateHousehold(baseInput(person, { horizonMonths: 24 }), stub);
    // Nothing before the claim month…
    expect(series.months[11].netWorthNominalCents).toBe(0);
    // …then one deposit per month from month 12 through 24 inclusive (13 months).
    expect(series.months[24].netWorthNominalCents).toBe(dollarsToCents(1_000) * 13);
  });

  it("live (post-now) wage earnings feed the record, not just the pre-now seed", () => {
    // Capture the record the seam sees at claiming so we can assert on it.
    let seenTotal = 0;
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      socialSecurityMonthlyBenefitCents: (record) => {
        for (const cents of record.annualWagesCents.values()) seenTotal += cents;
        return 0;
      },
    };
    const person: Person = {
      id: "p1",
      name: "You",
      birthYear: 1965, // claims at month 12
      ssClaimingAge: 62,
    };
    simulateHousehold(
      baseInput(person, {
        horizonMonths: 24,
        incomeSeries: [
          {
            series: new CashFlowSeries(0, dollarsToCents(5_000), { type: "fixed" }, {
              baselineUnit: "monthly",
            }),
            ownerId: "p1",
          },
        ],
      }),
      stub,
    );
    // Months 1–12 of $5,000 wages accumulated before the claim was priced.
    expect(seenTotal).toBe(dollarsToCents(5_000) * 12);
  });
});
