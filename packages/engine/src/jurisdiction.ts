import type { Cents } from "./money";
import type { EarningsRecord } from "./earningsRecord";
import type { TaxCategory } from "./cashFlowSeries";
import type { AccountReturnKind } from "./simAccount";
import type { ModelAssumption } from "./projection/assumptions";

/**
 * The jurisdiction seam: the engine hardcodes no jurisdiction fact; a `rules` package
 * (e.g. `US-2026`) supplies them all. {@link nullJurisdiction} keeps the engine runnable
 * standalone.
 */
export interface JurisdictionContext {
  /** Every rules fact is year-parameterized. */
  readonly year: number;
}

export interface GovernmentBenefitClaim {
  readonly record: EarningsRecord;
  /** The year the person reaches {@link claimingAge}. */
  readonly claimYear: number;
  /** 62 earliest, 67 full, 70 max. An input, never searched. */
  readonly claimingAge: number;
  /** {@link claimingAge} at first claim; higher when the base is recomputed as the worker keeps earning. */
  readonly currentAge: number;
}

export interface GovernmentBenefitContext extends JurisdictionContext {
  /** Age in `year`; the COLA exponent is age − eligibility age. */
  readonly currentAge: number;
  /** Plan `benefitColaRate` ?? general inflation. */
  readonly colaRate: number;
}

/** Age lets `rules` add the age-banded catch-up (from 50; larger in the 60–63 band under SECURE 2.0). */
export interface DeferralLimitContext extends JurisdictionContext {
  /** Absent → base limit only, no catch-up. */
  readonly age?: number;
}

export interface RmdContext extends JurisdictionContext {
  readonly age: number;
  /** Sets the rules-side RMD start age (73 vs. 75 under current US law). */
  readonly birthYear: number;
}

export interface HealthCostContext extends JurisdictionContext {
  readonly age: number;
}

/** `basisCents` 0 (a pre-tax account) → the whole draw is taxable. */
export interface WithdrawalTaxBasis {
  readonly grossCents: Cents;
  /** Principal already taxed going in. */
  readonly basisCents: Cents;
  /** The basis-fraction denominator. */
  readonly balanceCents: Cents;
  /** Neutral provenance — never a US vehicle string. */
  readonly category: TaxCategory;
}

export interface ReturnTaxTreatment {
  readonly taxAtAccrual: boolean;
  /** Moot when `taxAtAccrual` is false. */
  readonly category: TaxCategory;
}

export interface Jurisdiction {
  /** e.g. `"null"` or `"US-2026"`. */
  readonly id: string;

  /**
   * Age public health coverage begins (US: 65, Medicare): attributed health cost steps down
   * from self-funded to residual there. Absent → no step.
   */
  readonly publicHealthCoverageAge?: number;

  /**
   * The single tax chokepoint. Categories arrive whole, never collapsed into one lump: the
   * jurisdiction owns what share of each is taxed, and at what rate.
   */
  computeTaxCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * The SAME total as {@link computeTaxCents}, broken out per {@link TaxCategory} — the
   * jurisdiction's call, since US tax is not linearly separable by category (progressive
   * brackets, the deduction stacking onto gains).
   *
   * CONTRACT: Σ of the returned map MUST equal {@link computeTaxCents} for the same input,
   * enforced at runtime to the exact cent (`assertTaxAttributionReconciles`).
   *
   * Required; a jurisdiction charging no tax returns `{}`. Reporting only — the scalar
   * {@link computeTaxCents} stays the marginal-tax probe the gross-up loop uses.
   */
  computeTaxByCategoryCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Partial<Record<TaxCategory, Cents>>;

  /**
   * Simplifications specific to this jurisdiction (e.g. brackets grown forward at a flat
   * rate, not the IRS's published yearly figures), listed after the engine's neutral
   * {@link import("./projection/assumptions").MODEL_ASSUMPTIONS}.
   */
  readonly modelAssumptions?: readonly ModelAssumption[];

  /**
   * How much of a post-tax withdrawal is TAXABLE. The engine owns the basis STATE, the
   * jurisdiction the return-of-capital POLICY and its method (pro-rata, specific-lot,
   * average-cost); the engine reduces basis by `grossCents − taxable`, so the state update
   * stays method-agnostic.
   *
   * Probed for many amounts inside the withdrawal gross-up loop, so it MUST be pure and
   * monotone non-decreasing in `grossCents`, which lets the loop climb to its least fixed
   * point. Absent → the whole `grossCents` is taxable.
   */
  taxableWithdrawalCents?(basis: WithdrawalTaxBasis, ctx: JurisdictionContext): Cents;

  /**
   * How an account's periodic RETURN is taxed, given its neutral {@link
   * import("./simAccount").SimAccountTaxProfile.returnKind}: at accrual (US bank interest,
   * ordinary income) or deferred to withdrawal and taxed against basis (capital
   * appreciation). Absent, or `taxAtAccrual: false` → nothing booked at accrual.
   */
  returnTaxTreatment?(returnKind: AccountReturnKind, ctx: JurisdictionContext): ReturnTaxTreatment;

  /**
   * Which income categories count toward the covered-earnings {@link EarningsRecord}
   * behind the benefit formula. US: wages + self-employment ordinary income — never the
   * benefit itself (circular), gains, or tax-exempt income. Absent → `wages` only.
   */
  isCoveredEarnings?(taxCategory: TaxCategory): boolean;

  /**
   * A person's annual employee pre-tax deferral limit (401k-style), including the
   * age-banded catch-up when {@link DeferralLimitContext.age} is supplied. The waterfall
   * caps combined deferral here and redirects overflow to the next destination; the
   * employer match does NOT share the cap. Absent → uncapped.
   */
  retirementDeferralLimitCents?(ctx: DeferralLimitContext): Cents;

  /**
   * The full retirement age (US law: 67), used to time a benefit when the person hasn't
   * pinned their own {@link GovernmentBenefitClaim.claimingAge}. Absent → an unpinned
   * person's benefit is never timed.
   */
  readonly defaultBenefitClaimingAge?: number;

  /**
   * The government retirement benefit in eligibility-age dollars — `PIA(record) ×
   * claimingFactor(claimingAge)`. The eligibility gate lives INSIDE here: a record that
   * fails it (US: < 40 credits) returns 0. The engine caches the result as an OPAQUE base,
   * recalling this only while the record keeps growing. Absent → 0.
   */
  governmentBenefitBaseMonthlyCents?(claim: GovernmentBenefitClaim): Cents;

  /**
   * `baseCents × (1 + colaRate)^(currentAge − eligibilityAge)`. Collapsing the 62→claim
   * eligibility bridge and the post-claim forward COLA into one factor is exact over the
   * modelled 62–70 range. The result enters the waterfall POST-deferral, tagged
   * `governmentRetirementBenefit` so the tax seam applies its own inclusion %. Absent →
   * the base is paid unadjusted.
   */
  colaAdjustedBenefitCents?(baseCents: Cents, ctx: GovernmentBenefitContext): Cents;

  /**
   * `rules` owns the start age (birth-year-dependent, 73 vs. 75) and the life-expectancy
   * divisor table, returning 0 before the start age. The engine forces the amount out as
   * taxable ordinary income routed to a taxable destination, binding the withdrawal at
   * `max(desired, required)`. Absent → no RMD.
   */
  requiredMinimumDistributionCents?(
    preTaxBalanceCents: Cents,
    ctx: RmdContext,
  ): Cents;

  /**
   * The jurisdiction owns the eligibility age (US: 65) and the two figures it steps between:
   * before it, an unsubsidised self-funded cost (~$1,200/mo/person, conservative); at/after
   * it, a residual (~$500/mo/person — Medicare replaces the insurance but premiums, Part B,
   * and out-of-pocket remain).
   *
   * NOT a silent auto-step: the app pre-fills an authored, disclaimed budget item from it,
   * and {@link import("./earlyRetireeHealthCheck").assessEarlyRetireeHealthCost} compares an
   * authored expense against the pre-eligibility figure. Absent → no benchmark (0).
   */
  healthCostBenchmarkMonthlyCents?(ctx: HealthCostContext): Cents;
}

/** No taxes, no government programs: the engine runs end to end alone, and the baseline for engine-only tests. */
export const nullJurisdiction: Jurisdiction = {
  id: "null",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
};
