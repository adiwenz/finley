/** A child is recorded — a ChildEvent, with its recurring cost. */

import { useState } from "react";
import { dollarsToCents } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type FormProps } from "./formControls";

// Illustrative default annual cost of raising a child (today's dollars).
const DEFAULT_ANNUAL_COST = 15_000;

export function ChildForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [month, setMonth] = useState(defaultMonth);
  const [name, setName] = useState("");
  const [annualCost, setAnnualCost] = useState(DEFAULT_ANNUAL_COST);

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "ChildEvent",
      month,
      childId: `child-${nextId}`,
      childName: name || "Child",
      birthMonth: month,
      annualCostCents: dollarsToCents(annualCost),
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
      <NumInput
        label="Annual cost"
        value={annualCost}
        onChange={setAnnualCost}
        prefix="$"
        suffix="/yr"
        min={0}
        step={1_000}
      />
      <p className="hint">Adds a child-cost expense for 18 years from birth.</p>
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
