import { describe, it, expect } from "vitest";
import { dollarsToCents } from "@finley/engine";
import type {
  WithdrawalTaxBasis,
  RmdContext,
  GovernmentBenefitClaim,
  EarningsRecord,
  HealthCostContext,
  DeferralLimitContext,
} from "@finley/engine";
import { usJurisdiction } from "./index";
import { contributionLimits } from "./contributionLimits";
import { payrollTaxCents } from "./payrollTax";

// Proves rules can consume the engine (app → rules → engine) and that US-2026 implements
// the interface. Each seam is called directly on the jurisdiction object and its return
// asserted — the full-simulation net-worth gross-up this file used to re-run through
// `simulateHousehold` is engine-internal coverage and lives in the engine's own tests.
describe("usJurisdiction (US-2026)", () => {
  it("implements the jurisdiction interface", () => {
    expect(usJurisdiction.id).toBe("US-2026");
    // The seam takes MONTHLY slices: $1,000/mo annualizes to $12k, below the standard
    // deduction → no tax.
    expect(
      usJurisdiction.computeTaxCents({ wages: dollarsToCents(1000) }, { year: 2026 }),
    ).toBe(0);
  });

  it("exposes its federal-tax simplifications through the modelAssumptions seam", () => {
    // The disclosures ride the jurisdiction, so the report surfaces them without the
    // engine holding a US fact. Stable ids let a consumer key and style each.
    const ids = (usJurisdiction.modelAssumptions ?? []).map((a) => a.id);
    expect(ids).toContain("taxThresholdForwardIndexing");
    expect(ids).toContain("socialSecurityThresholdsUnindexed");
    expect(ids).toContain("taxAttributionProportional");
    expect(ids).toContain("rmdStartAge");
    expect(ids).toContain("retirementContributionLimits");
    expect(ids).toContain("employerMatchOutsideEmployeeCap");
    // Gains take LONG-TERM rates with no holding period tracked, so a sale from a
    // recently-funded account is under-taxed. Disclosed, not silently assumed.
    expect(ids).toContain("capitalGainsAllLongTerm");
    for (const a of usJurisdiction.modelAssumptions ?? []) {
      expect(a.text.length).toBeGreaterThan(0);
    }
  });

  it("reports tax per category, summing to the scalar total", () => {
    // A mixed month of wages + capital gains: the per-category split's Σ must equal the
    // scalar `computeTaxCents` for the same slice.
    const slice = {
      wages: Math.round(dollarsToCents(60_000) / 12),
      capitalGains: Math.round(dollarsToCents(20_000) / 12),
    };
    const total = usJurisdiction.computeTaxCents(slice, { year: 2026 });
    const byCategory = usJurisdiction.computeTaxByCategoryCents(slice, { year: 2026 });
    const sum = Object.values(byCategory).reduce((s: number, c) => s + (c ?? 0), 0);
    expect(sum).toBe(total);
    // Gains bear preferential-rate tax on their own band, not a blend.
    expect(byCategory.capitalGains).toBeGreaterThan(0);
    expect(byCategory.wages).toBeGreaterThan(0);
  });

  it("runs real single-filer federal tax through the seam", () => {
    // $100k/yr of wages → annual tax $13,170 (brackets + standard deduction, single
    // filer) → the month's 1/12 share.
    const monthly = usJurisdiction.computeTaxCents(
      { wages: Math.round(dollarsToCents(100_000) / 12) },
      { year: 2026 },
    );
    expect(monthly).toBe(Math.round(dollarsToCents(13_170) / 12));
  });

  it("taxes only the gain in a post-tax withdrawal through the basis seam", () => {
    // Basis 0 (a pre-tax account, or any balance with no recorded basis) → the whole draw
    // is taxable.
    const preTax: WithdrawalTaxBasis = {
      grossCents: dollarsToCents(1_000),
      basisCents: 0,
      balanceCents: dollarsToCents(5_000),
      category: "capitalGains",
    };
    expect(usJurisdiction.taxableWithdrawalCents!(preTax, { year: 2026 })).toBe(
      dollarsToCents(1_000),
    );
    // Half the balance is basis → pro-rata returns half the draw as principal, taxing the
    // other half.
    const halfBasis: WithdrawalTaxBasis = {
      grossCents: dollarsToCents(1_000),
      basisCents: dollarsToCents(2_500),
      balanceCents: dollarsToCents(5_000),
      category: "capitalGains",
    };
    expect(usJurisdiction.taxableWithdrawalCents!(halfBasis, { year: 2026 })).toBe(
      dollarsToCents(500),
    );
  });

  it("classifies a return as accrual-taxed interest or deferred appreciation", () => {
    // Bank interest is ordinary income booked the year it credits.
    expect(usJurisdiction.returnTaxTreatment!("interest", { year: 2026 })).toEqual({
      taxAtAccrual: true,
      category: "ordinaryIncome",
    });
    // Appreciation is deferred: taxed at withdrawal against basis, as capital gains.
    expect(usJurisdiction.returnTaxTreatment!("appreciation", { year: 2026 })).toEqual({
      taxAtAccrual: false,
      category: "capitalGains",
    });
  });

  it("forces the age-triggered RMD out of the pre-tax balance", () => {
    // Born 1960 → start age 75 (SECURE 2.0). Before it, nothing is forced.
    const before: RmdContext = { year: 2029, age: 70, birthYear: 1960 };
    expect(usJurisdiction.requiredMinimumDistributionCents!(dollarsToCents(100_000), before)).toBe(
      0,
    );
    // At 75 the Uniform Lifetime divisor is 24.6.
    const at75: RmdContext = { year: 2035, age: 75, birthYear: 1960 };
    expect(usJurisdiction.requiredMinimumDistributionCents!(dollarsToCents(100_000), at75)).toBe(
      Math.round(dollarsToCents(100_000) / 24.6),
    );
  });

  it("gates the government benefit on the fully-insured eligibility rule", () => {
    // Empty covered-earnings record → under 40 credits → no benefit (the eligibility gate
    // lives inside the base function).
    const record: EarningsRecord = { annualWagesCents: new Map() };
    const claim: GovernmentBenefitClaim = {
      record,
      claimYear: 2060,
      claimingAge: 67,
      currentAge: 67,
    };
    expect(usJurisdiction.governmentBenefitBaseMonthlyCents!(claim)).toBe(0);
  });

  it("steps the health-cost benchmark down at the Medicare-eligibility age", () => {
    // 2026 base figures: $1,200/mo self-funded before 65, $500/mo residual at/after.
    const pre65: HealthCostContext = { year: 2026, age: 60 };
    const post65: HealthCostContext = { year: 2026, age: 65 };
    expect(usJurisdiction.healthCostBenchmarkMonthlyCents!(pre65)).toBe(dollarsToCents(1_200));
    expect(usJurisdiction.healthCostBenchmarkMonthlyCents!(post65)).toBe(dollarsToCents(500));
  });

  it("caps elective deferral at the legislated year limit through the seam", () => {
    // The age-banded catch-up is exercised in depth in budgetFillToLimit.test.ts; here just
    // the wiring: an under-50 context yields the base 2026 elective-deferral limit.
    const ctx: DeferralLimitContext = { year: 2026, age: 40 };
    expect(usJurisdiction.retirementDeferralLimitCents!(ctx)).toBe(
      contributionLimits(2026).elective401kCents,
    );
  });

  it("charges employee FICA on wages through the payroll seam, and nothing on non-wage income", () => {
    // $60,000 of wages (the default plan's income) → the whole-year employee FICA. The
    // tables live in payrollTax.ts; the seam just routes `wages` to them per year.
    const annual = usJurisdiction.computePayrollTaxCents!(
      { wages: dollarsToCents(60_000) },
      { year: 2026 },
    );
    expect(annual).toBe(payrollTaxCents(dollarsToCents(60_000), 2026));
    // 7.65% employee share, well under the OASDI wage cap at $60k.
    expect(annual).toBe(dollarsToCents(60_000 * 0.0765));

    // ordinaryIncome is a 401(k)/RMD withdrawal category, NOT earned income — no FICA, so
    // the seam never levies payroll tax on retirement-account draws.
    expect(
      usJurisdiction.computePayrollTaxCents!({ ordinaryIncome: dollarsToCents(60_000) }, { year: 2026 }),
    ).toBe(0);
  });

  it("breaks payroll tax down per category, reconciling to the scalar charge — the engine's required attribution seam", () => {
    // The breakdown is trivial (one earned category, `wages`) but still required so the
    // engine's per-source FICA attribution has something to apportion by.
    const byCategory = usJurisdiction.computePayrollTaxByCategoryCents!(
      { wages: dollarsToCents(60_000) },
      { year: 2026 },
    );
    expect(byCategory).toEqual({ wages: payrollTaxCents(dollarsToCents(60_000), 2026) });

    // A zero-wage input reconciles to an empty breakdown, matching a zero scalar charge.
    expect(
      usJurisdiction.computePayrollTaxByCategoryCents!({ ordinaryIncome: dollarsToCents(60_000) }, { year: 2026 }),
    ).toEqual({});
  });

  it("discloses the payroll-tax simplifications through modelAssumptions", () => {
    const ids = (usJurisdiction.modelAssumptions ?? []).map((a) => a.id);
    expect(ids).toContain("oasdiWageBaseWageIndexed");
    expect(ids).toContain("additionalMedicareThresholdUnindexed");
  });
});
