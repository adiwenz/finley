/** A new liability is taken on — a LoanEvent. */

import { useState } from "react";
import { dollarsToCents, type LiabilityKind } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type FormProps } from "./formControls";

export function LoanForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [month, setMonth] = useState(defaultMonth);
  const [loanKind, setLoanKind] = useState<LiabilityKind>("auto");
  const [amount, setAmount] = useState(2000);
  const [apr, setApr] = useState(6);
  const [termYears, setTermYears] = useState(5);

  function submit() {
    // LoanEvent is discriminated on `kind`, so each arm carries only its own
    // kind-determined field — no `undefined` placeholder for the other's.
    const common = {
      id: `e${nextId}`,
      type: "LoanEvent",
      month,
      liabilityId: `loan-${nextId}`,
      ownerId: "p1",
      openingBalanceCents: dollarsToCents(amount),
      apr: apr / 100,
    } as const;
    onAdd(
      loanKind === "creditCard"
        ? { ...common, kind: loanKind, creditLimitCents: dollarsToCents(amount * 2) }
        : { ...common, kind: loanKind, termMonths: termYears * 12 },
    );
  }

  return (
    <>
      <MonthSelect value={month} horizonMonths={horizonMonths} onChange={setMonth} />
      <label className="field">
        <span className="field-label">Type</span>
        <select
          value={loanKind}
          onChange={(e) => setLoanKind(e.target.value as LiabilityKind)}
        >
          <option value="auto">Auto loan</option>
          <option value="studentLoan">Student loan</option>
          <option value="mortgage">Mortgage</option>
          <option value="creditCard">Credit card</option>
        </select>
      </label>
      <NumInput label="Amount" value={amount} onChange={setAmount} prefix="$" step={1000} />
      <NumInput label="APR" value={apr} onChange={setApr} suffix="%" step={0.25} />
      {loanKind !== "creditCard" && (
        <NumInput label="Term" value={termYears} onChange={setTermYears} suffix="yr" min={1} />
      )}
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
