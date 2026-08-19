import type { Cents } from "../money/money";
import type { EarningsRecord } from "../job/earningsRecord";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { AccountReturnKind } from "../plan/simAccount";
import type { ModelAssumption } from "../projection/assumptions";

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

/** The mirror-image context at the OTHER end of life from {@link RmdContext}: an age-gated withdrawal rule. */
export interface WithdrawalContext extends JurisdictionContext {
  readonly age: number;
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
   *
   * ANNUAL in, ANNUAL out: `taxableByCategory` is a FULL CALENDAR YEAR of taxable income by
   * category — never a monthly slice. The engine calls it in exactly two places, and never on a
   * partial year:
   *
   *  1. **The year's close**, on the year's ACTUAL accumulated total (see {@link
   *     import("../projection/runState").SimState.taxableIncomeByPersonYear}) — the authoritative
   *     liability, trued up the following April ({@link
   *     import("../projection/taxYearSettlement")}).
   *  2. **Monthly wage withholding**, on the year-to-date wages of the {@link
   *     isWithheldCategory} categories ANNUALIZED to a full year (see {@link
   *     import("../projection/withholding")}) — the paycheck approximation every payer makes,
   *     and still a full year of income as far as this seam is concerned. Only income the
   *     household has ALREADY earned feeds it, so the answer never depends on a later month.
   *
   * The engine owns collecting the totals and all payment timing; this seam only prices a year.
   * Calling it on a raw monthly slice would misprice lumpy income — the engine never does this.
   */
  computeTaxCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * {@link computeTaxCents} broken out per {@link TaxCategory} — the jurisdiction's call,
   * since US tax is not linearly separable by category (progressive brackets, the deduction
   * stacking onto gains). Same ANNUAL-in contract as {@link computeTaxCents}.
   *
   * CONTRACT: Σ of the returned map MUST equal {@link computeTaxCents} for the same input,
   * enforced at runtime to the exact cent (`assertPersonTaxBreakdownReconciles`).
   *
   * Required; no tax → `{}`. Reporting only: the scalar {@link computeTaxCents} is what every
   * pricing decision reads.
   */
  computeTaxByCategoryCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Partial<Record<TaxCategory, Cents>>;

  /**
   * Simplifications specific to this jurisdiction (e.g. brackets grown forward at a flat
   * rate rather than the authority's published yearly figures), listed after the engine's
   * neutral {@link import("../projection/assumptions").MODEL_ASSUMPTIONS}.
   */
  readonly modelAssumptions?: readonly ModelAssumption[];

  /**
   * How much of a post-tax withdrawal is TAXABLE. The engine owns the basis STATE, the
   * jurisdiction the return-of-capital POLICY and its method (pro-rata, specific-lot,
   * average-cost); the engine reduces basis by `grossCents − taxable`, so the state update
   * stays method-agnostic. MUST be pure. Absent → the whole `grossCents` is taxable.
   */
  taxableWithdrawalCents?(basis: WithdrawalTaxBasis, ctx: JurisdictionContext): Cents;

  /**
   * Additional tax on a withdrawal taken before the jurisdiction's access age (US: 10% before
   * 59½, IRC §72(t)) — layered ON TOP of ordinary income tax, never netted from it or from
   * {@link taxableWithdrawalCents}. Priced off the SAME {@link WithdrawalTaxBasis}, so a
   * jurisdiction can gate on `category` (US: only an `ordinaryIncome` — i.e. pre-tax — draw is
   * eligible) the same way it decides what portion of a draw is taxable at all.
   *
   * Charged immediately, in the draw's own month — unlike {@link computeTaxCents}, this needs
   * no annual reconciliation, because it is a flat rate on an amount already fully known the
   * moment the draw is priced, not a bracket that depends on the rest of the year's income.
   * The engine nets it out of what the draw DELIVERS (see {@link
   * import("../projection/withdrawal").buildWithdrawalSources}), so a household short of what
   * it asked for pulls more from the next account in line exactly as it would if a balance ran
   * out early — no separate settlement machinery. Absent → no penalty (also the correct answer
   * past the access age — a jurisdiction that implements this must return 0 there itself, since
   * the engine does not gate the call by age).
   */
  earlyWithdrawalPenaltyCents?(basis: WithdrawalTaxBasis, ctx: WithdrawalContext): Cents;

  /**
   * How an account's periodic RETURN is taxed, given its neutral {@link
   * import("../plan/simAccount").SimAccountTaxProfile.returnKind}: at accrual (US bank interest,
   * ordinary income) or deferred to withdrawal and taxed against basis (capital
   * appreciation). Absent, or `taxAtAccrual: false` → nothing booked at accrual.
   */
  returnTaxTreatment?(returnKind: AccountReturnKind, ctx: JurisdictionContext): ReturnTaxTreatment;

  /**
   * Employee payroll tax (US: FICA) — the person's ANNUAL EMPLOYEE PAYROLL-TAX LIABILITY on
   * their CUMULATIVE year-to-date EARNED income by category, distinct from {@link
   * computeTaxCents}: its base is the FULL pre-deferral gross (a 401(k) deferral cuts income
   * tax, never payroll tax) and its category set is earned income only, so a
   * retirement-account withdrawal booked `ordinaryIncome` bears none.
   *
   * This models a RECONCILED ANNUAL LIABILITY — the total FICA the worker owes across the
   * whole year on their combined earned income — NOT employer-by-employer paycheck
   * withholding. In reality each employer withholds independently against ITS OWN wages, so
   * a worker with two jobs (or a job change mid-year) can have excess Social Security
   * withheld across employers, refunded only at tax-return reconciliation. That per-employer
   * over-withhold-then-refund cash-flow timing is NOT modeled here: this seam always states
   * the correct combined-across-all-sources figure, as if reconciled on day one.
   *
   * The engine feeds year-to-date totals and charges the DIFFERENCE month to month, so a
   * capped component (OASDI's wage base) binds on cumulative earnings rather than annualized
   * monthly slices. MUST therefore be monotone non-decreasing in each category's amount, so
   * the difference is never a credit. Absent → no payroll tax charged.
   */
  computePayrollTaxCents?(
    annualEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * {@link computePayrollTaxCents} broken out per {@link TaxCategory} — the jurisdiction's
   * call, mirroring {@link computeTaxByCategoryCents}. REQUIRED whenever {@link
   * computePayrollTaxCents} is supplied (the engine asserts this at runtime).
   *
   * Returns the share of the person-level payroll-tax charge attributed to each income
   * source for reporting. The engine first settles the person's COMBINED annual
   * payroll-tax liability — subject to whatever jurisdiction rules apply (e.g. the Social
   * Security wage cap binding on their cumulative earnings) — via {@link
   * computePayrollTaxCents}, then attributes each month's INCREMENTAL charge back to the
   * income sources that generated it, using this breakdown as the per-category weights. A
   * per-category breakdown is what makes that attribution possible; a jurisdiction that
   * charges payroll tax but declines to break it down cannot be attributed correctly.
   *
   * This is attribution FOR REPORTING ONLY. It is NOT employer-by-employer paycheck
   * withholding, and it does not model any employer-specific payroll-tax liability — there
   * is no such thing as one job's or one employer's payroll tax here, only the person's
   * total, re-apportioned across sources after the fact.
   *
   * CONTRACT: Σ of the returned map for a given cumulative input MUST equal {@link
   * computePayrollTaxCents} for that SAME input — enforced at runtime, to the exact cent.
   */
  computePayrollTaxByCategoryCents?(
    annualEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Partial<Record<TaxCategory, Cents>>;

  /**
   * Which income categories a payer WITHHOLDS federal income tax on as it pays them (US: `wages`
   * — an employer withholds against a paycheck; nobody withholds against a brokerage gain, an
   * IRA draw or an RMD unless asked to).
   *
   * The engine withholds monthly on exactly these categories and no others, pricing the charge
   * through {@link computeTaxCents} on the year-to-date total of them, annualized (see {@link
   * import("../projection/withholding").monthlyWithholdingByCategoryCents}). Everything else —
   * gains, pre-tax withdrawals, RMDs, early-withdrawal penalties, one-off taxable events — bears
   * no in-year cash at all and reaches the household only through the following April's true-up.
   *
   * This is deliberately NOT the same question as {@link computePayrollTaxCents}'s earned-income
   * set, even though US answers both with `wages`: one asks what FICA is levied on, the other
   * what an income-tax payer withholds against.
   *
   * Absent → nothing is withheld during the year, and the whole annual liability settles in April.
   */
  isWithheldCategory?(taxCategory: TaxCategory): boolean;

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
   * and {@link import("../retirement/earlyRetireeHealthCheck").assessEarlyRetireeHealthCost} measures an
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
