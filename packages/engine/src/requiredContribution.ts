/**
 * The deadline-paced sinking-fund pace behind the `goalPaced` amount source and the
 * waterfall's fund-to-pace goal loop.
 *
 * Pace and triage are separate concerns: the deadline sets the *pace*, priority handles
 * *scarcity triage* (who falls behind when the paces don't all fit in one month's cash).
 * This owns the pace half.
 *
 * Growth-aware annuity: a monthly contribution `c` in a fund earning monthly rate `r` for
 * `m` months, starting from `balance`, accumulates to
 *
 *   balance·(1+r)^m + c·((1+r)^m − 1)/r
 *
 * solved for the `c` landing exactly on `target`. `monthlyRate` is passed in (the fund
 * account's rate), never read from a clock or the rules layer.
 */

import type { Cents } from "./money";

/**
 * The contribution a goal must make THIS month to still reach `targetCents` by its
 * deadline. Always ≥ 0 — a fund at or past its target requires nothing. Both early returns
 * below are limits of the annuity formula, not special-cased guesses.
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

  // The r→0 limit of the annuity, since ((1+r)^m − 1)/r → m. Also avoids the formula's 0/0.
  if (monthlyRate === 0) return Math.max(0, Math.round(gap / monthsRemaining));

  const growth = Math.pow(1 + monthlyRate, monthsRemaining);
  const projectedBalance = balanceCents * growth;
  const contribution = ((targetCents - projectedBalance) * monthlyRate) / (growth - 1);
  return Math.max(0, Math.round(contribution));
}
