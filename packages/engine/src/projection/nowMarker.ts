/**
 * The **"now" marker** — the distinguished point on the simulation timeline that separates
 * what the household already has from what the plan goes on to do (see `CONTEXT.md`,
 * *Backdating / "now" marker*).
 *
 * Month 0 is the first *processed* month, so it sits AFTER now: a property, liability or
 * balance dated 0 is something the plan does during its first month, not something already
 * on the books. Anything genuinely pre-existing carries {@link PRE_NOW_MONTH} and is seeded
 * into `ProjectionSeries.opening` instead.
 *
 * This distinction was a bare `-1` repeated at four sites, each re-explaining it in a comment.
 * Naming it keeps the rule in one place — and keeps `< 0` from drifting back to `<= 0`, which
 * is exactly the bug that let a Year-0 home purchase open with free equity.
 */

/** A holding that predates the plan: on the books at "now", so it opens with a balance. */
export const PRE_NOW_MONTH = -1;

/**
 * Does this `startMonth` mark something the household ALREADY has, rather than something the
 * plan originates during a processed month? Only the former belongs in the opening snapshot.
 */
export function isPreExisting(startMonth: number): boolean {
  return startMonth < 0;
}
