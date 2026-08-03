/** A child is recorded — a ChildEvent, with its recurring cost. */

import { useState } from "react";
import { dollarsToCents } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";

// Illustrative default annual cost of raising a child (today's dollars).
const DEFAULT_ANNUAL_COST = 15_000;

/** The form's live state — one draft in the terms the fields speak, not a hook per field. */
interface ChildDraft {
  readonly month: number;
  readonly name: string;
  readonly annualCost: number;
}

export function ChildForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  edit,
}: FormProps & { edit?: EditProps<EventOf<"ChildEvent">> }) {
  const [draft, setDraft] = useState<ChildDraft>(() =>
    edit
      ? { month: edit.event.month, name: edit.event.childName, annualCost: edit.event.annualCostCents / 100 }
      : { month: defaultMonth, name: "", annualCost: DEFAULT_ANNUAL_COST },
  );
  const patch = (fields: Partial<ChildDraft>) => setDraft((d) => ({ ...d, ...fields }));

  function submit() {
    // `birthMonth` defaults to `month` in the facade, so recording a birth as it happens needs
    // only the month; the child id (and its 18-year cost stream) is minted by `haveChild`.
    if (edit) {
      // Keep the form's invariant that birth is the recorded month — the same coupling the add
      // path makes — so moving the child moves its cost stream too.
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "haveChild",
          month: draft.month,
          name: draft.name || "Child",
          birthMonth: draft.month,
          annualCostCents: dollarsToCents(draft.annualCost),
        }),
      );
      return;
    }
    onAdd((p) =>
      p.haveChild({
        month: draft.month,
        name: draft.name || "Child",
        annualCostCents: dollarsToCents(draft.annualCost),
      }),
    );
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          type="text"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Child's name"
        />
      </label>
      <NumInput
        label="Annual cost"
        value={draft.annualCost}
        onChange={(annualCost) => patch({ annualCost })}
        prefix="$"
        suffix="/yr"
        min={0}
        step={1_000}
      />
      <p className="hint">Adds a child-cost expense for 18 years from birth.</p>
      <button className="btn primary" onClick={submit}>
        {edit ? "Save changes" : "Add event"}
      </button>
    </>
  );
}
