/**
 * Early-retiree health-cost honesty check (§5.4). The engine's contribution to
 * the Medicare picture: making the pre-eligibility health-cost gap visible for
 * someone who retires before Medicare kicks in.
 *
 * This file is ONE check, not "the health module" — health-care logic is split by
 * layer on purpose: the US dollar figures + eligibility age live in `rules`
 * (`healthCosts.ts`, behind the `healthCostBenchmarkMonthlyCents` seam), the
 * projection's per-month health cost is an authored expense series the app builds
 * (`projectionBase.ts` `buildHealthSeries`), and the app owns the panel wiring. None
 * of those can collapse here without crossing a package or altitude boundary.
 *
 * Pure and jurisdiction-agnostic — every figure is supplied by the caller. The
 * Medicare-eligibility age and the elevated self-funded benchmark come from the
 * rules `healthCostBenchmarkMonthlyCents` seam; the authored health expense comes
 * from the plan. Taking resolved real cents rather than reaching for the
 * jurisdiction keeps the check testable standalone and the jurisdiction fact in
 * exactly one place.
 *
 * Medicare is deliberately NOT a silent auto-step in the sim (§5.4 resolved):
 * health is an ordinary authored budget item. This helper does not synthesise a
 * cost — it flags when the authored one is missing the elevated pre-65 reality.
 */

import type { Cents } from "./money";

/**
 * Inputs to the early-retiree health-cost honesty check. The gap window is
 * `retirementAge … publicHealthCoverageAge`; a person retiring at/after the
 * coverage age has no self-funded window and is never flagged.
 */
export interface EarlyRetireeHealthCheck {
  /** The age the person stops employment (and its employer coverage). */
  readonly retirementAge: number;
  /** Jurisdiction fact (65 under US law): below it, retirees self-fund coverage. */
  readonly publicHealthCoverageAge: number;
  /** The plan's authored monthly health expense for the pre-eligibility window. */
  readonly authoredHealthMonthlyCents: Cents;
  /** The elevated self-funded benchmark for that window (from the rules seam). */
  readonly selfFundedBenchmarkMonthlyCents: Cents;
}

/**
 * The result of the honesty check. `flagged` is the headline "you retire before
 * Medicare but your plan doesn't reflect the elevated self-funded cost" nudge;
 * `gapYears` and `shortfallMonthlyCents` quantify it for the app's message.
 */
export interface EarlyRetireeHealthFlag {
  /** True when there is a pre-eligibility gap AND the authored cost falls short. */
  readonly flagged: boolean;
  /** Years of self-funded coverage before Medicare (`eligibilityAge − retirementAge`, ≥ 0). */
  readonly gapYears: number;
  /** How far the authored monthly cost falls below the benchmark (≥ 0). */
  readonly shortfallMonthlyCents: Cents;
}

/**
 * Assess whether an early retirement is honestly costed for health care (§5.4).
 * The flag fires only when both are true: the person retires before the Medicare-
 * eligibility age (a real self-funded gap exists), and their authored health
 * expense is below the elevated self-funded benchmark for that window (the plan
 * understates it). Retiring at/after eligibility, or already budgeting at least
 * the benchmark, does not flag.
 */
export function assessEarlyRetireeHealthCost(
  check: EarlyRetireeHealthCheck,
): EarlyRetireeHealthFlag {
  const gapYears = Math.max(0, check.publicHealthCoverageAge - check.retirementAge);
  const shortfallMonthlyCents = Math.max(
    0,
    check.selfFundedBenchmarkMonthlyCents - check.authoredHealthMonthlyCents,
  );
  return {
    flagged: gapYears > 0 && shortfallMonthlyCents > 0,
    gapYears,
    shortfallMonthlyCents,
  };
}
