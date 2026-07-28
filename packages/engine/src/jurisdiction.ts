import type { Cents } from "./money";
import type { EarningsRecord } from "./earningsRecord";
import type { TaxCategory } from "./cashFlowSeries";
import type { AccountReturnKind } from "./simAccount";
import type { ModelAssumption } from "./projection/assumptions";

/**
 * The jurisdiction seam: the engine defines what a jurisdiction must supply and hardcodes
 * no jurisdiction fact; a `rules` package (e.g. `US-2026`) fills it. {@link
 * nullJurisdiction} keeps the engine runnable and testable standalone.
 */
export interface JurisdictionContext {
  /** Calendar year the figure applies to; every rules fact is year-parameterized. */
  readonly year: number;
}

/**
 * Input to the government-benefit seam: the engine-owned covered-earnings record plus the
 * who/when the formula needs. Recomputable — {@link currentAge} advances if the base is
 * recomputed while the worker keeps earning, which the formula reads to index the record.
 */
export interface GovernmentBenefitClaim {
  readonly record: EarningsRecord;
  /** Calendar year benefits begin — the year the person reaches {@link claimingAge}. */
  readonly claimYear: number;
  /** Pinned claiming age (62 earliest, 67 full, 70 max). An input, never searched. */
  readonly claimingAge: number;
  /** Age at this (re)computation; equals {@link claimingAge} at first claim. */
  readonly currentAge: number;
}

/**
 * Context for {@link Jurisdiction.colaAdjustedBenefitCents}: the engine holds the frozen
 * base benefit opaquely and asks the jurisdiction to inflate it each year.
 */
export interface GovernmentBenefitContext extends JurisdictionContext {
  /** Age in `year`; the COLA factor's exponent is age − eligibility age. */
  readonly currentAge: number;
  /** This year's rate: plan `benefitColaRate` ?? general inflation. */
  readonly colaRate: number;
}

/**
 * Retirement-deferral-limit seam. Age lets `rules` add the age-banded catch-up (an extra
 * allowance from 50, larger in the 60–63 band under SECURE 2.0).
 */
export interface DeferralLimitContext extends JurisdictionContext {
  /** Absent → base limit only, no catch-up. */
  readonly age?: number;
}

/**
 * Required Minimum Distribution seam: the engine owns the pre-tax balances and calls once
 * a year per account holder; `rules` decides the start age and the required withdrawal.
 */
export interface RmdContext extends JurisdictionContext {
  readonly age: number;
  /** Sets the rules-side RMD start age (73 vs. 75 under current US law). */
  readonly birthYear: number;
}

/**
 * Health-cost benchmark seam: `rules` returns the elevated self-funded cost before the
 * Medicare-eligibility age, the lower residual at/after it.
 */
export interface HealthCostContext extends JurisdictionContext {
  readonly age: number;
}

/**
 * The engine-held state a {@link Jurisdiction.taxableWithdrawalCents} decision reads. The
 * engine owns and tracks the basis (across deposits, draws, transfers); the jurisdiction
 * owns the return-of-capital policy. `basisCents` 0 (a pre-tax account) → the whole draw
 * is taxable.
 */
export interface WithdrawalTaxBasis {
  readonly grossCents: Cents;
  /** Principal already taxed going in. */
  readonly basisCents: Cents;
  /** The basis-fraction denominator. */
  readonly balanceCents: Cents;
  /** Neutral withdrawal provenance — never a US vehicle string. */
  readonly category: TaxCategory;
}

/**
 * How {@link Jurisdiction.returnTaxTreatment} classifies an account's periodic return:
 * taxed as it accrues (bank interest) or deferred to withdrawal (capital appreciation).
 */
export interface ReturnTaxTreatment {
  readonly taxAtAccrual: boolean;
  /** Moot when `taxAtAccrual` is false. */
  readonly category: TaxCategory;
}

export interface Jurisdiction {
  /** e.g. `"null"` or `"US-2026"`. */
  readonly id: string;

  /**
   * Age at which public health coverage begins and the attributed health cost steps down
   * from self-funded to residual (US law: 65, Medicare) — named without the brand. The
   * single source of the step age; the early-retiree honesty flag measures the self-funded
   * gap up to it. Legislation-set; absent → no step, no gap.
   */
  readonly publicHealthCoverageAge?: number;

  /**
   * The single tax chokepoint: per-{@link TaxCategory} taxable amounts in, tax owed out.
   * The engine states each flow's PROVENANCE and passes the full gross per category, never
   * collapsing them into one lump; the jurisdiction owns how much of each is taxed and at
   * what rate (benefit inclusion %, capital-gains preference). v1 may return 0; what
   * matters is that exactly one replaceable function decides tax policy.
   */
  computeTaxCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * The SAME total as {@link computeTaxCents}, broken out per {@link TaxCategory}.
   * Attribution is the jurisdiction's call because US tax is not linearly separable by
   * category — progressive brackets, the standard deduction stacking down onto gains, the
   * preferential gains rate, and benefit provisional-income inclusion all make a dollar's
   * tax depend on the whole return.
   *
   * CONTRACT: Σ of the returned map MUST equal {@link computeTaxCents} for the same input,
   * enforced at runtime to the exact cent (see `assertTaxAttributionReconciles`).
   *
   * REQUIRED, with no engine/app fallback; a jurisdiction charging no tax returns `{}`.
   * Called at most once per person-month for reporting; the scalar {@link computeTaxCents}
   * remains the marginal-tax probe the withdrawal gross-up loop depends on.
   */
  computeTaxByCategoryCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Partial<Record<TaxCategory, Cents>>;

  /**
   * Model simplifications SPECIFIC to this jurisdiction, listed after the engine's neutral
   * {@link import("./projection/assumptions").MODEL_ASSUMPTIONS}. Any US-specific caveat —
   * e.g. brackets, the standard deduction, and gains thresholds grown forward at a flat
   * rate rather than the IRS's published yearly figures — lives here, never in the engine.
   */
  readonly modelAssumptions?: readonly ModelAssumption[];

  /**
   * How much of a post-tax withdrawal is TAXABLE, given the basis the engine tracks: the
   * engine owns the basis STATE and calls per draw, the jurisdiction owns the
   * return-of-capital POLICY and its accounting method (pro-rata, specific-lot,
   * average-cost). The engine reduces basis by `grossCents − taxable`, keeping the state
   * update method-agnostic.
   *
   * Called inside the withdrawal gross-up loop for many probe amounts, so it MUST be pure
   * and monotone non-decreasing in `grossCents` — a rising taxable base is what lets the
   * loop climb to its least fixed point. Absent → the whole `grossCents` is taxable.
   */
  taxableWithdrawalCents?(basis: WithdrawalTaxBasis, ctx: JurisdictionContext): Cents;

  /**
   * How an account's periodic RETURN is taxed, given its neutral {@link
   * import("./simAccount").SimAccountTaxProfile.returnKind}: taxed as it accrues (US bank
   * interest, as ordinary income) or deferred to withdrawal and taxed against basis
   * (capital appreciation). Called monthly for every account declaring a `returnKind`.
   * Absent, or `taxAtAccrual: false` → nothing is booked at accrual.
   */
  returnTaxTreatment?(returnKind: AccountReturnKind, ctx: JurisdictionContext): ReturnTaxTreatment;

  /**
   * Which income categories count toward the covered-earnings {@link EarningsRecord} that
   * feeds the benefit formula. A jurisdiction fact (US covers wages + self-employment
   * ordinary income, never the benefit itself — that would be circular — nor gains or
   * tax-exempt income). Absent → a documented bookkeeping-only default, `wages` only.
   */
  isCoveredEarnings?(taxCategory: TaxCategory): boolean;

  /**
   * A person's annual employee pre-tax deferral limit (401k-style), including the
   * age-banded catch-up when {@link DeferralLimitContext.age} is supplied. The waterfall
   * caps each person's combined deferral at this and redirects overflow to the next
   * destination; the employer match does NOT share this cap. Absent → uncapped.
   */
  retirementDeferralLimitCents?(ctx: DeferralLimitContext): Cents;

  /**
   * The full retirement age (US law: 67), used to time a benefit when the person hasn't
   * pinned their own {@link GovernmentBenefitClaim.claimingAge}. Legislation-set; absent →
   * an unpinned person's benefit is simply not timed (no source).
   */
  readonly defaultBenefitClaimingAge?: number;

  /**
   * The government retirement benefit in eligibility-age dollars — `PIA(record) ×
   * claimingFactor(claimingAge)`. Returns 0 when the record fails the jurisdiction's
   * eligibility gate (US: < 40 credits); the gate lives INSIDE here, not on a separate
   * seam. The engine caches the result as an OPAQUE base, recalling this only while the
   * record keeps growing; {@link colaAdjustedBenefitCents} grows it forward. Absent → 0.
   */
  governmentBenefitBaseMonthlyCents?(claim: GovernmentBenefitClaim): Cents;

  /**
   * Apply the cost-of-living adjustment to a frozen base benefit — `baseCents × (1 +
   * colaRate)^(currentAge − eligibilityAge)`. Collapsing the 62→claim eligibility bridge
   * and the post-claim forward COLA into one factor is exact over the modelled 62–70
   * range. The result enters the waterfall POST-deferral, tagged
   * `governmentRetirementBenefit` so the tax seam applies its own inclusion % — it is not
   * earned wages. Absent → the base is paid unadjusted.
   */
  colaAdjustedBenefitCents?(baseCents: Cents, ctx: GovernmentBenefitContext): Cents;

  /**
   * The Required Minimum Distribution a pre-tax account holder must withdraw this year.
   * `rules` owns the start age (birth-year-dependent, 73 vs. 75) and the life-expectancy
   * divisor table, returning 0 before the start age. The engine forces the amount out as
   * taxable ordinary income routed to a taxable destination — the withdrawal binds as
   * `max(desired, required)`. Legislation-set; absent → no RMD.
   */
  requiredMinimumDistributionCents?(
    preTaxBalanceCents: Cents,
    ctx: RmdContext,
  ): Cents;

  /**
   * The attributed monthly health cost for a person of the given age. The jurisdiction
   * owns the eligibility age (US: 65) and the two figures it steps between: an elevated
   * self-funded cost before it (~$1,200/mo/person, unsubsidised in v1 → conservative) and
   * a lower residual at/after it (~$500/mo/person — Medicare replaces self-funded
   * insurance but premiums, Part B, and out-of-pocket remain).
   *
   * Makes the pre-65 vs. post-65 gap VISIBLE: the app pre-fills the stepped segment and
   * the early-retirement nudge from it, and {@link
   * import("./earlyRetireeHealthCheck").assessEarlyRetireeHealthCost} compares an authored
   * health expense against the pre-eligibility figure. NOT a silent auto-step in the sim —
   * an authored budget item, disclaimed and legislation-set. Absent → no benchmark (0).
   */
  healthCostBenchmarkMonthlyCents?(ctx: HealthCostContext): Cents;
}

/**
 * No taxes, no government programs: the guarantee that the engine runs end to end on its
 * own, and the baseline for engine-only tests. Never remove it.
 */
export const nullJurisdiction: Jurisdiction = {
  id: "null",
  computeTaxCents: () => 0,
  // No tax charged, so there is nothing to attribute.
  computeTaxByCategoryCents: () => ({}),
};
