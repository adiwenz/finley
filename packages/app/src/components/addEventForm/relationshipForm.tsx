/** Partner joins the household — a RelationshipEvent. */

import { useState } from "react";
import { MonthSelect, type FormProps } from "./formControls";
import { START_YEAR } from "../../config";

/** The form's live state — one draft, not a hook per field. */
interface RelationshipDraft {
  readonly month: number;
  readonly name: string;
}

export function RelationshipForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [draft, setDraft] = useState<RelationshipDraft>(() => ({ month: defaultMonth, name: "" }));
  const patch = (fields: Partial<RelationshipDraft>) => setDraft((d) => ({ ...d, ...fields }));

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "RelationshipEvent",
      month: draft.month,
      // Authoring Person (§8): the form collects only a name today, so the
      // retirement/benefit inputs take sensible defaults and the partner joins with no
      // authored jobs (no earned income until the app can author them). birthYear is a
      // generic-adult placeholder — it only drives the age display, since jobs are empty.
      person: {
        id: `p-${nextId}`,
        name: draft.name || "Partner",
        birthYear: START_YEAR - 40,
        retirementTargetAge: 65,
        benefitClaimingAge: 67,
        jobs: [],
      },
    });
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
          placeholder="Partner's name"
        />
      </label>
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
