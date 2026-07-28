import { describe, it, expect } from "vitest";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction";
import { simulateHousehold, type HouseholdSimInput } from "./simulate";
import type { SimPerson } from "./simulate.types";

/** A liquid, non-compounding cash account — surplus idles here so net worth = Σ benefit deposits. */
function cashAccount(): SimAccount {
  return new SimAccount({
    id: "cash",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: 0,
    initialAnnualRate: 0,
  });
}

function baseInput(person: SimPerson, overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
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

/**
 * Stand-in COLA seam mirroring the `rules` formula: grow the opaque base by
 * `(1 + colaRate)^(currentAge − 62)`. The engine holds the base and calls this per year; the
 * single factor folds in both the eligibility bridge and forward COLA.
 */
const colaFrom62: NonNullable<Jurisdiction["colaAdjustedBenefitCents"]> = (base, ctx) =>
  Math.round(base * Math.pow(1 + ctx.colaRate, ctx.currentAge - 62));

describe("government-benefit accumulation + benefit seam", () => {
  it("null jurisdiction: the record accumulates but the benefit is 0", () => {
    // Already at full retirement age with seeded earnings, so a benefit *would* be claimed
    // immediately — but the null jurisdiction supplies no seam.
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959, // turns 67 in 2026
      benefitClaimingAge: 67,
      priorEarningsCents: { 2020: dollarsToCents(40_000), 2021: dollarsToCents(40_000) },
    };
    const series = simulateHousehold(baseInput(person), nullJurisdiction);
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });

  it("derives the monthly benefit from the accumulated record and injects it post-claim", () => {
    // Benefit = 1% of total covered earnings, proving the seeded EarningsRecord reaches
    // the seam.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: (claim) => {
        let total = 0;
        for (const cents of claim.record.annualWagesCents.values()) total += cents;
        return Math.round(total / 100);
      },
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959,
      benefitClaimingAge: 67, // claims from month 0 → benefit every simulated month
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
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1965, // turns 62 in 2027 → claim starts at month 12
      benefitClaimingAge: 62,
    };
    const series = simulateHousehold(baseInput(person, { horizonMonths: 24 }), stub);
    // Nothing before the claim month…
    expect(series.months[11].netWorthNominalCents).toBe(0);
    // …then one deposit per month from month 12 through 24 inclusive (13 months).
    expect(series.months[24].netWorthNominalCents).toBe(dollarsToCents(1_000) * 13);
  });

  it("live (post-now) wage earnings feed the record, not just the pre-now seed", () => {
    // Capture the record at the FIRST (claim-time) pricing; the base is re-priced later
    // while working, so only the initial call is asserted.
    let seenTotal: number | undefined;
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: (claim) => {
        if (seenTotal === undefined) {
          seenTotal = 0;
          for (const cents of claim.record.annualWagesCents.values()) seenTotal += cents;
        }
        return 0;
      },
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1965, // claims at month 12
      benefitClaimingAge: 62,
    };
    simulateHousehold(
      baseInput(person, {
        horizonMonths: 24,
        incomeSeries: [
          {
            series: new SimCashFlowSeries(0, dollarsToCents(5_000), { type: "fixed" }, {
              baselineUnit: "monthly",
              taxCategory: "wages",
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

  it("consults the jurisdiction's isCoveredEarnings predicate for what feeds the record", () => {
    // Counts ONLY `wages` as covered. The engine must route the covered-earnings decision
    // through the seam, so only the wages stream reaches the record.
    let seenTotal: number | undefined;
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      isCoveredEarnings: (cat) => cat === "wages",
      governmentBenefitBaseMonthlyCents: (claim) => {
        if (seenTotal === undefined) {
          seenTotal = 0;
          for (const cents of claim.record.annualWagesCents.values()) seenTotal += cents;
        }
        return 0;
      },
    };
    const person: SimPerson = { id: "p1", name: "You", birthYear: 1965, benefitClaimingAge: 62 };
    simulateHousehold(
      baseInput(person, {
        horizonMonths: 24,
        incomeSeries: [
          {
            series: new SimCashFlowSeries(0, dollarsToCents(5_000), { type: "fixed" }, {
              baselineUnit: "monthly",
              taxCategory: "wages",
            }),
            ownerId: "p1",
          },
          {
            series: new SimCashFlowSeries(0, dollarsToCents(3_000), { type: "fixed" }, {
              baselineUnit: "monthly",
              taxCategory: "ordinaryIncome",
            }),
            ownerId: "p1",
          },
        ],
      }),
      stub,
    );
    // Only the $5,000 wages stream (months 1–12) counts; ordinaryIncome is excluded.
    expect(seenTotal).toBe(dollarsToCents(5_000) * 12);
  });

  it("falls back to wages-only covered earnings when the jurisdiction omits the predicate", () => {
    // No isCoveredEarnings → the engine's documented default covers `wages` only, so the
    // ordinaryIncome stream never reaches the record.
    let seenTotal = 0;
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: (claim) => {
        for (const cents of claim.record.annualWagesCents.values()) seenTotal += cents;
        return 0;
      },
    };
    const person: SimPerson = { id: "p1", name: "You", birthYear: 1965, benefitClaimingAge: 62 };
    simulateHousehold(
      baseInput(person, {
        horizonMonths: 24,
        incomeSeries: [
          {
            series: new SimCashFlowSeries(0, dollarsToCents(4_000), { type: "fixed" }, {
              baselineUnit: "monthly",
              taxCategory: "ordinaryIncome",
            }),
            ownerId: "p1",
          },
        ],
      }),
      stub,
    );
    expect(seenTotal).toBe(0);
  });

  it("passes the full benefit gross to the seam, which owns the inclusion % (partial taxation)", () => {
    // The engine hands the FULL $1,000 gross tagged `governmentRetirementBenefit`; the
    // jurisdiction applies its own 50% inclusion then 20% → tax $100 → take-home $900
    // (not $800 if fully taxed). The untaxed half is still spendable cash.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: (byCat) =>
        Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.5 * 0.2),
      // Attribution contract: single category, so the breakdown is exact.
      computeTaxByCategoryCents: (byCat) => {
        const t = Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.5 * 0.2);
        return t > 0 ? { governmentRetirementBenefit: t } : {};
      },
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959, // turns 67 in 2026 → claims from month 0
      benefitClaimingAge: 67,
    };
    const series = simulateHousehold(baseInput(person), stub);
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(900) * 12);
  });

  it("inflates the post-claim benefit by the COLA (CPI) rate each year", () => {
    // Claiming at 62 (= eligibility) means no bridge, isolating the forward COLA: the paid
    // benefit rises by the COLA rate on each full year elapsed since the claim month — a
    // step function, not monthly compounding. The cash account is non-compounding, so each
    // month's net-worth delta *is* that month's paid benefit.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
      colaAdjustedBenefitCents: colaFrom62,
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1964, // turns 62 in 2026 → claims from month 0, no eligibility bridge
      benefitClaimingAge: 62,
    };
    const series = simulateHousehold(
      baseInput(person, { horizonMonths: 24, annualInflationRate: 0.1 }),
      stub,
    );
    const paidInMonth = (m: number) =>
      series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;
    expect(paidInMonth(1)).toBe(dollarsToCents(1_000)); // claim year → base benefit
    expect(paidInMonth(12)).toBe(dollarsToCents(1_100)); // +1 full year → ×1.10
    expect(paidInMonth(24)).toBe(dollarsToCents(1_210)); // +2 full years → ×1.10²
  });

  it("COLA-bridges a delayed claim from age-62 eligibility to the claim year", () => {
    // A benefit claimed after 62 must carry the COLAs accrued since eligibility, else
    // delaying forfeits them. PIA $1,000 (age-62 dollars), 10% CPI, claim at 67 → 5 years
    // bridged: first paid benefit = $1,000 × 1.1⁵.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
      colaAdjustedBenefitCents: colaFrom62,
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959, // turns 67 in 2026 → claims from month 0
      benefitClaimingAge: 67,
    };
    const series = simulateHousehold(
      baseInput(person, { horizonMonths: 12, annualInflationRate: 0.1 }),
      stub,
    );
    const paidInMonth1 =
      series.months[1].netWorthNominalCents! - series.months[0].netWorthNominalCents!;
    expect(paidInMonth1).toBe(Math.round(dollarsToCents(1_000) * Math.pow(1.1, 5)));
  });

  it("with zero inflation the post-claim benefit stays flat (COLA back-compat)", () => {
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959,
      benefitClaimingAge: 67,
    };
    // annualInflationRate defaults to 0 in baseInput → COLA is a no-op.
    const series = simulateHousehold(baseInput(person, { horizonMonths: 24 }), stub);
    expect(series.months[24].netWorthNominalCents).toBe(dollarsToCents(1_000) * 24);
  });

  it("a jurisdiction may tax the whole benefit (no inclusion cap)", () => {
    // 100% inclusion at a flat 20% → tax $200 → take-home $800/mo. Inclusion is the
    // jurisdiction's call, not an engine-side fraction.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: (byCat) => Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.2),
      // Attribution contract: single category, so the breakdown is exact.
      computeTaxByCategoryCents: (byCat) => {
        const t = Math.round((byCat.governmentRetirementBenefit ?? 0) * 0.2);
        return t > 0 ? { governmentRetirementBenefit: t } : {};
      },
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959,
      benefitClaimingAge: 67,
    };
    const series = simulateHousehold(baseInput(person), stub);
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(800) * 12);
  });

  it("benefitColaRate defaults to general inflation when unset", () => {
    // No benefitColaRate on the input → the benefit COLA is coupled to general CPI.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
      colaAdjustedBenefitCents: colaFrom62,
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1964, // turns 62 in 2026 → claims from month 0
      benefitClaimingAge: 62,
    };
    const series = simulateHousehold(
      baseInput(person, { horizonMonths: 24, annualInflationRate: 0.1 }),
      stub,
    );
    const paidInMonth = (m: number) =>
      series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;
    expect(paidInMonth(1)).toBe(dollarsToCents(1_000));
    expect(paidInMonth(12)).toBe(dollarsToCents(1_100)); // +1yr × 1.10 (= general CPI)
  });

  it("benefitColaRate decouples the benefit COLA from general inflation", () => {
    // An explicit benefitColaRate overrides general CPI for the benefit's COLA only.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
      colaAdjustedBenefitCents: colaFrom62,
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1964,
      benefitClaimingAge: 62,
    };
    const series = simulateHousehold(
      baseInput(person, {
        horizonMonths: 24,
        annualInflationRate: 0.1,
        benefitColaRate: 0.05,
      }),
      stub,
    );
    const paidInMonth = (m: number) =>
      series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;
    expect(paidInMonth(1)).toBe(dollarsToCents(1_000)); // claim year → base
    expect(paidInMonth(12)).toBe(dollarsToCents(1_050)); // +1yr × 1.05 (benefitColaRate, not 1.10)
  });

  it("recomputes the base while the claimant keeps working", () => {
    // The stub base scales with the record, and the claimant keeps earning covered wages,
    // so each completed year re-prices it upward. No inflation, so any increase is the
    // recompute, not COLA.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      isCoveredEarnings: (cat) => cat === "wages",
      governmentBenefitBaseMonthlyCents: (claim) => {
        let total = 0;
        for (const cents of claim.record.annualWagesCents.values()) total += cents;
        return Math.round(total / 1_000);
      },
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1964, // turns 62 in 2026 → claims from month 0
      benefitClaimingAge: 62,
      priorEarningsCents: {
        2023: dollarsToCents(40_000),
        2024: dollarsToCents(40_000),
        2025: dollarsToCents(40_000),
      },
    };
    const series = simulateHousehold(
      baseInput(person, {
        horizonMonths: 48,
        incomeSeries: [
          {
            series: new SimCashFlowSeries(0, dollarsToCents(4_000), { type: "fixed" }, {
              baselineUnit: "monthly",
              taxCategory: "wages",
            }),
            ownerId: "p1",
          },
        ],
      }),
      stub,
    );
    const paidInMonth = (m: number) =>
      series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;
    // Strictly higher later — the completed working years bumped it.
    expect(paidInMonth(40)).toBeGreaterThan(paidInMonth(1));
  });

  it("keeps the base frozen for a retire-then-claim record that never grows", () => {
    // Same earnings-sensitive stub but no post-claim covered wages, so the record is static
    // and the base never re-priced. With no inflation the paid benefit is flat.
    const stub: Jurisdiction = {
      id: "stub",
      computeTaxCents: () => 0,
      computeTaxByCategoryCents: () => ({}),
      isCoveredEarnings: (cat) => cat === "wages",
      governmentBenefitBaseMonthlyCents: (claim) => {
        let total = 0;
        for (const cents of claim.record.annualWagesCents.values()) total += cents;
        return Math.round(total / 1_000);
      },
    };
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1964,
      benefitClaimingAge: 62,
      priorEarningsCents: {
        2023: dollarsToCents(40_000),
        2024: dollarsToCents(40_000),
        2025: dollarsToCents(40_000),
      },
    };
    const series = simulateHousehold(baseInput(person, { horizonMonths: 48 }), stub);
    const paidInMonth = (m: number) =>
      series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;
    expect(paidInMonth(40)).toBe(paidInMonth(1));
  });
});
