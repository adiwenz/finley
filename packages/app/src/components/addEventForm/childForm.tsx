/** A child is recorded — a ChildEvent. */

import { useState } from "react";
import { MonthSelect, type FormProps } from "./formControls";

export function ChildForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [month, setMonth] = useState(defaultMonth);
  const [name, setName] = useState("");

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "ChildEvent",
      month,
      childId: `child-${nextId}`,
      childName: name || "Child",
      birthMonth: month,
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
          placeholder="Child's name"
        />
      </label>
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
