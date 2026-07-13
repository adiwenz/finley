/** Add-event form (§10.5 — plain-language authoring, one label = one event). */

import { useState } from "react";
import type { LifeEvent, NewLifeEvent, ReplayedHousehold } from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";
import { ChildForm } from "./childForm";
import { JobForm } from "./jobForm";
import { ExpenseForm } from "./expenseForm";
import { LoanForm } from "./loanForm";
import { SeparationForm } from "./separationForm";
import styles from "./addEventForm.module.css";

/**
 * The engine `LifeEvent` types this menu can author — a subset of the full
 * union (`DebtPayoffEvent` and `BudgetItemEndEvent` are handled elsewhere).
 * Derived from `LifeEvent` so the menu stays in lockstep with the engine:
 * renaming or removing an event type makes the matching entry below a compile
 * error rather than silent drift. Labels stay decoupled from these ids.
 */
type EventKind = Extract<
  LifeEvent["type"],
  | "JobChangeEvent"
  | "BudgetItemStartEvent"
  | "LoanEvent"
  | "RelationshipEvent"
  | "ChildEvent"
  | "SeparationEvent"
>;

const EVENT_KINDS: readonly { value: EventKind; label: string }[] = [
  { value: "JobChangeEvent", label: "Started a job" },
  { value: "BudgetItemStartEvent", label: "Added an expense" },
  { value: "LoanEvent", label: "Took out a loan" },
  { value: "RelationshipEvent", label: "Partnered" },
  { value: "ChildEvent", label: "Had a child" },
  { value: "SeparationEvent", label: "Separated" },
];

export function AddEventForm({
  household,
  defaultMonth,
  nextId,
  onAdd,
}: {
  household: ReplayedHousehold;
  defaultMonth: number;
  nextId: number;
  onAdd: (event: NewLifeEvent) => void;
}) {
  const [kind, setKind] = useState<EventKind>("JobChangeEvent");

  const formProps = { defaultMonth, nextId, onAdd };

  return (
    <div className={styles.authoring}>
      <h2>Add to timeline</h2>
      <p className="hint">
        Each choice records one clear life event. Ongoing numbers (your income,
        expenses) are edited directly under Budget — no event needed.
      </p>
      <label className="field">
        <span className="field-label">What happened?</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
          {EVENT_KINDS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {kind === "JobChangeEvent" && <JobForm {...formProps} household={household} />}
      {kind === "BudgetItemStartEvent" && <ExpenseForm {...formProps} household={household} />}
      {kind === "LoanEvent" && <LoanForm {...formProps} />}
      {kind === "RelationshipEvent" && <RelationshipForm {...formProps} />}
      {kind === "ChildEvent" && <ChildForm {...formProps} />}
      {kind === "SeparationEvent" && <SeparationForm {...formProps} household={household} />}
    </div>
  );
}
