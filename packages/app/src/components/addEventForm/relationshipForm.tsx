/** Partner joins the household — a RelationshipEvent. */

import { useState } from "react";
import { MonthSelect, type FormProps } from "./formControls";

export function RelationshipForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [month, setMonth] = useState(defaultMonth);
  const [name, setName] = useState("");

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "RelationshipEvent",
      month,
      person: { id: `p-${nextId}`, name: name || "Partner" },
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
