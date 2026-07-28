/**
 * The deadline-paced sinking-fund pace — the pure primitive behind the `goalPaced` amount
 * source and the waterfall's fund-to-pace goal loop.
 *
 * Pace and triage are separate concerns: the deadline sets the *pace* (how fast a goal
 * must accumulate to hit its target by its date), priority handles *scarcity triage* (who
 * falls behind when the paces don't all fit in one month's cash). This owns the pace half.
 *
 * Growth-aware annuity: a monthly contribution `c` in a fund earning monthly rate `r` for
 * `m` months, starting from `balance`, accumulates to
 *
 *   balance·(1+r)^m + c·((1+r)^m − 1)/r
 *
 * Solving for the `c` landing exactly on `target` gives the required contribution. Pure
 * and jurisdiction-agnostic: `monthlyRate` is passed in (the fund account's rate), never
 * read from a clock or the rules layer.
 */

import type { Cents } from "./money";

/**
 * The contribution a goal must make THIS month to still reach `targetCents` by its
 * deadline, given `balanceCents` already saved, `monthsRemaining` months of runway,
 * and the fund account's `monthlyRate`. Always ≥ 0 — a fund at or past its target
 * requires nothing.
 *
 * Two edge cases are limits of the annuity formula, not special-cased guesses:
 *   - **near-deadline** (`monthsRemaining ≤ 1`): nothing to spread over, so the whole
 *     gap `target − balance` is due this month.
 *   - **zero-rate** (`monthlyRate === 0`): the r→0 limit, `(target − balance) /
 *     monthsRemaining`, since `((1+r)^m − 1)/r → m`. Also avoids the formula's 0/0.
 */
export function requiredContributionCents(
  targetCents: Cents,
  balanceCents: Cents,
  monthsRemaining: number,
  monthlyRate: number,
): Cents {
  const gap = targetCents - balanceCents;
  if (gap <= 0) return 0;

  // Nothing left to amortize over — the gap is due in full now.
  if (monthsRemaining <= 1) return gap;

  // Even spread over the months left (the r→0 limit of the annuity).
  if (monthlyRate === 0) return Math.max(0, Math.round(gap / monthsRemaining));

  // Solve balance·(1+r)^m + c·((1+r)^m − 1)/r = target for c.
  const growth = Math.pow(1 + monthlyRate, monthsRemaining);
  const projectedBalance = balanceCents * growth;
  const contribution = ((targetCents - projectedBalance) * monthlyRate) / (growth - 1);
  return Math.max(0, Math.round(contribution));
}
