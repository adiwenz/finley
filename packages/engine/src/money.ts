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

/**
 * Split `totalCents` across the keyed `weights` in whole cents, in proportion to each
 * key's weight, with the shares summing to EXACTLY `totalCents` — a largest-remainder
 * (Hamilton) apportionment: floor every exact share, then hand the leftover cents out
 * one at a time to the biggest fractional remainders. Zero/negative total or a
 * non-positive weight sum yields an empty map (nothing to split); a key that rounds to
 * 0 is omitted, so the caller never sees an empty band.
 *
 * The keyed sibling of {@link splitEven} (which splits evenly across positions). Used to
 * attribute an already-decided total down to the sources that bore it — e.g. splitting a
 * tax category's tax across the individual jobs/accounts in that category by their taxable
 * weight (§5.3), where the split must reconcile to the total to the cent. Weights that
 * repeat a key are summed first, so two contributions from the same source band collapse.
 */
export function apportionByWeight(
  totalCents: Cents,
  weights: readonly (readonly [string, number])[],
): Map<string, Cents> {
  const summed = new Map<string, number>();
  let weightSum = 0;
  for (const [key, weight] of weights) {
    if (weight <= 0) continue;
    summed.set(key, (summed.get(key) ?? 0) + weight);
    weightSum += weight;
  }
  const out = new Map<string, Cents>();
  if (totalCents <= 0 || weightSum <= 0) return out;

  const shares: { key: string; whole: Cents; remainder: number }[] = [];
  let allocated = 0;
  for (const [key, weight] of summed) {
    const exact = (totalCents * weight) / weightSum;
    const whole = Math.floor(exact);
    allocated += whole;
    shares.push({ key, whole, remainder: exact - whole });
  }
  // Hand out the leftover cents, biggest fractional remainder first.
  let leftover = totalCents - allocated;
  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i]!.whole += 1;

  for (const { key, whole } of shares) if (whole > 0) out.set(key, whole);
  return out;
}
