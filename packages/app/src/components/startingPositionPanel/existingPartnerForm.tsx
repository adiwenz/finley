/** A partner already in the household when the plan starts — a `startPartnered` anchor. */

import { useState } from "react";
import { MAX_LIVED_AGE } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import type { StartingPositionFormProps } from "./startingPositionFormControls";

export function ExistingPartnerForm({ onAdd, onDone }: StartingPositionFormProps) {
  const [name, setName] = useState("");
  const [age, setAge] = useState(40);
  const [partneredForYears, setPartneredForYears] = useState(5);

  function submit() {
    // The anchor lands at its true past month, driven by how long the household has been
    // together — `startPartnered` computes that month from `partneredForMonths`.
    const birthYear = new Date().getFullYear() - age;
    onAdd((p) =>
      p.startPartnered({
        partneredForMonths: partneredForYears * 12,
        name: name || "Partner",
        birthYear,
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
          placeholder="Partner's name"
        />
      </label>
      <NumInput label="Their age today" value={age} onChange={setAge} min={18} max={MAX_LIVED_AGE} />
      <NumInput
        label="Together for"
        value={partneredForYears}
        onChange={setPartneredForYears}
        suffix="yr"
        min={0}
        max={70}
      />
      <p className="hint">No account effect — records the household as it already is.</p>
      <button className="btn primary" onClick={submit}>
        Add
      </button>
    </>
  );
}
