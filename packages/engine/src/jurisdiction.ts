import type { Cents } from "./money";
import type { EarningsRecord } from "./earningsRecord";

/**
 * The jurisdiction interface — the plug-and-play seam (ARCHITECTURE.md, §5.3–5.5).
 *
 * The engine DEFINES what a jurisdiction must supply; it never hardcodes any
 * jurisdiction fact. A `rules` package (e.g. `US-2026`) IMPLEMENTS this. The
 * engine ships the trivial {@link nullJurisdiction} (zero tax, no programs) so
 * it runs and is testable standalone with no rules package present.
 *
 * Slice 0 exposes only the `computeTax` seam. Later slices widen this interface
 * (contribution limits, Social Security benefit, Medicare, RMDs) against the
 * same engine-defines-socket / rules-fills-plug pattern.
 */
export interface JurisdictionContext {
  /** Calendar year the figure applies to; all rules facts are year-parameterized. */
  readonly year: number;
}

/**
 * Context for the Social Security benefit seam (§5.4). The engine supplies the
 * pinned claiming age (62–70, a decision variable, never searched by the solver),
 * the person's age in the year benefits begin, and that calendar year; `rules`
 * computes the benefit from the {@link EarningsRecord} plus these.
 */
export interface SocialSecurityContext extends JurisdictionContext {
  /** Pinned claiming age (62 earliest, 67 full, 70 max). An input, never searched. */
  readonly claimingAge: number;
  /** The person's age in the year benefits begin (equals claimingAge at first claim). */
  readonly currentAge: number;
}

/**
 * Context for the retirement-deferral-limit seam (§5.4). The engine supplies the
 * calendar year and — when known — the contributing person's age that year, so
 * `rules` can add the age-banded catch-up (an extra allowance from 50, larger in
 * the 60–63 band under SECURE 2.0). Age is optional: a person with no birth year
 * gets the base limit only.
 */
export interface DeferralLimitContext extends JurisdictionContext {
  /** The contributing person's age in `year`; enables age-banded catch-up. Absent → base limit only. */
  readonly age?: number;
}

/**
 * Context for the Required Minimum Distribution seam (§5.4). The engine owns the
 * pre-tax account balances and calls this once per year for each account holder;
 * `rules` decides the start age (birth-year-dependent) and, at/after it, the
 * required withdrawal from the supplied pre-tax balance (0 before the start age).
 */
export interface RmdContext extends JurisdictionContext {
  /** The account holder's age in `year` (`year − birthYear`). */
  readonly age: number;
  /** Birth year — sets the rules-side RMD start age (73 vs. 75 under current US law). */
  readonly birthYear: number;
}

/**
 * Context for the health-cost benchmark seam (§5.4). The engine supplies the
 * calendar year and the person's age that year; `rules` returns the attributed
 * monthly health cost that applies at that age — the elevated self-funded figure
 * before the jurisdiction's Medicare-eligibility age, the lower Medicare-residual
 * figure at/after it. This is the "visible attributed step" (Medicare at 65 lowers
 * health cost, not to zero) the app surfaces, and the benchmark the early-retiree
 * honesty flag compares an authored health expense against.
 */
export interface HealthCostContext extends JurisdictionContext {
  /** The person's age in `year`; the benchmark steps down at the Medicare-eligibility age. */
  readonly age: number;
}

export interface Jurisdiction {
  /** Stable identifier, e.g. `"null"` or `"US-2026"`. */
  readonly id: string;

  /**
   * §5.4 seam (readable fact): the age at which public health coverage begins,
   * where the attributed health cost steps down from the elevated self-funded
   * figure to the lower residual (US law: 65, Medicare). A neutral name — no
   * "Medicare" brand in the general interface. The projection uses this as the
   * single source of the health-step age, and the early-retiree honesty flag
   * measures the self-funded gap up to it. Optional and legislation-set: absent
   * (v1 null jurisdiction) → no step / no gap.
   */
  readonly publicHealthCoverageAge?: number;

  /**
   * The single tax chokepoint (§5.3 seam 1): taxable income in → tax owed in
   * cents out. v1 implementations may return 0; what matters is that the
   * pipeline calls exactly one replaceable function rather than smearing tax
   * logic across allocation code.
   */
  computeTaxCents(taxableIncomeCents: Cents, ctx: JurisdictionContext): Cents;

  /**
   * §5.4 seam: a person's annual employee pre-tax deferral limit (401k-style) for
   * the given year, including the age-banded catch-up when {@link
   * DeferralLimitContext.age} is supplied. The waterfall caps each person's
   * combined deferral at this and redirects the overflow to the next destination
   * in the priority order (§5.0). Optional and legislation-set; when absent,
   * deferrals are uncapped (v1 null jurisdiction). The employer match is separate
   * and does NOT share this cap.
   */
  retirementDeferralLimitCents?(ctx: DeferralLimitContext): Cents;

  /**
   * §5.4 seam: a person's monthly Social Security benefit, derived from their
   * accumulated lifetime {@link EarningsRecord} at claiming age. The engine owns
   * and accumulates the record (pure bookkeeping) and calls this once when the
   * person reaches their claiming age; `rules` implements the AIME→PIA bend-point
   * formula. Optional and legislation-set: when absent (v1 null jurisdiction) the
   * benefit is 0 while the record still accumulates. The result is nominal cents
   * and enters the waterfall POST-deferral, tagged `socialSecurity` for the
   * partial-taxation seam — SS is not earned wages (§5.4).
   */
  socialSecurityMonthlyBenefitCents?(
    record: EarningsRecord,
    ctx: SocialSecurityContext,
  ): Cents;

  /**
   * §5.4 seam: the Required Minimum Distribution a pre-tax account holder must
   * withdraw this year, given their aggregate pre-tax balance and age. `rules`
   * owns the start age (birth-year-dependent, e.g. 73 vs. 75) and the life-
   * expectancy divisor table; it returns 0 before the start age. The engine
   * accumulates the pre-tax balances (pure bookkeeping), calls this once per
   * year, and forces the returned amount out of pre-tax accounts as taxable
   * ordinary income routed to a taxable destination (the withdrawal binds as
   * `max(desired, required)`; the base sim has no desired draw, so `required`
   * binds). Optional and legislation-set: absent (v1 null jurisdiction) → no RMD
   * while the balances still compound.
   */
  requiredMinimumDistributionCents?(
    preTaxBalanceCents: Cents,
    ctx: RmdContext,
  ): Cents;

  /**
   * §5.4 seam: the attributed monthly health cost for a person of the given age
   * (Medicare, shape 2). The jurisdiction owns the eligibility age (65 under US
   * law) and the two figures it steps between: an elevated self-funded cost before
   * eligibility (a decade of expensive coverage the early-retiree must self-fund,
   * ~$1,200/mo/person, unsubsidised in v1 → conservative) and a lower residual at/
   * after it (Medicare replaces self-funded insurance but premiums/Part B/out-of-
   * pocket remain — ~$500/mo/person, not zero). Its value is making the pre-65 vs.
   * post-65 gap VISIBLE (§5.4): the app pre-fills the attributed stepped segment
   * and the early-retirement nudge from it, and the {@link
   * import("./earlyRetireeHealthCheck").assessEarlyRetireeHealthCost} honesty flag compares an
   * authored health expense against the pre-eligibility figure. NOT a silent auto-
   * step in the sim — an authored budget item, disclaimed and legislation-set.
   * Optional: absent (v1 null jurisdiction) → no benchmark (0).
   */
  healthCostBenchmarkMonthlyCents?(ctx: HealthCostContext): Cents;

  /**
   * §5.4 seam: the fraction (0..1) of a Social Security benefit that is TAXABLE
   * income. SS is only PARTIALLY taxed — under US law at most 85% of benefits are
   * included, so a share is always tax-free. The engine multiplies each SS income
   * source's gross by this fraction before it reaches the single §5.3 tax
   * chokepoint; the untaxed remainder still arrives as spendable take-home (you
   * receive the whole check, you are just not taxed on all of it). Optional:
   * absent (v1 null jurisdiction) → the benefit is treated as fully taxable
   * (fraction 1, conservative), matching the pre-partial-taxation behaviour.
   */
  socialSecurityTaxableFraction?(ctx: JurisdictionContext): number;
}

/**
 * The null jurisdiction: no taxes, no government programs. Lets the engine run
 * end to end on its own (ARCHITECTURE.md Phase 0/1). Never remove it — it is
 * the standalone-runnability guarantee and the baseline for engine-only tests.
 */
export const nullJurisdiction: Jurisdiction = {
  id: "null",
  computeTaxCents: () => 0,
};
