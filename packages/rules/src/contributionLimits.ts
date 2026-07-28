import type { Cents, DeferralLimitContext } from "@finley/engine";

/**
 * US retirement-account contribution limits — the structured cap set governing how much
 * may go into tax-advantaged accounts in a year.
 *
 * The `rules`-side plug for
 * {@link import("@finley/engine").Jurisdiction.retirementDeferralLimitCents}. The engine
 * owns the deferral *channel* (the waterfall caps each person's summed 401(k)-style
 * deferrals against this figure and redirects overflow to the next priority destination);
 * this module owns the *dollar values* and age bands.
 *
 * The caps are NOT one number: the 401(k) employee elective-deferral limit is separate
 * from the total-additions ceiling (employee + employer match) and from the much lower
 * IRA limit; catch-up is age-banded and per-account-type. The full set is modelled here so
 * the values index together, though v1 wires only the elective-deferral limit (+ catch-up)
 * into its single deferral channel; total-additions and IRA caps are authored and indexed
 * but await engine channels to enforce them.
 *
 * ⚠ Estimates, not advice. US legislation changes yearly; forward years are INDEXED, not
 * authoritative. Figures below are the pinned {@link CONTRIBUTION_LIMITS_BASE_YEAR} base.
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
 * The engine's deferral-limit seam: a person's 401(k)-style elective-deferral cap for the
 * year. No age (or under 50) → the base limit; from 50 the standard catch-up is added; in
 * 60–63 the larger SECURE 2.0 catch-up applies instead. The employer match is separate and
 * does NOT share this cap.
 */
export function retirementDeferralLimitCents(ctx: DeferralLimitContext): Cents {
  const limits = contributionLimits(ctx.year);
  const base = limits.elective401kCents;
  const age = ctx.age;
  if (age === undefined || age < 50) return base;
  if (age >= 60 && age <= 63) return base + limits.catchUp60to63Cents;
  return base + limits.catchUp50Cents;
}
