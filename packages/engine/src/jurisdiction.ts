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

/**
 * Age is passed through so `rules` can band a limit on it. The engine attaches no meaning to
 * the banding — whether age raises a limit, and by how much, is entirely the jurisdiction's.
 */
export interface DeferralLimitContext extends JurisdictionContext {
  /** Absent → the jurisdiction's un-banded limit. */
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
   * {@link computeTaxCents} broken out per {@link TaxCategory} — the jurisdiction's call,
   * since US tax is not linearly separable by category (progressive brackets, the deduction
   * stacking onto gains).
   *
   * CONTRACT: Σ of the returned map MUST equal {@link computeTaxCents} for the same input,
   * enforced at runtime to the exact cent (`assertTaxAttributionReconciles`).
   *
   * Required; no tax → `{}`. Reporting only — the scalar {@link computeTaxCents} stays the
   * gross-up loop's marginal-tax probe.
   */
  computeTaxByCategoryCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Partial<Record<TaxCategory, Cents>>;

  /**
   * Simplifications specific to this jurisdiction (e.g. brackets grown forward at a flat
   * rate rather than the authority's published yearly figures), listed after the engine's
   * neutral {@link import("./projection/assumptions").MODEL_ASSUMPTIONS}.
   */
  readonly modelAssumptions?: readonly ModelAssumption[];

  /**
   * How much of a post-tax withdrawal is TAXABLE. The engine owns the basis STATE, the
   * jurisdiction the return-of-capital POLICY and its method (pro-rata, specific-lot,
   * average-cost); the engine reduces basis by `grossCents − taxable`, so the state update
   * stays method-agnostic.
   *
   * The gross-up loop probes it repeatedly, so it MUST be pure and monotone non-decreasing
   * in `grossCents` — that is what lets the loop climb to its least fixed point. Absent →
   * the whole `grossCents` is taxable.
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
   * A person's annual limit on their OWN pre-tax deferral, summed across every plan they
   * hold. The waterfall caps combined deferral here and redirects overflow to the next
   * destination. The employer match does not draw on this limit — it is bounded by
   * {@link combinedPlanDepositLimitCents} instead. Absent → uncapped.
   */
  retirementDeferralLimitCents?(ctx: DeferralLimitContext): Cents;

  /**
   * The annual ceiling on employee deferral + employer match COMBINED, applied to ONE plan.
   * Where {@link retirementDeferralLimitCents} bounds the employee's own share across all
   * their plans, this bounds everything landing in a single one. Absent → the match is
   * uncapped.
   *
   * Per plan, so a second job brings its own full room. The engine buckets by income source,
   * NOT by destination account — two jobs paying into the same account are two plans.
   *
   * No ordering between the two limits is assumed: a jurisdiction may set this below
   * {@link retirementDeferralLimitCents}, in which case the match is simply squeezed to
   * nothing (see the deferral-preserving policy in `waterfall.ts`).
   */
  combinedPlanDepositLimitCents?(ctx: DeferralLimitContext): Cents;

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
   * and {@link import("./earlyRetireeHealthCheck").assessEarlyRetireeHealthCost} measures an
   * authored expense against it. Absent → no benchmark (0).
   */
  healthCostBenchmarkMonthlyCents?(ctx: HealthCostContext): Cents;
}

/** No taxes, no government programs: the engine runs end to end alone, and the baseline for engine-only tests. */
export const nullJurisdiction: Jurisdiction = {
  id: "null",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
};
