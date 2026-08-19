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

/**
 * One wage source's payment for ONE pay period, as a payroll system would see it — the input to
 * {@link Jurisdiction.computeWageWithholdingCents}.
 *
 * Every field is a fact about the PAST or the PRESENT — this period's pay, what the year has
 * already paid and withheld, how many periods are left. NOTHING here describes a month that has
 * not happened, and that omission IS the causality guarantee: a figure computed from these fields
 * cannot depend on the future, and cannot be revised once the period is paid. Where a real
 * taxpayer would look ahead, the model does what the IRS's own worksheets do and extends the
 * CURRENT period forward, which is knowledge, not foresight.
 *
 * Two scopes, and the difference matters. The per-SOURCE cumulative fields are what one employer
 * genuinely tracks about itself, and band that employer's own rates. The per-PERSON ones are what
 * the employee knows and their employers do not, and exist because withholding forms ask the
 * employee to correct for exactly that gap.
 */
export interface WageWithholdingRequest {
  /**
   * The source's provenance, so the jurisdiction decides for itself which flows payroll
   * withholds against. The engine consults this seam for EVERY income source and lets the answer
   * be zero, exactly as it does for payroll tax — keeping "a wage is withheld against, a pension
   * draw is not" a jurisdiction fact rather than an engine one.
   */
  readonly taxCategory: TaxCategory;
  /**
   * This period's RECURRING wages from this source, already net of any pre-tax deferral — the
   * deferral reduces the income-tax base even where it leaves the payroll-tax base alone.
   */
  readonly regularWagesCents: Cents;
  /**
   * This period's one-off wages from the same source — a bonus. Separated because a jurisdiction
   * may (and the US does) withhold on them by a different method precisely so that a one-off
   * payment is not read as a permanent pay rise.
   */
  readonly supplementalWagesCents: Cents;
  /** Supplemental wages this source already paid EARLIER in the year, for banded rates. */
  readonly priorSupplementalWagesCents: Cents;
  /**
   * Income tax this source has already withheld earlier in the year. A jurisdiction may condition
   * the supplemental method on whether anything has been withheld at all (the US does).
   */
  readonly priorRegularWithholdingCents: Cents;
  /** How many periods of this size the year holds — the annualization factor. */
  readonly payPeriodsPerYear: number;
  /**
   * Periods left in the tax year, THIS one included — 12 in January, 1 in December. The horizon a
   * prospective mid-year correction has left to spread itself over.
   */
  readonly remainingPayPeriods: number;
  /**
   * This period's regular wages from EVERY source of this same {@link taxCategory} paying the
   * person, this one included, highest first. A withholding form asks the employee about their
   * OTHER jobs precisely because independent employers each price their own wages as if they were
   * the person's only income, and the brackets are shared.
   */
  readonly concurrentRegularWagesCents: readonly Cents[];
  /**
   * True for the ONE source carrying the person's multiple-jobs correction — the highest-paying,
   * as the W-4's own worksheet directs. Every other source withholds its own wages untouched, so
   * the correction is applied once rather than once per employer.
   */
  readonly bearsMultipleJobsAdjustment: boolean;
  /**
   * The person's wages of this category from ALL sources so far this year, after pre-tax
   * deferral — including sources that have since stopped paying.
   */
  readonly priorPersonWagesCents: Cents;
  /** Income tax already withheld against those wages, by all of those sources. */
  readonly priorPersonWithholdingCents: Cents;
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
   * category — never a monthly slice. AUTHORITATIVE: this is what the year actually OWES, priced
   * once, at the year's close, on the income that actually arrived (see {@link
   * import("../projection/runState").SimState.taxableIncomeByPersonYear}). What was withheld
   * against it during the year is a separate, deliberately approximate figure
   * ({@link computeWageWithholdingCents}); the difference is the refund or balance due.
   *
   * The engine owns collecting the year's total and all payment timing; this seam only prices a
   * year. Calling it on anything less than a full year (a monthly slice, an annualized ×12
   * estimate) misprices lumpy income — the engine never does this.
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
   * stays method-agnostic.
   *
   * MUST be pure and monotone non-decreasing in `grossCents`, so that drawing more from an
   * account never books less taxable income. Absent → the whole `grossCents` is taxable.
   */
  taxableWithdrawalCents?(basis: WithdrawalTaxBasis, ctx: JurisdictionContext): Cents;

  /**
   * How an account's periodic RETURN is taxed, given its neutral {@link
   * import("../plan/simAccount").SimAccountTaxProfile.returnKind}: at accrual (US bank interest,
   * ordinary income) or deferred to withdrawal and taxed against basis (capital
   * appreciation). Absent, or `taxAtAccrual: false` → nothing booked at accrual.
   */
  returnTaxTreatment?(returnKind: AccountReturnKind, ctx: JurisdictionContext): ReturnTaxTreatment;

  /**
   * Federal income tax WITHHELD from one wage source's pay for one period — the paycheck-level
   * counterpart to {@link computeTaxCents}, and a different question from it.
   *
   * {@link computeTaxCents} is authoritative and annual: it prices a whole year of every kind of
   * income and says what is OWED. This says what payroll TAKES OUT, knowing only the period in
   * front of it. The two disagree by construction, and the engine settles the difference on the
   * jurisdiction's filing date rather than hiding it — see {@link
   * import("../projection/taxYearSettlement").finalizeTaxYear}.
   *
   * CAUSAL BY CONSTRUCTION: the request carries no forecast and no other period's figures, so a
   * raise, a cut, a missed paycheck or a job starting mid-year changes this period's withholding
   * and cannot reach back to change an earlier one. Non-wage income never arrives here at all —
   * a retirement withdrawal or a realized gain is priced only by the annual seam.
   *
   * MUST be non-negative: withholding is money taken from a paycheck, never added to it.
   * Absent → no income tax is withheld and the whole year's liability settles on filing.
   */
  computeWageWithholdingCents?(
    request: WageWithholdingRequest,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * Employee payroll tax (US: FICA) WITHHELD by ONE wage source, on that source's CUMULATIVE
   * year-to-date earned income by category. Distinct from {@link computeTaxCents}: its base is
   * the full pre-deferral gross (a 401(k) deferral cuts income tax, never payroll tax) and its
   * category set is earned income only, so a retirement-account withdrawal booked
   * `ordinaryIncome` bears none.
   *
   * PER SOURCE, NOT PER PERSON — this is real payroll withholding, and an employer applies every
   * cap and threshold to the wages IT paid because it cannot see the person's other jobs. A
   * person with two jobs therefore gets each capped component applied twice, which is what really
   * happens and what {@link reconcilePayrollTaxCents} exists to square up.
   *
   * The engine feeds year-to-date totals and charges the DIFFERENCE month to month, so a capped
   * component binds on cumulative earnings rather than on annualized monthly slices. MUST
   * therefore be monotone non-decreasing in each category's amount, so the difference is never a
   * credit. Absent → no payroll tax withheld.
   */
  computePayrollWithholdingCents?(
    sourceCumulativeEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * {@link computePayrollWithholdingCents} broken out per {@link TaxCategory} — the
   * jurisdiction's call, mirroring {@link computeTaxByCategoryCents}. REQUIRED whenever
   * {@link computePayrollWithholdingCents} is supplied (the engine asserts this at runtime), so
   * that a month's charge can be attributed back to the income it came from for reporting.
   *
   * CONTRACT: Σ of the returned map for a given cumulative input MUST equal
   * {@link computePayrollWithholdingCents} for that SAME input — enforced at runtime, to the
   * exact cent.
   */
  computePayrollWithholdingByCategoryCents?(
    sourceCumulativeEarnedByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Partial<Record<TaxCategory, Cents>>;

  /**
   * The payroll-tax adjustment the annual FILING makes over a year of per-source withholding —
   * signed, positive owed, negative refunded. One entry per wage source, each that source's
   * WHOLE-YEAR earned income by category.
   *
   * Exists because some payroll components are withheld per employer but owed on the person's
   * combined wages, so the two figures genuinely differ and the law genuinely squares them up on
   * the return (US: excess Social Security as a refundable credit, Additional Medicare on Form
   * 8959). It is NOT a place to re-derive payroll tax the withholding already got right: a
   * jurisdiction whose components are all uncapped, and a person with a single wage source under
   * every cap, must reconcile to exactly zero.
   *
   * The engine folds the result into the same settlement it charges the income-tax balance
   * through, so it reaches the household as cash on the filing date and never as a retroactive
   * change to a paycheck. Absent → payroll tax is never reconciled.
   */
  reconcilePayrollTaxCents?(
    annualEarnedByCategoryPerSource: readonly Partial<Record<TaxCategory, Cents>>[],
    ctx: JurisdictionContext,
  ): Cents;

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
