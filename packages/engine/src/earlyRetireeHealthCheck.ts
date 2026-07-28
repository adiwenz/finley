/**
 * Early-retiree health-cost honesty check: makes the pre-eligibility health-cost gap visible
 * for someone who retires before Medicare kicks in.
 *
 * ONE check, not "the health module" — health-care logic is split by layer on purpose: US
 * dollar figures + eligibility age live in `rules` (`healthCosts.ts`, behind the
 * `healthCostBenchmarkMonthlyCents` seam), the per-month health cost is an authored expense
 * series the app builds (`projectionBase.ts` `buildHealthSeries`), and the app owns the panel
 * wiring. None can collapse here without crossing a package or altitude boundary.
 *
 * Pure and jurisdiction-agnostic: every figure is supplied by the caller. Taking resolved real
 * cents rather than reaching for the jurisdiction keeps the check testable standalone and the
 * jurisdiction fact in exactly one place.
 *
 * Medicare is deliberately NOT a silent auto-step in the sim — health is an ordinary authored
 * budget item. This synthesises no cost; it flags when the authored one misses the elevated
 * pre-65 reality.
 */

import type { Cents } from "./money";

/**
 * The gap window is `retirementAge … publicHealthCoverageAge`; retiring at/after the coverage
 * age leaves no self-funded window and is never flagged.
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
 * `flagged` is the headline "you retire before Medicare but your plan doesn't reflect the
 * elevated self-funded cost" nudge; the other two quantify it for the app's message.
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
 * Fires only when BOTH hold: the person retires before Medicare eligibility (a real
 * self-funded gap), and their authored health expense is below the benchmark for that window.
 * Retiring at/after eligibility, or already budgeting the benchmark, does not flag.
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
