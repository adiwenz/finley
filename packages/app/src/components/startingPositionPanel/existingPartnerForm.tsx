/** A partner already in the household when the plan starts — a `startPartnered` anchor. */

import { useState } from "react";
import { MAX_AGE, MAX_LIVED_AGE } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import type { StartingPositionFormProps } from "./startingPositionFormControls";

/**
 * What the life-expectancy field opens on. A visible, editable starting point — NOT a fallback:
 * the engine requires a partner's own expectancy and never substitutes the primary's, so the
 * number has to be one the user can see and change, in the same spirit as the age above.
 */
const PARTNER_DEFAULT_LIFE_EXPECTANCY = 90;

export function ExistingPartnerForm({ onAdd, onDone }: StartingPositionFormProps) {
  const [name, setName] = useState("");
  const [age, setAge] = useState(40);
  const [lifeExpectancy, setLifeExpectancy] = useState(PARTNER_DEFAULT_LIFE_EXPECTANCY);
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
        lifeExpectancy,
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
      {/* Their own, not the household's: the projection runs to the longest-lived member, so a
          partner younger than the primary is what extends it. */}
      <NumInput
        label="Their life expectancy"
        value={lifeExpectancy}
        onChange={setLifeExpectancy}
        min={Math.max(60, age)}
        max={MAX_AGE}
      />
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
