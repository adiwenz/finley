/** A home already owned when the plan starts — an `ownHome` holding, with an optional mortgage. */

import { useState } from "react";
import { dollarsToCents, PRIMARY_PERSON_ID } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import type { StartingPositionFormProps } from "./startingPositionFormControls";

export function ExistingHomeForm({ onAdd, onDone }: StartingPositionFormProps) {
  const [value, setValue] = useState(400_000);
  const [hasMortgage, setHasMortgage] = useState(true);
  const [mortgageBalance, setMortgageBalance] = useState(280_000);
  const [mortgageApr, setMortgageApr] = useState(6);
  const [mortgageRemainingYears, setMortgageRemainingYears] = useState(25);

  function submit() {
    onAdd((p) =>
      p.ownHome({
        ownerId: PRIMARY_PERSON_ID,
        valueCents: dollarsToCents(value),
        mortgage: hasMortgage
          ? {
              balanceCents: dollarsToCents(mortgageBalance),
              apr: mortgageApr / 100,
              remainingTermMonths: mortgageRemainingYears * 12,
            }
          : undefined,
      }),
    );
    onDone();
  }

  return (
    <>
      <NumInput label="Current value" value={value} onChange={setValue} prefix="$" step={10_000} />
      <label className="field field-check">
        <input
          type="checkbox"
          checked={hasMortgage}
          onChange={(e) => setHasMortgage(e.target.checked)}
        />
        <span className="field-label">Still has a mortgage</span>
      </label>
      {hasMortgage && (
        <>
          <NumInput
            label="Mortgage balance today"
            value={mortgageBalance}
            onChange={setMortgageBalance}
            prefix="$"
            step={5_000}
          />
          <NumInput label="APR" value={mortgageApr} onChange={setMortgageApr} suffix="%" step={0.25} />
          <NumInput
            label="Term remaining"
            value={mortgageRemainingYears}
            onChange={setMortgageRemainingYears}
            suffix="yr"
            min={1}
            max={40}
          />
        </>
      )}
      <p className="hint">Opens at today's value — no down payment, no affordability gate.</p>
      <button className="btn primary" onClick={submit}>
        Add
      </button>
    </>
  );
}
