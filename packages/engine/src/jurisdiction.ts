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

export interface Jurisdiction {
  /** Stable identifier, e.g. `"null"` or `"US-2026"`. */
  readonly id: string;

  /**
   * The single tax chokepoint (§5.3 seam 1): taxable income in → tax owed in
   * cents out. v1 implementations may return 0; what matters is that the
   * pipeline calls exactly one replaceable function rather than smearing tax
   * logic across allocation code.
   */
  computeTaxCents(taxableIncomeCents: Cents, ctx: JurisdictionContext): Cents;

  /**
   * §5.4 seam: a person's annual employee pre-tax deferral limit (401k-style) for
   * the given year. The waterfall caps each person's combined deferral at this and
   * redirects the overflow to the next destination in the priority order (§5.0).
   * Optional and legislation-set; when absent, deferrals are uncapped (v1 null
   * jurisdiction). The employer match is separate and does NOT share this cap.
   */
  retirementDeferralLimitCents?(ctx: JurisdictionContext): Cents;

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
