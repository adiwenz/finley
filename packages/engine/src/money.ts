/**
 * Money is integer cents, never floats: floating-point drift compounds over a 40-year
 * horizon.
 *
 * `Cents` is a documentation alias over `number`, not a nominal brand, so the contract reads
 * as money without forcing constructors through the codebase. The whole-integer invariant is
 * enforced by the "money integrity" section of the invariant suite.
 */
export type Cents = number;

/**
 * Split a total across `n` slots as evenly as possible in whole cents, summing to exactly
 * `totalCents` — cumulative rounding absorbs the remainder, so no fraction of a cent is
 * created or lost.
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
 * Split `totalCents` across the keyed `weights` proportionally in whole cents, summing to
 * EXACTLY `totalCents` — largest-remainder (Hamilton) apportionment: floor every exact share,
 * then hand leftover cents out one at a time to the biggest fractional remainders.
 * Zero/negative total or a non-positive weight sum yields an empty map; a key that rounds to
 * 0 is omitted, so the caller never sees an empty band.
 *
 * Attributes an already-decided total down to the sources that bore it — e.g. a tax
 * category's tax across the jobs/accounts in it by taxable weight. Repeated keys are summed
 * first, so two contributions from the same source band collapse.
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
  let leftover = totalCents - allocated;
  shares.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i]!.whole += 1;

  for (const { key, whole } of shares) if (whole > 0) out.set(key, whole);
  return out;
}
