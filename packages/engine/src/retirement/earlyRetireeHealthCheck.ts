/**
 * Flags a retiree whose authored health expense ignores the elevated cost of self-funding
 * coverage before public eligibility.
 *
 * One check, not "the health module": the dollar figures and eligibility age live in `rules`
 * (`healthCosts.ts`, behind the `healthCostBenchmarkMonthlyCents` seam), and the authored cost
 * comes off the budget (`budget/budgetLine.ts` `healthcareMonthlyCents`). Pure and
 * jurisdiction-agnostic — the caller supplies every resolved figure.
 *
 * Medicare is not a silent auto-step in the sim, and health is an ordinary authored budget
 * line — the plan holds no health figure of its own. This synthesises no cost, only a flag.
 */

import type { Cents } from "../money/money";

export interface EarlyRetireeHealthCheck {
  /** Age employment — and with it employer coverage — stops. */
  readonly retirementAge: number;
  /** Jurisdiction fact (65 under US law): below it, retirees self-fund coverage. */
  readonly publicHealthCoverageAge: number;
  readonly authoredHealthMonthlyCents: Cents;
  readonly selfFundedBenchmarkMonthlyCents: Cents;
}

export interface EarlyRetireeHealthFlag {
  readonly flagged: boolean;
  /** `publicHealthCoverageAge − retirementAge`, clamped at 0. */
  readonly gapYears: number;
  /** Authored cost's shortfall against the benchmark, clamped at 0. */
  readonly shortfallMonthlyCents: Cents;
}

/**
 * Flags only when BOTH hold: a real self-funded gap before eligibility, and an authored health
 * expense below the benchmark for that window.
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
