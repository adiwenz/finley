import type { BlockedWarningView } from "../../ledgerView";
import { formatDollars, monthLabel } from "../../format";

/**
 * A soft warning for a projection the engine stopped: an explicitly-funded purchase whose sources
 * could not cover it, so the curve is hatched from there on. Persistent and non-dismissible — it
 * carries no dismiss control, because dismissing it would not make it less true; it clears only when
 * the plan no longer blocks (a different funding source, a smaller purchase). Named for the DTI
 * advisory's `soft-warning` marker class, but NOT advice: it proposes no value change, it reports a
 * stop that already happened. Red rather than amber for that reason — the plan did not merely lean
 * hard on credit, it ran out of money the purchase needed.
 *
 * The parent renders this only while `blockedWarning` returns non-null, so mounting IS the
 * condition holding; the component itself is a pure statement of that fact.
 */
export function BlockedWarning({ warning }: { warning: BlockedWarningView }) {
  return (
    <div className="alert alert-red soft-warning" role="status">
      <strong>Projection stopped.</strong> “{warning.eventLabel}” in {monthLabel(warning.month)}{" "}
      can’t be funded — the down payment falls {formatDollars(warning.shortfallCents)} short of what
      the chosen accounts deliver after the tax on selling them. The plan can’t go past that point,
      so everything after it is on hold and the graph is hatched from there.
    </div>
  );
}
