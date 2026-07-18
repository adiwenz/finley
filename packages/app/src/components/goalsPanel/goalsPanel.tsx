/**
 * Goals panel (§5.2) — each goal's projection-based on-track %, its target and
 * date, and priority reordering. Reordering re-runs the projection through the
 * waterfall, so the OTHER goals' numbers visibly move (the §5.2 tradeoff). A goal
 * held in a risky account for a near-term date shows an honesty flag.
 *
 * Goals are also authored here (Slice 5b): add, edit, and delete are direct
 * value-plane overrides (§4.2 / §10.3 — NO timeline event), each re-running the
 * projection so on-track %s update live, the same feedback loop reorder has. The
 * add/edit form is disclosed on demand (§10.4), not always open.
 *
 * Priority is the goal's position in the list; ↑/↓ reorder it. (Pointer
 * drag-and-drop is a later polish; the buttons are the accessible, testable
 * primitive and drive the exact same reprioritization.)
 */

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectionSeries } from "@finley/engine";
import type { Plan } from "@finley/engine";
import {
  goalRows,
  reorderGoal,
  setGoalRate,
  addGoal,
  updateGoal,
  removeGoal,
  type GoalDraft,
} from "../../goalsView";
import { GoalForm } from "./goalForm";
import { NumInput } from "../numInput/numInput";
import { formatDollars, monthLabel } from "../../format";

interface GoalsPanelProps {
  budget: Plan;
  series: ProjectionSeries;
  setBudget: Dispatch<SetStateAction<Plan>>;
}

/** Which authoring form, if any, is disclosed: a goal id (edit), "new" (add), or none. */
type Authoring = { kind: "edit"; id: string } | { kind: "new" } | null;

export function GoalsPanel({ budget, series, setBudget }: GoalsPanelProps) {
  const rows = goalRows(budget, series);
  const [authoring, setAuthoring] = useState<Authoring>(null);

  function move(id: string, direction: "up" | "down") {
    setBudget((current) => ({ ...current, goals: reorderGoal(current.goals, id, direction) }));
  }

  function setRate(id: string, annualReturnPct: number) {
    setBudget((current) => ({ ...current, goals: setGoalRate(current.goals, id, annualReturnPct) }));
  }

  function add(draft: GoalDraft) {
    setBudget((current) => ({ ...current, goals: addGoal(current.goals, draft) }));
    setAuthoring(null);
  }

  function edit(id: string, draft: GoalDraft) {
    setBudget((current) => ({ ...current, goals: updateGoal(current.goals, id, draft) }));
    setAuthoring(null);
  }

  function remove(id: string) {
    setBudget((current) => ({ ...current, goals: removeGoal(current.goals, id) }));
    if (authoring?.kind === "edit" && authoring.id === id) setAuthoring(null);
  }

  return (
    <>
      <h2>Goals</h2>
      {rows.length === 0 ? (
        <p className="hint">No goals yet — add one below.</p>
      ) : (
        <>
          <p className="hint">
            Higher goals are funded first. Reordering one moves the others — that’s the
            tradeoff.
          </p>
          <ul className="goal-list">
            {rows.map((row, i) => (
              <li key={row.id} className="goal-row" aria-label={row.name}>
                <div className="goal-head">
                  <span className="goal-name">{row.name}</span>
                  <span className="goal-track">{row.onTrackPct}% on track</span>
                </div>
                <div className="goal-meta">
                  {formatDollars(row.targetCents)} by{" "}
                  {row.targetDate === "asap" ? "as soon as possible" : monthLabel(row.targetDate)}
                </div>
                <div className="goal-disposition">At target: {row.dispositionLabel}</div>
                <NumInput
                  label="Fund return"
                  value={row.annualReturnPct}
                  onChange={(pct) => setRate(row.id, pct)}
                  suffix="%"
                  min={0}
                  step={0.5}
                />
                {row.shortHorizonRiskFlag && (
                  <p className="alert alert-amber" role="status">
                    This goal is close but held in a market-risk account — v1 shows a
                    steady return and can’t model a near-term dip.
                  </p>
                )}
                <div className="goal-actions">
                  <button
                    type="button"
                    aria-label={`Move ${row.name} up`}
                    disabled={i === 0}
                    onClick={() => move(row.id, "up")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${row.name} down`}
                    disabled={i === rows.length - 1}
                    onClick={() => move(row.id, "down")}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${row.name}`}
                    onClick={() =>
                      setAuthoring((a) =>
                        a?.kind === "edit" && a.id === row.id ? null : { kind: "edit", id: row.id },
                      )
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${row.name}`}
                    onClick={() => remove(row.id)}
                  >
                    Delete
                  </button>
                </div>
                {authoring?.kind === "edit" && authoring.id === row.id && (
                  <GoalForm
                    initial={budget.goals.find((g) => g.id === row.id)}
                    submitLabel="Save"
                    onSubmit={(draft) => edit(row.id, draft)}
                    onCancel={() => setAuthoring(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {authoring?.kind === "new" ? (
        <GoalForm submitLabel="Add" onSubmit={add} onCancel={() => setAuthoring(null)} />
      ) : (
        <button type="button" className="goal-add" onClick={() => setAuthoring({ kind: "new" })}>
          + Add a goal
        </button>
      )}
    </>
  );
}
