/**
 * Money is integer cents, never floats (§0.1). Every monetary value in the
 * engine — balances, series values, transfers, projection points — is an
 * integer number of cents. Floating-point drift compounds over a 40-year
 * horizon, so a float must never leak into a monetary quantity.
 *
 * `Cents` is a documentation alias over `number`, not a nominal brand: it makes
 * the shared type contract read as money without forcing constructors through
 * the codebase. The invariant that these are whole integers is enforced by the
 * tests (see the "money integrity" section of the invariant suite).
 */
export type Cents = number;

/**
 * Split a total across `n` slots as evenly as possible in whole cents, with the
 * slices summing to exactly `totalCents` — cumulative rounding absorbs the
 * remainder so no fraction of a cent is created or lost. Used wherever an
 * integer-cents amount must be divided without drift (e.g. the even shared-split
 * scheme, §5.0).
 */
export function splitEven(totalCents: Cents, n: number): Cents[] {
  const out: Cents[] = [];
  let prevCum = 0;
  for (let i = 1; i <= n; i++) {
    const cum = Math.round((totalCents * i) / n);
    out.push(cum - prevCum);
    prevCum = cum;
  }
  return out;
}
