/**
 * Retirement panel — the Mode-1 headline age ("when can we retire?") and, for the pinned
 * retirement age, the target-mode on-track % plus the nearest feasible age when the pin is
 * unreachable. Single-person for now, so Mode 1 and per-person Mode 2 coincide; the
 * per-person click-through arrives with a second household member.
 */

import type { Plan } from "@finley/engine";
import type { RetirementView } from "../../retirementView";
import { formatDollars } from "../../format";

export function RetirementPanel({
  view,
  budget,
}: {
  view: RetirementView;
  budget: Plan;
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

      {view.earlyRetireeHealth.flagged && (
        <p className="alert alert-amber" role="status">
          Retiring at {budget.retirementAge} means{" "}
          <strong>{view.earlyRetireeHealth.gapYears} years</strong> of self-funded
          health coverage before Medicare at 65. Your health budget looks about{" "}
          <strong>{formatDollars(view.earlyRetireeHealth.shortfallMonthlyCents)}/mo</strong>{" "}
          short of a typical pre-65 cost. Estimate, not advice.
        </p>
      )}

      {/* No Medicare readout: the plan no longer steps health down at 65, because it holds no
          health figure of its own to step. Whatever the budget's health line says is what the
          projection charges, for as long as the line runs — the user changes it in
          Base + Adjustments like any other expense. The pre-65 gap check above survives, since
          it reads the authored line and synthesises no cost. */}
    </>
  );
}
