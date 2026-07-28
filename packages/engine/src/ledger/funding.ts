/**
 * funding — the shared ordered-drain primitive for money-out events.
 *
 * Home Purchase and One-Time Spend both fund an outflow from an ordered list of eligible
 * accounts (liquid non-retirement accounts + goal funds; retirement excluded in v1). The one
 * place deciding "take X from these accounts, in the order given".
 *
 * Pure: it takes resolved balances (the caller resolves them at the event month) and an
 * amount, never a projection — which is what lets the §4.5 affordability gate and the event
 * replay share one definition of "can these sources fund this?".
 */

import type { Cents } from "../money";

export interface DrainDraw<S> {
  readonly source: S;
  readonly amountCents: Cents;
}

/**
 * The outcome of draining `amountCents` from an ordered source list:
 * - `drained` = `min(amount, available)`;
 * - `shortfall` = `max(0, amount − available)`, what the §4.5 gate hard-blocks on;
 * - `draws` — per-account amounts in source order, positive draws only.
 * `drained` and `shortfall` always sum to `max(0, amountCents)`.
 */
export interface DrainResult<S> {
  readonly drained: Cents;
  readonly shortfall: Cents;
  readonly draws: readonly DrainDraw<S>[];
}

/**
 * Drain `amountCents` from `sources` in order, exhausting each before the next. Available
 * balances are floored at zero, so a negative snapshot contributes nothing rather than
 * inflating the shortfall.
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
