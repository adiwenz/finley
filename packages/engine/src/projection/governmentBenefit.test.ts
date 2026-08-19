import { describe, it, expect } from "vitest";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
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
 * `(1 + colaRate)^(currentAge − 62)`. The single factor folds in both the eligibility bridge
 * and forward COLA.
 */
const colaFrom62: NonNullable<Jurisdiction["colaAdjustedBenefitCents"]> = (base, ctx) =>
  Math.round(base * Math.pow(1 + ctx.colaRate, ctx.currentAge - 62));

describe("government-benefit accumulation + benefit seam", () => {
  it("null jurisdiction: the record accumulates but the benefit is 0", () => {
    // Already at full retirement age with seeded earnings, so a benefit would be claimed
    // immediately if the null jurisdiction supplied a seam.
    const person: SimPerson = {
      id: "p1",
      name: "You",
      birthYear: 1959, // turns 67 in 2026
      benefitClaimingAge: 67,
      priorEarningsCents: { 2020: dollarsToCents(40_000), 2021: dollarsToCents(40_000) },
    };
    const series = simulateHousehold(baseInput(person), nullJurisdiction);
    expect(series.months[11].netWorthNominalCents).toBe(0);
  });

  it("derives the monthly benefit from the accumulated record and injects it post-claim", () => {
    // Benefit = 1% of total covered earnings, so the seeded EarningsRecord must reach the seam.
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
    // total = $80,000 = 8,000,000 cents → benefit = 80,000 cents/mo ($800). Claimed from
    // month 0, so months[0..11] each deposit once: 12 deposits by the end of year 0.
    const series = simulateHousehold(baseInput(person), stub);
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(800) * 12);
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
    expect(series.months[11].netWorthNominalCents).toBe(0);
    // One deposit per processed month from 12 through 23 inclusive: 12 months.
    expect(series.months[23].netWorthNominalCents).toBe(dollarsToCents(1_000) * 12);
  });

  it("live (post-now) wage earnings feed the record, not just the pre-now seed", () => {
    // Capture the record at the FIRST (claim-time) pricing: the base is re-priced later while
    // working, so only the initial call is asserted.
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
    // Year 0 (2026, months 0–11) now accrues its full 12 covered-earnings months, plus month
    // 12 (Jan 2027) folded in before the claim is priced: 13 wage-months of $5,000.
    expect(seenTotal).toBe(dollarsToCents(5_000) * 13);
  });

  it("consults the jurisdiction's isCoveredEarnings predicate for what feeds the record", () => {
    // The stub counts ONLY `wages` as covered, so only that stream may reach the record.
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
    // Only the $5,000 wages stream counts; ordinaryIncome is excluded. Year 0's full 12
    // months plus month 12 captured at claim pricing → 13 wage-months.
    expect(seenTotal).toBe(dollarsToCents(5_000) * 13);
  });

  it("falls back to wages-only covered earnings when the jurisdiction omits the predicate", () => {
    // No isCoveredEarnings → the engine's documented default covers `wages` only.
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
    // The engine hands over the FULL $1,000 gross; the jurisdiction applies its own 50%
    // inclusion then 20% → tax $100 → take-home $900, not the $800 of full taxation.
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
    // Nothing is withheld during the year the benefit is earned in — the whole liability
    // settles the following April (month 15), charging the year's twelve months at once:
    // 10% of $12,000.
    const series = simulateHousehold(baseInput(person, { horizonMonths: 16 }), stub);
    expect(series.months[15].flows!.taxCents).toBe(dollarsToCents(1_200));
  });

  it("inflates the post-claim benefit by the COLA (CPI) rate each year", () => {
    // Claiming at 62 (= eligibility) means no bridge, isolating the forward COLA: the paid
    // benefit steps up on each full year elapsed since the claim month, rather than compounding
    // monthly. The cash account is non-compounding, so each net-worth delta *is* that month's
    // paid benefit.
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
    // Horizon 25 so month 24 (year 2028, the ×1.10² step) is a processed month.
    const series = simulateHousehold(
      baseInput(person, { horizonMonths: 25, annualInflationRate: 0.1 }),
      stub,
    );
    const paidInMonth = (m: number) =>
      series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;
    expect(paidInMonth(1)).toBe(dollarsToCents(1_000)); // claim year → base benefit
    expect(paidInMonth(12)).toBe(dollarsToCents(1_100)); // +1 full year → ×1.10
    expect(paidInMonth(24)).toBe(dollarsToCents(1_210)); // +2 full years → ×1.10²
  });

  it("COLA-bridges a delayed claim from age-62 eligibility to the claim year", () => {
    // A benefit claimed after 62 must carry the COLAs accrued since eligibility, else delaying
    // forfeits them. PIA $1,000 (age-62 dollars), 10% CPI, claim at 67 → 5 years bridged.
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
    // 24 processed months (0–23), each depositing $1,000 from the month-0 claim.
    expect(series.months[23].netWorthNominalCents).toBe(dollarsToCents(1_000) * 24);
  });

  it("a jurisdiction may tax the whole benefit (no inclusion cap)", () => {
    // 100% inclusion at a flat 20% → tax $200 → take-home $800/mo. Inclusion is the
    // jurisdiction's call, never an engine-side fraction.
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
    // Nothing is withheld during the year the benefit is earned in — the whole liability
    // settles the following April (month 15), charging the year's twelve months at once:
    // 20% of $12,000.
    const series = simulateHousehold(baseInput(person, { horizonMonths: 16 }), stub);
    expect(series.months[15].flows!.taxCents).toBe(dollarsToCents(2_400));
  });

  it("benefitColaRate defaults to general inflation when unset", () => {
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
    // The stub base scales with the record and the claimant keeps earning covered wages, so
    // each completed year re-prices it. No inflation, so any increase is the recompute, not COLA.
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
    expect(paidInMonth(40)).toBeGreaterThan(paidInMonth(1));
  });

  it("keeps the base frozen for a retire-then-claim record that never grows", () => {
    // Same earnings-sensitive stub, but no post-claim covered wages: the record is static, so
    // the base is never re-priced and with no inflation the paid benefit stays flat.
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

describe("a benefit is bounded by the active window, exactly as a wage is", () => {
  const flatBenefit: Jurisdiction = {
    id: "stub",
    computeTaxCents: () => 0,
    computeTaxByCategoryCents: () => ({}),
    governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
  };

  /** Claiming from month 0, so every simulated month is a month they COULD be paid. */
  const claimingNow = (activeWindow?: SimPerson["activeWindow"]): SimPerson => ({
    id: "p1",
    name: "You",
    birthYear: 1959,
    benefitClaimingAge: 67,
    ...(activeWindow !== undefined ? { activeWindow } : {}),
  });

  /** What this month deposited — the benefit is the only inflow, so it is the whole delta. */
  const paidIn = (series: ReturnType<typeof simulateHousehold>, m: number) =>
    series.months[m].netWorthNominalCents! - series.months[m - 1].netWorthNominalCents!;

  it("stops paying a member who has left, without erasing that they were ever here", () => {
    // The separation case. The roster is everyone who EVER joined and is never pruned — the
    // earnings a departed partner banked are still theirs — so this loop is the only thing
    // standing between a person's benefit and a household they no longer belong to. It used to
    // pay them for the rest of the projection: separate at 50 and their whole Social Security
    // still arrived from 67 onward, inflating net worth and pulling the solved age earlier.
    const series = simulateHousehold(
      baseInput(claimingNow({ startMonth: 0, endMonthExclusive: 6 }), { horizonMonths: 12 }),
      flatBenefit,
    );
    expect(paidIn(series, 5)).toBe(dollarsToCents(1_000));
    for (const m of [6, 7, 11]) expect(paidIn(series, m)).toBe(0);
    // And nothing is clawed back: the months they were a member keep their deposits.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(1_000) * 6);
  });

  it("pays nothing before they joined, however old they already are", () => {
    // The other end of the same window, and not a hypothetical: a partner joining at 70 has
    // been claiming for years, and those years are not this household's money.
    const series = simulateHousehold(
      baseInput(claimingNow({ startMonth: 6, endMonthExclusive: Number.POSITIVE_INFINITY }), {
        horizonMonths: 12,
      }),
      flatBenefit,
    );
    for (const m of [1, 5] as const) expect(paidIn(series, m)).toBe(0);
    for (const m of [6, 11] as const) expect(paidIn(series, m)).toBe(dollarsToCents(1_000));
  });

  it("pays throughout for a person with no active window at all", () => {
    // Absent means unbounded, and that default is load-bearing: every single-earner plan states
    // no membership, so a window read as "not a member" would silence the primary's own benefit.
    const series = simulateHousehold(baseInput(claimingNow(), { horizonMonths: 12 }), flatBenefit);
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(1_000) * 12);
  });

  it("stops paying a member at their own life expectancy, even while still a member", () => {
    // Death is not separation, but it closes the same window: the member never leaves, and their
    // benefit ends at their expectancy all the same — a dead member draws nothing. Here the
    // window's exclusive end IS the death month, 6, so months 0–5 pay and 6 onward do not, with
    // nothing clawed back. Upstream (`personActiveWindow`) that end is `min(separation, death)`;
    // the simulator only ever sees the one number.
    const series = simulateHousehold(
      baseInput(claimingNow({ startMonth: 0, endMonthExclusive: 6 }), { horizonMonths: 12 }),
      flatBenefit,
    );
    expect(paidIn(series, 5)).toBe(dollarsToCents(1_000));
    for (const m of [6, 7, 11]) expect(paidIn(series, m)).toBe(0);
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(1_000) * 6);
  });

  it("bounds by whichever ends first — separation before expectancy, or the reverse", () => {
    // A member who leaves at 4 and would die at 8 stops at 4. The min is taken upstream, by
    // `personActiveWindow`, which is the whole point of there being one window: the simulator is
    // never handed two bounds to reconcile, and so can never reconcile them differently here
    // than a chart does elsewhere. This pins the composed answer, 4.
    const series = simulateHousehold(
      baseInput(claimingNow({ startMonth: 0, endMonthExclusive: 4 }), { horizonMonths: 12 }),
      flatBenefit,
    );
    expect(paidIn(series, 3)).toBe(dollarsToCents(1_000));
    for (const m of [4, 5, 8, 11]) expect(paidIn(series, m)).toBe(0);
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(1_000) * 4);
  });
});
