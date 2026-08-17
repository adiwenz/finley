/** Add-event form — plain-language authoring, one label = one event. */

import { useState } from "react";
import type {
  LifeEvent,
  Projection,
  FundingLookup,
  ProjectionResult,
} from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";
import { EditEventForm } from "./editEventForm";
import { ChildForm } from "./childForm";
import { LoanForm } from "./loanForm";
import { HomePurchaseForm } from "./homePurchaseForm";
import { SeparationForm } from "./separationForm";
import { OneTimeSpendForm } from "./oneTimeSpendForm";
import styles from "./addEventForm.module.css";

/**
 * The `LifeEvent` types this menu authors — a subset (`DebtPayoffEvent` is handled
 * elsewhere). Derived from `LifeEvent` so renaming or removing a type is a compile error
 * here rather than silent drift. Labels stay decoupled from these ids.
 */
export type EventKind = Extract<
  LifeEvent["type"],
  | "LoanEvent"
  | "HomePurchaseEvent"
  | "RelationshipEvent"
  | "ChildEvent"
  | "SeparationEvent"
  | "OneTimeSpendEvent"
>;

export const EVENT_KINDS: readonly { value: EventKind; label: string }[] = [
  { value: "LoanEvent", label: "Took out a loan" },
  { value: "HomePurchaseEvent", label: "Bought a home" },
  { value: "OneTimeSpendEvent", label: "Made a one-time spend" },
  { value: "RelationshipEvent", label: "Partnered" },
  { value: "ChildEvent", label: "Had a child" },
  { value: "SeparationEvent", label: "Separated" },
];

/** An in-progress edit of a timeline event: which event, how to commit it, how to abandon it. */
export interface EditingEvent {
  readonly event: LifeEvent;
  readonly onRevise: (write: (projection: Projection) => void) => void;
  readonly onCancel: () => void;
}

export function AddEventForm({
  result,
  funding,
  defaultMonth,
  horizonMonths,
  onAdd,
  editing,
  kind: presetKind,
}: {
  /**
   * The live run. The home-purchase form asks it for the DTI advisory, and the separation
   * form for who is actually in the household at the chosen month.
   */
  result: ProjectionResult;
  /**
   * The engine's funding questions against the ledger so far: which accounts could pay for
   * a money-out event at a month, and what a chosen set nets after tax. Read by the
   * home-purchase form's source picker.
   */
  funding: FundingLookup;
  defaultMonth: number;
  horizonMonths: number;
  onAdd: (write: (projection: Projection) => void) => void;
  /**
   * When set, this card revises an existing timeline event instead of authoring a new one —
   * the type picker is hidden (an event's type is fixed) and the matching form opens
   * pre-filled. Cleared by the parent once the edit commits or is cancelled.
   */
  editing?: EditingEvent;
  /**
   * The event type to author, chosen OUTSIDE this form — the life-change chooser picks it, so
   * the reader has already answered "what happened?" before the form opens. Supplying it hides
   * the internal picker; leaving it undefined keeps this form self-contained with its own.
   */
  kind?: EventKind;
}) {
  const [ownKind, setOwnKind] = useState<EventKind>("LoanEvent");
  const kind = presetKind ?? ownKind;

  const formProps = { defaultMonth, horizonMonths, onAdd };

  // An edit is type-locked, so the picker gives way to the one pre-filled form for that event.
  if (editing) {
    return (
      <EditEventForm
        // Keyed by the event, because every form seeds its draft ONCE, from the event it was
        // mounted with. Switching straight from one loan's marker to another's renders the same
        // element type in the same position, so React would keep the mounted form — still
        // holding the first loan's figures, ready to save them onto the second. The key is the
        // identity that makes those two different forms. It sits here, at the dispatch
        // boundary, so one rule covers every event type rather than each form re-deriving its
        // own draft from a changed prop; the surrounding add-form card keeps its own state.
        key={editing.event.id}
        editing={editing}
        result={result}
        funding={funding}
        defaultMonth={defaultMonth}
        horizonMonths={horizonMonths}
        onAdd={onAdd}
      />
    );
  }

  return (
    <div className={styles.authoring}>
      <h2>Add to timeline</h2>
      <p className="hint">
        Each choice records one clear life event. Ongoing numbers (your income,
        expenses) are edited directly under Budget — no event needed.
      </p>
      {presetKind === undefined && (
        <label className="field">
          <span className="field-label">What happened?</span>
          <select value={kind} onChange={(e) => setOwnKind(e.target.value as EventKind)}>
            {EVENT_KINDS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}

      {kind === "LoanEvent" && <LoanForm {...formProps} />}
      {kind === "HomePurchaseEvent" && (
        <HomePurchaseForm {...formProps} result={result} funding={funding} />
      )}
      {kind === "OneTimeSpendEvent" && <OneTimeSpendForm {...formProps} funding={funding} />}
      {kind === "RelationshipEvent" && <RelationshipForm {...formProps} />}
      {kind === "ChildEvent" && <ChildForm {...formProps} />}
      {kind === "SeparationEvent" && <SeparationForm {...formProps} result={result} />}
    </div>
  );
}
