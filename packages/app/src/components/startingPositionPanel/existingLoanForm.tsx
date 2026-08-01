/** A debt already carried when the plan starts — a `carryLoan` holding. */

import { useState } from "react";
import { dollarsToCents, PRIMARY_PERSON_ID, type LiabilityKind } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import type { StartingPositionFormProps } from "./startingPositionFormControls";

export function ExistingLoanForm({ onAdd, onDone }: StartingPositionFormProps) {
  const [kind, setKind] = useState<LiabilityKind>("auto");
  const [balance, setBalance] = useState(15_000);
  const [apr, setApr] = useState(6);
  const [remainingTermYears, setRemainingTermYears] = useState(3);

  function submit() {
    const common = {
      ownerId: PRIMARY_PERSON_ID,
      balanceCents: dollarsToCents(balance),
      apr: apr / 100,
    } as const;
    onAdd((p) =>
      p.carryLoan(
        kind === "creditCard"
          ? { ...common, kind, creditLimitCents: dollarsToCents(balance * 2) }
          : { ...common, kind, remainingTermMonths: remainingTermYears * 12 },
      ),
    );
    onDone();
  }

  return (
    <>
      <label className="field">
        <span className="field-label">Type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as LiabilityKind)}>
          <option value="auto">Auto loan</option>
          <option value="studentLoan">Student loan</option>
          <option value="mortgage">Mortgage (unsecured entry)</option>
          <option value="creditCard">Credit card</option>
        </select>
      </label>
      <NumInput label="Balance today" value={balance} onChange={setBalance} prefix="$" step={1_000} />
      <NumInput label="APR" value={apr} onChange={setApr} suffix="%" step={0.25} />
      {kind !== "creditCard" && (
        <NumInput
          label="Term remaining"
          value={remainingTermYears}
          onChange={setRemainingTermYears}
          suffix="yr"
          min={1}
        />
      )}
      <p className="hint">Opens at today's balance — no draw, no gate.</p>
      <button className="btn primary" onClick={submit}>
        Add
      </button>
    </>
  );
}
