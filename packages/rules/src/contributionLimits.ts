import type { Cents, DeferralLimitContext, ModelAssumption } from "@finley/engine";

/**
 * US retirement-account contribution limits — the `rules`-side plug for
 * {@link import("@finley/engine").Jurisdiction.retirementDeferralLimitCents}. The engine
 * owns the deferral *channel*; this module owns the *dollar values* and age bands.
 *
 * The caps are NOT one number: elective deferral, the total-additions ceiling (employee +
 * employer match) and the much lower IRA limit are separate, catch-up age-banded per
 * account type. All are modelled here so the values index together.
 *
 * Both 401(k)-side caps are wired: `waterfall.ts` clamps the employee deferral to
 * {@link retirementDeferralLimitCents} (per person, across every job) and the employer match
 * to {@link combinedPlanDepositLimitCents} (per plan — one job, one employer). ⚠ The IRA
 * figures are still unwired — modelled here so they index with the rest, but no seam
 * consumes them.
 *
 * The §-level facts live HERE, never in `@finley/engine`: the engine enforces two generic
 * limits and attaches no US meaning to either.
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
 * The most that employee deferral + employer match together may deposit into ONE plan in a
 * year — the `rules`-side plug for
 * {@link import("@finley/engine").Jurisdiction.combinedPlanDepositLimitCents}. The engine
 * applies it per plan, so a second job brings its own room, where
 * {@link retirementDeferralLimitCents} bounds the employee's own share across all of them.
 *
 * NOT simply "the §415(c) limit". §415(c) is the $72,000 base
 * ({@link ContributionLimits.totalAdditionsCents}); this adds the age-banded catch-up on top,
 * because catch-up contributions sit outside the §415(c) ceiling rather than inside it. The
 * $80,000 and $83,250 figures are therefore effective deposit ceilings, not statutory ones —
 * hence the name.
 *
 * 2026: $72,000 under 50 · $80,000 at 50–59 · $83,250 at 60–63 · $80,000 from 64.
 */
export function combinedPlanDepositLimitCents(ctx: DeferralLimitContext): Cents {
  const limits = contributionLimits(ctx.year);
  return limits.totalAdditionsCents + catchUpCents(limits, ctx.age);
}

/**
 * User-facing disclosures for this module — the `rules` side of
 * {@link import("@finley/engine").Jurisdiction.modelAssumptions}, co-located by `id` with
 * the code they describe ({@link retirementDeferralLimitCents} /
 * {@link totalAdditionsLimitCents} / {@link indexForward}). `usJurisdiction` hands these to
 * the report's "assumptions & simplifications" surface.
 *
 * ⚠ The dollar figures are duplicated in prose here. Keep them in step with the constants
 * at the top of this file whenever the base year is re-pinned.
 */
export const CONTRIBUTION_LIMIT_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "retirementContributionLimits",
    text:
      "Retirement contributions are capped at the 2026 federal limits. You can personally " +
      "contribute up to $24,500 a year across all your 401(k)-style jobs — rising to " +
      "$32,500 from age 50 (an $8,000 catch-up) and $35,750 for ages 60 to 63 (an $11,250 " +
      "super catch-up), then back to $32,500 from 64. Counting your employer's match on " +
      "top, a single job's plan can take $72,000 a year in total. Because catch-up " +
      "contributions are allowed above that ceiling, the effective combined limit rises to " +
      "$80,000 from age 50 and $83,250 for ages 60 to 63. Contributions past a cap are not " +
      "made: that money stays in your pay and is taxed as ordinary income. Like the tax " +
      "brackets, these figures are grown forward at an assumed 2.5%/yr rather than the " +
      "legislated amounts, which are published yearly and will differ.",
  },
  {
    id: "employerMatchOutsideEmployeeCap",
    text:
      "An employer match does not count against your personal contribution limit — it is " +
      "employer money, so it lands on top of the most you can defer yourself. It does count " +
      "against the combined limit above. The two limits have different reach: your personal " +
      "limit is shared across every job you hold, while the combined limit applies " +
      "separately to each employer, so a second job brings its own. Jobs are treated as " +
      "separate employers even where they pay into the same account. Where the combined " +
      "limit binds, this projection trims the employer match and leaves your own " +
      "contribution whole — a modelling choice, not a rule about how a real plan would " +
      "apply the cap.",
  },
];
