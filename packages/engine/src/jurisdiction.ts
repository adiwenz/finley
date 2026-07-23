import type { Cents } from "./money";
import type { EarningsRecord } from "./earningsRecord";
import type { TaxCategory } from "./cashFlowSeries";
import type { AccountReturnKind } from "./simAccount";

/**
 * The jurisdiction interface — the plug-and-play seam (ARCHITECTURE.md, §5.3–5.5).
 *
 * The engine DEFINES what a jurisdiction must supply; it never hardcodes any
 * jurisdiction fact. A `rules` package (e.g. `US-2026`) IMPLEMENTS this. The
 * engine ships the trivial {@link nullJurisdiction} (zero tax, no programs) so
 * it runs and is testable standalone with no rules package present.
 *
 * Slice 0 exposes only the `computeTax` seam. Later slices widen this interface
 * (contribution limits, government retirement benefit, Medicare, RMDs) against the
 * same engine-defines-socket / rules-fills-plug pattern.
 */
export interface JurisdictionContext {
  /** Calendar year the figure applies to; all rules facts are year-parameterized. */
  readonly year: number;
}

/**
 * The canonical government-benefit seam input (§5.4): the frozen covered-earnings
 * record plus the who/when the jurisdiction's benefit formula needs, priced at a
 * point in time. The engine owns and accumulates the {@link EarningsRecord} and
 * hands this whole shape to {@link Jurisdiction.governmentBenefitBaseMonthlyCents}.
 * It is recomputable: {@link currentAge} advances if the base is recomputed while
 * the worker keeps earning (Phase 5), which the base formula reads to index the
 * record forward.
 */
export interface GovernmentBenefitClaim {
  /** The lifetime covered-earnings record the benefit formula reads. */
  readonly record: EarningsRecord;
  /** Calendar year benefits begin (the year the person reaches {@link claimingAge}). */
  readonly claimYear: number;
  /** Pinned claiming age (62 earliest, 67 full, 70 max). An input, never searched. */
  readonly claimingAge: number;
  /** Age at this (re)computation — equals {@link claimingAge} at first claim, advances on recompute. */
  readonly currentAge: number;
}

/**
 * Context for the COLA-adjustment seam {@link Jurisdiction.colaAdjustedBenefitCents}
 * (§5.4). The engine holds the frozen base benefit as an OPAQUE number and, each
 * year, asks the jurisdiction to inflate it; the jurisdiction owns the formula. The
 * engine supplies the calendar year, the person's age that year (which drives the
 * COLA-factor exponent, measured from the jurisdiction's own eligibility age), and
 * the COLA rate to apply (the plan's `benefitColaRate` when set, else general CPI).
 */
export interface GovernmentBenefitContext extends JurisdictionContext {
  /** The person's age in `year` — drives the COLA factor exponent (age − eligibility age). */
  readonly currentAge: number;
  /** The cost-of-living rate to apply this year (plan `benefitColaRate` ?? general inflation). */
  readonly colaRate: number;
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

/**
 * The engine-held state a {@link Jurisdiction.taxableWithdrawalCents} decision reads:
 * the amount drawn, the account's cost basis and balance the draw is measured against,
 * and the draw's neutral provenance category. The engine OWNS and tracks the basis
 * (across deposits, draws, transfers) exactly as it accumulates pre-tax balances for
 * the RMD seam; the jurisdiction reads this snapshot and owns the return-of-capital
 * policy. `basisCents` 0 (a pre-tax account, no basis) means the whole draw is taxable.
 */
export interface WithdrawalTaxBasis {
  /** The gross amount withdrawn this draw. */
  readonly grossCents: Cents;
  /** Cost basis remaining in the account — principal already taxed going in. */
  readonly basisCents: Cents;
  /** Account balance the draw is measured against (the basis-fraction denominator). */
  readonly balanceCents: Cents;
  /** The account's neutral withdrawal provenance category (never a US vehicle string). */
  readonly category: TaxCategory;
}

/**
 * How a {@link Jurisdiction.returnTaxTreatment} decision classifies an account's
 * periodic return: taxed as it accrues (bank interest) or deferred to withdrawal
 * (capital appreciation), and — when accrued — under which {@link TaxCategory}.
 */
export interface ReturnTaxTreatment {
  /** True → tax the credited return in the year it accrues; false → defer to withdrawal. */
  readonly taxAtAccrual: boolean;
  /** The category the accrued return is booked under (moot when `taxAtAccrual` is false). */
  readonly category: TaxCategory;
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
   * The single tax chokepoint (§5.3 seam 1): per-{@link TaxCategory} taxable
   * amounts in → tax owed in cents out. The engine states each flow's PROVENANCE
   * (which category the amount came from) and passes the full gross per category;
   * the JURISDICTION owns the consequence — how much of each category is taxed and
   * at what rate (e.g. its own government-benefit inclusion %, capital-gains
   * preference). The engine never collapses the categories into one lump, so the
   * distinctions always reach the jurisdiction. v1 implementations may return 0;
   * what matters is that exactly one replaceable function decides tax policy rather
   * than smearing it across allocation code.
   */
  computeTaxCents(
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
    ctx: JurisdictionContext,
  ): Cents;

  /**
   * §5.3 seam: how much of a post-tax account withdrawal is TAXABLE, given the cost
   * basis the engine tracks ({@link WithdrawalTaxBasis}). This parallels the RMD seam —
   * the engine owns the basis STATE and calls this per draw; the JURISDICTION owns the
   * return-of-capital POLICY (is principal returned tax-free, and by what accounting
   * method — pro-rata, specific-lot, average-cost). The engine books the returned value
   * to `computeTaxCents` and reduces basis by `grossCents − taxable` (the principal
   * returned), so the state update stays method-agnostic. Called inside the withdrawal
   * gross-up loop for many probe amounts, so it MUST be pure and monotone non-decreasing
   * in `grossCents` (a rising taxable base is what lets the loop climb to its least fixed
   * point). Optional: absent (null jurisdiction) → the whole `grossCents` is taxable —
   * the engine never pre-reduces the base itself, preserving the "engine passes the full
   * gross" contract of {@link computeTaxCents} for a jurisdiction that models no basis.
   */
  taxableWithdrawalCents?(basis: WithdrawalTaxBasis, ctx: JurisdictionContext): Cents;

  /**
   * §5.3 seam: how an account's periodic RETURN is taxed, given the neutral kind of
   * return it produces ({@link import("./simAccount").SimAccountTaxProfile.returnKind}).
   * The engine owns the compounding and the accrual bookkeeping; the JURISDICTION owns
   * the policy — is the return taxed as it accrues (bank interest, US: yes, as ordinary
   * income) or deferred to withdrawal and taxed there against basis (capital
   * appreciation)? Called each month for every account that declares a `returnKind`.
   * Optional: absent (null jurisdiction), or any return the jurisdiction marks
   * `taxAtAccrual: false` → the engine books nothing at accrual and the return is
   * deferred. This is what moves interest's accrual-timing and ordinary-income
   * categorization out of the engine and into `rules`, where it belongs (#94 follow-up).
   */
  returnTaxTreatment?(returnKind: AccountReturnKind, ctx: JurisdictionContext): ReturnTaxTreatment;

  /**
   * §5.4 seam: which income {@link TaxCategory} flows count toward the covered-
   * earnings {@link EarningsRecord} that feeds the government-benefit formula. A
   * jurisdiction fact (US covers wages + self-employment ordinary income, never the
   * benefit itself — that would be circular — nor capital gains or tax-exempt
   * income), so it lives here rather than in the engine's neutral accumulator.
   * Optional: when absent, the engine applies a documented bookkeeping-only default
   * (`wages` only). Moot for the null jurisdiction, which never reads the record.
   */
  isCoveredEarnings?(taxCategory: TaxCategory): boolean;

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
   * §5.4 seam (readable fact): the default benefit claiming age — the full
   * retirement age (US law: 67) — used to time when a person's benefit begins
   * when they haven't pinned their own {@link GovernmentBenefitClaim.claimingAge}.
   * A jurisdiction fact, not an engine one: the engine holds no US age and reads
   * this to place the claim year, falling back to "benefit not timed" (no source)
   * when neither the person nor the jurisdiction supplies one. Optional and
   * legislation-set: absent (v1 null jurisdiction) → an unpinned person's benefit
   * is simply not timed, while the null jurisdiction returns a 0 base anyway.
   */
  readonly defaultBenefitClaimingAge?: number;

  /**
   * §5.4 seam (base): the government retirement benefit in eligibility-age dollars —
   * `PIA(record) × claimingFactor(claimingAge)` — derived from the accumulated
   * covered-earnings {@link EarningsRecord}. Returns 0 when the record fails the
   * jurisdiction's eligibility gate (US: < 40 credits; the gate lives INSIDE here,
   * not on a separate engine seam). `rules` implements the AIME→PIA bend-point
   * formula. The engine caches the result as an OPAQUE base and calls this once at
   * claim — then again only while the record keeps growing (Phase 5). Optional and
   * legislation-set: absent (v1 null jurisdiction) → 0 while the record still
   * accumulates. The COLA that grows it forward is a separate seam,
   * {@link colaAdjustedBenefitCents}, so the engine never sees the base's formula.
   */
  governmentBenefitBaseMonthlyCents?(claim: GovernmentBenefitClaim): Cents;

  /**
   * §5.4 seam (COLA): apply the cost-of-living adjustment to a frozen base benefit —
   * `baseCents × (1 + colaRate)^(currentAge − eligibilityAge)`. The engine holds
   * `baseCents` as an OPAQUE number (it never sees this formula nor the eligibility
   * age) and calls this cheaply once per year to get the nominal benefit actually
   * paid. Collapsing the old 62→claim eligibility bridge and the post-claim forward
   * COLA into this single factor is exact for the modelled 62–70 claiming range.
   * The result is nominal cents and enters the waterfall POST-deferral, tagged
   * `governmentRetirementBenefit` so the tax seam applies its own inclusion % — it
   * is not earned wages (§5.4). Optional: absent → the base is paid unadjusted.
   */
  colaAdjustedBenefitCents?(baseCents: Cents, ctx: GovernmentBenefitContext): Cents;

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
