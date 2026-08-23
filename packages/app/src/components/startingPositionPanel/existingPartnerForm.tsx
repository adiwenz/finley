/** A partner already in the household when the plan starts — a `startPartnered` anchor. */

import { useState } from "react";
import { MAX_AGE, MAX_LIVED_AGE, minLifeExpectancyFor, dollarsToCents } from "@finley/engine";
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
  // Their own money, kept apart from the primary's opening balances. Zeroes are the honest
  // default: a partner with nothing stated brings nothing, which is what this form meant before
  // it could say otherwise.
  const [savings, setSavings] = useState(0);
  const [retirement, setRetirement] = useState(0);
  const [brokerage, setBrokerage] = useState(0);

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
        accounts: {
          savingsBalanceCents: dollarsToCents(savings),
          retirementBalanceCents: dollarsToCents(retirement),
          brokerageBalanceCents: dollarsToCents(brokerage),
        },
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
        // The engine's floor for a person of this age, and nothing above it: a partner of 40
        // may be projected to 41. The `Math.max(60, …)` this replaces snapped that to 60.
        min={minLifeExpectancyFor(age)}
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
      {/* Return rates are deliberately absent: a partner's accounts grow at the household's own
          plan rates, which is one market assumption rather than a second set to keep in step. */}
      <NumInput label="Their cash savings" value={savings} onChange={setSavings} prefix="$" step={1_000} min={0} />
      <NumInput
        label="Their retirement account"
        value={retirement}
        onChange={setRetirement}
        prefix="$"
        step={1_000}
        min={0}
      />
      <NumInput label="Their brokerage" value={brokerage} onChange={setBrokerage} prefix="$" step={1_000} min={0} />
      <p className="hint">
        Their accounts join the household's net worth and can fund household spending while you are
        together, and leave with them at separation.
      </p>
      <button className="btn primary" onClick={submit}>
        Add
      </button>
    </>
  );
}
