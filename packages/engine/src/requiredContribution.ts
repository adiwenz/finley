/**
 * The deadline-paced sinking-fund pace (§14/§19 of JOBS_HOUSEHOLD_REDESIGN, #26) —
 * the single pure primitive behind the `goalPaced` amount source and the waterfall's
 * fund-to-pace goal loop.
 *
 * Separating pace from triage is the whole point of #26: the deadline sets the
 * *pace* (how fast a goal must accumulate to hit its target by its date), and
 * priority becomes *scarcity triage* (who falls behind when the paces don't all
 * fit in one month's cash). This module owns the pace half.
 *
 * Growth-aware annuity: a monthly contribution `c` held in a fund earning monthly
 * rate `r` for `m` months, starting from `balance`, accumulates to
 *
 *   balance·(1+r)^m + c·((1+r)^m − 1)/r
 *
 * Solving that for the `c` that lands exactly on `target` gives the required
 * contribution. Pure and jurisdiction-agnostic: `monthlyRate` is passed in (the
 * fund account's rate), never read from a clock or the rules layer.
 */

import type { Cents } from "./money";

/**
 * The contribution a goal must make THIS month to still reach `targetCents` by its
 * deadline, given `balanceCents` already saved, `monthsRemaining` months of runway,
 * and the fund account's `monthlyRate` (§14/§19, #26). Always ≥ 0 — a fund already
 * at or past its target (with or without projected growth) requires nothing.
 *
 * Two edge cases degrade off the general annuity formula (both are its limits, not
 * special-cased guesses):
 *   - **near-deadline** (`monthsRemaining ≤ 1`): no time to spread — the whole
 *     remaining gap is due this month, so it returns `target − balance`.
 *   - **zero-rate** (`monthlyRate === 0`): no growth to lean on — the gap is spread
 *     evenly, `(target − balance) / monthsRemaining` (the r→0 limit of the annuity,
 *     since `((1+r)^m − 1)/r → m`). This also avoids the 0/0 the formula would hit.
 */
export function requiredContributionCents(
  targetCents: Cents,
  balanceCents: Cents,
  monthsRemaining: number,
  monthlyRate: number,
): Cents {
  const gap = targetCents - balanceCents;
  if (gap <= 0) return 0;

  // Near-deadline: nothing left to amortize over — the gap is due in full now.
  if (monthsRemaining <= 1) return gap;

  // Zero-rate: even spread over the months left (the r→0 limit of the annuity).
  if (monthlyRate === 0) return Math.max(0, Math.round(gap / monthsRemaining));

  // Growth-aware annuity: solve balance·(1+r)^m + c·((1+r)^m − 1)/r = target for c.
  const growth = Math.pow(1 + monthlyRate, monthsRemaining);
  const projectedBalance = balanceCents * growth;
  const contribution = ((targetCents - projectedBalance) * monthlyRate) / (growth - 1);
  return Math.max(0, Math.round(contribution));
}
