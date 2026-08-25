/**
 * Whole-dollar amounts that still add up.
 *
 * The engine splits a household figure to the cent and the split is exact; rounding each person's
 * share to dollars independently is what breaks it. $6,640.50 divided evenly is $3,320.25 each,
 * and two $3,320 shares under a $6,641 total is a dollar the reader cannot find — visible the
 * moment they compare the same month across Combined and one person, which is the comparison the
 * per-person views exist to invite.
 *
 * So the total is rounded ONCE and the shares are apportioned to it: every share floors to a
 * dollar, and the dollars left over go to the largest fractional parts first, ties to whoever
 * comes first in the caller's order. Largest-remainder, the same rule the engine's own cent-level
 * split uses one unit down — and a display step only. No cents move: the engine's allocation, the
 * funding cascade and every stored figure are untouched, and this is never fed back into one.
 *
 * Shares that are NOT a partition of the total — a household figure carrying something charged to
 * nobody, a person the engine reported nothing for — are left to round on their own. Scaling them
 * up to close the gap would put money on people who were never asked for it, which is a worse lie
 * than a dollar that does not reconcile.
 */

/** Cents as {@link import("../../format").formatDollars} prints them: whole dollars, half away from zero. */
export function toDisplayCents(cents: number): number {
  return Math.sign(cents) * Math.round(Math.abs(cents) / 100) * 100;
}

/**
 * `parts` as whole-dollar cents summing to `toDisplayCents(totalCents)`, index-aligned with the
 * input. Falls back to rounding each part alone when they do not partition the total (see above).
 */
export function apportionDisplayCents(
  totalCents: number,
  parts: readonly number[],
): number[] {
  const target = toDisplayCents(totalCents);
  const exact = parts.reduce((sum, c) => sum + c, 0);
  // A cent of slack: the parts either add to the total or describe something else entirely.
  if (parts.length === 0 || Math.abs(exact - totalCents) >= 100) return parts.map(toDisplayCents);

  const floors = parts.map((c) => Math.floor(c / 100) * 100);
  const spare = (target - floors.reduce((sum, c) => sum + c, 0)) / 100;
  // Guarded rather than assumed: `target` is the total rounded, so the leftovers can only be one
  // dollar per part — anything else means the premise above did not hold after all.
  if (!Number.isInteger(spare) || spare < 0 || spare > parts.length) return parts.map(toDisplayCents);

  const byRemainder = parts
    .map((c, i) => ({ i, remainder: c - floors[i]! }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const out = [...floors];
  for (let n = 0; n < spare; n++) out[byRemainder[n]!.i]! += 100;
  return out;
}
