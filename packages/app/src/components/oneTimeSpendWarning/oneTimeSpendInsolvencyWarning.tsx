import type { OneTimeSpendInsolvencyWarningView } from "../../ledgerView";
import { monthLabel } from "../../format";

/**
 * A **soft warning** (CONTEXT.md's precise term — persistent, non-dismissible, proposes no value
 * change), not a **Nudge**: the spend itself is affordable (it isn't the block, and its own draw
 * resolved), but the plan it produces goes insolvent from some month on, and this states that fact
 * without suggesting a number. Amber, not red — unlike
 * {@link import("../blockedWarning/blockedWarning").BlockedWarning}, nothing here stopped.
 * Non-dismissible: it carries no dismiss control because the parent renders one only while
 * `oneTimeSpendInsolvencyWarnings` still returns it — mounting IS the condition holding, so it
 * clears itself the moment a smaller amount, a different month, or more income fixes it.
 */
export function OneTimeSpendInsolvencyWarning({
  warning,
}: {
  warning: OneTimeSpendInsolvencyWarningView;
}) {
  return (
    <div className="alert alert-amber soft-warning" role="status">
      <strong>Affordable, but —</strong> “{warning.eventLabel}” in {monthLabel(warning.month)} can
      be funded as authored, but it makes this plan insolvent from{" "}
      {monthLabel(warning.insolventFromMonth)} on. Consider a smaller amount, a different month,
      or a different funding source.
    </div>
  );
}
