/**
 * funding — the shared ordered-drain primitive for money-out events.
 *
 * Both money-out events (Home Purchase, One-Time Spend) fund
 * an outflow from an ordered list of eligible accounts (liquid non-retirement
 * accounts + goal funds; retirement excluded in v1). This is the one
 * place that decides "take X from these accounts, in the order given": it walks
 * the list, drawing as much as each account holds until the amount is met, and
 * reports what came out (`drained`), what could not be covered (`shortfall`), and
 * the per-account draws the caller turns into transfers.
 *
 * Pure and self-contained: it takes resolved balances (the caller resolves them
 * at the event month) and an amount, and never reaches for a projection. That is
 * what lets the §4.5 affordability gate and the event replay share one definition
 * of "can these sources fund this?" without importing each other's machinery.
 */

import type { Cents } from "../money";

/** One account's contribution to a drain: the source it came from and how much. */
export interface DrainDraw<S> {
  readonly source: S;
  readonly amountCents: Cents;
}

/**
 * The outcome of draining `amountCents` from an ordered source list:
 * - `drained` — total taken out (= `min(amount, available)`);
 * - `shortfall` — the uncovered remainder (= `max(0, amount − available)`), the
 *   value the §4.5 gate hard-blocks on;
 * - `draws` — the per-account amounts, in source order, for the accounts that
 *   actually contributed (positive draws only), ready to become transfers.
 * `drained` and `shortfall` always sum to `max(0, amountCents)`.
 */
export interface DrainResult<S> {
  readonly drained: Cents;
  readonly shortfall: Cents;
  readonly draws: readonly DrainDraw<S>[];
}

/**
 * Drain `amountCents` from `sources` in the order given, taking as much as each
 * source holds before moving to the next. A source's available balance is floored
 * at zero — a negative snapshot contributes nothing rather than adding to the
 * amount owed — so a stray negative can never inflate the shortfall. A non-positive
 * amount drains nothing.
 */
export function drainSources<S extends { readonly balanceCents: Cents }>(
  sources: readonly S[],
  amountCents: Cents,
): DrainResult<S> {
  let remaining = Math.max(0, amountCents);
  const draws: DrainDraw<S>[] = [];
  for (const source of sources) {
    if (remaining <= 0) break;
    const available = Math.max(0, source.balanceCents);
    const take = Math.min(available, remaining);
    if (take > 0) {
      draws.push({ source, amountCents: take });
      remaining -= take;
    }
  }
  return { drained: Math.max(0, amountCents) - remaining, shortfall: remaining, draws };
}
