/**
 * Engine-native wiring tests for the plan→projection mapping (§5.4/§7). Driven by
 * the purpose-built {@link samplePlan} fixture and {@link mockJurisdiction} so they
 * run standalone against the engine with no rules package — each test enables
 * exactly the one seam it exercises. The app keeps the #37 real-jurisdiction
 * acceptance tests (panel age == first surviving projection age on the default
 * plan under `usJurisdiction`); these pin the mapping itself.
 */
import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  dollarsToCents,
  nullJurisdiction,
  SYNTHETIC_CARD_ID,
} from "./index";
import { createProjectionBase, type ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan, careerJob } from "./testing/samplePlan";
import type { Plan } from "./plan";

const START_YEAR = 2026;

function ctx(jurisdiction = nullJurisdiction): ProjectionContext {
  return { jurisdiction, startYear: START_YEAR };
}

/** Replay the plan's base with one jurisdiction driving both the mapping and the sim. */
function project(plan: Plan, jurisdiction = nullJurisdiction) {
  return replayLedger(emptyLedger, createProjectionBase(plan, ctx(jurisdiction)), jurisdiction);
}

/** Last KNOWN nominal net worth: the final balance, or the terminal value if insolvent (§5.1). */
function endingNetWorthCents(plan: Plan, jurisdiction = nullJurisdiction): number {
  const known = project(plan, jurisdiction)
    .months.map((m) => m.netWorthNominalCents)
    .filter((c): c is number => c !== null);
  return known[known.length - 1];
}

/** Nominal net worth at a given age under a jurisdiction. */
function netWorthAtAge(plan: Plan, age: number, jurisdiction = nullJurisdiction): number {
  const series = project(plan, jurisdiction);
  return series.months[(age - plan.currentAge) * 12].netWorthNominalCents!;
}

describe("createProjectionBase — retirement + government benefit wired into the graph (§5.4/§7)", () => {
  it("gives the projection person a benefit basis: birth year (from age) and claiming age", () => {
    const base = createProjectionBase({ ...samplePlan, currentAge: 40, benefitClaimingAge: 68 }, ctx());
    const p = base.initialPersons![0];
    expect(p.birthYear).toBe(base.startYear! - 40);
    expect(p.benefitClaimingAge).toBe(68);
  });

  it("stops employment income at the retirement age — working longer ends richer", () => {
    // Same plan, later retirement = more earning years + fewer drawdown years, so a
    // later retirement leaves a strictly healthier terminal balance.
    const early = endingNetWorthCents({ ...samplePlan, retirementAge: 55 });
    const late = endingNetWorthCents({ ...samplePlan, retirementAge: 70 });
    expect(late).toBeGreaterThan(early);
  });

  it("pays a government retirement benefit from the claiming age — it appears in the series", () => {
    // A jurisdiction that models a flat monthly benefit; the null one does not. The
    // benefit shows up as `governmentRetirementBenefit`-tagged income from the claiming age (67).
    const benefitJurisdiction = mockJurisdiction({
      governmentBenefitBaseMonthlyCents: () => dollarsToCents(2_500),
    });
    const series = project(samplePlan, benefitJurisdiction);
    const paysBenefit = series.months.some(
      (m) => (m.flows?.incomeByCategoryCents["governmentRetirementBenefit"] ?? 0) > 0,
    );
    expect(paysBenefit).toBe(true);
    // And it materially lifts late net worth versus the same plan with no benefit program.
    const withBenefit = netWorthAtAge(samplePlan, 80, benefitJurisdiction);
    const noBenefit = netWorthAtAge(samplePlan, 80, nullJurisdiction);
    expect(withBenefit).toBeGreaterThan(noBenefit);
  });
});

describe("createProjectionBase — earned income before current age comes from the job (§4.6, #41)", () => {
  // The age a career began is now the career job's `startYear`, not a scalar field.
  const planFromCareerStart = (careerStartAge: number): Plan => ({
    ...samplePlan,
    currentAge: 40,
    jobs: [careerJob(dollarsToCents(8000), { currentAge: 40, careerStartAge })],
  });
  const priorYears = (careerStartAge: number) => {
    const base = createProjectionBase(planFromCareerStart(careerStartAge), ctx());
    return Object.keys(base.initialPersons![0].priorEarningsCents!)
      .map(Number)
      .sort((a, b) => a - b);
  };

  it("seeds prior earnings from the configured career start age, not a fixed 18", () => {
    // currentAge 40, startYear 2026: ages [careerStartAge, 40) map to the calendar
    // years [2026 − (40 − careerStartAge) … 2025], one entry per pre-"now" working year.
    const from18 = priorYears(18);
    const from30 = priorYears(30);
    expect(from18).toHaveLength(40 - 18);
    expect(from30).toHaveLength(40 - 30);
    // A later career start seeds fewer years and pushes the earliest one later in time.
    expect(from30[0]).toBeGreaterThan(from18[0]);
    // Both records still run up to the year before "now".
    expect(from18.at(-1)).toBe(START_YEAR - 1);
    expect(from30.at(-1)).toBe(START_YEAR - 1);
  });

  it("lowers the priced government benefit when the career started later (fewer covered years)", () => {
    // The US AIME (§5.4) divides a fixed 35-year window, so seeding fewer pre-"now" years
    // leaves more $0 slots and drags the benefit down. A jurisdiction that prices the benefit
    // straight off the covered record surfaces the difference in late net worth.
    const priced = mockJurisdiction({
      governmentBenefitBaseMonthlyCents: (claim) => {
        const total = [...claim.record.annualWagesCents.values()].reduce((a, b) => a + b, 0);
        return Math.round(total / 420);
      },
    });
    const early = netWorthAtAge(planFromCareerStart(18), 80, priced);
    const late = netWorthAtAge(planFromCareerStart(35), 80, priced);
    expect(early).toBeGreaterThan(late);
  });
});

describe("createProjectionBase — retirement decumulation liquidates instead of borrowing (#35)", () => {
  it("funds the retiree from investments — the synthetic card never carries a balance", () => {
    // Retirement spending exceeds income; once the liquid buffer is spent the shortfall
    // is met by SELLING assets (a taxable-fund sale re-enters as capitalGains at the
    // chokepoint), so the unlimited synthetic card stays flat at 0 the whole horizon.
    const series = project({ ...samplePlan, retirementAge: 63 }, mockJurisdiction());
    for (const m of series.months) {
      expect(m.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBe(0);
    }
    // Decumulation actually fires: some retirement month liquidates a taxable investment,
    // surfacing as capitalGains income (the plan has no other capitalGains source).
    const liquidated = series.months.some(
      (m) => (m.flows?.incomeByCategoryCents["capitalGains"] ?? 0) > 0,
    );
    expect(liquidated).toBe(true);
  });
});

describe("createProjectionBase — horizon spans to life expectancy (§7)", () => {
  it("projects from now to life expectancy, not a fixed 30 years", () => {
    const horizon = (currentAge: number, lifeExpectancy: number) =>
      project({ ...samplePlan, currentAge, lifeExpectancy }).months.length;
    // months are [0 … (life − now)*12] inclusive → +1.
    expect(horizon(35, 90)).toBe((90 - 35) * 12 + 1);
    expect(horizon(25, 95)).toBe((95 - 25) * 12 + 1);
    // A longer life means a longer projection — it is not clamped at 30 years.
    expect(horizon(35, 95)).toBeGreaterThan(horizon(35, 65));
  });
});

describe("createProjectionBase — health as its own additive, growing expense (§5.4)", () => {
  const saver: Plan = {
    ...samplePlan,
    jobs: [careerJob(dollarsToCents(6_000))],
    expenseCents: dollarsToCents(3_000),
    goals: [],
  };

  it("spends the health line: adding health lowers ending net worth", () => {
    const withoutHealth = endingNetWorthCents({ ...saver, healthMonthlyCents: 0 });
    const withHealth = endingNetWorthCents({ ...saver, healthMonthlyCents: dollarsToCents(500) });
    expect(withHealth).toBeLessThan(withoutHealth);
  });

  it("grows the health line at its own rate: a higher rate spends more over the horizon", () => {
    const base = { ...saver, healthMonthlyCents: dollarsToCents(500) };
    const flat = endingNetWorthCents({ ...base, healthInflationPct: 0 });
    const rising = endingNetWorthCents({ ...base, healthInflationPct: 8 });
    expect(rising).toBeLessThan(flat);
  });

  it("steps health down at the jurisdiction's public-coverage age when enrolling", () => {
    // A near-coverage saver so the step (age 65) lands inside the horizon and income
    // runs through it (retirementAge past life expectancy), so the difference shows in
    // real net worth rather than being masked by the synthetic-card insolvency floor.
    const nearCoverage: Plan = {
      ...samplePlan,
      currentAge: 55,
      retirementAge: 90,
      lifeExpectancy: 90,
      jobs: [careerJob(dollarsToCents(6_000), { currentAge: 55 })],
      expenseCents: dollarsToCents(3_000),
      healthMonthlyCents: dollarsToCents(1_000),
      postCoverageHealthMonthlyCents: dollarsToCents(400),
      healthInflationPct: 5,
      goals: [],
    };
    const covered = mockJurisdiction({ publicHealthCoverageAge: 65 });
    const enrolled = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: true }, covered);
    const selfFunded = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: false }, covered);
    // Enrolling drops health at 65 → less spent after 65 → more left in savings.
    expect(enrolled).toBeGreaterThan(selfFunded);
  });

  it("does not step when the jurisdiction has no public-coverage age, even if enrolling", () => {
    // publicHealthCoverageAge is the SINGLE source of the step: with none, an enrolling
    // plan collapses to one segment, identical to not enrolling.
    const nearCoverage: Plan = {
      ...samplePlan,
      currentAge: 55,
      retirementAge: 90,
      lifeExpectancy: 90,
      jobs: [careerJob(dollarsToCents(6_000), { currentAge: 55 })],
      healthMonthlyCents: dollarsToCents(1_000),
      postCoverageHealthMonthlyCents: dollarsToCents(400),
      goals: [],
    };
    const noCoverage = mockJurisdiction(); // no publicHealthCoverageAge
    const enrolled = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: true }, noCoverage);
    const selfFunded = endingNetWorthCents({ ...nearCoverage, enrollsInPublicHealthCoverage: false }, noCoverage);
    expect(enrolled).toBe(selfFunded);
  });
});
