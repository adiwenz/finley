/** Add-event form (§10.5 — plain-language authoring, one label = one event). */

import { useState } from "react";
import type { LifeEvent, NewLifeEvent, Household, ProjectionSeries } from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";
import { ChildForm } from "./childForm";
import { ExpenseForm } from "./expenseForm";
import { LoanForm } from "./loanForm";
import { HomePurchaseForm } from "./homePurchaseForm";
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
  | "BudgetItemStartEvent"
  | "LoanEvent"
  | "HomePurchaseEvent"
  | "RelationshipEvent"
  | "ChildEvent"
  | "SeparationEvent"
>;

const EVENT_KINDS: readonly { value: EventKind; label: string }[] = [
  { value: "BudgetItemStartEvent", label: "Added an expense" },
  { value: "LoanEvent", label: "Took out a loan" },
  { value: "HomePurchaseEvent", label: "Bought a home" },
  { value: "RelationshipEvent", label: "Partnered" },
  { value: "ChildEvent", label: "Had a child" },
  { value: "SeparationEvent", label: "Separated" },
];

export function AddEventForm({
  household,
  series,
  defaultMonth,
  nextId,
  horizonMonths,
  onAdd,
}: {
  household: Household;
  /** The live projection — the home-purchase form reads it for the §4.5 DTI warning. */
  series: ProjectionSeries;
  defaultMonth: number;
  nextId: number;
  horizonMonths: number;
  onAdd: (event: NewLifeEvent) => void;
}) {
  const [kind, setKind] = useState<EventKind>("BudgetItemStartEvent");

  const formProps = { defaultMonth, nextId, horizonMonths, onAdd };

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

      {kind === "BudgetItemStartEvent" && <ExpenseForm {...formProps} household={household} />}
      {kind === "LoanEvent" && <LoanForm {...formProps} />}
      {kind === "HomePurchaseEvent" && (
        <HomePurchaseForm {...formProps} household={household} series={series} />
      )}
      {kind === "RelationshipEvent" && <RelationshipForm {...formProps} />}
      {kind === "ChildEvent" && <ChildForm {...formProps} />}
      {kind === "SeparationEvent" && <SeparationForm {...formProps} household={household} />}
    </div>
  );
}
