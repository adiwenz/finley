/** Add-event form — plain-language authoring, one label = one event. */

import { useState } from "react";
import type {
  LifeEvent,
  NewLifeEvent,
  FundingLookup,
  Household,
  ProjectionSeries,
} from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";
import { ChildForm } from "./childForm";
import { LoanForm } from "./loanForm";
import { HomePurchaseForm } from "./homePurchaseForm";
import { SeparationForm } from "./separationForm";
import styles from "./addEventForm.module.css";

/**
 * The `LifeEvent` types this menu authors — a subset (`DebtPayoffEvent` is handled
 * elsewhere). Derived from `LifeEvent` so renaming or removing a type is a compile error
 * here rather than silent drift. Labels stay decoupled from these ids.
 *
 * No recurring-expense entry: an ongoing spend rate is edited directly under Base +
 * Adjustments, its single source of truth, so putting it on the timeline too would give
 * one concept two authoring paths.
 */
type EventKind = Extract<
  LifeEvent["type"],
  | "LoanEvent"
  | "HomePurchaseEvent"
  | "RelationshipEvent"
  | "ChildEvent"
  | "SeparationEvent"
>;

const EVENT_KINDS: readonly { value: EventKind; label: string }[] = [
  { value: "LoanEvent", label: "Took out a loan" },
  { value: "HomePurchaseEvent", label: "Bought a home" },
  { value: "RelationshipEvent", label: "Partnered" },
  { value: "ChildEvent", label: "Had a child" },
  { value: "SeparationEvent", label: "Separated" },
];

export function AddEventForm({
  household,
  series,
  funding,
  defaultMonth,
  nextId,
  horizonMonths,
  onAdd,
}: {
  household: Household;
  /** The live projection — the home-purchase form reads it for the DTI warning. */
  series: ProjectionSeries;
  /**
   * The engine's funding questions against the ledger so far: which accounts could pay for
   * a money-out event at a month, and what a chosen set nets after tax. Read by the
   * home-purchase form's source picker.
   */
  funding: FundingLookup;
  defaultMonth: number;
  nextId: number;
  horizonMonths: number;
  onAdd: (event: NewLifeEvent) => void;
}) {
  const [kind, setKind] = useState<EventKind>("LoanEvent");

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

      {kind === "LoanEvent" && <LoanForm {...formProps} />}
      {kind === "HomePurchaseEvent" && (
        <HomePurchaseForm {...formProps} household={household} series={series} funding={funding} />
      )}
      {kind === "RelationshipEvent" && <RelationshipForm {...formProps} />}
      {kind === "ChildEvent" && <ChildForm {...formProps} />}
      {kind === "SeparationEvent" && <SeparationForm {...formProps} household={household} />}
    </div>
  );
}
