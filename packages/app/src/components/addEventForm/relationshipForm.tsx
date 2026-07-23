/** Partner joins the household — a RelationshipEvent. */

import { useState } from "react";
import { MonthSelect, type FormProps } from "./formControls";
import { START_YEAR } from "../../config";

export function RelationshipForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [month, setMonth] = useState(defaultMonth);
  const [name, setName] = useState("");

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "RelationshipEvent",
      month,
      // Authoring Person (§8): the form collects only a name today, so the
      // retirement/benefit inputs take sensible defaults and the partner joins with no
      // authored jobs (no earned income until the app can author them). birthYear is a
      // generic-adult placeholder — it only drives the age display, since jobs are empty.
      person: {
        id: `p-${nextId}`,
        name: name || "Partner",
        birthYear: START_YEAR - 40,
        retirementTargetAge: 65,
        benefitClaimingAge: 67,
        jobs: [],
      },
    });
  }

  return (
    <>
      <MonthSelect value={month} horizonMonths={horizonMonths} onChange={setMonth} />
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Partner's name"
        />
      </label>
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
