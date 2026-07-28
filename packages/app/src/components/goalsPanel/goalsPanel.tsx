/**
 * Goals panel — each goal's projection-based on-track %, its target and date, and priority
 * reordering. Reordering re-runs the projection through the waterfall, so the OTHER goals'
 * numbers visibly move (the tradeoff).
 *
 * Goals are authored here too: add, edit, and delete are direct value-plane overrides (NO
 * timeline event), each re-running the projection so on-track %s update live.
 *
 * Priority is the goal's position in the list; ↑/↓ reorder it. Pointer drag-and-drop is
 * later polish; the buttons are the accessible, testable primitive.
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
                  {row.completion === "funded" ? (
                    // Funded is terminal, so the on-track % (a pacing signal) drops: once
                    // Funded latches, a drained fund reading "Funded · 40% on track" would
                    // only contradict the badge.
                    <span className="goal-status goal-status-funded">Funded</span>
                  ) : (
                    <span className="goal-track">{row.onTrackPct}% on track</span>
                  )}
                </div>
                {row.completion === "inProgress" && (
                  // Can read "In progress · Behind pace", too long to share the head line in
                  // a narrow panel, so it takes its own line (see .goal-status-in-progress).
                  <span className="goal-status goal-status-in-progress">
                    In progress{row.behindPace ? " · Behind pace" : ""}
                  </span>
                )}
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
