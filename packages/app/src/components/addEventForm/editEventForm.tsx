/** Edit an existing timeline event — the add forms, opened pre-filled and committed as a revision. */

import type { LifeEvent, Projection } from "@finley/engine";
import { RelationshipForm } from "./relationshipForm";
import type { EditingEvent } from "./addEventForm";
import styles from "./addEventForm.module.css";

/**
 * The event types this surface can reopen for editing — exactly those with an authoring form.
 * The timeline reads it to decide which markers get an Edit control, so a type absent here (a
 * debt payoff, authored elsewhere) never opens a form that cannot render it.
 */
export const EDITABLE_EVENT_TYPES: ReadonlySet<LifeEvent["type"]> = new Set<LifeEvent["type"]>([
  "RelationshipEvent",
]);

export function EditEventForm({
  editing,
  defaultMonth,
  horizonMonths,
  onAdd,
}: {
  editing: EditingEvent;
  defaultMonth: number;
  horizonMonths: number;
  onAdd: (write: (projection: Projection) => void) => void;
}) {
  const { event, onRevise, onCancel } = editing;
  const formProps = { defaultMonth, horizonMonths, onAdd };

  // Every arm hands the form the same `edit` seam — the event to seed from and the sink that
  // commits its revision. Narrowing per case keeps each form's `event` its own variant.
  function form() {
    switch (event.type) {
      case "RelationshipEvent":
        return <RelationshipForm {...formProps} edit={{ event, onRevise }} />;
      default:
        // Unreachable: the timeline only offers Edit for {@link EDITABLE_EVENT_TYPES}.
        return null;
    }
  }

  return (
    <div className={styles.authoring}>
      <h2>Edit event</h2>
      <p className="hint">
        Correct this event’s details. Its place on the timeline, and everything it created,
        are kept.
      </p>
      {form()}
      <button className="btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
