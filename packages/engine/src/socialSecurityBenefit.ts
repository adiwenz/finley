import type { Cents } from "./money";
import type { EarningsRecord } from "./earningsRecord";
import type { Jurisdiction } from "./jurisdiction";

/**
 * A Social Security claim priced at a point in time (§5.4): the frozen earnings
 * record plus the who/when the jurisdiction's AIME→PIA formula needs. The engine
 * owns this shape so every surface that prices a benefit — the nominal net-worth
 * projection and the real-terms retirement panel — reaches the
 * {@link Jurisdiction.socialSecurityMonthlyBenefitCents} seam through ONE function
 * and cannot silently disagree on the formula. (Each caller still supplies its own
 * {@link record}; agreeing on the record itself is a separate concern.)
 */
export interface SocialSecurityClaim {
  /** The lifetime covered-earnings record the AIME→PIA formula reads. */
  readonly record: EarningsRecord;
  /** Calendar year benefits begin (the year the person reaches {@link claimingAge}). */
  readonly claimYear: number;
  /** Pinned claiming age (62 earliest, 67 full, 70 max). An input, never searched. */
  readonly claimingAge: number;
  /** The person's age in {@link claimYear} — equals {@link claimingAge} at first claim. */
  readonly currentAge: number;
}

/**
 * The nominal monthly Social Security benefit at claim, via the jurisdiction seam
 * (§5.4). Clamped ≥ 0; 0 when the jurisdiction supplies no benefit seam (v1 null).
 * This is the single place the engine invokes the seam — the projection and the
 * panel both route through it, so they price an identical record identically.
 */
export function priceSocialSecurityMonthlyCents(
  jurisdiction: Jurisdiction,
  claim: SocialSecurityClaim,
): Cents {
  return Math.max(
    0,
    jurisdiction.socialSecurityMonthlyBenefitCents?.(claim.record, {
      year: claim.claimYear,
      claimingAge: claim.claimingAge,
      currentAge: claim.currentAge,
    }) ?? 0,
  );
}

/**
 * The same benefit as a REAL (base-year dollars) ANNUAL figure: price the nominal
 * monthly benefit at the claim year, annualize, then deflate back to `baseYear` at
 * CPI (§0.5). This is what a real / today's-dollars surface (the retirement panel)
 * reports; the nominal projection instead holds the monthly figure and grows it by
 * COLA each year post-claim, which lands at the same value in real terms.
 */
export function priceSocialSecurityAnnualRealCents(
  jurisdiction: Jurisdiction,
  claim: SocialSecurityClaim,
  baseYear: number,
  annualInflationRate: number,
): Cents {
  const monthlyNominal = priceSocialSecurityMonthlyCents(jurisdiction, claim);
  const deflator = Math.pow(1 + annualInflationRate, claim.claimYear - baseYear);
  return Math.round((monthlyNominal * 12) / deflator);
}
