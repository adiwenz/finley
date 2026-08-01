/** A child already born when the plan starts — a `haveExistingChild` anchor. */

import { useState } from "react";
import { dollarsToCents } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import type { StartingPositionFormProps } from "./startingPositionFormControls";

const DEFAULT_ANNUAL_COST = 15_000;

export function ExistingChildForm({ onAdd, onDone }: StartingPositionFormProps) {
  const [name, setName] = useState("");
  const [ageYears, setAgeYears] = useState(3);
  const [annualCost, setAnnualCost] = useState(DEFAULT_ANNUAL_COST);

  function submit() {
    // The birth anchor lands at its true past month, so the 18-year cost stream clips to
    // the years of childhood that remain rather than starting over.
    onAdd((p) =>
      p.haveExistingChild({
        name: name || "Child",
        ageMonths: ageYears * 12,
        annualCostCents: dollarsToCents(annualCost),
      }),
    );
    onDone();
  }

  return (
    <>
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
      <NumInput label="Age today" value={ageYears} onChange={setAgeYears} suffix="yr" min={0} max={17} />
      <NumInput
        label="Annual cost"
        value={annualCost}
        onChange={setAnnualCost}
        prefix="$"
        suffix="/yr"
        min={0}
        step={1_000}
      />
      <p className="hint">Adds a child-cost expense for the years of childhood that remain.</p>
      <button className="btn primary" onClick={submit}>
        Add
      </button>
    </>
  );
}
