/**
 * Retirement panel (§7) — the Mode-1 headline age ("when can we retire?") and,
 * for the pinned retirement age, the target-mode on-track % plus the honest
 * nearest-feasible age when the pin is unreachable (§7.1). Single-person this
 * slice, so Mode 1 and the per-person Mode 2 coincide; the per-person click-through
 * arrives with a second household member.
 */

import type { BudgetValues } from "../../planTypes";
import type { RetirementView } from "../../retirementView";

export function RetirementPanel({
  view,
  budget,
}: {
  view: RetirementView;
  budget: BudgetValues;
}) {
  return (
    <>
      <h2>Retirement</h2>
      {view.headlineAge === null ? (
        <p className="alert alert-red" role="status">
          On these numbers the money never lasts to age {budget.lifeExpectancy} — no
          retirement age is feasible. Structural changes are required.
        </p>
      ) : (
        <p className="hint">
          You can retire at{" "}
          <strong aria-label="Earliest feasible retirement age">{view.headlineAge}</strong> and
          have the portfolio last to age {budget.lifeExpectancy}.
        </p>
      )}

      <p className="hint">
        Your target is age {budget.retirementAge}:{" "}
        {view.target.feasible ? (
          <strong>on track (100%)</strong>
        ) : (
          <>
            <strong>{view.targetOnTrackPct}% of the way there</strong>
            {view.target.nearestFeasibleAge !== null && (
              <> — the nearest feasible age is {view.target.nearestFeasibleAge}.</>
            )}
          </>
        )}
      </p>
    </>
  );
}
