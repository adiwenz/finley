import type { Cents, DeferralLimitContext } from "@finley/engine";

/**
 * US retirement-account contribution limits — the `rules`-side plug for
 * {@link import("@finley/engine").Jurisdiction.retirementDeferralLimitCents}. The engine
 * owns the deferral *channel*; this module owns the *dollar values* and age bands.
 *
 * The caps are NOT one number: elective deferral, the total-additions ceiling (employee +
 * employer match) and the much lower IRA limit are separate, catch-up age-banded per
 * account type. All are modelled here so the values index together.
 *
 * ⚠ {@link totalAdditionsLimitCents} is computed but NOT yet enforced by the projection: the
 * engine clamps the employee deferral to {@link retirementDeferralLimitCents} in
 * `waterfall.ts` and then deposits the employer match on top unclamped. Enforcing 415(c)
 * needs an engine-side seam to consume this. The IRA figures are likewise unwired.
 *
 * ⚠ Estimates, not advice. Forward years are INDEXED from the pinned
 * {@link CONTRIBUTION_LIMITS_BASE_YEAR} base below, not authoritative.
 */

/** The calendar year the pinned dollar figures below are authoritative for. */
export const CONTRIBUTION_LIMITS_BASE_YEAR = 2026;

/** 401(k)/403(b)/457 employee elective-deferral limit — the shared-across-jobs cap. */
const BASE_ELECTIVE_401K_CENTS: Cents = 24_500_00;
/** Additional elective deferral allowed from age 50 (the standard catch-up). */
const BASE_CATCH_UP_50_CENTS: Cents = 8_000_00;
/** The larger SECURE 2.0 catch-up, 60–63 only. Replaces (not adds to) the 50+ figure. */
const BASE_CATCH_UP_60_TO_63_CENTS: Cents = 11_250_00;
/** Section 415(c) total-additions ceiling: employee deferral + employer match combined. */
const BASE_TOTAL_ADDITIONS_CENTS: Cents = 72_000_00;
/** Traditional/Roth IRA annual contribution limit (separate, much lower cap). */
const BASE_IRA_CENTS: Cents = 7_500_00;
/**
 * Additional IRA contribution from age 50 — FLAT, no upper-age cliff (post-SECURE, IRA
 * contributions continue while there is earned income). ⚠ Do NOT apply the 401(k) age
 * banding: reusing `retirementDeferralLimitCents` for an IRA channel would invent a 60–63
 * super-catch-up and an age-64 drop the IRA lacks.
 */
const BASE_IRA_CATCH_UP_50_CENTS: Cents = 1_100_00;

/**
 * Assumed forward CPI indexing rate. The seam context carries no year-by-year rate, so
 * this rules-side estimate stands in for the legislated, yearly-published one.
 */
const ASSUMED_ANNUAL_INDEXING_RATE = 0.025;

/** IRS rounding increment for elective-deferral, catch-up, and total-additions figures. */
const ROUND_500_CENTS = 500_00;
/** IRS rounding increment for the (lower) IRA figures. */
const ROUND_IRA_CENTS = 500_00;

/**
 * Index a base-year figure forward to `year`, rounded DOWN to `incrementCents` (how the
 * IRS steps these caps). Years at or before the base year return it unchanged — no
 * backward indexing.
 */
function indexForward(baseCents: Cents, year: number, incrementCents: Cents): Cents {
  const years = year - CONTRIBUTION_LIMITS_BASE_YEAR;
  if (years <= 0) return baseCents;
  const indexed = baseCents * Math.pow(1 + ASSUMED_ANNUAL_INDEXING_RATE, years);
  return Math.floor(indexed / incrementCents) * incrementCents;
}

export interface ContributionLimits {
  readonly year: number;
  /** 401(k)-style employee elective-deferral limit (shared across a person's jobs). */
  readonly elective401kCents: Cents;
  /** Standard catch-up added to the elective limit from age 50. */
  readonly catchUp50Cents: Cents;
  /** SECURE 2.0 catch-up for ages 60–63 (replaces, not adds to, the 50+ figure). */
  readonly catchUp60to63Cents: Cents;
  /** Section 415(c) total-additions ceiling (employee + employer match). */
  readonly totalAdditionsCents: Cents;
  /** Traditional/Roth IRA annual limit (separate, lower cap). */
  readonly iraCents: Cents;
  /** IRA catch-up from age 50 — flat: no 60–63 band, no age-64 drop, unlike the 401(k) one. */
  readonly iraCatchUp50Cents: Cents;
}

/** The pinned {@link CONTRIBUTION_LIMITS_BASE_YEAR} figures indexed forward to `year`. */
export function contributionLimits(year: number): ContributionLimits {
  return {
    year,
    elective401kCents: indexForward(BASE_ELECTIVE_401K_CENTS, year, ROUND_500_CENTS),
    catchUp50Cents: indexForward(BASE_CATCH_UP_50_CENTS, year, ROUND_500_CENTS),
    catchUp60to63Cents: indexForward(BASE_CATCH_UP_60_TO_63_CENTS, year, ROUND_500_CENTS),
    totalAdditionsCents: indexForward(BASE_TOTAL_ADDITIONS_CENTS, year, ROUND_500_CENTS),
    iraCents: indexForward(BASE_IRA_CENTS, year, ROUND_IRA_CENTS),
    iraCatchUp50Cents: indexForward(BASE_IRA_CATCH_UP_50_CENTS, year, ROUND_IRA_CENTS),
  };
}

/**
 * The catch-up a person of `age` may add in `year`. No age (or under 50) → none; from 50 the
 * standard figure; in 60–63 the larger SECURE 2.0 one INSTEAD (it replaces, not stacks); from
 * 64 back to the standard one.
 *
 * Shared by both caps below because the catch-up rides on top of each: the same dollars that
 * raise the elective limit also raise the 415(c) ceiling.
 */
function catchUpCents(limits: ContributionLimits, age: number | undefined): Cents {
  if (age === undefined || age < 50) return 0;
  if (age >= 60 && age <= 63) return limits.catchUp60to63Cents;
  return limits.catchUp50Cents;
}

/**
 * The engine's deferral-limit seam: a person's 401(k)-style elective-deferral cap for the
 * year — what the EMPLOYEE may personally defer, age-banded by {@link catchUpCents}. The
 * employer match is separate and does NOT share this cap; it is bounded only by
 * {@link totalAdditionsLimitCents}.
 *
 * 2026: $24,500 under 50 · $32,500 at 50–59 · $35,750 at 60–63 · $32,500 from 64.
 */
export function retirementDeferralLimitCents(ctx: DeferralLimitContext): Cents {
  const limits = contributionLimits(ctx.year);
  return limits.elective401kCents + catchUpCents(limits, ctx.age);
}

/**
 * The Section 415(c) total-additions ceiling: employee deferral + employer match COMBINED,
 * per employer plan. The outer bound on everything that lands in the account — where
 * {@link retirementDeferralLimitCents} bounds only the employee's own share.
 *
 * Age-banded the same way, since catch-up contributions sit on top of the 415(c) base rather
 * than inside it.
 *
 * 2026: $72,000 under 50 · $80,000 at 50–59 · $83,250 at 60–63 · $80,000 from 64.
 */
export function totalAdditionsLimitCents(ctx: DeferralLimitContext): Cents {
  const limits = contributionLimits(ctx.year);
  return limits.totalAdditionsCents + catchUpCents(limits, ctx.age);
}
