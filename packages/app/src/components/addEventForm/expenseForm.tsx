/** A recurring expense starts — a BudgetItemStartEvent. */

import { useState } from "react";
import { dollarsToCents, membersAt, type Household } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, OwnerSelect, type FormProps } from "./formControls";

export function ExpenseForm({
  household,
  defaultMonth,
  nextId,
  onAdd,
}: FormProps & { household: Household }) {
  const [month, setMonth] = useState(defaultMonth);
  const [amount, setAmount] = useState(2000);
  const [ownerId, setOwnerId] = useState("p1");

  // Attribute the expense to someone in the household when it starts. Derived
  // during render so it tracks the month picker; falls back to you if the
  // selected owner isn't present at the chosen month.
  const owners = membersAt(household, month).map((p) =>
    p.id === "p1" ? { ...p, name: "You" } : p,
  );
  const selectedOwner = owners.some((o) => o.id === ownerId) ? ownerId : "p1";

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "BudgetItemStartEvent",
      month,
      seriesId: `budget-${nextId}`,
      ownerId: selectedOwner,
      seriesType: "expense",
      monthlyCents: dollarsToCents(amount),
      growthMode: { type: "fixed" },
    });
  }

  return (
    <>
      <MonthSelect value={month} onChange={setMonth} />
      <NumInput label="Monthly expense" value={amount} onChange={setAmount} prefix="$" step={100} />
      {owners.length > 1 && (
        <OwnerSelect owners={owners} value={selectedOwner} onChange={setOwnerId} />
      )}
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
